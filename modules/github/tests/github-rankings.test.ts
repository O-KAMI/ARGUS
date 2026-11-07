// The module's database behaviour: one row per repository, boards that are replaced rather than appended
// to, the four boards' own orders, and a run that fails leaving the previous board readable (方案 11.1, 11.3).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { readBoard, readCategories, readRepository, readStatus } from "../backend/api.ts";
import { classifyRepository } from "../backend/classify.ts";
import {
  applyClassifications, finishRun, replaceBoard, setManualClassification, startRun, upsertRepositories,
  type RepoInput,
} from "../backend/store.ts";

after(async () => { await closeDb(); });

const repo = (githubId: number | null, fullName: string, extra: Partial<RepoInput> = {}): RepoInput => ({
  githubId,
  nodeId: githubId === null ? null : `NODE_${githubId}`,
  fullName,
  ownerLogin: fullName.split("/")[0]!,
  name: fullName.split("/")[1]!,
  htmlUrl: `https://github.com/${fullName}`,
  description: null,
  homepage: null,
  language: null,
  stargazersCount: 0,
  forksCount: null,
  openIssuesCount: null,
  licenseSpdxId: null,
  topics: [],
  isFork: false,
  isArchived: false,
  createdAt: null,
  updatedAt: null,
  pushedAt: null,
  matchedTopics: [],
  profile: "complete",
  ...extra,
});

/** Collects and classifies the way one refresh does, without the network. */
async function collect(inputs: readonly RepoInput[]) {
  const saved = await upsertRepositories(inputs);
  await applyClassifications(saved.toClassify.map((row) => {
    const result = classifyRepository({
      fullName: row.full_name,
      description: row.description,
      topics: row.topics,
      matchedTopics: row.matched_topics,
      manualOverride: row.manual_override,
    });
    return {
      pk: row.pk, isAi: result.isAi, primaryCategory: result.primaryCategory, categories: result.categories,
      method: result.method, confidence: result.confidence, matchedTopics: result.matchedTopics,
    };
  }));
  return saved;
}

const count = async (table: "github_repositories" | "github_ranking_entries" | "github_collection_runs") => {
  const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ${sql(table)}`;
  return rows[0]!.n;
};

// Four repositories, two of them AI, collected once for the tests that read boards.
const WEEKLY = [
  repo(null, "acme/plain-tool", { description: "A plain command line tool.", language: "Go", stargazersCount: 100 }),
  repo(2001, "ai-lab/llm-kit", { description: "An LLM toolkit.", topics: ["llm"], language: "Python", stargazersCount: 50 }),
  repo(2002, "acme/big-service", { description: "A large service.", language: "Go", stargazersCount: 900 }),
  repo(2003, "ai-lab/agent-kit", { description: "Build autonomous AI agents.", topics: ["ai-agent"], language: "Rust", stargazersCount: 10 }),
];

test("one repository keeps one row however often it is collected", async () => {
  const first = await collect([repo(1001, "acme/repeat", { description: "First pass.", stargazersCount: 10 })]);
  const second = await collect([repo(1001, "acme/repeat", { description: "First pass.", stargazersCount: 10 })]);
  assert.equal(first.pks.get("acme/repeat"), second.pks.get("acme/repeat"));
  assert.equal(second.unchanged, 1, "nothing a reader sees changed, so only the collection time moves");
  assert.equal(second.inserted, 0);
  const [rows] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM github_repositories WHERE full_name = 'acme/repeat'`;
  assert.equal(rows!.n, 1);

  const changed = await collect([repo(1001, "acme/repeat", { description: "Second pass.", stargazersCount: 42 })]);
  assert.equal(changed.updated, 1);
  const [saved] = await sql<{ stargazers_count: number; description: string }[]>`
    SELECT stargazers_count, description FROM github_repositories WHERE github_id = 1001`;
  assert.equal(saved!.stargazers_count, 42);
  assert.equal(saved!.description, "Second pass.");
});

test("a renamed repository is followed by its GitHub id, and its full_name is updated", async () => {
  const before = await collect([repo(1101, "old-owner/old-name", { description: "Kept." })]);
  const after = await collect([repo(1101, "new-owner/new-name", { description: "Kept." })]);
  assert.equal(before.pks.get("old-owner/old-name"), after.pks.get("new-owner/new-name"));
  const rows = await sql<{ full_name: string }[]>`SELECT full_name FROM github_repositories WHERE github_id = 1101`;
  assert.deepEqual(rows.map((row) => row.full_name), ["new-owner/new-name"]);
});

test("a trending card without an id picks its id up from a later search run", async () => {
  const trending = await collect([repo(null, "page-only/from-trending", { stargazersCount: 7 })]);
  const searched = await collect([repo(1201, "page-only/from-trending", { stargazersCount: 7, topics: ["llm"] })]);
  assert.equal(trending.pks.get("page-only/from-trending"), searched.pks.get("page-only/from-trending"));
  const [row] = await sql<{ github_id: number | null }[]>`SELECT github_id FROM github_repositories WHERE full_name = 'page-only/from-trending'`;
  assert.equal(row!.github_id, 1201);
});

test("a board is replaced on refresh, never appended to", async () => {
  const saved = await collect(WEEKLY);
  const at = new Date();
  const entries = WEEKLY.map((item, index) => ({
    repositoryId: saved.pks.get(item.fullName.toLowerCase())!, rank: index + 1, sourceRank: index + 1, sourceUrl: "https://github.com/trending?since=weekly",
  }));
  await replaceBoard("all_weekly", entries, at);
  await replaceBoard("all_weekly", entries.slice(0, 2), at);
  const board = await readBoard({ board: "all_weekly", page: 1, pageSize: 20, language: null, category: null, keyword: null });
  assert.equal(board.total, 2, "the second refresh's two rows are the whole board");
  assert.equal(board.items.length, 2);
  assert.deepEqual(board.items.map((item) => item.rank), [1, 2]);
});

test("the weekly board keeps GitHub's order and the AI weekly board is its filtered subset", async () => {
  const saved = await collect(WEEKLY);
  const pk = (fullName: string) => saved.pks.get(fullName.toLowerCase())!;
  const at = new Date();
  // GitHub's own order, which is not the star order: 100, 50, 900, 10.
  const weekly = WEEKLY.map((item, index) => ({ repositoryId: pk(item.fullName), rank: index + 1, sourceRank: index + 1, sourceUrl: "t" }));
  await replaceBoard("all_weekly", weekly, at);
  const aiWeekly = weekly.filter((entry) => ["ai-lab/llm-kit", "ai-lab/agent-kit"].includes(WEEKLY[entry.rank - 1]!.fullName))
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
  await replaceBoard("ai_weekly", aiWeekly, at);

  const all = await readBoard({ board: "all_weekly", page: 1, pageSize: 20, language: null, category: null, keyword: null });
  assert.deepEqual(all.items.map((item) => item.fullName), ["acme/plain-tool", "ai-lab/llm-kit", "acme/big-service", "ai-lab/agent-kit"]);
  assert.deepEqual(all.items.map((item) => item.stargazersCount), [100, 50, 900, 10], "not re-sorted by stars");

  const ai = await readBoard({ board: "ai_weekly", page: 1, pageSize: 20, language: null, category: null, keyword: null });
  assert.deepEqual(ai.items.map((item) => [item.fullName, item.rank, item.sourceRank]), [
    ["ai-lab/llm-kit", 1, 2], ["ai-lab/agent-kit", 2, 4],
  ], "its own consecutive number beside GitHub's position");
});

test("the star boards read back in cumulative-star order", async () => {
  const saved = await collect(WEEKLY);
  const pk = (fullName: string) => saved.pks.get(fullName.toLowerCase())!;
  const byStars = [...WEEKLY].sort((a, b) => b.stargazersCount! - a.stargazersCount! || a.fullName.localeCompare(b.fullName));
  await replaceBoard("all_stars", byStars.map((item, index) => ({ repositoryId: pk(item.fullName), rank: index + 1, sourceRank: null, sourceUrl: item.htmlUrl })), new Date());
  await replaceBoard("ai_stars", byStars.filter((item) => item.fullName.startsWith("ai-lab/"))
    .map((item, index) => ({ repositoryId: pk(item.fullName), rank: index + 1, sourceRank: null, sourceUrl: item.htmlUrl })), new Date());

  const all = await readBoard({ board: "all_stars", page: 1, pageSize: 20, language: null, category: null, keyword: null });
  assert.deepEqual(all.items.map((item) => item.fullName), ["acme/big-service", "acme/plain-tool", "ai-lab/llm-kit", "ai-lab/agent-kit"]);
  const ai = await readBoard({ board: "ai_stars", page: 1, pageSize: 20, language: null, category: null, keyword: null });
  assert.deepEqual(ai.items.map((item) => item.fullName), ["ai-lab/llm-kit", "ai-lab/agent-kit"], "50 stars before 10");
});

test("filters narrow a board without changing the order of what is left", async () => {
  const query = { board: "all_stars" as const, page: 1, pageSize: 20, language: null, category: null, keyword: null };
  const go = await readBoard({ ...query, language: "Go" });
  assert.deepEqual(go.items.map((item) => item.fullName), ["acme/big-service", "acme/plain-tool"]);
  const keyword = await readBoard({ ...query, keyword: "agent" });
  assert.deepEqual(keyword.items.map((item) => item.fullName), ["ai-lab/agent-kit"]);
  const category = await readBoard({ ...query, board: "ai_stars", category: "agent" });
  assert.deepEqual(category.items.map((item) => item.fullName), ["ai-lab/agent-kit"]);
  // A category is not a filter of the whole-site board (方案 8.1); it is ignored there.
  const ignored = await readBoard({ ...query, category: "agent" });
  assert.equal(ignored.filters.category, null);
  assert.equal(ignored.total, 4);
  // Freshness belongs to the board's collection run, not to the reader's filter: a keyword that matches
  // nothing is an empty result, and the page must not turn it into "更新失败".
  assert.ok(go.fetchedAt, "the board was collected at a known time");
  const empty = await readBoard({ ...query, keyword: "zzz-no-such-repository" });
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.items, []);
  assert.equal(empty.fetchedAt, go.fetchedAt, "the filter did not move the board's own time");
  assert.equal(empty.stale, go.stale, "an empty filter result is not a stale board");
});

test("an administrator's exclusion survives the next collection", async () => {
  const saved = await collect([repo(1301, "ai-lab/overruled", { description: "An LLM agent framework.", topics: ["llm"] })]);
  const pk = saved.pks.get("ai-lab/overruled")!;
  const [before] = await sql<{ is_ai: boolean }[]>`SELECT is_ai FROM github_repositories WHERE pk = ${pk}`;
  assert.equal(before!.is_ai, true);

  // Put it on an AI board so the read side can be watched: an exclusion has to leave the board at once,
  // because in a private deployment the next refresh may not come for a long time.
  const [agentKit] = await sql<{ pk: number }[]>`SELECT pk FROM github_repositories WHERE full_name = 'ai-lab/agent-kit'`;
  const onBoard = (repositoryId: number, rank: number) => ({ repositoryId, rank, sourceRank: null, sourceUrl: `https://github.com/r/${rank}` });
  const aiStars = { board: "ai_stars" as const, page: 1, pageSize: 20, language: null, category: null, keyword: null };
  await replaceBoard("ai_stars", [onBoard(pk, 1), onBoard(agentKit!.pk, 2)], new Date());
  const names = async () => (await readBoard(aiStars)).items.map((item) => item.fullName);
  assert.deepEqual(await names(), ["ai-lab/overruled", "ai-lab/agent-kit"]);

  assert.equal(await setManualClassification(pk, "exclude", null), true);
  assert.deepEqual(await names(), ["ai-lab/agent-kit"], "the exclusion took the repository off the AI board at once");
  // The next run sees changed metadata, but the row is an administrator's to decide.
  const again = await collect([repo(1301, "ai-lab/overruled", { description: "An even better LLM agent framework.", topics: ["llm", "ai-agent"] })]);
  assert.equal(again.toClassify.length, 0, "a manual row is not handed to the classifier again");
  const [after] = await sql<{ is_ai: boolean; classification_method: string }[]>`
    SELECT is_ai, classification_method FROM github_repositories WHERE pk = ${pk}`;
  assert.equal(after!.is_ai, false);
  assert.equal(after!.classification_method, "manual");

  assert.equal(await setManualClassification(pk, "include", "agent"), true);
  const [included] = await sql<{ is_ai: boolean; ai_primary_category: string }[]>`
    SELECT is_ai, ai_primary_category FROM github_repositories WHERE pk = ${pk}`;
  assert.equal(included!.is_ai, true);
  assert.equal(included!.ai_primary_category, "agent");
  assert.deepEqual(await names(), ["ai-lab/overruled", "ai-lab/agent-kit"], "a manual inclusion is on the board at once too");

  // Undoing an override is not an exclusion: the rules run again over the evidence already stored, so the
  // repository keeps the verdict its topics earned instead of falling off the AI boards.
  assert.equal(await setManualClassification(pk, null, null), true);
  const [restored] = await sql<{ is_ai: boolean; classification_method: string; ai_primary_category: string | null; ai_categories: string[]; manual_override: string | null }[]>`
    SELECT is_ai, classification_method, ai_primary_category, ai_categories, manual_override FROM github_repositories WHERE pk = ${pk}`;
  assert.equal(restored!.manual_override, null);
  assert.equal(restored!.is_ai, true, "the rules' verdict came back");
  assert.equal(restored!.classification_method, "topic");
  assert.equal(restored!.ai_primary_category, "agent");
  assert.deepEqual(restored!.ai_categories, ["agent", "llm"]);
  assert.deepEqual(await names(), ["ai-lab/overruled", "ai-lab/agent-kit"], "undoing put it back on the AI board");

  assert.equal(await setManualClassification(999_999_999, "exclude", null), false, "an unknown repository is not created");
});

test("a failed run leaves the previous board readable and says the data is old", async () => {
  const fresh = await readBoard({ board: "all_weekly", page: 1, pageSize: 20, language: null, category: null, keyword: null });
  assert.equal(fresh.total, 4, "the board the order test wrote is still there");
  const run = await startRun("trending");
  await finishRun(run, { status: "failed", errorMessage: "GitHub trending did not answer" });
  const afterFailure = await readBoard({ board: "all_weekly", page: 1, pageSize: 20, language: null, category: null, keyword: null });
  assert.equal(afterFailure.total, fresh.total, "a failed refresh left the previous board alone");
  assert.equal(afterFailure.stale, true);
  const status = await readStatus();
  assert.equal(status.runs[0]!.status, "failed");
  assert.equal(status.runs[0]!.sourceType, "trending");
});

test("the detail, category and status reads answer what the api promises", async () => {
  const saved = await collect(WEEKLY);
  const detail = await readRepository(saved.pks.get("ai-lab/agent-kit")!);
  assert.ok(detail);
  assert.equal(detail!.repository.fullName, "ai-lab/agent-kit");
  assert.equal(detail!.repository.aiPrimaryCategory, "agent");
  assert.equal(detail!.manualOverride, null);
  assert.equal(detail!.classificationMethod, "topic");
  assert.ok(detail!.boards.length >= 1, "the boards it is on");
  assert.ok(detail!.classifiedAt);
  assert.equal(await readRepository(999_999_999), null);

  const categories = await readCategories();
  const agent = categories.categories.find((entry) => entry.category === "agent");
  assert.ok(agent && agent.count >= 1);
  assert.equal(agent!.label, "AI Agent");
  assert.equal(categories.taxonomyVersion.length > 0, true);

  const status = await readStatus();
  assert.equal(status.boards.length, 4);
  assert.ok(status.repositories >= 4);
  assert.ok(status.aiRepositories >= 2);
  assert.equal(typeof status.tokenConfigured, "boolean");
  assert.equal(await count("github_repositories") > 0, true);
});

// 审计 2026-11-04 四.8：Search 的答复是完整画像，它的空值是「确认没有」（下架主页、清空 topics、取消归档）；
// 趋势卡片只带部分字段，它的沉默必须保留存量值。补 github_id、语言、Fork、license、homepage 不再是 unchanged。
test("a Search run's confirmed absences clear, and a trending card's silences keep", async () => {
  const first = await collect([repo(3001, "meta/fill", {
    description: "Old.", homepage: "https://old.example", language: "Go", licenseSpdxId: "MIT",
    topics: ["llm"], isArchived: true, stargazersCount: 5,
  })]);
  const pk = first.pks.get("meta/fill")!;
  const second = await collect([repo(3001, "meta/fill", { description: "Old.", language: "Rust", stargazersCount: 5 })]);
  assert.equal(second.updated, 1, "cleared and filled fields are a visible update, not 'unchanged'");
  const [row] = await sql<{ homepage: string | null; license_spdx_id: string | null; topics: string[]; is_archived: boolean; language: string | null }[]>`
    SELECT homepage, license_spdx_id, topics, is_archived, language FROM github_repositories WHERE pk = ${pk}`;
  assert.deepEqual([row!.homepage, row!.license_spdx_id, row!.topics, row!.is_archived, row!.language], [null, null, [], false, "Rust"]);
  const third = await collect([repo(null, "meta/fill", { stargazersCount: 5, profile: "partial" })]);
  assert.equal(third.unchanged, 1, "a card that carries none of these fields changes none");
  const [still] = await sql<{ language: string | null; topics: string[]; is_archived: boolean }[]>`
    SELECT language, topics, is_archived FROM github_repositories WHERE pk = ${pk}`;
  assert.deepEqual([still!.language, still!.topics, still!.is_archived], ["Rust", [], false]);
});

test("only classification evidence sends a row back to the classifier", async () => {
  const first = await collect([repo(3002, "meta/lang-only", { description: "Desc.", language: "Go", stargazersCount: 1 })]);
  assert.equal(first.toClassify.length, 1);
  const second = await collect([repo(3002, "meta/lang-only", { description: "Desc.", language: "Rust", stargazersCount: 1 })]);
  assert.equal(second.updated, 1);
  assert.equal(second.toClassify.length, 0, "a language fill is visible but is not new classification evidence");
  const third = await collect([repo(3002, "meta/lang-only", { description: "Desc, rewritten.", language: "Rust", stargazersCount: 1 })]);
  assert.equal(third.toClassify.length, 1, "a rewritten description is new evidence");
});
