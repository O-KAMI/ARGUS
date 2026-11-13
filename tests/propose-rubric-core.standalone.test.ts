// 提议回路的纯函数：把对账反馈编成 brief，以及「待批提议」的渲染/回读往返。提议永远不是线上提示词——
// 主人 --apply 才生效。回读用四反引号围栏，所以标准全文里即便自带三反引号代码块也不会被截断。
import assert from "node:assert/strict";
import { test } from "node:test";
import { compileBrief, parseProposal, renderProposal, type RubricFeedback } from "../scripts/propose-rubric-core.ts";

const feedback = (over: Partial<RubricFeedback> = {}): RubricFeedback => ({
  rubric: "你是 {{siteName}} 的学习价值判档器。\n只返回 {\"level\":\"hit\",\"kinds\":[\"skill_playbook\"]}",
  promptVersion: "selection-score-learning@abc1234567",
  metrics: { accuracy: 0.74, fp: 12, fn: 10, held: 8, reviewRate: 0.2, decisive: 40 },
  held: { n: 8, select: 2, reject: 5, either: 1 },
  mistakes: [{ kind: "FP", title: "某模型发布", stratum: "news-like", excerpt: "正文主体是发生了什么" }],
  heldExamples: [{ title: "一个可复用玩法", gold: "select", stratum: "boundary", excerpt: "截图加一句话讲清步骤" }],
  ...over,
});

test("compileBrief states the numbers, the boundary reading, the cases and the full current rubric", () => {
  const brief = compileBrief(feedback());
  assert.match(brief, /selection-score-learning@abc1234567/);
  assert.match(brief, /自动决定准确率：0\.74/);
  assert.match(brief, /误选 FP：12 · 漏选 FN：10/);
  assert.match(brief, /hold 8 条 → 精选 2 · 不精选 5 · 两可 1/);
  // reject > select: the boundary is too loose, push edge toward miss.
  assert.match(brief, /edge 偏松，宜把这类往 miss 收/);
  assert.match(brief, /FP 「某模型发布」（news-like）/);
  assert.match(brief, /人工=select 「一个可复用玩法」（boundary）/);
  // The rubric is carried verbatim so the proposal edits the real text, {{siteName}} and all.
  assert.ok(brief.includes("你是 {{siteName}} 的学习价值判档器。"));
});

test("compileBrief reads each boundary shape, including no held cases at all", () => {
  assert.match(compileBrief(feedback({ held: { n: 6, select: 5, reject: 1, either: 0 } })), /edge 偏紧，宜把这类往 hit 放/);
  assert.match(compileBrief(feedback({ held: { n: 4, select: 2, reject: 2, either: 0 } })), /边界本身合理，宜保持 hold/);
  const none = compileBrief(feedback({ held: { n: 0, select: 0, reject: 0, either: 0 }, heldExamples: [] }));
  assert.match(none, /本次没有边界档（hold）样本/);
  assert.match(none, /## 边界档样本与人工裁定\n（无）/);
});

test("a proposal round-trips even when the rubric itself contains triple-backtick code", () => {
  const rubric = [
    "你是 {{siteName}} 的学习价值判档器。",
    "示例输出：",
    "```json",
    '{"level":"hit","kinds":["skill_playbook"]}',
    "```",
    "只返回合法 JSON。",
  ].join("\n");
  const rendered = renderProposal({ rationale: "把 news_like 的边界收紧", rubric, baseVersion: "selection-score-learning@abc1234567", createdAt: "2026-11-13T00:00:00.000Z" });
  // The pending file says it is not live and how to approve it.
  assert.match(rendered, /待主人批准，未生效/);
  assert.match(rendered, /--apply/);
  const back = parseProposal(rendered);
  assert.equal(back.rationale, "把 news_like 的边界收紧");
  assert.equal(back.rubric, rubric);
  // The inner triple-backtick block survived intact.
  assert.ok(back.rubric.includes("```json\n{\"level\":\"hit\",\"kinds\":[\"skill_playbook\"]}\n```"));
});

test("parseProposal refuses a file without a rubric block or without a rationale", () => {
  assert.throws(() => parseProposal("# 提议\n\n## 理由\n\n因为所以\n"), /没有评分标准全文/);
  assert.throws(() => parseProposal("````markdown\n正文\n````\n"), /没有改动理由/);
});