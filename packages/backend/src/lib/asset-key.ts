// The asset a post is about, as a deterministic key. Five people recommending the same repository write
// five posts with five different URLs and five different "occurrences", so neither the URL identity nor
// the same-occurrence judgement merges them; an exact key does, and it also reaches past the 14-day
// semantic recall window. Pure regex on purpose: it runs at ingest and must never cost a model call.
import { normalizeUrl } from "./url.ts";

const GITHUB = /(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)/i;
const HUGGINGFACE = /(?:https?:\/\/)?huggingface\.co\/([\w.-]+)\/([\w.-]+)/i;
const NPM = /(?:https?:\/\/)?(?:www\.)?npmjs\.com\/package\/((?:@[\w.-]+\/)?[\w.-]+)/i;
const PYPI = /(?:https?:\/\/)?pypi\.org\/project\/([\w.-]+)/i;
const ANY_URL = /https?:\/\/[^\s<>"'`)\]}，。；]+/g;

// A post's own permalink, a quoted tweet or a video page says nothing about which asset it recommends.
// Matched at a dot boundary with the TLD allowed for, so `mobile.twitter.com` is out but `next.com` is not.
const NOT_AN_ASSET = /(?:^|\.)(?:x|twitter|fxtwitter|fixupx|fixvx|vxtwitter|nitter|t|twimg|youtube|youtu|bilibili|weibo|zhihu|threads|linkedin|instagram|xiaohongshu|xhs)(?:\.[a-z]{2,3})?$/i;

const strip = (value: string) => value.replace(/^[^A-Za-z0-9@]+/, "").replace(/[)\].,;:!?'"]+$/, "");

/** The namespaces assetKey returns. A request guard reads this, so adding one cannot silently 404 at the API. */
const NAMESPACE = /^(?:gh|hf|npm|pypi|url):/u;

/** Whether a string could be one of assetKey's keys (a guard, not a parser). */
export function isAssetKey(value: string): boolean {
  return value.length <= 300 && NAMESPACE.test(value) && !/[\u0000-\u0020]/u.test(value);
}

/**
 * `gh:owner/repo`, `hf:owner/repo`, `npm:<pkg>`, `pypi:<pkg>` or `url:<normalized>`; null when the text
 * names no asset. `ownUrl` is the material's own permalink: a page linking to itself says nothing about
 * which asset it recommends, and treating it as one would merge every report of that page together.
 */
export function assetKey(text: string | null | undefined, ownUrl?: string | null): string | null {
  if (!text) return null;
  const gh = GITHUB.exec(text);
  if (gh) return `gh:${strip(gh[1]!).toLowerCase()}/${strip(gh[2]!).toLowerCase()}`;
  const hf = HUGGINGFACE.exec(text);
  if (hf) return `hf:${strip(hf[1]!).toLowerCase()}/${strip(hf[2]!).toLowerCase()}`;
  const npm = NPM.exec(text);
  if (npm) return `npm:${strip(npm[1]!).toLowerCase()}`;
  const pypi = PYPI.exec(text);
  if (pypi) return `pypi:${strip(pypi[1]!).toLowerCase()}`;
  const own = ownUrl ? normalizeUrl(ownUrl) : null;
  for (const match of text.match(ANY_URL) ?? []) {
    const url = strip(match);
    let host: string;
    try { host = new URL(url).hostname.toLowerCase(); } catch { continue; }
    if (NOT_AN_ASSET.test(host)) continue;
    const normalized = normalizeUrl(url);
    if (!normalized || normalized === own) continue;
    return `url:${normalized}`;
  }
  return null;
}
