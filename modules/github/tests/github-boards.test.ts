// 审计 2026-11-04 四.8 的榜版本规则：完整读取（含合法空集）发布为新版本；partial 与 failed 不替换既有
// 完整榜，冷启动时才以已观测候选先行并明确标注 partial；采集阀关闭时任何入口都不发请求、不写运行记录。
// 人工纳入的仓库即使本轮查询没见过，也参与 AI 总榜候选。
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";

let mode: "full" | "partial-ai" | "empty-trending" | "empty-search" = "full";
let requests = 0;
const failedTopics = new Set<string>();

const card = (owner: string, repo: string, stars: number, description = "A repository card.") => `
  <article class="Box-row">
    <h2 class="h3 lh-condensed">
      <a href="/${owner}/${repo}" data-view-component="true" class="Link">
        <span class="text-normal">${owner} /</span>
        ${repo}
      </a>
    </h2>
    <p class="col-9 color-fg-muted my-1 pr-4">${description}</p>
    <div class="f6 color-fg-muted mt-2">
      <span class="d-inline-block ml-0 mr-3" itemprop="programmingLanguage">Python</span>
      <a class="Link--muted d-inline-block mr-3" href="/${owner}/${repo}/stargazers">${stars.toLocaleString("en-US")}</a>
      <a class="Link--muted d-inline-block mr-3" href="/${owner}/${repo}/forks">10</a>
      <span class="d-inline-block float-sm-right">100 stars this week</span>
    </div>
  </article>`;
const page = (...cards: string[]) => `<!doctype html><html><body><main><div class="application-main">${cards.join("")}</div></main></body></html>`;

const apiRepo = (id: number, fullName: string, stars: number) => ({
  id, node_id: `N${id}`, full_name: fullName, owner: { login: fullName.split("/")[0] }, name: fullName.split("/")[1],
  html_url: `https://github.com/${fullName}`, description: "An AI toolkit.", homepage: null, language: "Python",
  stargazers_count: stars, forks_count: 10, open_issues_count: 3, license: null, topics: ["llm"],
  fork: false, archived: false, created_at: "2024-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", pushed_at: "2026-01-01T00:00:00Z",
});
const json = (res: import("node:http").ServerResponse, items: unknown[]) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ total_count: items.length, incomplete_results: false, items }));
};

const server = createServer((req, res) => {
  requests += 1;
  const url = new URL(req.url!, "http://stub");
  if (url.pathname === "/trending") {
    const cards = mode === "empty-trending" ? [] : [
      card("ai-lab", "agent-kit", 12_000, "Build autonomous AI agents with LLMs."),
      card("small-org", "tiny-tool", 900, "A plain command line tool."),
      card("ml-org", "vector-store", 5_400, "Vector database for RAG."),
      card("no-lang", "plain-thing", 3_100, "Something else entirely."),
      card("big-org", "huge-repo", 98_000, "An enormous project."),
    ];
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(page(...cards));
  }
  if (url.pathname === "/search/repositories") {
    const q = url.searchParams.get("q") ?? "";
    const topic = q.includes("topic:");
    // A run reads the star board before the topics: one run, one failure budget. A topic in the budget
    // fails on every retry, so the run really observes a partial AI reading.
    if (!topic) failedTopics.clear();
    if (topic && mode === "partial-ai") {
      if (!failedTopics.has(q) && failedTopics.size < 2) failedTopics.add(q);
      if (failedTopics.has(q)) {
        res.writeHead(500, { "content-type": "application/json" });
        return res.end("{}");
      }
    }
    if (mode === "empty-search") return json(res, []);
    if (topic) return json(res, [apiRepo(2003, "ai-lab/agent-kit", 12_000)]);
    return json(res, [apiRepo(2003, "ai-lab/agent-kit", 12_000), apiRepo(2002, "acme/big-service", 900)]);
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end("{}");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
process.env.GITHUB_API_BASE_URL = `http://127.0.0.1:${port}`;
process.env.GITHUB_TRENDING_WEEKLY_URL = `http://127.0.0.1:${port}/trending`;
process.env.GITHUB_TOKEN = "test-token";
process.env.COLLECT_ENABLED = "true";

const { refreshGithubRankings } = await import("../backend/collect.ts");
const { readBoard } = await import("../backend/api.ts");
const { readBoardStates, setManualClassification, upsertRepositories } = await import("../backend/store.ts");
const { config } = await import("@aihot/backend/config");
const { closeDb, sql } = await import("@aihot/backend/db");
config.allowPrivateNetworkFetch = true;

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeDb();
});

const boardRows = (board: string) => sql<{ repository_id: number; rank: number }[]>`
  SELECT repository_id, rank FROM github_ranking_entries WHERE board_type = ${board} ORDER BY rank`;

test("a complete run publishes every board as a complete version", async () => {
  const result = await refreshGithubRankings("test-full");
  assert.equal(result.disabled, undefined);
  assert.deepEqual(result.problems, []);
  const states = await readBoardStates();
  for (const board of ["all_weekly", "all_stars", "ai_weekly", "ai_stars"] as const) {
    assert.ok(states.get(board)?.coverage === "complete" || states.get(board)?.coverage === "empty",
      `${board} serves a whole version of its own, got ${states.get(board)?.coverage}`);
    assert.ok(states.get(board)?.version_at, `${board} records the version's own time`);
  }
  const ai = await readBoard({ board: "ai_stars", page: 1, pageSize: 20, language: null, category: null, keyword: null });
  assert.equal(ai.coverage, "complete");
  assert.deepEqual(ai.items.map((item) => item.name), ["agent-kit"]);
});

test("a manual include joins the AI stars board without appearing in this run's queries", async () => {
  const saved = await upsertRepositories([{
    githubId: 4004, nodeId: "N4004", fullName: "manual/only-repo", ownerLogin: "manual", name: "only-repo",
    htmlUrl: "https://github.com/manual/only-repo", description: "A hand-included AI repo.", homepage: null,
    language: "Python", stargazersCount: 999_999, forksCount: 1, openIssuesCount: 1, licenseSpdxId: null,
    topics: [], isFork: false, isArchived: false, createdAt: null, updatedAt: null, pushedAt: null,
    matchedTopics: [], profile: "complete",
  }]);
  const pk = saved.pks.get("manual/only-repo")!;
  assert.equal(await setManualClassification(pk, "include", "llm"), true);
  const result = await refreshGithubRankings("test-manual");
  assert.deepEqual(result.problems, []);
  const ai = await readBoard({ board: "ai_stars", page: 1, pageSize: 20, language: null, category: null, keyword: null });
  assert.deepEqual(ai.items.map((item) => item.fullName), ["manual/only-repo", "ai-lab/agent-kit"], "the included repo ranks by stars in the same version");
});

test("a partial AI reading never replaces a complete AI board, while the weekly boards move on", async () => {
  const before = await boardRows("ai_stars");
  const weeklyBefore = (await readBoardStates()).get("all_weekly")?.version_at;
  mode = "partial-ai";
  try {
    const result = await refreshGithubRankings("test-partial");
    assert.ok(result.problems.some((problem) => problem.includes("ai_stars")), `the kept board is said out loud; problems: ${result.problems.join(" | ")}`);
    const states = await readBoardStates();
    assert.equal(states.get("ai_stars")?.coverage, "complete", "the served AI board keeps its complete coverage");
    assert.equal(states.get("ai_stars")?.last_status, "partial", "the attempt is recorded as partial");
    assert.ok(states.get("all_weekly")!.version_at!.getTime() > weeklyBefore!.getTime(), "an unaffected board still moves");
  } finally {
    mode = "full";
  }
  assert.deepEqual(await boardRows("ai_stars"), before, "not one row of the complete board moved");
});

test("a cold start serves observed candidates as an explicitly partial board, until a complete run", async () => {
  await sql`DELETE FROM github_ranking_entries WHERE board_type = 'ai_stars'`;
  await sql`DELETE FROM github_board_state WHERE board_type = 'ai_stars'`;
  mode = "partial-ai";
  try {
    await refreshGithubRankings("test-cold");
    const cold = await readBoard({ board: "ai_stars", page: 1, pageSize: 20, language: null, category: null, keyword: null });
    assert.equal(cold.coverage, "partial", "the reader is told this is candidates, not a snapshot");
    assert.ok(cold.items.length > 0, "the observed candidates are still readable");
  } finally {
    mode = "full";
  }
  await refreshGithubRankings("test-cold-complete");
  const done = await readBoard({ board: "ai_stars", page: 1, pageSize: 20, language: null, category: null, keyword: null });
  assert.equal(done.coverage, "complete");
});

test("a complete empty search clears the star board, and a suspicious empty trending page keeps its board", async () => {
  mode = "empty-search";
  try {
    await refreshGithubRankings("test-empty-search");
    const states = await readBoardStates();
    assert.equal(states.get("all_stars")?.coverage, "empty", "an answered-empty star search clears the star board");
    assert.equal(states.get("all_stars")?.entries, 0);
    assert.ok(states.get("all_stars")?.last_complete_at, "the empty answer is still a valid verification");
    assert.equal(states.get("all_weekly")?.coverage, "complete", "the untouched weekly board keeps serving");
  } finally {
    mode = "full";
  }
  await refreshGithubRankings("test-refill");
  mode = "empty-trending";
  try {
    const before = await boardRows("all_weekly");
    await refreshGithubRankings("test-empty-trending");
    const states = await readBoardStates();
    assert.equal(states.get("all_weekly")?.last_status, "failed", "a page with no cards at all is a parse failure, not an empty board");
    assert.deepEqual(await boardRows("all_weekly"), before, "so the weekly board stays at its complete version");
  } finally {
    mode = "full";
  }
  await refreshGithubRankings("test-refill-2");
});

test("a closed collection valve answers disabled from every entrance, with no request and no run", async () => {
  process.env.COLLECT_ENABLED = "false";
  try {
    const runs = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM github_collection_runs`;
    const seen = requests;
    const result = await refreshGithubRankings("admin:button");
    assert.equal(result.disabled, true);
    assert.equal(requests, seen, "zero external requests");
    assert.deepEqual((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM github_collection_runs`)[0]!.n, runs[0]!.n, "no run row for a run that never happened");
    const queued = await refreshGithubRankings("queue-leftover");
    assert.equal(queued.disabled, true, "the queue's entrance shares the valve");
  } finally {
    process.env.COLLECT_ENABLED = "true";
  }
});