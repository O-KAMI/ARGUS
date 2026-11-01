// The ranking as this site keeps it. Upstream's own order, numbers and words are stored verbatim; the one
// thing changed is every image address, unwrapped out of upstream's signed proxy (its signature expires
// within a day) so this site's own proxy signs it again on each read. Keeping this narrowed form rather
// than the raw answer means a field upstream renames or drops cannot reach a page as an unknown string, and
// a stored snapshot stays readable for as long as its row does.
import { UPSTREAM_ORIGIN } from "./upstream.ts";
import {
  hotBadges, hotSpark, hotTrend, participantKind, storyPublicIdOf, unwrapImageAddress,
  type HotBadge, type HotTrend, type UpstreamHot, type UpstreamHotTopics,
} from "./upstream.ts";

export interface StoredParticipant {
  name: string;
  kind: "editorial" | "signal";
  /** The publisher's or the account's own image address, unsigned; this site's proxy signs it per read. */
  icon: string | null;
}

export interface StoredHotEntry {
  rank: number;
  /** Upstream's own event id: unique among the entries, and what the web keys its rows by. */
  story: { publicId: string; title: string };
  heat: number;
  trend: HotTrend;
  trendPct: number | null;
  badges: HotBadge[];
  participantCount: number;
  sourceCount: number;
  sourceNames: string[];
  participants: StoredParticipant[];
  spark: Array<number | null>;
  summary: string | null;
  latest: string | null;
  cover: { url: string; width: number | null; height: number | null } | null;
}

export interface StoredHot {
  computedAt: string;
  windowHours: number;
  entries: StoredHotEntry[];
}

export interface StoredTopic {
  rank: number;
  /** Upstream's own item id, of the same namespace as its curated list. */
  id: string;
  title: string;
  /** The publisher's own article; null when upstream named none this site may send a reader to. */
  original: string | null;
  storyPublicId: string | null;
  sourceName: string | null;
  sourceCount: number;
  signalCount: number;
  participantCount: number;
  sourceNames: string[];
  latestAt: string | null;
}

export interface StoredTopics {
  count: number;
  items: StoredTopic[];
}

const whole = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const count = (value: unknown): number => Math.max(0, Math.round(whole(value)));

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const words = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim()))] : [];

/**
 * An address this site may send a reader to as the report's original: http(s), and not a page of the
 * catalogue itself. Upstream names the publisher's own article, but a link back to the catalogue would be
 * a link to a site this one does not speak for, so it is dropped rather than passed on.
 */
export function publisherUrl(href: string | null | undefined): string | null {
  if (typeof href !== "string") return null;
  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin === UPSTREAM_ORIGIN ? null : url.toString();
  } catch {
    return null;
  }
}

/** One ranking entry, narrowed: an entry without a rank or a title is not an entry. */
function storedEntry(value: unknown, index: number): StoredHotEntry | null {
  const entry = value as Partial<StoredHotEntry> & { story?: { publicId?: unknown; title?: unknown }; cover?: { url?: unknown; width?: unknown; height?: unknown } | null } | null;
  const publicId = text(entry?.story?.publicId);
  const title = text(entry?.story?.title);
  if (!publicId || !title) return null;
  const cover = text(entry?.cover?.url) ? unwrapImageAddress(String(entry!.cover!.url)) : null;
  return {
    rank: count(entry?.rank) || index + 1,
    story: { publicId, title },
    heat: whole(entry?.heat),
    trend: hotTrend(entry?.trend),
    trendPct: entry?.trendPct === null || entry?.trendPct === undefined ? null : whole(entry.trendPct, 0),
    badges: hotBadges(entry?.badges),
    participantCount: count(entry?.participantCount),
    sourceCount: count(entry?.sourceCount),
    sourceNames: words(entry?.sourceNames),
    participants: (Array.isArray(entry?.participants) ? entry!.participants : []).flatMap((p) => {
      const name = text((p as { name?: unknown })?.name);
      return name ? [{ name, kind: participantKind((p as { kind?: unknown }).kind), icon: unwrapImageAddress(text((p as { iconUrl?: unknown })?.iconUrl)) }] : [];
    }),
    spark: hotSpark(entry?.spark),
    summary: text(entry?.summary),
    latest: text(entry?.latest),
    cover: cover ? { url: cover, width: entry?.cover?.width === null ? null : whole(entry?.cover?.width) || null, height: entry?.cover?.height === null ? null : whole(entry?.cover?.height) || null } : null,
  };
}

/** The ranking answer as stored. An answer without entries stores nothing: the row keeps the ranking before it. */
export function storedHot(answer: UpstreamHot | null): StoredHot | null {
  const entries = (Array.isArray(answer?.entries) ? answer!.entries : []).map(storedEntry).filter((e): e is StoredHotEntry => e !== null);
  const computedAt = text(answer?.computedAt);
  if (!entries.length || !computedAt) return null;
  return { computedAt, windowHours: count(answer?.windowHours) || 48, entries };
}

/** The machine ranking answer as stored, keyed by the item ids that join it to the curated list. */
export function storedTopics(answer: UpstreamHotTopics | null): StoredTopics | null {
  const items = (Array.isArray(answer?.items) ? answer!.items : []).flatMap((topic, index) => {
    const id = text(topic?.id);
    if (!id) return [];
    return [{
      rank: count(topic.rank) || index + 1,
      id,
      title: text(topic.title) ?? id,
      original: publisherUrl(topic.links?.original),
      storyPublicId: storyPublicIdOf(topic.links?.story),
      sourceName: text(topic.source?.name),
      sourceCount: count(topic.sourceCount),
      signalCount: count(topic.signalCount),
      participantCount: count(topic.participantCount ?? topic.sourceCount),
      sourceNames: words(topic.sourceNames),
      latestAt: text(topic.latestAt),
    }];
  });
  return items.length ? { count: items.length, items } : null;
}

/** What the ranking adds to one mirrored report: the place it holds upstream and its picture. */
export interface RankingExtra {
  rank: number;
  heat: number;
  participantCount: number;
  /** Upstream's event id, which the ranking entry is keyed by. */
  storyPublicId: string | null;
  /** The publisher's own image address, already unwrapped. */
  cover: { url: string; width: number | null; height: number | null } | null;
}

/**
 * The ranking by the item id that represents it, merged out of the two stored readings: the machine one
 * names the item and its event, the page one carries that event's picture. Best effort on both — an item no
 * ranking names is mirrored without a picture, and a ranking this pass could not read leaves every item
 * without one.
 */
export function rankingOf(topics: StoredTopics | null, hot: StoredHot | null): Map<string, RankingExtra> {
  const entries = new Map<string, StoredHotEntry>();
  for (const entry of hot?.entries ?? []) entries.set(entry.story.publicId, entry);
  const ranking = new Map<string, RankingExtra>();
  for (const topic of topics?.items ?? []) {
    const entry = topic.storyPublicId ? entries.get(topic.storyPublicId) ?? null : null;
    ranking.set(topic.id, {
      rank: topic.rank,
      heat: entry?.heat ?? 0,
      participantCount: entry?.participantCount || topic.participantCount,
      storyPublicId: topic.storyPublicId,
      cover: entry?.cover ?? null,
    });
  }
  return ranking;
}
