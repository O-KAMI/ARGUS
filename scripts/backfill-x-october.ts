// October 2026 backfill for the site's own X accounts (2026-10-01 .. 2026-10-31, Asia/Shanghai).
//
// Normal collection reads the newest FxTwitter page of an account, so October posts below that page
// were never captured. FxTwitter cannot be asked for a window: `?since=<tweet id>` answers 204 for
// busy and quiet accounts alike and `since_id`/`max_id` are silently ignored (measured 2026-10-31),
// but `cursor.bottom` does page back through the archive for free. So the walk is: page the timeline
// until one of the account's own posts predates the window. SocialData is bought only for an account
// whose walk stopped short, and only through the receipt and budget machinery.
//
// Nothing here analyses anything: the material is stored and queued, no model is called. Every row
// carries the backfill marker, so it stays out of the daily report and the hot rankings.
//
//   node --env-file=.env scripts/backfill-x-october.ts                       # dry run (the default)
//   node --env-file=.env scripts/backfill-x-october.ts x-dotey x-sama        # dry run, some sources
//   BACKFILL_X_OCTOBER_CONFIRM=1 node --env-file=.env scripts/backfill-x-october.ts \
//     --live --confirm=BACKFILL-X-2026-10                                   # the real run
import { addDays, beijingDate, beijingMidnight, monthRange } from "@aihot/contracts/time";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { queueProcessing } from "@aihot/backend/jobs/content";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { fetchFxTimeline, type FxRequestBudget, type FxStatus, type FxTimeline } from "@aihot/backend/providers/fxtwitter";
import { BudgetExceededError, completeReceipt } from "@aihot/backend/providers/receipts";
import { searchTweets, type SdMedia, type SdTweet } from "@aihot/backend/providers/socialdata";
import { xHandle } from "@aihot/backend/sources/account";
import { admitListing } from "@aihot/backend/sources/filters";
import type { Candidate, SourceRow } from "@aihot/backend/sources/types";
import { selfThreadHandle, tweetToCandidate } from "@aihot/backend/sources/x";

const MONTH = "2026-10";
const CONFIRM_TOKEN = "BACKFILL-X-2026-10";
const CONFIRM_ENV = "BACKFILL_X_OCTOBER_CONFIRM";
const BACKFILL_REASON = "october-backfill";

/** Posts on one FxTwitter timeline page. */
const PAGE_POSTS = 20;
/** Raw requests per page, the provider's 404 retries included: about one transient 404 every two
 * pages, and a cursor that failed three fast attempts answered ten seconds later. */
const REQUESTS_PER_PAGE = 2;
/** Rounds for one page, each the provider's own three attempts. A page given up here is a hole in
 * October, so the waits grow instead of the walk moving on. */
const PAGE_ROUNDS_MS = [0, 5_000, 15_000, 30_000];
const MAX_PAGES_PER_SOURCE = 60;
const MAX_REQUESTS_PER_SOURCE = 250;
const MAX_REQUESTS_TOTAL = 1_500;
const PAGE_PACE_MS = 400;
const MAX_PAID_PAGES_PER_SOURCE = 10;
const PACE_MARGIN = 1.15;
/** SocialData bills US$0.20 per 1,000 objects returned (providers/socialdata.ts). */
const USD_PER_OBJECT = 0.0002;

const range = monthRange(MONTH)!;
const WINDOW_START = beijingMidnight(range.start);
/** Exclusive: midnight Beijing on the first day of the next month. */
const WINDOW_END = beijingMidnight(addDays(range.end, 1));
/** X ids begin with their milliseconds since 2010-11-04 (sources/collect.ts xIdAt). */
const xIdAt = (ms: number) => ((BigInt(ms) - 1288834974657n) << 22n).toString();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const message = (error: unknown) => String(error instanceof Error ? error.message : error).slice(0, 200);

const argv = process.argv.slice(2);
const live = argv.includes("--live");
const confirm = argv.find((a) => a.startsWith("--confirm="))?.slice("--confirm=".length);
const wanted = argv.filter((a) => !a.startsWith("--"));
const unrecognised = argv.filter((a) => a.startsWith("--") && a !== "--live" && a !== "--dry-run" && !a.startsWith("--confirm="));

if (unrecognised.length) {
  console.error(`不认识的参数：${unrecognised.join(" ")}。用法见文件开头。`);
  process.exit(1);
}
// Two independent confirmations, so neither a repeated shell history entry nor one typed flag spends
// anything: the token on the command line and its environment variable beside it.
if (live && (confirm !== CONFIRM_TOKEN || process.env[CONFIRM_ENV] !== "1")) {
  console.error(`--live 会真的抓取并写库。它还要两重确认：--confirm=${CONFIRM_TOKEN} 与环境变量 ${CONFIRM_ENV}=1。`);
  console.error("现在什么都没做。只想看计划，直接不带 --live 运行。");
  process.exit(1);
}
const now = Date.now();
if (now <= WINDOW_START.getTime()) {
  console.error(`回灌窗口 ${MONTH} 还没开始，没有可补的内容。`);
  process.exit(1);
}

interface Plan {
  source: SourceRow;
  handle: string;
  storedOctober: number;
  /** Newest and oldest October material already in the library. */
  storedSpan: string;
  perDay: number;
  newPosts: number;
  pages: number;
  requests: number;
  paidRequests: number;
  paidCost: number;
}

const sources = (
  await sql<SourceRow[]>`
    SELECT id, name, kind, config, tier, participation_mode, first_party, interval_minutes, enabled, cursor, fail_count
    FROM sources WHERE kind = 'x_search' ORDER BY id`
).filter((s) => s.enabled);
const paused = (
  await sql<{ id: string }[]>`SELECT id FROM sources WHERE kind = 'x_search' AND NOT enabled ORDER BY id`
).map((r) => r.id);
const missing = wanted.filter((id) => !sources.some((s) => s.id === id) && !paused.includes(id));
if (missing.length) {
  console.error(`找不到这些 X 信源：${missing.join(", ")}`);
  await closeDb();
  process.exit(1);
}
const chosen = wanted.length ? sources.filter((s) => wanted.includes(s.id)) : sources;
const skippedWanted = wanted.filter((id) => paused.includes(id));

const budgetRow = await sql<{ per_minute: number; per_hour: number; per_day: number }[]>`
  SELECT per_minute, per_hour, per_day FROM budgets WHERE service = 'socialdata'`;
// The newest page of each account is what normal collection stores, so the span of a source's newest
// PAGE_POSTS posts is its posting rate: the only volume evidence available without reading anything.
const stored = await sql<Array<{ source_id: string; published_at: Date }>>`
  SELECT source_id, published_at FROM articles
  WHERE source_id = ANY(${chosen.map((s) => s.id)}::text[]) AND published_at IS NOT NULL
  ORDER BY source_id, published_at DESC`;

const bySource = new Map<string, Date[]>();
for (const row of stored) bySource.set(row.source_id, [...(bySource.get(row.source_id) ?? []), row.published_at]);

const walkDays = (now - WINDOW_START.getTime()) / 86_400_000;
const windowDays = (Math.min(now, WINDOW_END.getTime()) - WINDOW_START.getTime()) / 86_400_000;

const plans: Plan[] = [];
for (const source of chosen) {
  const handle = xHandle(source.config);
  if (!handle) {
    console.error(`${source.id}: 查询里没有 from:<handle>，读不了，跳过。`);
    continue;
  }
  const dates = bySource.get(source.id) ?? [];
  const october = dates.filter((d) => d.getTime() >= WINDOW_START.getTime() && d.getTime() < WINDOW_END.getTime());
  const newest = dates.slice(0, PAGE_POSTS);
  const spanMs = newest.length > 1 ? newest[0].getTime() - newest[newest.length - 1].getTime() : 0;
  const perDay = spanMs > 0 ? ((newest.length - 1) * 86_400_000) / spanMs : 0;
  const seen = perDay * walkDays;
  const pages = Math.max(1, Math.ceil(seen / PAGE_POSTS)) + 1;
  const expectedOctober = Math.round(perDay * windowDays);
  plans.push({
    source, handle,
    storedOctober: october.length,
    storedSpan: october.length
      ? `${beijingDate(october[october.length - 1])}..${beijingDate(october[0])}`
      : "-",
    perDay,
    newPosts: Math.max(0, expectedOctober - october.length),
    pages,
    requests: pages * REQUESTS_PER_PAGE,
    paidRequests: pages,
    paidCost: seen * USD_PER_OBJECT,
  });
}

const total = {
  storedOctober: plans.reduce((sum, p) => sum + p.storedOctober, 0),
  newPosts: plans.reduce((sum, p) => sum + p.newPosts, 0),
  pages: plans.reduce((sum, p) => sum + p.pages, 0),
  requests: plans.reduce((sum, p) => sum + p.requests, 0),
  paidRequests: plans.reduce((sum, p) => sum + p.paidRequests, 0),
  paidCost: plans.reduce((sum, p) => sum + p.paidCost, 0),
};

const head = ["source", "handle", "oct-in-db", "oct-span", "post/day", "new", "pages", "free-req", "paid-req*", "usd*"];
console.log(`X 十月回灌：${range.start} .. ${range.end}（北京时间）· ${plans.length} 个信源${live ? "" : " · 试运行，不联网、不写入"}`);
console.log(`每个信源读 GET https://api.fxtwitter.com/2/profile/<handle>/statuses，再顺着 cursor.bottom 往回翻，翻到该账号自己的帖子早于 ${range.start} 为止；只收窗口内的帖子。`);
console.log(head.join("\t"));
for (const p of plans) {
  console.log([p.source.id, `@${p.handle}`, p.storedOctober, p.storedSpan, p.perDay.toFixed(2), p.newPosts,
    p.pages, p.requests, p.paidRequests, p.paidCost.toFixed(3)].join("\t"));
}
console.log(`合计\t\t${total.storedOctober}\t\t\t${total.newPosts}\t${total.pages}\t${total.requests}\t${total.paidRequests}\t${total.paidCost.toFixed(3)}`);
console.log(`* 付费是兜底：只有免费翻页没走到 ${range.start} 的信源才买 SocialData，这里是“每个信源都要兜底”的上限。`);
console.log(`  SocialData 预算 ${budgetRow[0] ? `${budgetRow[0].per_minute}/分、${budgetRow[0].per_hour}/时、${budgetRow[0].per_day}/天` : "未知"}：上限真要花完得跑几天，脚本自己按预算节流，熔断就停。`);
console.log(`  免费请求按每页 ${REQUESTS_PER_PAGE} 次算（含 404 重试）；每信源上限 ${MAX_PAGES_PER_SOURCE} 页 / ${MAX_REQUESTS_PER_SOURCE} 次，全程上限 ${MAX_REQUESTS_TOTAL} 次；付费兜底每信源最多 ${MAX_PAID_PAGES_PER_SOURCE} 页。`);
if (paused.length) console.log(`已暂停、本次不动：${paused.length} 个${skippedWanted.length ? `（含指定的 ${skippedWanted.join(", ")}）` : ""}。`);

if (!live) {
  console.log(`试运行到此为止：没有联网，没有写库。真的执行：${CONFIRM_ENV}=1 node --env-file=.env scripts/backfill-x-october.ts --live --confirm=${CONFIRM_TOKEN}`);
  await closeDb();
  process.exit(0);
}

// sources/x.ts keeps the FxTwitter → SocialData mapping private; this is the same mapping, so the
// backfilled rows carry exactly the identity, title, body and media normal collection would give
// them, and a re-read of an existing post is a revision rather than a second article.
function fxInstant(status: FxStatus): number | null {
  const ms = typeof status.created_timestamp === "number" ? status.created_timestamp * 1000 : Date.parse(status.created_at ?? "");
  return Number.isFinite(ms) ? ms : null;
}

function fxMedia(status: FxStatus): SdMedia[] {
  const all = Array.isArray(status.media?.all) ? status.media.all : [];
  return all.flatMap((m): SdMedia[] => {
    const type = m.type === "video" ? "video" : m.type === "gif" || m.type === "animated_gif" ? "animated_gif" : "photo";
    const url = type === "photo" ? m.url : (m.thumbnail_url ?? m.url);
    return url ? [{ type, media_url_https: url, original_info: { width: m.width, height: m.height } }] : [];
  });
}

function fxToTweet(status: FxStatus): SdTweet | null {
  const at = fxInstant(status);
  if (at === null) return null;
  const date = new Date(at).toISOString();
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
    quoted_status: status.quote ? fxToTweet(status.quote) : null,
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
function keeps(status: FxStatus, handle: string, selfThreads: boolean): boolean {
  if (status.reposted_by) return true;
  if (!status.replying_to) return true;
  return selfThreads && status.replying_to.screen_name?.toLowerCase() === handle.toLowerCase();
}

const inWindow = (at: number) => at >= WINDOW_START.getTime() && at < WINDOW_END.getTime();

type WalkEnd = "reached" | "exhausted" | "page-cap" | "request-cap" | "failed";

interface Walked {
  end: WalkEnd;
  error?: string;
  pages: number;
  requests: number;
  /** The oldest instant the walk proved coverage of: what the paid fallback still has to buy. */
  floor: number | null;
  candidates: Candidate[];
}

/** One page, waited out instead of given up: FxTwitter's 404 is usually transient, and a page lost
 * here is a hole in October that no later run notices. 204 is the only genuine "no content". */
async function readPage(handle: string, cursor: string | null, budget: FxRequestBudget): Promise<FxTimeline> {
  let lastError: unknown = new Error("fxtwitter: no attempt was made");
  for (const wait of PAGE_ROUNDS_MS) {
    if (wait) await sleep(wait);
    if (budget.remaining <= 0) break;
    try {
      return await fetchFxTimeline(handle, cursor, { requestBudget: budget });
    } catch (error) {
      lastError = error;
      if (budget.remaining <= 0) break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function walk(source: SourceRow, handle: string, allowance: number): Promise<Walked> {
  const budget: FxRequestBudget = { remaining: allowance };
  const spent = () => allowance - budget.remaining;
  const selfThreads = source.config.publisherRole === "organization" || source.config.publisherRole === "person";
  const kept = new Map<string, Candidate>();
  const stop = (end: WalkEnd, error?: string): Walked =>
    ({ end, error, pages, requests: spent(), floor, candidates: [...kept.values()] });
  let cursor: string | null = null;
  let pages = 0;
  let floor: number | null = null;
  for (;;) {
    if (budget.remaining <= 0) return stop("request-cap");
    if (pages >= MAX_PAGES_PER_SOURCE) return stop("page-cap");
    let timeline: FxTimeline;
    try {
      timeline = await readPage(handle, cursor, budget);
    } catch (error) {
      return stop("failed", message(error));
    }
    pages += 1;
    let crossed = false;
    for (const status of timeline.statuses) {
      const at = fxInstant(status);
      if (at === null) continue;
      // Reposts carry an old original's date, so only the account's own posts prove coverage.
      if (!status.reposted_by && status.author?.screen_name?.toLowerCase() === handle.toLowerCase()) {
        if (at < WINDOW_START.getTime()) crossed = true;
        if (floor === null || at < floor) floor = at;
      }
      if (!keeps(status, handle, selfThreads) || !inWindow(at)) continue;
      const tweet = fxToTweet(status);
      if (!tweet) continue;
      const candidate = tweetToCandidate(tweet);
      if (!kept.has(candidate.identityKey!)) kept.set(candidate.identityKey!, candidate);
    }
    if (crossed) return stop("reached");
    if (!timeline.cursor) return stop("exhausted");
    cursor = timeline.cursor;
    await sleep(PAGE_PACE_MS);
  }
}

interface Stored {
  found: number;
  created: number;
  revised: number;
  unchanged: number;
  queued: number;
}

/** Material through the one entrance every channel uses: identity `x:<tweet id>`, revisions, the
 * timeline rule. The backfill marker keeps it out of the daily report and the hot rankings. */
async function store(source: SourceRow, candidates: Candidate[]): Promise<Stored> {
  const result: Stored = { found: 0, created: 0, revised: 0, unchanged: 0, queued: 0 };
  for (const candidate of admitListing(candidates, source)) {
    result.found += 1;
    const raw = typeof candidate.raw === "object" && candidate.raw ? (candidate.raw as Record<string, unknown>) : {};
    const material = { ...candidate, sourceId: source.id, via: "fetch" as const, backfill: BACKFILL_REASON,
      raw: { ...raw, _aihot: { backfill: true, month: MONTH } } };
    let res;
    try {
      res = await upsertMaterial(material);
    } catch (error) {
      console.error(`  ${source.id}: ${candidate.identityKey} 写入失败：${message(error)}`);
      continue;
    }
    if (res.created) result.created += 1;
    else if (res.revised) result.revised += 1;
    else result.unchanged += 1;
    if (res.created || res.revised || res.processingNeeded) {
      await queueProcessing(res.articleId);
      result.queued += 1;
    }
  }
  return result;
}

/** SocialData's own window for a receipt identity, so a retry in the same half hour reuses the paid
 * answer instead of buying it again (sources/x.ts). */
const receiptWindow = () => new Date(Math.floor(Date.now() / 1_800_000) * 1_800_000).toISOString();

/** Spacing that can trip neither the minute nor the hour budget, and a run ceiling at the day's.
 * checkBudget counts every live attempt of the service, not just this run's, and rejects at the
 * ceiling rather than below it, so exact-limit pacing would sit on it: hence the margin. */
function paidPace(perMinute: number, perHour: number, perDay: number) {
  const state = { last: 0, sent: 0 };
  const spacing = Math.max((60_000 / perMinute) || 0, (3_600_000 / perHour) || 0) * PACE_MARGIN;
  return {
    spacing,
    sent: () => state.sent,
    async take(): Promise<void> {
      if (state.sent >= perDay) throw new BudgetExceededError("socialdata", "day", 3600);
      const wait = spacing - (Date.now() - state.last);
      if (wait > 0) await sleep(wait);
      state.last = Date.now();
      state.sent += 1;
    },
  };
}

/** An account the free walk left short, bought from SocialData: newest first, from the window's own
 * first instant, through the receipt and budget machinery and no further than the day's budget. */
async function paidFill(source: SourceRow, handle: string, pace: ReturnType<typeof paidPace>): Promise<{ pages: number; cost: number; end: "reached" | "page-cap" | "budget" | "failed"; error?: string }> {
  const base = selfThreadHandle(source)
    ? `from:${handle} (-filter:replies OR filter:self_threads)`
    : `from:${handle} -filter:replies`;
  const query = `${base} since_id:${xIdAt(WINDOW_START.getTime())}`;
  const window = receiptWindow();
  const receiptIds: number[] = [];
  const kept = new Map<string, Candidate>();
  let cursor: string | null = null;
  let pages = 0;
  let objects = 0;
  let end: "reached" | "page-cap" | "budget" | "failed" = "page-cap";
  let error: string | undefined;
  for (;;) {
    if (pages >= MAX_PAID_PAGES_PER_SOURCE) break;
    let res;
    try {
      await pace.take();
      res = await searchTweets(query, { purpose: "source_fetch", subject: `source:${source.id}:backfill-${MONTH}`, window, type: "Latest", cursor });
    } catch (caught) {
      end = caught instanceof BudgetExceededError ? "budget" : "failed";
      error = message(caught);
      // A page that fails after the first one leaves the pages already bought usable.
      break;
    }
    pages += 1;
    receiptIds.push(res.receiptId);
    objects += res.tweets.length;
    let crossed = false;
    for (const tweet of res.tweets) {
      if (tweet.retweeted_status) continue;
      const at = Date.parse(tweet.tweet_created_at);
      if (!Number.isFinite(at)) continue;
      if (at < WINDOW_START.getTime()) crossed = true;
      if (!inWindow(at)) continue;
      const candidate = tweetToCandidate(tweet);
      if (!kept.has(candidate.identityKey!)) kept.set(candidate.identityKey!, candidate);
    }
    if (crossed) { end = "reached"; break; }
    if (!res.nextCursor || res.tweets.length === 0) { end = "reached"; break; }
    cursor = res.nextCursor;
  }
  const written = await store(source, [...kept.values()]);
  // The paid answer's business effect commits before its receipt completes, as in collection.
  await sql.begin(async (tx) => {
    for (const receiptId of receiptIds) await completeReceipt(tx, receiptId);
  });
  console.log(`  ${source.id}: 付费兜底 ${pages} 页 / ${objects} 条 ≈ $${(objects * USD_PER_OBJECT).toFixed(3)}，写入 ${written.created} 新 ${written.revised} 改，${end}${error ? `（${error}）` : ""}`);
  return { pages, cost: objects * USD_PER_OBJECT, end, error };
}

const limits = budgetRow[0];
const pace = limits && limits.per_minute > 0 && limits.per_hour > 0 && limits.per_day > 0
  ? paidPace(limits.per_minute, limits.per_hour, limits.per_day)
  : null;

console.log(`\n开始抓取（写库）。免费翻页每页间隔 ${PAGE_PACE_MS}ms${pace ? `；付费兜底每 ${Math.round(pace.spacing / 1000)}s 一次，本次最多 ${limits!.per_day} 次` : "；SocialData 预算为 0，付费兜底不可用"}。`);

const run = { requests: 0, pages: 0, created: 0, revised: 0, unchanged: 0, queued: 0 };
const short: Array<{ plan: Plan; walk: Walked }> = [];
for (const plan of plans) {
  const allowance = Math.min(MAX_REQUESTS_PER_SOURCE, MAX_REQUESTS_TOTAL - run.requests);
  if (allowance <= 0) {
    console.log(`${plan.source.id}: 全程免费请求上限 ${MAX_REQUESTS_TOTAL} 用完，剩下的信源没读。`);
    short.push({ plan, walk: { end: "request-cap", pages: 0, requests: 0, floor: null, candidates: [] } });
    continue;
  }
  const walked = await walk(plan.source, plan.handle, allowance);
  run.requests += walked.requests;
  run.pages += walked.pages;
  const written = await store(plan.source, walked.candidates);
  run.created += written.created;
  run.revised += written.revised;
  run.unchanged += written.unchanged;
  run.queued += written.queued;
  const covered = walked.end === "reached" || walked.end === "exhausted";
  console.log(`${plan.source.id} @${plan.handle}: ${walked.pages} 页 / ${walked.requests} 次，读到 ${walked.candidates.length} 条，写入 ${written.created} 新 ${written.revised} 改 ${written.unchanged} 旧，${covered ? "覆盖到窗口起点" : `${walked.end}${walked.error ? `（${walked.error}）` : ""}`}`);
  if (!covered) short.push({ plan, walk: walked });
}

let paid = { requests: 0, cost: 0 };
if (short.length && !pace) console.log(`\n${short.length} 个信源没走到窗口起点，但 SocialData 预算为 0，买不了兜底：${short.map((s) => s.plan.source.id).join(", ")}`);
for (const item of short) {
  if (!pace) break;
  if (pace.sent() >= (limits?.per_day ?? 0)) {
    console.log(`\nSocialData 当日预算用完，剩下的 ${short.length} 个信源留给下一次运行。`);
    break;
  }
  console.log(`\n${item.plan.source.id}: 免费翻页停在 ${item.walk.floor ? new Date(item.walk.floor).toISOString() : "第一页"}，改用付费搜索。`);
  try {
    const res = await paidFill(item.plan.source, item.plan.handle, pace);
    paid = { requests: paid.requests + res.pages, cost: paid.cost + res.cost };
    if (res.end === "budget") {
      console.log("SocialData 预算熔断，停止付费兜底。");
      break;
    }
  } catch (error) {
    if (error instanceof BudgetExceededError) {
      console.log("SocialData 预算熔断，停止付费兜底。");
      break;
    }
    console.error(`${item.plan.source.id}: 付费兜底失败：${message(error)}`);
  }
}

console.log(`\n完成：${run.pages} 页 / ${run.requests} 次免费请求，写入 ${run.created} 新 ${run.revised} 改（${run.unchanged} 条已存在、内容没变），排队 ${run.queued} 篇；付费 ${paid.requests} 次 ≈ $${paid.cost.toFixed(3)}。`);
console.log(`没走到 ${range.start} 的信源：${short.length} 个${short.length ? `（${short.map((s) => s.plan.source.id).join(", ")}）` : ""}。`);
console.log("worker 是停着的：这些素材只是排进了队列，等它启动后按新的评分标准分析。");
await stopBoss();
await closeDb();
