// What an answer from the catalogue narrows to before this site stores it (backend/snapshot.ts,
// backend/upstream.ts). No database and no network: the point is that upstream's own order, numbers and
// words survive verbatim, that a word or mark this site has no drawing for cannot reach a page, and that
// every picture is kept as the publisher's own address rather than the catalogue's signed one, whose
// signature expires within a day.
import assert from "node:assert/strict";
import { test } from "node:test";
import { publisherUrl, rankingOf, storedHot, storedTopics } from "../backend/snapshot.ts";
import {
  hotBadges, hotSpark, hotTrend, policyOf, retryAfterSeconds, selectedPath, storyPublicIdOf, unwrapImageAddress,
  type UpstreamHot, type UpstreamHotEntry, type UpstreamHotTopics,
} from "../backend/upstream.ts";

const PROXY = "https://aihot.news/api/img-proxy";
/** The catalogue's signed proxy over a publisher's picture, as its answers carry it. */
const signed = (inner: string) => `${PROXY}?u=${encodeURIComponent(inner)}&exp=1800000000&sig=deadbeef`;

const entry = (extra: Partial<UpstreamHotEntry> = {}): UpstreamHotEntry => ({
  rank: 1,
  story: { publicId: "st-1", title: "一个跨源讨论的事件" },
  heat: 128.4,
  participantCount: 7,
  sourceCount: 4,
  sourceNames: ["甲媒体", "乙账号"],
  participants: [{ name: "甲媒体", kind: "editorial", iconUrl: signed("https://cdn.publisher.example/face.png") }],
  summary: "多方在同一件事上发声。",
  latest: "官方随后确认。",
  cover: { url: signed("https://cdn.publisher.example/cover.png"), srcSet: `${signed("https://cdn.publisher.example/cover.png")} 800w`, width: 800, height: 450 },
  trend: "up",
  trendPct: 12,
  badges: ["surge"],
  spark: [1, 2, 3],
  ...extra,
});

const hot = (entries: UpstreamHotEntry[], extra: Partial<UpstreamHot> = {}): UpstreamHot =>
  ({ computedAt: "2026-11-01T02:00:00.000Z", windowHours: 48, entries, ...extra });

test("the ranking is stored as upstream computed it: order, numbers and words untouched", () => {
  const stored = storedHot(hot([entry(), entry({ rank: 2, story: { publicId: "st-2", title: "第二件事" }, heat: 90 })]))!;
  assert.equal(stored.computedAt, "2026-11-01T02:00:00.000Z");
  assert.equal(stored.windowHours, 48);
  assert.deepEqual(stored.entries.map((e) => e.story.publicId), ["st-1", "st-2"], "the order is upstream's, not re-sorted by heat");
  assert.equal(stored.entries[0]!.heat, 128.4, "the heat value is kept exactly, not rounded or recomputed");
  assert.equal(stored.entries[0]!.trend, "up");
  assert.deepEqual(stored.entries[0]!.badges, ["surge"]);
  assert.equal(stored.entries[0]!.summary, "多方在同一件事上发声。");
  assert.deepEqual(stored.entries[0]!.sourceNames, ["甲媒体", "乙账号"]);
  assert.deepEqual(stored.entries[0]!.spark, [1, 2, 3]);
});

test("every picture is kept as the publisher's own address, so this site signs it again per read", () => {
  const stored = storedHot(hot([entry()]))!;
  assert.equal(stored.entries[0]!.cover?.url, "https://cdn.publisher.example/cover.png");
  assert.equal(stored.entries[0]!.participants[0]!.icon, "https://cdn.publisher.example/face.png");
  assert.equal(stored.entries[0]!.cover?.width, 800);
  assert.equal(stored.entries[0]!.cover?.height, 450);
  // The stored row keeps no srcSet: it is this site's proxy that builds one, signed for the reader's moment.
  assert.deepEqual(Object.keys(stored.entries[0]!.cover ?? {}), ["url", "width", "height"]);
});

test("an entry this site cannot draw is dropped, and a word it has no drawing for becomes neutral", () => {
  const stored = storedHot(hot([
    entry({ story: { publicId: "", title: "没有事件号" } }),
    entry({ rank: 2, story: { publicId: "st-2", title: "" } }),
    entry({ rank: 3, story: { publicId: "st-3", title: "留下的那条" }, trend: "sideways", badges: ["surge", "surge", "breaking", 7], spark: "not-a-list" }),
  ]))!;
  assert.deepEqual(stored.entries.map((e) => e.story.publicId), ["st-3"]);
  assert.equal(stored.entries[0]!.trend, "unknown", "an unknown trend word never reaches the page as an unknown string");
  assert.deepEqual(stored.entries[0]!.badges, ["surge"], "an unknown mark is dropped and a repeated one collapses");
  assert.deepEqual(stored.entries[0]!.spark, []);
});

test("an answer that holds no ranking stores nothing, so the row keeps the reading before it", () => {
  assert.equal(storedHot(null), null);
  assert.equal(storedHot(hot([])), null);
  assert.equal(storedHot(hot([entry()], { computedAt: "" })), null, "an undated ranking is no ranking: the surfaces would show a wrong reading time");
  assert.equal(storedHot(hot([entry()], { windowHours: 0 }))!.windowHours, 48);
});

test("a rank upstream left out falls back to the place the entry holds in the answer", () => {
  const stored = storedHot(hot([entry({ rank: 0 }), entry({ rank: 0, story: { publicId: "st-2", title: "第二件事" } })]))!;
  assert.deepEqual(stored.entries.map((e) => e.rank), [1, 2]);
});

test("hourly heat keeps the last 48 observations and a value that is not a number is a hole in the day", () => {
  assert.deepEqual(hotSpark([1, "2", null, 3, {}]), [1, null, null, 3, null]);
  assert.equal(hotSpark(Array.from({ length: 60 }, (_, i) => i)).length, 48);
  assert.deepEqual(hotSpark(Array.from({ length: 60 }, (_, i) => i))[0], 12, "the oldest kept observation, not the newest");
  assert.deepEqual(hotSpark(null), []);
  assert.deepEqual(hotSpark(undefined), []);
});

const topic = (extra: Partial<UpstreamHotTopics["items"][number]> = {}): UpstreamHotTopics["items"][number] => ({
  rank: 1,
  id: "it-1",
  title: "代表这一事件的那条资讯",
  source: { name: "甲媒体" },
  links: { aihot: "https://aihot.news/items/it-1", original: "https://publisher.example/post-1", story: "https://aihot.news/story/st-1" },
  sourceCount: 4,
  signalCount: 9,
  participantCount: 7,
  sourceNames: ["甲媒体", "乙账号"],
  latestAt: "2026-11-01T01:30:00.000Z",
  ...extra,
});

test("the machine ranking is stored keyed by the item ids that join it to the curated list", () => {
  const stored = storedTopics({ schemaVersion: 1, count: 2, items: [topic(), topic({ rank: 2, id: "it-2", title: "另一条" })] })!;
  assert.equal(stored.count, 2);
  assert.deepEqual(stored.items.map((t) => t.id), ["it-1", "it-2"]);
  assert.equal(stored.items[0]!.storyPublicId, "st-1");
  assert.equal(stored.items[0]!.original, "https://publisher.example/post-1");
  assert.equal(stored.items[0]!.signalCount, 9);
  assert.equal(stored.items[0]!.sourceName, "甲媒体");
});

test("a topic this site cannot send a reader on, or cannot name, is dropped rather than passed on", () => {
  const stored = storedTopics({
    schemaVersion: 1, count: 3, items: [
      topic({ id: "" }),
      topic({ id: "it-2", links: { aihot: "https://aihot.news/items/it-2", original: "https://aihot.news/story/st-9" } }),
      topic({ id: "it-3", title: "", participantCount: null, sourceCount: 5, links: { aihot: "https://aihot.news/items/it-3", original: "javascript:alert(1)" } }),
    ],
  })!;
  assert.deepEqual(stored.items.map((t) => t.id), ["it-2", "it-3"], "a topic without an item id joins nothing");
  assert.equal(stored.items[0]!.original, null, "a link back to the catalogue is not the publisher's article");
  assert.equal(stored.items[0]!.storyPublicId, null, "links.story absent means there is no event page here, and no id is invented");
  assert.equal(stored.items[1]!.title, "it-3", "an untitled topic is named by its id rather than dropped");
  assert.equal(stored.items[1]!.participantCount, 5, "the source count stands in when upstream counted no participants");
  assert.equal(storedTopics({ schemaVersion: 1, count: 0, items: [] }), null);
});

test("the two readings merge by the event id: the machine one names the item, the page one carries the picture", () => {
  const topics = storedTopics({ schemaVersion: 1, count: 2, items: [topic(), topic({ rank: 2, id: "it-2", links: { aihot: "a", original: "https://publisher.example/post-2" } })] })!;
  const hotStored = storedHot(hot([entry()]))!;
  const ranking = rankingOf(topics, hotStored);
  assert.deepEqual([...ranking.keys()], ["it-1", "it-2"]);
  assert.deepEqual(ranking.get("it-1"), {
    rank: 1, heat: 128.4, participantCount: 7, storyPublicId: "st-1",
    cover: { url: "https://cdn.publisher.example/cover.png", width: 800, height: 450 },
  });
  // The second topic names no event the page ranking holds: it is mirrored without a picture rather than
  // given one that belongs to another entry.
  assert.deepEqual(ranking.get("it-2"), { rank: 2, heat: 0, participantCount: 7, storyPublicId: null, cover: null });
  assert.equal(rankingOf(null, null).size, 0, "a pass that read no ranking mirrors every item without a picture");
});

test("an address is unwrapped out of the signed proxy, and anything else is kept only when it is a publisher's own", () => {
  assert.equal(unwrapImageAddress(signed("https://cdn.publisher.example/a.png")), "https://cdn.publisher.example/a.png");
  assert.equal(unwrapImageAddress("https://cdn.publisher.example/b.png"), "https://cdn.publisher.example/b.png");
  assert.equal(unwrapImageAddress("https://aihot.news/og/hot.png"), null, "a page of the catalogue itself is no picture to mirror");
  assert.equal(unwrapImageAddress("/relative/cover.png"), null);
  assert.equal(unwrapImageAddress(signed("javascript:alert(1)")), null);
  assert.equal(unwrapImageAddress(signed("/relative.png")), null);
  assert.equal(unwrapImageAddress("not a url at all"), null);
  assert.equal(unwrapImageAddress(null), null);
  assert.equal(unwrapImageAddress(undefined), null);
});

test("an event id is read off the end of an event page address, and nothing is invented from another shape", () => {
  assert.equal(storyPublicIdOf("https://aihot.news/story/st-1"), "st-1");
  assert.equal(storyPublicIdOf("https://aihot.news/story/st-1?from=hot#top"), "st-1");
  assert.equal(storyPublicIdOf("https://aihot.news/story/"), null);
  assert.equal(storyPublicIdOf(null), null);
  assert.equal(storyPublicIdOf(undefined), null);
  assert.equal(storyPublicIdOf(7 as unknown as string), null);
});

test("only an http(s) address that is not the catalogue's own may be sent to a reader as the original", () => {
  assert.equal(publisherUrl("https://publisher.example/post"), "https://publisher.example/post");
  assert.equal(publisherUrl("https://aihot.news/items/it-1"), null);
  assert.equal(publisherUrl("ftp://publisher.example/post"), null);
  assert.equal(publisherUrl("javascript:alert(1)"), null);
  assert.equal(publisherUrl("//publisher.example/post"), null);
  assert.equal(publisherUrl(undefined), null);
});

test("a Retry-After is a wait in seconds, whether upstream states a delay or a moment", () => {
  const now = new Date("2026-11-01T02:00:00.000Z");
  assert.equal(retryAfterSeconds("120", now), 120);
  assert.equal(retryAfterSeconds(" 90 ", now), 90);
  assert.equal(retryAfterSeconds("Fri, 01 Nov 2026 02:01:30 GMT", now), 90);
  assert.equal(retryAfterSeconds("Fri, 01 Nov 2026 01:59:00 GMT", now), null, "a moment already past asks for no wait");
  assert.equal(retryAfterSeconds("0", now), null);
  assert.equal(retryAfterSeconds("soon", now), null);
  assert.equal(retryAfterSeconds(null, now), null);
});

test("the licence terms an answer states about itself are read from its own headers, and nothing is assumed", () => {
  const headers = (map: Record<string, string>) => ({ get: (name: string) => map[name.toLowerCase()] ?? null });
  // Node's TypeScript stripper misreads a single-quoted string that holds double quotes, so the Link header
  // fixtures below are double-quoted with their own quotes escaped.
  const terms = "<https://aihot.news/terms>; rel=\"terms-of-service\"";
  const canonical = "<https://aihot.news/hot>; rel=\"canonical\"";
  // Upstream answered none of these on every address read on 2026-11-01 (backend/upstream.ts), so the
  // absence is the ordinary case and must not become a policy this site invented.
  assert.equal(policyOf(headers({ "content-type": "application/json" })), null);
  assert.deepEqual(
    policyOf(headers({
      "x-aihot-policy-version": "1.1",
      "x-aihot-commercial-use": "written-authorization-required",
      "x-aihot-contact": "mailto:contact@aihot.news",
      link: terms,
    })),
    { version: "1.1", commercialUse: "written-authorization-required", contact: "mailto:contact@aihot.news", terms: "https://aihot.news/terms" },
  );
  assert.deepEqual(policyOf(headers({ "x-aihot-contact": "mailto:contact@aihot.news" })),
    { version: null, commercialUse: null, contact: "mailto:contact@aihot.news", terms: null }, "one header stated is still a statement");
  assert.equal(policyOf(headers({ link: canonical })), null, "a Link that is not the terms is no terms");
});

test("the curated list's cursor is added to the address only when there is one, and it is sent as it came", () => {
  assert.equal(selectedPath(null), "/api/v1/items?mode=selected&window=7d&limit=100");
  assert.equal(selectedPath("abc"), "/api/v1/items?mode=selected&window=7d&limit=100&cursor=abc");
  assert.equal(selectedPath("a b&c"), "/api/v1/items?mode=selected&window=7d&limit=100&cursor=a%20b%26c");
});

test("an upstream category this industry knows carries its genre tag; one it does not leaves the item untagged", async () => {
  const { genreOfCategory } = await import("../backend/mirror.ts");
  assert.equal(genreOfCategory("ai-models"), "模型发布");
  assert.equal(genreOfCategory("paper"), "论文/研究");
  assert.equal(genreOfCategory("opinion"), "大佬观点");
  assert.equal(genreOfCategory("not-a-category"), null);
  assert.equal(genreOfCategory(null), null);
});

test("the reading rhythm is stated in the words the surfaces draw, and an unreadable cron claims nothing", async () => {
  const { paceOf } = await import("../backend/hot.ts");
  assert.equal(paceOf("*/15 * * * *"), "每 15 分钟读一次");
  assert.equal(paceOf("*/1 * * * *"), "每 1 分钟读一次");
  assert.equal(paceOf("5 * * * *"), "每小时读一次");
  assert.equal(paceOf("5 3 * * *"), "每天读一次");
  assert.equal(paceOf("*/15 9-18 * * 1-5"), "按后台设定的节奏读取");
});
