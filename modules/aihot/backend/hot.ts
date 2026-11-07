// The ranking this site publishes in place of the engine's own (ServerModule.hot, read by
// publication/hot.ts `publishedHot`): the stored reading of the catalogue's ranking, served as it was
// read, joined to the reports this site mirrors of the same items.
//
// Nothing here is recomputed. The order, the heat, the trend, the badges, the participant names and the
// summaries are upstream's own words and numbers; what this file adds is only what a reader of this site
// needs and upstream cannot give: where the entry opens here, and this site's own signature on every
// picture (upstream's signed addresses expire within a day, so the stored snapshot keeps the publisher's
// own address and the proxy signs it again on each read).
import { HOT_FACE_LIMIT, type HotEntryLink, type HotParticipant } from "@aihot/contracts/site";
import { sql } from "@aihot/backend/db";
import { cached, type Cached } from "@aihot/backend/lib/cache";
import { proxiedImage, proxiedImageSet } from "@aihot/backend/media/imgproxy";
import type { PublishedHot, PublishedHotEntry } from "@aihot/backend/modules";
import { storyReportCondition } from "@aihot/backend/publication/scope";
import { MIRROR_LABEL, MIRROR_SOURCE_ID, aihotConfig, mirrorIntervalMinutes, mirrorMaxSkewMinutes } from "./config.ts";
import type { StoredHot, StoredHotEntry, StoredParticipant, StoredTopic, StoredTopics } from "./snapshot.ts";
import { endpointStates } from "./state.ts";
import { HOT_PATH, HOT_TOPICS_PATH, UPSTREAM_ORIGIN } from "./upstream.ts";

/** Upstream's own ranking page, which the surfaces name as the address to compare the reading against. */
const UPSTREAM_HOT_PAGE = `${UPSTREAM_ORIGIN}/hot`;

/** How often this site reads the ranking, in the words the surfaces draw as they are. */
export function paceOf(cron: string): string {
  const minutes = /^\*\/(\d+) \* \* \* \*$/.exec(cron);
  if (minutes) return `每 ${minutes[1]} 分钟读一次`;
  if (/^\d+ \* \* \* \*$/.test(cron)) return "每小时读一次";
  if (/^\d+ \d+ \* \* \*$/.test(cron)) return "每天读一次";
  return "按后台设定的节奏读取";
}

interface Snapshot {
  hot: StoredHot | null;
  topics: StoredTopics | null;
  /**
   * When each of the two readings in use was last verified valid (a whole 200 or a confirming 304), as the
   * rows state it. A malformed 200 never moves this time, so an old snapshot is never shown as "just read".
   * A ranking whose two halves came from different passes is a mix of two moments, and the reader is told
   * rather than shown a single tidy time.
   */
  readAt: { hot: number | null; topics: number | null };
}

async function querySnapshot(): Promise<Snapshot> {
  const rows = await endpointStates();
  const at = (endpoint: string) => rows.find((row) => row.endpoint === endpoint)?.answer ?? null;
  const read = (endpoint: string) => rows.find((row) => row.endpoint === endpoint)?.lastOkAt?.getTime() ?? null;
  return {
    hot: at(HOT_PATH) as StoredHot | null,
    topics: at(HOT_TOPICS_PATH) as StoredTopics | null,
    readAt: { hot: read(HOT_PATH), topics: read(HOT_TOPICS_PATH) },
  };
}

// Two rows of jsonb, the ranking's ~40 KB among them: read once every 15 seconds rather than once per hot
// surface, and served stale for up to 45 while the next read runs. The join to this site's own reports is
// not cached, so a withdrawal or a retirement reaches the ranking at once.
let reader: Cached<Snapshot> | null = null;
const snapshot = () => (reader ??= cached<Snapshot>(querySnapshot, { freshMs: 15_000, maxStaleMs: 45_000 }));

/**
 * Drops the reading kept above, so the next hot surface asks the database again. A pass that ran in this
 * process — the administrator's manual fetch — calls it: the ranking it just wrote is the one to serve,
 * not the one this process read up to 45 seconds ago.
 */
export function invalidateSnapshot(): void {
  reader = null;
}

/** A report of this site's own for a mirrored item, which is what makes an entry openable here. */
interface OwnReport {
  itemId: string;
  /** The publisher's own article, as the material stored it. */
  url: string;
  /** The publisher upstream named, kept as the material's author. */
  author: string | null;
  /** The catalogue's event id the item was mirrored under; null when no ranking named it then. */
  story: string | null;
  /** The catalogue's own item id. */
  externalId: string | null;
}

async function ownReports(now: Date): Promise<{ byStory: Map<string, OwnReport>; byExternalId: Map<string, OwnReport> }> {
  const rows = await sql<{ id: string; url: string; author: string | null; story: string | null; external_id: string | null }[]>`
    SELECT p.article_id AS id, p.url, a.author, a.raw->'mirror'->'upstream'->>'story' AS story,
      a.raw->>'externalId' AS external_id
    FROM publications p JOIN articles a ON a.id = p.article_id JOIN sources s ON s.id = p.source_id
    WHERE p.source_id = ${MIRROR_SOURCE_ID} AND ${storyReportCondition(now)}`;
  const byStory = new Map<string, OwnReport>();
  const byExternalId = new Map<string, OwnReport>();
  for (const row of rows) {
    const report: OwnReport = { itemId: row.id, url: row.url, author: row.author, story: row.story, externalId: row.external_id };
    if (row.story && !byStory.has(row.story)) byStory.set(row.story, report);
    if (row.external_id && !byExternalId.has(row.external_id)) byExternalId.set(row.external_id, report);
  }
  return { byStory, byExternalId };
}

/**
 * The faces of an entry, in the order the web draws them: 精选组 first as upstream ordered them, then
 * 氛围组, one row per public name, and an image only on the first few editorial ones (HOT_FACE_LIMIT).
 * Every icon address is this site's own signed proxy over the publisher's picture.
 */
function faces(participants: readonly StoredParticipant[]): HotParticipant[] {
  const ordered = participants
    .map((p, i) => ({ p, i }))
    .sort((x, y) => Number(y.p.kind === "editorial") - Number(x.p.kind === "editorial") || x.i - y.i);
  const named = new Map<string, StoredParticipant>();
  for (const { p } of ordered) if (!named.has(p.name)) named.set(p.name, p);
  return [...named].map(([name, p], i): HotParticipant => {
    const person: HotParticipant = { name, kind: p.kind };
    if (p.kind === "editorial" && i < HOT_FACE_LIMIT) {
      person.iconUrl = proxiedImage(p.icon, "avatar");
      const srcSet = proxiedImageSet(p.icon, "avatar");
      if (srcSet) person.iconSrcSet = srcSet;
    }
    return person;
  });
}

function coverOf(entry: StoredHotEntry): PublishedHotEntry["cover"] {
  const url = entry.cover ? proxiedImage(entry.cover.url, "full") : null;
  if (!url || !entry.cover) return null;
  return { url, srcSet: proxiedImageSet(entry.cover.url, "hero") ?? undefined, width: entry.cover.width, height: entry.cover.height };
}

/**
 * The ranking to publish, or null when this module has no reading of it: an unread ranking publishes
 * nothing at all, which leaves the engine's own computed ranking in place (publication/hot.ts).
 */
export async function mirroredHot(now = new Date()): Promise<PublishedHot | null> {
  const [{ hot, topics, readAt }, own] = await Promise.all([snapshot().get(undefined), ownReports(now)]);
  if (!hot?.entries.length) return null;
  const byStory = new Map<string, StoredTopic>();
  for (const topic of topics?.items ?? []) if (topic.storyPublicId) byStory.set(topic.storyPublicId, topic);

  const entries = hot.entries.map((entry): PublishedHotEntry => {
    const topic = byStory.get(entry.story.publicId) ?? null;
    // The report of this site's own for the entry: the one mirrored under this event, else the one mirrored
    // from the item the machine ranking names as this event's representative.
    const report = own.byStory.get(entry.story.publicId) ?? (topic ? own.byExternalId.get(topic.id) ?? null : null);
    const representativeUrl = topic?.original ?? report?.url ?? null;
    const link: HotEntryLink | null = report
      ? { to: `/items/${report.itemId}`, external: false }
      : representativeUrl ? { to: representativeUrl, external: true } : null;
    return {
      rank: entry.rank,
      story: entry.story,
      heat: entry.heat,
      trend: entry.trend,
      trendPct: entry.trendPct,
      badges: entry.badges,
      participantCount: entry.participantCount,
      sourceCount: entry.sourceCount,
      sourceNames: entry.sourceNames,
      participants: faces(entry.participants),
      spark: entry.spark,
      summary: entry.summary,
      latest: entry.latest,
      cover: coverOf(entry),
      link,
      itemId: report?.itemId ?? null,
      representativeUrl,
      representativeSource: topic?.sourceName ?? report?.author ?? null,
      signalCount: topic?.signalCount ?? entry.sourceCount,
      latestAt: topic?.latestAt ?? entry.latest ?? hot.computedAt,
    };
  });

  // The two readings the ranking is made of, as of the passes that read them: the oldest is what a reader
  // may rely on, and a spread past the module's own limit means the halves did not come from one pass.
  const times = [readAt.hot, topics ? readAt.topics : null].filter((t): t is number => t !== null);
  const oldest = times.length ? Math.min(...times) : null;
  const spread = times.length > 1 ? Math.round((Math.max(...times) - Math.min(...times)) / 60_000) : 0;
  const behind = oldest !== null ? Math.round((now.getTime() - oldest) / 60_000) : 0;

  return {
    computedAt: hot.computedAt,
    windowHours: hot.windowHours,
    mirror: {
      label: MIRROR_LABEL, url: UPSTREAM_HOT_PAGE, pace: paceOf(aihotConfig.refreshCron),
      asOf: oldest === null ? null : new Date(oldest).toISOString(),
      mixed: spread > mirrorMaxSkewMinutes(),
      stale: behind > 2 * mirrorIntervalMinutes(),
    },
    entries,
  };
}
