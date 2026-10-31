# ARGUS Phase 2 运行记录

- 日期：2026-10-30
- 模型：`tencentcloud/deepseek-v4.1-flash-1017`（SF LLM Hub，OpenAI 兼容）
- 状态：采集、分析、精选、聚类已真实跑通；44 个 X 关注源全部启用，抓取按 **FxTwitter → RSS → SocialData** 三层回退（前两层免费，SocialData 只在两层都失败时按量计费）；16 个账号的博客/Newsletter RSS 平时暂停，作为对应 X 源的第 2 层；另有 19 个独立 RSS 源正常调度，每日 04:30 自动探活。付费上限统一由后台 `budgets.socialdata` 控制（3/40/100），后端不写死。

> **本文是 2026-10-30 的运行记录，其中 RSS 相关部分已被 2026-10-31 的整体优化（P1）取代，不再重写：**
> 35 个 RSS 源（19 个独立源 + 16 个 X 第 2 层）连同其 3246 篇材料已从库中删除，行业新闻改由 AIHOT 镜像提供；
> X 采集回到 **FxTwitter → SocialData** 两层，`sources/x-rss-links.ts` 映射表与 `scripts/convert-x-to-rss.ts`
> 一并移除。RSS 仍是可用的信源类型，只是本站当前没有配置任何 RSS 源。现行口径见 `README.md` 与 `docs/argus-phase3.md`。

## 1. 模型接入

2026-10-30 实测：

| 项 | 结果 |
|---|---|
| `POST /v1/chat/completions` | 200 |
| 普通回答 | 正常返回 `content`，同时返回 `reasoning_content` |
| `response_format: json_object` | 200，返回合法 JSON |
| 视觉 | 模型声明并实测支持（`LLM_VISION=true`） |

`.env` 关键项：

```env
LLM_BASE_URL=http://llm-model-hub-apis.sf-express.com/v1
LLM_MODEL=tencentcloud/deepseek-v4.1-flash-1017
LLM_VISION=true
LLM_REASONING_TOKENS=8000
LLM_EXTRA_JSON={}
COLLECT_ENABLED=true
MODEL_CALLS_ENABLED=true
```

密钥只保存在 `.env`（已 gitignore），没有写入源码、构建产物或日志。已核对构建目录中不含密钥值。

## 2. 首次真实采集

首批 23 个 RSS 信源，首轮回填每源 3 条，结果（截至 2026-10-30 10:35 北京时间）：

| 指标 | 数值 |
|---|---|
| 入库文章 | 45 |
| 完成分析 | 38 |
| 形成事件 | 19 |
| 入选精选 | 4 |
| 进入日报 | 0（本轮执行时的旧规则覆盖前一日 08:00–当日 08:00，本轮内容在 08:00 后完成评判，进入下一期；现行自然日规则见 `selection.md`） |

入选内容示例：

- Google DeepMind 发布 Gemini 4 Carbon（AI 模型，76 分）
- Google DeepMind 发布 Genie 4 世界模型（AI 模型，73 分）
- 微软研究院发布 Flint-interactive（论文/研究，61 分）
- 微软研究院与合作者证明 31 年未解的 KLS 猜想（论文/研究，80 分）

模型自动分类结果已包含分类、主题标签、实体标签，例如：

- `ai-models` + `{模型发布, 评测/基准, 安全/对齐, Agent, 编码, Google, OpenAI, Anthropic, Hugging Face}`
- `ai-products` + `{产品更新, Google, Agent, 设计/交互}`
- `paper` + `{论文/研究, 数据/训练, 图像生成}`

分类来自 `industry/taxonomy.ts` 的词表与 `industry/prompts/structure.md`；主题页按 `industry/topics.json` 的标签聚合，后续可直接在词表、主题文件和后台“内容诊断”里微调。

## 3. 已知问题

1. **5 篇文章正文补齐失败**：`JINA_API_KEY is not configured`。这些文章停在 `new`，不影响已入库内容；如需要补齐网页正文，提供 Jina key 或在后台关闭依赖 Jina 的信源。
2. **2 次模型输出截断**：发生在把 `LLM_REASONING_TOKENS` 从 4000 提到 8000 之前；worker 已重启，文章会自动重试。
3. **首日日报窗口为空（迁移前规则的历史记录）**：当时每日 08:00 出刊，覆盖前一日 08:00 到当日 08:00。首次采集发生在 10:00 之后，因此 10-30 的日报没有窗口内内容；系统按“上游无评判”报错并持续告警，10-31 08:00 起会正常出刊。这是首日的空窗口，不是抓取故障。现行规则改为前一日 00:00 至当日 00:00，出刊与告警时间不变。
4. **精选门槛沿用 AIHOT 默认值**：T1 60、T1_5 65、T2 76。首批 45 条中入选 4 条，偏严格；若要提高产量，先用 `scripts/eval-selection.ts` 和标注样本校准，不要直接改数字。

## 4. X 接入：FxTwitter → RSS → SocialData

X 信源不需要 X 账号密码或 Cookie。每个账号按三层读取，优先使用免费来源：

| 层 | 来源 | 计费 | 作用 |
|---|---|---|---|
| 1 | FxTwitter 公开 API（`/2/profile/{handle}/statuses`） | 免费、无 key，公开文档标称 1000 次/分钟/IP | 账号最新一页（约 20 条）：原创、转帖原帖、引用、媒体 |
| 2 | 该账号的博客/Newsletter RSS | 免费 | 只在 FxTwitter 失败、且 `x-rss-links.ts` 有映射时启用；RSS 已新鲜则复用，不重复抓 |
| 3 | SocialData 搜索 | 按返回对象计费（约 US$0.0002/条） | 前两层都不可用时的兜底；受后台 `budgets.socialdata` 限制 |

当前状态：

- **44 个 X 关注源全部 `enabled=true`，全部 `config.provider="fxtwitter"`**；每轮按账号单独请求，不再合并 SocialData 分片。
- **44/44 已建立 `lastTweetId` 游标**。`x-googleai` 曾连续返回 404 并走第 2 层 `rss-google-ai`，强制重跑后 FxTwitter 正常返回 12 条；`x-ylecun` 也已从 FxTwitter 建立游标。404 是暂时性的，持续失败时仍会自动落到 RSS。
- `scripts/import-x-following.ts` 新建的源默认 `provider="fxtwitter"`；`scripts/convert-x-to-rss.ts` 把已有 X 源统一切到 FxTwitter，并暂停 16 个对应账号的 RSS 源，让它们只做第 2 层。

### 4.1 转帖、引用与回复

FxTwitter 时间线里，转帖的顶层对象就是**被转的原帖**，`reposted_by` 是执行转发的关注账号。采集规则：

- **转帖原帖照常入库**：作者、正文、媒体都用原帖，另存 `xPost.repostedBy`；信源允许全文展示时，站点在标题下方显示“由 @xxx 转发”（当前 44 个 X 源都是摘要模式，所以这一行只在开启全文的源上出现）。
- **引用帖**保留引用对象（`xPost.quoted`）和正文。
- **普通回复排除**；关注账号自己的线程回复只在 `publisherRole` 为 `organization` / `person` 时保留；被转帖的原帖即使是回复也收录。

### 4.2 X 长文（Article）

- `/status/{id}` 的 `article.content.blocks` 已包含长文正文，抽取时**优先用 FxTwitter 免费读取**。
- 只有 FxTwitter 取不到可用正文（请求失败、返回的帖子里没有 `article`，或 `article` 只有无法渲染的媒体块）时才调用 SocialData `getArticle`（按篇计费）。
- 2026-10-30 切换后用免费路径补回 5 篇此前 `unconfirmed` 的 X 长文，付费 `x_article` receipts 未新增；另有 1 篇原长文已不可见（FxTwitter 也没有正文），保持 `unconfirmed`，没有为它再付一次费。

### 4.3 失败与重试

- FxTwitter 的 `since` 参数不可靠：部分活跃账号在 7/30/90/180 天窗口都返回 404，不带 `since` 则正常。因此采集**始终取最新一页，按 `lastTweetId` 去重**。
- FxTwitter 会对存在的页面偶发 404。时间线最多尝试 3 次（间隔 700ms），单帖最多 2 次；`204` 视为确实没有内容；持续 404 视为失败并进入下一层，避免把暂时失败当成“没有更新”。
- 单帖没有日期、或嵌套引用没有日期时，跳过该帖或用父帖日期；不会因此丢掉整页。

### 4.4 SocialData 计费（历史实测，仍然有效）

- 原 key 充值后余额为 US$10，但**没有可用的免费 3 次/分钟**。
- 用户资料查询扣 US$0.0002；一次返回 20 条推文的搜索扣 US$0.004；同一分钟内 3 次精确短语搜索（返回 1+2+1 条）扣 US$0.0008。
- 结论：这个账号按**返回对象**计费，3 次/分钟的免费层没有生效；无论请求是第 1 次还是第 3 次，只要返回推文就会扣余额。
- 首轮补齐覆盖 35 个源，约 US$0.13；之后开启 FxTwitter，时间线不再产生新的付费请求。当前 `budgets.socialdata` 仍为 **3/分钟、40/小时、100/天**（后台可调），只保护第 3 层和长文兜底。

### 4.5 切换后的实测分布

- 切换后最初 20 次 X 抓取：**18 次 FxTwitter、1 次 RSS、1 次 SocialData**（含后来强制重跑的 x-ylecun/x-googleai，之后均为 FxTwitter）。
- 那 1 次 SocialData 是 `x-nvidia` 在重试逻辑修复前的首次回退（3 条 receipt）；修复后强制重跑走 FxTwitter，找到 16 条、新增 6 条，没有新的付费请求。
- `x-googleai` 走第 2 层 `rss-google-ai` 成功；`x-simonw`、`x-yihui-indie`、`x-rowancheung` 在修复后都从 FxTwitter 正常取到内容。
- 用户提供的 X handle `LiFaFa225677` 在 SocialData 查询返回 `User is suspended`；这不影响按账号抓取已导入的 44 个信源，但如果之后要重新导入 following，需要先恢复该账号。

## 5. 关注账号的博客 / Newsletter RSS

2026-10-30 对 44 个关注账号逐个探测首页的 `<link rel="alternate">` 与常见 feed 路径，并用后端 `fetchRss` 实际解析验证。共 **16 个账号有可用 RSS**。

### 5.1 16 个作为第 2 层的 RSS

这 16 个 RSS 源平时 `enabled=false`，只在对应 X 源的 FxTwitter 失败时被强制抓取一次；**X 源本身全部保持启用**，所以这些账号在 X 上的实时内容不会再因“有 RSS”而停更。

| 账号 | RSS | 说明 |
|---|---|---|
| Amelia Wattenberger | `https://wattenberger.com/rss.xml` | 个人博客，仍在更新 |
| Ethan Mollick | `https://www.oneusefulthing.org/feed` | One Useful Thing，仍在更新 |
| Rowan Cheung | `https://www.therundown.ai/feed` | The Rundown，仍在更新 |
| 宝玉 | `https://s.baoyu.io/feed.xml` | 个人博客，仍在更新 |
| Google AI | `https://blog.google/technology/ai/rss/` | 官方博客，新增 T1 |
| OpenAI | `https://openai.com/news/rss.xml` | 已有 `rss-openai-news` |
| Google DeepMind | `https://deepmind.google/blog/rss.xml` | 已有 `rss-google-deepmind` |
| NVIDIA | `https://blogs.nvidia.com/feed/` | 已有 `rss-nvidia-blog` |
| Simon Willison | `https://simonwillison.net/atom/everything/` | 已有 `rss-simon-willison` |
| Andrej Karpathy | `https://karpathy.github.io/feed.xml` | 最近一篇 2026-02，偏旧 |
| Karina Nguyen | `https://karinanguyen.com/index.xml` | 最近一篇 2026-06 |
| Matt Pocock | `https://www.totaltypescript.com/rss.xml` | 最近一篇 2023，教程为主 |
| Sam Altman | `https://blog.samaltman.com/posts.atom` | 博客低频，最近 2026-04 |
| Yihui Xie | `https://yihui.org/index.xml` | 博客主题是 R/knitr，与 @yihui_indie 的 AI 内容不同线 |
| swyx | `https://swyx.io/rss.xml` | 最近一篇 2026-07 |
| Uncle Bob | `https://blog.cleancoder.com/atom.xml` | 最近一篇 2023 |

映射表曾在 `packages/backend/src/sources/x-rss-links.ts`；`scripts/convert-x-to-rss.ts` 负责把已有 X 源切到 FxTwitter 并暂停这 16 个 RSS 源。**这两个文件已在 2026-10-31 的 P1 中移除**（映射的 16 个 RSS 源已删，`readX` 的 RSS 兜底分支成为死路径；脚本重跑会复活全部 16 个源），下文表格仅作当时的探测记录保留。

没有可用 RSS 的账号（Anthropic、Claude、Andrew Ng、Emil Kowalski、Zain Kahn、归藏、赵纯想、Linus Ekenstam 等）同样走 X 第 1 层。Zain Kahn 的 `superhuman.ai/feed` 被 Cloudflare 403 拦截；卡兹克的 `aihot.news/feed.xml` 是 AIHOT 聚合站而非他的个人博客，未当作替代源。

### 5.2 接入结果

| 项 | 数值 |
|---|---|
| RSS 信源 | 35：19 个正常调度，16 个暂停作为对应 X 源的第 2 层 |
| 新增 RSS 首轮回填 | 28 篇（每源 3 条；Matt Pocock 的历史条目在时间窗外，0 篇） |
| X 信源 | 44：全部启用，全部 `provider=fxtwitter` |
| 已建游标 / 未建游标 | 44 / 0（`x-googleai` 与 `x-ylecun` 在强制重跑后都由 FxTwitter 建立） |

已抓到的 332 条 X 内容保留。自动分类示例：

- `opinion` + 借 Gemini 4 Carbon 发布感慨模型训练差距
- `ai-products` + 开源 AI 服装图数据库
- `tip` + Claude 指挥 Codex 操控浏览器的规则

### 5.3 每日 RSS 探活

worker 每天 **04:30（Asia/Shanghai）** 运行 `sources.rss-probe`，对**全部 35 个 RSS 源**（19 个启用 + 16 个第 2 层）做一次真实读取：

- 用 `fetchRss(force)` 解析 feed；网络类失败先重试一次。
- **文档已不是 RSS/Atom 或 404/410**：视为失效，自动从同一站点的首页 `<link rel="alternate">` 和常见路径找新 feed，验证通过后写回 `config.feedUrl`、清空失败状态，下一分钟由正常采集器抓取。
- **网络/TLS 不可达**：保留原地址，不判为失效、不换 feed，下一轮探活继续重试。
- **不再做付费回退**：探活只负责免费 RSS 的换址与报告。暂停的 16 个第 2 层 RSS 也会被检查、必要时换址，但不会因探活被启用或排队；它们只在对应 X 源的 FxTwitter 失败时被强制读取一次。
- 结果写入 `settings.rss.health.last` 和 `job_runs`；有失效/不可达时通过现有告警通道发送。旧的 `settings.rss.fallback.last` 与一次性付费回退逻辑已删除。

2026-10-30 首次全量探活（当时 35 个启用源，历史记录）：

| 结果 | 数量 | 说明 |
|---|---|---|
| 正常 | 27 | — |
| 空 feed | 1 | arXiv cs.CL 当时返回 0 条，保留原地址 |
| 自动换新地址 | 2 | LangChain：`blog.langchain.com/rss/` → `www.langchain.com/blog/rss.xml`；Vercel：`vercel.com/feed/rss` → `vercel.com/blog/feed` |
| 网络不可达 | 5 | Google Research、Hugging Face、Import AI、Mistral、NVIDIA；原地址保留，下一轮重试 |

两个换址后的源已由采集器成功抓取（`health=ok`）；复跑探活为 29 正常、1 空、5 不可达、0 失效。按新的第 2 层规则，NVIDIA 的 RSS 不再由探活付费回退，而是由 `x-nvidia` 的 FxTwitter 免费覆盖。

手动运行：

```bash
node --env-file=.env scripts/probe-rss.ts
```

操作代码在 `packages/backend/src/sources/rss-health.ts`，调度在 `apps/worker/src/schedules.ts`。

## 6. 内容筛选：内容类型 / 技术方向 / 来源

2026-10-30，首页与“全部情报”增加三个可组合筛选。它们只缩小列表范围，不改变排序、不引入“学习内容优先”的加权——用户明确要求先做筛选，不做优先级。

| 维度 | 参数 | 参数值 | 数据来源 |
|---|---|---|---|
| 内容类型 | `genre` | `教程/实践`、`模型发布`、`大佬观点`、`产品更新`、`现象/趋势`、`行业动态`、`论文/研究`、`评测/基准`、`政策/监管`、`开源/仓库` | `publications.tags` 中的类别标签 |
| 技术方向 | `field` | `Agent`、`编码`、`推理`、`多模态`、`语音`、`视频`、`图像生成`、`RAG`、`端侧`、`数据/训练`、`搜索`、`部署/工程`、`开源生态`、`具身智能`、`MCP/工具调用`、`设计/交互` | `publications.tags` 中的技术方向标签 |
| 来源 | `platform` | `x`、`wechat`、`youtube`、`bilibili`、`web` | 发布渠道、信源类型与文章 URL |

表格列的是 URL 参数值，菜单文案取 `GENRE_FILTERS` / `FIELD_FILTERS` 的 `label`，两者可能不同（例如 `现象/趋势` 显示为“行业趋势”，`Agent` 显示为“Agent / Skills”）。

### 6.1 判定逻辑

- **内容类型与技术方向**：直接对 `p.tags` 做包含判断（`p.tags @> [tag]`），模型在结构化阶段已经打好这些标签，不需要新表或回填。两个维度同时选中时是 AND：文章必须同时带两类标签。
- **来源在 SQL 里判定**，实现为 `packages/backend/src/publication/items.ts` 的 `platformCondition`：
  - `x` 只看 `p.channel = 'x'`。X 帖子里的外链不会改变来源，所以“X 帖引用 YouTube”仍算 X。
  - `wechat`：信源 `kind = 'mp_account'`，或文章 URL 主机为 `mp.weixin.qq.com`；只认新闻渠道。
  - `youtube` / `bilibili`：只认新闻渠道，URL 主机分别匹配 `youtube.com`、`youtu.be` 与 `bilibili.com`、`b23.tv`，允许子域名。正则锚定在协议之后的主机段，URL 路径里出现同名字样不会误判。
  - `web` 是排除法：新闻渠道里不属于上面三类的都归网站/RSS。以后新增视频站时，必须先把它加进 `platform`，否则会暂时落在 `web`。
- **“一手（官方）”** 仍是原有的 `channel=firstParty`，不属于 `platform`。来源菜单里它是与五个平台并列的单选项，选平台会清掉 `channel`，选一手会清掉 `platform`。
- **空选项不隐藏**：公众号、YouTube、Bilibili 目前没有信源，选中后显示空态；这是有意的，避免用户以为筛选不存在。2026-10-30 实测（全部 1,540 条）：X 658、网站/RSS 880，公众号、YouTube、Bilibili 均为 0；这些数字随采集变化，只用于确认口径。

### 6.2 参数与缓存

- 网址参数：`genre`、`field`、`platform`，与旧的 `channel`、`category`、`tag` 可叠加，例如 `/all?genre=教程/实践&field=Agent&platform=x`。分页时会丢掉 `page`/`cursor`，切换精选与全部会保留筛选。
- 首页 `/` 与 `/all` 都接受同一组参数；`q` 只在 `/all` 生效。
- 新参数已进入 timeline 的游标绑定、pool 的 30 秒总数缓存键和搜索结果共享键。以后再加维度时，这三处与 `queryPool` 的返回 `filters` 必须一起更新，否则分页或缓存会串结果。

### 6.3 改动入口

- 选项表与校验：`packages/contracts/src/taxonomy.ts`（`GENRE_FILTERS`、`FIELD_FILTERS`、`PLATFORM_KEYS`）。
- SQL 条件：`packages/backend/src/publication/items.ts`；三个读取面分别在 `timeline.ts`、`pool.ts`、`groups.ts`。
- 接口校验与热点条的“未筛选”判定：`apps/api/src/routes/site.ts`。
- 网页参数解析与标题：`apps/web/app/lib/seo.ts`；三菜单、手机筛选面板与可删除 chip：`apps/web/app/features/feed/Filters.tsx`；页面接入：`routes/home.tsx`、`routes/all.tsx`。
- 回归测试：`tests/feed-filters.test.ts`，覆盖两个维度的组合、来源判定（含子域名、仿冒路径、X 外链）、空来源与 API 非法值。

## 7. 当前配置与下一步

**抓取顺序固定为 FxTwitter → RSS → SocialData**，代码在 `packages/backend/src/sources/collect.ts` 的 `readX`：

- **第 1 层**：44 个 X 源全部 `provider=fxtwitter`，免费、无 key；`FXTWITTER_BASE_URL` 只在自建实例时需要改。
- **第 2 层**：16 个账号的 RSS 暂停待命，只在第 1 层失败时强制读取；19 个独立 RSS 源正常调度。
- **第 3 层**：SocialData 仅在两层都失败时逐账号搜索，受 `budgets.socialdata`（**3/分钟、40/小时、100/天**）限制；按每次约 20 条、US$0.004 估算，即使打满日上限也只有约 **US$0.40/天**。
- **X 长文**：FxTwitter 优先，取不到才走 SocialData，按篇约 US$0.0002。
- **转帖**：原帖入库并保留 `repostedBy`，站点显示“由 @xxx 转发”。
- **RSS 探活**：每天 04:30 检查全部 35 个 RSS 源（含 16 个第 2 层）；同站有替代就免费换址，没有替代的只报告，不再付费回退，也不会把第 2 层唤醒。

待观察：

1. 18:46（北京时间）的下一批定时抓取，确认 44 个 X 源都走第 1 层、没有新增 SocialData receipts；有 RSS 映射的账号在 FxTwitter 失败时才落到第 2 层。
2. `x-googleai` 与 `x-ylecun` 已在强制重跑后由 FxTwitter 建立游标（44/44）；继续观察会不会再出现持续 404，若 RSS 也失效再查 handle/接口。
3. 观察几天后再按需要调低 `budgets.socialdata`；现在它只是第 3 层的安全网。若第 3 层长期为 0，可以进一步收紧。
4. 接入 YouTube / Bilibili：需要频道 ID 或 UP 主 ID；视频 Adapter、字幕状态与章节展示属 Phase 3。
5. 用真实内容微调主题词表、分类边界与精选门槛。
