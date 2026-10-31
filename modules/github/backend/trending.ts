// GitHub Trending Weekly. GitHub publishes no API for it, so the page's own HTML is read (方案 2.1, 13 节):
// the cards are found through the repository link in a card heading rather than one CSS class, the page's
// order becomes source_rank and is never re-sorted by stars, and an unusable page fails the run so the
// previous board stays up.
import * as cheerio from "cheerio";
import { guardedFetch, requireOk } from "@aihot/backend/lib/http-fetch";
import { githubConfig } from "./config.ts";

/** One card on the trending page, in the page's own order. */
export interface TrendingItem {
  /** The card's position on the page, 1-based: the weekly boards' only ranking input. */
  sourceRank: number;
  fullName: string;
  ownerLogin: string;
  name: string;
  htmlUrl: string;
  description: string | null;
  language: string | null;
  stargazersCount: number;
  forksCount: number | null;
}

export interface TrendingPage {
  items: TrendingItem[];
  sourceUrl: string;
  fetchedAt: Date;
  /** Checks that passed but look wrong, recorded with the run instead of failing it (方案 2.1 解析注意事项). */
  warnings: string[];
}

/** A page that no longer holds a usable trending list: its shape changed, or GitHub answered a challenge. */
export class TrendingParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrendingParseError";
  }
}

/** Fewer cards than this means the page is not the trending list any more; the previous board is kept. */
const MIN_CARDS = 5;

/** "12,345", "1.2k" and the like, from the star and fork counts the page prints beside their links. */
function count(text: string): number | null {
  const m = /(\d[\d,]*(?:\.\d+)?)\s*([kKmM])?/.exec(text);
  if (!m) return null;
  const base = Number(m[1]!.replace(/,/g, ""));
  if (!Number.isFinite(base)) return null;
  const unit = m[2]?.toLowerCase();
  return Math.round(base * (unit === "k" ? 1e3 : unit === "m" ? 1e6 : 1));
}

const clean = (value: string) => value.replace(/\s+/g, " ").trim();

/** The "/owner/repo" of a repository link, or null for any other link in a card heading. */
function repositoryOf(href: string | undefined): { ownerLogin: string; name: string; fullName: string } | null {
  if (!href) return null;
  const m = /^\/([^/?#\s]+)\/([^/?#\s]+)\/?$/.exec(href);
  if (!m) return null;
  let ownerLogin: string;
  let name: string;
  try {
    ownerLogin = decodeURIComponent(m[1]!);
    name = decodeURIComponent(m[2]!);
  } catch {
    return null;
  }
  // The trending page's own chrome uses two-part paths too (sponsors, collections); those have no card.
  if (ownerLogin.toLowerCase() === name.toLowerCase()) return null;
  return { ownerLogin, name, fullName: `${ownerLogin}/${name}` };
}

/**
 * The cards of a trending page, in the order the HTML gives them. A card is an <article> (GitHub's Box-row)
 * when there is one, else the heading's own container, so a class rename does not empty the board.
 */
export function parseTrending(html: string, sourceUrl: string, fetchedAt: Date): TrendingPage {
  const $ = cheerio.load(html);
  const warnings: string[] = [];
  const items: TrendingItem[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  $("h2 a[href]").each((_, element) => {
    const link = $(element);
    const found = repositoryOf(link.attr("href"));
    if (!found) return;
    const key = found.fullName.toLowerCase();
    if (seen.has(key)) {
      warnings.push(`duplicate repository card ${found.fullName} kept once`);
      return;
    }
    const card = link.closest("article").first();
    // GitHub has renamed the card class before; without an <article> the heading's own block still holds
    // the description, the language and the two count links.
    const listItem = link.closest("li").first();
    const scope = card.length ? card : listItem.length ? listItem : link.parent().parent();
    const stars = count(clean(scope.find('a[href$="/stargazers"]').first().text()));
    const description = clean(scope.find("p").first().text()) || null;
    const language = clean(scope.find('[itemprop="programmingLanguage"]').first().text()) || null;
    if (stars === null && !description && !language) {
      skipped++;
      return;
    }
    seen.add(key);
    items.push({
      sourceRank: items.length + 1,
      fullName: found.fullName,
      ownerLogin: found.ownerLogin,
      name: found.name,
      htmlUrl: new URL(`/${found.ownerLogin}/${found.name}`, "https://github.com").toString(),
      description,
      language,
      stargazersCount: stars ?? 0,
      forksCount: count(clean(scope.find('a[href$="/forks"]').first().text())),
    });
  });
  if (items.length === 0) throw new TrendingParseError(`no repository card parsed from ${sourceUrl}; the page shape changed or GitHub served a challenge, the previous board is kept`);
  if (items.length < MIN_CARDS) warnings.push(`only ${items.length} repository cards, fewer than the usual ${MIN_CARDS}+`);
  if (skipped > 0) warnings.push(`${skipped} heading link(s) carried no card and were left out`);
  return { items, sourceUrl, fetchedAt, warnings };
}

/** Reads the weekly trending page. Throws when GitHub does not answer 200 or the list cannot be parsed. */
export async function fetchTrendingWeekly(url = githubConfig.trendingWeeklyUrl): Promise<TrendingPage> {
  const fetchedAt = new Date();
  const res = await guardedFetch(url, {
    headers: { accept: "text/html,application/xhtml+xml", "user-agent": "ARGUS-github-rankings" },
    timeoutMs: githubConfig.timeoutMs,
    maxBytes: 8 * 1024 * 1024,
    redirectPolicy: "same-origin",
  });
  requireOk(res, `GitHub trending weekly (${url})`);
  return parseTrending(res.text(), res.url, fetchedAt);
}
