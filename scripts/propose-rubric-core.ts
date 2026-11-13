// The pure parts of the rubric-proposal loop (scripts/propose-rubric.ts): turning an eval reconciliation
// into a feedback brief, and rendering/parsing a *pending* proposal. Nothing here calls a model or writes
// the live prompt — the proposal is a file the owner approves by applying it, so the rubric never drifts
// without a human decision (the "AI 提议、你批准" rule).
import { z } from "zod";
import { nonEmpty } from "./eval-tools.ts";

/** One calibration signal: the current rubric, how the model did against human gold, and concrete cases. */
export interface RubricFeedback {
  rubric: string;
  promptVersion: string;
  metrics: { accuracy: number | null; fp: number; fn: number; held: number; reviewRate: number | null; decisive: number };
  held: { n: number; select: number; reject: number; either: number };
  mistakes: Array<{ kind: string; title: string; stratum: string | null; excerpt: string | null }>;
  heldExamples: Array<{ title: string; gold: string; stratum: string | null; excerpt: string | null }>;
}

const caseLine = (c: { title: string; stratum: string | null; excerpt: string | null }, lead: string) =>
  `- ${lead}「${c.title}」${c.stratum ? `（${c.stratum}）` : ""}${c.excerpt ? `\n  > ${c.excerpt.replace(/\s+/g, " ").slice(0, 240)}` : ""}`;

/**
 * The brief the proposal model reads: the rubric as it stands, the reconciliation numbers, the boundary
 * signal (how humans resolved the cases the model held), and concrete misjudged / held cases. The boundary
 * reading is stated so a proposal moves hit/edge/miss on evidence, not on a guess.
 */
export function compileBrief(f: RubricFeedback): string {
  const m = f.metrics;
  const boundary = f.held.n === 0 ? "本次没有边界档（hold）样本，边界信号不足，主要看 FP/FN。"
    : f.held.reject > f.held.select ? `人工把多数边界档判为不精选（${f.held.reject}/${f.held.n}）：edge 偏松，宜把这类往 miss 收。`
      : f.held.select > f.held.reject ? `人工把多数边界档判为精选（${f.held.select}/${f.held.n}）：edge 偏紧，宜把这类往 hit 放。`
        : `人工对边界档精选与不精选各半（${f.held.select}/${f.held.reject}）：边界本身合理，宜保持 hold、只修明显的 FP/FN。`;
  return [
    `# 学习轨评分标准校准反馈`,
    ``,
    `当前版本：${f.promptVersion}`,
    ``,
    `## 对账指标（模型自动决定 vs 人工金标）`,
    `- 自动决定准确率：${m.accuracy ?? "—"}（决定样本 ${m.decisive}）`,
    `- 误选 FP：${m.fp} · 漏选 FN：${m.fn}`,
    `- 边界档 hold：${m.held}（待复核率 ${m.reviewRate ?? "—"}）`,
    ``,
    `## 边界档人工复核结果（校准 hit/edge/miss 的信号）`,
    `- hold ${f.held.n} 条 → 精选 ${f.held.select} · 不精选 ${f.held.reject} · 两可 ${f.held.either}`,
    `- 读法：${boundary}`,
    ``,
    `## 判错的样本（FP=不该选却选了，FN=该选却没选）`,
    ...(f.mistakes.length ? f.mistakes.map((c) => caseLine(c, `${c.kind} `)) : ["（无）"]),
    ``,
    `## 边界档样本与人工裁定`,
    ...(f.heldExamples.length ? f.heldExamples.map((c) => caseLine(c, `人工=${c.gold} `)) : ["（无）"]),
    ``,
    `## 当前评分标准全文`,
    ``,
    f.rubric.trimEnd(),
    ``,
  ].join("\n");
}

/** The proposal model's answer: why it changes what it changes, and the full proposed rubric text. */
export const ProposalSchema = z.object({ rationale: nonEmpty, rubric: nonEmpty });
export type Proposal = z.infer<typeof ProposalSchema>;

/**
 * The instruction the proposal model runs under. It refines taste, not structure: the kinds table, the
 * five dimensions, the noise suppression, the input safety boundary and the JSON output contract stay;
 * what moves is "什么算 hit/edge/miss" and the important/noise examples, on the evidence in the brief.
 */
export const PROPOSAL_SYSTEM = [
  "你在帮站点主人校准学习轨精选评分标准。输入是一份校准反馈：现行标准全文、模型对人工金标的对账指标、",
  "边界档（hold）的人工复核结果，以及判错与边界样本。你的任务是提出一版最小改动的新标准。",
  "",
  "硬约束（违反即作废）：",
  "- 保留原有结构：输入安全边界、kinds 表（11 类，名称不变）、五个维度、噪声压制、最后检查、JSON 输出契约。",
  "- 保留 {{siteName}} 占位符与「只返回 level 与 kinds 的合法 JSON」这一输出要求，一字不改其语义。",
  "- 只调整「什么算 hit/edge/miss」的判档边界与「什么算重要/什么算噪声」的例子，依据反馈里的证据，不要整篇重写。",
  "- 边界信号：人工把多数 hold 判为不精选就把 edge 往 miss 收，判为精选就往 hit 放，各半就保持 hold、只修明显 FP/FN。",
  "- 不引入来源名称、粉丝数、信源层级等输入里不提供的信息作为加分项；保持来源盲评。",
  "",
  "只返回合法 JSON：{\"rationale\":\"改动理由，逐条对应反馈里的证据\",\"rubric\":\"新标准全文（保留 {{siteName}} 与 JSON 契约）\"}。",
].join("\n");

const FENCE = "````";

/** A pending proposal as a readable file: the rationale, then the full proposed rubric in a four-backtick
 *  fence (so a rubric that itself contains triple-backtick code stays intact). Never the live prompt. */
export function renderProposal(p: Proposal & { baseVersion: string; createdAt: string }): string {
  return [
    `# 学习轨评分标准提议（待主人批准，未生效）`,
    ``,
    `- 基于版本：${p.baseVersion}`,
    `- 生成时间：${p.createdAt}`,
    `- 生效方式：主人审阅后运行 \`node --env-file=.env scripts/propose-rubric.ts --apply <本文件>\`，`,
    `  才会写入 industry/prompts/selection-score-learning.md（内容哈希变 ⇒ 新版本，之后的新资料按新标准判）。`,
    ``,
    `## 理由`,
    ``,
    p.rationale.trim(),
    ``,
    `## 提议的评分标准（全文）`,
    ``,
    `${FENCE}markdown`,
    p.rubric.trimEnd(),
    FENCE,
    ``,
  ].join("\n");
}

/** Read a proposal file back into its rationale and rubric. The rubric is the four-backtick markdown block. */
export function parseProposal(text: string): Proposal {
  const rubric = new RegExp(`${FENCE}markdown\\n([\\s\\S]*?)\\n${FENCE}`).exec(text)?.[1];
  const rationale = /## 理由\n+([\s\S]*?)\n+## 提议的评分标准/.exec(text)?.[1]?.trim();
  if (!rubric || !rubric.trim()) throw new Error("提议文件里没有评分标准全文（````markdown 块）");
  if (!rationale) throw new Error("提议文件里没有改动理由（## 理由 段）");
  return { rationale, rubric: rubric.trimEnd() };
}