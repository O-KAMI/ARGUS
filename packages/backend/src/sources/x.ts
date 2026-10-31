// X accounts via SocialData search, newest first. Verified publishers include their own thread
// continuations; other replies stay excluded. Plain accounts share length-bounded search shards.
import { searchTweets, tweetMedia, tweetText, type SdArticle, type SdMedia, type SdTweet } from "../providers/socialdata.ts";
import { fetchFxTimeline as fetchFxTimelineApi, type FxStatus } from "../providers/fxtwitter.ts";
import { ProviderRejectedError } from "../providers/receipts.ts";
import type { XPostData } from "../content/materials.ts";
import { sha256 } from "../lib/ids.ts";
import { FetchError, type Candidate, type SourceRow } from "./types.ts";
import { xHandle } from "./account.ts";

function avatar(url: string | undefined): string | null {
  // Larger avatar than the default 48px thumbnail.
  return url ? url.replace("_normal.", "_bigger.") : null;
}

export function toXPost(t: SdTweet): XPostData {
  const q = t.quoted_status ?? null;
  return {
    tweetId: t.id_str,
    authorName: t.user.name,
    handle: t.user.screen_name,
    avatarUrl: avatar(t.user.profile_image_url_https),
    text: tweetText(t),
    lang: t.lang ?? null,
    replyTo: t.in_reply_to_status_id_str ?? null,
    media: tweetMedia(t),
    quoted: q
      ? { authorName: q.user.name, handle: q.user.screen_name, text: tweetText(q), url: `https://x.com/${q.user.screen_name}/status/${q.id_str}`, media: tweetMedia(q) }
      : null,
    repostedBy: t.reposted_by
      ? { authorName: t.reposted_by.name, handle: t.reposted_by.screen_name, url: `https://x.com/${t.reposted_by.screen_name}` }
      : null,
  };
}

const X_ARTICLE_LINK = /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/i\/article\/\d+/gi;

/** The post links an X Article (long-form text posted on X): its body is fetched before judging. */
export function linksXArticle(text: string | null | undefined): boolean {
  return new RegExp(X_ARTICLE_LINK.source, "i").test(text ?? "");
}

/** Nothing but the article's link: without the article there is nothing to judge (under 30 characters left). */
export function onlyXArticleLink(text: string | null | undefined): boolean {
  return linksXArticle(text) && (text ?? "").replace(X_ARTICLE_LINK, "").trim().length < 30;
}

/** The post's own X Article in SocialData's shape, so both providers share one formatter. */
export function fxArticle(status: FxStatus): SdArticle | null {
  const article = status.article;
  const blocks = article?.content?.blocks;
  return article && Array.isArray(blocks) && blocks.length ? { title: article.title, content_state: { blocks } } : null;
}

/** An X Article as plain text with Markdown-like headings, quotes and list marks; media blocks are left out. */
export function xArticleText(article: SdArticle): { title: string; text: string } | null {
  const lines: string[] = [];
  for (const b of article.content_state?.blocks ?? []) {
    const text = (b.text ?? "").trim();
    if (!text || b.type === "atomic") continue;
    const mark = { "header-one": "# ", "header-two": "## ", "header-three": "### ", blockquote: "> ", "unordered-list-item": "- ", "ordered-list-item": "1. " }[b.type ?? ""] ?? "";
    lines.push(mark + text);
  }
  const text = lines.join("\n\n").trim();
  return text ? { title: (article.title ?? "").trim(), text } : null;
}

export function tweetToCandidate(t: SdTweet): Candidate {
  const post = toXPost(t);
  const firstLine = post.text.split("\n").find((l) => l.trim()) ?? post.text;
  return {
    url: `https://x.com/${t.user.screen_name}/status/${t.id_str}`,
    identityKey: `x:${t.id_str}`,
    title: firstLine.length > 140 ? `${firstLine.slice(0, 137)}...` : firstLine,
    author: t.user.screen_name,
    language: t.lang ?? null,
    publishedAt: new Date(t.tweet_created_at),
    bodyText: [post.text, post.quoted ? `\n\n【引用 @${post.quoted.handle}】${post.quoted.text}` : ""].join("").trim(),
    // A linked X Article is the post's real body: extraction fetches it (jobs/content.ts route).
    bodyStatus: linksXArticle(post.text) ? "pending" : "ok",
    xPost: post,
    media: post.media ?? [],
    raw: { favorite: t.favorite_count ?? null, retweet: t.retweet_count ?? null, views: t.views_count ?? null },
  };
}

function fxMedia(status: FxStatus): SdMedia[] {
  const all = Array.isArray(status.media?.all) ? status.media.all : [];
  return all.flatMap((m): SdMedia[] => {
    const type = m.type === "video" ? "video" : m.type === "gif" || m.type === "animated_gif" ? "animated_gif" : "photo";
    // A video's playable URL is not an image: show its thumbnail and open the post for playback.
    const url = type === "photo" ? m.url : (m.thumbnail_url ?? m.url);
    return url ? [{ type, media_url_https: url, original_info: { width: m.width, height: m.height } }] : [];
  });
}

function fxDate(status: FxStatus, fallback?: string): string | null {
  const ms = typeof status.created_timestamp === "number" ? status.created_timestamp * 1000 : Date.parse(status.created_at ?? "");
  if (Number.isFinite(ms)) return new Date(ms).toISOString();
  return fallback ?? null;
}

function fxToTweet(status: FxStatus, fallbackDate?: string): SdTweet | null {
  const date = fxDate(status, fallbackDate);
  // A malformed entry is skipped, not turned into a chapter that blocks the whole free layer.
  if (!date) return null;
  const media = fxMedia(status);
  return {
    id_str: status.id,
    tweet_created_at: date,
    full_text: status.text ?? "",
    lang: status.lang,
    user: {
      name: status.author?.name ?? status.author?.screen_name ?? "",
      screen_name: status.author?.screen_name ?? "",
      profile_image_url_https: status.author?.avatar_url,
    },
    in_reply_to_status_id_str: status.replying_to?.status ?? null,
    in_reply_to_screen_name: status.replying_to?.screen_name ?? null,
    quoted_status: status.quote ? fxToTweet(status.quote, date) : null,
    is_quote_status: !!status.quote,
    entities: media.length ? { media } : undefined,
    extended_entities: media.length ? { media } : undefined,
    favorite_count: status.likes,
    retweet_count: status.reposts,
    reply_count: status.replies,
    quote_count: status.quotes,
    views_count: status.views,
    reposted_by: status.reposted_by
      ? { name: status.reposted_by.name ?? status.reposted_by.screen_name ?? "", screen_name: status.reposted_by.screen_name ?? "", profile_image_url_https: status.reposted_by.avatar_url }
      : null,
  };
}

/** Reposts are kept even when the original was a reply: the followed account chose to carry it. */
function keepsFxStatus(status: FxStatus, handle: string, selfThreads: boolean): boolean {
  if (status.reposted_by) return true;
  if (!status.replying_to) return true;
  return selfThreads && status.replying_to.screen_name?.toLowerCase() === handle.toLowerCase();
}

/** A free account import or outage repair never turns into an unbounded walk through its archive. */
const FX_MAX_PAGES = 3;
const FX_BACKLOG_MS = 7 * 86_400_000;
const FX_REQUEST_BUDGET = 12;
const FX_MAX_BACKLOG = 3;

/** An older FxTwitter stretch, with the boundary that was in force when it was deferred. */
export interface FxBacklog {
  next: string;
  untilId: string | null;
  publishedAfter: string;
}

function savedFxBacklog(value: unknown): FxBacklog[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((b): FxBacklog[] => {
    if (!b || typeof b !== "object") return [];
    const item = b as Record<string, unknown>;
    if (typeof item.next !== "string" || !item.next || typeof item.publishedAfter !== "string" || !Number.isFinite(Date.parse(item.publishedAfter))) return [];
    if (item.untilId !== null && (typeof item.untilId !== "string" || !/^\d+$/.test(item.untilId))) return [];
    return [{ next: item.next, untilId: item.untilId, publishedAfter: item.publishedAfter }];
  });
}

/** Reposts carry an old original's id and date, so only the account's own posts prove coverage. */
function fxBoundary(statuses: FxStatus[], handle: string, untilId: string | null, floor: number): "watermark" | "time" | null {
  for (const status of statuses) {
    if (status.reposted_by || status.author?.screen_name?.toLowerCase() !== handle.toLowerCase()) continue;
    const date = fxDate(status);
    if (date && Date.parse(date) <= floor) return "time";
    if (untilId && /^\d+$/.test(status.id) && BigInt(status.id) <= BigInt(untilId)) return "watermark";
  }
  return null;
}

/**
 * The newest page plus bounded older stretches. The first import reads at most seven days; an existing
 * source pages only when its newest page has not met the old watermark (a detected collection hole).
 * A deferred cursor keeps its original watermark and time floor, so a busy account makes progress over
 * later runs instead of restarting a full backfill every time. Raw retries share the same request budget.
 */
export async function fetchFxSource(source: SourceRow): Promise<XFetch> {
  const handle = xHandle(source.config);
  if (!handle) throw new FetchError("query missing");
  const selfThreads = source.config.publisherRole === "organization" || source.config.publisherRole === "person";
  const saved = savedFxBacklog(source.cursor?.fxBacklog);
  const watermark = typeof source.cursor?.lastTweetId === "string" && /^\d+$/.test(source.cursor.lastTweetId) ? source.cursor.lastTweetId : null;
  const budget = { remaining: FX_REQUEST_BUDGET };
  const tweets = new Map<string, SdTweet>();
  let totalPages = 0;
  let newestPages = 0;
  let dropped = 0;

  const readStretch = async (stretch: { next: string | null; untilId: string | null; publishedAfter: string }, pageLimit: number, initial: boolean) => {
    let next = stretch.next;
    const floor = Date.parse(stretch.publishedAfter);
    const startPages = totalPages;
    while (totalPages < FX_MAX_PAGES && totalPages - startPages < pageLimit && budget.remaining > 0) {
      let timeline: Awaited<ReturnType<typeof fetchFxTimelineApi>>;
      try {
        timeline = await fetchFxTimelineApi(handle, next, { requestBudget: budget });
      } catch (error) {
        // The newest page remains mandatory: without it the existing RSS/SocialData fallback still runs.
        if (initial && totalPages === startPages) throw error;
        return { backlog: next ? { ...stretch, next } : null, failed: true };
      }
      totalPages += 1;
      for (const status of timeline.statuses) {
        if (!keepsFxStatus(status, handle, selfThreads)) continue;
        const tweet = fxToTweet(status);
        if (!tweet) continue;
        // A newly discovered repost still matters when its original predates the archive window.
        if (!status.reposted_by && Date.parse(tweet.tweet_created_at) < floor) continue;
        if (!tweets.has(tweet.id_str)) tweets.set(tweet.id_str, tweet);
      }
      const boundary = fxBoundary(timeline.statuses, handle, stretch.untilId, floor);
      if (boundary || !timeline.cursor) return { backlog: null, failed: false };
      next = timeline.cursor;
    }
    return { backlog: next ? { ...stretch, next } : null, failed: false };
  };

  // With older work outstanding, reserve all but one page for it; new posts still get checked first.
  const newestLimit = saved.length ? 1 : FX_MAX_PAGES;
  const newest = await readStretch({ next: null, untilId: watermark, publishedAfter: new Date(Date.now() - FX_BACKLOG_MS).toISOString() }, newestLimit, true);
  newestPages = totalPages;
  const pending = [...saved];
  if (newest.backlog) pending.push(newest.backlog);

  let index = 0;
  let failed = false;
  while (index < pending.length && totalPages < FX_MAX_PAGES && budget.remaining > 0 && !failed) {
    const read = await readStretch(pending[index]!, FX_MAX_PAGES - totalPages, false);
    if (read.backlog) pending[index] = read.backlog;
    else pending.splice(index, 1);
    if (!read.backlog) continue;
    index += 1;
    failed = read.failed;
  }
  while (pending.length > FX_MAX_BACKLOG) {
    pending.shift();
    dropped += 1;
  }

  const all = [...tweets.values()];
  const lastId = all.reduce<string | null>((max, t) => (max === null || BigInt(t.id_str) > BigInt(max) ? t.id_str : max), null);
  return {
    candidates: all.map(tweetToCandidate),
    receiptIds: [],
    lastId,
    backlog: [],
    fxBacklog: pending,
    fxRequests: FX_REQUEST_BUDGET - budget.remaining,
    pages: newestPages,
    truncated: pending.length > 0,
    backlogPages: totalPages - newestPages,
    dropped,
  };
}

/** Half-hour receipt window: a retried fetch in the same window reuses the paid response. */
function windowKey(now = Date.now()): string {
  return new Date(Math.floor(now / 1_800_000) * 1_800_000).toISOString();
}

/** Pages of new posts read per run after a watermark; a longer search continues in later runs. */
const MAX_PAGES = 10;
/** Pages per run spent on older stretches left over from earlier runs. */
const MAX_BACKLOG_PAGES = 10;
/** Stretches kept per source; beyond this the oldest is given up and reported. */
const MAX_BACKLOG = 5;

/** Where a newest-first search stopped at the page limit: the same query continues from `next`. */
export interface XBacklog {
  query: string;
  next: string;
}

export interface XRead {
  tweets: SdTweet[];
  /** Paid search pages whose business effects must be committed before their receipts complete. */
  receiptIds: number[];
  lastId: string | null;
  /** Stretches still to read, oldest first (kept in the source cursor). */
  backlog: XBacklog[];
  pages: number;
  /** The new-post search stopped at the page limit; the rest joined the backlog. */
  truncated: boolean;
  backlogPages: number;
  /** Stretches given up (too many, or the provider refused to continue one): posts in them may be missing. */
  dropped: number;
}

export interface XFetch extends Omit<XRead, "tweets"> {
  candidates: Candidate[];
  /** Free-provider continuations stay separate from paid SocialData query cursors. */
  fxBacklog?: FxBacklog[];
  /** Raw FxTwitter HTTP requests, including retries. */
  fxRequests?: number;
}

/**
 * New posts since the watermark. The search is bounded by since_id, so every further page holds older
 * posts that are still new to us. A search longer than one run's pages (a long outage) moves the
 * watermark to the newest post and keeps its position; later runs read on from there until it reaches
 * the old watermark, so nothing in between is skipped. Without a watermark (a source's very first
 * fetch) one page is read: its import is bounded anyway.
 */
export async function readXSearch(base: string, opts: { lastId: string | null; backlog: XBacklog[]; subject: string; type?: "Latest" | "Top" }): Promise<XRead> {
  const { lastId } = opts;
  const backlog = opts.backlog.map((b) => ({ ...b }));
  const window = windowKey();
  const search = (query: string, cursor: string | null) =>
    searchTweets(query, { purpose: "source_fetch", subject: opts.subject, window, type: opts.type ?? "Latest", cursor });
  const all: SdTweet[] = [];
  const receiptIds = new Set<number>();
  const query = lastId ? `${base} since_id:${lastId}` : base;
  let cursor: string | null = null;
  let pages = 0;
  let truncated = false;
  for (;;) {
    let res: Awaited<ReturnType<typeof search>>;
    try {
      res = await search(query, cursor);
    } catch (error) {
      // A later page failing keeps the pages already read; the search goes on from there next run.
      if (!cursor) throw error;
      truncated = true;
      backlog.push({ query, next: cursor });
      break;
    }
    pages += 1;
    receiptIds.add(res.receiptId);
    all.push(...res.tweets);
    if (!lastId || !res.nextCursor || res.tweets.length === 0) break;
    if (pages >= MAX_PAGES) {
      truncated = true;
      backlog.push({ query, next: res.nextCursor });
      break;
    }
    cursor = res.nextCursor;
  }

  // Older stretches, oldest first. Budget, account or passing trouble leaves them for the next run; a
  // position the provider refuses as a bad request (an expired cursor) is given up.
  let dropped = 0;
  while (backlog.length > MAX_BACKLOG) {
    backlog.shift();
    dropped += 1;
  }
  let backlogPages = 0;
  while (backlog.length > 0 && backlogPages < MAX_BACKLOG_PAGES) {
    const stretch = backlog[0]!;
    let res: Awaited<ReturnType<typeof search>>;
    try {
      res = await search(stretch.query, stretch.next);
    } catch (error) {
      if (error instanceof ProviderRejectedError && (error.status === 400 || error.status === 422)) {
        backlog.shift();
        dropped += 1;
        continue;
      }
      break;
    }
    backlogPages += 1;
    receiptIds.add(res.receiptId);
    all.push(...res.tweets);
    if (!res.nextCursor || res.tweets.length === 0) backlog.shift();
    else stretch.next = res.nextCursor;
  }

  const seen = new Set<string>();
  const tweets = all.filter((t) => !t.retweeted_status && !seen.has(t.id_str) && !!seen.add(t.id_str));
  const maxId = tweets.reduce<string | null>((m, t) => (m === null || BigInt(t.id_str) > BigInt(m) ? t.id_str : m), lastId);
  return { tweets, receiptIds: [...receiptIds], lastId: maxId, backlog, pages, truncated, backlogPages, dropped };
}

/**
 * One account's own search (its first fetch, a query of its own, or a manual run from the admin), from
 * its watermark or from an earlier post (`since`).
 */
export async function fetchXSearch(source: SourceRow, since?: string): Promise<XFetch> {
  const handle = selfThreadHandle(source);
  const base = handle ? `from:${handle} (-filter:replies OR filter:self_threads)` : String(source.config.query ?? "");
  if (!base) throw new FetchError("query missing");
  const { tweets, ...read } = await readXSearch(base, {
    lastId: since ?? source.cursor?.lastTweetId ?? null,
    backlog: Array.isArray(source.cursor?.xBacklog) ? source.cursor.xBacklog : [],
    subject: `source:${source.id}`,
    type: source.config.searchType ?? "Latest",
  });
  return { candidates: tweets.map(tweetToCandidate), ...read };
}

// Shards: plain account queries read together

/** A query that can share a search: exactly "from:handle -filter:replies", newest first. */
const SHARDABLE = /^from:[A-Za-z0-9_]{1,15} -filter:replies$/i;
/** The same test in SQL, for the schedulers. */
export const SHARDABLE_SQL = "^from:[A-Za-z0-9_]{1,15} -filter:replies$";
/** SocialData refuses queries over 512 characters; the since_id watermark takes about 30 of them. */
const SHARD_QUERY_MAX = 470;
const SHARD_MAX_ACCOUNTS = 24;

/** The account a source reads, when it can share a search: a plain query and a watermark already set. */
export function shardHandle(s: Pick<SourceRow, "kind" | "config" | "cursor">): string | null {
  if (s.kind !== "x_search" || (s.config.searchType ?? "Latest") !== "Latest" || !s.cursor?.lastTweetId) return null;
  return SHARDABLE.test(String(s.config.query ?? "")) ? xHandle(s.config) : null;
}

/** Verified publisher identity permits its own announcement thread, not conversations with others. */
export function selfThreadHandle(s: Pick<SourceRow, "config">): string | null {
  if (s.config.publisherRole !== "organization" && s.config.publisherRole !== "person") return null;
  return SHARDABLE.test(String(s.config.query ?? "")) ? xHandle(s.config) : null;
}

export function shardQuery(handles: string[], selfThreads: string[] = []): string {
  const posts = `(${handles.map((h) => `from:${h}`).join(" OR ")}) -filter:replies`;
  const own = handles.filter((h) => selfThreads.includes(h));
  return own.length ? `(${posts} OR (${own.map((h) => `from:${h}`).join(" OR ")}) filter:self_threads)` : posts;
}

export interface XShard {
  key: string;
  mode: string;
  sourceIds: string[];
}

/**
 * Accounts that can share a search, per participation mode, in a stable order (by source id) and
 * packed into queries under the length limit. The same sources give the same shards, so a shard's
 * accounts stay together between runs; a source added or removed shifts only the shards after it.
 */
export function planXShards(sources: Array<Pick<SourceRow, "id" | "kind" | "config" | "cursor" | "participation_mode">>): XShard[] {
  const byMode = new Map<string, Array<{ id: string; handle: string; selfThread: boolean }>>();
  for (const s of sources) {
    const handle = shardHandle(s);
    if (handle) byMode.set(s.participation_mode, [...(byMode.get(s.participation_mode) ?? []), { id: s.id, handle, selfThread: !!selfThreadHandle(s) }]);
  }
  const shards: XShard[] = [];
  for (const [mode, list] of [...byMode].sort(([a], [b]) => a.localeCompare(b))) {
    list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let current: typeof list = [];
    const close = () => {
      if (current.length) shards.push({ mode, sourceIds: current.map((c) => c.id), key: `${mode}:${sha256(current.map((c) => c.id).join(",")).slice(0, 12)}` });
      current = [];
    };
    for (const s of list) {
      if (current.length >= SHARD_MAX_ACCOUNTS || shardQuery([...current, s].map((c) => c.handle), [...current, s].filter((c) => c.selfThread).map((c) => c.handle)).length > SHARD_QUERY_MAX) close();
      current.push(s);
    }
    close();
  }
  return shards;
}
