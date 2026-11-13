import { describePublicationTime } from "../sources/dates.ts";
// analyzeArticle: the judging and writing steps, each with its own prompt from the industry pack
// (industry/prompts/):
// Without material (only a title) or a displayable original post, the item waits for a new material
// revision before any step.
//   1. prefilter: does the material belong to this industry at all (wide recall). Only BLOCK stops an
//      item; a BLOCK on an original post without text counts as UNKNOWN;
//   2. score: the source tier's threshold (industry/selection.ts) decides 精选 — two independent calls on
//      the news track; the learning track takes one, and its boundary level (edge) is held for a human;
//   3. structure: category, tags, subjects and the current news fact, beside scoring;
//   4. writing, once the structure is in: the Chinese title, summary and reason by the content
//      understanding for selected and near-selected items, by the cheaper title/summary prompts for the rest;
//      copy that uses a word the site keeps from readers (industry/wording.ts) goes back once to change only those.
// Material with only a title or a feed summary has its article page fetched before it is judged.
import { z } from "zod";
import { CATEGORY_KEYS } from "@aihot/contracts/taxonomy";
import { CATEGORIES } from "@aihot/industry/taxonomy";
import { LEARNING_KINDS, SELECTION, trackOf, type LearningKind, type LearningLevel, type Track } from "@aihot/industry/selection";
import { ITEM_COPY } from "@aihot/site";
import { sql } from "../db.ts";
import { chatJson, MODELS, type ContentPart } from "../providers/llm.ts";
import { completeReceipt, failedReceiptId, failureKind } from "../providers/receipts.ts";
import { collapseWhitespace } from "../lib/text.ts";
import { modelFor, modelRoute, modelSupportsVision } from "./models.ts";
import { buildMaterial, firstImagePart, loadAnalyzeInput, type AnalyzeInputArticle } from "./input.ts";
import { visionEvidence } from "./vision.ts";
import { pageFetchable } from "../content/extract.ts";
import { shutdownSignal } from "../jobs/queue.ts";
import {
  buildArticlePrompt, buildLongTweetPrompt, buildShortTweetPrompt, finalizeCopy, isShortTweetInput, looksZh, MAX_BODY_CHARS, missingEvidence,
  needsShortTweetTranslation, parseTranslateOutput, PREFILTER_SYSTEM, prefilterUser, translateInputOf, UNDERSTAND_SYSTEM, understandUser,
  type IdentityGuard,
} from "./writing.ts";
import { CATEGORY_GUIDE, CATEGORY_TAGS, ENTITIES, ENTITY_TAGS, ITEM_TYPES, normalizeTags, TOPIC_TAGS } from "./vocabulary.ts";
import { promptText, promptVersion } from "./prompts.ts";
import { originalPostCopy } from "../content/posts.ts";
import { wordingProblems } from "./wording.ts";

export { buildMaterial, loadAnalyzeInput, type AnalyzeInputArticle };

export const PROMPT_VERSIONS = {
  prefilter: promptVersion("prefilter"),
  score: promptVersion("selection-score"),
  scoreLearning: promptVersion("selection-score-learning"),
  understand: promptVersion("understand"),
  summarize: promptVersion("summarize-article", "summarize-article-empty", "summarize-short-post", "summarize-short-post-quoted", "summarize-long-post", "summarize-long-post-quoted", "identity-context"),
  structure: promptVersion("structure"),
  wording: promptVersion("mend-wording"),
} as const;

/** Which wording a judgement was produced under, per track, in the order the versions are concatenated. */
export function analyzePromptVersion(track: Track): string {
  const { prefilter, score, scoreLearning, understand, summarize, structure, wording } = PROMPT_VERSIONS;
  return [prefilter, track === "learning" ? scoreLearning : score, understand, summarize, structure, wording].join("+");
}

export function selectionPromptVersion(track: Track): string {
  return [PROMPT_VERSIONS.prefilter, track === "learning" ? PROMPT_VERSIONS.scoreLearning : PROMPT_VERSIONS.score].join("+");
}

/** Every step's prompt, as stored on each judgement. */
export const SELECTION_PROMPT_VERSION = selectionPromptVersion("news");
export const ANALYZE_PROMPT_VERSION = analyzePromptVersion("news");

// Scoring

/** The most score calls per article; their mean decides, and its floor is shown. */
export const SCORE_CALLS = 2;

/**
 * Whether a track takes a second score call. The news track averages a continuous score, where a second
 * opinion is information rather than a coin flip, so it keeps both calls. The learning track answers in
 * three discrete levels and takes only one: `hit` selects, `miss` rejects, and `edge` — the boundary the
 * model cannot settle on its own — is held for a human decision (normalizeAnalysis `review`) rather than
 * asked again. A second level call would only re-roll the same boundary, so it is not spent.
 */
export function secondScoreWanted(track: Track): boolean {
  return track !== "learning";
}

/**
 * The thresholds on the mean score, per source tier (industry/selection.ts): selected when the scores'
 * mean reaches it. Tiers without a threshold are not scored for 精选.
 */
export function tierThreshold(tier: string): number | null {
  return SELECTION.thresholds[tier] ?? null;
}

/**
 * The threshold a judgement is held against. Tiers without one (EXCLUDE_MP and anything unlisted) are
 * never scored on either track: that safety boundary does not move. `inherit` is never scored either —
 * a mirrored source takes its selection from upstream and must not spend model calls here.
 */
export function trackThreshold(track: Track, tier: string): number | null {
  if (track === "inherit" || SELECTION.thresholds[tier] === undefined) return null;
  return track === "learning" ? SELECTION.learning.threshold : SELECTION.thresholds[tier];
}

/** Unselected items above this mean are written like selected ones. */
export const UNDERSTAND_FLOOR = SELECTION.understandFloor;

/** Call parameters of the score step, unless the model sets its own (the site's preset, `scoreCall`). */
const scoreCall = (model: string) => MODELS[model]?.scoreCall ?? { temperature: 0.2, maxTokens: 1024, timeoutMs: 120_000 };

/** The score prompt: the industry's taste (industry/prompts/selection-score.md). */
export const SCORE_SYSTEM = promptText("selection-score");

/**
 * The learning track's own wording, in its own file. It cannot be `{{track}}` inside one file:
 * promptVersion hashes file contents only, so two different wordings would share one version number
 * and a receipt could no longer say which of them produced a result.
 */
export const SCORE_LEARNING_SYSTEM = promptText("selection-score-learning");

export function scoreSystem(track: Track): string {
  return track === "learning" ? SCORE_LEARNING_SYSTEM : SCORE_SYSTEM;
}

export const ScoreSchema = z.object({ attentionScore: z.coerce.number().int().min(0).max(100) });

/** The learning track answers with a level, not a number; `SELECTION.learning.levels` maps it back onto the same score machinery. */
export const LearningScoreSchema = z.object({
  level: z.preprocess((v) => String(v ?? "").trim().toLowerCase(), z.enum(["hit", "edge", "miss"])),
  kinds: z.array(z.string()).max(6).catch([]),
});

/** Only kinds the vocabulary knows: the model does not get to extend the list. */
function knownKinds(raw: readonly string[]): LearningKind[] {
  return [...new Set(raw.filter((k): k is LearningKind => (LEARNING_KINDS as readonly string[]).includes(k)))].slice(0, 3);
}

const SCORE_TIME = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});

/** The score input's time: Beijing time, ISO 8601 with +08:00 (the form the prompt was tuned on). */
export function scoreInputTime(at: Date): string {
  const ms = at.getTime() % 1000;
  return `${SCORE_TIME.format(at).replace(" ", "T")}${ms ? `.${String(ms).padStart(3, "0")}` : ""}+08:00`;
}

/**
 * The score input: no source facts (the prompt forbids guessing them), the publication time, the
 * original title (items are scored before any Chinese copy exists) and the whole body. The output
 * instruction follows the track's own contract: the learning prompt answers `level,kinds`, the news
 * prompt `attentionScore` — asking one track for the other's field contradicts its system wording.
 */
export function buildScoreInput(a: AnalyzeInputArticle, track: Track = "news"): string {
  let body: string;
  if (a.xPost) {
    const quoted = a.xPost.quoted?.text ? `\n\n[引用 ${a.xPost.quoted.handle ? `@${a.xPost.quoted.handle}` : "原推文"}]：${a.xPost.quoted.text}` : "";
    body = `${String(a.xPost.text ?? "").trim()}${quoted}`.trim();
  } else {
    body = (a.bodyText ?? a.excerpt ?? "").trim();
  }
  if (!body) body = a.title;
  const at = a.publishedAt;
  return [
    track === "learning"
      ? "请按系统规则评估以下单篇材料的学习价值。只输出 level 与 kinds（level 取 hit/edge/miss）。"
      : "请按系统规则评估以下单篇材料所代表的事件。只输出 attentionScore。",
    `【发布时间（北京时间）】\n${at ? a.publicationTime === undefined || a.publicationTime?.includes("T") ? scoreInputTime(at) : describePublicationTime(at, a.publicationTime) : "未知（收录时间不代表发布时间）"}`,
    `【标题】\n${a.title.trim()}`,
    `【完整正文】\n${body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) : body}`,
  ].join("\n\n");
}

// Step outputs

const PrefilterSchema = z.object({
  label: z.preprocess((v) => String(v ?? "").trim().toUpperCase(), z.enum(["PASS", "BLOCK", "UNKNOWN"])),
  reason: z.string().max(200).catch(""),
});

const FactSchema = z
  .object({
    title: z.string().max(80),
    subject: z.string().max(80).nullable().optional(),
    action: z.string().max(80).nullable().optional(),
    object: z.string().max(160).nullable().optional(),
    occurredAt: z.string().nullable().optional(),
    evidence: z.string().trim().max(600).nullable().catch(null),
    conditions: z.array(z.object({
      // Older reusable receipts may also contain a paraphrase. New extraction only copies evidence.
      text: z.string().trim().min(1).max(200).optional().catch(undefined),
      quote: z.string().trim().min(1).max(400),
    }).nullable().catch(null)).catch([]),
  })
  .nullable()
  .catch(null);

export const StructureSchema = z.object({
  scope: z.enum(["single", "composite", "unknown"]).catch("unknown"),
  category: z.enum(CATEGORY_KEYS).nullable().catch(null),
  tags: z.array(z.string()).max(12).catch([]),
  subjects: z.array(z.string()).max(6).catch([]),
  fact: FactSchema,
});

const UnderstandSchema = z.object({
  itemType: z.enum(ITEM_TYPES),
  authorRole: z.enum(["principal", "observer", "relayer"]).catch("relayer"),
  // The understanding prompt asks for tags; the public ones come from the structure step.
  tags: z.array(z.string()).max(12).catch([]),
  editorialJudgment: z.string().max(400).catch(""),
  titleZh: z.string().trim().min(1).max(200),
  summaryZh: z.string().trim().min(1).max(4000),
});

const SummarizeSchema = z.object({ titleZh: z.string(), summaryZh: z.string(), bodyZh: z.string() });

const ZH_COUNT = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"];

/** The structure step owns the public category and tags, as well as grouping evidence (filled from the pack's vocabulary). */
export const STRUCTURE_SYSTEM = promptText("structure", {
  categoryCount: ZH_COUNT[CATEGORIES.length] ?? String(CATEGORIES.length),
  categoryGuide: CATEGORY_GUIDE,
  categoryTags: CATEGORY_TAGS.join("、"),
  topicTags: TOPIC_TAGS.join("、"),
  entityTags: ENTITY_TAGS.join("、"),
  entities: Object.entries(ENTITIES).map(([id, e]) => `${id}（${e.aliases.slice(0, 3).join("/")}）`).join("，"),
});

/** Keep only quotes present both in the original material and in the text the structure model saw. */
export function normalizeStructure(data: z.infer<typeof StructureSchema>, a: AnalyzeInputArticle) {
  const visible = collapseWhitespace(buildMaterial(a));
  const originals = (a.xPost
    ? [String(a.xPost.text ?? a.title), String(a.xPost.quoted?.text ?? "")]
    : [a.bodyText ?? a.excerpt ?? ""]).map(collapseWhitespace);
  // A title is not the unseen contents of a video/article, regardless of the model's confidence.
  const scope = originals.some(Boolean) ? data.scope : "unknown";
  const grounded = (quote: string | null | undefined) => {
    const text = collapseWhitespace(quote ?? "");
    return text && visible.includes(text) && originals.some((original) => original.includes(text)) ? text : null;
  };
  const fact = !originals.some(Boolean) || scope === "composite" || !data.fact ? null : {
    ...data.fact,
    evidence: grounded(data.fact.evidence),
    conditions: data.fact.conditions.flatMap((c) => {
      if (!c) return [];
      const quote = grounded(c.quote);
      return quote ? [{ text: c.text ?? quote, quote }] : [];
    }).slice(0, 4),
  };
  return {
    category: data.category, tags: normalizeTags(data.tags),
    subjects: [...new Set(data.subjects.map((s) => s.trim().toLowerCase()).filter((s) => s in ENTITIES))],
    scope, fact,
  };
}

export interface AnalysisRun {
  /** Absent when there is nothing to judge yet: only a title, and no displayable original post. */
  prefilter: { label: "PASS" | "BLOCK" | "UNKNOWN"; reason: string; model: string; receiptId: number; reused: boolean } | null;
  /**
   * The independent score calls and the tier threshold they are held against; absent when the material
   * is not scored. `refused`: the model's content filter declined it, so it is not selected.
   */
  scores: { model: string; threshold: number; values: number[]; receiptIds: number[]; reused: boolean; refused?: boolean; kinds?: LearningKind[]; level?: LearningLevel } | null;
  /** The reader-facing copy: `understand` (selected, near-selected), `summarize`, `verbatim` (a Chinese short post), `none`. */
  writing: {
    kind: "understand" | "summarize" | "verbatim" | "none";
    model: string | null;
    titleZh: string;
    summaryZh: string;
    reasonZh: string | null;
    itemType?: string;
    authorRole?: string;
    identityGuard?: IdentityGuard;
    receiptIds: number[];
    reused: boolean;
  } | null;
  structure: (ReturnType<typeof normalizeStructure> & { model: string; receiptId: number; reused: boolean }) | null;
}

const isContentFilter = (error: unknown) => failureKind(error) === "refused" && /contentFilter|"1301"/.test((error as Error).message);

/** Only a title or a feed summary, and a page to fetch: the article is judged on the page. */
export function waitsForPage(a: AnalyzeInputArticle): boolean {
  return a.bodyStatus === "pending" && !a.bodyText && !a.xPost && pageFetchable(a.url, a.source.kind);
}

type StepOpts = { attemptTag?: string; scoreModel?: string };
type ReceiptObserver = (receiptId: number) => void;

/** A stopping worker finishes the stage it is in, never starts the next. */
const checkAnalysisRunning = () => shutdownSignal.signal.throwIfAborted();

const subjectOf = (a: AnalyzeInputArticle) => `article:${a.id}@${a.revision}`;
const tagged = (attemptTag: string | undefined, step: string) => [attemptTag, step].filter(Boolean).join(":") || undefined;

async function runPrefilter(a: AnalyzeInputArticle, opts: StepOpts, onReceipt?: ReceiptObserver): Promise<NonNullable<AnalysisRun["prefilter"]>> {
  // Shadow-switched: dormant by default, and only the learning track's short picture posts ever read one.
  const evidence = await visionEvidence(a, onReceipt);
  const model = await modelFor("prefilter");
  checkAnalysisRunning();
  const res = await chatJson({
    model,
    purpose: "prefilter_article",
    subject: subjectOf(a),
    promptVersion: PROMPT_VERSIONS.prefilter,
    system: PREFILTER_SYSTEM,
    user: prefilterUser(a, { visualEvidence: evidence?.state === "ok" ? evidence.text : null }),
    schema: PrefilterSchema,
    temperature: 0,
    maxTokens: 512,
    attemptTag: opts.attemptTag,
  });
  // A BLOCK without text to back it (an original post that is only media or a link) counts as UNKNOWN (which goes on).
  const label = res.data.label === "BLOCK" && missingEvidence(a) ? "UNKNOWN" : res.data.label;
  return { label, reason: res.data.reason, model: res.model, receiptId: res.receiptId, reused: res.reused };
}

/** The production prefilter step, exposed separately so SelectBench can preserve partial receipt evidence. */
export async function runSelectionPrefilter(
  a: AnalyzeInputArticle,
  opts: StepOpts = {},
  onReceipt?: ReceiptObserver,
): Promise<NonNullable<AnalysisRun["prefilter"]>> {
  try {
    const result = await runPrefilter(a, opts, onReceipt);
    onReceipt?.(result.receiptId);
    return result;
  } catch (error) {
    const receiptId = failedReceiptId(error);
    if (receiptId !== null) onReceipt?.(receiptId);
    throw error;
  }
}

async function runScores(
  a: AnalyzeInputArticle,
  track: Track,
  threshold: number,
  opts: StepOpts,
  onReceipt?: ReceiptObserver,
): Promise<NonNullable<AnalysisRun["scores"]>> {
  const model = opts.scoreModel ?? (await modelFor("score"));
  const call = scoreCall(model);
  const input = buildScoreInput(a, track);
  const params = {
    model, purpose: "score_article" as const, subject: subjectOf(a), system: scoreSystem(track), user: input,
    promptVersion: track === "learning" ? PROMPT_VERSIONS.scoreLearning : PROMPT_VERSIONS.score,
    temperature: call.temperature, maxTokens: call.maxTokens, timeoutMs: call.timeoutMs,
  };
  let kinds: LearningKind[] = [];
  let level: LearningLevel | undefined;
  const values: number[] = [];
  const receiptIds: number[] = [];
  let reused = true;
  // One after the other: the news track's second call reuses the provider's cached prompt. The learning
  // track stops after one — its boundary level goes to a human, not to a second roll.
  for (let i = 0; i < SCORE_CALLS; i++) {
    if (i > 0 && !secondScoreWanted(track)) break;
    checkAnalysisRunning();
    try {
      // Each call is its own paid request; an explicit re-evaluation gets new ones.
      const attemptTag = tagged(opts.attemptTag, `score-${i + 1}`);
      if (track === "learning") {
        const res = await chatJson({ ...params, attemptTag, schema: LearningScoreSchema });
        onReceipt?.(res.receiptId);
        // The level is mapped onto a score here, so the mean-against-threshold rule and the score shown
        // on the card stay exactly the machinery the news track already uses.
        values.push(SELECTION.learning.levels[res.data.level as LearningLevel]);
        if (i === 0) { kinds = knownKinds(res.data.kinds); level = res.data.level as LearningLevel; }
        receiptIds.push(res.receiptId);
        reused &&= res.reused;
      } else {
        const res = await chatJson({ ...params, attemptTag, schema: ScoreSchema });
        onReceipt?.(res.receiptId);
        values.push(res.data.attentionScore);
        receiptIds.push(res.receiptId);
        reused &&= res.reused;
      }
    } catch (error) {
      const receiptId = failedReceiptId(error);
      if (receiptId !== null) onReceipt?.(receiptId);
      // The model's content filter declines the material (Zhipu 1301): not scored, so not selected.
      if (isContentFilter(error)) return { model, threshold, values, receiptIds, reused: false, refused: true };
      throw error;
    }
  }
  return track === "learning" ? { model, threshold, values, receiptIds, reused, kinds, level } : { model, threshold, values, receiptIds, reused };
}

/** The production score step; its threshold stays case-specific even when an evaluator shares model output. */
export async function runSelectionScores(
  a: AnalyzeInputArticle,
  opts: StepOpts = {},
  onReceipt?: ReceiptObserver,
): Promise<AnalysisRun["scores"]> {
  const threshold = trackThreshold(trackOf(a.source.tags), a.source.tier);
  return threshold === null ? null : runScores(a, trackOf(a.source.tags), threshold, opts, onReceipt);
}

export async function runStructure(a: AnalyzeInputArticle, opts: StepOpts = {}): Promise<NonNullable<AnalysisRun["structure"]>> {
  const model = await modelFor("structure");
  checkAnalysisRunning();
  const res = await chatJson({
    model,
    purpose: "structure_article",
    subject: subjectOf(a),
    promptVersion: PROMPT_VERSIONS.structure,
    system: STRUCTURE_SYSTEM,
    user: buildMaterial(a),
    schema: StructureSchema,
    temperature: 0.2,
    maxTokens: 1200,
    attemptTag: tagged(opts.attemptTag, "structure"),
  });
  return { ...normalizeStructure(res.data, a), model: res.model, receiptId: res.receiptId, reused: res.reused };
}

/** Content understanding grounded in the original; null on a content-filter refusal. */
export async function runUnderstand(a: AnalyzeInputArticle, opts: StepOpts = {}): Promise<AnalysisRun["writing"]> {
  const model = await modelFor("understand");
  const text = understandUser(a);
  const call = (image: ContentPart | null) => {
    checkAnalysisRunning();
    return chatJson({
      model, purpose: "understand_article", subject: subjectOf(a), promptVersion: PROMPT_VERSIONS.understand, system: UNDERSTAND_SYSTEM,
      user: image ? [{ type: "text", text }, image] : text, schema: UnderstandSchema, temperature: 0.2, maxTokens: 16_384,
      timeoutMs: 180_000, attemptTag: tagged(opts.attemptTag, "understand"),
    });
  };
  // Image input is opt-in: an unspecified capability must not become a paid provider probe.
  const image = modelSupportsVision(model) ? await firstImagePart(a) : null;
  let res: Awaited<ReturnType<typeof call>>;
  try {
    res = await call(image);
  } catch (error) {
    if (isContentFilter(error)) return null;
    // The model refused the image (download, format): the text is written without it.
    if (!image || failureKind(error) !== "refused") throw error;
    try {
      res = await call(null);
    } catch (retryError) {
      if (isContentFilter(retryError)) return null;
      throw retryError;
    }
  }
  const d = res.data;
  const copy = finalizeCopy(translateInputOf(a), { titleZh: d.titleZh, summaryZh: d.summaryZh });
  return {
    kind: "understand", model: res.model, titleZh: copy.titleZh, summaryZh: copy.summaryZh, reasonZh: d.editorialJudgment.trim() || null,
    itemType: d.itemType, authorRole: d.authorRole, identityGuard: copy.identityGuard, receiptIds: [res.receiptId], reused: res.reused,
  };
}

export const MEND_SYSTEM = promptText("mend-wording", { reasonLabel: ITEM_COPY.reasonLabel });
const MendSchema = z.object({ titleZh: z.string().trim().min(1), summaryZh: z.string().trim().min(1), reasonZh: z.string().trim().nullable().catch(null) });

/**
 * Written copy that uses a word the site keeps from its readers (industry/wording.ts) goes back once, those words
 * named, to change only them: a site's writing prompts can ask the same, but a model keeps drifting back to the
 * words it uses most. The mended copy keeps the
 * identity guard and is used only when it leaves fewer such words and the same numbers.
 */
async function mendWording(a: AnalyzeInputArticle, w: NonNullable<AnalysisRun["writing"]>, opts: StepOpts): Promise<NonNullable<AnalysisRun["writing"]>> {
  // A copy missing its title or summary waits for a whole one (normalizeAnalysis): nothing to mend, and no text to
  // let a model without the material fill in.
  if ((w.kind !== "understand" && w.kind !== "summarize") || !w.titleZh || !w.summaryZh) return w;
  const problems = wordingProblems(w);
  if (!problems.length) return w;
  const t = translateInputOf(a);
  checkAnalysisRunning();
  let res;
  try {
    res = await chatJson({
      model: await modelFor("wording"), purpose: "mend_wording", subject: subjectOf(a), promptVersion: PROMPT_VERSIONS.wording, system: MEND_SYSTEM,
      user: [
        `来源：${t.sourceName ?? "（未注明）"}`, `原题：${t.title}`,
        `中文稿：\n${JSON.stringify({ titleZh: w.titleZh, summaryZh: w.summaryZh, reasonZh: w.reasonZh })}`,
        `问题：\n${problems.map((p) => `- ${p}`).join("\n")}`,
      ].join("\n\n"),
      schema: MendSchema, temperature: 0.1, maxTokens: 2048, attemptTag: tagged(opts.attemptTag, "wording"),
    });
  } catch (error) {
    // An answer that is not the copy asked for, or a refusal the same request would meet again (each provider words
    // its own), leaves the first copy: a mend that cannot be had must not hold the item back. Its receipt stays failed
    // (seen on the runs page, and asked again the next time the item is analysed); a busy provider is tried again later.
    const kind = failureKind(error);
    if (kind === "unusable" || kind === "refused") return w;
    throw error;
  }
  const copy = finalizeCopy(t, { titleZh: res.data.titleZh, summaryZh: res.data.summaryZh });
  const mended = { titleZh: copy.titleZh, summaryZh: copy.summaryZh, reasonZh: w.reasonZh === null ? null : res.data.reasonZh || w.reasonZh };
  const paid = { receiptIds: [...w.receiptIds, res.receiptId], reused: w.reused && res.reused };
  // A guard that emptied the title or summary (a company the input does not name), a number changed or dropped, or
  // no fewer such words: the first copy stands.
  const numbers = (c: { titleZh: string; summaryZh: string; reasonZh: string | null }) => (`${c.titleZh} ${c.summaryZh} ${c.reasonZh ?? ""}`.match(/\d+(?:[.,]\d+)*/g) ?? []).sort().join(" ");
  if (!mended.titleZh || !mended.summaryZh || numbers(mended) !== numbers(w) || wordingProblems(mended).length >= problems.length) return { ...w, ...paid };
  return { ...w, ...mended, identityGuard: copy.identityGuard ?? w.identityGuard, ...paid };
}

/** The title/summary prompts (articles, long and short posts). */
async function runSummarize(a: AnalyzeInputArticle, opts: StepOpts): Promise<NonNullable<AnalysisRun["writing"]>> {
  const t = translateInputOf(a);
  const isX = t.sourceKind === "x_search";
  const short = isShortTweetInput(t);
  const main = collapseWhitespace(t.mainText || t.title);
  const plain = { reasonZh: null, receiptIds: [] as number[], reused: true };
  // A short post already in Chinese is its own copy, and too little text is not written up from a title.
  if (short && !needsShortTweetTranslation(main)) return { kind: "verbatim", model: null, titleZh: main, summaryZh: main, ...plain };
  if (!short && t.text.trim().length < 20) return { kind: "none", model: null, titleZh: looksZh(t.title) ? t.title : "", summaryZh: "", ...plain };
  const route = await modelRoute("summarize");
  checkAnalysisRunning();
  const res = await chatJson({
    ...route,
    purpose: "summarize_article",
    subject: subjectOf(a),
    promptVersion: PROMPT_VERSIONS.summarize,
    system: "",
    user: short ? buildShortTweetPrompt(t) : isX ? buildLongTweetPrompt(t) : buildArticlePrompt(t),
    schema: SummarizeSchema,
    json: false,
    parse: parseTranslateOutput,
    temperature: 0.2,
    maxTokens: 2048,
    attemptTag: tagged(opts.attemptTag, "summarize"),
  });
  const p = res.data;
  const draft = short
    ? { titleZh: p.titleZh || (looksZh(main) ? main : ""), summaryZh: p.bodyZh || p.summaryZh }
    : isX
      ? { titleZh: p.titleZh, summaryZh: p.summaryZh || p.bodyZh }
      : { titleZh: p.titleZh || (looksZh(t.title) ? t.title : ""), summaryZh: p.summaryZh };
  const copy = finalizeCopy(t, draft);
  return { kind: "summarize", model: res.model, titleZh: copy.titleZh, summaryZh: copy.summaryZh, reasonZh: null, identityGuard: copy.identityGuard, receiptIds: [res.receiptId], reused: res.reused };
}

/** Only a title, and no displayable original post: nothing to judge until a material revision arrives. */
export function awaitsMaterial(a: AnalyzeInputArticle): boolean {
  return missingEvidence(a) && !originalPostCopy(a.xPost, a.url);
}

/**
 * The mean of the calls actually made, or null when there is no verdict to average (a refusal, or no
 * score at all). One decisive verdict is its own mean, which is what lets the learning track's one-call
 * path and the news track's two-call path share the same rule.
 */
function scoreMean(scores: AnalysisRun["scores"]): number | null {
  if (!scores || scores.refused || scores.values.length === 0 || scores.values.length > SCORE_CALLS) return null;
  return scores.values.reduce((total, v) => total + v, 0) / scores.values.length;
}

/** The score shown: the calls' mean, floored (it never decides a half point on its own). */
export function shownScore(scores: AnalysisRun["scores"]): number | null {
  const mean = scoreMean(scores);
  return mean === null ? null : Math.floor(mean);
}

/**
 * The selection rule on the scores: their mean reaches the source tier's threshold (or `threshold`, when
 * an evaluation sweeps it). The item must also pass relevance (normalizeAnalysis).
 */
export function scoresSelect(scores: AnalysisRun["scores"], threshold = scores?.threshold ?? null): boolean {
  const mean = scoreMean(scores);
  return mean !== null && threshold !== null && mean >= threshold;
}

/** Runs the steps on the material as it is (or reuses their receipts) without writing business results. */
export async function runAnalysis(a: AnalyzeInputArticle, opts: StepOpts = {}): Promise<AnalysisRun> {
  checkAnalysisRunning();
  // Missing article text waits for a later revision, before any paid step; displayable original posts keep their judgement.
  if (awaitsMaterial(a)) return { prefilter: null, scores: null, writing: null, structure: null };
  const prefilter = await runSelectionPrefilter(a, opts);
  if (prefilter.label === "BLOCK") return { prefilter, scores: null, writing: null, structure: null };
  const original = originalPostCopy(a.xPost, a.url);
  // The structure step needs nothing from the scores: it runs beside them.
  const structure = runStructure(a, opts).then((value) => ({ value }), (error: unknown) => ({ error }));
  try {
    const scores = await runSelectionScores(a, opts);
    const mean = scoreMean(scores);
    const near = scoresSelect(scores) || (mean !== null && mean > UNDERSTAND_FLOOR);
    const s = await structure;
    if ("error" in s) throw s.error;
    const writing: NonNullable<AnalysisRun["writing"]> = original
      ? { kind: "verbatim", model: null, titleZh: original.title, summaryZh: original.summary ?? "", reasonZh: null, receiptIds: [], reused: true }
      : await mendWording(a, (near ? await runUnderstand(a, opts) : null) ?? (await runSummarize(a, opts)), opts);
    return { prefilter, scores, writing, structure: s.value };
  } finally {
    // A score/writing error or deploy must not let the job finish while a paid structure request
    // still owns a response. It settles and stores its receipt before shutdown can close the DB.
    await structure;
  }
}

/** One judgement from the steps: the selection rule, the reader-facing copy and the structure. */
export function normalizeAnalysis(run: AnalysisRun) {
  const label = run.prefilter?.label;
  const titleZh = collapseWhitespace(run.writing?.titleZh ?? "");
  const summaryZh = (run.writing?.summaryZh ?? "").trim();
  // Original posts can consist entirely of media. Model-written copy still needs a title and summary.
  const relevance = label === "BLOCK" ? "block" : !run.writing || !titleZh || (!summaryZh && run.writing.kind !== "verbatim") ? "unknown" : "pass";
  const values = run.scores && !run.scores.refused ? run.scores.values : null;
  const score = shownScore(run.scores);
  const threshold = run.scores?.threshold ?? null;
  // The learning track's boundary level is not an auto-decision: it is held for a human in the review
  // queue. `hit` still selects and `miss` still rejects on the one call; only `edge` waits.
  const review = run.scores?.level === "edge";
  const selected = relevance === "pass" && scoresSelect(run.scores) && !review;
  const kinds = run.scores?.kinds ?? [];
  const subjects = run.structure?.subjects ?? [];
  const tags = [...(run.structure?.tags ?? [])];
  for (const s of subjects) {
    const display = ENTITIES[s]?.displayTag;
    if (display && !tags.includes(display)) tags.push(display);
  }
  return {
    relevance,
    selected,
    review,
    score,
    scores: values,
    scoreModel: run.scores?.model ?? null,
    scoreRefused: run.scores?.refused ?? false,
    threshold,
    kinds,
    category: run.structure?.category ?? null,
    tags,
    subjects,
    titleZh,
    summaryZh,
    reasonZh: run.writing?.reasonZh ?? null,
    scope: run.structure?.scope ?? "unknown",
    fact: run.structure?.fact ?? null,
  };
}

export interface AnalyzeResult {
  analysisId: number | null;
  stale: boolean;
  /** The article page is to be fetched first; nothing was committed. */
  needsBody?: boolean;
  output: ReturnType<typeof normalizeAnalysis> | null;
  receiptIds: number[];
  reused: boolean;
}

/**
 * Analyses the current revision and commits the judgement. A result computed for an older revision
 * is kept for traceability but never overwrites a newer input (stale = true).
 */
export async function analyzeArticle(articleId: string, opts: StepOpts = {}): Promise<AnalyzeResult | null> {
  const input = await loadAnalyzeInput(articleId);
  if (!input) return null;
  // Its page first; extraction queues the analysis again (normally the queue already routed it there).
  if (waitsForPage(input)) return { analysisId: null, stale: false, needsBody: true, output: null, receiptIds: [], reused: true };
  const run = await runAnalysis(input, opts);
  const out = normalizeAnalysis(run);
  const receiptIds = [
    ...(run.prefilter ? [run.prefilter.receiptId] : []), ...(run.scores?.receiptIds ?? []), ...(run.writing?.receiptIds ?? []),
    ...(run.structure ? [run.structure.receiptId] : []),
  ];
  const w = run.writing;
  const detail = {
    prefilter: run.prefilter && { label: run.prefilter.label, reason: run.prefilter.reason },
    scores: out.scores, scoreModel: out.scoreModel, threshold: out.threshold, ...(out.scoreRefused ? { scoreRefused: true } : {}),
    ...(out.kinds.length ? { learningKinds: out.kinds } : {}),
    ...(out.review ? { review: true } : {}),
    ...(w ? { writer: w.kind, writerModel: w.model, itemType: w.itemType ?? null, authorRole: w.authorRole ?? null } : {}),
    ...(w?.identityGuard?.outcome === "fallback" ? { identityGuard: w.identityGuard } : {}),
    scope: out.scope, fact: out.fact,
  };
  const committed = await sql.begin(async (tx) => {
    const [current] = await tx<{ revision: number }[]>`SELECT revision FROM articles WHERE id = ${articleId} FOR UPDATE`;
    const stale = !current || current.revision !== input.revision;
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO analyses (article_id, input_revision, origin, model, prompt_version, receipt_ids, relevance, category, tags,
        subjects, title_zh, summary_zh, reason_zh, score, selected, output)
      VALUES (${articleId}, ${input.revision}, 'model', ${w?.model ?? run.prefilter?.model ?? null}, ${analyzePromptVersion(trackOf(input.source.tags))}, ${receiptIds},
        ${out.relevance}, ${out.category}, ${out.tags}, ${out.subjects}, ${out.titleZh}, ${out.summaryZh}, ${out.reasonZh},
        ${out.score}, ${out.selected}, ${tx.json(detail as never)})
      RETURNING id`;
    for (const id of receiptIds) await completeReceipt(tx, id);
    if (!stale) {
      await tx`UPDATE articles SET processing_state = ${out.relevance === "block" ? "blocked" : "analyzed"}, processing_error = NULL WHERE id = ${articleId}`;
    }
    return { analysisId: row!.id, stale };
  });
  const reused = (run.prefilter?.reused ?? true) && (run.scores?.reused ?? true) && (w?.reused ?? true) && (run.structure?.reused ?? true);
  return { analysisId: committed.analysisId, stale: committed.stale, output: out, receiptIds, reused };
}
