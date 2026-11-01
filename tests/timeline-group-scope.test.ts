// Failure cases: a composite or mention folding into a fact; stale fact membership still folding;
// a future/withdrawn/unselected report affecting the anchor; filters choosing an anchor outside their
// own set; a later report moving a fact; equal-time standalone cards changing cursor order; an asset
// taking its posts away from the facts they were grouped under.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { loadGroupReports } from "@aihot/backend/publication/groups";
import { loadTimeline } from "@aihot/backend/publication/timeline";

after(closeDb);

test("timeline grouping preserves evidence scope and filter-local anchors", async () => {
  const prefix = `timeline-scope-${tag()}`;
  const at = new Date("2026-01-01T00:00:00Z");
  const now = new Date(+at + 100_000);
  await sql`INSERT INTO sources (id, name, kind, tier) VALUES (${prefix}, ${prefix}, 'rss', 'T1')`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, title) VALUES (${prefix}, ${prefix}) RETURNING id`;
  const add = async (suffix: string, seconds: number, options: { role?: string; scope?: string; channel?: string; visibility?: string; selected?: boolean; future?: boolean; missing?: boolean; standalone?: boolean } = {}) => {
    const id = `${prefix}-${suffix}`;
    const time = new Date(+at + seconds * 1000);
    await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at)
      VALUES (${id}, ${prefix}, ${id}, ${`https://example.org/${id}`}, ${id}, ${time}, ${time})`;
    const [analysis] = await sql<{ id: number }[]>`INSERT INTO analyses (article_id, input_revision, origin, output)
      VALUES (${id}, 1, 'rule', ${sql.json(options.scope ? { scope: options.scope } : {})}) RETURNING id`;
    await sql`INSERT INTO publications (article_id, source_id, analysis_id, title, url, discovered_at, timeline_at, sort_at, visible_after,
      selected, eligible, visibility, channel, tags, fact_id)
      VALUES (${id}, ${prefix}, ${analysis!.id}, ${id}, ${`https://example.org/${id}`}, ${time}, ${time}, ${time}, ${options.future ? new Date(+now + 1) : time},
        ${options.selected ?? true}, true, ${options.visibility ?? "public"}, ${options.channel ?? "news"}, ${[prefix]}, ${options.standalone ? null : fact!.id})`;
    if (!options.missing && !options.standalone) await sql`INSERT INTO fact_articles (fact_id, article_id, role)
      VALUES (${fact!.id}, ${id}, ${options.role ?? "report"})`;
    return id;
  };
  await add("old-report", 0);
  await add("x-report", 10, { channel: "x" });
  const standalone = [
    await add("composite", 20, { scope: "composite" }),
    await add("mention", 30, { role: "mention" }),
    await add("removed", 40, { missing: true }),
    await add("standalone-a", 50, { standalone: true }),
    await add("standalone-z", 50, { standalone: true }),
  ];
  await add("future", -50, { future: true });
  await add("withdrawn", -40, { visibility: "withdrawn" });
  await add("unselected", -30, { selected: false });
  const filters = { channel: "all" as const, category: null, tag: prefix, now };
  const full = await loadTimeline(filters);
  assert.deepEqual(full.cards.map(card => card.key), [...standalone.reverse().map(id => `a${id}`), `f${fact!.id}`]);
  assert.equal(full.cards.at(-1)!.anchorAt, at.toISOString());
  assert.deepEqual(new Set(full.cards.at(-1)!.group!.memberIds), new Set([`${prefix}-old-report`, `${prefix}-x-report`]));
  const filtered = await loadTimeline({ ...filters, channel: "x" });
  assert.deepEqual(filtered.cards.map(card => [card.key, card.anchorAt]), [[`f${fact!.id}`, new Date(+at + 10_000).toISOString()]]);
  const news = await loadTimeline({ ...filters, channel: "news" });
  assert.deepEqual(news.cards.find(card => card.key === `f${fact!.id}`)!.group!.memberIds, [`${prefix}-old-report`]);
  const paged = [];
  let cursor: string | null = null;
  do {
    const page = await loadTimeline({ ...filters, cursor, limit: 2 });
    paged.push(...page.cards);
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(JSON.stringify(paged), JSON.stringify(full.cards));
});

// Two posts recommending the same repository are one card even when grouping put them under different
// facts; a fact keeps only the reports that recommend no asset of their own.
test("one asset folds its posts into one card, ahead of the facts they were grouped under", async () => {
  const prefix = `timeline-asset-${tag()}`;
  const other = `${prefix}-b`;
  const at = new Date("2026-02-01T00:00:00Z");
  const now = new Date(+at + 100_000);
  const asset = `gh:${prefix.toLowerCase()}/repo`;
  await sql`INSERT INTO sources (id, name, kind, tier) VALUES (${prefix}, ${prefix}, 'rss', 'T1'), (${other}, ${other}, 'x_search', 'T2')`;
  const facts = await sql<{ id: number }[]>`
    INSERT INTO facts (public_id, title) VALUES (${`${prefix}-1`}, ${prefix}), (${`${prefix}-2`}, ${prefix}) RETURNING id`;
  const add = async (suffix: string, seconds: number, o: { source?: string; asset?: string | null; fact?: number | null; selected?: boolean; visibility?: string } = {}) => {
    const id = `${prefix}-${suffix}`;
    const time = new Date(+at + seconds * 1000);
    const factId = o.fact === undefined ? facts[0]!.id : o.fact;
    await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at, asset_key)
      VALUES (${id}, ${o.source ?? prefix}, ${id}, ${`https://example.org/${id}`}, ${id}, ${time}, ${time}, ${o.asset ?? null})`;
    const [analysis] = await sql<{ id: number }[]>`INSERT INTO analyses (article_id, input_revision, origin, output)
      VALUES (${id}, 1, 'rule', '{}'::jsonb) RETURNING id`;
    await sql`INSERT INTO publications (article_id, source_id, analysis_id, title, url, discovered_at, timeline_at, sort_at, visible_after,
      selected, eligible, visibility, channel, tags, fact_id)
      VALUES (${id}, ${o.source ?? prefix}, ${analysis!.id}, ${id}, ${`https://example.org/${id}`}, ${time}, ${time}, ${time}, ${time},
        ${o.selected ?? true}, true, ${o.visibility ?? "public"}, 'x', ${[prefix]}, ${factId})`;
    if (factId !== null) await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${factId}, ${id}, 'report')`;
    return id;
  };
  // The same asset under two different facts, a report of the first fact that recommends no asset, a
  // pool-only post about the asset, and a withdrawn one that must not be counted anywhere.
  const first = await add("first", 0, { asset });
  const second = await add("second", 10, { source: other, asset, fact: facts[1]!.id });
  const plain = await add("plain", 20);
  await add("pool-only", 30, { source: other, asset, fact: null, selected: false });
  await add("withdrawn", 40, { source: other, asset, fact: null, visibility: "withdrawn" });

  const filters = { channel: "all" as const, category: null, tag: prefix, now };
  const timeline = await loadTimeline(filters);
  assert.deepEqual(timeline.cards.map((c) => c.key), [`f${facts[0]!.id}`, `k${asset}`],
    "the second fact has no card left: its only report moved to the asset");
  const [factCard, assetCard] = timeline.cards as [typeof timeline.cards[number], typeof timeline.cards[number]];
  assert.equal(factCard.item.id, plain);
  assert.deepEqual(factCard.group && [factCard.group.kind, factCard.group.key, factCard.group.memberIds], ["fact", `${prefix}-1`, [plain]]);
  // The fact's own report list is unchanged by the asset fold: a report that recommends an asset is
  // still evidence of its fact, and is listed both here and under the asset's card.
  assert.equal(factCard.group!.reportCount, 2);
  assert.equal(assetCard.item.id, first, "the T1 source speaks for the asset");
  assert.deepEqual(assetCard.group && [assetCard.group.kind, assetCard.group.key], ["asset", asset]);
  assert.deepEqual(assetCard.group!.memberIds, [first, second], "only the selected posts are the card's members");
  assert.deepEqual([assetCard.group!.reportCount, assetCard.group!.additionalSourceCount], [3, 1],
    "the pool-only post counts and so does its source; the withdrawn one counts nowhere");

  const reports = await loadGroupReports({ kind: "asset", key: asset, channel: "all", category: null, tag: prefix }, now);
  assert.deepEqual(reports && [reports.kind, reports.reports.map((r) => r.id)], ["asset", ["pool-only", "second", "first"].map((s) => `${prefix}-${s}`)],
    "newest first, and the withdrawn post is not a member");
  assert.equal(await loadGroupReports({ kind: "asset", key: `gh:${prefix}/missing`, channel: "all", category: null, tag: null }, now), null);

  // A key this long still round-trips through the cursor.
  const paged = [];
  let cursor: string | null = null;
  do {
    const page = await loadTimeline({ ...filters, cursor, limit: 1 });
    paged.push(...page.cards);
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(paged.map((c) => c.key), timeline.cards.map((c) => c.key));
});
