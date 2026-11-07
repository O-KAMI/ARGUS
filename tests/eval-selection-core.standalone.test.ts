// 审计反例：评测按当前门槛 60 取得 [60,90]（首轮恰在门槛上才触发复判），旧扫描在门槛 74 上用平均 75
// 判入选；而生产把门槛改成 74 时首轮 60 不再触发复判，只有 60，结果是拒绝。扫描必须用生产的停止规则
// 逐门槛重放真实决策：缺第二次答案记为证据不足（计入覆盖率），不当低分也不当成功。
import assert from "node:assert/strict";
import { test } from "node:test";
import { replaySelectionDecision, selectionThresholdMetrics, type SelectionThresholdCase } from "../scripts/eval-selection-core.ts";
import type { AnalysisRun } from "@aihot/backend/editorial/analyze";

const scores = (values: number[], extra: Partial<NonNullable<AnalysisRun["scores"]>> = {}): AnalysisRun["scores"] =>
  ({ model: "m", threshold: 60, values, receiptIds: [], reused: true, ...extra });

test("a stored learning run is replayed through the production stopping rule at each threshold", () => {
  // First verdict on the old threshold, second opinion stored: at 60 both count (mean 75 selects).
  const both = scores([60, 90]);
  assert.equal(replaySelectionDecision("learning", both, 60)?.decision, "select");
  assert.equal(replaySelectionDecision("learning", both, 60)?.second, "stored");
  // At 74 the first verdict 60 is off the threshold: no second call happens, only 60 is held, reject.
  const at74 = replaySelectionDecision("learning", both, 74);
  assert.equal(at74?.decision, "reject");
  assert.equal(at74?.second, "unwanted");
  assert.equal(replaySelectionDecision("learning", both, 90)?.decision, "reject");
  // A run whose first verdict was decisive holds one value: at 60 the rule wants a second it never asked.
  const one = scores([60]);
  assert.deepEqual(replaySelectionDecision("learning", one, 60), { decision: null, second: "missing" });
  // ...while at 90 the stored 90 sits on the threshold and the missing second opinion stays a gap.
  assert.deepEqual(replaySelectionDecision("learning", scores([90]), 90), { decision: null, second: "missing" });
  assert.equal(replaySelectionDecision("learning", scores([90]), 60)?.decision, "select");
});

test("the news track keeps both calls at every threshold, and refused runs decide nothing", () => {
  const news = scores([50, 80]);
  assert.equal(replaySelectionDecision("news", news, 60)?.decision, "select");
  assert.equal(replaySelectionDecision("news", news, 74)?.decision, "reject");
  assert.equal(replaySelectionDecision("news", news, 74)?.second, "stored");
  assert.equal(replaySelectionDecision("learning", scores([], { refused: true }), 60), null);
  assert.equal(replaySelectionDecision("learning", null, 60), null);
});

test("the sweep charges a wanted-but-absent second opinion to coverage, and prices the calls it would take", () => {
  const cases: SelectionThresholdCase[] = [
    { gold: "select", track: "learning", available: true, passed: true, scores: scores([60, 90]) },
    { gold: "select", track: "learning", available: true, passed: true, scores: scores([60]) },
  ];
  const at60 = selectionThresholdMetrics(cases, 60);
  assert.equal(at60.gap, 1, "the run without a stored second opinion cannot answer the threshold that wants one");
  assert.equal(at60.calls100, 200, "at 60 both cases want two calls");
  const at74 = selectionThresholdMetrics(cases, 74);
  assert.equal(at74.gap, 0, "at 74 neither case wants a second opinion, so the stored answers suffice");
  assert.equal(at74.calls100, 100, "at 74 the stopping rule saves the second call on both cases");
  assert.equal(at74.fn, 2, "both cases reject at 74 without a second opinion; the [60,90] one is the audit's example the old sweep called a selection");
});