// The upstream public catalogue this site mirrors. Nothing here calls a model and nothing here spends a
// budget: the answers are read with conditional requests, kept as they came (state.ts), and served back
// unchanged (hot.ts) or stored as this site's own material (mirror.ts).
//
// What this reader states about itself, on every request:
//   x-aihot-commercial-use: written-authorization-required   (commercial use needs written authorisation)
//   x-aihot-policy-version: 1.1
// ⚠️ Upstream does not answer with licence headers of its own. Read live on 2026-11-01, `/api/site/hot`,
// `/api/v1/hot-topics`, `/api/v1/items` and `/terms` all came back with `x-aihot-policy-version`,
// `x-aihot-commercial-use`, `x-aihot-contact` and `Link` absent. `policyOf` still reads them, so a row
// records whatever an answer does state, but nothing may assume one is there: the terms this mirror rests
// on are the page at UPSTREAM_TERMS (HTTP 200 the same day), not a header.
//
// Its terms ask a polling reader to keep the saved ETag and send If-None-Match, to poll no faster than once
// a minute, and to wait out a Retry-After. This module asks every 15 minutes (config.ts), keeps the ETag of
// the page it read whole, and holds off for as long as a Retry-After says.
import { guardedFetch } from "@aihot/backend/lib/http-fetch";

export const UPSTREAM_ORIGIN = "https://aihot.news";

export const POLICY_HEADERS = {
  "x-aihot-commercial-use": "written-authorization-required",
  "x-aihot-policy-version": "1.1",
} as const;

/** The terms page this reader checked before mirroring (HTTP 200 on 2026-11-01; no answer links to it). */
export const UPSTREAM_TERMS = "https://aihot.news/terms";

/** The window upstream offers (`24h` or `7d`; anything else answers HTTP 400) and this site keeps. */
export const SELECTED_WINDOW = "7d";
/** Upstream's page cap. The 7-day window answered 115 items in 2 pages when this was written. */
const PAGE_LIMIT = 100;
/** A stop on a runaway cursor, far past the window's ~2 pages. */
const MAX_PAGES = 6;

export const HOT_PATH = "/api/site/hot";
export const HOT_TOPICS_PATH = "/api/v1/hot-topics";
/** The curated list without its cursor; `selectedPath` adds one page's cursor to it. */
export const SELECTED_PATH = `/api/v1/items?mode=selected&window=${SELECTED_WINDOW}&limit=${PAGE_LIMIT}`;

/** The three addresses this module reads, and the rows state.ts keeps for them. */
export const ENDPOINTS = [HOT_PATH, HOT_TOPICS_PATH, SELECTED_PATH] as const;

/** The curated list, one page of it (`cursor` from the previous page's `page.nextCursor`). */
export const selectedPath = (cursor: string | null): string =>
  `${SELECTED_PATH}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;

/** GET /api/v1/items — one curated item. The answer's OpenAPI names every field required but `reason` and `attribution`. */
export interface UpstreamItem {
  id: string;
  title: string;
  originalTitle: string | null;
  summary: string | null;
  source: { name: string } | null;
  links: { aihot: string; original: string };
  publishedAt: string | null;
  discoveredAt: string | null;
  category: string | null;
  score: number | null;
  selected: boolean;
  reason?: string | null;
  attribution?: { name: string; url: string } | null;
}

export interface UpstreamItems {
  schemaVersion: number;
  items: UpstreamItem[];
  page: { count: number; hasMore: boolean; nextCursor: string | null };
}

/** GET /api/v1/hot-topics — the ranking's representative item, and the event page that carries its cover. */
export interface UpstreamHotTopic {
  rank: number;
  /** An item id of the same namespace as /api/v1/items, which is what joins the two rankings. */
  id: string;
  title: string;
  source: { name: string } | null;
  links: { aihot: string; original: string; story?: string | null };
  sourceCount: number;
  signalCount: number;
  participantCount?: number | null;
  sourceNames: string[];
  latestAt: string | null;
}

export interface UpstreamHotTopics {
  schemaVersion: number;
  count: number;
  items: UpstreamHotTopic[];
}

/** GET /api/site/hot — one entry of the 48-hour ranking, as upstream computed it. */
export interface UpstreamHotEntry {
  rank: number;
  story: { publicId: string; title: string };
  heat: number;
  participantCount: number;
  sourceCount: number;
  sourceNames: string[];
  participants: Array<{ name: string; kind?: unknown; iconUrl?: string | null; iconSrcSet?: string | null }>;
  summary: string | null;
  latest: string | null;
  /** `width` and `height` are null on part of the entries; `url` is upstream's own signed image proxy. */
  cover: { url: string; srcSet?: string | null; width: number | null; height: number | null } | null;
  /** Read as unknown: a word or a mark this site does not draw becomes "unknown" or is dropped. */
  trend?: unknown;
  trendPct?: number | null;
  badges?: unknown;
  /** Hourly heat, oldest first, null where the window holds no observation. */
  spark?: unknown;
}

export interface UpstreamHot {
  computedAt: string;
  windowHours: number;
  entries: UpstreamHotEntry[];
}

/** Retry-After as a wait in seconds: a delay or an HTTP date. Null when absent, unparsable or past. */
export function retryAfterSeconds(value: string | null, now = new Date()): number | null {
  if (!value) return null;
  const seconds = /^\s*\d+\s*$/.test(value) ? Number(value) : (Date.parse(value) - now.getTime()) / 1000;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.ceil(seconds);
}

/** The licence terms an answer stated about itself, read from its own headers; null when it stated none. */
export interface UpstreamPolicy {
  /** `x-aihot-policy-version`. */
  version: string | null;
  /** `x-aihot-commercial-use`: what upstream says commercial use needs. */
  commercialUse: string | null;
  /** `x-aihot-contact`. */
  contact: string | null;
  /** The `rel="terms-of-service"` Link header's address. */
  terms: string | null;
}

const TERMS_LINK = /<([^>]+)>\s*;\s*rel="?terms-of-service"?/i;

export function policyOf(headers: { get(name: string): string | null }): UpstreamPolicy | null {
  const policy: UpstreamPolicy = {
    version: headers.get("x-aihot-policy-version"),
    commercialUse: headers.get("x-aihot-commercial-use"),
    contact: headers.get("x-aihot-contact"),
    terms: TERMS_LINK.exec(headers.get("link") ?? "")?.[1] ?? null,
  };
  return Object.values(policy).some((v) => v !== null) ? policy : null;
}

export interface UpstreamAnswer<T> {
  status: number;
  /** Null on a 304 and on an answer that asks the reader to wait. */
  data: T | null;
  etag: string | null;
  /** Seconds to hold off, from Retry-After; null when upstream sent none. */
  retryAfter: number | null;
  /** The licence terms the answer stated about itself; null on every answer read so far. */
  policy: UpstreamPolicy | null;
}

/**
 * One conditional read. A 304 keeps the caller's saved ETag; 429 and 503 carry the wait upstream asks for
 * instead of throwing, so the caller holds off rather than asking again sooner. Anything else that is not
 * 200 throws: an answer this module cannot read is a failure of the pass, not an empty ranking.
 * `origin` is only ever another address of the same upstream (a test's stub); egress stays guarded.
 */
export async function upstreamJson<T>(path: string, etag?: string | null, origin: string = UPSTREAM_ORIGIN): Promise<UpstreamAnswer<T>> {
  const asked = new Date();
  const res = await guardedFetch(`${origin}${path}`, {
    headers: { ...POLICY_HEADERS, ...(etag ? { "if-none-match": etag } : {}) },
    timeoutMs: 30_000,
  });
  const policy = policyOf(res.headers);
  const retryAfter = retryAfterSeconds(res.headers.get("retry-after"), asked);
  if (res.status === 304) return { status: 304, data: null, etag: res.headers.get("etag") ?? etag ?? null, retryAfter, policy };
  if (res.status === 429 || res.status === 503) return { status: res.status, data: null, etag: etag ?? null, retryAfter, policy };
  if (res.status !== 200) throw new Error(`upstream ${path} answered HTTP ${res.status}`);
  return { status: 200, data: JSON.parse(res.text()) as T, etag: res.headers.get("etag"), retryAfter, policy };
}

export interface SelectedWindow {
  items: UpstreamItem[];
  /** The first page's ETag, and only it: a page that did not answer leaves the next pass unconditional. */
  etag: string | null;
  pages: number;
  unchanged: boolean;
  /** Seconds upstream asked this reader to wait (429/503); null when it answered. */
  wait: number | null;
}

/**
 * The whole curated window, page by page, deduplicated by upstream's own id. A 304 on the first page means
 * the window is as this reader last saw it, so no page is read at all.
 */
export async function readSelected(etag: string | null, origin: string = UPSTREAM_ORIGIN): Promise<SelectedWindow> {
  const first = await upstreamJson<UpstreamItems>(selectedPath(null), etag, origin);
  if (first.status === 304) return { items: [], etag: first.etag, pages: 0, unchanged: true, wait: first.retryAfter };
  if (first.status !== 200 || !first.data) return { items: [], etag: null, pages: 0, unchanged: false, wait: first.retryAfter };
  const items: UpstreamItem[] = [];
  const seen = new Set<string>();
  const take = (page: UpstreamItems) => {
    for (const item of Array.isArray(page.items) ? page.items : []) {
      if (typeof item?.id === "string" && !seen.has(item.id)) {
        seen.add(item.id);
        items.push(item);
      }
    }
  };
  take(first.data);
  let page = first.data.page;
  let pages = 1;
  while (page?.hasMore && page.nextCursor && pages < MAX_PAGES) {
    const next = await upstreamJson<UpstreamItems>(selectedPath(page.nextCursor), null, origin);
    if (next.status !== 200 || !next.data) return { items, etag: null, pages, unchanged: false, wait: next.retryAfter };
    take(next.data);
    page = next.data.page;
    pages += 1;
  }
  return { items, etag: page?.hasMore ? null : first.etag, pages, unchanged: false, wait: null };
}

// What an answer carries, narrowed to what this site draws. Upstream may rename or drop a field; a word
// this site has no drawing for becomes "unknown" rather than reaching the page as an unknown string.

const TRENDS = new Set(["up", "down", "flat", "new"]);
export type HotTrend = "up" | "down" | "flat" | "new" | "unknown";

export function hotTrend(value: unknown): HotTrend {
  return typeof value === "string" && TRENDS.has(value) ? (value as HotTrend) : "unknown";
}

const BADGES = new Set(["surge", "new", "rising"]);
export type HotBadge = "surge" | "new" | "rising";

export function hotBadges(value: unknown): HotBadge[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((b): b is HotBadge => typeof b === "string" && BADGES.has(b)))];
}

export function participantKind(value: unknown): "editorial" | "signal" {
  return value === "signal" ? "signal" : "editorial";
}

/** Hourly heat, oldest first; a value that is not a number is a hole in the day. */
export function hotSpark(value: unknown, limit = 48): Array<number | null> {
  if (!Array.isArray(value)) return [];
  return value.slice(-limit).map((v) => (typeof v === "number" && Number.isFinite(v) ? v : null));
}

/** A date upstream states, or null: an undated item is archived by its discovery time (materials.ts). */
export function upstreamDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at) : null;
}

/**
 * The publisher's own image address behind upstream's signed proxy. The signature expires within a day, so
 * a mirrored picture keeps the address inside it and this site's proxy signs it again; an address that is
 * already absolute is kept as it is. Anything else (a relative path that is not the proxy) is no picture.
 */
export function unwrapImageAddress(href: string | null | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, UPSTREAM_ORIGIN);
    const inner = url.pathname === "/api/img-proxy" ? url.searchParams.get("u") : null;
    const address = inner ?? (url.origin === UPSTREAM_ORIGIN ? null : url.toString());
    if (!address) return null;
    const parsed = new URL(address);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/** The id at the end of an upstream event page address, which is the key of a /api/site/hot entry. */
export function storyPublicIdOf(href: string | null | undefined): string | null {
  if (typeof href !== "string") return null;
  const segment = href.replace(/[?#].*$/, "").split("/").pop() ?? "";
  return segment.length > 0 ? segment : null;
}
