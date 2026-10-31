// FxTwitter's public API: free, keyless X timelines and posts. Requests do not go through receipts or
// the paid-request budget; a failing call is the caller's signal to fall back to RSS or SocialData.
import { config } from "../config.ts";
import { guardedFetch } from "../lib/http-fetch.ts";

export interface FxUser {
  id?: string;
  name?: string;
  screen_name?: string;
  avatar_url?: string;
  url?: string;
}

export interface FxMediaItem {
  id?: string;
  type?: string;
  url?: string;
  thumbnail_url?: string;
  width?: number;
  height?: number;
  altText?: string;
}

export interface FxReplyRef {
  screen_name?: string;
  status?: string;
  url?: string;
}

export interface FxArticle {
  title?: string;
  /** DraftJS blocks, the same shape SocialData returns for an article. */
  content?: { blocks?: Array<{ type?: string; text?: string }> };
}

export interface FxStatus {
  id: string;
  url?: string;
  text?: string;
  author?: FxUser;
  created_at?: string;
  created_timestamp?: number;
  replying_to?: FxReplyRef | null;
  reposted_by?: FxUser | null;
  quote?: FxStatus | null;
  media?: { all?: FxMediaItem[] } | null;
  /** The long-form article the post published, when it has one. */
  article?: FxArticle | null;
  likes?: number;
  reposts?: number;
  replies?: number;
  quotes?: number;
  views?: number;
  lang?: string;
}

export interface FxTimeline {
  statuses: FxStatus[];
  /** FxTwitter's token for the next older page. */
  cursor: string | null;
}

/** Raw HTTP requests left for one source run, including retries (not merely successful pages). */
export interface FxRequestBudget {
  remaining: number;
}

class FxRequestBudgetExhausted extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(path: string, budget?: FxRequestBudget): Promise<{ status: number; body: any }> {
  if (budget) {
    if (budget.remaining <= 0) throw new FxRequestBudgetExhausted();
    budget.remaining -= 1;
  }
  const res = await guardedFetch(`${config.fxTwitterBaseUrl.replace(/\/$/, "")}${path}`, {
    headers: { accept: "application/json" },
    timeoutMs: 30_000,
    maxBytes: 8 * 1024 * 1024,
    route: "direct",
  });
  const text = res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

async function once(path: string, budget?: FxRequestBudget) {
  try {
    return await request(path, budget);
  } catch (error) {
    if (error instanceof FxRequestBudgetExhausted) throw error;
    await sleep(400);
    return request(path, budget);
  }
}

/**
 * One timeline page. FxTwitter sometimes answers 404 for a page that does exist (guest-token/cache
 * hiccups), so a 404 is retried a few times and then treated as a failure: the caller falls back to
 * RSS instead of silently recording an empty timeline. 204 genuinely means no posts. A caller paging
 * a backlog supplies one raw-request budget shared by every page and retry.
 */
export async function fetchFxTimeline(handle: string, cursor?: string | null, opts: { requestBudget?: FxRequestBudget } = {}): Promise<FxTimeline> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const path = `/2/profile/${encodeURIComponent(handle)}/statuses${query}`;
  let lastStatus = 0;
  let lastBody: any = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await sleep(700);
    let res: Awaited<ReturnType<typeof request>>;
    try {
      res = await once(path, opts.requestBudget);
    } catch (error) {
      if (error instanceof FxRequestBudgetExhausted) break;
      continue;
    }
    lastStatus = res.status;
    lastBody = res.body;
    if (res.status === 204) return { statuses: [], cursor: null };
    if (res.body?.code === 404) continue;
    if (res.status !== 200 || !Array.isArray(res.body?.results)) break;
    const next = res.body?.cursor?.bottom;
    return { statuses: res.body.results as FxStatus[], cursor: typeof next === "string" ? next : null };
  }
  const detail = lastBody?.message ?? lastBody?.error ?? `HTTP ${lastStatus}`;
  throw new Error(`fxtwitter ${lastStatus}: ${String(detail).slice(0, 200)}`);
}

/**
 * One post by id. Used for an account's current handle and for its article body. A 404 here is often
 * the same transient answer as the timeline's, so it is retried once before the caller pays SocialData;
 * a post that truly has no article answers 200 with `article` absent.
 */
export async function fetchFxStatus(id: string): Promise<FxStatus> {
  let lastStatus = 0;
  let lastBody: any = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await sleep(700);
    const res = await once(`/status/${encodeURIComponent(id)}`);
    lastStatus = res.status;
    lastBody = res.body;
    if (res.status === 200 && res.body?.tweet?.id) return res.body.tweet as FxStatus;
    if (res.status !== 404) break;
  }
  throw new Error(`fxtwitter status ${lastStatus}: ${String(lastBody?.message ?? "").slice(0, 200)}`);
}
