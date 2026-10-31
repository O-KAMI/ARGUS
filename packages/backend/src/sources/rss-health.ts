// Daily RSS liveness probe. A feed that stops parsing or returns an error is looked up again on its own
// site; a valid replacement is written back and fetched by the normal scheduler. When no replacement
// exists the source is reported. Account fallbacks live in the X collector (FxTwitter → RSS → SocialData).
import { audit } from "../audit.ts";
import { sql } from "../db.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { sendAlert } from "../notify/feishu.ts";
import { unsupportedConfig } from "./config-keys.ts";
import { fetchRss } from "./rss.ts";
import type { SourceRow } from "./types.ts";

const COMMON_FEED_PATHS = ["/feed", "/feed.xml", "/rss.xml", "/rss", "/atom.xml", "/index.xml", "/feed/", "/blog/feed", "/blog/rss.xml", "/posts.atom", "/en/feed"];

interface SourceProbeRow {
  id: string;
  name: string;
  config: Record<string, unknown>;
  tier: string;
  participation_mode: "editorial" | "hot_signal" | "isolated";
  first_party: boolean;
  interval_minutes: number;
  enabled: boolean;
  cursor: Record<string, unknown> | null;
  fail_count: number;
  updated_at: Date;
  health: string;
}

export interface RssProbeResult {
  id: string;
  name: string;
  status: "ok" | "empty" | "replaced" | "failed" | "unreachable";
  items?: number;
  feedUrl: string;
  replacement?: string;
  error?: string;
}

function sourceRow(row: SourceProbeRow): SourceRow {
  return {
    id: row.id,
    name: row.name,
    kind: "rss",
    config: row.config,
    tier: row.tier,
    participation_mode: row.participation_mode,
    first_party: row.first_party,
    interval_minutes: row.interval_minutes,
    enabled: row.enabled,
    cursor: row.cursor,
    fail_count: row.fail_count,
  };
}

function sameUrl(a: string, b: string): boolean {
  const norm = (value: string) => value.replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

function feedLinks(html: string, base: string): string[] {
  const out: string[] = [];
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const rel = /\brel\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase() ?? "";
    const type = /\btype\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase() ?? "";
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href || !rel.includes("alternate") || !/application\/(rss|atom)\+xml/.test(type)) continue;
    try {
      const url = new URL(href, base);
      if (/^https?:$/.test(url.protocol)) out.push(url.href);
    } catch {
      // A malformed href is ignored, like any other unusable candidate.
    }
  }
  return [...new Set(out)];
}

/** Pages that may link the site's current feed: the origin, the feed's parent path, and the usual host variants. */
function homeCandidates(feedUrl: string): string[] {
  let url: URL;
  try { url = new URL(feedUrl); } catch { return []; }
  const out = new Set<string>([url.origin]);
  const path = url.pathname.replace(/\/+$/, "");
  if (/\/(?:feed|rss|atom|index|posts)(?:\.(?:xml|atom))?$/i.test(path)) {
    const parent = path.replace(/\/[^/]+$/, "");
    if (parent) out.add(`${url.origin}${parent}/`);
  }
  if (url.hostname.startsWith("s.")) out.add(`${url.protocol}//${url.hostname.slice(2)}/`);
  if (url.hostname.startsWith("www.")) out.add(`${url.protocol}//${url.hostname.slice(4)}/`);
  else out.add(`${url.protocol}//www.${url.hostname}/`);
  return [...out];
}

async function readHome(url: string): Promise<{ url: string; html: string } | null> {
  try {
    const res = await guardedFetch(url, {
      route: "egress",
      timeoutMs: 25_000,
      maxBytes: 4 * 1024 * 1024,
      headers: { accept: "text/html,application/xhtml+xml" },
    });
    if (res.status < 200 || res.status >= 300) return null;
    const type = res.headers.get("content-type") ?? "";
    if (type && !/text\/html|application\/xhtml\+xml/i.test(type)) return null;
    return { url: res.url, html: res.text() };
  } catch {
    return null;
  }
}

async function validFeed(source: SourceRow, feedUrl: string): Promise<boolean> {
  const probe: SourceRow = {
    ...source,
    // The feed itself, without the source's date/category filters: a valid feed must not be rejected
    // because its current entries fall outside this source's publication window.
    config: { feedUrl },
    cursor: null,
  };
  try {
    const read = await fetchRss(probe, { force: true });
    return read.candidates.length > 0;
  } catch {
    return false;
  }
}

/** Finds a working feed on the same site as a dead one; null when the site has none. */
export async function discoverFeed(source: SourceRow, deadFeedUrl: string): Promise<string | null> {
  for (const home of homeCandidates(deadFeedUrl)) {
    const page = await readHome(home);
    if (!page) continue;
    const linked = feedLinks(page.html, page.url).filter((u) => !sameUrl(u, deadFeedUrl));
    for (const candidate of linked) {
      if (await validFeed(source, candidate)) return candidate;
    }
    for (const path of COMMON_FEED_PATHS) {
      let candidate: string;
      try { candidate = new URL(path, page.url).href; } catch { continue; }
      if (sameUrl(candidate, deadFeedUrl)) continue;
      if (await validFeed(source, candidate)) return candidate;
    }
  }
  return null;
}

/** A document that is not a feed (HTML, a 404, an XML parse failure) is dead; a network/TLS failure may
 * pass on the next run and must not cause a feed swap. */
function isDeadFeed(error: unknown): boolean {
  const message = String(error);
  if (/not an RSS\/Atom document|feed parse error/i.test(message)) return true;
  const status = /HTTP (\d{3})/.exec(message);
  return status !== null && [404, 410].includes(Number(status[1]));
}

/** A transient network error gets one quiet retry; malformed documents do not. */
async function readFeed(source: SourceRow) {
  try {
    return await fetchRss(source, { force: true });
  } catch (error) {
    if (isDeadFeed(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    return fetchRss(source, { force: true });
  }
}

async function probeOne(row: SourceProbeRow): Promise<RssProbeResult> {
  const source = sourceRow(row);
  const feedUrl = String(row.config.feedUrl ?? "");
  try {
    const read = await readFeed(source);
    if (read.candidates.length > 0) return { id: row.id, name: row.name, status: "ok", items: read.candidates.length, feedUrl };
    return { id: row.id, name: row.name, status: "empty", items: 0, feedUrl };
  } catch (error) {
    const detail = String(error).slice(0, 300);
    if (!isDeadFeed(error)) {
      return { id: row.id, name: row.name, status: "unreachable", feedUrl, error: detail };
    }
    const replacement = await discoverFeed(source, feedUrl);
    if (replacement) {
      try {
        await sql.begin(async (tx) => {
          const [before] = await tx<{ config: Record<string, unknown> }[]>`
            SELECT config FROM sources WHERE id = ${row.id} FOR UPDATE`;
          if (!before) throw new Error("source disappeared");
          const config = { ...before.config, feedUrl: replacement };
          const refused = unsupportedConfig("rss", config);
          if (refused.length) throw new Error(`新 feed 地址不被接受：${refused.join("、")}`);
          // An enabled collector reads it on its next minute; a paused one stays paused until its X
          // source needs the fallback, so it must not be woken here.
          await tx`UPDATE sources SET config = ${tx.json(config as never)},
            next_fetch_at = CASE WHEN enabled THEN now() ELSE next_fetch_at END,
            health = CASE WHEN enabled THEN 'unknown' ELSE health END,
            fail_count = CASE WHEN enabled THEN 0 ELSE fail_count END,
            last_error = NULL, updated_at = now() WHERE id = ${row.id}`;
          await audit("rss-health", "source.update", `source:${row.id}`, `RSS 探活失败，切换到同站 feed：${detail}`,
            { config: before.config }, { config }, { db: tx });
        });
        return { id: row.id, name: row.name, status: "replaced", feedUrl, replacement };
      } catch (updateError) {
        return { id: row.id, name: row.name, status: "failed", feedUrl, replacement, error: `${detail}；替换失败：${String(updateError).slice(0, 200)}` };
      }
    }
    return { id: row.id, name: row.name, status: "failed", feedUrl, error: detail };
  }
}

export interface RssProbeSummary {
  at: string;
  checked: number;
  ok: number;
  empty: number;
  replaced: number;
  failed: number;
  unreachable: number;
  results: RssProbeResult[];
}

/**
 * Probes every RSS source once; used by the daily worker schedule and the manual script. Paused
 * sources are the X collector's second layer: they are checked and may have their address replaced,
 * but the probe never enables them or queues a fetch.
 */
export async function probeRssSources(): Promise<RssProbeSummary> {
  const rows = await sql<SourceProbeRow[]>`
    SELECT id, name, config, tier, participation_mode, first_party, interval_minutes, enabled, cursor, fail_count, updated_at, health
    FROM sources WHERE kind = 'rss' ORDER BY id`;
  const results: RssProbeResult[] = [];
  let next = 0;
  // Four at a time: enough to finish a dead feed's discovery quickly without hammering the sites.
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < rows.length) {
      const row = rows[next++]!;
      results.push(await probeOne(row));
    }
  }));
  results.sort((a, b) => a.id.localeCompare(b.id));

  const summary: RssProbeSummary = {
    at: new Date().toISOString(),
    checked: results.length,
    ok: results.filter((r) => r.status === "ok").length,
    empty: results.filter((r) => r.status === "empty").length,
    replaced: results.filter((r) => r.status === "replaced").length,
    failed: results.filter((r) => r.status === "failed").length,
    unreachable: results.filter((r) => r.status === "unreachable").length,
    results,
  };
  await sql`INSERT INTO settings (key, value, updated_by) VALUES ('rss.health.last', ${sql.json(summary as never)}, 'rss-health')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`;
  const failed = results.filter((r) => r.status === "failed");
  const unreachable = results.filter((r) => r.status === "unreachable");
  if (failed.length || unreachable.length) {
    const lines = [
      `${summary.checked} 个 RSS 源，${summary.replaced} 个已换新地址，${failed.length} 个失效，${unreachable.length} 个本次网络不可达（原地址保留，下一轮重试）。`,
      ...failed.map((r) => `失效：${r.name}（${r.id}）：${r.error ?? "无法读取"}`),
      ...unreachable.map((r) => `不可达：${r.name}（${r.id}）：${r.error ?? "连接失败"}`),
    ];
    await sendAlert("📡 RSS 每日探活", lines);
  }
  return summary;
}
