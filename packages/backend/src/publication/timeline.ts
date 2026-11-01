// Selected news timeline: ordinary reports fold by fact, and posts recommending the same asset fold
// together ahead of that; standalone and independent-source articles keep their own cards. Each group
// stays at its first appearance.
import type { GroupInfo, GroupKind, TimelineCard, TimelineFilters, TimelineResponse } from "@aihot/contracts/site";
import { beijingDate, beijingMidnight } from "@aihot/contracts/time";
import { sql } from "../db.ts";
import { cachedByKey } from "../lib/cache.ts";
import { pickRepresentative, REPRESENTATIVE_COLUMNS, type RepresentativeRow } from "./representative.ts";
import { decodeCursor, encodeCursor, InvalidCursorError, queryBinding } from "../lib/cursor.ts";
import {
  ITEM_COLUMNS, ITEM_FROM, categoryCondition, channelCondition, platformCondition, tagCondition, toFeedItemSummary,
  type ItemRow,
} from "./items.ts";
import { evidenceCondition, foldableSelectionCondition, listedCondition, ownFactEvidenceCondition, selectedCondition } from "./scope.ts";

export interface TimelineQuery extends TimelineFilters {
  cursor?: string | null;
  limit?: number;
  now?: Date;
}

interface GroupRow {
  gk: string;
  anchor_at: Date;
}

function filterSql(q: TimelineQuery) {
  return sql`${channelCondition(q.channel)} ${categoryCondition(q.category)} ${tagCondition(q.tag)}
    ${tagCondition(q.genre)} ${tagCondition(q.field)} ${platformCondition(q.platform)}`;
}

function binding(q: TimelineQuery): string {
  return queryBinding({ c: q.channel, k: q.category, t: q.tag, g: q.genre ?? null, f: q.field ?? null, p: q.platform ?? "all" });
}

/**
 * Public pool reports in the given groups, under the same filters (non-selected included): the sets
 * "另外 N 家也报道了" and "同一个项目还有 N 篇" expand and the group counts come from.
 */
async function groupPool(q: TimelineQuery, now: Date, factIds: number[], assetKeys: string[]) {
  if (!factIds.length && !assetKeys.length) return [];
  const [byFact, byAsset] = await Promise.all([
    factIds.length
      ? sql<{ gk: string; article_id: string; source_id: string }[]>`
        SELECT DISTINCT 'f' || f.id::text AS gk, p.article_id, p.source_id
        FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
        WHERE f.id IN ${sql(factIds)}
          AND ${evidenceCondition()} AND ${listedCondition(now)} ${filterSql(q)}`
      : Promise.resolve([] as { gk: string; article_id: string; source_id: string }[]),
    assetKeys.length
      ? sql<{ gk: string; article_id: string; source_id: string }[]>`
        SELECT DISTINCT 'k' || a.asset_key AS gk, p.article_id, p.source_id
        FROM publications p JOIN articles a ON a.id = p.article_id
        WHERE a.asset_key IN ${sql(assetKeys)} AND ${listedCondition(now)} ${filterSql(q)}`
      : Promise.resolve([] as { gk: string; article_id: string; source_id: string }[]),
  ]);
  return [...byFact, ...byAsset];
}

/**
 * The selected set grouped into cards (asset, fact or standalone item) with their anchor times, newest
 * first. Every timeline page and its day counts read this list; it is kept for five seconds per
 * filter scope (a newly selected report appears at most that much later).
 */
const groupedAnchors = cachedByKey(binding, (q: TimelineQuery) => queryGroupedAnchors(q, new Date()), { freshMs: 5000, maxStaleMs: 5000, maxKeys: 50 });

async function queryGroupedAnchors(q: TimelineQuery, now: Date) {
  const rows = (
    await sql<{ gk: string; anchor_at: Date }[]>`
      WITH base AS MATERIALIZED (
        SELECT p.sort_at, CASE
          WHEN a.asset_key IS NOT NULL AND ${foldableSelectionCondition()} THEN 'k' || a.asset_key
          WHEN p.fact_id IS NOT NULL AND ${ownFactEvidenceCondition()} AND ${foldableSelectionCondition()} THEN 'f' || p.fact_id::text
          ELSE 'a' || p.article_id END AS gk
        FROM publications p JOIN articles a ON a.id = p.article_id
        WHERE ${selectedCondition(now)} ${filterSql(q)}
      )
      SELECT gk, min(sort_at) AS anchor_at FROM base GROUP BY gk ORDER BY anchor_at DESC, gk COLLATE "C" DESC`
  ).map((r) => ({ gk: r.gk, anchor: r.anchor_at.getTime() }));
  return rows;
}

/** Counts requested Beijing days over anchors already sorted newest first. */
export function countTimelineDays(grouped: readonly { anchor: number }[], days: ReadonlySet<string>): Record<string, number> {
  const firstBelow = (bound: number) => {
    let lo = 0, hi = grouped.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (grouped[mid]!.anchor >= bound) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const counts: Record<string, number> = {};
  for (const day of days) {
    const start = beijingMidnight(day).getTime();
    const count = firstBelow(start) - firstBelow(start + 86_400_000);
    if (count) counts[day] = count;
  }
  return counts;
}

export async function loadTimeline(q: TimelineQuery): Promise<Omit<TimelineResponse, "hot">> {
  const now = q.now ?? new Date();
  const limit = Math.min(Math.max(q.limit ?? 20, 1), 40);
  const bind = binding(q);
  let after: { a: number; g: string } | null = null;
  if (q.cursor) {
    const c = decodeCursor<{ a: number; g: string; b: string }>("tl2", q.cursor);
    if (c.b !== bind || typeof c.a !== "number" || typeof c.g !== "string") throw new InvalidCursorError("cursor does not match this query");
    after = { a: c.a, g: c.g };
  }

  // A given clock (tests, replays) reads afresh.
  const grouped = q.now ? await queryGroupedAnchors(q, now) : await groupedAnchors(q);
  const start = after ? grouped.findIndex((g) => g.anchor < after!.a || (g.anchor === after!.a && g.gk < after!.g)) : 0;
  const groups: GroupRow[] = (start < 0 ? [] : grouped.slice(start, start + limit + 1)).map((g) => ({ gk: g.gk, anchor_at: new Date(g.anchor) }));

  const page = groups.slice(0, limit);
  const hasMore = groups.length > limit;

  const factIds = page.filter((g) => g.gk.startsWith("f")).map((g) => Number(g.gk.slice(1)));
  const assetKeys = page.filter((g) => g.gk.startsWith("k")).map((g) => g.gk.slice(1));

  // Read only ranking fields for the whole group; bodies, media and translations are hydrated for this page's representatives.
  type Member = RepresentativeRow & Pick<ItemRow, "id"> & { fact_id: number | null; asset_key: string | null };
  // The same precedence the group keys were built with: an asset takes its reports away from their fact.
  const groupOf = (m: Member) => (m.asset_key !== null ? `k${m.asset_key}` : `f${m.fact_id}`);
  const [members, pool] = await Promise.all([
    factIds.length || assetKeys.length
      ? sql<Member[]>`
        SELECT p.fact_id, a.asset_key, p.article_id AS id, p.body_mode, p.score, p.timeline_at, ${REPRESENTATIVE_COLUMNS}
        FROM publications p JOIN sources s ON s.id = p.source_id JOIN articles a ON a.id = p.article_id
          LEFT JOIN facts f ON f.id = p.fact_id
        WHERE ((p.fact_id IN ${sql(factIds)} AND ${ownFactEvidenceCondition()}) OR a.asset_key IN ${sql(assetKeys)})
          AND ${selectedCondition(now)} AND ${foldableSelectionCondition()} ${filterSql(q)}`
      : Promise.resolve([] as Member[]),
    groupPool(q, now, factIds, assetKeys),
  ]);
  const factInfo = new Map(
    factIds.length ? (await sql<{ id: number; public_id: string }[]>`SELECT id, public_id FROM facts WHERE id IN ${sql(factIds)}`).map((f) => [f.id, f]) : [],
  );

  const planned: Array<{ key: string; anchorAt: string; id: string; group: GroupInfo | null }> = [];
  for (const g of page) {
    if (g.gk.startsWith("a")) {
      planned.push({ key: g.gk, anchorAt: g.anchor_at.toISOString(), id: g.gk.slice(1), group: null });
      continue;
    }
    const kind: GroupKind = g.gk.startsWith("k") ? "asset" : "fact";
    const candidates = members.filter((m) => groupOf(m) === g.gk);
    if (!candidates.length) continue;
    const rep = pickRepresentative(candidates);
    const reports = pool.filter((r) => r.gk === g.gk);
    const repSource = reports.find((r) => r.article_id === rep.id)?.source_id;
    const group: GroupInfo = {
      kind,
      // A fact is addressed by the public id its reports are looked up under; an asset key is already public-safe.
      key: kind === "fact" ? factInfo.get(Number(g.gk.slice(1)))?.public_id ?? g.gk.slice(1) : g.gk.slice(1),
      additionalSourceCount: new Set(reports.filter((r) => r.source_id !== repSource).map((r) => r.source_id)).size,
      reportCount: new Set(reports.map((r) => r.article_id)).size,
      memberIds: [...new Set(candidates.map((m) => m.id))],
    };
    const showGroup = group.reportCount > 1;
    planned.push({ key: g.gk, anchorAt: g.anchor_at.toISOString(), id: rep.id, group: showGroup ? group : null });
  }

  // Recheck scope when hydrating: a withdrawal may commit after the narrow representative read.
  const rows = new Map(planned.length ? (await sql<ItemRow[]>`
    SELECT ${ITEM_COLUMNS} ${ITEM_FROM} WHERE p.article_id IN ${sql(planned.map((p) => p.id))}
      AND ${selectedCondition(now)} ${filterSql(q)}`).map((row) => [row.id, row]) : []);
  const cards: TimelineCard[] = planned.flatMap(({ id, key, anchorAt, group }) => {
    const row = rows.get(id);
    if (!row) return [];
    return [{ key, anchorAt, item: toFeedItemSummary(row), group }];
  });

  // Day header counts for the days on this page, over the full grouped set.
  const days = new Set(page.map((g) => beijingDate(g.anchor_at)));
  const dayCounts = countTimelineDays(grouped, days);

  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor("tl2", { a: last.anchor_at.getTime(), g: last.gk, b: bind }) : null;
  return {
    filters: { channel: q.channel, category: q.category, tag: q.tag, genre: q.genre ?? null, field: q.field ?? null, platform: q.platform ?? "all" },
    cards, nextCursor, dayCounts,
  };
}
