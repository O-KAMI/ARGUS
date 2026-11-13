// 评测重放必须用生产的判定规则（secondScoreWanted + scoresSelect + 学习轨边界档复核），逐门槛重放真实决策。
// 新闻轨仍打两次分取平均：缺第二次答案记为证据不足（计入覆盖率），不当低分也不当成功——审计的反例
// （存下 [50,80]，按 74 重放平均 65 应拒绝）现在是常驻测试。学习轨只打一次：hit 入选、miss 拒绝、
// edge 交人工复核（hold），不再复判，所以也没有“缺第二次”的缺口。
import assert from "node:assert/strict";
import { test } from "node:test";
import { replaySelectionDecision, selectionThresholdMetrics, type SelectionThresholdCase } from "../scripts/eval-selection-core.ts";
import type { AnalysisRun } from "@aihot/backend/editorial/analyze";

const scores = (values: number[], extra: Partial<NonNullable<AnalysisRun["scores"]>> = {}): AnalysisRun["scores"] =>
  ({ model: "m", threshold: 60, values, receiptIds: [], reused: true, ...extra });

test("the learning track replays one call: hit selects, miss rejects, edge is held for a human", () => {
  assert.deepEqual(replaySelectionDecision("learning", scores([90], { level: "hit" }), 60), { decision: "select", second: "unwanted" });
  assert.deepEqual(replaySelectionDecision("learning", scores([20], { level: "miss" }), 60), { decision: "reject", second: "unwanted" });
  const edge = scores([60], { level: "edge" });
  assert.deepEqual(replaySelectionDecision("learning", edge, 60), { decision: "hold", second: "unwanted" });
  // The boundary is a level, not a number to average: it is held at every threshold the sweep visits.
  assert.equal(replaySelectionDecision("learning", edge, 74)?.decision, "hold");
  assert.equal(replaySelectionDecision("learning", edge, 90)?.decision, "hold");
  // A second stored value is ignored — the learning track never asks again.
  assert.deepEqual(replaySelectionDecision("learning", scores([60, 90], { level: "edge" }), 60), { decision: "hold", second: "unwanted" });
  assert.equal(replaySelectionDecision("learning", scores([], { refused: true }), 60), null);
  assert.equal(replaySelectionDecision("learning", null, 60), null);
});

test("the news track keeps both calls at every threshold, and a missing second opinion decides nothing", () => {
  const news = scores([50, 80]);
  assert.equal(replaySelectionDecision("news", news, 60)?.decision, "select"); // mean 65 >= 60
  assert.equal(replaySelectionDecision("news", news, 60)?.second, "stored");
  assert.equal(replaySelectionDecision("news", news, 74)?.decision, "reject"); // mean 65 < 74
  assert.equal(replaySelectionDecision("news", news, 74)?.second, "stored");
  // The audit's counterexample shape: a stored run with only one value cannot answer a track that wants two.
  assert.deepEqual(replaySelectionDecision("news", scores([80]), 60), { decision: null, second: "missing" });
});

test("the sweep charges a wanted-but-absent second opinion to coverage, and prices the calls it would take", () => {
  const cases: SelectionThresholdCase[] = [
    { gold: "select", track: "news", available: true, passed: true, scores: scores([50, 80]) },
    { gold: "select", track: "news", available: true, passed: true, scores: scores([80]) },
  ];
  const at60 = selectionThresholdMetrics(cases, 60);
  assert.equal(at60.gap, 1, "the news run without a stored second opinion cannot answer the threshold");
  assert.equal(at60.calls100, 200, "news wants two calls each");
  assert.equal(at60.coverage, 0.5, "the gap counts against coverage");
  assert.equal(at60.fn, 0, "the one-value run is a gap, not a confident reject");
});

test("the learning sweep takes one call a case and reports the boundary it holds", () => {
  const cases: SelectionThresholdCase[] = [
    { gold: "select", track: "learning", available: true, passed: true, scores: scores([90], { level: "hit" }) },
    { gold: "reject", track: "learning", available: true, passed: true, scores: scores([20], { level: "miss" }) },
    { gold: "select", track: "learning", available: true, passed: true, scores: scores([60], { level: "edge" }) },
  ];
  const at60 = selectionThresholdMetrics(cases, 60);
  assert.equal(at60.gap, 0, "learning never wants a second call");
  assert.equal(at60.calls100, 100, "learning takes one call each");
  assert.equal(at60.held, 1, "the edge case is held for a human");
  assert.equal(at60.decisive, 2, "hit and miss auto-decide; the edge does not");
  assert.equal(at60.fp, 0, "hit matches gold select; no false selection");
  assert.equal(at60.fn, 0, "miss matches gold reject; no false miss");
});