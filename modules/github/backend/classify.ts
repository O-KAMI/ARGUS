// AI project recognition: rules over GitHub topics, the description and the name (方案 3 节). No model call
// — a reader's page never triggers one and collection stays free, explainable and debuggable. Every result
// carries the reasons it was reached from, and an administrator's manual override always wins.
import type { AiCategory, ClassificationMethod } from "../contract.ts";

export interface AiTopic {
  topic: string;
  category: AiCategory;
}

/**
 * The topic query library (方案 2.3). Each entry is queried on its own against the Search API and also
 * counts as evidence when a repository carries the topic. Adding, dropping or re-categorising a topic is a
 * change here and nowhere else in collection; `GITHUB_AI_TAXONOMY_VERSION` names the rules a row was
 * classified with, so a later version can be re-run over the old rows.
 */
export const AI_TOPIC_LIBRARY: readonly AiTopic[] = [
  // AI / ML 基础
  { topic: "artificial-intelligence", category: "llm" },
  { topic: "machine-learning", category: "llm" },
  { topic: "deep-learning", category: "llm" },
  // LLM / 生成式 AI
  { topic: "llm", category: "llm" },
  { topic: "llms", category: "llm" },
  { topic: "large-language-models", category: "llm" },
  { topic: "generative-ai", category: "app" },
  // Agent
  { topic: "ai-agent", category: "agent" },
  { topic: "ai-agents", category: "agent" },
  { topic: "agentic-ai", category: "agent" },
  { topic: "autonomous-agents", category: "agent" },
  // MCP
  { topic: "mcp", category: "mcp" },
  { topic: "model-context-protocol", category: "mcp" },
  { topic: "mcp-server", category: "mcp" },
  // RAG / 知识库
  { topic: "rag", category: "rag" },
  { topic: "retrieval-augmented-generation", category: "rag" },
  { topic: "vector-database", category: "rag" },
  { topic: "embeddings", category: "rag" },
  // 模型推理
  { topic: "inference", category: "infra" },
  { topic: "model-serving", category: "infra" },
  { topic: "ollama", category: "infra" },
  { topic: "vllm", category: "infra" },
  // 模型训练
  { topic: "fine-tuning", category: "training" },
  { topic: "lora", category: "training" },
  { topic: "model-training", category: "training" },
  // 多模态
  { topic: "multimodal", category: "multimodal" },
  { topic: "computer-vision", category: "multimodal" },
  { topic: "speech-recognition", category: "multimodal" },
  { topic: "stable-diffusion", category: "multimodal" },
  { topic: "diffusion-models", category: "multimodal" },
  // AI 开发框架
  { topic: "langchain", category: "devtools" },
  { topic: "llamaindex", category: "devtools" },
  { topic: "transformers", category: "devtools" },
  { topic: "coding-agent", category: "devtools" },
  { topic: "code-assistant", category: "devtools" },
];

/** The distinct topics the collector queries, in the library's order. */
export const AI_TOPIC_QUERIES: readonly string[] = [...new Set(AI_TOPIC_LIBRARY.map((entry) => entry.topic))];

const TOPIC_CATEGORY = new Map(AI_TOPIC_LIBRARY.map((entry) => [entry.topic, entry.category]));

/**
 * Topics that say "AI" without saying what the project does. On their own they are not enough (方案 3.2 排除信号:
 * "Topic 过于宽泛，且 Description / README 无法证明其 AI 属性"); they need a specific topic or the description.
 */
const BROAD_TOPICS = new Set(["ai", "ml", "artificial-intelligence", "machine-learning", "deep-learning", "nlp"]);

/** A description or name pattern, the categories it argues for and how much it is worth. */
interface Signal {
  pattern: RegExp;
  categories: AiCategory[];
  weight: number;
}

const DESCRIPTION_SIGNALS: readonly Signal[] = [
  { pattern: /\bmcp\b|model context protocol/i, categories: ["mcp"], weight: 0.6 },
  { pattern: /\b(?:ai|llm|autonomous|multi)[\s-]?agents?\b|\bagentic\b/i, categories: ["agent"], weight: 0.55 },
  { pattern: /\brag\b|retrieval[\s-]augmented|vector (?:database|db|store|search)|\bembeddings?\b/i, categories: ["rag"], weight: 0.5 },
  { pattern: /\bllms?\b|large language model|language models?\b/i, categories: ["llm"], weight: 0.55 },
  { pattern: /\binference\b|model serving|\bvllm\b|\bollama\b|\bgpu\b[^.]{0,40}\b(?:kernels?|optimi|runtime)/i, categories: ["infra"], weight: 0.5 },
  { pattern: /fine[\s-]?tun|\blora\b|\bqlora\b|\bpeft\b|\brlhf\b|pre[\s-]?train|model training/i, categories: ["training"], weight: 0.5 },
  { pattern: /multi[\s-]?modal|computer vision|image generation|text[\s-]to[\s-](?:image|speech|video)|speech (?:recognition|synthesis)|stable diffusion|diffusion model|\bocr\b|\bwhisper\b/i, categories: ["multimodal"], weight: 0.5 },
  { pattern: /coding agent|code assistant|ai (?:ide|coding|pair program)|\bcopilot\b|prompt (?:engineering|management|tooling|template)/i, categories: ["devtools"], weight: 0.5 },
  { pattern: /\bchatbot\b|\bassistant\b|generative ai (?:app|application)|\bai app(?:lication)?\b/i, categories: ["app"], weight: 0.35 },
  { pattern: /\btransformers?\b|\bpytorch\b|\btensorflow\b|\bkeras\b|\bonnx\b/i, categories: ["llm", "training"], weight: 0.25 },
];

/** A resource list, a course or a paper index: AI-related, but never an Agent or a model framework (方案 3.2). */
const RESOURCE_PATTERN = /^(?:awesome[\s-]|\u2764|\ud83d\udcda)|\b(?:awesome|curated) (?:list|lists)\b|\bpapers? list\b|\breading list\b|\btutorials?\b|\bcourses?\b|\broadmap\b|\bhandbook\b|\bresources?\b|\bcheatsheet\b/i;

/** A repository name that carries an AI word of its own, worth less than the description. */
const NAME_SIGNAL = /\b(?:ai|llm|gpt|agent|mcp|rag|ml|nlp|diffusion|transformer)\b/i;

export interface ClassificationInput {
  fullName: string;
  description: string | null;
  /** The topics GitHub reports on the repository. */
  topics: string[];
  /** The topic queries that found it, kept for the admin to see why it is a candidate (方案 2.3 规则 3). */
  matchedTopics: string[];
  manualOverride: "include" | "exclude" | null;
}

export interface Classification {
  isAi: boolean;
  primaryCategory: AiCategory | null;
  categories: AiCategory[];
  method: ClassificationMethod;
  /** 0…1, to three places: how much of the evidence was specific. */
  confidence: number;
  matchedTopics: string[];
  /** The rules that fired, in the order they did; shown in the repository detail so a result is explainable. */
  reasons: string[];
}

const CATEGORY_ORDER: readonly AiCategory[] = ["agent", "mcp", "llm", "rag", "infra", "training", "multimodal", "devtools", "app", "resources"];

/** The primary category is the first of the taxonomy's own order the evidence reached (方案 3.3). */
function primaryOf(categories: Set<AiCategory>): AiCategory | null {
  return CATEGORY_ORDER.find((category) => categories.has(category)) ?? null;
}

/**
 * Classifies one repository. `topic` when a specific topic decided it, `description` when the description
 * or the name did, `manual` when an administrator did — and an administrator's word is never overruled by
 * a later run (方案 3.4).
 */
export function classifyRepository(input: ClassificationInput): Classification {
  const matchedTopics = [...new Set([...input.matchedTopics, ...input.topics.filter((topic) => TOPIC_CATEGORY.has(topic) || BROAD_TOPICS.has(topic))])].sort();
  const reasons: string[] = [];

  if (input.manualOverride === "exclude") {
    return { isAi: false, primaryCategory: null, categories: [], method: "manual", confidence: 1, matchedTopics, reasons: ["管理员手工排除"] };
  }

  const categories = new Set<AiCategory>();
  let score = 0;
  const specificTopics: string[] = [];
  for (const topic of input.topics) {
    const category = TOPIC_CATEGORY.get(topic);
    if (!category) continue;
    if (BROAD_TOPICS.has(topic)) {
      score += 0.15;
      continue;
    }
    specificTopics.push(topic);
    categories.add(category);
    score += 0.5;
    reasons.push(`Topic ${topic}`);
  }

  const description = input.description ?? "";
  let descriptionHit = false;
  for (const signal of DESCRIPTION_SIGNALS) {
    if (!signal.pattern.test(description)) continue;
    descriptionHit = true;
    score += signal.weight;
    for (const category of signal.categories) categories.add(category);
    reasons.push(`简介命中 ${signal.pattern.source.slice(0, 48)}`);
  }

  const [, repoName] = input.fullName.split("/");
  if (NAME_SIGNAL.test(repoName ?? "")) {
    score += 0.15;
    descriptionHit = true;
    reasons.push(`仓库名 ${repoName} 含 AI 词`);
  }

  const isResource = RESOURCE_PATTERN.test(description) || RESOURCE_PATTERN.test(repoName ?? "");
  if (isResource) {
    // A list, a course or a paper index stays on the AI boards, but under its own category: it is not the
    // Agent framework or the model its title happens to name (方案 3.2 排除信号).
    categories.clear();
    categories.add("resources");
    score = Math.min(score, 0.75);
    reasons.push("资源清单 / 教程，归入 AI 资源");
  }

  const hasSpecificTopic = specificTopics.length > 0;
  const broadOnly = !hasSpecificTopic && input.topics.some((topic) => BROAD_TOPICS.has(topic));
  // A broad topic with nothing to back it up is the "mentioned AI in passing" case the plan excludes.
  const isAi = input.manualOverride === "include" ? true : hasSpecificTopic || (descriptionHit && score >= 0.5) || (broadOnly && descriptionHit && score >= 0.65);

  if (input.manualOverride === "include") reasons.unshift("管理员手工纳入");
  if (broadOnly && !descriptionHit) reasons.push(`只有宽泛 Topic（${input.topics.filter((t) => BROAD_TOPICS.has(t)).join(", ")}），简介没有佐证，不纳入`);

  const confidence = input.manualOverride ? 1 : Math.min(Math.round(score * 1000) / 1000, 0.99);
  const method: ClassificationMethod = input.manualOverride ? "manual" : hasSpecificTopic ? "topic" : "description";
  const kept = isAi ? (isResource ? new Set<AiCategory>(["resources"]) : categories) : new Set<AiCategory>();
  if (isAi && kept.size === 0) kept.add("app");
  return {
    isAi,
    primaryCategory: isAi ? primaryOf(kept) : null,
    categories: isAi ? CATEGORY_ORDER.filter((category) => kept.has(category)) : [],
    method,
    confidence,
    matchedTopics,
    reasons,
  };
}
