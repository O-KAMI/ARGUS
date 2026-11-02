// The industry mirror's behaviour in this site's own storage: what one pass writes about the three
// addresses it reads, what a mirrored item becomes (material, a copied judgement, a publication), what
// every hot surface serves while a reading is stored, and the engine's own ranking staying up while none
// is. The catalogue is answered here, at a local address of the same shape, so no test reaches the network,
// none spends a budget, and none calls a model.
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { installModules } from "@aihot/backend/modules";
import { hotAnswer } from "@aihot/backend/publication/agent";
import { loadItemDetail } from "@aihot/backend/publication/detail";
import { hotSearchLinks, loadHotStrip, publishedHot } from "@aihot/backend/publication/hot";
import { loadHot, v1HotTopics } from "@aihot/backend/publication/stories";
import { platformOf } from "@aihot/backend/publication/rules";
import { TRACKS, trackOf } from "@aihot/industry/selection";
import { MIRROR_LABEL, MIRROR_SOURCE_ID } from "../backend/config.ts";
import { invalidateSnapshot, mirroredHot, paceOf } from "../backend/hot.ts";
import { ensureMirrorSource, genreOfCategory, retireMirrored, storeItem, storeItems, type StoreResult } from "../backend/mirror.ts";
import { mirrorOnce } from "../backend/pass.ts";
import { storedHot, type RankingExtra } from "../backend/snapshot.ts";
import { endpointStates, heldFor, nextSave, readEndpoints, saveEndpoints } from "../backend/state.ts";
import { ENDPOINTS, HOT_PATH, HOT_TOPICS_PATH, SELECTED_PATH, type UpstreamHot, type UpstreamItem } from "../backend/upstream.ts";
import aihot from "../server.ts";

installModules([aihot]);

const T = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const PROXY = "https://aihot.news/api/img-proxy";
/** The catalogue's signed proxy over a publisher's picture, as its answers carry it. */
const signed = (inner: string) => `${PROXY}?u=${encodeURIComponent(inner)}&exp=1800000000&sig=deadbeef`;
/** A publisher's own address: this site keeps these, and never the catalogue's signed ones. */
const publisher = (slug: string) => `https://publisher.example/${slug}-${T}`;

const STORY = { a: `st-a-${T}`, b: `st-b-${T}`, c: `st-c-${T}` };
const ITEM = { a: `it-a-${T}`, b: `it-b-${T}`, c: `it-c-${T}` };
const ETAG = { hot: `"hot-${T}"`, topics: `"topics-${T}"`, items: `"items-${T}"` };

/** Eight editorial faces, one invisible one and a repeat, so the face limit and the ordering both show. */
const faces = () => [
  ...Array.from({ length: 8 }, (_, i) => ({ name: `机构${i + 1}`, kind: "editorial", iconUrl: signed(`https://cdn.publisher.example/f${i + 1}.png`) })),
  { name: "氛围账号", kind: "signal", iconUrl: signed("https://cdn.publisher.example/s1.png") },
  { name: "机构1", kind: "editorial", iconUrl: signed("https://cdn.publisher.example/f1.png") },
];

const hotBody = () => ({
  computedAt: "2026-11-01T02:00:00.000Z",
  windowHours: 48,
  entries: [
    {
      rank: 1, story: { publicId: STORY.a, title: `镜像的第一件事 ${T}` }, heat: 320.75, participantCount: 10, sourceCount: 5,
      sourceNames: ["甲媒体", "乙账号", "丙实验室"], participants: faces(),
      summary: "多方在同一件事上发声。", latest: "官方随后确认。",
      cover: { url: signed(publisher("post-a")), srcSet: `${signed(publisher("post-a"))} 800w`, width: 1200, height: 675 },
      trend: "up", trendPct: 18, badges: ["surge", "new"], spark: [1, 2, 3, 4],
    },
    {
      rank: 2, story: { publicId: STORY.b, title: `镜像的第二件事 ${T}` }, heat: 210, participantCount: 4, sourceCount: 3,
      sourceNames: ["甲媒体"], participants: [{ name: "甲媒体", kind: "editorial", iconUrl: signed("https://cdn.publisher.example/f1.png") }],
      summary: null, latest: null, cover: null, trend: "sideways", trendPct: null, badges: ["breaking"], spark: [],
    },
    {
      rank: 3, story: { publicId: STORY.c, title: `镜像的第三件事 ${T}` }, heat: 90, participantCount: 2, sourceCount: 2,
      sourceNames: ["丁媒体"], participants: [], summary: "第三件事的摘要。", latest: null, cover: null,
      trend: "down", trendPct: -5, badges: [], spark: [5, 4],
    },
  ],
});

const topicsBody = () => ({
  schemaVersion: 1, count: 3,
  items: [
    {
      rank: 1, id: ITEM.a, title: `第一件事的代表资讯 ${T}`, source: { name: "甲媒体" },
      links: { aihot: `https://aihot.news/items/${ITEM.a}`, original: publisher("post-a"), story: `https://aihot.news/story/${STORY.a}` },
      sourceCount: 5, signalCount: 12, participantCount: 10, sourceNames: ["甲媒体", "乙账号"], latestAt: "2026-11-01T01:30:00.000Z",
    },
    {
      rank: 2, id: ITEM.b, title: `第二件事的代表资讯 ${T}`, source: { name: "乙账号" },
      links: { aihot: `https://aihot.news/items/${ITEM.b}`, original: publisher("post-b"), story: `https://aihot.news/story/${STORY.b}` },
      sourceCount: 3, signalCount: 6, participantCount: 4, sourceNames: ["甲媒体"], latestAt: "2026-11-01T01:00:00.000Z",
    },
    {
      // The third topic names an event but its item is not in this site's curated window: the entry goes to
      // the publisher's own article instead of a page of this site.
      rank: 3, id: ITEM.c, title: `第三件事的代表资讯 ${T}`, source: { name: "丁媒体" },
      links: { aihot: `https://aihot.news/items/${ITEM.c}`, original: publisher("post-c"), story: `https://aihot.news/story/${STORY.c}` },
      sourceCount: 2, signalCount: 3, participantCount: 2, sourceNames: ["丁媒体"], latestAt: "2026-11-01T00:30:00.000Z",
    },
  ],
});

const item = (id: string, slug: string, extra: Partial<UpstreamItem> = {}): UpstreamItem => ({
  id, title: `镜像标题 ${slug}`, originalTitle: `Original headline ${slug}`, summary: `这是镜像过来的中文摘要 ${slug}。`,
  source: { name: "甲媒体" }, links: { aihot: `https://aihot.news/items/${id}`, original: publisher(slug) },
  publishedAt: "2026-10-31T22:00:00.000Z", discoveredAt: "2026-10-31T23:00:00.000Z",
  category: "ai-models", score: 82, selected: true, reason: "多方同时报道",
  attribution: { name: "甲媒体", url: publisher(slug) },
  ...extra,
});

const itemsBody = (cursor: string | null) => cursor
  ? { schemaVersion: 1, items: [item(ITEM.b, "post-b")], page: { count: 1, hasMore: false, nextCursor: null } }
  : { schemaVersion: 1, items: [item(ITEM.a, "post-a"), item(ITEM.b, "post-b")], page: { count: 2, hasMore: true, nextCursor: "cur2" } };

// The catalogue as a local address of the same shape: `upstreamJson` takes an origin for exactly this, and
// egress stays guarded (the private-address valve is the one the engine's own stub tests use).
type Reply = { status: number; body?: unknown; etag?: string | null; headers?: Record<string, string> };
const asked: string[] = [];
const seenHeaders: http.IncomingHttpHeaders[] = [];
function fixture(url: URL): Reply {
  if (url.pathname === HOT_PATH) return { status: 200, body: hotBody(), etag: ETAG.hot };
  if (url.pathname === HOT_TOPICS_PATH) return { status: 200, body: topicsBody(), etag: ETAG.topics };
  if (url.pathname === "/api/v1/items") {
    const cursor = url.searchParams.get("cursor");
    return { status: 200, body: itemsBody(cursor), etag: cursor ? null : ETAG.items };
  }
  return { status: 404 };
}
let route: (url: URL) => Reply = fixture;

const catalogue = http.createServer((req, res) => {
  const url = new URL(req.url!, "http://127.0.0.1");
  asked.push(`${url.pathname}${url.search}`);
  seenHeaders.push(req.headers);
  const reply = route(url);
  if (reply.status === 200 && reply.etag && req.headers["if-none-match"] === reply.etag) {
    res.writeHead(304, { etag: reply.etag });
    return void res.end();
  }
  res.writeHead(reply.status, { "content-type": "application/json", ...(reply.etag ? { etag: reply.etag } : {}), ...reply.headers });
  res.end(reply.body === undefined ? "" : JSON.stringify(reply.body));
});
await new Promise<void>((resolve) => catalogue.listen(0, "127.0.0.1", () => resolve()));
const ORIGIN = `http://127.0.0.1:${(catalogue.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;

const clock = (at: string) => new Date(at);
/** Every assertion below wants the row a stored item wrote; a skipped one is the failure, not a null. */
const stored = (result: StoreResult) => {
  if (!result.stored) throw new Error(`item was not stored: ${result.reason}`);
  return result;
};
const clearAsks = () => { asked.length = 0; seenHeaders.length = 0; };
const pathAsked = (path: string) => asked.filter((a) => a.startsWith(path)).length;

/** The module's own valve, opened for one call and put back: the alert reads it when it is asked, not at import. */
async function withValve<T>(open: boolean, run: () => Promise<T> | T): Promise<T> {
  const previous = process.env.AIHOT_MIRROR_ENABLED;
  if (open) process.env.AIHOT_MIRROR_ENABLED = "true";
  else delete process.env.AIHOT_MIRROR_ENABLED;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.AIHOT_MIRROR_ENABLED;
    else process.env.AIHOT_MIRROR_ENABLED = previous;
  }
}

const counts = async () => {
  const rows = await sql<{ a: number; p: number; n: number; r: number; d: number }[]>`
    SELECT (SELECT count(*) FROM articles WHERE source_id = ${MIRROR_SOURCE_ID})::int AS a,
      (SELECT count(*) FROM publications p JOIN articles x ON x.id = p.article_id WHERE x.source_id = ${MIRROR_SOURCE_ID})::int AS p,
      (SELECT count(*) FROM analyses n JOIN articles x ON x.id = n.article_id WHERE x.source_id = ${MIRROR_SOURCE_ID})::int AS n,
      (SELECT count(*) FROM receipts)::int AS r, (SELECT count(*) FROM deliveries)::int AS d`;
  return rows[0]!;
};

after(async () => {
  catalogue.close();
  installModules([]);
  await closeDb();
});

test("the mirror's own source is created once, and an administrator's pause survives every later write", async () => {
  const first = await ensureMirrorSource();
  assert.equal(first.enabled, true);
  const [row] = await sql<{ id: string; name: string; kind: string; tags: string[]; tier: string; participation_mode: string; interval_minutes: number; enabled: boolean }[]>`
    SELECT id, name, kind, tags, tier, participation_mode, interval_minutes, enabled FROM sources WHERE id = ${MIRROR_SOURCE_ID}`;
  assert.equal(row!.name, MIRROR_LABEL, "readers see this site's own neutral label, never the catalogue's name");
  assert.equal(row!.kind, "external", "it receives reports; nothing collects it as one of this site's sources");
  assert.deepEqual(row!.tags, [TRACKS.inherit], "it sits on the news track's inherited selection, not the learning track");
  assert.equal(trackOf(row!.tags), "inherit");
  assert.equal(row!.participation_mode, "editorial");
  assert.equal(row!.interval_minutes, 1440, "a schedule of its own reads it, not the engine's per-source poll");

  await sql`UPDATE sources SET enabled = false WHERE id = ${MIRROR_SOURCE_ID}`;
  const again = await ensureMirrorSource();
  assert.equal(again.enabled, false, "resuming is the administrator's, not this module's");
  await sql`UPDATE sources SET enabled = true WHERE id = ${MIRROR_SOURCE_ID}`;
  assert.equal((await ensureMirrorSource()).enabled, true);
});

test("a mirrored item becomes this site's own material, judged by the rule that copies upstream's decision", async () => {
  // This item's own id, event and picture: its row must not join any entry of the ranking the surfaces read
  // in the test below, which asserts the reports the ranking of its own pass brought in.
  const id = `own-${T}`;
  const ranking: RankingExtra = { rank: 1, heat: 320.75, participantCount: 10, storyPublicId: `st-own-${T}`, cover: { url: publisher("own-cover"), width: 1200, height: 675 } };
  const result = stored(await storeItem(item(id, "own-material"), ranking, clock("2026-11-01T02:00:00.000Z")));
  assert.equal(result.created, true);
  assert.equal(result.revised, false);

  const [a] = await sql`
    SELECT source_id, url, title, author, language, revision, processing_state, grouping_status, media, raw, published_at, timeline_at, discovered_at
    FROM articles WHERE id = ${result.articleId}`;
  assert.equal(a!.source_id, MIRROR_SOURCE_ID);
  assert.equal(a!.url, publisher("own-material"), "the publisher's own address, not the catalogue's page");
  assert.equal(a!.title, `Original headline ${"own-material"}`, "the headline the publisher wrote is the material's title");
  assert.equal(a!.author, "甲媒体", "the publisher upstream named, so the card's source line is the publisher's");
  assert.equal(a!.language, "zh");
  assert.equal(a!.processing_state, "analyzed", "the analysis sweep must not find it new and pay for a second judgement");
  assert.equal(a!.grouping_status, "complete", "nor must the grouping sweep find it pending");
  assert.equal(a!.timeline_at.toISOString(), "2026-11-01T02:00:00.000Z", "a fresh item joins this site's timeline when it was read, as the engine's one timeline rule decides");
  assert.equal(a!.published_at.toISOString(), "2026-10-31T22:00:00.000Z", "the item's own time is still what a card is dated by");
  assert.equal(a!.media[0].url, publisher("own-cover"), "the cover is the publisher's own address, unsigned");
  assert.equal(a!.raw.mirror.upstream.story, `st-own-${T}`, "the event the ranking keyed, which is what joins the card back");
  assert.equal(a!.raw.externalId, id);
  assert.equal(a!.raw.mirror.policy.commercialUse, "written-authorization-required", "what this reader states about itself, kept with the material");
  assert.equal(a!.raw.mirror.ranking.rank, 1);

  const [judgement] = await sql<{ origin: string; relevance: string; title_zh: string; summary_zh: string; selected: boolean; score: number; tags: string[] }[]>`
    SELECT origin, relevance, title_zh, summary_zh, selected, score, tags FROM analyses WHERE article_id = ${result.articleId}`;
  assert.equal(judgement!.origin, "rule", "upstream already decided: this site copies it and claims no model judgement");
  assert.equal(judgement!.relevance, "pass");
  assert.equal(judgement!.title_zh, `镜像标题 own-material`);
  assert.equal(judgement!.selected, true, "upstream's own selected flag, not this site's threshold");
  assert.equal(judgement!.score, 82);
  assert.deepEqual(judgement!.tags, ["模型发布"], "the upstream category carries this industry's genre tag");

  const [p] = await sql<{ visibility: string; selected: boolean; seat: boolean }[]>`
    SELECT visibility, selected, seat FROM publications WHERE article_id = ${result.articleId}`;
  assert.equal(p!.visibility, "public");
  assert.equal(p!.selected, true);
});

test("an item that cannot be shown is left out, and the pass says why", async () => {
  const before = await counts();
  assert.deepEqual(await storeItem(item(`no-summary-${T}`, "post", { summary: "  " }), null), { stored: false, reason: "no summary" });
  assert.deepEqual(await storeItem(item(`no-link-${T}`, "post", { links: { aihot: "x", original: "" } }), null), { stored: false, reason: "no original link" });
  assert.deepEqual(await storeItem(item(`no-title-${T}`, "post", { title: "" }), null), { stored: false, reason: "no title" });
  assert.deepEqual(await counts(), before, "nothing half-written is left behind");

  // The same address collected by a source of this site's own stays that source's, judgement and all.
  const other = `test-other-${T}`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at, config)
    VALUES (${other}, ${"自家信源"}, 'web_list', 'T2', 'editorial', '2100-01-01', ${sql.json({ url: publisher("owned-by-other") })})`;
  const own = stored(await storeItem(item(`owned-${T}`, "owned-by-other"), null, clock("2026-11-01T02:00:00.000Z")));
  await sql`UPDATE articles SET source_id = ${other} WHERE id = ${own.articleId}`;
  const clash = await storeItem(item(`owned-${T}-again`, "owned-by-other"), null, clock("2026-11-01T02:00:00.000Z"));
  assert.deepEqual(clash, { stored: false, reason: "another source owns the material" });
  const [kept] = await sql<{ source_id: string }[]>`SELECT source_id FROM articles WHERE url = ${publisher("owned-by-other")}`;
  assert.equal(kept!.source_id, other, "the mirror did not take the row over");
});

test("the same item read twice writes nothing again, and a cover the ranking gained later is presentation", async () => {
  const first = stored(await storeItem(item(`idem-${T}`, "idempotent"), null, clock("2026-11-01T02:00:00.000Z")));
  assert.equal(first.created, true);
  const repeat = stored(await storeItem(item(`idem-${T}`, "idempotent"), null, clock("2026-11-01T02:15:00.000Z")));
  assert.equal(repeat.articleId, first.articleId);
  assert.equal(repeat.created, false);
  assert.equal(repeat.revised, false, "the same words are not a new revision: no judgement, no re-ask");
  const [one] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM analyses WHERE article_id = ${first.articleId}`;
  assert.equal(one!.n, 1);

  // A cover the ranking carries from a later pass, on an item already stored without one: presentation, not a
  // new verdict, and no second judgement.
  const bare = item(`late-${T}`, "late");
  const without = stored(await storeItem(bare, null, clock("2026-11-01T02:20:00.000Z")));
  assert.equal(without.cover, false);
  const withCover: RankingExtra = { rank: 4, heat: 0, participantCount: 0, storyPublicId: `st-late-${T}`, cover: { url: publisher("late-cover"), width: 800, height: 450 } };
  const late = stored(await storeItem(bare, withCover, clock("2026-11-01T02:30:00.000Z")));
  assert.equal(late.cover, true);
  assert.equal(late.articleId, without.articleId);
  const [now] = await sql<{ media: { url: string }[]; revision: number; n: number }[]>`
    SELECT media, revision, (SELECT count(*)::int FROM analyses a WHERE a.article_id = articles.id) AS n
    FROM articles WHERE id = ${without.articleId}`;
  assert.equal(now!.media[0]!.url, publisher("late-cover"), "the cover reached the article already stored under it");
  assert.equal(now!.revision, 1, "a picture is not a new version of the words");
  assert.equal(now!.n, 1, "and the judgement of the first read is kept");
});

test("a window is read page by page, and an item upstream repeats is stored once", async () => {
  const pass = await storeItems([item(`pg-a-${T}`, "page-a"), item(`pg-b-${T}`, "page-b"), item(`pg-a-${T}`, "page-a")]);
  assert.equal(pass.read, 3);
  assert.equal(pass.stored, 3, "the same id read twice in one window is one article, updated");
  assert.equal(pass.created, 2, "the repeat was not a second article");
  const [rows] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM articles WHERE url = ${publisher("page-a")}`;
  assert.equal(rows!.n, 1);
  assert.deepEqual(await storeItems([]), { read: 0, stored: 0, created: 0, revised: 0, selected: 0, covers: 0, skipped: 0 });
});

test("one pass reads all three addresses, keeps what each answered, and stores the window as this site's own", async () => {
  clearAsks();
  const report = await mirrorOnce("schedule", clock("2026-11-01T03:00:00.000Z"), ORIGIN);
  assert.deepEqual(report.problems, []);
  assert.equal(report.paused, false);
  assert.equal(report.reason, "schedule");
  assert.deepEqual(report.endpoints.map((e) => [e.endpoint, e.status, e.count]), [[HOT_PATH, 200, 3], [HOT_TOPICS_PATH, 200, 3], [SELECTED_PATH, 200, 2]]);
  assert.equal(report.pages, 2, "the window is read to its end, not just its first page");
  assert.equal(report.items.read, 2);
  assert.equal(report.items.skipped, 0);
  assert.equal(pathAsked(HOT_PATH), 1);

  const rows = await endpointStates();
  assert.deepEqual(rows.map((r) => r.endpoint), [HOT_PATH, HOT_TOPICS_PATH, SELECTED_PATH].sort());
  const [hot, topics, window] = rows;
  assert.equal(hot!.etag, ETAG.hot);
  assert.equal(hot!.lastOkAt!.toISOString(), "2026-11-01T03:00:00.000Z");
  assert.equal(hot!.lastError, null);
  assert.equal(hot!.policy, null, "the catalogue stated no licence header, and none is invented");
  assert.equal((hot!.answer as { entries: unknown[] }).entries.length, 3);
  assert.equal((topics!.answer as { items: { id: string }[] }).items[0].id, ITEM.a);
  // The module keeps its own state rows, but the engine's source list reads `sources`: a pass that left the
  // row saying "never read" would make the admin's health column unusable for the mirror.
  const [source] = await sql<{ health: string; ok: boolean }[]>`
    SELECT health, (last_ok_at IS NOT NULL) AS ok FROM sources WHERE id = ${MIRROR_SOURCE_ID}`;
  assert.equal(source!.health, "ok", "a pass that read all three stamps the mirror's own source row");
  assert.equal(source!.ok, true);
  assert.equal(window!.answer, null, "the window is stored as this site's own material, not kept as somebody else's list");

  // Every request states what this reader is, as its terms ask of an automated one.
  assert.equal(seenHeaders[0]!["x-aihot-commercial-use"], "written-authorization-required");
  assert.equal(seenHeaders[0]!["x-aihot-policy-version"], "1.1");

  // The two rankings of this same pass joined the items they name: the event id the card joins back by, and
  // the picture — which the item upstream's window carries on its own has no place for.
  const [mirrored] = await sql<{ raw: { mirror: { upstream: { story: string }; ranking: { rank: number } } }; media: { url: string }[] }[]>`
    SELECT raw, media FROM articles WHERE url = ${publisher("post-a")}`;
  assert.equal(mirrored!.raw.mirror.upstream.story, STORY.a, "the event the machine ranking keyed this item under");
  assert.equal(mirrored!.raw.mirror.ranking.rank, 1, "and the place the page ranking held for it");
  assert.equal(mirrored!.media[0]!.url, publisher("post-a"), "the cover of that event, unwrapped to the publisher's own address");
  assert.equal(report.items.covers, 1, "only the item a ranking picture belongs to");

  // ... and none of it costs anything: no model call, no receipt, no push.
  const totals = await counts();
  assert.equal(totals.r, 0, "a mirror that calls a model is a mirror this site cannot afford to run unseen");
  assert.equal(totals.d, 0, "already public upstream, so nothing is pushed again");
});

test("a second pass asks with the ETags it kept and writes nothing again", async () => {
  const before = await counts();
  clearAsks();
  const report = await mirrorOnce("schedule", clock("2026-11-01T03:15:00.000Z"), ORIGIN);
  assert.deepEqual(report.endpoints.map((e) => e.status), [304, 304, 304]);
  assert.equal(report.unchanged, true);
  assert.equal(report.pages, 0);
  assert.equal(report.items.read, 0, "a window that had not changed is not stored again");
  assert.deepEqual(await counts(), before);
  assert.equal(asked.length, 3, "one conditional request per address, and no second page after a 304");
  assert.deepEqual([...new Set(seenHeaders.map((h) => h["if-none-match"]))].sort(), [ETAG.hot, ETAG.items, ETAG.topics].sort());

  const rows = await readEndpoints([HOT_PATH]);
  assert.equal(rows.get(HOT_PATH)!.etag, ETAG.hot, "a 304 keeps the ETag: the next pass is conditional too");
  assert.equal(rows.get(HOT_PATH)!.lastCount, 3, "and the count it last saw, so the owner still sees what is live");
});

test("a rate-limit answer is waited out instead of asked again sooner", async () => {
  route = (url) => url.pathname === "/api/v1/items" ? { status: 429, headers: { "retry-after": "120" } } : fixture(url);
  clearAsks();
  const at = clock("2026-11-01T03:30:00.000Z");
  const report = await mirrorOnce("schedule", at, ORIGIN);
  const window = report.endpoints.find((e) => e.endpoint === SELECTED_PATH)!;
  assert.equal(window.status, 429);
  assert.equal(window.held, 120);
  assert.match(report.problems.join("；"), /要求等待 120 秒/);
  const held = await readEndpoints([SELECTED_PATH]);
  assert.equal(held.get(SELECTED_PATH)!.holdUntil!.toISOString(), "2026-11-01T03:32:00.000Z");
  assert.equal(heldFor(held.get(SELECTED_PATH)!, clock("2026-11-01T03:31:00.000Z")), 60);
  assert.equal(heldFor(held.get(SELECTED_PATH)!, clock("2026-11-01T03:33:00.000Z")), null, "the wait ends when upstream said it would");

  // Inside the wait the address is not asked at all; the rankings still get their conditional read.
  clearAsks();
  const inside = await mirrorOnce("schedule", clock("2026-11-01T03:31:00.000Z"), ORIGIN);
  assert.equal(pathAsked("/api/v1/items"), 0, "asking again inside a Retry-After is what the wait forbids");
  assert.equal(inside.endpoints.find((e) => e.endpoint === SELECTED_PATH)!.held, 60);
  assert.equal(inside.endpoints.find((e) => e.endpoint === SELECTED_PATH)!.status, null);

  clearAsks();
  await mirrorOnce("schedule", clock("2026-11-01T03:35:00.000Z"), ORIGIN);
  assert.equal(pathAsked("/api/v1/items"), 1, "past the wait it asks again");
  route = fixture;
});

test("an address that cannot be read leaves the ranking this site publishes exactly as it was", async () => {
  // Picture addresses are signed per read, so the comparison is of what the ranking holds, not of a signature.
  const shape = (h: Awaited<ReturnType<typeof loadHot>>) => [h.computedAt, h.windowHours, h.entries.map((e) => [e.rank, e.story.publicId, e.heat, e.cover !== null, e.participants.length])];
  const before = shape(await loadHot());
  route = (url) => url.pathname === HOT_PATH ? { status: 500 } : fixture(url);
  clearAsks();
  const report = await mirrorOnce("schedule", clock("2026-11-01T04:00:00.000Z"), ORIGIN);
  assert.equal(report.endpoints.find((e) => e.endpoint === HOT_PATH)!.status, null);
  assert.match(report.problems.join("；"), /api\/site\/hot 读取失败/);
  const rows = await readEndpoints([HOT_PATH]);
  assert.equal(rows.get(HOT_PATH)!.etag, ETAG.hot, "a failed read keeps the ETag, so the next pass is conditional");
  assert.equal(rows.get(HOT_PATH)!.lastStatus, null);
  assert.equal(rows.get(HOT_PATH)!.lastOkAt!.toISOString(), "2026-11-01T03:35:00.000Z", "the owner sees when it last actually read");
  assert.deepEqual(shape(await loadHot()), before, "the page keeps serving the reading it has, with its original reading time");

  // A 200 that holds no ranking is a problem too, and drops the ETag so the next pass reads afresh.
  route = (url) => url.pathname === HOT_PATH ? { status: 200, body: { computedAt: "2026-11-01T04:00:00.000Z", windowHours: 48, entries: [] }, etag: `"empty-${T}"` } : fixture(url);
  const empty = await mirrorOnce("schedule", clock("2026-11-01T04:15:00.000Z"), ORIGIN);
  assert.match(empty.problems.join("；"), /api\/site\/hot 答了 200 但没有可用的条目/);
  const kept = await readEndpoints([HOT_PATH]);
  assert.equal(kept.get(HOT_PATH)!.etag, null, "an empty answer is not the current reading: read afresh next time");
  assert.equal(kept.get(HOT_PATH)!.lastCount, 0);
  assert.deepEqual(shape(await loadHot()), before, "and the ranking before it is still what the surfaces show");
  assert.equal((await loadHot()).entries.length, 3);
  route = fixture;
});

test("a mirror paused in the admin reads nothing at all", async () => {
  await sql`UPDATE sources SET enabled = false WHERE id = ${MIRROR_SOURCE_ID}`;
  clearAsks();
  const report = await mirrorOnce("schedule", clock("2026-11-01T04:30:00.000Z"), ORIGIN);
  assert.equal(report.paused, true);
  assert.deepEqual(report.endpoints, []);
  assert.equal(asked.length, 0);
  assert.match(report.problems.join("；"), /已在后台暂停/);
  await sql`UPDATE sources SET enabled = true WHERE id = ${MIRROR_SOURCE_ID}`;
  await mirrorOnce("admin", clock("2026-11-01T04:31:00.000Z"), ORIGIN);
  assert.equal(asked.length, 3, "resumed in the admin, and the next pass reads again by itself");
});

test("the ranking a module keeps is what every hot surface serves, as it was read", async () => {
  const published = (await publishedHot())!;
  assert.ok(published);
  assert.equal(published.mirror.label, MIRROR_LABEL);
  assert.equal(published.mirror.url, "https://aihot.news/hot", "the reading is there to be compared against its source");
  assert.equal(published.mirror.pace, paceOf("*/15 * * * *"));
  assert.deepEqual(published.entries.map((e) => e.rank), [1, 2, 3], "the order is upstream's, and the surfaces do not re-sort it");
  assert.equal(published.entries[0]!.heat, 320.75);

  const hot = await loadHot();
  assert.equal(hot.mirror!.label, MIRROR_LABEL);
  assert.equal(hot.computedAt, "2026-11-01T02:00:00.000Z", "the page states the reading time of the ranking it shows");
  assert.equal(hot.windowHours, 48);
  assert.deepEqual(hot.entries.map((e) => [e.story.title, e.heat, e.trend]), [
    [`镜像的第一件事 ${T}`, 320.75, "up"],
    [`镜像的第二件事 ${T}`, 210, "unknown"],
    [`镜像的第三件事 ${T}`, 90, "down"],
  ], "numbers, order and words as upstream answered them; a word with no drawing here is neutral");
  assert.deepEqual(hot.entries[0]!.badges, ["surge", "new"]);
  assert.deepEqual(hot.entries[1]!.badges, [], "an upstream mark this site cannot draw is dropped, not shown as a mystery word");
  assert.deepEqual(hot.entries[0]!.sourceNames, ["甲媒体", "乙账号", "丙实验室"], "not run through this site's source-name rules");

  // Where a reader actually goes, per entry.
  const [a, b, c] = hot.entries;
  assert.match(a!.link!.to, /^\/items\/[a-z0-9]+$/);
  assert.equal(a!.link!.external, false);
  assert.match(b!.link!.to, /^\/items\//);
  assert.equal(c!.link!.external, true, "an entry this site did not mirror opens the publisher's own article");
  assert.equal(c!.link!.to, publisher("post-c"));
  assert.ok(!a!.story.publicId.startsWith("/"), "the event id is upstream's own, kept as the row key only");

  // Every picture is signed by this site's own outlet over the publisher's address.
  assert.match(a!.cover!.url, /^\/api\/img-proxy\?u=/);
  assert.equal(decodeURIComponent(a!.cover!.url).includes(publisher("post-a")), true);
  assert.equal(a!.cover!.width, 1200);
  assert.ok(b!.cover === null);

  // The faces: this site's own limit, editorial first in upstream's order, and the repeat gone.
  assert.equal(a!.participants.length, 9, "eight editorial, one invisible, and 机构1 counted once");
  assert.deepEqual(a!.participants.slice(0, 8).map((p) => p.name), [`机构1`, `机构2`, `机构3`, `机构4`, `机构5`, `机构6`, `机构7`, `机构8`]);
  assert.equal(a!.participants[8]!.kind, "signal");
  assert.equal(a!.participants.filter((p) => p.iconUrl).length, 6, "only the first six faces are drawn, whatever upstream sent");
  assert.match(a!.participants[5]!.iconUrl!, /^\/api\/img-proxy\?u=/);
  assert.equal(a!.participants[6]!.iconUrl, undefined, "a seventh would be a row of circles nobody sees");
  assert.equal(a!.participants[8]!.iconUrl, undefined, "the invisible group carries no picture here either");

  // This site's own announcements are not part of any ranking, mirrored or otherwise.
  assert.ok(Array.isArray(hot.announcements));

  // The machine exit: ranks and counts, no heat, and no event id for a reader to be sent chasing.
  const v1 = await v1HotTopics();
  assert.equal(v1.count, 3);
  assert.equal("story" in v1.items[0]!.links, false, "absent, never null: the spec says do not construct a story id");
  assert.equal(v1.items[0]!.id, a!.link!.to.slice("/items/".length), "this site's own report id when it has one");
  assert.equal(v1.items[2]!.id, STORY.c, "else upstream's event id, which resolves nowhere here");
  assert.equal(v1.items[0]!.links.original, publisher("post-a"));
  assert.equal(v1.items[0]!.source.name, "甲媒体");
  assert.equal(v1.items[0]!.signalCount, 12, "the machine ranking's own count, not this site's evidence");
  assert.equal("heat" in v1.items[0]!, false, "the public API has never returned heat values");

  // The strip on the home page and the search suggestions, from the same single reading.
  const strip = (await loadHotStrip())!;
  assert.deepEqual(strip.map((e) => e.storyPublicId), [null, null, null], "an upstream event id is not a route of this site");
  assert.equal(strip[0]!.itemId, a!.link!.to.slice("/items/".length));
  assert.equal(strip[2]!.itemId, null);
  assert.deepEqual(await hotSearchLinks(), [
    { rank: 1, title: `镜像的第一件事 ${T}`, to: a!.link!.to },
    { rank: 2, title: `镜像的第二件事 ${T}`, to: b!.link!.to },
  ], "a suggestion is a route, so an entry with no page of this site's own is left out rather than sent to /hot");

  // What an AI agent is told, so it cannot invent an event id or claim this ranking as this site's measure.
  const text = hotAnswer(v1, 10, "mcp");
  assert.match(text, /照读一个公开行业目录/);
  assert.equal(text.includes("public_id="), false);
  assert.match(text, /原文：/);
  assert.match(text, /不要.*拼/);
  assert.equal(text.includes(`https://aihot.news`), false, "the answer links the publisher's article and this site, never the catalogue's name in prose");
});

test("a mirrored report is drawn as its own card, on the platform its source was declared under", async () => {
  const [article] = await sql<{ id: string }[]>`SELECT id FROM articles WHERE url = ${publisher("post-a")}`;
  assert.equal(platformOf("external", "news", publisher("post-a"), MIRROR_SOURCE_ID), "aihot", "the module declares the platform its source's reports came under");
  assert.equal(platformOf("web_list", "news", publisher("post-a")), "web", "a source the module does not declare is an ordinary website");
  const [p] = await sql<{ channel: string; source_id: string }[]>`SELECT channel, source_id FROM publications WHERE article_id = ${article!.id}`;
  assert.equal(p!.source_id, MIRROR_SOURCE_ID);
  assert.equal(p!.channel, "news", "a mirrored report is news, whatever the catalogue's own page calls it");
  // The platform reaches the public item too: a surface has to be able to tell a mirrored report's own
  // number and copy from one this site's model wrote (apps/web: isMirrored → 镜像评分 and 摘要).
  const detail = await loadItemDetail(article!.id);
  assert.equal(detail.kind === "found" && detail.item.platform, "aihot", "the read layer carries where the report came from");
});

test("mirrored material leaves with the window it came from, and a report that quotes it keeps it", async () => {
  const gone = stored(await storeItem(item(`old-${T}`, "old"), null, clock("2026-11-01T05:00:00.000Z")));
  const cited = stored(await storeItem(item(`cited-${T}`, "cited"), null, clock("2026-11-01T05:00:00.000Z")));
  const fresh = stored(await storeItem(item(`fresh-${T}`, "fresh"), null, clock("2026-11-01T05:00:00.000Z")));
  // Both were first mirrored outside the 7-day window this site keeps; the third one is still inside it.
  const old = "2026-10-20T04:00:00.000Z";
  await sql`UPDATE articles SET discovered_at = ${old} WHERE id = ${gone.articleId}`;
  await sql`UPDATE articles SET discovered_at = ${old} WHERE id = ${cited.articleId}`;
  await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at)
    VALUES ('daily', ${`mirror-pin-${T}`}, ${old}, ${old}, ${sql.json({ sections: [{ items: [{ itemId: cited.articleId }] }] } as never)}, ${old})`;

  const result = await retireMirrored(clock("2026-11-01T05:00:00.000Z"));
  assert.equal(result.retired, 1);
  assert.equal(result.pinned, 1, "a published report is never rewritten, so the items it quotes outlive the window");
  const [left] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM articles WHERE id IN (${gone.articleId}, ${cited.articleId}, ${fresh.articleId})`;
  assert.equal(left!.n, 2, "the out-of-window item goes, the cited one and the one still in the window stay");
  const [out] = await sql<{ visibility: string }[]>`SELECT visibility FROM publications WHERE article_id = ${gone.articleId}`;
  assert.equal(out, undefined, "cascade took the projection with it");
});

test("a stored field is kept whole, and one a pass says nothing about keeps its value", async () => {
  const previous = (await readEndpoints([HOT_PATH])).get(HOT_PATH)!;
  const save = nextSave(previous, HOT_PATH, { lastStatus: 503, lastError: "上游 503" });
  assert.equal(save.etag, previous.etag, "the pass said nothing about the ETag: the one kept is the one to send");
  assert.equal(save.answer, previous.answer);
  assert.equal(save.lastOkAt, previous.lastOkAt);
  assert.equal(save.holdUntil, previous.holdUntil);
  const cleared = nextSave(previous, HOT_PATH, { etag: null, answer: null, holdUntil: null });
  assert.equal(cleared.etag, null, "a pass that names a field whole may clear it");

  await saveEndpoints([save]);
  invalidateSnapshot();
  assert.equal((await publishedHot())!.entries.length, 3, "a status written alone does not touch the ranking it reads");
  await saveEndpoints([nextSave(previous, HOT_PATH, {})]);
  invalidateSnapshot();
});

test("with no reading stored, every surface falls back to the ranking this site computes itself", async () => {
  await sql`DELETE FROM aihot_mirror_state`;
  invalidateSnapshot();
  assert.equal(await publishedHot(), null, "a module that has read nothing publishes nothing");
  assert.equal(await mirroredHot(), null);
  const hot = await loadHot();
  assert.equal(hot.mirror ?? null, null, "and the page says cross-source heat again, not a mirror of somebody else's");
  assert.deepEqual(hot.entries, []);
  assert.equal(await loadHotStrip(), null, "the engine's own ranking is empty here too");
  const v1 = await v1HotTopics();
  assert.deepEqual(v1.items, []);
  assert.equal((await v1HotTopics()).items.length, 0);

  // A ranking of two events this site mirrored nothing of: fewer than three hides the strip rather than
  // showing a stub of one, and an entry with no page of this site's own is not a link and not a suggestion.
  const twoEntryAnswer: UpstreamHot = {
    computedAt: "2026-11-01T06:00:00.000Z",
    windowHours: 48,
    entries: [1, 2].map((rank) => ({
      rank, story: { publicId: `st-none-${rank}-${T}`, title: `没有镜像到的一件事 ${rank}` },
      heat: 100 - rank * 40, participantCount: 1, sourceCount: 1, sourceNames: ["甲媒体"], participants: [],
      summary: null, latest: null, cover: null,
    })),
  };
  await saveEndpoints([
    {
      endpoint: HOT_PATH, etag: null, holdUntil: null, lastStatus: 200, lastCount: 2, lastOkAt: new Date(), lastError: null, policy: null,
      answer: storedHot(twoEntryAnswer),
    },
    {
      endpoint: HOT_TOPICS_PATH, etag: null, holdUntil: null, lastStatus: 200, lastCount: 0, lastOkAt: new Date(), lastError: null, policy: null, answer: null,
    },
  ]);
  invalidateSnapshot();
  const two = await loadHot();
  assert.equal(two.entries.length, 2);
  assert.equal(two.mirror!.label, MIRROR_LABEL, "still a mirror, so the page still says whose numbers these are");
  assert.equal(await loadHotStrip(), null, "two entries are not a strip");
  assert.equal((await publishedHot())!.entries[0]!.link, null, "no topic, no report: nowhere to send a reader, so the title is not a link");
  assert.deepEqual(await hotSearchLinks(), [], "a suggestion is a route, so an entry with no page of this site's own is left out");
});

test("the mirror's own reading rhythm, and what it says about itself to the machine exit", () => {
  assert.deepEqual(genreOfCategory("opinion") === "大佬观点" && genreOfCategory("unknown-category") === null, true);
  assert.equal(paceOf("5 * * * *"), "每小时读一次");
  const sockets = aihot.schedules!;
  assert.deepEqual(sockets.map((s) => [s.name, s.cron, s.missed]), [["aihot.mirror", "*/15 * * * *", "once"]]);
  assert.equal(sockets[0]!.when!(), false, "off until the owner opens its own valve, whatever COLLECT_ENABLED says");
  assert.deepEqual(aihot.independentSelectedSources, [MIRROR_SOURCE_ID], "a mirrored report never shares a display seat with this site's own");
  assert.deepEqual(aihot.platforms, { aihot: [MIRROR_SOURCE_ID] });
  assert.equal(ENDPOINTS.length, 3);
});

// A window upstream still had more of is the one case where every request succeeded and the mirror is still
// short: a 200 on every page, stopped only by this reader's own cap. Without a stated truncation the next
// pass would treat a partial window as the whole one, and the owner would see nothing but a healthy row.
test("a window that does not end inside the page cap is stored as far as it reached and said so", async () => {
  route = (url) => url.pathname !== "/api/v1/items" ? fixture(url) : {
    status: 200, etag: `"loop-${T}"`,
    body: { schemaVersion: 1, items: [item(`loop-${url.searchParams.get("cursor") ?? "first"}-${T}`, "loop")], page: { count: 1, hasMore: true, nextCursor: "again" } },
  };
  clearAsks();
  const at = clock("2026-11-01T05:00:00.000Z");
  const report = await mirrorOnce("schedule", at, ORIGIN);
  assert.equal(report.truncated, true);
  assert.equal(report.stopReason, "max-pages");
  assert.equal(report.pages, 6, "the reader stops on its own cap, not where upstream ended");
  assert.match(report.problems.join("；"), /读到第 6 页上游仍说有更多/);
  const row = (await readEndpoints([SELECTED_PATH])).get(SELECTED_PATH)!;
  assert.equal(row.lastStatus, 200, "upstream answered every page; it is the read that is incomplete");
  assert.match(String(row.lastError), /^truncated: /);
  assert.equal(row.etag, null, "a short window is not the whole window: the next pass reads afresh instead of accepting a 304");
  const findings = await withValve(true, () => aihot.alerts?.(at.getTime() + 60_000));
  assert.ok(findings?.some((f) => f.key === "aihot.mirror.truncated"), "a successful but short read still reaches the owner");
  route = fixture;
});

// Each address keeps its own last reading when it cannot be read, so the published ranking can be two
// moments joined. The spread is measured, said in the pass, and shown on the page rather than drawn as one
// tidy update time.
test("a ranking whose halves come from different passes is published as the mix it is", async () => {
  route = (url) => url.pathname === HOT_TOPICS_PATH ? { status: 500 } : fixture(url);
  const at = clock("2026-11-01T05:40:00.000Z");
  const report = await mirrorOnce("schedule", at, ORIGIN);
  assert.equal(report.skewMinutes, 40, "this pass read the page ranking; the machine one is from 05:00");
  assert.match(report.problems.join("；"), /混合快照/);
  route = fixture;
  invalidateSnapshot();
  const mixed = await mirroredHot(clock("2026-11-01T05:41:00.000Z"));
  assert.equal(mixed?.mirror.mixed, true);
  assert.equal(mixed?.mirror.asOf, "2026-11-01T05:00:00.000Z", "the oldest reading in use is what a reader may rely on");
  assert.equal(mixed?.mirror.stale, true, "and it is past two polling intervals, so the page says the reading is behind");

  clearAsks();
  const whole = await mirrorOnce("schedule", clock("2026-11-01T05:45:00.000Z"), ORIGIN);
  assert.equal(whole.skewMinutes, 0, "both halves read in one pass are one moment again");
  assert.equal(whole.problems.length, 0);
  invalidateSnapshot();
  const aligned = await mirroredHot(clock("2026-11-01T05:46:00.000Z"));
  assert.equal(aligned?.mirror.mixed, false);
  assert.equal(aligned?.mirror.stale, false);
});
