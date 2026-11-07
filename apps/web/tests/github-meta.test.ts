// Failure mode: /github?board=ai_stars showed the AI board but the tab title said "全站周榜" — the meta
// function read `data`, which MetaArgs never carries (it is `loaderData`), so every URL fell back to the
// default board's title, description and canonical. The browser test also covers switching boards and
// going back: the title must follow the board actually shown, not the one first loaded.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, expect, type Browser } from "@playwright/test";
import { BOARDS, BOARD_COPY, type RankingRepository, type RankingResponse } from "../../../modules/github/contract.ts";
import { fakeApi, startWebServer, visit, type WebServer } from "./web-server.ts";

const repo = (n: number): RankingRepository => ({
  repositoryId: n, rank: n, sourceRank: n, fullName: `owner/repo-${n}`, ownerLogin: "owner", name: `repo-${n}`,
  htmlUrl: `https://github.com/owner/repo-${n}`, description: `Fixture repository ${n}`, homepage: null,
  language: "TypeScript", stargazersCount: 1000 - n, forksCount: 10, topics: ["ai"], isAi: true,
  aiPrimaryCategory: "llm", aiCategories: ["llm"], isArchived: false, updatedAt: null, fetchedAt: "2026-11-01T08:00:00.000Z",
});

const api = fakeApi((url) => {
  if (url.pathname !== "/api/github/rankings") return undefined;
  const board = (url.searchParams.get("board") ?? "all_weekly") as RankingResponse["board"];
  const empty = url.searchParams.get("keyword") === "nomatch";
  const response: RankingResponse = {
    board, basis: BOARD_COPY[board].basis, items: empty ? [] : [repo(1), repo(2)], page: 1, pageSize: 20,
    total: empty ? 0 : 2, pageCount: 1, filters: { language: null, category: null, keyword: url.searchParams.get("keyword") },
    languages: ["TypeScript"], fetchedAt: "2026-11-01T08:00:00.000Z", stale: false, coverage: null,
  };
  return response;
});

let web: WebServer;
let chrome: Browser;

before(async () => {
  const started = await Promise.allSettled([
    startWebServer(api).then((w) => { web = w; }),
    chromium.launch({ channel: "chromium" }).then((b) => { chrome = b; }),
  ]);
  for (const result of started) if (result.status === "rejected") throw result.reason;
});

after(async () => {
  await chrome?.close();
  await web?.stop();
});

test("each board's URL titles, describes and canonicals itself; a filtered empty view keeps its board's title", async () => {
  for (const board of BOARDS) {
    const path = board === "all_weekly" ? "/github" : `/github?board=${board}`;
    const html = await (await fetch(`${web.origin}${path}`)).text();
    const copy = BOARD_COPY[board];
    assert.ok(html.includes(`<title>${copy.label} · GitHub 开源趋势`), `${path} is titled ${copy.label}`);
    assert.ok(html.includes(`content="${copy.basis} 发现值得关注的开源项目。"`), `${path} describes its own board`);
    const canonical = board === "all_weekly" ? "/github" : `/github?board=${board}`;
    assert.match(html, new RegExp(`rel="canonical" href="[^"]*${canonical.replace("?", "\\?")}"`), `${path} canonicals itself`);
    if (board !== "all_weekly") assert.ok(html.includes('name="robots" content="noindex, follow"'), `${path} stays out of the index`);
  }
  const filtered = await (await fetch(`${web.origin}/github?board=ai_stars&keyword=nomatch`)).text();
  assert.ok(filtered.includes("没有符合条件的项目"), "the empty filter view says so");
  assert.ok(filtered.includes(`<title>${BOARD_COPY.ai_stars.label} · GitHub 开源趋势`), "the empty view keeps the AI board's title");
});

test("switching boards and going back move the tab title and canonical with the board shown", async () => {
  const context = await chrome.newContext();
  const page = await context.newPage();
  try {
    await visit(page, `${web.origin}/github`);
    await expect(page).toHaveTitle(/^全站周榜 · GitHub 开源趋势/);
    await page.getByRole("navigation", { name: "榜单" }).getByRole("link", { name: "AI 总榜" }).click();
    await expect(page).toHaveTitle(/^AI 累计 Star 总榜 · GitHub 开源趋势/);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", /\/github\?board=ai_stars$/);
    await page.goBack();
    await expect(page).toHaveTitle(/^全站周榜 · GitHub 开源趋势/);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", /\/github$/);
  } finally {
    await context.close();
  }
});