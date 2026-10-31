// The daily RSS probe replaces a dead feed with a working one on the same site, records the operator
// action, and never queues a paid X fetch: account coverage belongs to the X collector's own layers.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { probeRssSources } from "@aihot/backend/sources/rss-health";

const SOURCE = `probe-${tag()}`;
const PAUSED = `probe-paused-${tag()}`;
let base = "";
let server: http.Server;

const feed = () => `<?xml version="1.0"?><rss version="2.0"><channel><title>Probe</title>
  <item><title>A fresh item</title><link>${base}/post</link><pubDate>${new Date().toUTCString()}</pubDate>
  <description>A fresh body.</description></item></channel></rss>`;

before(async () => {
  config.allowPrivateNetworkFetch = true;
  server = http.createServer((req, res) => {
    if (req.url === "/dead.xml") {
      res.statusCode = 404;
      res.end("not found");
    } else if (req.url === "/") {
      res.setHeader("content-type", "text/html");
      res.end('<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head><body>Home</body></html>');
    } else if (req.url === "/feed.xml") {
      res.setHeader("content-type", "application/rss+xml");
      res.end(feed());
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address");
  base = `http://127.0.0.1:${address.port}`;
  // The probe reads every RSS source; this file owns its database copy, so park any template rows.
  await sql`UPDATE sources SET kind = 'external' WHERE kind = 'rss'`;
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, enabled, next_fetch_at)
            VALUES (${SOURCE}, 'Probe fixture', 'rss', ${sql.json({ feedUrl: `${base}/dead.xml` })}, 'T2', 'editorial', true, '2100-01-01')`;
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, enabled, health, next_fetch_at)
            VALUES (${PAUSED}, 'Paused fallback fixture', 'rss', ${sql.json({ feedUrl: `${base}/dead.xml` })}, 'T2', 'editorial', false, 'paused', '2100-01-01')`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await closeDb();
});

test("a dead feed is replaced on the same site, recorded, and no paid fallback is queued", async () => {
  const summary = await probeRssSources();
  const result = summary.results.find((r) => r.id === SOURCE)!;
  assert.equal(result.status, "replaced");
  assert.equal(result.replacement, `${base}/feed.xml`);
  assert.equal(summary.results.find((r) => r.id === PAUSED)?.replacement, `${base}/feed.xml`, "the second layer is checked too");

  const [row] = await sql<{ feed_url: string; health: string; fail_count: number }[]>`
    SELECT config->>'feedUrl' AS feed_url, health, fail_count FROM sources WHERE id = ${SOURCE}`;
  assert.equal(row!.feed_url, `${base}/feed.xml`);
  assert.equal(row!.health, "unknown");
  assert.equal(row!.fail_count, 0);

  const [entry] = await sql<{ actor: string; action: string; after: { config?: { feedUrl?: string } } }[]>`
    SELECT actor, action, after FROM audit_log WHERE subject = ${`source:${SOURCE}`} ORDER BY id DESC LIMIT 1`;
  assert.equal(entry?.actor, "rss-health");
  assert.equal(entry?.action, "source.update");
  assert.equal(entry?.after.config?.feedUrl, `${base}/feed.xml`);

  const [paused] = await sql<{ feed_url: string; enabled: boolean; health: string; next_fetch_at: Date }[]>`
    SELECT config->>'feedUrl' AS feed_url, enabled, health, next_fetch_at FROM sources WHERE id = ${PAUSED}`;
  assert.equal(paused!.feed_url, `${base}/feed.xml`);
  assert.equal(paused!.enabled, false, "the probe never enables a fallback source");
  assert.equal(paused!.health, "paused");
  assert.equal(paused!.next_fetch_at.toISOString(), "2100-01-01T00:00:00.000Z", "the probe never wakes a paused source");

  assert.equal((await sql`SELECT 1 FROM settings WHERE key = 'rss.fallback.last'`).length, 0);
});
