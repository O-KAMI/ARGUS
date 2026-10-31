// 精选的门槛。评分标准本身写在 prompts/selection-score.md；这里只决定“多少分算入选”。
// 每篇资料由评分模型独立打两次分（0–100），两次之和 ≥ 2 × 门槛才成为精选候选；
// 确认新闻身份与新增价值后，由发布规则决定展示（见 docs/selection.md），卡片上显示两次的平均分。
// 门槛按信源分级区分：官方一手信源的门槛低一些，媒体和个人的高一些。改了门槛或评分提示词，
// 用 scripts/eval-selection.ts 在你自己标注的样本上重跑一遍，再决定上线（见 docs/selection.md）。

export const SELECTION = {
  /**
   * 信源分级 → 入选门槛（平均分）。分级在后台“信源”里给每个源设置：
   *   T1 官方一手（官网、官方博客、机构）· T1_5 官方账号、准官方创作者 · T2 媒体与个人
   * 分级 EXCLUDE_MP 以及这里没有列出的分级，不参与精选评分（只进“全部动态”）。
   */
  thresholds: { T1: 60, T1_5: 65, T2: 76 } as Record<string, number>,
  /**
   * 没入选、但平均分高于这个数的资料，也用精选的写法（内容理解：标题、摘要、推荐理由）来写，
   * 其余用更便宜的“标题摘要翻译”。
   */
  understandFloor: 50,
  /**
   * 学习轨：判的不是新闻热度，而是“这条能不能提高站点主人的 AI 水平”。评分标准写在
   * prompts/selection-score-learning.md，模型只回答三档，由 levels 映射成分数，于是
   * “两次独立调用 + 两次之和 ≥ 2 × 门槛”这条既有规则一字不改地复用：
   *   门槛 60（当前）＝两次都不低于 edge · 75 ＝至少一次 hit 且另一次不低于 edge · 90 ＝两次都 hit
   * 学习轨的源都是主人本人关注的实践者，信任级同级，所以门槛不按 tier 分档。
   */
  learning: {
    threshold: 60,
    levels: { hit: 90, edge: 60, miss: 20 },
  },
} as const;

/** 学习轨的内容类型，与 prompts/selection-score-learning.md 的 kinds 表一一对应（单一来源，别只改一处）。 */
export const LEARNING_KINDS = [
  "skill_playbook", "asset_release", "oss_ecosystem", "monetization_fde", "tutorial_explainer",
  "principles_internals", "knowledge_base", "ai_video", "new_play", "opinion_insight", "news_like",
] as const;

export type LearningKind = (typeof LEARNING_KINDS)[number];

export type LearningLevel = keyof typeof SELECTION.learning.levels;

// 精选分轨。轨道写在 sources.tags 的保留值里（后台“信源”可编辑，seed 也带），不新增列：
//   track:learning 自己关注的实践者，判的是“这条能不能提高我的 AI 水平”
//   track:inherit  镜像来源，直接继承上游自带的精选，本站不做模型判定
// 没有标记的源走原有新闻轨，门槛按 tier（上面的 thresholds）。
// `track:` 是内部路由标记，绝不能进模型上下文（editorial/writing.ts 负责过滤）。
export const TRACK_TAG_PREFIX = "track:";

export const TRACKS = { learning: "track:learning", inherit: "track:inherit" } as const;

export type Track = "learning" | "inherit" | "news";

/** 一个源的轨道：tags 里的 track: 标记；没有标记或标记不认识，都是新闻轨。 */
export function trackOf(tags: readonly string[] | null | undefined): Track {
  if (tags?.includes(TRACKS.learning)) return "learning";
  if (tags?.includes(TRACKS.inherit)) return "inherit";
  return "news";
}
