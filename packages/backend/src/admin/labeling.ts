// Hand-labelling the selection decision. The page lists learning-track items the site has already
// scored, the operator says 精选 or not, and one action does two things: the public decision changes now
// through the existing editorial override (overrideFields in admin/content.ts already carries the version
// check, the re-publish, the audit trail and selected_ledger), and the same answer is kept in
// selection_gold as the human evidence scripts/eval-selection.ts calibrates the threshold against.
// Nothing here calls a model: the judgement shown beside an item is read from analyses as stored.
import { z } from "zod";
import { TRACKS, trackOf, type Track } from "@aihot/industry/selection";
import type { AdminLabelDecision, AdminLabeling, AdminLabelingRow, AdminLabelingState, AdminLabelResult, BeforeJson } from "@aihot/contracts/admin";
import { Conflict } from "../audit.ts";
import { sql } from "../db.ts";
import { loadAnalyzeInput, PROMPT_VERSIONS, type AnalyzeInputArticle } from "../editorial/analyze.ts";
import { translateInputOf } from "../editorial/writing.ts";
import { overrideFields } from "./content.ts";

const STATES = ["awaiting", "labelled", "all"] as const;

/**
 * Learning-track items with a stored score, newest first. An item the prefilter blocked or that never
 * got material has no score: there is no number for a threshold to be swept against, and forcing
 * `selected` on it would not reach the public feeds, so it is not offered for labelling — the counts say
 * how many such items there are rather than leaving the list silently short.
 */
export async function listLabeling(f: { state?: string; page?: number } = {}): Promise<BeforeJson<AdminLabeling>> {
  const state: AdminLabelingState = (STATES as readonly string[]).includes(f.state ?? "") ? (f.state as AdminLabelingState) : "awaiting";
  const page = Math.max(1, f.page ?? 1);
  const [rows, [counts]] = await Promise.all([
    sql<BeforeJson<AdminLabelingRow>[]>`
      SELECT a.id, a.title, a.url, a.discovered_at, a.published_at,
             s.name AS source_name, s.tier,
             an.relevance, an.score, an.selected AS analysis_selected, an.category,
             an.title_zh, an.summary_zh, an.reason_zh, an.created_at AS analyzed_at,
             position(${PROMPT_VERSIONS.scoreLearning} in an.prompt_version) > 0 AS scored_learning,
             p.selected AS published_selected, p.visibility,
             coalesce(o.version, 0) AS override_version, (o.fields->>'selected')::boolean AS override_selected,
             CASE WHEN g.case_id IS NULL THEN NULL
                  ELSE jsonb_build_object('decision', g.decision, 'actor', g.actor, 'created_at', g.created_at) END AS gold
      FROM articles a
      JOIN sources s ON s.id = a.source_id
      JOIN LATERAL (SELECT relevance, score, selected, category, title_zh, summary_zh, reason_zh, created_at, prompt_version
                    FROM analyses x WHERE x.article_id = a.id ORDER BY x.id DESC LIMIT 1) an ON an.score IS NOT NULL
      LEFT JOIN publications p ON p.article_id = a.id
      LEFT JOIN editorial_overrides o ON o.article_id = a.id
      LEFT JOIN selection_gold g ON g.article_id = a.id
      WHERE ${TRACKS.learning} = ANY (s.tags)
        AND (${state} = 'all' OR (${state} = 'labelled') = (g.case_id IS NOT NULL))
      ORDER BY a.discovered_at DESC, a.id
      LIMIT 50 OFFSET ${(page - 1) * 50}`,
    sql<AdminLabeling["counts"][]>`
      SELECT count(*)::int AS items, count(*) FILTER (WHERE scored)::int AS scored,
             count(*) FILTER (WHERE labelled)::int AS labelled, count(*) FILTER (WHERE scored AND NOT labelled)::int AS awaiting
      FROM (SELECT EXISTS (SELECT 1 FROM analyses x WHERE x.article_id = a.id AND x.score IS NOT NULL) AS scored,
                   EXISTS (SELECT 1 FROM selection_gold g WHERE g.article_id = a.id) AS labelled
            FROM articles a JOIN sources s ON s.id = a.source_id WHERE ${TRACKS.learning} = ANY (s.tags)) t`,
  ]);
  return { page, state, rows, counts };
}

/**
 * The gold case of an item, in the shape scripts/eval-selection-core.ts reads: the material as the
 * scoring step sees it, the source facts that fix its track and threshold, and where the operator put it.
 */
function goldCase(item: AnalyzeInputArticle, language: string | null, track: Track, stratum?: string) {
  const t = translateInputOf(item);
  // The gold reader rebuilds the score input from `material` alone and has no quoted-post field of its
  // own, so a quoted post travels inside bodyOriginal; left out, a re-run would score other material.
  const quoted = t.quotedText ? `\n\n[引用${t.quotedAuthor ? ` @${t.quotedAuthor}` : ""}]：${t.quotedText}` : "";
  return {
    caseId: item.id,
    material: {
      title: item.title,
      originalTitle: null,
      publishedAt: item.publishedAt?.toISOString() ?? null,
      sourceName: item.source.name,
      bodyZh: item.translationZh ?? null,
      bodyOriginal: `${t.text.trim()}${quoted}`.trim() || null,
    },
    sourceFacts: { sourceKind: t.sourceKind, sourceTier: item.source.tier, firstParty: item.source.firstParty, language, track },
    samplingContext: stratum ? { samplingStratum: stratum } : {},
  };
}

const LabelSchema = z.object({
  decision: z.enum(["select", "reject"]),
  reason: z.string().trim().min(1),
  version: z.number().int().nonnegative(),
  stratum: z.string().trim().min(1).max(60).optional(),
});

/**
 * One label, two effects: the item's public `selected` now, and its row of calibration evidence. The
 * override goes first, so a refusal (a stale version, an item that vanished) leaves no gold row claiming
 * a decision that did not take effect.
 */
export async function labelSelection(id: string, input: unknown, actor: string): Promise<BeforeJson<AdminLabelResult>> {
  const label = LabelSchema.parse(input);
  const [item, [meta]] = await Promise.all([
    loadAnalyzeInput(id),
    sql<{ language: string | null }[]>`SELECT language FROM articles WHERE id = ${id}`,
  ]);
  if (!item || !meta) throw new Conflict("内容不存在");
  const gold = goldCase(item, meta.language, trackOf(item.source.tags), label.stratum);
  await overrideFields(id, { fields: { selected: label.decision === "select" }, reason: label.reason, version: label.version }, actor);
  await sql`
    INSERT INTO selection_gold (case_id, article_id, track, material, source_facts, sampling_context, decision, actor)
    VALUES (${gold.caseId}, ${id}, ${gold.sourceFacts.track}, ${sql.json(gold.material as never)}, ${sql.json(gold.sourceFacts as never)},
            ${sql.json(gold.samplingContext as never)}, ${label.decision}, ${actor})
    ON CONFLICT (case_id) DO UPDATE SET
      track = EXCLUDED.track, material = EXCLUDED.material, source_facts = EXCLUDED.source_facts,
      sampling_context = EXCLUDED.sampling_context, decision = EXCLUDED.decision, actor = EXCLUDED.actor, created_at = now()`;
  const [published] = await sql<{ selected: boolean }[]>`SELECT selected FROM publications WHERE article_id = ${id}`;
  return { caseId: gold.caseId, decision: label.decision, selected: published?.selected ?? null };
}

/**
 * The stored labels as gold jsonl, one case per line, for scripts/eval-selection.ts. Kept here so the
 * table's columns are read in one place; the api's files do not survive a container, which is why the
 * labels live in the database and the jsonl is written on demand by the script.
 */
export async function exportSelectionGold(track?: Track): Promise<string> {
  const rows = await sql<{ case_id: string; material: unknown; source_facts: unknown; sampling_context: unknown; decision: string }[]>`
    SELECT case_id, material, source_facts, sampling_context, decision FROM selection_gold
    WHERE (${track ?? null}::text IS NULL OR track = ${track ?? null})
    ORDER BY created_at, case_id`;
  return rows.map((r) => JSON.stringify({
    caseId: r.case_id, material: r.material, sourceFacts: r.source_facts, samplingContext: r.sampling_context, gold: { decision: r.decision },
  })).join("\n") + (rows.length ? "\n" : "");
}

/** How many labels are stored, per track: what the calibration has to work with. */
export async function selectionGoldCounts(): Promise<Array<{ track: string; select: number; reject: number; total: number }>> {
  return sql`
    SELECT track, count(*) FILTER (WHERE decision = 'select')::int AS select, count(*) FILTER (WHERE decision = 'reject')::int AS reject,
           count(*)::int AS total
    FROM selection_gold GROUP BY track ORDER BY track`;
}
