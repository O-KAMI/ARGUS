// The asset a post is about, as a deterministic key. Five people recommending the same repository write
// five posts with five different URLs and five different "occurrences", so neither the URL identity nor
// the same-occurrence judgement merges them; an exact key does, and it also reaches past the 14-day
// semantic recall window. Pure parsing on purpose: it runs at ingest and must never cost a model call.
import { normalizeUrl } from "./url.ts";

// 候选链接先整体取出再解析主机：正则在文本里截子串会把 notgithub.com 里的 github.com 当成主机，
// 也会把 HF 的 datasets/<机构>/<资源> 截成两段、让同机构的两个 dataset 撞成一个键。
// 左侧边界排除主机名字符，右侧停在空白与常见包裹标点；中文可以直接贴着链接写。
const CANDIDATE = /(?<![\w@.-])(?:https?:\/\/)?(?:www\.)?(?:github\.com|huggingface\.co|npmjs\.com|pypi\.org)\/[^\s<>"'`)\]}，。；]+/gi;
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
 * The key of a parsed candidate URL, or null when its path names no resource. Host and resource path
 * are matched exactly; Hugging Face models, datasets and spaces stay distinct (`hf:owner/model`,
 * `hf:datasets/owner/name`, `hf:spaces/owner/name`).
 */
function siteKey(raw: string): string | null {
  let u: URL;
  try { u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return null; }
  const host = u.hostname.toLowerCase();
  const segments = u.pathname.split("/").filter(Boolean);
  // 资源名取段首的合法字符：中文可以直接贴在链接后面（“repo很好用”），百分号编码同理。
  const name = (i: number) => /^[\w.-]+/.exec(segments[i] ?? "")?.[0].toLowerCase() ?? null;
  if (host === "github.com" || host === "www.github.com") {
    const owner = name(0), repo = name(1);
    return owner && repo ? `gh:${owner}/${repo}` : null;
  }
  if (host === "huggingface.co") {
    const kind = segments[0] === "datasets" || segments[0] === "spaces" ? segments[0] : null;
    const owner = name(kind ? 1 : 0), resource = name(kind ? 2 : 1);
    return owner && resource ? `hf:${kind ? `${kind}/` : ""}${owner}/${resource}` : null;
  }
  if ((host === "npmjs.com" || host === "www.npmjs.com") && segments[0] === "package") {
    const scoped = segments[1]?.startsWith("@");
    const scope = scoped ? /^@([\w.-]+)/.exec(segments[1]!)?.[1]?.toLowerCase() ?? null : null;
    const pkg = name(scoped ? 2 : 1);
    return pkg && (!scoped || scope) ? `npm:${scoped ? `@${scope}/` : ""}${pkg}` : null;
  }
  if (host === "pypi.org" && segments[0] === "project") {
    const pkg = name(1);
    return pkg ? `pypi:${pkg}` : null;
  }
  return null;
}

/**
 * `gh:owner/repo`, `hf:[datasets|spaces/]owner/repo`, `npm:<pkg>`, `pypi:<pkg>` or `url:<normalized>`;
 * null when the text names no asset. `ownUrl` is the material's own permalink: a page linking to itself
 * says nothing about which asset it recommends, and treating it as one would merge every report of that
 * page together.
 */
export function assetKey(text: string | null | undefined, ownUrl?: string | null): string | null {
  if (!text) return null;
  for (const match of text.matchAll(CANDIDATE)) {
    const key = siteKey(strip(match[0]));
    if (key) return key;
  }
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
