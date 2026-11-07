// Collection picks up where it stopped: an X search longer than one run continues in later runs until
// it meets the old watermark (no post in between is skipped, no page is bought twice). The watermark
// alone bounds it: posts made weeks before the account was added are kept too.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { collectSource } from "@aihot/backend/sources/collect";

const T = tag();
const X_SOURCE = `test-x-${T}`;

// SocialData: 45 posts newer than the watermark, newest first half a day apart, 2 a page; `cursor` is the page number.
const BASE = BigInt(Date.now()) * 1000n;
const WATERMARK = BASE + 100n;
const POSTS = Array.from({ length: 45 }, (_, i) => BASE + 145n - BigInt(i));
const tweet = (id: bigint) => ({
  id_str: String(id), tweet_created_at: new Date(Date.now() - Number(BASE + 145n - id) * 12 * 3_600_000).toISOString(),
  full_text: `Post ${id} ${T}`, lang: "en", user: { name: "Test account", screen_name: `acct${T}` },
});
const socialdata = await stub((_hit, req) => {
  const u = new URL(req.url, "http://stub");
  const since = BigInt(/since_id:(\d+)/.exec(u.searchParams.get("query") ?? "")?.[1] ?? "0");
  const page = Number(u.searchParams.get("cursor") ?? 0);
  const ids = POSTS.filter((id) => id > since);
  return { tweets: ids.slice(page * 2, page * 2 + 2).map(tweet), next_cursor: (page + 1) * 2 < ids.length ? String(page + 1) : null };
});

process.env.SOCIALDATA_BASE_URL = socialdata.url;
process.env.SOCIALDATA_API_KEY = "test-key";
config.allowPrivateNetworkFetch = true;

// FxTwitter: four pages of twenty posts, newest first; page four is older than the first-import cap keeps.
const FX_HANDLE = `fx${T}`;
const fxNow = Math.floor(Date.now() / 1000);
const fxStatus = (id: number) => ({
  type: "status", id: String(id), url: `https://x.com/${FX_HANDLE}/status/${id}`, text: `Fx post ${id} ${T}`,
  author: { id: "9", name: "Fx account", screen_name: FX_HANDLE }, created_timestamp: fxNow - id * 60,
});
const fxPages: Record<string, { code: number; results: ReturnType<typeof fxStatus>[]; cursor: { top: null; bottom: string | null } }> = {
  "": { code: 200, results: Array.from({ length: 20 }, (_, i) => fxStatus(80 - i)), cursor: { top: null, bottom: "p2" } },
  p2: { code: 200, results: Array.from({ length: 20 }, (_, i) => fxStatus(60 - i)), cursor: { top: null, bottom: "p3" } },
  p3: { code: 200, results: Array.from({ length: 20 }, (_, i) => fxStatus(40 - i)), cursor: { top: null, bottom: "p4" } },
  p4: { code: 200, results: Array.from({ length: 20 }, (_, i) => fxStatus(20 - i)), cursor: { top: null, bottom: null } },
};
const fxtwitter = await stub((_hit, req) => fxPages[new URL(req.url, "http://stub").searchParams.get("cursor") ?? ""]!);
config.fxTwitterBaseUrl = fxtwitter.url;

before(async () => {
  await sql`UPDATE budgets SET per_minute = 1000, per_hour = 10000, per_day = 100000 WHERE service = 'socialdata'`;
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, cursor, next_fetch_at)
            VALUES (${X_SOURCE}, 'Test X', 'x_search', ${sql.json({ query: `from:acct${T}` })}, 'T1', 'editorial',
                    ${sql.json({ initializedAt: new Date().toISOString(), lastTweetId: String(WATERMARK) })}, '2100-01-01')`;
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, cursor, next_fetch_at)
            VALUES (${`test-fx-${T}`}, 'Test Fx', 'x_search', ${sql.json({ query: `from:${FX_HANDLE} -filter:replies`, provider: "fxtwitter" })}, 'T1', 'editorial',
                    NULL, '2100-01-01')`;
});
after(async () => {
  await socialdata.close();
  await fxtwitter.close();
  await stopBoss();
  await closeDb();
});

test("an X search longer than one run is read to the old watermark over the next runs", async () => {
  const stored = async () => Number((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM articles WHERE source_id = ${X_SOURCE}`)[0]!.n);
  const cursor = async () => (await sql<{ cursor: { lastTweetId: string; xBacklog?: unknown[] } }[]>`SELECT cursor FROM sources WHERE id = ${X_SOURCE}`)[0]!.cursor;

  const first = await collectSource(X_SOURCE, { force: true });
  assert.equal(first.status, "ok");
  assert.equal(await stored(), 40, "a run reads its own pages and ten more of the stretch left over");
  assert.equal((await cursor()).lastTweetId, String(BASE + 145n), "the watermark moves to the newest post");
  assert.equal((await cursor()).xBacklog?.length, 1, "the unread stretch is kept for the next run");
  const [run] = await sql<{ detail: { truncated: boolean; backlog: number } }[]>`SELECT detail FROM fetch_runs WHERE source_id = ${X_SOURCE} ORDER BY id DESC LIMIT 1`;
  assert.deepEqual([run!.detail.truncated, run!.detail.backlog], [true, 1], "the admin sees the stretch still to read");

  const receipts = await sql`SELECT status FROM receipts WHERE service = 'socialdata' AND subject = ${`source:${X_SOURCE}`}`;
  assert.equal(receipts.length, 20);
  assert.ok(receipts.every((r) => r.status === "completed"), "stored pages complete with the saved coverage, including backlog pages");

  const second = await collectSource(X_SOURCE, { force: true });
  assert.equal(second.status, "ok");
  assert.equal(await stored(), 45, "every post between the old watermark and the newest is stored");
  assert.equal((await cursor()).xBacklog, undefined, "nothing is left to read");
  assert.equal(socialdata.hits(), 20 + 1 + 3, "no page is requested twice");
});

test("a capped first import never skips a middle range while ingesting older posts", async () => {
  const id = `test-fx-${T}`;
  const kept = Array.from({ length: 30 }, (_, i) => 80 - i);
  const storedIds = async () => (await sql<{ url: string }[]>`SELECT url FROM articles WHERE source_id = ${id}`).map((r) => Number(r.url.split("/").pop())).sort((a, b) => b - a);
  const cursor = async () => (await sql<{ cursor: { lastTweetId: string; fxBacklog?: unknown[]; initialHistoryExcluded?: { count: number; newest: string; oldest: string } } }[]>`SELECT cursor FROM sources WHERE id = ${id}`)[0]!.cursor;
  const lastDetail = async () => (await sql<{ detail: Record<string, number> }[]>`SELECT detail FROM fetch_runs WHERE source_id = ${id} ORDER BY id DESC LIMIT 1`)[0]!.detail;

  const first = await collectSource(id, { force: true });
  assert.equal(first.status, "ok");
  assert.equal(first.created, 30, "the first import keeps its bounded newest slice");
  assert.deepEqual(await storedIds(), kept);
  const c = await cursor();
  assert.equal(c.lastTweetId, "80", "the catch-up watermark still tracks the newest post");
  assert.equal(c.fxBacklog, undefined, "the history chain stops at the cap instead of pointing past the kept items");
  assert.equal(c.initialHistoryExcluded?.count, 30, "the capped middle range is recorded as deliberately excluded");
  assert.ok(c.initialHistoryExcluded?.newest && c.initialHistoryExcluded?.oldest, "the excluded range has both boundaries");
  const d = await lastDetail();
  assert.deepEqual([d.discovered, d.written, d.excluded, d.awaitingBackfill], [60, 30, 30, 0]);

  // A second run, a restart and repeated input: only the newest page is re-read, all duplicates.
  for (let run = 0; run < 3; run++) {
    const again = await collectSource(id, { force: true });
    assert.equal(again.status, "ok");
    assert.equal(again.created, 0);
    assert.deepEqual(await storedIds(), kept, "no older page is ingested while the excluded middle range stays out");
    assert.equal((await lastDetail()).duplicate, 20);
  }
  assert.equal(fxtwitter.hits(), 3 + 3, "the first import reads three pages; each later run re-reads only the newest page");
});
