# ARGUS

**AI Intelligence & Knowledge Hub · AI 情报与知识中枢**

> 观世界 · 见未来
>
> 从纷繁信息中，发现真正重要的内容。

ARGUS 是一个个人优先、默认私有的 AI 情报站：持续追踪官方博客、技术社区、开源仓库与指定账号，把分散内容标准化、去重、评分、翻译与聚类，每天早上 08:00 出一份中文日报，并按主题沉淀为可检索的长期知识库。

- 产品与视觉方案、各阶段交付记录：统一在 [`docs/plans/`](docs/plans/README.md)
- 交接与验收上下文（功能逻辑、坑点、待办、经验）：[`项目地图.md`](项目地图.md)
- 上游框架与基线说明：[`docs/upstream-aihot-readme.md`](docs/upstream-aihot-readme.md)

## 已实现（Phase 1）

- **东方水墨 / 自然编辑风**：暖纸白、墨色文字、低饱和印章红；衬线品牌标题与克制的山水纹理。
- **ARGUS 品牌资产**：圆形观测之眼 + 层叠山峦矢量 Logo、favicon、512/192/180 px 图标、字标组件。
- **首页品牌首屏**：主标语、辅助文案与今日内容入口；不占用主要阅读区域。
- **私有访问**：默认需要访问密码登录；网页、RSS、公开 API、MCP、站点地图、分享图与媒体出口全部在服务端校验会话。
- **导航与 IA**：首页、全部情报、热点、AI 日报、主题知识库、收藏与待读、Agent 接入、关于、更新日志、反馈、账户。
- **AI 主题**：Vibe Coding、Agent / Skills / MCP、UI/UX、RAG、推理、多模态、开源、论文、行业趋势等主题页。
- **三组内容筛选**：首页和全部情报都能按内容类型、技术方向、来源（X / 行业镜像 / YouTube / Bilibili / 公众号 / GitHub / 知识星球 / 网站）组合筛选，选中结果写进网址。
- **信源是双轨**（2026-10-31 定型）：行业新闻与发布类走**行业镜像**（`modules/aihot/`，worker 每 15 分钟读一份公开榜单，滚动 7 天，不落历史库）；自有信源**只有 44 个指定账号**，全部标 `track:learning`，判的是「这条能不能提高我的 AI 水平」。RSS 类型框架仍支持，但本站**当前零 RSS 源**（原 23 个连同 3246 篇材料已于 2026-10-31 清除）。
- **安全**：密码只存服务端；日志脱敏；私有页面 `no-store` + `noindex`；SSR 使用独立内部令牌访问 API。

## 技术栈

Node.js 24+ · TypeScript · React Router（SSR）· Fastify · PostgreSQL 17 · pg-boss · Tailwind CSS · Docker Compose。

三个进程：

| 进程 | 位置 | 职责 |
|---|---|---|
| web | `apps/web` | 页面渲染，只通过 HTTP 读 api |
| api | `apps/api` | 站点接口、公开 API、RSS、MCP、后台、媒体 |
| worker | `apps/worker` | 采集、模型处理、聚类、热度、日报 |

## 本地运行

需要 Node.js 24+、PostgreSQL 17 和一个 OpenAI 兼容模型 API Key（真正开始采集与生成内容时需要）。

```bash
# 1. 配置（生成 .env，含随机会话密钥、内部令牌与访问密码）
node scripts/init-env.ts --llm-key <你的模型 API Key>

# 2. 数据库（示例；也可用 docker compose up -d db）
#    在 .env 里设置 DATABASE_URL
node --env-file=.env scripts/migrate.ts
node --env-file=.env scripts/seed.ts

# 3. 三个进程（另开终端）
node --env-file=.env apps/api/src/main.ts
node --env-file=.env apps/web/server.ts
node --env-file=.env apps/worker/src/main.ts
```

打开 <http://localhost:3000>，用 `.env` 里的 `ADMIN_PASSWORD` 登录。后台在 `/admin`。

Docker 部署见 [`docs/deploy.md`](docs/deploy.md)。使用 Docker Compose 时，`PRIVATE_ACCESS` 与 `INTERNAL_TOKEN` 已由 `docker-compose.yml` 透传给 web。

## 私有访问配置

| 变量 | 说明 |
|---|---|
| `PRIVATE_ACCESS` | `true` 时所有读者页面、RSS、公开 API、MCP、媒体都需要登录；未设置或留空时默认 `true`。 |
| `INTERNAL_TOKEN` | web 与 api 之间的 SSR 共享密钥，至少 32 位；`init-env` 先生成它，再启用私有访问。 |
| `ADMIN_PASSWORD` | 访问密码，同时用于 `/admin`；至少 12 位。 |

关闭私有模式（恢复匿名阅读）时设置 `PRIVATE_ACCESS=false`，并同步调整 `site/public/robots.txt` 与隐私说明。


## 模型配置

ARGUS 通过 OpenAI 兼容接口调用模型。生产配置示例（密钥只写 `.env`，不提交）：

```env
LLM_BASE_URL=http://<你的内网模型网关>/v1
LLM_API_KEY=<模型网关密钥>
LLM_MODEL=tencentcloud/deepseek-v4.1-flash-1017
LLM_VISION=true
LLM_REASONING_TOKENS=8000
LLM_EXTRA_JSON={}
```

`LLM_REASONING_TOKENS` 是给推理过程额外留的输出额度；推理模型输出被截断（`finish_reason=length`）时调大它。页面访问不会调用模型，模型只在 worker 的任务里运行。

## X（推特）接入

X 信源不需要 X 账号密码或 Cookie，抓取按 **FxTwitter → SocialData** 两层回退，优先使用免费来源：

| 层 | 来源 | 计费 | 说明 |
|---|---|---|---|
| 1 | FxTwitter 公开 API | 免费、无 key | 账号最新一页（约 20 条），含原创、转帖原帖、引用和媒体 |
| 2 | SocialData 搜索 | 按返回对象计费 | 免费层失败时的兜底，受后台 `budgets.socialdata` 限制 |

1. 批量导入你关注的账号（这一步用 SocialData 读 following 列表）：

```bash
node --env-file=.env scripts/import-x-following.ts --user @你的X账号 --dry-run   # 先看会创建多少
node --env-file=.env scripts/import-x-following.ts --user @你的X账号
```

脚本会读取该账号的 following 列表，为每个账号创建一个 `x_search` 信源（`provider=fxtwitter`、`from:handle -filter:replies`、T2、editorial）。`--limit N` 可先导入前 N 个，`--hot-signal` 只作热度证据不进入精选。脚本自身按 20 秒/次限速，余额为 0 会直接退出，避免误扣。

FxTwitter 不需要 key，默认 `https://api.fxtwitter.com`；只有自建实例时才需要在 `.env` 设置 `FXTWITTER_BASE_URL`。它会对存在的页面偶发 404，采集器会重试后再决定是否落到 SocialData。转帖会收录被转的原帖（保留原作者、正文和媒体）；信源允许全文展示时，站点会显示“由 @xxx 转发”（当前 X 源为摘要模式，因此默认不显示）。X 长文（Article）也优先从 FxTwitter 的 `/status/{id}` 免费读取。

SocialData 仍然**没有可用的免费层**（2026-10-30 实测：20 条搜索扣 US$0.004，同一分钟 3 次短语搜索也按返回对象计费），所以它只作第 2 层和长文兜底；所有付费请求受后台 `budgets.socialdata` 限制（当前 **3/分钟、40/小时、100/天**，满额约 US$0.40/天），后端不写死任何上限。

RSS 仍是可用的信源类型（后台可加，`scripts/probe-rss.ts` 可手动探活，worker 每天 **04:30 北京时间**对当时所有 `kind='rss'` 的源跑一次探活：失效的 feed 会自动从同站首页/常见路径找新地址，网络不可达保留原地址、下一轮继续重试）。**本站当前没有配置任何 RSS 源**——行业新闻改由 AIHOT 镜像提供，X 账号不再有 RSS 第二层。

主题分类由模型按 `industry/taxonomy.ts` 的标签词表和 `industry/prompts/` 的提示词自动完成，可在 `industry/topics.json` 与后台“内容诊断”里人工微调。

## 内容筛选（精选 / 全部）

首页和“全部情报”共用同一套筛选，三个菜单可以任意组合。选中的结果写进网址，刷新、分享和切换精选/全部都不会丢：

| 参数 | 菜单 | 取值（网址参数） | 数据来源 |
|---|---|---|---|
| `genre` | 内容类型 | `教程/实践`、`模型发布`、`大佬观点`、`产品更新`、`现象/趋势`、`行业动态`、`论文/研究`、`评测/基准`、`政策/监管`、`开源/仓库`、`Skill/Agent 玩法`、`MCP/工具`、`开源生态`、`AI 编程`、`AI 变现/FDE`、`AI UI/设计`、`原理/机制`、`知识库`、`AI 视频`、`教材/课程`、`新玩法灵感`、`信息差` | `publications.tags` 里的类别标签 |
| `field` | 技术方向 | `Agent`、`编码`、`推理`、`多模态`、`语音`、`视频`、`图像生成`、`RAG`、`端侧`、`数据/训练`、`搜索`、`部署/工程`、`开源生态`、`具身智能`、`MCP/工具调用`、`设计/交互` | `publications.tags` 里的技术方向标签 |
| `platform` | 来源 | `x`、`aihot`、`youtube`、`bilibili`、`wechat`、`github`、`zhishixingqiu`、`web` | 发布时写进 `publications.platform` 的存储列 |

表格列的是网址里的参数值；菜单文案可能更短（例如 `现象/趋势` 显示为“行业趋势”，`Agent` 显示为“Agent / Skills”，`aihot` 显示为“行业镜像”），以 `packages/contracts/src/taxonomy.ts` 为准。

内容类型后十二项与学习轨的内容类型（`industry/taxonomy.ts` 里 kind 与分类标签的对应表）一一对应，词表、`GENRE_FILTERS` 和提示词三处一起改。`开源/仓库` 指某个具体项目的发布，`开源生态` 指盘点、选型与趋势。

来源判定不靠模型，发布时算一次存进 `publications.platform`（`packages/backend/src/publication/rules.ts` 的 `platformOf`），读取面只比较这一列，不在查询里重复推导：

- `x`：`publications.channel = 'x'`；X 帖子即使外链 YouTube，也只算 X。
- `wechat`：信源 `kind = 'mp_account'`，或文章 URL 主机是 `mp.weixin.qq.com`。
- `youtube` / `bilibili`：新闻渠道的文章 URL 主机分别为 `youtube.com` / `youtu.be` 与 `bilibili.com` / `b23.tv`（含子域名）。
- `web`：其余新闻 / RSS；只是 URL 路径里出现 `youtube.com` 字样的不算 YouTube。
- `aihot` / `github` / `zhishixingqiu`：地址和信源类型都推不出来，由写入这条内容的一方（镜像模块等）直接给出。
- 加列之前发布的行由 `scripts/backfill-publications-platform.ts` 按同一套规则分批回填；没有回填的行只出现在“全部来源”里。
- “一手（官方）”不是 `platform`，仍是原来的 `channel=firstParty`；来源菜单里二选一，选平台会清掉 `channel`，反过来也一样。

例子：

```text
/all?genre=教程/实践&field=Agent
/all?platform=x
/?platform=youtube&genre=模型发布
```

目前还没有公众号、YouTube、Bilibili、行业镜像、GitHub、知识星球信源，选这几项会如实显示空态，不会隐藏选项。新增筛选项时，选项表在 `packages/contracts/src/taxonomy.ts`；三个读取面（timeline、pool、group reports）和网页端的 `readFilters` / `filterParams` / `filterLabels` 要一起改，回归测试在 `tests/feed-filters.test.ts`。

## 检查

```bash
npm run typecheck
DATABASE_URL=postgres://…/<名字>_test npm test          # 库名以 _test 或 _ci 结尾
npm run build -w @aihot/web && node --test apps/web/tests/*.test.ts
# 私有模式下 smoke 需要会话 Cookie：
SMOKE_COOKIE="aihot_admin=…" node scripts/smoke.ts --base http://127.0.0.1:3000
```

## 目录

| 位置 | 内容 |
|---|---|
| `site/` | 站名文案、品牌与 Logo、条款页、根目录固定文件、更新日志、模块清单 |
| `industry/` | 分类、主题、示范信源、提示词、入选门槛 |
| `apps/` | web / api / worker 三个进程 |
| `packages/backend/` | 采集、内容、编辑、事件、公开读取层、日报、任务 |
| `database/migrations/` | 数据库迁移（按文件名排序执行） |
| `tests/` | 后端测试 |
| `docs/` | 上游文档、本阶段交付记录、部署与架构说明 |

## 许可与来源

代码沿用上游 **AIHOT** 开源框架（MIT，见 [`LICENSE`](LICENSE)）改造；ARGUS 的品牌、文案与视觉资产为本项目所有。原文版权归各来源，本站默认只展示摘要与原文链接。
