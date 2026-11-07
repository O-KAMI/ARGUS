// The source list shows each source's health and why it fails, failing sources first.
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { listSources } from "@aihot/backend/admin/sources";

after(closeDb);

test("the source list shows health and the failure reason, failing sources first", async () => {
  await sql`INSERT INTO sources (id, name, kind, health, fail_count, last_error) VALUES
    ('list-ok', 'List A', 'rss', 'ok', 0, NULL), ('list-failing', 'List B', 'rss', 'failing', 6, 'HTTP 503')`;
  const { rows, totals } = await listSources({ q: "List" });
  assert.deepEqual(rows.map(({ id, health, fail_count, last_error }) => ({ id, health, fail_count, last_error })), [
    { id: "list-failing", health: "failing", fail_count: 6, last_error: "HTTP 503" },
    { id: "list-ok", health: "ok", fail_count: 0, last_error: null },
  ]);
  assert.equal(totals.failing, 1);
});

test("the source list shows the latest original item time beside the last run, so a quiet account is not a failure", async () => {
  await sql`INSERT INTO sources (id, name, kind, health, last_ok_at, last_fetch_at) VALUES
    ('list-quiet', 'List Quiet', 'rss', 'ok', now(), now())`;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, published_at, discovered_at, timeline_at) VALUES
    ('list-quiet-old', 'list-quiet', 'list-quiet-old', 'https://example.org/quiet/old', 'Old', now() - interval '40 days', now(), now() - interval '40 days'),
    ('list-quiet-new', 'list-quiet', 'list-quiet-new', 'https://example.org/quiet/new', 'New', now() - interval '20 days', now(), now() - interval '20 days')`;
  const { rows } = await listSources({ q: "List Quiet" });
  const [row] = rows;
  assert.ok(row!.last_ok_at, "the last successful run is shown");
  assert.ok(row!.latest_item_at, "the newest stored original's own time is shown separately");
  assert.ok(Date.parse(String(row!.latest_item_at)) < Date.parse(String(row!.last_ok_at)), "a long-quiet account keeps its old item time without looking broken");
  const { rows: empty } = await listSources({ q: "List" });
  assert.equal(empty.find((r) => r.id === "list-ok")?.latest_item_at ?? null, null, "a source without items has no item time");
});
