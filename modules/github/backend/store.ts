// The module's whole database surface: what collection writes, what the api reads. Boards hold only their
// current version and are replaced inside one transaction, so a failed refresh leaves the previous result
// readable (方案 6.4, 7.3).
import { sql, type Sql } from "@aihot/backend/db";
import type { AiCategory, BoardType, ClassificationMethod } from "../contract.ts";
import { classifyRepository } from "./classify.ts";
import { githubConfig } from "./config.ts";

export type SourceType = "trending" | "search_all" | "search_ai";
export type RunStatus = "running" | "success" | "partial" | "failed";

/** Everything collection knows about one repository; a trending card leaves the Search-only fields null. */
export interface RepoInput {
  githubId: number | null;
  nodeId: string | null;
  fullName: string;
  ownerLogin: string;
  name: string;
  htmlUrl: string;
  description: string | null;
  homepage: string | null;
  language: string | null;
  stargazersCount: number | null;
  forksCount: number | null;
  openIssuesCount: number | null;
  licenseSpdxId: string | null;
  topics: string[];
  isFork: boolean;
  isArchived: boolean;
  createdAt: Date | null;
  updatedAt: Date | null;
  pushedAt: Date | null;
  /** The topic queries that produced it, kept beside the repository for the admin (方案 2.3 规则 3). */
  matchedTopics: string[];
  /**
   * Whether this reading carries the repository's whole profile. A Search answer does, so its nulls are
   * confirmed absences (a removed homepage, cleared topics, an un-archived repository); a trending card
   * does not, so what it lacks keeps the stored value.
   */
  profile: "partial" | "complete";
}

export interface RepositoryRow {
  pk: number;
  github_id: number | null;
  node_id: string | null;
  full_name: string;
  owner_login: string;
  name: string;
  html_url: string;
  description: string | null;
  homepage: string | null;
  language: string | null;
  stargazers_count: number;
  forks_count: number | null;
  open_issues_count: number | null;
  license_spdx_id: string | null;
  topics: string[];
  is_fork: boolean;
  is_archived: boolean;
  created_at: Date | null;
  updated_at: Date | null;
  pushed_at: Date | null;
  is_ai: boolean;
  ai_primary_category: AiCategory | null;
  ai_categories: AiCategory[];
  classification_method: ClassificationMethod;
  classification_confidence: number;
  matched_topics: string[];
  manual_override: "include" | "exclude" | null;
  taxonomy_version: string;
  classified_at: Date | null;
  last_seen_at: Date;
  synced_at: Date;
}

export interface UpsertedRepositories {
  /** By the lower-cased full_name the caller supplied. */
  pks: Map<string, number>;
  /** The rows whose classification-relevant metadata is new or changed, and which no human has settled. */
  toClassify: RepositoryRow[];
  inserted: number;
  updated: number;
  unchanged: number;
}

/** The fields whose change makes a classification worth recomputing. */
const CLASSIFICATION_INPUTS = ["description", "topics", "full_name", "name"] as const;

/** A trending card fills only part of a row: what it does not carry keeps the value a Search run wrote. */
const merge = <T>(incoming: T | null, existing: T | null): T | null => (incoming === null || incoming === undefined ? existing : incoming);

/**
 * Upserts one collection's repositories. GitHub's Repository ID identifies a renamed repository, so a row
 * whose id matches is updated with its new full_name; a row only a trending page has seen is matched by
 * full_name and picks up its id when a later Search run reports one (方案 11.1 用例 10).
 */
export async function upsertRepositories(inputs: readonly RepoInput[], db: Sql = sql): Promise<UpsertedRepositories> {
  const byName = new Map<string, RepoInput>();
  for (const input of inputs) {
    const key = input.fullName.toLowerCase();
    const earlier = byName.get(key);
    // The same repository from two topic queries keeps one row and both topics (方案 2.3 规则 6).
    if (!earlier || earlier.githubId === null) byName.set(key, earlier ? { ...input, matchedTopics: [...new Set([...earlier.matchedTopics, ...input.matchedTopics])] } : input);
    else byName.set(key, { ...earlier, matchedTopics: [...new Set([...earlier.matchedTopics, ...input.matchedTopics])] });
  }
  const wanted = [...byName.values()];
  if (wanted.length === 0) return { pks: new Map(), toClassify: [], inserted: 0, updated: 0, unchanged: 0 };

  const names = wanted.map((r) => r.fullName.toLowerCase());
  const ids = wanted.flatMap((r) => (r.githubId === null ? [] : [r.githubId]));
  const existing = await db<RepositoryRow[]>`
    SELECT * FROM github_repositories WHERE lower(full_name) = ANY(${names})${ids.length ? db` OR github_id = ANY(${ids})` : db``}`;
  const byId = new Map(existing.flatMap((row) => (row.github_id === null ? [] : [[row.github_id, row] as const])));
  const byLower = new Map(existing.map((row) => [row.full_name.toLowerCase(), row]));

  const pks = new Map<string, number>();
  const toClassify: RepositoryRow[] = [];
  const untouched: number[] = [];
  let inserted = 0;
  let updated = 0;

  for (const input of wanted) {
    const key = input.fullName.toLowerCase();
    // The id wins over the name: a renamed repository is the same repository, and a trending placeholder
    // that already took the new name gives way to it.
    const matchedById = input.githubId === null ? undefined : byId.get(input.githubId);
    const matchedByName = byLower.get(key);
    if (matchedById && matchedByName && matchedById.pk !== matchedByName.pk && matchedByName.github_id === null) {
      await db`DELETE FROM github_repositories WHERE pk = ${matchedByName.pk}`;
      byLower.delete(key);
    }
    const row = matchedById ?? matchedByName;

    if (!row) {
      const [created] = await db<RepositoryRow[]>`
        INSERT INTO github_repositories (
          github_id, node_id, full_name, owner_login, name, html_url, description, homepage, language,
          stargazers_count, forks_count, open_issues_count, license_spdx_id, topics, is_fork, is_archived,
          created_at, updated_at, pushed_at, matched_topics, taxonomy_version, last_seen_at, synced_at
        ) VALUES (
          ${input.githubId}, ${input.nodeId}, ${input.fullName}, ${input.ownerLogin}, ${input.name}, ${input.htmlUrl},
          ${input.description}, ${input.homepage}, ${input.language}, ${input.stargazersCount ?? 0}, ${input.forksCount},
          ${input.openIssuesCount}, ${input.licenseSpdxId}, ${db.json(input.topics)}, ${input.isFork}, ${input.isArchived},
          ${input.createdAt}, ${input.updatedAt}, ${input.pushedAt}, ${db.json(input.matchedTopics)}, ${githubConfig.taxonomyVersion}, now(), now()
        ) RETURNING *`;
      inserted++;
      pks.set(key, created!.pk);
      byId.set(created!.github_id ?? -created!.pk, created!);
      byLower.set(key, created!);
      toClassify.push(created!);
      continue;
    }

    const whole = input.profile === "complete";
    const kept = <T,>(incoming: T | null, existing: T | null): T | null => (whole ? incoming : merge(incoming, existing));
    const merged: RepositoryRow = {
      ...row,
      github_id: merge(input.githubId, row.github_id),
      node_id: merge(input.nodeId, row.node_id),
      full_name: input.fullName,
      owner_login: input.ownerLogin,
      name: input.name,
      html_url: input.htmlUrl,
      description: kept(input.description, row.description),
      homepage: kept(input.homepage, row.homepage),
      language: kept(input.language, row.language),
      stargazers_count: input.stargazersCount ?? row.stargazers_count,
      forks_count: kept(input.forksCount, row.forks_count),
      open_issues_count: kept(input.openIssuesCount, row.open_issues_count),
      license_spdx_id: kept(input.licenseSpdxId, row.license_spdx_id),
      topics: whole ? input.topics : (input.topics.length ? input.topics : row.topics),
      is_fork: whole ? input.isFork : input.isFork || row.is_fork,
      is_archived: whole ? input.isArchived : input.isArchived || row.is_archived,
      created_at: kept(input.createdAt, row.created_at),
      updated_at: kept(input.updatedAt, row.updated_at),
      pushed_at: kept(input.pushedAt, row.pushed_at),
      matched_topics: [...new Set([...row.matched_topics, ...input.matchedTopics])],
    };
    // "The profile changed" and "the classification inputs changed" are two questions: filling github_id,
    // language, forks, license or homepage is a visible update worth writing, but only description, topics
    // and the names are evidence the classifier reads again (and a human's verdict still stands over it).
    const profileOf = (r: RepositoryRow) => JSON.stringify([
      r.github_id, r.node_id, r.full_name, r.owner_login, r.name, r.html_url, r.description, r.homepage,
      r.language, r.stargazers_count, r.forks_count, r.open_issues_count, r.license_spdx_id, [...r.topics].sort(),
      r.is_fork, r.is_archived, r.created_at?.getTime() ?? null, r.updated_at?.getTime() ?? null, r.pushed_at?.getTime() ?? null,
    ]);
    const profileChanged = profileOf(merged) !== profileOf(row);
    const classificationChanged = CLASSIFICATION_INPUTS.some((field) => {
      const before = field === "topics" ? [...row.topics].sort().join(",") : String(row[field] ?? "");
      const after = field === "topics" ? [...merged.topics].sort().join(",") : String(merged[field] ?? "");
      return before !== after;
    });
    if (!profileChanged) {
      untouched.push(row.pk);
      pks.set(key, row.pk);
      if (row.taxonomy_version !== githubConfig.taxonomyVersion && !row.manual_override) toClassify.push(row);
      continue;
    }
    const [saved] = await db<RepositoryRow[]>`
      UPDATE github_repositories SET
        github_id = ${merged.github_id}, node_id = ${merged.node_id}, full_name = ${merged.full_name},
        owner_login = ${merged.owner_login}, name = ${merged.name}, html_url = ${merged.html_url},
        description = ${merged.description}, homepage = ${merged.homepage}, language = ${merged.language},
        stargazers_count = ${merged.stargazers_count}, forks_count = ${merged.forks_count},
        open_issues_count = ${merged.open_issues_count}, license_spdx_id = ${merged.license_spdx_id},
        topics = ${db.json(merged.topics)}, is_fork = ${merged.is_fork}, is_archived = ${merged.is_archived},
        created_at = ${merged.created_at}, updated_at = ${merged.updated_at}, pushed_at = ${merged.pushed_at},
        matched_topics = ${db.json(merged.matched_topics)}, last_seen_at = now(), synced_at = now()
      WHERE pk = ${row.pk} RETURNING *`;
    updated++;
    pks.set(key, saved!.pk);
    byId.set(saved!.github_id ?? -saved!.pk, saved!);
    byLower.set(key, saved!);
    // An administrator's verdict stands: a later run never reclassifies over it (方案 3.4).
    if (classificationChanged && !saved!.manual_override) toClassify.push(saved!);
  }

  if (untouched.length) await db`UPDATE github_repositories SET last_seen_at = now() WHERE pk = ANY(${untouched})`;
  return { pks, toClassify, inserted, updated, unchanged: untouched.length };
}

export interface ClassificationWrite {
  pk: number;
  isAi: boolean;
  primaryCategory: AiCategory | null;
  categories: AiCategory[];
  method: ClassificationMethod;
  confidence: number;
  matchedTopics: string[];
}

/** Writes the classifier's verdicts and stamps the taxonomy version they came from. */
export async function applyClassifications(rows: readonly ClassificationWrite[]): Promise<number> {
  let applied = 0;
  for (const row of rows) {
    // The WHERE keeps an administrator's verdict out of reach, so the rows asked for and the rows written
    // are not the same number; the result reports the ones actually written.
    const result = await sql`
      UPDATE github_repositories SET
        is_ai = ${row.isAi}, ai_primary_category = ${row.primaryCategory}, ai_categories = ${sql.json(row.categories)},
        classification_method = ${row.method}, classification_confidence = ${row.confidence},
        matched_topics = ${sql.json(row.matchedTopics)}, taxonomy_version = ${githubConfig.taxonomyVersion},
        classified_at = now()
      WHERE pk = ${row.pk} AND manual_override IS NULL`;
    applied += result.count;
  }
  return applied;
}

/** An administrator's include / exclude, and an optional corrected primary category (方案 8.4). */
export async function setManualClassification(pk: number, override: "include" | "exclude" | null, primaryCategory: AiCategory | null): Promise<boolean> {
  const [evidence] = await sql<Pick<RepositoryRow, "full_name" | "description" | "topics" | "matched_topics">[]>`
    SELECT full_name, description, topics, matched_topics FROM github_repositories WHERE pk = ${pk}`;
  if (!evidence) return false;
  // Undoing hands the row back to the rules, which then run again over the evidence already stored. Stamping
  // it "topic" with nothing classified would drop it off the AI boards while claiming the rules had spoken.
  const ruled = classifyRepository({
    fullName: evidence.full_name,
    description: evidence.description,
    topics: evidence.topics,
    matchedTopics: evidence.matched_topics,
    manualOverride: override,
  });
  const isAi = override === null ? ruled.isAi : override === "include";
  const primary = override === "include" ? primaryCategory : override === "exclude" ? null : ruled.primaryCategory;
  const [row] = await sql<RepositoryRow[]>`
    UPDATE github_repositories SET
      manual_override = ${override},
      is_ai = ${isAi},
      ai_primary_category = ${primary},
      ai_categories = ${sql.json(override === null ? ruled.categories : primary ? [primary] : [])},
      classification_method = ${override === null ? ruled.method : "manual"},
      classification_confidence = ${override === null ? ruled.confidence : 1},
      classified_at = now()
    WHERE pk = ${pk} RETURNING *`;
  return !!row;
}

export interface BoardEntry {
  repositoryId: number;
  rank: number;
  sourceRank: number | null;
  sourceUrl: string;
}

/**
 * Replaces one board's current ranking in a transaction: the delete and the insert land together or not at
 * all, so a half-written board is never served and a failed refresh keeps the previous one.
 */
export async function replaceBoard(board: BoardType, entries: readonly BoardEntry[], fetchedAt: Date): Promise<number> {
  await sql.begin(async (tx) => {
    await tx`DELETE FROM github_ranking_entries WHERE board_type = ${board}`;
    for (const entry of entries) {
      await tx`
        INSERT INTO github_ranking_entries (board_type, repository_id, rank, source_rank, fetched_at, source_url)
        VALUES (${board}, ${entry.repositoryId}, ${entry.rank}, ${entry.sourceRank}, ${fetchedAt}, ${entry.sourceUrl})`;
    }
  });
  return entries.length;
}

export type BoardCoverage = "complete" | "partial" | "empty";

export interface BoardStateRow {
  board_type: BoardType;
  last_attempt_at: Date | null;
  last_complete_at: Date | null;
  version_at: Date | null;
  coverage: BoardCoverage | null;
  entries: number;
  last_status: string | null;
}

/** What the last attempts left each board at: served version, its coverage, and when it was last read. */
export async function readBoardStates(boards: readonly BoardType[] = ["all_weekly", "all_stars", "ai_weekly", "ai_stars"]): Promise<Map<BoardType, BoardStateRow>> {
  const rows = await sql<BoardStateRow[]>`SELECT * FROM github_board_state WHERE board_type = ANY(${boards})`;
  return new Map(rows.map((row) => [row.board_type, row]));
}

/**
 * One row per board, written with the board itself: an attempt that replaced nothing still lands here.
 * The caller decides what a kept board keeps (it holds the previous state); this writes the verdict.
 */
export async function writeBoardState(state: {
  board: BoardType; lastAttemptAt: Date; lastStatus: string; entries: number;
  coverage: BoardCoverage | null; versionAt: Date | null; lastCompleteAt: Date | null;
}): Promise<void> {
  await sql`
    INSERT INTO github_board_state (board_type, last_attempt_at, last_complete_at, version_at, coverage, entries, last_status, updated_at)
    VALUES (${state.board}, ${state.lastAttemptAt}, ${state.lastCompleteAt}, ${state.versionAt},
            ${state.coverage}, ${state.entries}, ${state.lastStatus}, now())
    ON CONFLICT (board_type) DO UPDATE SET
      last_attempt_at = EXCLUDED.last_attempt_at,
      last_complete_at = EXCLUDED.last_complete_at,
      version_at = EXCLUDED.version_at,
      coverage = EXCLUDED.coverage,
      entries = EXCLUDED.entries,
      last_status = EXCLUDED.last_status,
      updated_at = now()`;
}

export async function startRun(sourceType: SourceType): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO github_collection_runs (source_type, status) VALUES (${sourceType}, 'running') RETURNING id`;
  return row!.id;
}

export async function finishRun(id: string, result: { status: RunStatus; itemsCount?: number | null; errorMessage?: string | null; incompleteResults?: boolean }): Promise<void> {
  await sql`
    UPDATE github_collection_runs SET
      status = ${result.status}, finished_at = now(), items_count = ${result.itemsCount ?? null},
      error_message = ${result.errorMessage ?? null}, incomplete_results = ${result.incompleteResults ?? false}
    WHERE id = ${id}`;
}

/** Collection runs are a log, not a record to keep: the daily retention run leaves the last 30 days. */
export async function pruneCollectionRuns(olderThan: Date): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    DELETE FROM github_collection_runs WHERE created_at < ${olderThan} RETURNING id`;
  return rows.length;
}

/** Repositories no board lists and no run has seen for a year: the reader-facing data never mentions them. */
export async function pruneUnseenRepositories(olderThan: Date): Promise<number> {
  const rows = await sql<{ pk: number }[]>`
    DELETE FROM github_repositories WHERE last_seen_at < ${olderThan} RETURNING pk`;
  return rows.length;
}
