// What the api answers: the four boards, one repository, the AI categories and the admin's status page.
// Reads only — nothing here touches GitHub, and no model is called (AGENTS.md).
import { sql } from "@aihot/backend/db";
import { AI_CATEGORIES, AI_CATEGORY_LABELS, BOARD_COPY, BOARDS, type AiCategory, type BoardType, type CategoriesResponse, type CollectionStatus, type RankingRepository, type RankingResponse, type RepositoryDetail } from "../contract.ts";
import { collectionEnabled, githubConfig } from "./config.ts";
import { readBoardStates, type RunStatus, type SourceType } from "./store.ts";

/** Which collection run a board's freshness comes from. */
const BOARD_SOURCE: Record<BoardType, SourceType> = {
  all_weekly: "trending",
  ai_weekly: "trending",
  all_stars: "search_all",
  ai_stars: "search_ai",
};

/** A board older than this is called stale even when its last run succeeded: the daily refresh did not come. */
const STALE_AFTER_MS = 30 * 3600_000;

interface BoardRow {
  rank: number;
  source_rank: number | null;
  fetched_at: Date;
  pk: number;
  full_name: string;
  owner_login: string;
  name: string;
  html_url: string;
  description: string | null;
  homepage: string | null;
  language: string | null;
  stargazers_count: number;
  forks_count: number | null;
  topics: string[];
  is_ai: boolean;
  ai_primary_category: AiCategory | null;
  ai_categories: AiCategory[];
  is_archived: boolean;
  updated_at: Date | null;
}

export interface BoardQuery {
  board: BoardType;
  page: number;
  pageSize: number;
  language: string | null;
  category: AiCategory | null;
  keyword: string | null;
}

/** Filters are the only thing a reader may change on a board; the order always stays the board's own. */
function filters(query: BoardQuery) {
  const language = query.language ? sql`AND r.language = ${query.language}` : sql``;
  // A category narrows only the AI boards: the whole-site ones are not about categories (方案 8.1).
  const aiBoard = query.board === "ai_weekly" || query.board === "ai_stars";
  const category = query.category && aiBoard ? sql`AND r.ai_categories @> ${sql.json([query.category])}::jsonb` : sql``;
  const keyword = query.keyword
    ? sql`AND (r.full_name ILIKE ${`%${query.keyword}%`} OR r.description ILIKE ${`%${query.keyword}%`})`
    : sql``;
  // An AI board answers from the verdict as it stands now, not as it stood when the board was written: an
  // administrator's exclusion takes effect at once instead of waiting for a refresh that may not come.
  const stillAi = aiBoard ? sql`AND r.is_ai` : sql``;
  return sql`${language} ${category} ${keyword} ${stillAi}`;
}

const repository = (row: BoardRow): RankingRepository => ({
  repositoryId: row.pk,
  rank: row.rank,
  sourceRank: row.source_rank,
  fullName: row.full_name,
  ownerLogin: row.owner_login,
  name: row.name,
  htmlUrl: row.html_url,
  description: row.description,
  homepage: row.homepage,
  language: row.language,
  stargazersCount: row.stargazers_count,
  forksCount: row.forks_count,
  topics: row.topics,
  isAi: row.is_ai,
  aiPrimaryCategory: row.ai_primary_category,
  aiCategories: row.ai_categories,
  isArchived: row.is_archived,
  updatedAt: row.updated_at ? row.updated_at.toISOString() : null,
  fetchedAt: row.fetched_at.toISOString(),
});

export async function readBoard(query: BoardQuery): Promise<RankingResponse> {
  const where = filters(query);
  const rows = await sql<BoardRow[]>`
    SELECT e.rank, e.source_rank, e.fetched_at, r.pk, r.full_name, r.owner_login, r.name, r.html_url,
           r.description, r.homepage, r.language, r.stargazers_count, r.forks_count, r.topics,
           r.is_ai, r.ai_primary_category, r.ai_categories, r.is_archived, r.updated_at
    FROM github_ranking_entries e JOIN github_repositories r ON r.pk = e.repository_id
    WHERE e.board_type = ${query.board} ${where}
    ORDER BY e.rank, e.repository_id
    LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`;
  const [totals] = await sql<{ total: number; languages: string[] | null }[]>`
    SELECT count(*)::int AS total,
           (SELECT array_agg(DISTINCT l ORDER BY l) FROM (
              SELECT r2.language AS l FROM github_ranking_entries e2
              JOIN github_repositories r2 ON r2.pk = e2.repository_id
              WHERE e2.board_type = ${query.board} AND r2.language IS NOT NULL) distinct_languages) AS languages
    FROM github_ranking_entries e JOIN github_repositories r ON r.pk = e.repository_id
    WHERE e.board_type = ${query.board} ${where}`;
  // Freshness belongs to the board's collection run, not to the reader's filter: a keyword that matches
  // nothing is an empty result, and calling it "更新失败" would be a lie about a run that succeeded.
  const [freshness] = await sql<{ fetched_at: Date | null }[]>`
    SELECT max(fetched_at) AS fetched_at FROM github_ranking_entries WHERE board_type = ${query.board}`;

  const fetchedAt = freshness?.fetched_at ?? null;
  const [lastRun] = await sql<{ status: RunStatus }[]>`
    SELECT status FROM github_collection_runs WHERE source_type = ${BOARD_SOURCE[query.board]}
    ORDER BY started_at DESC LIMIT 1`;
  const [boardState] = await readBoardStates([query.board]).then((map) => [map.get(query.board)]);
  const stale = fetchedAt === null
    || lastRun?.status === "failed" || lastRun?.status === "partial"
    || Date.now() - fetchedAt.getTime() > STALE_AFTER_MS;

  const total = totals?.total ?? 0;
  const aiBoard = query.board === "ai_weekly" || query.board === "ai_stars";
  return {
    board: query.board,
    basis: BOARD_COPY[query.board].basis,
    items: rows.map(repository),
    page: query.page,
    pageSize: query.pageSize,
    total,
    pageCount: Math.max(Math.ceil(total / query.pageSize), 1),
    filters: { language: query.language, category: aiBoard ? query.category : null, keyword: query.keyword },
    languages: totals?.languages ?? [],
    fetchedAt: fetchedAt ? fetchedAt.toISOString() : null,
    stale,
    coverage: boardState?.coverage ?? null,
  };
}

export async function readRepository(repositoryId: number): Promise<RepositoryDetail | null> {
  const [row] = await sql<(BoardRow & {
    node_id: string | null; is_fork: boolean; open_issues_count: number | null; license_spdx_id: string | null;
    created_at: Date | null; pushed_at: Date | null; classification_method: string; classification_confidence: number;
    matched_topics: string[]; manual_override: "include" | "exclude" | null; taxonomy_version: string;
    classified_at: Date | null; last_seen_at: Date; synced_at: Date;
  })[]>`
    SELECT r.*, now() AS fetched_at, 0 AS rank, NULL::int AS source_rank FROM github_repositories r WHERE r.pk = ${repositoryId}`;
  if (!row) return null;
  const boards = await sql<{ board_type: BoardType; rank: number; source_rank: number | null }[]>`
    SELECT board_type, rank, source_rank FROM github_ranking_entries WHERE repository_id = ${repositoryId} ORDER BY rank, board_type`;
  return {
    repository: repository(row),
    boards: boards.map((entry) => ({
      board: entry.board_type,
      label: BOARD_COPY[entry.board_type].label,
      rank: entry.rank,
      sourceRank: entry.source_rank,
    })),
    classificationMethod: row.classification_method as RepositoryDetail["classificationMethod"],
    classificationConfidence: Number(row.classification_confidence),
    matchedTopics: row.matched_topics,
    manualOverride: row.manual_override,
    taxonomyVersion: row.taxonomy_version,
    classifiedAt: row.classified_at ? row.classified_at.toISOString() : null,
    isFork: row.is_fork,
    openIssuesCount: row.open_issues_count,
    licenseSpdxId: row.license_spdx_id,
    nodeId: row.node_id,
    createdAt: row.created_at ? row.created_at.toISOString() : null,
    pushedAt: row.pushed_at ? row.pushed_at.toISOString() : null,
    lastSeenAt: row.last_seen_at.toISOString(),
    syncedAt: row.synced_at.toISOString(),
  };
}

/** The AI categories with how many repositories each holds, for the filter (方案 8.3). */
export async function readCategories(): Promise<CategoriesResponse> {
  const rows = await sql<{ category: AiCategory; count: number }[]>`
    SELECT category, count(*)::int AS count
    FROM github_repositories, jsonb_array_elements_text(ai_categories) AS category
    WHERE is_ai GROUP BY category`;
  const counts = new Map(rows.map((row) => [row.category, row.count]));
  return {
    categories: AI_CATEGORIES.map((category) => ({ category, label: AI_CATEGORY_LABELS[category], count: counts.get(category) ?? 0 })),
    taxonomyVersion: githubConfig.taxonomyVersion,
  };
}

export async function readStatus(): Promise<CollectionStatus> {
  const [counts] = await sql<{ repositories: number; ai_repositories: number }[]>`
    SELECT (SELECT count(*)::int FROM github_repositories) AS repositories,
           (SELECT count(*)::int FROM github_repositories WHERE is_ai) AS ai_repositories`;
  const boards = await sql<{ board_type: BoardType; entries: number; fetched_at: Date | null }[]>`
    SELECT board_type, count(*)::int AS entries, max(fetched_at) AS fetched_at
    FROM github_ranking_entries GROUP BY board_type`;
  const byBoard = new Map(boards.map((row) => [row.board_type, row]));
  const runs = await sql<{ id: string; source_type: SourceType; status: RunStatus; started_at: Date; finished_at: Date | null; items_count: number | null; error_message: string | null; incomplete_results: boolean }[]>`
    SELECT id, source_type, status, started_at, finished_at, items_count, error_message, incomplete_results
    FROM github_collection_runs ORDER BY started_at DESC LIMIT 20`;
  return {
    tokenConfigured: !!githubConfig.token,
    collectEnabled: collectionEnabled(),
    taxonomyVersion: githubConfig.taxonomyVersion,
    refreshCron: githubConfig.refreshCron,
    repositories: counts?.repositories ?? 0,
    aiRepositories: counts?.ai_repositories ?? 0,
    boards: BOARDS.map((board) => ({
      board,
      label: BOARD_COPY[board].label,
      entries: byBoard.get(board)?.entries ?? 0,
      fetchedAt: byBoard.get(board)?.fetched_at?.toISOString() ?? null,
    })),
    runs: runs.map((run) => ({
      id: run.id,
      sourceType: run.source_type,
      status: run.status,
      startedAt: run.started_at.toISOString(),
      finishedAt: run.finished_at ? run.finished_at.toISOString() : null,
      itemsCount: run.items_count,
      errorMessage: run.error_message,
      incompleteResults: run.incomplete_results,
    })),
  };
}
