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
  applyClassifications, finishRun, replaceBoard, startRun, upsertRepositories,
  type BoardEntry, type RepoInput,
} from "./store.ts";

export interface BoardOutcome {
  board: BoardType;
  /** How many rows the board now has; 0 means it was left at its previous version. */
  entries: number;
  replaced: boolean;
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
});

/** The weekly boards' shared source: the trending page, whose order is the ranking (方案 4.1). */
async function collectTrending(problems: string[]): Promise<{ items: TrendingItem[]; sourceUrl: string }> {
  const run = await startRun("trending");
  try {
    const page = await fetchTrendingWeekly();
    problems.push(...page.warnings);
    await finishRun(run, { status: "success", itemsCount: page.items.length });
    return { items: page.items, sourceUrl: page.sourceUrl };
  } catch (error) {
    const message = (error as Error).message.slice(0, 2000);
    await finishRun(run, { status: "failed", errorMessage: message });
    problems.push(error instanceof TrendingParseError ? message
      : error instanceof GithubRateLimited ? `周榜采集被限流，保留上一版周榜：${message}`
        : `周榜采集失败，保留上一版周榜：${message}`);
    return { items: [], sourceUrl: githubConfig.trendingWeeklyUrl };
  }
}

/** The whole star board: pages of the Search API by cumulative stars (方案 2.2). */
async function collectAllStars(problems: string[]): Promise<GithubRepo[]> {
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
    return found.repos;
  } catch (error) {
    await finishRun(run, { status: "failed", errorMessage: (error as Error).message.slice(0, 2000) });
    problems.push(`总榜采集失败，保留上一版总榜：${(error as Error).message.slice(0, 400)}`);
    return [];
  }
}

/** A candidate the topic search found, with the topics that found it: the classifier's evidence (方案 3.1). */
type AiCandidate = GithubRepo & { matchedTopics: string[] };

/**
 * The AI board's candidates: one Search API query per topic in the library, merged by GitHub Repository ID.
 * A topic that fails is reported and the others still complete (方案 2.3, 7.3). A rate-limited topic ends the
 * loop: the limit is on the token, so the topics after it would each be refused in turn (方案 7.3 不要持续快速重试).
 */
async function collectAiTopics(problems: string[]): Promise<AiCandidate[]> {
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
  await finishRun(run, {
    status: repos.length === 0 ? "failed" : failures.length || incompleteResults ? "partial" : "success",
    itemsCount: repos.length,
    incompleteResults,
    errorMessage: failures.length ? failures.slice(0, 5).join("；").slice(0, 2000) : null,
  });
  return repos;
}

/** `null` leaves the board at its previous version: an empty source is never an empty board. */
async function writeBoard(board: BoardType, entries: BoardEntry[] | null, fetchedAt: Date): Promise<BoardOutcome> {
  if (entries === null || entries.length === 0) {
    const [kept] = await sql<{ entries: number }[]>`SELECT count(*)::int AS entries FROM github_ranking_entries WHERE board_type = ${board}`;
    return { board, entries: kept?.entries ?? 0, replaced: false };
  }
  return { board, entries: await replaceBoard(board, entries, fetchedAt), replaced: true };
}

async function collect(reason: string): Promise<RefreshResult> {
  const startedAt = new Date();
  const problems: string[] = [];

  const trending = await collectTrending(problems);
  const allStars = await collectAllStars(problems);
  const aiTopics = await collectAiTopics(problems);

  const inputs: RepoInput[] = [
    ...trending.items.map(trendingInput),
    ...allStars.map((repo) => repoInput(repo, ["search:stars"])),
    ...aiTopics.map((repo) => repoInput(repo, repo.matchedTopics.map((topic) => `topic:${topic}`))),
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
  for (const repo of allStars) {
    const repositoryId = pkOf(repo.fullName);
    if (repositoryId === undefined) continue;
    starBoard.push({ repositoryId, rank: starBoard.length + 1, sourceRank: null, sourceUrl: repo.htmlUrl });
  }
  // AI 总榜：the topic candidates that are AI, by stars and then by full_name so equal stars stay put.
  const aiStars = aiTopics
    .filter((repo) => {
      const repositoryId = pkOf(repo.fullName);
      return repositoryId !== undefined && aiFlags.get(repositoryId);
    })
    .sort((a, b) => b.stargazersCount - a.stargazersCount || a.fullName.localeCompare(b.fullName))
    .map((repo, index) => ({ repositoryId: pkOf(repo.fullName)!, rank: index + 1, sourceRank: null, sourceUrl: repo.htmlUrl }));

  const boards = [
    await writeBoard("all_weekly", trending.items.length ? weekly : null, fetchedAt),
    await writeBoard("ai_weekly", trending.items.length ? aiWeekly : null, fetchedAt),
    await writeBoard("all_stars", allStars.length ? starBoard : null, fetchedAt),
    await writeBoard("ai_stars", aiTopics.length ? aiStars : null, fetchedAt),
  ];
  for (const outcome of boards) {
    if (!outcome.replaced) problems.push(`${outcome.board} 没有新数据，保留上一版榜单`);
  }

  return {
    reason,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    trendingItems: trending.items.length,
    allStarsCandidates: allStars.length,
    aiTopicCandidates: aiTopics.length,
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
export function refreshGithubRankings(reason = "schedule"): Promise<RefreshResult> {
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
