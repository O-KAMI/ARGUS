// Checks the selection against your own labelled samples (a "gold set"), one track at a time: each case
// runs the site's selection steps (editorial/analyze.ts) — the prefilter, then that track's score prompt
// with every model in --models (the news track averages two calls; the learning track takes one and holds
// its boundary level for a human) — and is compared with your decision. Metrics and the threshold sweep
// are reported per track, because the tracks ask with different wordings and hold the answer against
// different thresholds: one number over both would say nothing about either.
//
// CALIBRATION PROTOCOL (docs/selection.md). Hand-label 30–50 real items in the admin (精选标注); each
// label also decides the item's public `selected` and is stored in selection_gold. Export them with
// --export-gold, sweep the thresholds 40–90, find where FP and FN cross over (the inflection) and fix the
// threshold there (industry/selection.ts). Two things are never calibration evidence: a model labelling
// its own output, and the upstream AIHOT site's old curation. Only what a person decided in this
// deployment counts, so the labels come out of this database and nothing else is imported as gold.
//
// Usage:
//   node --env-file=.env scripts/eval-selection.ts --export-gold [--track learning]
//   node --env-file=.env scripts/eval-selection.ts [--gold .data/gold-learning.jsonl] [--track learning]
//     [--models default,deepseek-flash] [--n 50] [--split all] [--sweep 40-90] [--label "..."]
// Without --gold a track reads the file DEPLOYMENT.selectionGold gives it, else .data/gold.jsonl for the
// news track and .data/gold-<track>.jsonl for any other; every file that exists is read.
// Receipts make re-runs free; "either" cases are excluded from decisive metrics. Each run is also
// imported into SelectBench (admin → SelectBench) with every case, unless --no-import is given.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { DEPLOYMENT } from "@aihot/site";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { exportSelectionGold, selectionGoldCounts } from "@aihot/backend/admin/labeling";
import { TRACKS } from "@aihot/industry/selection";
import {
  awaitsMaterial,
  buildScoreInput,
  runSelectionPrefilter,
  runSelectionScores,
  scoresSelect,
  selectionPromptVersion,
  shownScore,
  trackThreshold,
  type AnalysisRun,
  type AnalyzeInputArticle,
} from "@aihot/backend/editorial/analyze";
import { importSelectBenchRun } from "@aihot/backend/admin/selectbench";
import { evalModels, pmap, positiveInt, safeReportNamePart, sampleCases, usageFor } from "./eval-tools.ts";
import {
  GOLD_TRACKS,
  heldResolutions,
  parseSelectionGoldJsonl,
  scoreCacheKey,
  selectionMetrics,
  selectionThresholdMetrics,
  type SelectionDecision,
  type SelectionGoldRow,
  type SelectionGoldTrack,
} from "./eval-selection-core.ts";

const { values } = parseArgs({
  options: {
    gold: { type: "string" },
    track: { type: "string" },
    models: { type: "string" },
    n: { type: "string" },
    split: { type: "string" },
    sweep: { type: "string" },
    concurrency: { type: "string", default: "6" },
    seed: { type: "string", default: "7" },
    label: { type: "string" },
    "export-gold": { type: "boolean", default: false },
    "no-import": { type: "boolean", default: false },
  },
});

const own = DEPLOYMENT.selectionGold;

/** The gold file a track's labels live in: the deployment's own choice, else the track's default path. */
const goldFile = (track: string) => own?.[track]?.file ?? (track === "news" ? ".data/gold.jsonl" : `.data/gold-${track}.jsonl`);

const n = values.n === undefined ? undefined : positiveInt(values.n, "n");
const goldSample = (track: string) => n ?? own?.[track]?.sample ?? 200;
const goldSplit = (track: string) => values.split ?? own?.[track]?.split ?? "all";

function goldSweep(track: string): [number, number] {
  if (!values.sweep) return own?.[track]?.sweep ?? [40, 90];
  const m = /^(\d+)-(\d+)$/.exec(values.sweep.trim());
  if (!m) throw new Error("--sweep must be a range such as 40-90");
  return [Number(m[1]), Number(m[2])];
}

const wantedTracks = (): SelectionGoldTrack[] => {
  if (!values.track) return [...GOLD_TRACKS];
  const named = values.track.split(",").map((t) => t.trim()).filter(Boolean);
  for (const t of named) if (!(GOLD_TRACKS as readonly string[]).includes(t)) throw new Error(`unknown track ${t} (use ${GOLD_TRACKS.join(", ")})`);
  return named as SelectionGoldTrack[];
};

/** The admin's hand labels out of selection_gold, into the gold file each track is read from. */
async function exportGold() {
  const counts = await selectionGoldCounts();
  const named = values.track ? wantedTracks() : null;
  const tracks = named ?? (counts.map((c) => c.track).filter((t): t is SelectionGoldTrack => (GOLD_TRACKS as readonly string[]).includes(t)));
  if (!tracks.length) {
    console.log("selection_gold 里还没有人工标注。先在后台“精选标注”里标 30–50 条，再导出。");
    return;
  }
  for (const track of tracks) {
    const jsonl = await exportSelectionGold(track);
    const file = path.resolve(REPO_ROOT, goldFile(track));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, jsonl);
    const labelled = counts.find((c) => c.track === track);
    console.log(`${track}: ${jsonl ? jsonl.trimEnd().split("\n").length : 0} 条 → ${path.relative(REPO_ROOT, file)}`
      + (labelled ? `（精选 ${labelled.select} · 不精选 ${labelled.reject}）` : ""));
  }
}

interface Sampled { track: SelectionGoldTrack; r: SelectionGoldRow }

/**
 * A case as the site's rules leave it: `relevance` is what the prefilter (or missing material) decided,
 * `scores` the two scores held against the case's track threshold. The eval writes no reader-facing copy;
 * an item past the prefilter is taken as written up, as the site writes one for every such item.
 */
interface Outcome extends Sampled {
  relevance: "pass" | "block" | "unknown" | null;
  scores: AnalysisRun["scores"];
  receiptIds: number[];
  error: string | null;
}

function toInput(r: SelectionGoldRow, track: SelectionGoldTrack): AnalyzeInputArticle {
  const m = r.material;
  const isX = r.sourceFacts.sourceKind === "x_search";
  const body = m.bodyOriginal || m.bodyZh || null;
  return {
    id: `gold-${r.caseId}`,
    revision: 1,
    bodyStatus: "ok",
    title: m.originalTitle || m.title,
    url: "https://example.invalid/" + r.caseId,
    author: null,
    publishedAt: m.publishedAt ? new Date(m.publishedAt) : null,
    bodyText: isX ? null : body,
    excerpt: null,
    xPost: isX ? { authorName: m.sourceName, handle: "", text: body ?? m.title } : null,
    media: [],
    source: {
      name: m.sourceName,
      kind: r.sourceFacts.sourceKind,
      tier: r.sourceFacts.sourceTier ?? "T2",
      firstParty: r.sourceFacts.firstParty ?? false,
      // The score step takes the track from the source's reserved tag, exactly as production does, so
      // the case is scored by its own track's wording and threshold.
      tags: track === "news" ? [] : [TRACKS[track]],
    },
  };
}

/** The site's decision for the case, at its track threshold or at `threshold`; null when the case failed.
 *  The learning boundary (edge) is held for a human, mirroring normalizeAnalysis. */
const decide = (x: Outcome, threshold?: number): SelectionDecision | null =>
  x.error !== null ? null
    : x.relevance === "pass" && x.scores?.level === "edge" ? "hold"
      : x.relevance === "pass" && scoresSelect(x.scores, threshold) ? "select" : "reject";

function mistakesOf(results: Outcome[]) {
  const mistakes: Array<Record<string, unknown>> = [];
  for (const x of results) {
    const pred = decide(x);
    const gold = x.r.gold.decision;
    if (pred === null || gold === "either") continue;
    const stratum = x.r.samplingContext?.samplingStratum ?? null;
    if (pred === "select" && gold === "reject") mistakes.push({ kind: "FP", caseId: x.r.caseId, track: x.track, title: x.r.material.title, score: shownScore(x.scores), stratum });
    else if (pred === "reject" && gold === "select") mistakes.push({ kind: "FN", caseId: x.r.caseId, track: x.track, title: x.r.material.title, score: shownScore(x.scores), relevance: x.relevance, stratum });
  }
  return mistakes;
}

async function evaluate() {
  const wanted = wantedTracks();
  const files = values.gold
    ? [{ track: null as SelectionGoldTrack | null, file: values.gold }]
    : wanted.map((track) => ({ track, file: goldFile(track) })).filter(({ file }) => existsSync(path.resolve(REPO_ROOT, file)));
  if (!files.length) {
    throw new Error(`no gold file exists (${wanted.map(goldFile).join(", ")}). Label items in the admin (精选标注) and run --export-gold, or pass --gold.`);
  }
  const seen = new Map<string, string>();
  const rows: Sampled[] = [];
  for (const { track, file } of files) {
    const full = path.resolve(REPO_ROOT, file);
    for (const r of parseSelectionGoldJsonl(readFileSync(full, "utf8"))) {
      const of = r.sourceFacts.track;
      if (seen.has(r.caseId)) throw new Error(`${file}: duplicate caseId ${r.caseId}, already read from ${seen.get(r.caseId)}`);
      seen.set(r.caseId, file);
      if (!wanted.includes(of)) continue;
      if (track !== null && track !== of) console.log(`${file}: ${r.caseId} says track ${of}, not the file's ${track}`);
      rows.push({ track: of, r });
    }
  }
  const byTrack = wanted
    .map((track) => ({ track, rows: rows.filter((x) => x.track === track).map((x) => x.r) }))
    .filter((x) => x.rows.length);
  if (!byTrack.length) throw new Error(`no gold cases for the tracks ${wanted.join(", ")}`);
  const seed = Number(values.seed);
  const sample: Sampled[] = byTrack.flatMap(({ track, rows: pool }) =>
    sampleCases(pool, { split: goldSplit(track), n: goldSample(track), seed }).map((r) => ({ track, r })));
  const trackNames = byTrack.map(({ track }) => track);
  const splits = [...new Set(trackNames.map(goldSplit))];
  const concurrency = positiveInt(values.concurrency!, "concurrency");
  const models = await evalModels(values.models, "score");

  const report: Record<string, unknown> = {};
  for (const model of models) {
    const started = performance.now();
    // Two gold cases can render the same score input while being judged on different tracks, or carry
    // different source facts and thresholds. Share only a score result of the same track on the same
    // input (including a failure): the tracks use different prompt wordings and expect different
    // answers, so a response shared across them would score one track by the other's standard.
    const scoreRequests = new Map<string, Promise<{ scores: AnalysisRun["scores"]; receiptIds: number[]; error: string | null }>>();
    const results = await pmap(sample, concurrency, async ({ track, r }): Promise<Outcome> => {
      const input = toInput(r, track);
      const receiptIds: number[] = [];
      const outcome = (relevance: Outcome["relevance"], scores: AnalysisRun["scores"] = null, error: string | null = null): Outcome =>
        ({ track, r, relevance, scores, receiptIds, error });
      // Only a title: the site waits for material, without a model call.
      if (awaitsMaterial(input)) return outcome("unknown");
      try {
        const prefilter = await runSelectionPrefilter(input, {}, (id) => receiptIds.push(id));
        if (prefilter.label === "BLOCK") return outcome("block");
        const threshold = trackThreshold(track, input.source.tier);
        if (threshold === null) return outcome("pass");

        const key = scoreCacheKey(track, buildScoreInput(input, track));
        let request = scoreRequests.get(key);
        if (!request) {
          const sharedReceiptIds: number[] = [];
          request = runSelectionScores(input, { scoreModel: model }, (id) => sharedReceiptIds.push(id)).then(
            (scores) => ({ scores, receiptIds: sharedReceiptIds, error: null }),
            (error: unknown) => ({ scores: null, receiptIds: sharedReceiptIds, error: String(error).slice(0, 200) }),
          );
          scoreRequests.set(key, request);
        }
        const shared = await request;
        receiptIds.push(...shared.receiptIds);
        if (shared.error) return outcome(null, null, shared.error);
        // Model output is independent of the source tier and of which case asked; the threshold is not.
        return outcome("pass", shared.scores ? { ...shared.scores, threshold } : null);
      } catch (error) {
        return outcome(null, null, String(error).slice(0, 200));
      }
    });

    const perTrack: Record<string, unknown> = {};
    for (const track of trackNames) {
      const of = results.filter((x) => x.track === track);
      const summary = selectionMetrics(of.map((x) => ({ gold: x.r.gold.decision, decision: decide(x) })));
      // Threshold sweep keeps valid-output metrics, while coverage and completeAcc charge decisive failures.
      // Each candidate threshold replays the production stopping rule against the stored raw levels.
      const cases = of.map((x) => ({ gold: x.r.gold.decision, track, available: x.error === null, passed: x.relevance === "pass", scores: x.scores }));
      const [from, to] = goldSweep(track);
      const sweep = [];
      for (let t = from; t <= to; t += 2) sweep.push(selectionThresholdMetrics(cases, t));
      const held = heldResolutions(of.map((x) => ({ gold: x.r.gold.decision, decision: decide(x) })));
      perTrack[track] = { n: of.length, promptVersion: selectionPromptVersion(track), summary, sweep, heldResolutions: held, mistakes: mistakesOf(of) };
      console.log(`[${track}] ${model} ${JSON.stringify({ ...summary, promptVersion: selectionPromptVersion(track) })}`);
      if (held.n) console.log(`  [${track}] 边界档人工复核结果：${held.n} 条 hold → 精选 ${held.select} · 不精选 ${held.reject} · 两可 ${held.either}（这是校准 hit/edge/miss 边界的信号）`);
      console.log(sweep.map((s) =>
        `  [${track}] t=${s.t} acc=${s.acc} completeAcc=${s.completeAcc} coverage=${s.coverage} P=${s.P} R=${s.R} F1=${s.F1} sel=${s.sel} fp=${s.fp} fn=${s.fn} gap=${s.gap} calls100=${s.calls100}`
      ).join("\n"));
    }
    const usage = await usageFor(results.flatMap((x) => x.receiptIds));
    const summary = { model, ...selectionMetrics(results.map((x) => ({ gold: x.r.gold.decision, decision: decide(x) }))), ...usage, wallSeconds: Math.round((performance.now() - started) / 1000) };
    // One track: its own numbers are the run's. Several: the combined line is only a total, so say so.
    if (trackNames.length > 1) console.log(`[all tracks] ${model} ${JSON.stringify(summary)}`);
    const cases = results.map((x) => ({
      caseId: x.r.caseId,
      track: x.track,
      title: x.r.material.title,
      stratum: x.r.samplingContext?.samplingStratum ?? null,
      gold: x.r.gold.decision,
      decision: decide(x),
      score: shownScore(x.scores),
      relevance: x.relevance,
      receiptId: x.receiptIds[0] ?? null,
      error: x.error,
    }));
    report[model] = {
      summary,
      sweep: trackNames.flatMap((track) => ((perTrack[track] as { sweep: Array<Record<string, unknown>> }).sweep).map((s) => ({ track, ...s }))),
      mistakes: mistakesOf(results),
      cases,
      tracks: perTrack,
    };
  }

  const outDir = path.join(REPO_ROOT, ".data/eval");
  mkdirSync(outDir, { recursive: true });
  const splitName = splits.length === 1 ? safeReportNamePart(splits[0]!) : "mixed";
  const file = path.join(outDir, `selection-${safeReportNamePart(trackNames.join("+"))}-${splitName}-${sample.length}-${Date.now()}.json`);
  const meta = {
    tracks: Object.fromEntries(trackNames.map((track) => [track, { n: sample.filter((x) => x.track === track).length, split: goldSplit(track), sweep: goldSweep(track), promptVersion: selectionPromptVersion(track) }])),
    split: splits.length === 1 ? splits[0]! : "mixed",
    n: sample.length,
    seed,
    promptVersion: trackNames.length === 1 ? selectionPromptVersion(trackNames[0]!) : trackNames.map((t) => `${t}:${selectionPromptVersion(t)}`).join(" "),
    createdAt: new Date().toISOString(),
  };
  writeFileSync(file, JSON.stringify({ meta, models: report }, null, 2));
  console.log(`report: ${file}`);
  if (!values["no-import"]) {
    const run = await importSelectBenchRun({ meta, models: report }, values.label ?? `${trackNames.join("+")} ${meta.split} ${sample.length} 条 · ${Object.keys(report).join(" / ")}`, "script:eval-selection");
    console.log(`SelectBench run: ${run.id}`);
  }
}

if (values["export-gold"]) await exportGold();
else await evaluate();
await closeDb();
