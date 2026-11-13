// The "AI 提议、你批准" rubric feedback loop (docs/selection.md). Human confirmations in the admin become
// gold (selection_gold); eval-selection reconciles the model against that gold and reports how humans
// resolved the boundary cases it held. This script turns one such reconciliation into a brief and — only
// with --propose — asks a model for a *pending* rubric edit. Nothing here changes the live rubric: the
// owner approves by running --apply <proposal>, which writes industry/prompts/selection-score-learning.md.
//
//   Compile the brief from the latest learning eval (reads files, calls no model):
//     node --env-file=.env scripts/propose-rubric.ts [--report <eval.json>] [--model <name>] [--gold <file>]
//   Also ask a model for a pending proposal (PAID, one call; owner-triggered):
//     node --env-file=.env scripts/propose-rubric.ts --propose [--model <name>]
//   Approve a proposal: write it to the live rubric (no model call; the content hash becomes a new version):
//     node --env-file=.env scripts/propose-rubric.ts --apply .data/proposals/learning-rubric-<ts>.md
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { promptFromText, promptVersion } from "@aihot/backend/editorial/prompts";
import { sha256 } from "@aihot/backend/lib/ids";
import { chatJson, MODELS } from "@aihot/backend/providers/llm";
import { completeReceipt, failedReceiptId } from "@aihot/backend/providers/receipts";
import { heldResolutions, parseSelectionGoldJsonl, selectionMetrics, type SelectionDecision, type SelectionGoldDecision } from "./eval-selection-core.ts";
import { positiveInt } from "./eval-tools.ts";
import { compileBrief, parseProposal, ProposalSchema, PROPOSAL_SYSTEM, renderProposal, type RubricFeedback } from "./propose-rubric-core.ts";

const RUBRIC_NAME = "selection-score-learning";
const RUBRIC_FILE = path.join(REPO_ROOT, "industry/prompts", `${RUBRIC_NAME}.md`);

const { values } = parseArgs({
  options: {
    report: { type: "string" },
    model: { type: "string" },
    gold: { type: "string", default: ".data/gold-learning.jsonl" },
    propose: { type: "boolean", default: false },
    apply: { type: "string" },
    "max-examples": { type: "string", default: "12" },
    "out-dir": { type: "string", default: ".data/proposals" },
  },
});

/** The newest learning eval report, unless --report names one. */
function latestReport(): string {
  if (values.report) return path.resolve(REPO_ROOT, values.report);
  const dir = path.join(REPO_ROOT, ".data/eval");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^selection-learning-.*\.json$/.test(f)) : [];
  if (!files.length) throw new Error("no selection-learning-*.json report: run eval-selection.ts --track learning first");
  return files.map((f) => path.join(dir, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]!;
}

interface EvalReport {
  models: Record<string, {
    cases: Array<{ caseId: string; track: string; title: string; stratum: string | null; gold: string; decision: string | null }>;
    tracks: Record<string, { promptVersion: string }>;
  }>;
}

/** Approve a pending proposal: render-guard it, then write the live rubric. No model call. */
function applyProposal(file: string) {
  const { rationale, rubric } = parseProposal(readFileSync(path.resolve(REPO_ROOT, file), "utf8"));
  // The proposed text must render like a pack prompt (no unknown {{value}}, no broken include) before it
  // replaces the live one — the same renderer the worker uses, so a bad proposal fails here, not live.
  promptFromText(RUBRIC_NAME, rubric);
  const before = promptVersion(RUBRIC_NAME);
  writeFileSync(RUBRIC_FILE, `${rubric.trimEnd()}\n`);
  console.log(`已生效：${path.relative(REPO_ROOT, RUBRIC_FILE)}`);
  console.log(`原版本：${before}（版本按内容哈希计，内容若有改动则版本号随之变；下次加载即用此标准判）`);
  console.log(`\n改动理由：\n${rationale}`);
  console.log(`\n复测：node --env-file=.env scripts/eval-selection.ts --track learning（报告里的 promptVersion 即新版本）`);
}

async function main() {
  if (values.apply) return applyProposal(values.apply);

  const maxExamples = positiveInt(values["max-examples"]!, "max-examples");
  const reportPath = latestReport();
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as EvalReport;
  const names = Object.keys(report.models);
  const model = values.model ?? (names.length === 1 ? names[0]! : undefined);
  if (!model) throw new Error(`report has models ${names.join(", ")}: pass --model to pick one`);
  const run = report.models[model];
  if (!run) throw new Error(`report has no model ${model} (has ${names.join(", ")})`);
  const learning = run.tracks.learning;
  if (!learning) throw new Error(`report has no learning track for ${model}: run eval-selection.ts --track learning`);

  // Excerpts come from the gold material the owner labelled, joined by caseId; no gold file → titles only.
  const goldPath = path.resolve(REPO_ROOT, values.gold!);
  const goldById = new Map(existsSync(goldPath) ? parseSelectionGoldJsonl(readFileSync(goldPath, "utf8")).map((r) => [r.caseId, r]) : []);
  const excerptOf = (caseId: string): string | null => {
    const m = goldById.get(caseId)?.material;
    return m ? m.bodyZh || m.bodyOriginal || m.originalTitle || null : null;
  };

  // Recompute the reconciliation from the case-level decisions with the same functions eval uses, so the
  // brief stays consistent no matter which eval version wrote the report (older ones predate the hold fields).
  const learningCases = run.cases.filter((c) => c.track === "learning");
  const metricCases = learningCases.map((c) => ({ gold: c.gold as SelectionGoldDecision, decision: c.decision as SelectionDecision | null }));
  const summary = selectionMetrics(metricCases);
  const held = heldResolutions(metricCases);
  const heldCases = learningCases.filter((c) => c.decision === "hold");
  // FP/FN straight from the cases (the report's atomic truth), so each carries a caseId to join its excerpt.
  const mistakes = learningCases.flatMap((c) => {
    const kind = c.decision === "select" && c.gold === "reject" ? "FP" : c.decision === "reject" && c.gold === "select" ? "FN" : null;
    return kind ? [{ kind, title: c.title, stratum: c.stratum, excerpt: excerptOf(c.caseId) }] : [];
  });
  const feedback: RubricFeedback = {
    rubric: readFileSync(RUBRIC_FILE, "utf8"),
    promptVersion: learning.promptVersion,
    metrics: { accuracy: summary.accuracy, fp: summary.fp, fn: summary.fn, held: summary.held, reviewRate: summary.reviewRate, decisive: summary.decisive },
    held,
    mistakes: mistakes.slice(0, maxExamples),
    heldExamples: heldCases.slice(0, maxExamples).map((c) => ({ title: c.title, gold: c.gold, stratum: c.stratum, excerpt: excerptOf(c.caseId) })),
  };

  const outDir = path.resolve(REPO_ROOT, values["out-dir"]!);
  mkdirSync(outDir, { recursive: true });
  const ts = Date.now();
  const brief = compileBrief(feedback);
  const briefFile = path.join(outDir, `learning-brief-${ts}.md`);
  writeFileSync(briefFile, brief);
  console.log(`brief: ${path.relative(REPO_ROOT, briefFile)}（基于 ${model} · ${learning.promptVersion}）`);
  console.log(`  自动决定准确率 ${feedback.metrics.accuracy ?? "—"} · FP ${feedback.metrics.fp} · FN ${feedback.metrics.fn} · hold ${feedback.held.n}（精选 ${feedback.held.select}/不精选 ${feedback.held.reject}/两可 ${feedback.held.either}）`);

  if (!values.propose) {
    console.log(`\n未调用模型。审阅 brief 后，加 --propose 让模型出一版待批提议（付费，一次调用）。`);
    return;
  }

  if (!MODELS[model]) throw new Error(`unknown model ${model}`);
  console.log(`\n提议调用：${model}（付费，一次；回执 purpose=propose_rubric）`);
  try {
    const res = await chatJson({
      model,
      purpose: "propose_rubric",
      subject: `rubric-proposal:${model}:${learning.promptVersion}`,
      promptVersion: `propose-rubric@${sha256(PROPOSAL_SYSTEM).slice(0, 10)}`,
      system: PROPOSAL_SYSTEM,
      user: brief,
      schema: ProposalSchema,
      temperature: 0.2,
      maxTokens: 8000,
    });
    await completeReceipt(sql, res.receiptId);
    const proposal = renderProposal({ ...res.data, baseVersion: learning.promptVersion, createdAt: new Date().toISOString() });
    const file = path.join(outDir, `learning-rubric-${ts}.md`);
    writeFileSync(file, proposal);
    console.log(`待批提议（未生效）：${path.relative(REPO_ROOT, file)}${res.reused ? "（复用回执）" : ""}`);
    console.log(`审阅后生效：node --env-file=.env scripts/propose-rubric.ts --apply ${path.relative(REPO_ROOT, file)}`);
  } catch (failure) {
    const receiptId = failedReceiptId(failure);
    console.error(`提议失败${receiptId !== null ? `（回执 ${receiptId}）` : ""}：${String(failure).slice(0, 500)}`);
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await closeDb();
}