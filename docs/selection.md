# 精选与校准

## 一条资料怎么变成精选

1. **收进来**：同一网址、同一内容只留一份。普通文章只有标题或摘要时，按信源规则补取正文；视频播放页使用已提供的文字材料，不把播放器页面当正文。没有可信发布时间的资料先不公开，读到原文日期后再判断新旧（见 [信源](sources.md#规则旧文不刷屏) 的“旧文不刷屏”）。
2. **预筛**（`prefilter.md`）：这是不是本行业的事。宽进，只拦明显无关的：`BLOCK` 的资料不出现在任何公开页面；`PASS` 和拿不准的 `UNKNOWN` 继续往下走。只有标题、没有正文、订阅摘要或帖子文字的普通文章先等待材料，不评分、不凭标题写文案，也不进入公开池；材料补齐产生新修订后再判断。可展示的空文字或纯链接原帖沿用原有评分与原样展示规则。
3. **评分**（`selection-score.md`）：新闻轨用同一份评分标准独立打两次分（0–100），**平均分 ≥ 门槛**就够分，门槛按信源分级不同；学习轨只打一次分、答三档，边界档 `edge` 不自动入选而是交人工复核（见 [学习轨](#学习轨三档映射成分数)）。够分的还要过第 6 步的去重才进精选。页面上显示的分数是实际打过的几次调用的平均（向下取整）。
4. **结构化**（`structure.md`）：和评分同时进行。给出分类和标签（页面上显示的就是这一份）、主体公司，判断这篇是一条具体新闻、讲多件事的综合稿，还是材料不够、说不清；是具体新闻的，抽出它的事实（谁、做了什么、对什么、什么时候）和原文里的出处、前提条件。主题页、事件归组和日报都靠它。
5. **写标题摘要**：等结构化完成再写。入选的和差一点入选的（平均分高于 `understandFloor`），按 `content-understanding.md` 写中文标题、答案先行的摘要和推荐理由；其余的按 `summarize-*.md` 写简短的标题摘要，进“全部动态”。X 帖子没有正文或只含链接时，保留原帖的链接、图片和引用，不调用写作或翻译模型，也不生成“请补充正文”的文案；已经取得实际正文的 X 长文照常处理。写好的文字用了 `industry/wording.ts` 里列出的词时，再让模型只改这些词一次（`mend-wording.md`）。
6. **归组与去重**（`group-*.md`）：不同来源报道的同一件事归成一个事件，事件页有综述（`story-digest.md`），“热门”按事件排。修改综述提示词前，可用 [综述评测](story-digest-evaluation.md) 在同一批事件上把现有提示词和候选提示词并排比较。分数够了的资料要等归组完成才进精选：模型同时判断它和精选里已有的报道是不是同一条新闻，以及它有没有精选还没给过的具体信息。
   - 同一条新闻的几篇报道都可以入选：网页上折成一个阅读组；API、RSS 和同步接口每条新闻只出一条，由代表报道出面：官方一手优先；其次是核实过的官方账号（填了 `publisherRole` 和 `owner_entity_id` 的 `T1_5` 账号，新闻的主体正是这家公司，机构先于个人）；再往后是有全文的、分数高的、发得早的。
   - 点名了同一个资产（仓库、模型、包、页面）的几篇内容，网页上**优先按资产折叠**，不看归并结果：`asset_key` 是入库时用正则抽出来的，不花模型调用，所以还没重新归并的存量内容也能合并成一张卡。卡上写的是"另外 N 篇也推荐了它"——推荐同一个项目的是不同的人，不是不同的媒体。折叠优先级与展开接口见 [事件归组](grouping.md#前台折叠按资产键折成一张卡)。
   - 不是同一条新闻、但没有新信息的（换个说法再介绍一遍已经披露的能力、只是上架到别的平台、只重复已选要点的汇总），不进精选，留在“全部动态”。讲多件事的综合稿不单独成事件，只挂到它提到的事件上，有精选没覆盖的重要内容才入选；材料不够、确认不了是哪条新闻的，不进精选。
   - 显式撤回的报道保留历史归属，但不再参与之后的归组召回、候选代表、事件起点或自动事件比较；同网址及 X 回复／引用也不能借它提供身份依据。同一事实仍有有效报道时使用有效稿，全撤回则暂不召回；恢复公开后可重新参与。只展示摘要或尚未发布的记录不等于撤回，保留原有资格。已有关系和判断不删除，不批量重新归组。
   - 确认之前资料只在“全部动态”里，等得再久也不会自动放行。模型调用失败或回答不合格式，这条资料就停在那里：等待超过 10 分钟会告警，后台“运行”页列出这些资料，可以在后台“内容诊断”里打开这条资料，点“重新归组”。所以归组用的模型要能稳定按格式回答。
7. **日报、周报、月报**：
   - **日报**每天 08:00 出（日报、周报、月报的出刊时间在 `site/site.ts` 的 `EDITION_TIMES`，下面按默认值写）。上海日期 D 的刊期为 D，覆盖前一日 00:00 到 D 日 00:00（不含终点），即前一个上海自然日；08:00 只是出刊时间。按规则编排，不调用模型。一件事一条，取报道最多的那条新闻里最权威的一篇，同一事件窗口内的其他进展列在下面，讲多件事的综合稿挂到它提到的最重要那件事下面。最近 7 期报过的不再出现；报过的事件再有进展，只有当事方自己有新动作（教程、观点这类 `commentary` 类别不算）、或这条进展有 4 家以上信源报道时才进正文，其余进快讯。没有报道入选、但有官方原帖并且已有 3 个以上独立参与方的事件也会补进来（只进日报，不进精选、不推送）。按重要性排序（入选报道的最高分、窗口内讨论它的独立参与方、有没有官方原帖，跟进的减分），前 12 条进正文，同一信源最多 2 条，再往后最多 10 条一行快讯。第一条是头条，导语就是它自己的标题和摘要；第 2–4 条是本期看点。
   - **周报**（每周一 10:00）和**月报**（每月 1 日 10:30）由这一周、这个月的日报汇编：同一事件跨天只算一件，按日报给它的位置（头条、看点、上了几天）、报道面和评分排序，周报取前 20 件、月报取前 30 件，按日报的分节分栏目。模型（`report-period.md`、`report-period-sections.md`）只写总述和三件以上栏目的一句导读，不增删条目；它写出了条目里没有的名字或数字（拉丁字母的名称、三位以上或带小数点、百分号的数字、词表里的公司），这段话就不用：总述换成按模板生成的一句，栏目不放导读。行业通用词（`taxonomy.ts` 的 `PLAIN_TERMS`）和站名不受这个限制。
   - 每条精选只进一期：按它的时间算，确认入选比它晚的按确认时间；自然日零点以后才确认的进下一期。切换自然日窗口时，首张新刊与前一旧刊在前一日 00:00–08:00 重叠，仍靠同一事件归组和最近 7 期记忆抑制重复，不改写旧刊。
   - 每半小时检查一次：08:00 到点的刊期出一次，已经出过的不重写；停机错过的、失败的，在之后的检查里按原刊期补上。日报自然日窗口里有资料经过判断、但没有新事件时照常出空刊；没有任何资料经过判断仍算失败。缺期仍在出刊后两小时（默认 10:00）告警，口径见[部署说明](deploy.md#更新)。周报、月报的周期内，应有日报齐全且原始正文条目全部为空时，自动跳过该期，不写空周报或月报、不调用模型，也不记为生成或失败；首个周期从全站最早日报开始检查。没有可汇总条目时，若缺失日报或原有条目后来无法公开，仍保留原有错误。跳过不写永久标记，在现有补刊范围内更正日报后可重新生成。

每一步的提示词都在 `industry/prompts/`，改提示词不用改代码。提示词的版本就是它内容的哈希：改了提示词，之后的新资料按新版判断，已经判过的不会重算。

## 门槛：`industry/selection.ts`

```ts
export const SELECTION = {
  thresholds: { T1: 60, T1_5: 65, T2: 76 },   // 两次评分的平均至少要到这个数
  understandFloor: 50,                        // 平均分高于它的未入选资料，也按入选的写法写
};
```

官方一手信源（T1）门槛低一些，媒体和个人（T2）门槛高一些：同样一件事，官方原文更值得先看。没有门槛的分级（`EXCLUDE_MP`）不参与精选。

这组数是 AIHOT 在 AI 领域一直在用的门槛，偏严：宁可少选几条，也不让噪声进精选。换了行业、改了评分标准，一定要按下面的办法重新校准。

## 校准

### 1. 准备样本集

从你自己的信源里挑 100–200 条资料，一条一条标“该选 / 不该选”，存成 `.data/gold.jsonl`（`.data/` 不进 Git）。每行一条：

```json
{"caseId":"law-001","material":{"title":"原文标题","originalTitle":null,"publishedAt":"2026-10-01T09:00:00+08:00","sourceName":"信源名称","bodyZh":null,"bodyOriginal":"正文……"},"sourceFacts":{"sourceKind":"rss","sourceTier":"T1","firstParty":true,"language":"zh"},"samplingContext":{"benchmarkSplit":"development","samplingStratum":"regulation"},"gold":{"decision":"select"}}
```

| 字段 | 说明 |
|---|---|
| `caseId` | 唯一编号 |
| `material` | 标题、原标题、发布时间、信源名、正文（中文正文放 `bodyZh`，原文放 `bodyOriginal`，有一个就行） |
| `sourceFacts` | 信源类型、分级、是否一手（线上只有 `T1` 算一手，标注时保持一致）、语言。分级决定用哪个门槛 |
| `samplingContext` | 可选。`benchmarkSplit` 分开发集和留出集，`samplingStratum` 是你自己的分组（比如“新规”“判决”“营销”），看错在哪一类 |
| `gold.decision` | `select` 该选，`reject` 不该选，`either` 两可（不计入准确率） |

`industry/gold.example.jsonl` 有两条示例。

几条建议：

- 多放**难例**：差一点就该选、差一点就不该选的。一眼就能判断的放太多，准确率会虚高。
- 分出一部分做**留出集**（`benchmarkSplit: "holdout"`），调提示词只看开发集，最后再用留出集检查一遍，免得把提示词调成只会做这几道题。
- 标注的人最好就是以后读这个站的人，或者和他们口味一致的人。
- 评测只跑预筛和评分，不含第 6 步的去重：按这条资料本身该不该选来标，不要因为同一件事已经选过另一篇就标“不该选”。

### 2. 跑评测

```bash
node --env-file=.env scripts/eval-selection.ts --gold .data/gold.jsonl --split development --label "第一版评分标准"
```

对每条样本跑一遍预筛和评分，输出：

- **有效输出准确率、查准率、查全率和 F1**：只看成功得到入选决定的非 `either` 样本，用来判断模型答出来以后有多准；
- **覆盖率**：成功得到入选决定的样本占全部非 `either` 金标样本的比例；**完整准确率**则用全部非 `either` 金标样本作分母，把模型失败或回答不合格式也算作没有正确完成；
- `either` 始终不进入上述质量指标的分母；报告另外记录决定样本失败数与 `either` 失败数。`goldSelectRate` 按全部非 `either` 金标计算，因此同一批样本在不同模型间应保持一致；
- 门槛从 40 到 90 每隔 2 分（范围可以在下面说的 `DEPLOYMENT.selectionGold` 里改），各自会得到什么结果；门槛扫描同样同时报告有效输出准确率、覆盖率和完整准确率；
- 判错的条目，完整报告写到 `.data/eval/`，同时导入后台 SelectBench（加 `--no-import` 不导入）。

不传 `--models` 时，评测用“精选评分”这一步线上正在用的模型：后台“模型与评测”页切换过的优先，其次是环境变量 `SCORE_MODEL`，再其次是 `site/models.ts` 的 `DEFAULTS.score`，都没有就用默认模型（`.env` 里的 `LLM_*`）。`--models default,deepseek-flash` 可以在同一批样本上比较几个模型。其他常用参数：`--n 200` 最多抽多少条，`--split holdout` 只跑留出集，`--no-import` 不导入 SelectBench。在 `site/site.ts` 的 `DEPLOYMENT.selectionGold` 里写好样本文件、抽样条数、只抽哪一份和门槛扫描范围，以后不带参数运行就用这一套。

同一次评测里，不同样本渲染出完全相同的评分输入时，只共享模型的评分结果，各样本仍按自己的预筛结果、信源分级门槛和标注独立计分；失败的结果也在这次运行里共享，这样第一次跑和用已有结果重跑覆盖的样本一样。重复运行会复用已有回执。报告里的 token 用量和平均耗时，按相关回执的全部请求尝试汇总，解析失败后的重试也算在内；用已有结果重跑时，显示的是这些回执累计的用量，不代表这次新增的费用。

### 3. 看错例，改标准，再跑

在后台 SelectBench 里逐条看判错的资料和模型给的理由：

上传多模型报告时，同一 `caseId` 在各模型下须使用相同的 `gold` 标注，模型的 `decision` 可以不同。标注冲突的报告会在写入前被拒绝，避免同一条资料在并排比较时出现不同的人工答案；不提供逐例 `cases` 的报告仍可导入。

- 该选没选上，多半是评分标准里没说清它为什么重要：在 `selection-score.md` 里把这类价值写进“必须正常评价”的部分，给出例子。
- 不该选却选上了，多半是噪声没压住：写进“必须压住”的部分。
- 整体偏松或偏紧，而判错的条目分数都贴着门槛，再调 `industry/selection.ts` 的门槛。

先改标准，再动门槛：门槛只能整体移动，解决不了“哪一类判错了”。每改一次跑一遍，SelectBench 里能看到每一版的对比。比较模型时不要只看有效输出 F1：如果覆盖率明显不同，还要一起看完整准确率；高分但经常无法完成结构化判断的模型，不应被失败样本从分母里“隐藏”掉。

## 换模型

后台“模型与评测”页能看到每一步当前用哪个模型、近期的成功率、耗时和 token 用量，也能直接切换（只影响之后的新任务）。换评分模型之前，先用 `--models` 在同一批样本上比一比。

## 双轨精选（2026-10-31 起）

轨道不是新列，是 `sources.tags` 里的保留值（后台"信源"可编辑，`industry/selection.ts trackOf()` 判定）：

| 标记 | 轨道 | 怎么判 |
|---|---|---|
| `track:learning` | 学习轨 | 语义分档：这条内容对"提高站点主人的 AI 实战水平"有没有用 |
| `track:inherit` | 继承轨 | 直接继承上游自带精选，本站不做任何模型判定 |
| 无标记 | 新闻轨 | 五轴加权评分（`prompts/selection-score.md`，措辞与门槛均未改） |

`track:` 是内部路由标记，**绝不进模型上下文**（`editorial/writing.ts` 负责过滤）。

### 学习轨：三档映射成分数

模型只输出 `level`（`hit`/`edge`/`miss`）与 `kinds`。档位映射成分数后，走与新闻轨**同一条**“平均分 ≥ 门槛”的规则（`editorial/analyze.ts` 的 `scoresSelect`）；学习轨只打一次分，且边界档 `edge` 额外由人工复核闸门拦下（`normalizeAnalysis` 的 `review`），不自动入选：

| 档位 | 含义 | 映射分 |
|---|---|---|
| `hit` | 明确是我要的学习内容 | 90 |
| `edge` | 沾边但价值有限 | 60 |
| `miss` | 行业新闻 / 模型产品发布 / 闲聊 / 带货 | 20 |

#### 一次调用定案，边界档交人工复核

三档是离散语义、不是连续分数，再问一次并不提供“另一位的独立意见”，只会重摇同一个边界。所以学习轨**只打一次分**（`secondScoreWanted` 对学习轨恒为 false）：

| 起手 | 结果 |
|---|---|
| `hit`（90 > 60） | 自动入选 |
| `miss`（20 < 60） | 自动不入选 |
| `edge`（60 = 60） | **不自动入选，进后台“精选标注 → 待复核”队列，等主人确认** |

`edge` 的拦下由 `normalizeAnalysis` 的 `review` 标记完成（`selected = pass && scoresSelect && !review`），并写进 `analyses.output.review`。复核队列据此列出“最新判定为 edge 且还没有人工设置”的条目；主人确认后走 `labelSelection`（与手工标注同一条路：立即改公开 `selected` + 追加 `selection_gold`）。门槛 60 仍把 `edge` 映射在边界上供显示与 `scoresSelect` 使用，但**学习轨的校准杠杆是评分标准（什么算 hit/edge/miss），不是挪门槛**。

为什么取消复判：旧机制只在起手 `edge` 时打第二次，实测 756 篇打过两次分的学习轨文章里，第二次真正改变结局的只有 44 篇（5.8%），**全部是否决方向、从不提升**（复算口径见 项目地图.md 14.3）——它只是一次昂贵的否决。与其让模型重摇边界，不如把边界直接交给主人：模型只在有把握（hit/miss）时自动定案，拿不准的（edge）一律人工确认，确认结果回流成校准证据。

学习轨门槛**不按 tier 分档**——这些源都是主人本人关注的实践者，信任级同级。`EXCLUDE_MP` 与未列层级仍完全不打分；继承轨不打分。

### 学习轨的 11 类内容

10 类命中（`skill_playbook`、`asset_release`、`oss_ecosystem`、`monetization_fde`、`tutorial_explainer`、`principles_internals`、`knowledge_base`、`ai_video`、`new_play`、`opinion_insight`）+ 1 类被压低（`news_like`）。词表在 `industry/selection.ts LEARNING_KINDS`，与提示词的 kinds 表、`industry/taxonomy.ts CATEGORY_TAGS`、`packages/contracts/src/taxonomy.ts GENRE_FILTERS` **四处一一对应，改一处要改四处**。

**分类以内容重心为准，不以话题为准**：一条"某模型发布"若附带深入原理讲解 → `principles_internals` 命中；一条"我搭了个知识库"若只有晒图无细节 → kinds 是 `knowledge_base` 但档位 `miss`。

### 为什么必须两套标准（不要试图统一）

新闻轨的噪声压制里明写"纯训练方法、架构微创新、底层优化、量化、检索、协议或单一基准刷分……默认 `sig ≤ 4` 且 `reson ≤ 3`"——**新闻轨主动压低原理类内容**。学习轨反过来把 `principles_internals` 列为命中类。两轨方向相反，合并会同时毁掉两边。学习轨只保留"纯刷分排名"这一条压制（压到边缘封顶）。

另外，`events/group.ts` 的"材料不足"一票否决（`scope==='unknown' && !fact`）**在学习轨不生效**：纯图短帖（一张截图 + 一句话的 skill 玩法）在学习轨恰恰是高价值内容，材料够不够由学习轨提示词自己判。新闻轨保持原样。**注意这与 `selection_adds_value` 那道精选去重闸门是两个不同机制，后者绝不能放开。**

### 改了措辞或门槛之后

分轨评测（**共享缓存 key 含轨道**，两轨不会串味）：

```bash
node --env-file=.env scripts/eval-selection.ts --export-gold --track learning
node --env-file=.env scripts/eval-selection.ts --track learning --sweep 40-90
```

校准协议：在后台"精选标注"手工标 30–50 条（模型拿不准的边界档在"待复核"里确认）→ 导出金标 → 跑评测看模型判得准不准。评测用与生产**同一套判定函数**重放（`secondScoreWanted` + `scoresSelect` + 学习轨 `review`），报告**自动决定**（hit/miss）的准确率/精确/召回，以及**待复核率**（`held`/`reviewRate`，edge 占比，即交给人工的工作量）；`hold` 不算失败、也不计入自动决定准确率，但计入覆盖率。

- **学习轨**要改的是评分标准（`prompts/selection-score-learning.md` 里什么算 hit/edge/miss），不是门槛——三档离散，挪门槛只在极端值才改变结局，`--sweep` 对学习轨基本是平线。
- **新闻轨**仍是连续分，`--sweep 40-90` 找 FP/FN 拐点定门槛依旧适用。

标注一次做两件事：立即改公开 `selected`（走 `admin/content.ts overrideFields`，有版本检查、重发布、审计），并追加一行 `selection_gold` 作为校准证据。

**两种东西永远不算校准证据**：模型给自己打标；上游 AIHOT 的旧精选口径。只有"这个部署里由人做出的决定"才算。

### 人工确认回流：AI 提议、你批准

边界档的人工确认不止改这一条的入选，还回流成校准评分标准的证据。整条回路是「人确认 → 对账 → AI 提议 → 人批准 → 生效」，**AI 永远只提议，主人批准才生效**，标准不会自行漂移：

1. **人确认**：主人在后台"精选标注 → 待复核"里判边界档。`labelSelection` 立即改公开 `selected`，并追加一行 `selection_gold`（人工金标）。
2. **对账**：`eval-selection.ts --track learning` 用生产同一套函数重放，报告的 `tracks.learning.heldResolutions` 给出"模型挂起的边界档、人工怎么判的"（精选 / 不精选 / 两可）。这是校准 `hit/edge/miss` 的核心信号：
   - 多数被判**不精选** ⇒ `edge` 偏松，宜把这类往 `miss` 收；
   - 多数被判**精选** ⇒ `edge` 偏紧，宜把这类往 `hit` 放；
   - **各半** ⇒ 边界本身合理，保持 `hold`、只修明显的 FP/FN。
3. **编 brief**（免费，不调模型）：`propose-rubric.ts` 把一次对账编成校准反馈——现行标准全文 + 自动决定指标 + 边界读法 + 判错与边界样本（正文摘录按 `caseId` 从金标关联）。指标与 FP/FN 都从报告的 `cases` 用 `selectionMetrics`/`heldResolutions` 现算，不依赖报告里可能过时的预聚合字段。
   ```bash
   node --env-file=.env scripts/propose-rubric.ts                 # 读最新的 selection-learning-*.json，写 .data/proposals/learning-brief-<ts>.md
   node --env-file=.env scripts/propose-rubric.ts --report <eval.json> --model <name> --max-examples 20
   ```
4. **AI 提议**（付费一次，主人触发）：加 `--propose`，模型在 `PROPOSAL_SYSTEM` 约束下出一版**最小改动**的新标准，写成"待批提议" `.data/proposals/learning-rubric-<ts>.md`，**永不直接生效**。回执 `purpose=propose_rubric`（自由字符串，无需迁移）。硬约束：保留 kinds 表（11 类）、五个维度、噪声压制、输入安全边界、`{{siteName}}` 与"只返回 level/kinds 的 JSON"契约，只动判档边界与重要/噪声的例子。
   ```bash
   node --env-file=.env scripts/propose-rubric.ts --propose [--model <name>]
   ```
5. **人批准 → 生效**：主人审阅提议（理由 + 全文）后运行 `--apply`，才写入 `industry/prompts/selection-score-learning.md`。写入前先过**渲染校验**（`promptFromText`，与 worker 同一渲染器）：未知 `{{token}}` 或坏 include 会被拦下、**不写**。内容哈希变 ⇒ 新版本，之后的新资料按新标准判。
   ```bash
   node --env-file=.env scripts/propose-rubric.ts --apply .data/proposals/learning-rubric-<ts>.md
   node --env-file=.env scripts/eval-selection.ts --track learning   # 复测，报告里的 promptVersion 即新版本
   ```

`.data/proposals/` 与 brief 都不进仓库（`.data/` 已 gitignore）。**生效只影响之后到达的资料**：存量不会因 `--apply` 自动重判（按哈希匹配重判是另一件事，见下节与 项目地图.md）。

#### 边界档批量标注：按内容类型抽样

边界档积压几百篇时，逐条在后台确认太慢。`scripts/edge-worksheet.ts` 把待复核的 `edge` 按**内容类型**（`LEARNING_KINDS` 11 类）分组、每类抽几篇（默认 6，`--per-kind` 可调），写成一张 spreadsheet 填的 CSV，填完读回走**同一个** `labelSelection`（改公开 `selected` + 存 `selection_gold`，版本检查、审计、`selected_ledger` 一个不绕）。

```bash
node --env-file=.env scripts/edge-worksheet.ts --out .data/edge-worksheet.csv          # 抽样写空表
node --env-file=.env scripts/edge-worksheet.ts --import .data/edge-worksheet.csv      # 干跑核对
node --env-file=.env scripts/edge-worksheet.ts --import .data/edge-worksheet.csv --live  # 落库
```

与盲标表（`gold-worksheet.ts`，看不到模型判分、用来独立测门槛）相反，这张表**不盲**：显示类别与模型的推荐理由，因为主人是在**确认边界**、不是独立测量。类别作为分层 `edge:<kind>` 存进 `selection_gold.sampling_context`，于是 `propose-rubric.ts` 能按类别读"这一类人工怎么判"，把校准做成**每类一条规则**（哪类偏松往 miss 收、哪类偏紧往 hit 放），而不是全局挪一个门槛。只抽当前评分哈希、还没有人工决定（无 override、无 gold）的 `edge`；按 id 排序抽样，重跑同一库得到同一张表；行按类别轮转排列，只填前 N 行也覆盖每一类。

### 改了信源的轨道、或改了评分标准之后

打标记 / 改措辞都只影响之后到达的资料。`analyses` 里已有的行仍是旧措辞与门槛判出来的，**不会自动重判**（历史判定永不回溯重写，回执与 `prompt_version` 保证可审计）。要让存量按新措辞生效，用同一个脚本，`--by` 选匹配方式：

```bash
# 换轨（信源新打了 track:learning，存量还是新闻轨判的）——按提示词名字匹配，默认
node --env-file=.env scripts/reanalyze-track.ts --dry-run --limit 30
node --env-file=.env scripts/reanalyze-track.ts --concurrency 6

# 改评分标准（名字不变、内容哈希变，如校准学习轨）——按当前评分版本的哈希匹配
node --env-file=.env scripts/reanalyze-track.ts --by hash --track learning --dry-run
node --env-file=.env scripts/reanalyze-track.ts --by hash --track learning --concurrency 6
```

只有评分步骤因措辞变化重新付费（新闻轨每篇 2 次、学习轨 1 次）；预筛、结构、写作的回执按提示词版本复用，版本没变所以免费。**例外**：一篇原本低于 understand 门槛（学习轨 miss=20）、重判后升到 hit/edge（≥60）的文章会新付一次 understand，反向降档的同理可能新付一次 summarize——重判不只花评分的钱。脚本只挑"最新一条 analyses 的 `prompt_version` 与应有措辞不符"的文章，因此幂等、可重入，并打印 before/after 的 `articles / selected / public` 对账。

**并发**：吞吐上限是预算的每分钟熔断（`budgets` 表，llm 默认 300/分钟）；并发 6 约 95 次/分钟，余量充足，调高前先按"每分钟付费次数 ≈ 并发 × 60 ÷ 每篇耗时 × 每篇付费次数"估算别撞 300。另一条限制是回执的 `busy` 守卫：`logical_key` 按**内容哈希**（service+purpose+model+identity）算、不是按文章 id，所以**两篇材料完全相同的文章并发处理会撞 `Receipt N is in flight`**（第五轮全量在低并发下也有 9 次）。这类失败是瞬时的，脚本幂等，**补跑一轮即可收回**；并发越高撞车概率越大，权衡吞吐与补跑成本。
