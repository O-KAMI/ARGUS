// The GitHub REST side of collection: one outbound HTTP layer with its rate limits and bounded retries
// (方案 2.2, 2.3, 7.3), and the Search API adapters the two star boards are built from. Requests leave
// through guardedFetch, so the SSRF guard, the egress proxy and the body limits are the engine's.
import { guardedFetch, type GuardedResponse } from "@aihot/backend/lib/http-fetch";
import { githubConfig } from "./config.ts";

/** A repository as the Search API returns it, normalised to the columns github_repositories holds. */
export interface GithubRepo {
  githubId: number;
  nodeId: string | null;
  fullName: string;
  ownerLogin: string;
  name: string;
  htmlUrl: string;
  description: string | null;
  homepage: string | null;
  language: string | null;
  stargazersCount: number;
  forksCount: number | null;
  openIssuesCount: number | null;
  licenseSpdxId: string | null;
  topics: string[];
  isFork: boolean;
  isArchived: boolean;
  createdAt: Date | null;
  updatedAt: Date | null;
  pushedAt: Date | null;
}

/**
 * GitHub answered 403 or 429 for its rate limit. Collection stops instead of hammering the endpoint and
 * keeps the boards it already has (方案 7.3); the run is recorded with this message.
 */
export class GithubRateLimited extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number, message: string) {
    super(message);
    this.name = "GithubRateLimited";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** GitHub answered something else that is not a result: a bad token, a moved endpoint, a server error. */
export class GithubApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GithubApiError";
    this.status = status;
  }
}

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "ARGUS-github-rankings",
  };
  // The token is read from the collectors credential group and never leaves this header.
  if (githubConfig.token) h.authorization = `Bearer ${githubConfig.token}`;
  return h;
}

/** Retry-After, else the wall-clock second the limit resets at, else a minute as a conservative guess. */
function retryAfterSeconds(res: GuardedResponse): number {
  const after = Number(res.headers.get("retry-after"));
  if (Number.isFinite(after) && after > 0) return Math.min(Math.ceil(after), 3600);
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) return Math.min(Math.max(Math.ceil(reset - Date.now() / 1000), 1), 3600);
  return 60;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Is this a transport failure worth another attempt (a timeout, a reset connection, a 5xx)? */
const retryable = (error: unknown) =>
  error instanceof GithubApiError ? error.status >= 500
    : error instanceof Error && !(error instanceof GithubRateLimited);

/**
 * One GET against GitHub, with a bounded exponential backoff for transport failures and server errors.
 * A rate-limited answer is thrown at once: waiting it out inside one collection run would hold the worker
 * for up to an hour, so the run fails and the previous boards stay up.
 */
export async function githubGet(url: string): Promise<GuardedResponse> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= githubConfig.maxRetries; attempt++) {
    try {
      const res = await guardedFetch(url, { headers: headers(), timeoutMs: githubConfig.timeoutMs, maxBytes: 16 * 1024 * 1024 });
      if (res.status === 200) return res;
      if (res.status === 403 || res.status === 429) {
        const seconds = retryAfterSeconds(res);
        throw new GithubRateLimited(seconds, `GitHub rate limit: HTTP ${res.status}, retry after ${seconds}s${githubConfig.token ? "" : " (no GITHUB_TOKEN: 60 core and 10 search requests an hour)"}`);
      }
      throw new GithubApiError(res.status, `GitHub answered HTTP ${res.status} for ${url}`);
    } catch (error) {
      lastError = error;
      if (!retryable(error) || attempt === githubConfig.maxRetries) throw error;
      await wait(1000 * 2 ** (attempt - 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("GitHub request failed");
}

const date = (value: unknown): Date | null => {
  if (typeof value !== "string") return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
};
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);
const whole = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null);

/** One Search API item to a GithubRepo; null when it lacks the identity or the address (方案 2.1 校验). */
export function normalizeSearchItem(item: unknown): GithubRepo | null {
  if (typeof item !== "object" || item === null) return null;
  const r = item as Record<string, unknown>;
  const githubId = whole(r.id);
  const fullName = text(r.full_name);
  const htmlUrl = text(r.html_url);
  if (githubId === null || !fullName || !htmlUrl || !fullName.includes("/")) return null;
  const [ownerLogin, ...rest] = fullName.split("/");
  const name = rest.join("/");
  if (!ownerLogin || !name) return null;
  const license = (typeof r.license === "object" && r.license !== null ? (r.license as Record<string, unknown>).spdx_id : undefined);
  return {
    githubId,
    nodeId: text(r.node_id),
    fullName,
    ownerLogin,
    name,
    htmlUrl,
    description: text(r.description),
    homepage: text(r.homepage),
    language: text(r.language),
    stargazersCount: whole(r.stargazers_count) ?? 0,
    forksCount: whole(r.forks_count),
    openIssuesCount: whole(r.open_issues_count),
    licenseSpdxId: text(license) === "NOASSERTION" ? null : text(license),
    topics: Array.isArray(r.topics) ? r.topics.filter((t): t is string => typeof t === "string") : [],
    isFork: r.fork === true,
    isArchived: r.archived === true,
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
    pushedAt: date(r.pushed_at),
  };
}

export interface SearchPage {
  items: GithubRepo[];
  /** The Search API's own warning that it timed out and answered from a partial index (方案 2.2 规则 5). */
  incompleteResults: boolean;
  totalCount: number;
}

/**
 * One Search Repositories query, always by cumulative stars descending — the only ordering the two star
 * boards are allowed to use. Forks are left out of every query, the same for both boards.
 */
export async function searchRepositories(query: string, perPage: number, page = 1): Promise<SearchPage> {
  const url = `${githubConfig.apiBaseUrl}/search/repositories?${new URLSearchParams({
    q: query, sort: "stars", order: "desc", per_page: String(Math.min(perPage, 100)), page: String(page),
  })}`;
  const body = JSON.parse((await githubGet(url)).text()) as Record<string, unknown>;
  const raw = Array.isArray(body.items) ? body.items : [];
  const items = raw.map(normalizeSearchItem).filter((item): item is GithubRepo => item !== null);
  return { items, incompleteResults: body.incomplete_results === true, totalCount: whole(body.total_count) ?? items.length };
}

/**
 * The whole star board: pages of 100 up to `limit`, stopping at the Search API's own 1,000-result ceiling
 * (方案 2.2 规则 4) or at the first rate-limited page, which makes the run partial instead of empty.
 */
export async function searchTopStars(limit: number): Promise<{ repos: GithubRepo[]; incompleteResults: boolean; rateLimited: string | null }> {
  // Paged by a moving key: stars change while the pages are being read, so GitHub can hand the same
  // repository back on two pages. A duplicate would trip the board's (board_type, repository_id) key and
  // roll back the whole replacement, so the first sighting is the one that counts.
  const byId = new Map<number, GithubRepo>();
  let incompleteResults = false;
  let rateLimited: string | null = null;
  const pages = Math.min(Math.ceil(limit / 100), 10);
  for (let page = 1; page <= pages && byId.size < limit; page++) {
    try {
      const found = await searchRepositories("stars:>0 fork:false", 100, page);
      for (const repo of found.items) if (!byId.has(repo.githubId)) byId.set(repo.githubId, repo);
      incompleteResults ||= found.incompleteResults;
    } catch (error) {
      if (!(error instanceof GithubRateLimited)) throw error;
      rateLimited = error.message;
      break;
    }
  }
  return { repos: [...byId.values()].slice(0, limit), incompleteResults, rateLimited };
}

/**
 * One AI topic's candidates, keeping the topics that produced them (方案 2.3 规则 3). A topic that fails
 * does not stop the others; the caller records the run as partial (方案 7.3). A rate-limited topic does stop
 * them: the limit is on the token, not on the topic, so the remaining queries would only be refused.
 */
export async function searchTopic(topic: string, perPage: number): Promise<{ repos: GithubRepo[]; incompleteResults: boolean; error: string | null; rateLimited: boolean }> {
  try {
    const found = await searchRepositories(`stars:>0 fork:false topic:${topic}`, perPage);
    return { repos: found.items, incompleteResults: found.incompleteResults, error: null, rateLimited: false };
  } catch (error) {
    const rateLimited = error instanceof GithubRateLimited;
    return { repos: [], incompleteResults: false, rateLimited, error: `${topic}: ${(error as Error).message}`.slice(0, 400) };
  }
}
