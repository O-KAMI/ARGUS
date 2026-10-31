// The three feed filters: content type and technical direction read publication tags; source reads the
// platform publishing stored on the row, which publication/rules.ts platformOf derives from the channel,
// the source kind and the URL host. Every one combines with the legacy channel/category/tag filters on
// both the selected timeline and the public pool.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import type { CategoryKey, ChannelKey, PlatformKey } from "@aihot/contracts/taxonomy";
import { loadPool } from "@aihot/backend/publication/pool";
import { platformOf, type Platform } from "@aihot/backend/publication/rules";
import { loadTimeline } from "@aihot/backend/publication/timeline";
import { parseFilters } from "../apps/api/src/routes/site.ts";

const T = `feed-filters-${tag()}`;
const NEWS = `${T}-news`;
const MP = `${T}-mp`;
const X = `${T}-x`;
const KINDS: Record<string, string> = { [NEWS]: "rss", [MP]: "mp_account", [X]: "x_search" };
const now = new Date("2026-01-01T12:00:00Z");
const id = (suffix: string) => `${T}-${suffix}`;
after(closeDb);
before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier) VALUES
    (${NEWS}, ${NEWS}, 'rss', 'T1'), (${MP}, ${MP}, 'mp_account', 'T1'), (${X}, ${X}, 'x_search', 'T1')`;
});

interface SeedOptions {
  source?: string;
  channel?: "news" | "x";
  category?: string;
  tags?: string[];
  url?: string;
  age?: number;
  scope?: string;
  /** A platform no address derives (a mirror's); publishing stores those itself. */
  platform?: Platform;
}

async function seed(suffix: string, options: SeedOptions = {}) {
  const at = new Date(+now - (options.age ?? 60) * 1000);
  const url = options.url ?? `https://example.org/${id(suffix)}`;
  const source = options.source ?? NEWS;
  const channel = options.channel ?? "news";
  const platform = options.platform ?? platformOf(KINDS[source]!, channel, url);
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at)
    VALUES (${id(suffix)}, ${source}, ${id(suffix)}, ${url}, ${suffix}, ${at}, ${at})`;
  await sql`INSERT INTO publications (article_id, title, source_id, channel, platform, category, tags, url, discovered_at, timeline_at, sort_at,
    selected, eligible, visibility, visible_after)
    VALUES (${id(suffix)}, ${suffix}, ${source}, ${channel}, ${platform}, ${options.category ?? "ai-models"},
      ${[options.scope ?? T, ...(options.tags ?? [])]}, ${url}, ${at}, ${at}, ${at}, true, true, 'public', ${at})`;
}

type FeedFilters = {
  genre?: string | null;
  field?: string | null;
  platform?: PlatformKey;
  channel?: ChannelKey;
  category?: CategoryKey | null;
  tag?: string | null;
};

/** The same filters read through both public surfaces: selected timeline cards and the /all pool. */
async function read(extra: FeedFilters = {}, scope = T) {
  const base = { channel: "all" as const, category: null, tag: scope, now };
  const filters = { ...base, ...extra };
  const [timeline, pool] = await Promise.all([loadTimeline(filters), loadPool(filters)]);
  return {
    timeline: timeline.cards.map((card) => card.item.id).sort(),
    pool: pool.items.map((item) => item.id).sort(),
    total: pool.total,
    pageCount: pool.pageCount,
    todayCount: pool.todayCount,
    timelineFilters: timeline.filters,
    poolFilters: pool.filters,
  };
}

test("content type and technical direction narrow both surfaces and combine with legacy filters", async () => {
  await seed("tutorial-agent", { tags: ["教程/实践", "Agent"], age: 40 });
  await seed("tutorial-reasoning", { tags: ["教程/实践", "推理"], category: "paper", age: 30 });
  await seed("release-agent", { tags: ["模型发布", "Agent"], age: 20 });
  await seed("review-x", { tags: ["评测/基准"], channel: "x", source: X, age: 10 });

  const byGenre = await read({ genre: "教程/实践" });
  assert.deepEqual(byGenre.timeline, ["tutorial-agent", "tutorial-reasoning"].map(id).sort());
  assert.deepEqual(byGenre.pool, byGenre.timeline);
  assert.equal(byGenre.total, 2);

  const byField = await read({ field: "Agent" });
  assert.deepEqual(byField.timeline, ["release-agent", "tutorial-agent"].map(id).sort());
  assert.deepEqual(byField.pool, byField.timeline);

  const combined = await read({ genre: "教程/实践", field: "Agent" });
  assert.deepEqual([combined.timeline, combined.total], [[id("tutorial-agent")], 1]);

  const withCategory = await read({ genre: "教程/实践", category: "ai-models" });
  assert.deepEqual([withCategory.timeline, withCategory.total], [[id("tutorial-agent")], 1]);

  const withChannel = await read({ genre: "教程/实践", channel: "x" });
  assert.deepEqual([withChannel.timeline, withChannel.total], [[], 0]);
  assert.equal(withChannel.pageCount, 1, "an empty filter still offers one page");

  assert.deepEqual(combined.timelineFilters, {
    channel: "all", category: null, tag: T, genre: "教程/实践", field: "Agent", platform: "all",
  });
  assert.deepEqual(combined.poolFilters, {
    channel: "all", category: null, tag: T, genre: "教程/实践", field: "Agent", platform: "all", q: null, tab: "time",
  });
});

test("source reads the platform publishing stored: X, 公众号, YouTube, Bilibili, a mirror and the rest", async () => {
  const scope = `${T}-platform`;
  await seed("yt", { scope, tags: ["视频"], url: "https://www.youtube.com/watch?v=one", age: 90 });
  await seed("youtu", { scope, tags: ["视频"], url: "https://youtu.be/two", age: 80 });
  await seed("yt-lookalike", { scope, tags: ["视频"], url: "https://example.org/youtube.com/watch", age: 70 });
  await seed("bili", { scope, url: "https://www.bilibili.com/video/BV1", age: 60 });
  await seed("b23", { scope, url: "https://b23.tv/three", age: 50 });
  await seed("wechat-url", { scope, url: "https://mp.weixin.qq.com/s/four", age: 40 });
  await seed("wechat-kind", { scope, source: MP, url: "https://example.org/mp-post", age: 30 });
  await seed("web", { scope, url: "https://example.org/news", age: 20 });
  await seed("x", { scope, source: X, channel: "x", url: "https://x.com/handle/status/1", age: 10 });
  await seed("x-yt-url", { scope, source: X, channel: "x", url: "https://www.youtube.com/watch?v=five", age: 5 });
  await seed("mirror", { scope, url: "https://example.org/mirrored", platform: "aihot", age: 1 });

  const platform = async (name: PlatformKey) => (await read({ platform: name }, scope)).timeline;
  assert.deepEqual(await platform("x"), ["x", "x-yt-url"].map(id).sort(), "X is the publication channel, not its URL");
  assert.deepEqual(await platform("youtube"), ["yt", "youtu"].map(id).sort());
  assert.deepEqual(await platform("bilibili"), ["b23", "bili"].map(id).sort());
  assert.deepEqual(await platform("wechat"), ["wechat-kind", "wechat-url"].map(id).sort());
  assert.deepEqual(await platform("web"), ["web", "yt-lookalike"].map(id).sort());
  assert.deepEqual(await platform("aihot"), [id("mirror")], "a platform no address derives is still filterable: it is stored");
  assert.equal((await platform("all")).length, 11);

  const combined = await read({ platform: "youtube", genre: "模型发布" }, scope);
  assert.deepEqual([combined.timeline, combined.total], [[], 0], "YouTube plus an unrelated content type is empty");
});

test("a source with no records yet shows an honest empty state", async () => {
  const scope = `${T}-empty`;
  await seed("only-web", { scope, url: "https://example.org/only", age: 1 });
  const empty = await read({ platform: "bilibili", field: "RAG" }, scope);
  assert.deepEqual([empty.timeline, empty.total, empty.pageCount, empty.todayCount], [[], 0, 1, 0]);
  assert.equal(empty.poolFilters.platform, "bilibili");
  assert.equal(empty.timelineFilters.field, "RAG");
});

test("the api accepts the documented values and rejects unknown ones", () => {
  assert.deepEqual(
    parseFilters({ genre: "教程/实践", field: "Agent", platform: "youtube" }),
    { channel: "all", category: null, tag: null, genre: "教程/实践", field: "Agent", platform: "youtube" },
  );
  for (const [query, message] of [
    [{ genre: "不存在" }, "invalid genre"],
    [{ field: "不存在" }, "invalid field"],
    [{ platform: "twitter" }, "invalid platform"],
  ] as const) {
    assert.throws(() => parseFilters(query), new RegExp(message));
  }
});
