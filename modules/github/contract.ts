// What the rankings page and the api agree on: the four boards, the AI categories, the filter names and
// the shape of an answer. Plain data and types only, so the web bundle never reaches the module's backend.

/** The four boards, in the order the page's tabs show them. */
export const BOARDS = ["all_weekly", "all_stars", "ai_weekly", "ai_stars"] as const;
export type BoardType = (typeof BOARDS)[number];

/**
 * Each board's own wording. `basis` is the limitation the page must state out loud (方案 13 节): the weekly
 * boards keep GitHub's order, the star boards only reach the Search API's top 1,000 candidates, and the AI
 * weekly board is a filtered subset rather than a scan of every AI repository.
 */
export const BOARD_COPY: Record<BoardType, { label: string; tab: string; basis: string; weekly: boolean }> = {
  all_weekly: {
    label: "全站周榜",
    tab: "全站周榜",
    basis: "排名沿用 GitHub Trending Weekly 官方页面顺序，不按 Star 数重排。",
    weekly: true,
  },
  all_stars: {
    label: "累计 Star 总榜",
    tab: "全站总榜",
    basis: "按 GitHub 公开仓库累计 Star 数排序；候选范围是搜索接口能返回的前 1,000 个仓库，不是全部公开仓库。",
    weekly: false,
  },
  ai_weekly: {
    label: "AI 周榜",
    tab: "AI 周榜",
    basis: "从 GitHub Trending Weekly 中筛选 AI 相关项目，保留官方原始顺序；它是全站周榜的子集，不覆盖 GitHub 上所有 AI 仓库。",
    weekly: true,
  },
  ai_stars: {
    label: "AI 累计 Star 总榜",
    tab: "AI 总榜",
    basis: "基于公开 GitHub Topics 与仓库信息识别 AI 项目，并按累计 Star 数排序；没有打 Topic 标签的 AI 仓库可能被漏掉。",
    weekly: false,
  },
};

/** The AI taxonomy (方案 3.3), in the order the classifier prefers a primary category. */
export const AI_CATEGORIES = [
  "agent", "mcp", "llm", "rag", "infra", "training", "multimodal", "devtools", "app", "resources",
] as const;
export type AiCategory = (typeof AI_CATEGORIES)[number];

export const AI_CATEGORY_LABELS: Record<AiCategory, string> = {
  agent: "AI Agent",
  mcp: "MCP / Skills",
  llm: "LLM / 模型",
  rag: "RAG / 知识库",
  infra: "AI 基础设施",
  training: "模型训练",
  multimodal: "多模态 AI",
  devtools: "AI 开发工具",
  app: "AI 应用",
  resources: "AI 资源 / 教程",
};

/** The page sizes the reader may pick (方案 9.3). */
export const PAGE_SIZES = [20, 50, 100] as const;

/** How a repository got its AI classification, for the detail view and the admin. */
export const CLASSIFICATION_METHODS = ["topic", "description", "manual"] as const;
export type ClassificationMethod = (typeof CLASSIFICATION_METHODS)[number];

/** One row of a board: the repository as the page draws it, plus its two numbers. */
export interface RankingRepository {
  repositoryId: number;
  /** The position on this board, 1-based. */
  rank: number;
  /** GitHub Trending's own position, only on the weekly boards; the AI weekly board shows it beside its own number. */
  sourceRank: number | null;
  fullName: string;
  ownerLogin: string;
  name: string;
  htmlUrl: string;
  description: string | null;
  homepage: string | null;
  language: string | null;
  stargazersCount: number;
  forksCount: number | null;
  topics: string[];
  isAi: boolean;
  aiPrimaryCategory: AiCategory | null;
  aiCategories: AiCategory[];
  isArchived: boolean;
  updatedAt: string | null;
  fetchedAt: string;
}

export interface RankingResponse {
  board: BoardType;
  basis: string;
  items: RankingRepository[];
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
  filters: { language: string | null; category: AiCategory | null; keyword: string | null };
  languages: string[];
  /** The newest successful fetch behind this board; null when it has never succeeded. */
  fetchedAt: string | null;
  /** True while the newest run of the board's source failed, so the board shows the previous result. */
  stale: boolean;
  /**
   * What the served version covers: `partial` is a cold-start candidate list with no complete snapshot
   * yet; null while no attempt has recorded anything.
   */
  coverage: "complete" | "partial" | "empty" | null;
}

export interface CategoryCount {
  category: AiCategory;
  label: string;
  count: number;
}

export interface CategoriesResponse {
  categories: CategoryCount[];
  taxonomyVersion: string;
}

export interface RepositoryBoards {
  board: BoardType;
  label: string;
  rank: number;
  sourceRank: number | null;
}

export interface RepositoryDetail {
  repository: RankingRepository;
  boards: RepositoryBoards[];
  classificationMethod: ClassificationMethod;
  classificationConfidence: number;
  matchedTopics: string[];
  manualOverride: "include" | "exclude" | null;
  taxonomyVersion: string;
  classifiedAt: string | null;
  isFork: boolean;
  openIssuesCount: number | null;
  licenseSpdxId: string | null;
  nodeId: string | null;
  createdAt: string | null;
  pushedAt: string | null;
  lastSeenAt: string;
  syncedAt: string;
}

/** What the admin's status endpoint answers. */
export interface CollectionStatus {
  tokenConfigured: boolean;
  /** The engine's collection valve; closed means refresh answers disabled without any request. */
  collectEnabled: boolean;
  taxonomyVersion: string;
  refreshCron: string;
  repositories: number;
  aiRepositories: number;
  boards: Array<{ board: BoardType; label: string; entries: number; fetchedAt: string | null }>;
  runs: Array<{
    id: string;
    sourceType: "trending" | "search_all" | "search_ai";
    status: "running" | "success" | "partial" | "failed";
    startedAt: string;
    finishedAt: string | null;
    itemsCount: number | null;
    errorMessage: string | null;
    incompleteResults: boolean;
  }>;
}
