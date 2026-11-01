// The reports a folded card opens ("另外 N 家也报道了", "同一个项目还有 N 篇"). Members must pass the same
// visibility, pool eligibility and parent-page filters as the card they open under.
import type { CategoryKey, ChannelKey, PlatformKey } from "@aihot/contracts/taxonomy";
import type { GroupKind, GroupReportsResponse } from "@aihot/contracts/site";
import { sql } from "../db.ts";
import { categoryCondition, channelCondition, platformCondition, tagCondition } from "./items.ts";
import { evidenceCondition, listedCondition } from "./scope.ts";
import { publicSourceName } from "./rules.ts";

export interface GroupReportsQuery {
  kind: GroupKind;
  /** A fact's public id, or an asset key (lib/asset-key.ts). */
  key: string;
  channel: ChannelKey;
  category: CategoryKey | null;
  tag: string | null;
  genre?: string | null;
  field?: string | null;
  platform?: PlatformKey;
}

/** A group has a few dozen reports at most; the cap only bounds an odd one. */
const MAX_REPORTS = 100;

const COLUMNS = sql`p.article_id AS id, p.title, p.timeline_at, p.url, s.name AS source_name`;
const FROM = sql`FROM publications p JOIN sources s ON s.id = p.source_id`;

/** The group's public reports under the filters, newest first; null when it has none. */
export async function loadGroupReports(q: GroupReportsQuery, now = new Date()): Promise<GroupReportsResponse | null> {
  const filters = sql`${channelCondition(q.channel)} ${categoryCondition(q.category)} ${tagCondition(q.tag)}
    ${tagCondition(q.genre)} ${tagCondition(q.field)} ${platformCondition(q.platform)}`;
  const members = await (q.kind === "asset"
    ? sql<{ id: string; title: string; timeline_at: Date; url: string; source_name: string }[]>`
      SELECT ${COLUMNS} ${FROM} JOIN articles a ON a.id = p.article_id
      WHERE a.asset_key = ${q.key} AND ${listedCondition(now)} ${filters}
      ORDER BY p.timeline_at DESC, p.article_id ASC LIMIT ${MAX_REPORTS}`
    : sql<{ id: string; title: string; timeline_at: Date; url: string; source_name: string }[]>`
      SELECT ${COLUMNS} ${FROM}
        JOIN fact_articles fa ON fa.article_id = p.article_id JOIN facts f ON f.id = fa.fact_id
      WHERE f.public_id = ${q.key} AND ${evidenceCondition()} AND ${listedCondition(now)} ${filters}
      ORDER BY p.timeline_at DESC, p.article_id ASC LIMIT ${MAX_REPORTS}`);
  if (members.length === 0) return null;
  return {
    kind: q.kind,
    key: q.key,
    reports: members.map((m) => ({
      id: m.id,
      title: m.title,
      source: { name: publicSourceName(m.source_name) },
      timelineAt: m.timeline_at.toISOString(),
      originalUrl: m.url,
    })),
  };
}
