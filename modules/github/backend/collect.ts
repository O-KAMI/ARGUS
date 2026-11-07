// One refresh of the four boards, in the plan's order (方案 7.2). Every source is collected first, the
// repositories are merged and classified once, and only then are the boards replaced — a source that fails
// leaves its own board at the previous version instead of emptying it (方案 2.1 规则 7, 7.3).
import { sql } from "@aihot/backend/db";
import { defineQueue } from "@aihot/backend/modules";
import type { BoardType } from "../contract.ts";
import { githubConfig } from "./config.ts";
import { AI_TOPIC_QUERIES, classifyRepository } from "./classify.ts";
import { GithubRateLimited, searchTopic, searchTopStars, type GithubRepo } from "./github-api.ts";
import { fetchTrendingWeekly, TrendingParseError, type TrendingItem } from "./trending.ts";
import {
  applyClassifications, finishRun, readBoardStates, replaceBoard, startRun, upsertRepositories, writeBoardState,
  type BoardCoverage, type BoardEntry, type RepoInput,
} from "./store.ts";
import { collectionEnabled } from "./config.ts";

/** How much of a board's source this run actually saw. */
export type SourceRead = "complete" | "empty" | "partial" | "failed";

export interface BoardOutcome {
  board: BoardType;
  /** How many rows the board now has; 0 means it was left at its previous version. */
  entries: number;
  replaced: boolean;
  /** The coverage of the version now served; a kept board keeps its previous coverage. */
  coverage: BoardCoverage | null;
}

export interface RefreshResult {
  reason: string;
  startedAt: string;
  finishedAt: string;
  trendingItems: number;
  allStarsCandidates: number;
  aiTopicCandidates: number;
  repositories: { inserted: number; updated: number; unchanged: number };
  classified: number;
  aiRepositories: number;
  boards: BoardOutcome[];
  /** What went wrong or looked odd, in the order it happened; the run is `partial` when this is not empty. */
  problems: string[];
  /** The collection valve is closed: nothing was read, nothing was written. */
  disabled?: boolean;
}

const repoInput = (repo: GithubRepo, matchedTopics: string[]): RepoInput => ({
  githubId: repo.githubId,
  nodeId: repo.nodeId,
  fullName: repo.fullName,
  ownerLogin: repo.ownerLogin,
  name: repo.name,
  htmlUrl: repo.htmlUrl,
  description: repo.description,
  homepage: repo.homepage,
  language: repo.language,
  stargazersCount: repo.stargazersCount,
  forksCount: repo.forksCount,
  openIssuesCount: repo.openIssuesCount,
  licenseSpdxId: repo.licenseSpdxId,
  topics: repo.topics,
  isFork: repo.isFork,
  isArchived: repo.isArchived,
  createdAt: repo.createdAt,
  updatedAt: repo.updatedAt,
  pushedAt: repo.pushedAt,
  matchedTopics,
  profile: "complete",
});

const trendingInput = (item: TrendingItem): RepoInput => ({
  githubId: null,
  nodeId: null,
  fullName: item.fullName,
  ownerLogin: item.ownerLogin,
  name: item.name,
  htmlUrl: item.htmlUrl,
  description: item.description,
  homepage: null,
  language: item.language,
  stargazersCount: item.stargazersCount,
  forksCount: item.forksCount,
  openIssuesCount: null,
  licenseSpdxId: null,
  topics: [],
  isFork: false,
  isArchived: false,
  createdAt: null,
  updatedAt: null,
  pushedAt: null,
  matchedTopics: ["trending-weekly"],
  profile: "partial",
});

/** The weekly boards' shared source: the trending page, whose order is the ranking (方案 4.1). */
async function collectTrending(problems: string[]): Promise<{ items: TrendingItem[]; sourceUrl: string; read: SourceRead }> {
  const run = await startRun("trending");
  try {
    const page = await fetchTrendingWeekly();
    problems.push(...page.warnings);
    await finishRun(run, { status: page.warnings.length ? "partial" : "success", itemsCount: page.items.length });
    return { items: page.items, sourceUrl: page.sourceUrl, read: page.warnings.length ? "partial" : page.items.length ? "complete" : "empty" };
  } catch (error) {
    const message = (error as Error).message.slice(0, 2000);
    await finishRun(run, { status: "failed", errorMessage: message });
    problems.push(error instanceof TrendingParseError ? message
      : error instanceof GithubRateLimited ? `周榜采集被限流，保留上一版周榜：${message}`
        : `周榜采集失败，保留上一版周榜：${message}`);
    return { items: [], sourceUrl: githubConfig.trendingWeeklyUrl, read: "failed" };
  }
}

/** The whole star board: pages of the Search API by cumulative stars (方案 2.2). */
async function collectAllStars(problems: string[]): Promise<{ repos: GithubRepo[]; read: SourceRead }> {
  const run = await startRun("search_all");
  try {
    const found = await searchTopStars(githubConfig.allStarsLimit);
    if (found.rateLimited) problems.push(`总榜候选被限流，只取到 ${found.repos.length} 个：${found.rateLimited}`);
    if (found.incompleteResults) problems.push("GitHub 搜索接口报告总榜结果不完整（incomplete_results）");
    await finishRun(run, {
      status: found.rateLimited || found.incompleteResults ? "partial" : "success",
      itemsCount: found.repos.length,
      incompleteResults: found.incompleteResults,
      errorMessage: found.rateLimited,
    });
    const read = found.rateLimited || found.incompleteResults ? "partial" : found.repos.length ? "complete" : "empty";
    return { repos: found.repos, read };
  } catch (error) {
    await finishRun(run, { status: "failed", errorMessage: (error as Error).message.slice(0, 2000) });
    problems.push(`总榜采集失败，保留上一版总榜：${(error as Error).message.slice(0, 400)}`);
    return { repos: [], read: "failed" };
  }
}

/** A candidate the topic search found, with the topics that found it: the classifier's evidence (方案 3.1). */
type AiCandidate = GithubRepo & { matchedTopics: string[] };

/**
 * The AI board's candidates: one Search API query per topic in the library, merged by GitHub Repository ID.
 * A topic that fails is reported and the others still complete (方案 2.3, 7.3). A rate-limited topic ends the
 * loop: the limit is on the token, so the topics after it would each be refused in turn (方案 7.3 不要持续快速重试).
 */
async function collectAiTopics(problems: string[]): Promise<{ repos: AiCandidate[]; read: SourceRead }> {
  const run = await startRun("search_ai");
  const byId = new Map<number, AiCandidate>();
  const failures: string[] = [];
  let incompleteResults = false;
  let queried = 0;
  for (const topic of AI_TOPIC_QUERIES) {
    const found = await searchTopic(topic, githubConfig.aiTopicPageSize);
    queried++;
    if (found.error) failures.push(found.error);
    incompleteResults ||= found.incompleteResults;
    for (const repo of found.repos) {
      const earlier = byId.get(repo.githubId);
      if (earlier) earlier.matchedTopics.push(topic);
      else byId.set(repo.githubId, { ...repo, matchedTopics: [topic] });
    }
    if (found.rateLimited) {
      const skipped = AI_TOPIC_QUERIES.length - queried;
      if (skipped > 0) problems.push(`搜索接口已限流，剩下 ${skipped} 个 AI Topic 本轮不再查询`);
      break;
    }
  }
  const repos = [...byId.values()];
  if (failures.length) problems.push(`${failures.length}/${AI_TOPIC_QUERIES.length} 个 AI Topic 查询失败：${failures.slice(0, 3).join("；")}`);
  if (incompleteResults) problems.push("GitHub 搜索接口报告 AI Topic 结果不完整（incomplete_results）");
  const degraded = failures.length > 0 || incompleteResults;
  await finishRun(run, {
    status: repos.length === 0 && queried === failures.length ? "failed" : degraded ? "partial" : "success",
    itemsCount: repos.length,
    incompleteResults,
    errorMessage: failures.length ? failures.slice(0, 5).join("；").slice(0, 2000) : null,
  });
  const read: SourceRead = repos.length ? (degraded ? "partial" : "complete") : queried === failures.length ? "failed" : degraded ? "partial" : "empty";
  return { repos, read };
}

/**
 * What one source reading may do to its board. A complete reading publishes its version, empty included:
 * a source that answers with nothing has cleared its board, and keeping the old rows would serve repos
 * the source no longer lists. A partial or failed reading never replaces a complete version — but with
 * no complete version yet (a cold start) the observed candidates are served, labelled partial.
 */
async function writeBoard(board: BoardType, entries: BoardEntry[], fetchedAt: Date, read: SourceRead): Promise<BoardOutcome> {
  const [state] = await readBoardStates([board]).then((map) => [map.get(board)]);
  const hadComplete = state?.coverage === "complete" || state?.coverage === "empty";
  const replace = read === "complete" || read === "empty" || (read === "partial" && !hadComplete);
  const rows = replace ? await replaceBoard(board, entries, fetchedAt) : null;
  const [kept] = rows === null
    ? await sql<{ entries: number }[]>`SELECT count(*)::int AS entries FROM github_ranking_entries WHERE board_type = ${board}`
    : [];
  const entriesNow = rows ?? kept?.entries ?? 0;
  // A kept board keeps the version it serves: its coverage, its version time and its last complete read.
  const coverage: BoardCoverage | null = replace ? (read === "partial" ? "partial" : entries.length ? "complete" : "empty") : state?.coverage ?? null;
  const versionAt = replace ? fetchedAt : state?.version_at ?? null;
  const lastCompleteAt = replace && (read === "complete" || read === "empty") ? fetchedAt : state?.last_complete_at ?? null;
  await writeBoardState({ board, lastAttemptAt: fetchedAt, lastStatus: read, entries: entriesNow, coverage, versionAt, lastCompleteAt });
  return { board, entries: entriesNow, replaced: replace, coverage };
}

async function collect(reason: string): Promise<RefreshResult> {
  const startedAt = new Date();
  const problems: string[] = [];

  const trending = await collectTrending(problems);
  const allStars = await collectAllStars(problems);
  const aiTopics = await collectAiTopics(problems);

  const inputs: RepoInput[] = [
    ...trending.items.map(trendingInput),
    ...allStars.repos.map((repo) => repoInput(repo, ["search:stars"])),
    ...aiTopics.repos.map((repo) => repoInput(repo, repo.matchedTopics.map((topic) => `topic:${topic}`))),
  ];
  const saved = await upsertRepositories(inputs);

  // Only new repositories and ones whose classification input changed are classified again (方案 7.1).
  const verdicts = saved.toClassify.map((row) => {
    const result = classifyRepository({
      fullName: row.full_name,
      description: row.description,
      topics: row.topics,
      matchedTopics: row.matched_topics,
      manualOverride: row.manual_override,
    });
    return {
      pk: row.pk,
      isAi: result.isAi,
      primaryCategory: result.primaryCategory,
      categories: result.categories,
      method: result.method,
      confidence: result.confidence,
      matchedTopics: result.matchedTopics,
    };
  });
  const classified = await applyClassifications(verdicts);

  // The boards read the verdicts back, so a manual override and this run's classifications weigh the same.
  const wanted = [...saved.pks.values()];
  const aiFlags = new Map<number, boolean>(wanted.length
    ? (await sql<{ pk: number; is_ai: boolean }[]>`SELECT pk, is_ai FROM github_repositories WHERE pk = ANY(${wanted})`).map((row) => [row.pk, row.is_ai])
    : []);
  const [counted] = await sql<{ aiRepositories: number }[]>`
    SELECT count(*)::int AS "aiRepositories" FROM github_repositories WHERE is_ai`;
  const aiRepositories = counted?.aiRepositories ?? 0;

  const fetchedAt = new Date();
  const pkOf = (fullName: string) => saved.pks.get(fullName.toLowerCase());

  // 全站周榜：GitHub's own order, untouched (方案 4.1).
  const weekly: BoardEntry[] = [];
  for (const item of trending.items) {
    const repositoryId = pkOf(item.fullName);
    if (repositoryId === undefined) continue;
    weekly.push({ repositoryId, rank: item.sourceRank, sourceRank: item.sourceRank, sourceUrl: trending.sourceUrl });
  }
  // AI 周榜：the same order, filtered, with its own consecutive number beside GitHub's position.
  const aiWeekly: BoardEntry[] = [];
  for (const entry of weekly) {
    if (!aiFlags.get(entry.repositoryId)) continue;
    aiWeekly.push({ ...entry, rank: aiWeekly.length + 1, sourceRank: entry.sourceRank });
  }
  // 全站总榜：the Search API's own star-descending order.
  const starBoard: BoardEntry[] = [];
  for (const repo of allStars.repos) {
    const repositoryId = pkOf(repo.fullName);
    if (repositoryId === undefined) continue;
    starBoard.push({ repositoryId, rank: starBoard.length + 1, sourceRank: null, sourceUrl: repo.htmlUrl });
  }
  // AI 总榜：the topic candidates that are AI, by stars and then by full_name so equal stars stay put.
  // An administrator's include joins the candidates even when this run's queries never saw the repository:
  // the verdict says what is AI, the run only says where it ranks (方案 8.4).
  const aiStarsPool = new Map<number, { stars: number; fullName: string; htmlUrl: string }>();
  for (const repo of aiTopics.repos) {
    const repositoryId = pkOf(repo.fullName);
    if (repositoryId !== undefined && aiFlags.get(repositoryId)) {
      aiStarsPool.set(repositoryId, { stars: repo.stargazersCount, fullName: repo.fullName, htmlUrl: repo.htmlUrl });
    }
  }
  for (const row of await sql<{ pk: number; full_name: string; html_url: string; stargazers_count: number }[]>`
    SELECT pk, full_name, html_url, stargazers_count FROM github_repositories WHERE manual_override = 'include' AND is_ai`) {
    if (!aiStarsPool.has(row.pk)) aiStarsPool.set(row.pk, { stars: row.stargazers_count, fullName: row.full_name, htmlUrl: row.html_url });
  }
  const aiStars = [...aiStarsPool.entries()]
    .sort((a, b) => b[1].stars - a[1].stars || a[1].fullName.localeCompare(b[1].fullName))
    .map(([repositoryId, repo], index) => ({ repositoryId, rank: index + 1, sourceRank: null, sourceUrl: repo.htmlUrl }));

  const boards = [
    await writeBoard("all_weekly", weekly, fetchedAt, trending.read),
    // The AI weekly board is the parent weekly's AI subset: it shares the parent's reading, and therefore
    // its version — a kept parent keeps its subset, a cleared parent clears it.
    await writeBoard("ai_weekly", aiWeekly, fetchedAt, trending.read),
    await writeBoard("all_stars", starBoard, fetchedAt, allStars.read),
    await writeBoard("ai_stars", aiStars, fetchedAt, aiTopics.read),
  ];
  for (const outcome of boards) {
    if (!outcome.replaced) problems.push(`${outcome.board} 没有可用的完整读取，保留上一版榜单`);
  }

  return {
    reason,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    trendingItems: trending.items.length,
    allStarsCandidates: allStars.repos.length,
    aiTopicCandidates: aiTopics.repos.length,
    repositories: { inserted: saved.inserted, updated: saved.updated, unchanged: saved.unchanged },
    classified,
    aiRepositories,
    boards,
    problems: problems.filter(Boolean),
  };
}

/** The crawl this process is already doing, if any. */
let inFlight: Promise<RefreshResult> | null = null;

/**
 * One crawl at a time in this process. The daily schedule calls this directly while the admin's button
 * arrives through the singleton queue, so the two can land together; two concurrent runs would replace the
 * same board twice and the second insert would trip its (board_type, repository_id) key, leaving the four
 * boards half-updated. The second caller joins the first and gets its result.
 */
const disabledResult = (reason: string): RefreshResult => {
  const at = new Date().toISOString();
  return {
    reason, startedAt: at, finishedAt: at, trendingItems: 0, allStarsCandidates: 0, aiTopicCandidates: 0,
    repositories: { inserted: 0, updated: 0, unchanged: 0 }, classified: 0, aiRepositories: 0, boards: [],
    problems: ["COLLECT_ENABLED 关闭，本次不采集：对外请求数为 0，榜单保持原版本"], disabled: true,
  };
};

export function refreshGithubRankings(reason = "schedule"): Promise<RefreshResult> {
  // The one execution entry every path shares: the schedule, the admin's button and leftover queue jobs.
  // Closed valve means no run row, no request and no board write, whichever door was knocked on.
  if (!collectionEnabled()) return Promise.resolve(disabledResult(reason));
  if (inFlight) return inFlight;
  const done = collect(reason).finally(() => { inFlight = null; });
  inFlight = done;
  return done;
}

/**
 * The admin's manual refresh, as a queue of its own beside the engine's: the request only enqueues, and a
 * second press while one is running joins it instead of starting a parallel crawl (方案 7.1, 8.4).
 */
export const githubRefreshQueue = defineQueue<{ reason: string }>({
  name: "github.refresh",
  options: { policy: "singleton", retryLimit: 1, retryDelay: 60_000, expireInSeconds: 3600 },
  worker: { pollingIntervalSeconds: 10 },
  run: async (jobs) => refreshGithubRankings(jobs.at(-1)?.reason ?? "manual"),
});
