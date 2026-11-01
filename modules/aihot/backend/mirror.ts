// What a mirrored item becomes in this site's own storage: material through the engine's single entrance,
// a rule judgement that copies upstream's Chinese copy and its own selected flag, and the publication the
// public read layer already serves. No model call and no receipt is involved, so the mirror costs no
// budget and a page that reads it triggers no fetch. Reading upstream is upstream.ts, the pass that runs
// this is pass.ts, and the sockets that schedule the pass are server.ts.
import { sql, type Db, type Tx } from "@aihot/backend/db";
import { stableJson } from "@aihot/backend/lib/ids";
import { normalizeUrl } from "@aihot/backend/lib/url";
import { upsertMaterial, updatePresentation, type MediaItem } from "@aihot/backend/content/materials";
import { publishArticleTx, retireArticle } from "@aihot/backend/publication/publish";
import { TRACKS } from "@aihot/industry/selection";
import { isCategoryKey, type CategoryKey, type GenreTag } from "@aihot/contracts/taxonomy";
import { MIRROR_LABEL, MIRROR_SOURCE_ID, MIRROR_WINDOW_DAYS } from "./config.ts";
import { POLICY_HEADERS, SELECTED_WINDOW, UPSTREAM_TERMS, upstreamDate, type UpstreamItem } from "./upstream.ts";
import type { RankingExtra } from "./snapshot.ts";

/** How the mirrored material reached this site (articles.article_discoveries.via). */
const VIA = "aihot";

/** The window an item is kept for, from the moment this site first mirrored it. */
export const MIRROR_WINDOW_MS = MIRROR_WINDOW_DAYS * 86_400_000;

/** Upstream's categories are this industry's; the genre tag is what the pool's 内容类型 filter reads. */
const GENRE_OF_CATEGORY: Partial<Record<CategoryKey, GenreTag>> = {
  "ai-models": "模型发布",
  "ai-products": "产品更新",
  industry: "行业动态",
  paper: "论文/研究",
  tip: "教程/实践",
  opinion: "大佬观点",
};

/** The genre tag a mirrored category carries; a category this industry lacks leaves the item untagged. */
export function genreOfCategory(value: unknown): string | null {
  return isCategoryKey(value) ? (GENRE_OF_CATEGORY[value] ?? null) : null;
}

/**
 * The mirror's own source, created on first use. An administrator's pause is kept: `enabled` is written
 * only by the row's own creation, and a paused mirror stays paused until it is resumed in the admin.
 */
export async function ensureMirrorSource(db: Db = sql): Promise<{ enabled: boolean }> {
  const [row] = await db<{ enabled: boolean }[]>`
    INSERT INTO sources (id, name, kind, config, tags, tier, participation_mode, interval_minutes, site_fulltext, syndicate_fulltext, enabled, health)
    VALUES (${MIRROR_SOURCE_ID}, ${MIRROR_LABEL}, 'external', '{}'::jsonb, ${[TRACKS.inherit]}, 'T2', 'editorial', 1440, false, false, true, 'unknown')
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind, tags = EXCLUDED.tags,
      tier = EXCLUDED.tier, participation_mode = EXCLUDED.participation_mode, updated_at = now()
    RETURNING enabled`;
  return { enabled: row?.enabled ?? false };
}

/** The ranking's cover as this site stores media: the publisher's own address, which the proxy signs again. */
function coverMedia(ranking: RankingExtra | null): MediaItem[] | undefined {
  const url = ranking?.cover?.url;
  if (!url) return undefined;
  return [{ kind: "image", url, width: ranking!.cover!.width, height: ranking!.cover!.height }];
}

/**
 * What a mirrored article keeps about where it came from: upstream's own id and addresses, the
 * attribution its terms ask a reader to retain, the licence terms this reader states about itself, and
 * the place the item held in upstream's ranking when it was mirrored. Readers see none of it: a page
 * names the publisher (the material's author) and links the original, and the upstream's own name and
 * mark stay off the site (AGENTS.md).
 */
function provenance(item: UpstreamItem, ranking: RankingExtra | null): Record<string, unknown> {
  return {
    externalId: item.id,
    mirror: {
      upstream: { item: item.links.aihot, story: ranking?.storyPublicId ?? null, window: SELECTED_WINDOW, discoveredAt: item.discoveredAt ?? null },
      attribution: item.attribution ?? null,
      publisher: item.source?.name ?? null,
      policy: { commercialUse: POLICY_HEADERS["x-aihot-commercial-use"], version: POLICY_HEADERS["x-aihot-policy-version"], terms: UPSTREAM_TERMS },
      ...(ranking ? { ranking: { rank: ranking.rank, heat: ranking.heat, participantCount: ranking.participantCount } } : {}),
    },
  };
}

/**
 * The mirrored judgement: upstream already decided, in Chinese, so this site copies the decision instead
 * of paying for its own. `origin='rule'` keeps it out of every model statistic, `relevance='pass'` and the
 * copied title and summary make the item pool eligible, and `selected` is upstream's own flag.
 */
async function writeJudgement(tx: Tx, articleId: string, revision: number, item: UpstreamItem): Promise<void> {
  const [exists] = await tx<{ id: number }[]>`
    SELECT id FROM analyses WHERE article_id = ${articleId} AND input_revision = ${revision} AND origin = 'rule' LIMIT 1`;
  if (exists) return;
  const category = isCategoryKey(item.category) ? item.category : null;
  const genre = genreOfCategory(item.category);
  const reason = (item.reason ?? "").trim();
  await tx`
    INSERT INTO analyses (article_id, input_revision, origin, relevance, category, tags, subjects,
      title_zh, summary_zh, reason_zh, score, selected, output)
    VALUES (${articleId}, ${revision}, 'rule', 'pass', ${category}, ${genre ? [genre] : []}, ${[]},
      ${item.title.trim()}, ${(item.summary ?? "").trim()}, ${reason || null},
      ${typeof item.score === "number" && Number.isFinite(item.score) ? item.score : null}, ${item.selected === true},
      ${tx.json({ mirror: { upstreamId: item.id, window: SELECTED_WINDOW } } as never)})`;
}

export type StoreResult =
  | { stored: true; articleId: string; created: boolean; revised: boolean; selected: boolean; cover: boolean }
  | { stored: false; reason: string };

/**
 * One mirrored item, in one transaction: its material, the rule judgement of the revision that material
 * has, the processing state that keeps the engine's paid sweeps away from it, and its publication. The
 * transaction is the whole reason a mirrored article can never reach a model: a revision resets
 * processing_state, and a crash between the two writes would hand it to the analysis sweep.
 */
export async function storeItem(item: UpstreamItem, ranking: RankingExtra | null, now = new Date()): Promise<StoreResult> {
  const title = typeof item?.title === "string" ? item.title.trim() : "";
  // Upstream's own headline is the material's title and its Chinese rewrite the displayed one, so a card
  // shows the rewrite and the page still names the headline the publisher wrote (publish.ts).
  const headline = typeof item?.originalTitle === "string" && item.originalTitle.trim() ? item.originalTitle.trim() : title;
  const summary = typeof item?.summary === "string" ? item.summary.trim() : "";
  const url = normalizeUrl(typeof item?.links?.original === "string" ? item.links.original : "");
  if (!title || !headline) return { stored: false, reason: "no title" };
  // Nothing to show without Chinese copy: the pool admits an item only with a title and a summary.
  if (!summary) return { stored: false, reason: "no summary" };
  if (!url) return { stored: false, reason: "no original link" };
  const media = coverMedia(ranking);
  return sql.begin(async (tx) => {
    const material = await upsertMaterial({
      sourceId: MIRROR_SOURCE_ID, url, title: headline, author: item.source?.name ?? null, language: "zh",
      publishedAt: upstreamDate(item.publishedAt), publicationTime: item.publishedAt ?? null, discoveredAt: now,
      bodyStatus: "none", media, raw: provenance(item, ranking), via: VIA,
    }, tx);
    const [article] = await tx<{ revision: number; source_id: string; media: MediaItem[] }[]>`
      SELECT revision, source_id, media FROM articles WHERE id = ${material.articleId}`;
    // The same address collected by a source of this site belongs to that source: its own judgement stays.
    if (!article || article.source_id !== MIRROR_SOURCE_ID) return { stored: false, reason: "another source owns the material" };
    if (material.created || material.revised) await writeJudgement(tx, material.articleId, article.revision, item);
    // A mirrored article is judged and settled: the analysis sweep must not find it new and the grouping
    // sweep must not find it pending, or the engine would pay for a decision upstream already made.
    await tx`
      UPDATE articles SET processing_state = 'analyzed', processing_error = NULL, processing_retry_at = NULL,
        processing_queued_at = NULL, grouping_status = 'complete', grouped_at = coalesce(grouped_at, ${now})
      WHERE id = ${material.articleId} AND (processing_state <> 'analyzed' OR grouping_status <> 'complete')`;
    // A cover upstream's ranking gained after the item was stored is presentation: it keeps the judgement.
    if (!material.created && !material.revised && media && stableJson(media) !== stableJson(article.media)) {
      await updatePresentation(tx, material.articleId, { media });
    }
    // Released, as an explicit import is: already public upstream, so no push and no seat waiting.
    const published = await publishArticleTx(tx, material.articleId, { releasedAt: now });
    return {
      stored: true as const, articleId: material.articleId, created: material.created, revised: material.revised,
      selected: published?.selected ?? false, cover: !!media,
    };
  });
}

/** What one pass did with the items of the window it read. */
export interface MirrorPass {
  /** Items upstream's window held. */
  read: number;
  stored: number;
  created: number;
  revised: number;
  selected: number;
  /** Mirrored items that carry a cover from upstream's ranking. */
  covers: number;
  skipped: number;
}

export const emptyPass = (): MirrorPass => ({ read: 0, stored: 0, created: 0, revised: 0, selected: 0, covers: 0, skipped: 0 });

/** The items of a window already read, stored one by one. A failure of one item leaves the rest. */
export async function storeItems(items: readonly UpstreamItem[], ranking: ReadonlyMap<string, RankingExtra> = new Map(), now = new Date()): Promise<MirrorPass> {
  const pass = emptyPass();
  pass.read = items.length;
  for (const item of items) {
    const result = await storeItem(item, ranking.get(item?.id ?? "") ?? null, now).catch((error: unknown) => {
      console.log(JSON.stringify({ level: "warn", msg: "aihot mirror: an item failed", id: item?.id ?? null, err: String(error) }));
      return { stored: false as const, reason: String(error) };
    });
    if (!result.stored) {
      pass.skipped += 1;
      continue;
    }
    pass.stored += 1;
    if (result.created) pass.created += 1;
    if (result.revised) pass.revised += 1;
    if (result.selected) pass.selected += 1;
    if (result.cover) pass.covers += 1;
  }
  return pass;
}

/**
 * Mirrored material leaves with the window it came from, and everything derived from it goes with it
 * (publications cascade on the article; publish.ts retireArticle records the removal in the selected-set
 * ledger first). An item a report quotes stays: a published report is never rewritten, so its items
 * outlive the window. Age is counted from this site's first mirror of the item, which is the one time a
 * mirrored row is written and never moved (`discovered_at`): an item upstream's window still holds is
 * re-read as the same article, not deleted and stored again.
 */
export async function retireMirrored(now = new Date()): Promise<{ retired: number; pinned: number }> {
  const cutoff = new Date(now.getTime() - MIRROR_WINDOW_MS);
  const rows = await sql<{ id: string; pinned: boolean }[]>`
    SELECT a.id, EXISTS (
        SELECT 1 FROM reports r, jsonb_path_query(r.content, '$.**.itemId') AS cited(value)
        WHERE cited.value #>> '{}' = a.id
      ) AS pinned
    FROM articles a
    WHERE a.source_id = ${MIRROR_SOURCE_ID} AND a.discovered_at < ${cutoff}`;
  let retired = 0;
  for (const row of rows) {
    if (row.pinned) continue;
    if (await retireArticle(row.id, now)) retired += 1;
  }
  return { retired, pinned: rows.filter((row) => row.pinned).length };
}
