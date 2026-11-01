# 事件归组与关系评测

站点先用标题和摘要召回最近两周的候选事实（配了向量服务时比向量，没配时比文字重合度），再让模型判断报道之间的关系，同时判断这篇报道相对精选里已有的内容有没有新信息（分数够了的报道要靠这一条才进精选，见 [精选与校准](selection.md)）。关系定义和站点实际使用的提示词在 `industry/prompts/group-*.md`，代码入口在 `packages/backend/src/events/relate.ts` 和 `group.ts`。

四种关系是：

- `SAME_OCCURRENCE`：同一次真实发生，例如同一发布的官方原文和媒体报道。
- `SAME_STORY`：不是同一次发生，但属于同一具体事件的直接进展，例如发布后的上架、评测或回应。
- `UNRELATED`：不同的事，即使主体、产品或话题相同。
- `ROUNDUP`：其中一方是包含多个话题的汇总。

## 用自己的标注样本评测两两关系判断

`scripts/eval-relations.ts` 只评测模型对两篇报道之间关系的判断。它直接复用站点归组时用的 `PAIR_SYSTEM`、`pairUser()`、`PairSchema` 和提示词版本，因此提示词变了，评测也跟着变。它不重新跑候选召回，也不把结果写回事件归组。

把自己的标注数据放在 `.data/` 下（该目录不会提交到 Git）。`industry/relation-gold.example.jsonl` 给了四条虚构示例。每行一条：

```json
{"caseId":"release-001","a":{"title":"...","source":"...","firstParty":true,"publishedAt":"2026-09-01T09:00:00+08:00","summary":"..."},"b":{"title":"...","source":"...","firstParty":false,"publishedAt":"2026-09-01T09:20:00+08:00","summary":"..."},"samplingContext":{"benchmarkSplit":"development","samplingStratum":"same-release"},"gold":{"relation":"SAME_OCCURRENCE"}}
```

`a`、`b` 也可以带和站点内部 `ReportView` 一致的可选 `frame`：

```json
{"subject":"Acme","action":"发布","object":"Acme-2","occurredAt":"2026-09-01"}
```

建议把容易混淆的边界样本放进开发集，再留一部分 `benchmarkSplit: "holdout"` 最后检查。`samplingStratum` 是可选的分组标签，用来看错在哪一类，不影响模型输入。

### 运行

先按正常部署方式配置数据库和模型，再运行：

```bash
node --env-file=.env scripts/eval-relations.ts \
  --gold .data/relation-gold.jsonl \
  --split development
```

默认使用“归组复核”这一步当前的模型：后台“模型与评测”页切换过的优先，其次是环境变量 `GROUP_REVIEW_MODEL`，再其次是 `site/models.ts` 的 `DEFAULTS.groupReview`，都没有就用默认模型。也可以显式比较多个已配置的模型：

```bash
node --env-file=.env scripts/eval-relations.ts \
  --gold .data/relation-gold.jsonl \
  --models default,deepseek-flash \
  --split development \
  --n 200 \
  --seed 7 \
  --thresholds 0.75,0.8
```

可用参数：

| 参数 | 默认值 | 说明 |
|---|---:|---|
| `--gold` | `.data/relation-gold.jsonl` | 标注样本文件（JSONL） |
| `--models` | “归组复核”当前的模型 | 逗号分隔的模型名 |
| `--split` | `all` | `development`、`holdout` 或自己定的分组 |
| `--n` | `200` | 最多评测多少条 |
| `--seed` | `7` | 抽样用的随机种子，种子相同，每次抽到的样本相同 |
| `--concurrency` | `6` | 同时发出的模型请求数 |
| `--thresholds` | production 的 `STORY_REVIEW_MIN_CONFIDENCE,TIE_MIN_CONFIDENCE` | 判断两篇报道“连进同一事件”时用的置信度门槛；显式传参会覆盖默认值 |

完整报告写到 `.data/eval/relations-*.json`。每个模型会得到：

- 4 × 4 的对照表：每种标注关系被模型判成了哪种关系；
- 每种关系的查准率、查全率、F1 和样本数（只统计成功得到结构化判断的样本）；
- `coverage`：成功得到结构化判断的样本占全部金标样本的比例；
- `accuracy` 与四类 macro-F1：只衡量成功得到结构化判断后的判断质量；`completeAccuracy` 则用全部金标样本作分母，把调用失败或回答不合格式也算作没有正确完成；
- 把 `SAME_OCCURRENCE`、`SAME_STORY` 都算作“连进同一事件”时，各个置信度门槛下的查准率、查全率和 F1，同时给出同一批样本的 `coverage` 与 `completeAccuracy`；
- 调用出错的条数、token 用量、每次请求的平均耗时和整次评测的总耗时；
- 每条样本的判断、置信度、模型写的差别说明（`difference`）和回执编号。

模型调用照常经过回执和预算熔断。相同模型、提示词和输入的重复评测会复用已有回执；同一次运行中输入相同的样本共享一次请求结果，各自按自己的标注计分，失败也共享，不在这次运行里重复请求。报告里的 `reused` 包括共享的成功或失败结果，以及复用的已有成功回执。评测的回执用单独的用途 `eval_relation_pair`，不计入站点归组那几步在后台的统计。

token 用量和平均耗时按报告引用的回执对应的全部请求尝试汇总，包括之前解析失败的响应；同一张回执不会因为多条样本重复计算。用已有结果重跑时仍显示这些历史用量，不代表这次新增的费用。

CI 检查 JSONL 解析、固定种子的抽样、各项指标，以及本地假模型服务下的并发复用和重试用量统计，不访问外部模型服务。

## 资产身份键与学习轨归并口径（2026-10-31 起）

### 问题

同一个 GitHub 仓库 / skill / 教程被 5 个大佬分别推荐 → 5 篇不同 URL 的帖子、5 个不同的"发生" → 精选里出现 5 条重复。原有的语义召回问的是"是否同一次发生"，帧是 `{subject, action, object, occurredAt}`，答不了这个问题；而且 `recallFacts` 只看 14 天，一个月内被反复推荐的同一个资产会跨窗口漏合并。

### 确定性锚点：`articles.asset_key`

入库时从正文与 `x_post`（含被引用帖）正则抽**主外链资产**，经 `lib/url.ts normalizeUrl` 归一后写键：`gh:owner/repo`、`hf:owner/repo`、`npm:<pkg>`、`pypi:<pkg>`、`url:<normalized>`。实现在 `packages/backend/src/lib/asset-key.ts`，接线在 `content/materials.ts assetOf()`，回填脚本 `scripts/backfill-asset-key.ts`。

**纯正则、零模型调用，且在采集入库时完成**——不违反"页面打开不得触发模型调用"。社交域名与帖子自身永久链接被排除（`NOT_AN_ASSET` 在点边界匹配并允许带 TLD，所以 `mobile.twitter.com` 排除、`next.com` 不排除）。抽取顺序：gh → hf → npm → pypi → 第一个归一后非社交且不等于自身 URL 的外链。

**为什么不复用 `identity_key`**：它是材料自身的全局身份、驱动修订判定。把两篇不同帖子写成同一个 `identity_key` 会让其中一篇变成另一篇的修订版、内容被覆盖——那是错的。两篇帖子都该存在，在 **fact 层**合并。

`asset_key` 变化视为修订（同一篇帖子后来补上了仓库链接），走既有 `recheckSelection` / `resetAutomatic` 路径，不新写状态机。

### 归并口径

`events/recall.ts relatedPosts()` 增 `sameAsset` 查询，与 `sameUrl` 同构（跨源、`fa.role IN ('primary','report')`、`st.merged_into IS NULL`、`groupingEvidenceCondition`），但**不受 14 天召回窗口限制**（精确键查找）。`events/group.ts decide()` 把 `sameAsset` 与 `sameUrl` 同等对待，产出 verdict `same-asset`，并同样参与代表席位（`publications.seat`）判定。

### 语义兜底

新增 `group-batch-learning.md` / `group-pair-learning.md`（及配套 `-learning` 定义与方法文件）：判定问题从"是否同一次发生"改为"**是否指向同一个资产 / 同一份教程 / 同一个玩法**"，帧从 `{subject, action, object, occurredAt}` 改为 `{asset, assetKind, author, whatItOffers}`。跨平台同内容（同一条 X + 同一个 bilibili 教程）只能靠这条路径，属**尽力而为**，不做确定性保证。

**必须是独立文件，不能用 `{{track}}` 值参数化**：`editorial/prompts.ts promptVersion` 只对**文件内容**做哈希、不含填入的值。值参数化会让两种不同措辞产生同一个版本号，回执与后台模型页就无法区分是哪套措辞产出的结果。新闻轨的 `group-batch.md` / `group-pair.md` / `group-definitions.md` / `group-method.md` **一字未改**，其内容哈希、历史回执与可比性全部保留。

成本：资产键抽取零成本；语义归并复用现有 `group` 路由与回执，**不新增调用次数**（同一批候选一次判定）。

### 前台折叠：按资产键折成一张卡

归并只解决"两篇是不是同一件事"，它要付模型调用、要等后台跑完、还受 14 天窗口影响；已经入库的存量文章用的仍是新闻轨口径，重新归并是逐篇付费的操作，尚未执行。前台的精选列表因此另有一条**不依赖归并结果**的折叠：同一个 `asset_key` 的几篇入选内容折成一张卡。

`publication/timeline.ts` 给每张卡算一个分组键 `gk`，优先级从高到低：

| 前缀 | 分组依据 | 什么时候用 |
|---|---|---|
| `k` | `articles.asset_key` | 帖子点名了某个资产，且这篇在折叠条件下（`foldableSelectionCondition`） |
| `f` | `publications.fact_id` | 归并判成了同一条新闻，且这篇是该新闻自己的证据（`ownFactEvidenceCondition`） |
| `a` | `article_id` | 都不满足：独立成卡 |

资产优先于新闻——两篇推荐同一个仓库的帖子即使被归并判成了同一条新闻，也按资产折叠。这样存量文章不必等重归并就能在页面上合并。

展开卡片调 `GET /api/site/groups/reports?fact=<public_id>` 或 `?asset=<asset_key>`（`publication/groups.ts`）。分组写在查询串而不是路径里，因为资产键带斜杠、`url:` 命名空间下甚至是一整个网址。两种键都过白名单：`fact` 必须匹配 `^[\w-]{1,64}$`，`asset` 必须是 `lib/asset-key.ts isAssetKey()` 认得的五个命名空间之一、不含控制字符。两者必须恰好给一个，给错直接 404。

详情页（`publication/detail.ts`）用同一套优先级算 `group`，从折叠卡点进去的读者看到的是同一个组。

卡上的文案按 `kind` 分开：新闻数**家**（"另外 N 家也报道了"），资产数**篇**（"另外 N 篇也推荐了它"）——推荐同一个仓库的是不同的人，不是不同的媒体。

**已知限制**：一篇有资产键的文章仍会同时出现在它所属新闻的展开列表里（`groupPool` 的 fact 查询没有排除资产键）。这是刻意保留的——新闻轨的行为因此与折叠改动前逐字节一致，代价是极少数情况下同一篇会在两处列出。
