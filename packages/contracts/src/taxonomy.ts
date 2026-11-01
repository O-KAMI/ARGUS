// Public vocabularies shared by the website, the API and the worker. The categories themselves belong to
// the industry pack (industry/taxonomy.ts); their keys are external identities (URLs, API, RSS) and never change.
// How the public API, RSS and MCP differ from the website is the site's (site/site.ts PUBLIC_CATEGORIES).
import { CATEGORIES } from "@aihot/industry/taxonomy";
import { PUBLIC_CATEGORIES } from "@aihot/site";

type Category = (typeof CATEGORIES)[number];

export type CategoryKey = Category["key"];
export const CATEGORY_KEYS = CATEGORIES.map((c) => c.key) as unknown as readonly [CategoryKey, ...CategoryKey[]];

/** Website tab labels. */
export const CATEGORY_LABELS = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.label])) as Record<CategoryKey, string>;

const MERGE: Partial<Record<string, string>> = PUBLIC_CATEGORIES.merge;
const FEED_LABELS: Partial<Record<string, string>> = PUBLIC_CATEGORIES.feedLabels;

/** The categories the public API, RSS and MCP know: a merged category is published as the one it joins. */
export type PublicApiCategoryKey = Exclude<CategoryKey, keyof typeof PUBLIC_CATEGORIES.merge>;
export const PUBLIC_API_CATEGORY_KEYS = CATEGORIES.filter((c) => !Object.hasOwn(MERGE, c.key)).map((c) => c.key) as unknown as readonly [PublicApiCategoryKey, ...PublicApiCategoryKey[]];

export function toPublicApiCategory(category: string | null): PublicApiCategoryKey | null {
  const c = CATEGORIES.find((x) => x.key === category);
  if (!c) return null;
  return (MERGE[c.key] ?? c.key) as PublicApiCategoryKey;
}

/** A public category's name in feeds (<category>, a category feed's title): the site's, else the pack's feed label, else its website label. */
export function feedCategoryLabel(key: PublicApiCategoryKey): string {
  const c: { label: string; feedLabel?: string } = CATEGORIES.find((x) => x.key === key)!;
  return FEED_LABELS[key] ?? c.feedLabel ?? c.label;
}

export function isCategoryKey(value: unknown): value is CategoryKey {
  return typeof value === "string" && (CATEGORY_KEYS as readonly string[]).includes(value);
}

export const CHANNEL_KEYS = ["all", "news", "x", "firstParty"] as const;
export type ChannelKey = (typeof CHANNEL_KEYS)[number];

export const CHANNEL_LABELS: Record<ChannelKey, string> = {
  all: "全部",
  news: "资讯",
  x: "X",
  firstParty: "一手",
};

export function isChannelKey(value: unknown): value is ChannelKey {
  return typeof value === "string" && (CHANNEL_KEYS as readonly string[]).includes(value);
}

/**
 * The feed's content-type filter: the FIRST category tag of a report, in reading order. These are the
 * industry's genre tags (industry/taxonomy.ts), named here with the labels the filter menu shows.
 */
export const GENRE_FILTERS = [
  { tag: "教程/实践", label: "教程 / 实践" },
  { tag: "模型发布", label: "模型发布" },
  { tag: "大佬观点", label: "大佬观点" },
  { tag: "产品更新", label: "产品更新" },
  { tag: "现象/趋势", label: "行业趋势" },
  { tag: "行业动态", label: "行业动态" },
  { tag: "论文/研究", label: "论文研究" },
  { tag: "评测/基准", label: "评测 / 基准" },
  { tag: "政策/监管", label: "政策监管" },
  { tag: "开源/仓库", label: "开源项目" },
  // The learning track's content kinds (industry/taxonomy.ts CATEGORY_TAGS): one genre per kind.
  { tag: "Skill/Agent 玩法", label: "Skill / Agent 玩法" },
  { tag: "MCP/工具", label: "MCP / 工具" },
  { tag: "开源生态", label: "开源生态" },
  { tag: "AI 编程", label: "AI 编程" },
  { tag: "AI 变现/FDE", label: "AI 变现 / FDE" },
  { tag: "AI UI/设计", label: "AI UI / 设计" },
  { tag: "原理/机制", label: "原理 / 机制" },
  { tag: "知识库", label: "知识库" },
  { tag: "AI 视频", label: "AI 视频" },
  { tag: "教材/课程", label: "教材 / 课程" },
  { tag: "新玩法灵感", label: "新玩法灵感" },
  { tag: "信息差", label: "信息差" },
] as const;

export type GenreTag = (typeof GENRE_FILTERS)[number]["tag"];

export function isGenreTag(value: unknown): value is GenreTag {
  return typeof value === "string" && GENRE_FILTERS.some((f) => f.tag === value);
}

/** The feed's technical-direction filter: the industry's optional topic tags. */
export const FIELD_FILTERS = [
  { tag: "Agent", label: "Agent / Skills" },
  { tag: "编码", label: "编码 / Vibe Coding" },
  { tag: "推理", label: "推理" },
  { tag: "多模态", label: "多模态" },
  { tag: "语音", label: "语音" },
  { tag: "视频", label: "视频" },
  { tag: "图像生成", label: "图像生成" },
  { tag: "RAG", label: "RAG" },
  { tag: "端侧", label: "端侧 AI" },
  { tag: "数据/训练", label: "数据 / 训练" },
  { tag: "搜索", label: "搜索" },
  { tag: "部署/工程", label: "部署 / 工程" },
  { tag: "开源生态", label: "开源生态" },
  { tag: "具身智能", label: "具身智能" },
  { tag: "MCP/工具调用", label: "MCP / 工具调用" },
  { tag: "设计/交互", label: "设计 / 交互" },
] as const;

export type FieldTag = (typeof FIELD_FILTERS)[number]["tag"];

export function isFieldTag(value: unknown): value is FieldTag {
  return typeof value === "string" && FIELD_FILTERS.some((f) => f.tag === value);
}

/**
 * Where a report came from. Decided once when the report is published and stored on it
 * (backend publication/rules.ts platformOf); the filter reads that column, so a platform no
 * address or account kind reveals (a mirror, GitHub, 知识星球) is still expressible.
 * 前台不出现上游镜像的名字，`aihot` 显示为中性的“行业镜像”。
 */
export const PLATFORM_KEYS = ["all", "x", "aihot", "youtube", "bilibili", "wechat", "github", "zhishixingqiu", "web"] as const;
export type PlatformKey = (typeof PLATFORM_KEYS)[number];

export const PLATFORM_LABELS: Record<PlatformKey, string> = {
  all: "全部来源",
  x: "X",
  aihot: "行业镜像",
  youtube: "YouTube",
  bilibili: "Bilibili",
  wechat: "公众号",
  github: "GitHub",
  zhishixingqiu: "知识星球",
  web: "网站 / RSS",
};

export function isPlatformKey(value: unknown): value is PlatformKey {
  return typeof value === "string" && (PLATFORM_KEYS as readonly string[]).includes(value);
}

/**
 * A report the site mirrors from another catalogue: its Chinese copy, its score and its selection are the
 * catalogue's own, and no model of this site was called for it. A surface says 镜像评分 and 摘要 rather
 * than claiming this site's model wrote them.
 */
export function isMirrored(platform: PlatformKey | null | undefined): boolean {
  return platform === "aihot";
}

/** Article ids. Also the local-data import validation pattern. */
export const ARTICLE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/;
