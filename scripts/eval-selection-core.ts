// Selection evaluation cases (one human gold decision per line) and their metrics. Whether a case is
// selected is the site's own rule (editorial/analyze.ts), never a copy of it.
import { z } from "zod";
import { scoresSelect, secondScoreWanted, type AnalysisRun } from "@aihot/backend/editorial/analyze";
import { binaryMetrics, nonEmpty, nullableString, parseCasesJsonl, round, SamplingContext } from "./eval-tools.ts";

/** "either": both decisions are acceptable; such cases stay out of the decisive metrics. */
export const GOLD_DECISIONS = ["select", "reject", "either"] as const;
export type SelectionGoldDecision = (typeof GOLD_DECISIONS)[number];
/** The pipeline's answer: select/reject auto-decide, `hold` defers the learning boundary to a human. */
export type SelectionDecision = "select" | "reject" | "hold";

/** The track a case is judged on: the value trackOf(sources.tags) gives (industry/selection.ts). */
export const GOLD_TRACKS = ["learning", "news", "inherit"] as const;
export type SelectionGoldTrack = (typeof GOLD_TRACKS)[number];

const GoldRow = z.object({
  caseId: nonEmpty,
  material: z.object({
    title: nonEmpty,
    sourceName: nonEmpty,
    originalTitle: nullableString,
    publishedAt: nullableString.refine((value) => value === null || !Number.isNaN(new Date(value).getTime()), "publishedAt is not a valid date"),
    bodyZh: nullableString,
    bodyOriginal: nullableString,
  }),
  sourceFacts: z.object({
    sourceKind: nonEmpty,
    sourceTier: nullableString.transform((value) => value ?? undefined),
    firstParty: z.boolean().optional(),
    language: nullableString,
    // A file written by hand before the tracks existed describes news-track material; the labels the
    // admin exports always name their track.
    track: z.enum(GOLD_TRACKS).optional().transform((value) => value ?? "news"),
  }),
  samplingContext: SamplingContext.optional(),
  gold: z.object({ decision: z.enum(GOLD_DECISIONS) }),
});
export type SelectionGoldRow = z.infer<typeof GoldRow>;

/** Validate the entire gold set before filtering or sending any model requests. */
export const parseSelectionGoldJsonl = (text: string): SelectionGoldRow[] => parseCasesJsonl(text, GoldRow);

/**
 * The key one run shares a score response under. The tracks ask with different wordings
 * (selection-score.md and selection-score-learning.md) and expect different answers, while
 * buildScoreInput renders the material alone: keyed on the material only, the same case on two tracks
 * would reuse one response and be scored by the other track's standard.
 */
export const scoreCacheKey = (track: SelectionGoldTrack, scoreInput: string): string => `${track}\0${scoreInput}`;

export interface SelectionMetricCase {
  gold: SelectionGoldDecision;
  decision: SelectionDecision | null;
}

/**
 * Selection quality has two denominators:
 * - valid-output metrics describe the decisions the pipeline auto-made (select/reject);
 * - coverage / completeAccuracy charge failures against every decisive gold case.
 * A `hold` (the learning boundary deferred to a human) is a deliberate answer, not a failure: it counts
 * toward coverage and toward `held`/`reviewRate`, but not toward the auto-decision accuracy. Gold "either"
 * cases are excluded from both denominators, but their failures remain observable.
 */
export function selectionMetrics(cases: SelectionMetricCase[]) {
  const decisive = cases.filter((row) => row.gold !== "either");
  const eitherErrors = cases.filter((row) => row.gold === "either" && row.decision === null).length;
  const auto = decisive.filter((row) => row.decision === "select" || row.decision === "reject");
  const held = decisive.filter((row) => row.decision === "hold").length;
  const answered = auto.length + held;
  const m = binaryMetrics(auto.map((row) => ({ gold: row.gold === "select", predicted: row.decision === "select" })), auto.length);
  return {
    n: cases.length,
    decisiveGold: decisive.length,
    decisive: auto.length,
    held,
    either: cases.length - decisive.length,
    errors: (decisive.length - answered) + eitherErrors,
    decisiveErrors: decisive.length - answered,
    eitherErrors,
    tp: m.tp,
    fp: m.fp,
    fn: m.fn,
    tn: m.tn,
    coverage: round(answered / Math.max(1, decisive.length)),
    accuracy: m.accuracy,
    completeAccuracy: round((m.tp + m.tn) / Math.max(1, decisive.length)),
    precision: m.precision,
    recall: m.recall,
    f1: m.f1,
    selectedRate: round((m.tp + m.fp) / Math.max(1, auto.length)),
    reviewRate: round(held / Math.max(1, decisive.length)),
    // A property of the labelled decisive set, not of whichever cases a model happened to answer.
    goldSelectRate: round(decisive.filter((row) => row.gold === "select").length / Math.max(1, decisive.length)),
  };
}

/**
 * How humans resolved the boundary the model held (`hold`): the signal that calibrates hit/edge/miss.
 * A boundary mostly rejected means `edge` is too loose (push it toward miss); mostly selected means too
 * tight (push it toward hit). `either` marks a genuinely acceptable boundary the rubric may keep holding.
 */
export function heldResolutions(cases: SelectionMetricCase[]) {
  const held = cases.filter((row) => row.decision === "hold");
  return {
    n: held.length,
    select: held.filter((row) => row.gold === "select").length,
    reject: held.filter((row) => row.gold === "reject").length,
    either: held.filter((row) => row.gold === "either").length,
  };
}

/** A case's outcome: past the prefilter or not, and its scores; `available` false when it failed. */
export interface SelectionThresholdCase {
  gold: SelectionGoldDecision;
  track: SelectionGoldTrack;
  available: boolean;
  passed: boolean;
  scores: AnalysisRun["scores"];
}

/**
 * The decision a stored score run yields under `threshold`, replayed with the production rule
 * (secondScoreWanted + scoresSelect + the learning review hold — the same functions the worker runs).
 * The news track averages two calls; a run scored under another threshold may hold no second value where
 * this one wants it, reported as `missing` and deciding nothing — never a low score (a confident reject
 * the pipeline would not have made) and never a success. The learning track takes one call: `hit` selects,
 * `miss` rejects, and `edge` is held for a human (`hold`).
 */
export function replaySelectionDecision(
  track: SelectionGoldTrack,
  scores: AnalysisRun["scores"],
  threshold: number,
): { decision: SelectionDecision; second: "stored" | "unwanted" } | { decision: null; second: "missing" } | null {
  if (!scores || scores.refused || scores.values.length === 0) return null;
  const first = scores.values[0]!;
  if (!secondScoreWanted(track)) {
    if (scores.level === "edge") return { decision: "hold", second: "unwanted" };
    return { decision: scoresSelect({ ...scores, values: [first] }, threshold) ? "select" : "reject", second: "unwanted" };
  }
  if (scores.values.length < 2) return { decision: null, second: "missing" };
  return { decision: scoresSelect(scores, threshold) ? "select" : "reject", second: "stored" };
}

/** The decisions had every case been held against `threshold`, each replayed through the stopping rule. */
export function selectionThresholdMetrics(cases: SelectionThresholdCase[], threshold: number) {
  const replayed = cases.map((row) => ({
    gold: row.gold,
    replay: row.available && row.passed && row.scores ? replaySelectionDecision(row.track, row.scores, threshold) : null,
  }));
  const metrics = selectionMetrics(replayed.map((row) => ({ gold: row.gold, decision: row.replay?.decision ?? null })));
  // What running at this threshold would cost: one call each, plus the second opinions its own stopping
  // rule asks for. A stored run that lacks a wanted second opinion leaves the question open (gap), and
  // the offline sampling that paid for the stored answers is reported separately by the run's receipts.
  const answered = replayed.filter((row) => row.replay !== null);
  const calls = answered.reduce((total, row) => total + 1 + (row.replay!.second === "unwanted" ? 0 : 1), 0);
  return {
    t: threshold,
    acc: metrics.accuracy,
    completeAcc: metrics.completeAccuracy,
    coverage: metrics.coverage,
    P: metrics.precision,
    R: metrics.recall,
    F1: metrics.f1,
    sel: metrics.selectedRate,
    // Where the sweep is read: the threshold is fixed where a false 精选 stops costing more than a miss.
    fp: metrics.fp,
    fn: metrics.fn,
    decisive: metrics.decisive,
    decisiveGold: metrics.decisiveGold,
    decisiveErrors: metrics.decisiveErrors,
    /** Learning boundary cases held for a human at this threshold (the news track holds none). */
    held: metrics.held,
    reviewRate: metrics.reviewRate,
    /** Cases whose stored answers cannot answer this threshold (a wanted second opinion was never asked). */
    gap: replayed.filter((row) => row.replay?.second === "missing").length,
    /** Expected score calls per 100 answered cases were this threshold live. */
    calls100: answered.length ? round((100 * calls) / answered.length) : null,
  };
}
