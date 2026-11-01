# ARGUS GitHub 开源榜单模块开发方案

-   版本：V1.0
-   模块名称：GitHub Open Source Rankings
-   所属产品：ARGUS --- AI Intelligence & Knowledge Hub
-   目标：在 ARGUS 中增加 GitHub 开源项目周榜与累计 Star 总榜，并提供 AI
    项目专项榜单
-   实施原则：复用 ARGUS / AIHOT 现有架构，免费优先，最小化新增组件

------------------------------------------------------------------------

## 0. 给 AI 编程助手的执行总指令

你负责在现有 ARGUS 项目中实现 GitHub 开源榜单模块。**这是 ARGUS
的一个独立业务模块，不是新建一个独立产品。**

开始开发前必须：

1.  先阅读 ARGUS 仓库中的
    `AGENTS.md`、README、架构文档、数据库模型、任务队列、路由、权限和测试文档。
2.  先运行现有项目，记录 `typecheck`、`test`、`build` 和 smoke test
    基线。
3.  以当前代码为准确认技术栈和数据模型；本文描述与实际代码冲突时，优先遵循现有实现，并记录差异。
4.  优先复用 AIHOT / ARGUS 已有的 Source Adapter、Worker、pg-boss
    任务队列、PostgreSQL、Fastify API、React Router 页面和设计系统。
5.  严格沿用项目根目录的 `design.md`：东方水墨 /
    自然编辑风、暖纸白、灰墨文字、克制的朱印红。不要重新设计品牌。
6.  每个阶段先说明修改文件、数据库迁移、接口和测试计划，再实施；完成后提供实际测试结果。
7.  不得将 GitHub Token 写入源码、前端
    bundle、日志或测试快照；通过后端环境变量或现有密钥管理配置。
8.  不绕过 GitHub
    登录、验证码、访问限制或反爬保护；优先使用公开页面和官方 REST
    API，遵守 GitHub 服务条款与 API 限额。
9.  不得声称未执行的测试已经通过，不得用虚构数据填充正式榜单。

### 本模块明确不做的事情

-   不计算 Star 周增长、增长率或增长速度。
-   不保存每日 Star 历史快照。
-   不生成 Star 增长曲线或增长率排行榜。
-   不接入 GH Archive。
-   不引入付费第三方榜单 API。
-   不单独建设 Python 服务、SQLite 数据库、GitHub Actions
    数据管道或第二套任务调度系统。
-   不把 GitHub
    仓库榜单强行当成普通文章，送入整套文章翻译、摘要和日报流程。
-   不在前端浏览器中直接调用 GitHub API 或暴露 GitHub Token。

------------------------------------------------------------------------

## 1. 产品目标与四个榜单

本模块只建设四个榜单，名称和口径必须在页面、API、数据库中保持一致。

  -------------------------------------------------------------------------------------
  榜单              数据来源          排序规则                 说明
  ----------------- ----------------- ------------------------ ------------------------
  全站周榜          GitHub Trending   保留 GitHub 页面原始顺序 官方 Trending 周榜
                    Weekly                                     

  全站总榜          GitHub REST       `stargazers_count` 降序  按累计 Star 排名
                    Search API                                 

  AI 周榜           全站 Trending     过滤 AI                  AI
                    Weekly + AI 分类  项目，保留原始周榜顺序   项目在官方周榜中的子集

  AI 总榜           GitHub REST       `stargazers_count` 降序  AI 项目累计 Star 排名
                    Search API + AI                            
                    分类                                       
  -------------------------------------------------------------------------------------

### 1.1 必须明确的口径

GitHub Trending 页面提供 Daily、Weekly、Monthly 周期，并没有官方的
All-time / Total Star 总榜入口。因此：

-   "周榜"直接采集 `https://github.com/trending?since=weekly`。
-   "总榜"通过 GitHub Search Repositories API，按累计 Star 倒序查询。
-   页面上将总榜命名为"累计 Star 总榜"，避免误称为 GitHub 官方 Trending
    All-time。
-   Trending 的排名算法没有公开的完整、可复算规则。GitHub
    历史官方说明曾提到趋势会综合
    Star、Fork、Commit、关注和页面访问等信号。因此必须保留 GitHub
    页面原始顺序，不能自行按 Star 数或 Star 增长重新排序。
-   GitHub Trending 的 Weekly 是 GitHub 自己定义的周周期，不在 ARGUS
    中另行计算自然周。

### 1.2 AI 周榜的范围说明

GitHub Trending 页面支持按编程语言筛选，但没有公开的 AI Topic 专项
Trending 入口。因此 MVP 的 AI 周榜定义为：

> 从 GitHub 全站 Trending Weekly 当前返回的仓库中，识别并筛选 AI
> 相关项目，保留这些项目在全站 Trending 中的原始先后顺序。

这意味着 AI 周榜是"全站官方周榜中的 AI 项目子集"，不是对 GitHub 全站所有
AI
仓库进行完整的七日热度扫描。页面应在说明文字中明确这一点，避免让用户误以为它覆盖所有
AI 仓库。

如果未来需要更完整的 AI 周榜，必须另立需求并明确排名口径；不能把累计
Star 排名伪装成周榜，也不能自行推算 Star 增长。

------------------------------------------------------------------------

## 2. 数据源与采集方式

### 2.1 数据源 A：GitHub Trending Weekly

入口：

``` text
https://github.com/trending?since=weekly
```

采集方式：

1.  由 ARGUS 后端 Worker 发起 HTTP GET 请求。
2.  优先使用现有 HTTP 客户端和 HTML 解析依赖；若项目已有
    Playwright，可作为页面兼容性备用方案，不要为本功能单独引入浏览器集群。
3.  使用 Cheerio 或项目已有 HTML parser 解析服务端返回的页面。
4.  从每个仓库卡片中提取：
    -   官方页面位置 `source_rank`
    -   `owner`
    -   `repository_name`
    -   `full_name`
    -   `html_url`
    -   `description`
    -   `primary_language`
    -   `stargazers_count`（累计 Star）
    -   `forks_count`（页面可稳定获取时）
    -   页面采集时间 `fetched_at`
5.  不解析、不计算、不保存"本周新增 Star"字段。
6.  严格按照 HTML 中仓库卡片的先后顺序生成 `source_rank`，不得按 Star
    数二次排序。
7.  页面结构变化、空列表、解析结果异常时，任务应失败并保留上一版成功数据，不能把空结果覆盖正式榜单。

解析注意事项：

-   不要依赖页面中某个易变的 CSS class 作为唯一识别条件。
-   优先使用稳定的语义结构、仓库链接格式和卡片容器组合定位。
-   将真实 HTML 样本保存为测试 fixture，建立解析器单元测试。
-   每次采集校验仓库数量、必填字段和重复仓库；数量异常时记录告警。
-   不绕过登录、验证码、访问限制或其他保护机制；遇到限制时停止重试并保留缓存。

### 2.2 数据源 B：全站累计 Star 总榜

使用 GitHub REST API：

``` http
GET https://api.github.com/search/repositories?q=stars%3A%3E0&sort=stars&order=desc&per_page=100&page=1
```

推荐请求头：

``` http
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2022-11-28
Authorization: Bearer ${GITHUB_TOKEN}
```

实现规则：

1.  `sort=stars`、`order=desc` 是总榜排序的唯一依据。
2.  MVP 默认采集 Top 100；如页面需要 Top 200 或 Top 500，再按页获取。
3.  每页最多 100 条，按 `page` 翻页。
4.  GitHub Search API 对单次查询最多提供 1,000
    条结果，因此本模块将全站总榜的最大候选范围限定为 Top
    1,000；不得宣称已遍历 GitHub 全部公开仓库。
5.  检查响应中的 `incomplete_results`。若为
    `true`，在任务记录中标记数据不完整，不得静默宣称结果完整。
6.  可按产品口径排除 Fork 仓库，但必须统一应用于全站总榜和 AI
    总榜，并在页面注明。默认建议排除
    Fork，减少复制仓库对榜单的干扰；归档仓库可以保留，但显示 Archived
    标签。
7.  不需要查询每个仓库的 Star 用户列表，也不需要逐个读取 Star 时间戳。

### 2.3 数据源 C：AI 总榜候选仓库

AI 总榜不能只从全站 Top 1,000 中筛选，否则可能漏掉累计 Star
很高、但没有进入全站 Top 1,000 的 AI 项目。

因此采用 GitHub Search API 的 `topic:`
查询发现候选仓库，再统一去重、分类和按累计 Star 排序。

核心查询示例：

``` http
GET https://api.github.com/search/repositories?q=stars%3A%3E0+topic%3Allm&sort=stars&order=desc&per_page=100
```

建议维护可配置的 Topic 查询词库：

  ----------------------------------------------------------------------------------------------------
  分类                                Topic 查询词
  ----------------------------------- ----------------------------------------------------------------
  AI / ML 基础                        `artificial-intelligence`、`machine-learning`、`deep-learning`

  LLM / 生成式 AI                     `llm`、`large-language-models`、`generative-ai`

  Agent                               `ai-agent`、`ai-agents`、`agentic-ai`

  MCP                                 `mcp`、`model-context-protocol`

  RAG / 知识库                        `rag`、`retrieval-augmented-generation`、`vector-database`

  模型推理                            `inference`、`model-serving`、`ollama`、`vllm`

  模型训练                            `fine-tuning`、`lora`、`model-training`

  多模态                              `multimodal`、`computer-vision`、`speech-recognition`

  图像生成                            `stable-diffusion`、`diffusion-models`

  AI 开发框架                         `langchain`、`llamaindex`、`transformers`
  ----------------------------------------------------------------------------------------------------

执行策略：

1.  每个 Topic 单独发起 Search API 查询，按 Star 倒序，每个 Topic MVP
    默认取 Top 100。
2.  合并全部查询结果，以 GitHub Repository ID 去重。
3.  保留仓库命中的 Topic 来源，供分类和后台排查使用。
4.  根据分类规则识别是否属于 AI 项目。
5.  对最终候选仓库按 `stargazers_count` 降序，生成 AI 累计 Star 总榜。
6.  对同一仓库命中多个 Topic 的情况只保留一条记录，但允许拥有多个 AI
    分类。
7.  查询词库应配置化，新增或删除 Topic 不需要修改采集核心代码。

注意：Topic 查询覆盖的是有相应 Topic 标注的仓库，不等于 GitHub 全部 AI
项目。项目应在 UI 或帮助说明中注明"基于公开 Topic 与仓库元数据识别"。

------------------------------------------------------------------------

## 3. AI 项目识别与分类

### 3.1 MVP 采用规则优先，不依赖付费 LLM

AI 项目分类不需要为每个仓库调用外部大模型。优先使用：

1.  GitHub Topics。
2.  Repository Description。
3.  仓库名称。
4.  必要时读取 README 的标题和前几段作为辅助证据。
5.  管理员人工纳入 / 排除规则。

这套方式可免费运行、结果可解释、易于调试。未来如确有大量边界项目，再考虑调用
ARGUS 已配置的模型对低置信度项目辅助分类；该能力不是 MVP 必需项。

### 3.2 AI 项目判定原则

判断标准：

> AI 必须是项目的核心功能、核心技术或主要应用方向，而不是 README
> 中偶然提到 AI。

强匹配信号：

-   Topics 命中明确 AI 标签，例如
    `llm`、`ai-agent`、`rag`、`mcp`、`machine-learning`。
-   Description 明确说明项目是 AI Agent、LLM 框架、模型推理服务、RAG
    系统或 AI 应用。
-   README 的项目定位和核心功能明确属于 AI 领域。

排除信号：

-   项目只是普通业务系统，README 中顺带提到 AI。
-   项目只是调用某个 AI API，但核心产品与 AI 无关。
-   Topic 过于宽泛，且 Description / README 无法证明其 AI 属性。
-   仓库是教程集合、导航列表或资源清单时，可归入"AI 资源 /
    教程"，不要误归入 Agent 或模型框架。

### 3.3 AI 分类体系

一个仓库允许多个分类标签，但应设置一个主分类。

  -----------------------------------------------------------------------------------------------
  主分类                  覆盖范围                          示例关键词
  ----------------------- --------------------------------- -------------------------------------
  AI Agent                Agent 框架、自治 Agent、多 Agent  agent、agentic、autonomous

  MCP / Skills            MCP Server、MCP                   mcp、model-context-protocol、skills
                          Client、Skills、工具连接          

  LLM / 模型              大语言模型、模型权重、模型生态    llm、language-model、transformer

  RAG / 知识库            检索增强、Embedding、向量数据库   rag、embedding、vector-database

  AI 基础设施             推理部署、Serving、GPU 优化       inference、serving、vllm、ollama

  模型训练                训练、微调、LoRA、评测            fine-tuning、lora、training

  多模态 AI               图像、语音、视频、视觉、多模态    multimodal、vision、speech

  AI 开发工具             AI 编程、代码助手、Prompt         coding-agent、code-assistant
                          工具、Agent IDE                   

  AI 应用                 面向用户的 AI 产品和应用          assistant、copilot、generative-app
  -----------------------------------------------------------------------------------------------

### 3.4 分类结果管理

每个仓库至少保存：

-   `is_ai`
-   `ai_primary_category`
-   `ai_categories`
-   `classification_method`：topic / description / readme / manual
-   `classification_confidence`
-   `matched_topics`
-   `manual_override`：人工覆盖规则
-   `classified_at`
-   `taxonomy_version`

管理员可以维护：

-   AI 项目白名单：强制纳入。
-   非 AI 项目黑名单：强制排除。
-   分类修正：修改主分类或增加分类标签。
-   Topic 词库：新增、禁用、调整分类归属。

人工修正优先级高于自动规则，后续采集不得无条件覆盖人工结论。

------------------------------------------------------------------------

## 4. 数据处理与榜单生成流程

``` mermaid
flowchart TD
    A[定时任务 / 手动刷新] --> B[GitHub Trending Weekly 页面]
    A --> C[GitHub REST Search API]

    B --> D[Trending HTML 解析]
    C --> E[总榜与 AI Topic 候选采集]

    D --> F[仓库标准化与去重]
    E --> F

    F --> G[AI 项目识别与分类]

    G --> H[全站周榜]
    G --> I[全站累计 Star 总榜]
    G --> J[AI 周榜：全站周榜过滤]
    G --> K[AI 累计 Star 总榜]

    H --> L[PostgreSQL 当前榜单数据]
    I --> L
    J --> L
    K --> L

    L --> M[Fastify API]
    M --> N[ARGUS 开源榜单页面]
```

### 4.1 四个榜单的生成规则

**全站周榜**

-   来源：Trending Weekly 页面。
-   `rank = source_rank`。
-   不按 Star 数重排。
-   只展示 GitHub 页面实际返回的项目。

**AI 周榜**

-   输入：全站周榜仓库集合。
-   过滤：`is_ai = true`。
-   保留原始 `source_rank`。
-   另生成连续的 `ai_rank`，用于显示 AI 子榜单序号。
-   排序依据仍是原始 Trending 顺序，不重新计算热度。

**全站累计 Star 总榜**

-   来源：Search Repositories API。
-   `sort=stars&order=desc`。
-   `rank` 按 API 返回顺序生成。
-   不计算任何增长指标。

**AI 累计 Star 总榜**

-   输入：多组 AI Topic Search API 候选仓库。
-   以 Repository ID 去重。
-   过滤 `is_ai = true`。
-   按 `stargazers_count` 降序。
-   如 Star 数相同，使用 `full_name` 字母序作为稳定的次级排序条件。

------------------------------------------------------------------------

## 5. ARGUS 技术架构集成

### 5.1 不新建独立技术栈

以现有 ARGUS / AIHOT 工程为准，优先复用：

  层次     沿用技术                                 本模块职责
  -------- ---------------------------------------- ----------------------------------
  前端     React Router + 当前组件体系 + Tailwind   榜单页面、筛选、详情
  API      Fastify                                  榜单查询、仓库详情、管理接口
  采集     TypeScript / Node.js                     Trending HTML 与 GitHub REST API
  任务     现有 Worker + pg-boss                    定时刷新、手动刷新、失败重试
  数据库   PostgreSQL                               仓库元数据、榜单排名、任务记录
  部署     现有 Docker Compose                      复用现有服务部署

不要因为 GitHub 模块而新增 Python、SQLite、Redis、第二套
PostgreSQL、独立 Next.js 项目或独立 GitHub Actions 流水线。

### 5.2 模块边界

建议在现有代码结构中增加独立 GitHub Domain：

``` text
src/
├── modules/
│   └── github/
│       ├── adapters/
│       │   ├── github-trending.adapter.ts
│       │   └── github-search.adapter.ts
│       ├── services/
│       │   ├── github-collector.service.ts
│       │   ├── github-normalizer.service.ts
│       │   ├── github-ai-classifier.service.ts
│       │   └── github-ranking.service.ts
│       ├── repositories/
│       │   └── github.repository.ts
│       ├── jobs/
│       │   └── refresh-github-rankings.job.ts
│       ├── routes/
│       │   └── github-ranking.routes.ts
│       ├── schemas/
│       │   └── github-ranking.schema.ts
│       └── types/
│           └── github.types.ts
```

以上为建议结构。实际开发必须先检查现有目录规范，若已有
`sources`、`integrations` 或 `domains`
结构，应按项目现有组织方式落位，不要强行创建重复分层。

### 5.3 与 ARGUS 内容系统的关系

GitHub 榜单首先是"开源项目资源 / 排名数据"，不是普通文章。

-   仓库元数据进入 GitHub Repository 资源模型。
-   榜单排名通过独立 Ranking Entry 关联仓库。
-   如 ARGUS 已有 Resource / Source 模型，优先扩展复用。
-   不要把同一仓库每次刷新都创建成一篇新文章。
-   不要默认对所有仓库调用 AI 翻译、摘要、日报和热点聚类。
-   用户后续收藏仓库时，可复用 ARGUS 现有收藏能力。

------------------------------------------------------------------------

## 6. 数据库设计

先检查 AIHOT / ARGUS 现有模型。若没有可复用的资源实体，再新增以下表。

### 6.1 `github_repositories`

仓库主数据，一仓库一条记录，以 GitHub Repository ID 为唯一键。

  字段                          类型建议      说明
  ----------------------------- ------------- ----------------------------
  `id`                          BIGINT        GitHub Repository ID，唯一
  `node_id`                     TEXT          GitHub Node ID
  `full_name`                   TEXT          owner/repo，唯一索引
  `owner_login`                 TEXT          仓库所有者
  `name`                        TEXT          仓库名称
  `html_url`                    TEXT          GitHub 仓库地址
  `description`                 TEXT          仓库简介
  `homepage`                    TEXT          项目主页
  `language`                    TEXT          主要语言
  `stargazers_count`            INTEGER       当前累计 Star
  `forks_count`                 INTEGER       Fork 数
  `open_issues_count`           INTEGER       开放 Issue 数
  `license_spdx_id`             TEXT          License
  `topics`                      JSONB         GitHub Topics
  `is_fork`                     BOOLEAN       是否 Fork
  `is_archived`                 BOOLEAN       是否归档
  `created_at`                  TIMESTAMPTZ   GitHub 创建时间
  `updated_at`                  TIMESTAMPTZ   GitHub 更新时间
  `pushed_at`                   TIMESTAMPTZ   最近 Push 时间
  `is_ai`                       BOOLEAN       是否 AI 项目
  `ai_primary_category`         TEXT          AI 主分类
  `ai_categories`               JSONB         AI 多分类
  `classification_method`       TEXT          分类依据
  `classification_confidence`   NUMERIC       分类置信度
  `matched_topics`              JSONB         命中的 Topic
  `manual_override`             TEXT          include / exclude / null
  `taxonomy_version`            TEXT          分类规则版本
  `last_seen_at`                TIMESTAMPTZ   最近一次采集时间
  `synced_at`                   TIMESTAMPTZ   最近一次元数据同步时间

### 6.2 `github_ranking_entries`

当前榜单数据。若 ARGUS 已有通用 Ranking / Ranking Entry 模型，优先复用。

  字段              类型建议           说明
  ----------------- ------------------ -----------------------------------------------
  `id`              UUID / BIGSERIAL   主键
  `board_type`      TEXT               all_weekly / all_stars / ai_weekly / ai_stars
  `repository_id`   BIGINT             关联仓库
  `rank`            INTEGER            当前榜单序号
  `source_rank`     INTEGER            GitHub 官方 Trending 原始位置
  `fetched_at`      TIMESTAMPTZ        本次采集时间
  `source_url`      TEXT               数据来源地址

唯一约束建议：`(board_type, repository_id)`。

### 6.3 `github_collection_runs`

采集运行记录，用于后台状态和故障排查。

  字段                   类型建议      说明
  ---------------------- ------------- --------------------------------------
  `id`                   UUID          运行 ID
  `source_type`          TEXT          trending / search_all / search_ai
  `status`               TEXT          running / success / partial / failed
  `started_at`           TIMESTAMPTZ   开始时间
  `finished_at`          TIMESTAMPTZ   结束时间
  `items_count`          INTEGER       获取数量
  `error_message`        TEXT          错误摘要
  `incomplete_results`   BOOLEAN       Search API 是否返回不完整结果

### 6.4 存储策略

-   榜单仅维护当前有效结果。
-   仓库元数据按 Repository ID Upsert。
-   榜单刷新成功后，在事务中替换对应 `board_type` 的当前排名。
-   失败时不清空旧榜单。
-   可保留采集运行日志用于排障，但不保存每日 Star 时间序列。
-   不创建 `star_history`、`star_growth`、`growth_rate` 等表或字段。

------------------------------------------------------------------------

## 7. 定时任务与刷新策略

### 7.1 推荐频率

使用 ARGUS 现有 pg-boss / Worker：

  ----------------------------------------------------------------------------------
  任务                    频率建议                说明
  ----------------------- ----------------------- ----------------------------------
  Trending Weekly 采集    每天 1 次               周榜周期仍由 GitHub
                                                  定义，只是每天刷新当前结果

  全站累计 Star 总榜      每天 1 次               更新累计 Star 排名

  AI Topic 候选采集       每天 1 次               更新 AI 总榜候选集合

  AI 分类                 随采集触发              仅处理新增或元数据发生变化的仓库

  手动刷新                管理员触发              复用相同 Job，不在 HTTP
                                                  请求中同步爬取
  ----------------------------------------------------------------------------------

推荐时间：每天 08:00，时区 `Asia/Shanghai`。具体应沿用 ARGUS
现有调度时区配置。

### 7.2 任务执行顺序

1.  获取 Trending Weekly HTML。
2.  解析并校验项目列表。
3.  获取全站累计 Star 总榜。
4.  按配置的 Topic 列表获取 AI 候选仓库。
5.  合并、去重并更新仓库主数据。
6.  对新增或变化仓库执行 AI 分类。
7.  生成四个榜单。
8.  事务更新当前榜单。
9.  更新运行状态、最后成功时间和错误信息。

### 7.3 幂等与失败处理

-   相同 Repository ID 不得重复创建。
-   同一任务重复执行不得产生重复榜单条目。
-   API 429 / 403 限流时读取响应头，遵守 `Retry-After` 或
    `X-RateLimit-Reset`，不要持续快速重试。
-   网络超时采用有限次数指数退避。
-   Trending 页面结构异常时保留上一版数据。
-   单个 Topic 查询失败时记录 partial 状态，不影响其他 Topic 的结果。
-   前端始终显示最近成功采集时间；数据过期时展示"数据更新失败，当前为上次成功结果"。

------------------------------------------------------------------------

## 8. 后端 API 设计

接口路径应适配现有 Fastify 路由规范。

### 8.1 查询榜单

``` http
GET /api/github/rankings?board=all_weekly&page=1&pageSize=50
```

`board` 允许值：

-   `all_weekly`
-   `all_stars`
-   `ai_weekly`
-   `ai_stars`

可选参数：

-   `page`
-   `pageSize`
-   `language`
-   `category`
-   `keyword`

规则：

-   `all_weekly`、`ai_weekly` 不能因为用户选择排序字段而破坏官方顺序。
-   `all_stars`、`ai_stars` 默认按累计 Star 降序。
-   `category` 只对 AI 榜单生效。
-   `keyword` 对 `full_name`、`description` 做后端查询。

### 8.2 仓库详情

``` http
GET /api/github/repositories/:repositoryId
```

返回仓库元数据、AI 分类、当前所属榜单和 GitHub 原始地址。

### 8.3 分类选项

``` http
GET /api/github/categories
```

返回 AI 分类列表和各分类项目数量。

### 8.4 管理接口

``` http
POST /api/admin/github/refresh
GET  /api/admin/github/status
PUT  /api/admin/github/repositories/:repositoryId/classification
```

管理接口必须复用 ARGUS 现有管理员鉴权，不得只依赖前端隐藏按钮。

------------------------------------------------------------------------

## 9. 前端页面与交互

### 9.1 页面入口

建议在 ARGUS 的"资源库"中增加"GitHub
开源榜单"子页面；如果现有导航结构更适合独立入口，可遵循当前导航规则，但不要重复建设第二套资源库。

页面标题：

**GitHub 开源趋势**

副标题：

**发现值得关注的开源项目**

### 9.2 四个 Tab

页面顶部提供四个明确 Tab：

1.  全站周榜
2.  全站总榜
3.  AI 周榜
4.  AI 总榜

每个 Tab 显示独立榜单，不要把四个榜单混在一个列表中。

### 9.3 筛选能力

-   编程语言筛选。
-   AI 分类筛选（仅 AI 榜单）。
-   仓库名称 / 描述搜索。
-   每页 20 / 50 / 100 条。
-   显示数据更新时间。

注意：周榜只能过滤，不能改变原始排名顺序；总榜可以继续按累计 Star
排序，但默认顺序必须是 Star 降序。

### 9.4 项目卡片字段

建议展示：

-   排名序号。
-   Owner / Repository Name。
-   项目简介。
-   累计 Star 数。
-   Fork 数（可选）。
-   主要编程语言。
-   AI 分类标签（AI 榜单显示）。
-   Topics。
-   最近更新时间。
-   GitHub 原文链接。

禁止展示：

-   本周新增 Star（本模块不采集该字段）。
-   Star 增长率。
-   Star 增长曲线。
-   自行计算的 Trending 热度分。

AI 周榜可以同时显示：

-   AI 子榜序号，例如 `AI #3`。
-   全站 Trending 原始位置，例如 `全站周榜 #12`。

### 9.5 页面视觉

严格遵循 `design.md`：

-   暖纸白背景、深墨文字、浅色卡片。
-   轻边框、克制阴影、充足留白。
-   朱印红只用于少量重点标记。
-   以清晰的信息列表为主，不做高饱和科技仪表盘。
-   桌面端优先保证信息密度，移动端改为单列卡片。
-   加载、空结果、部分失败、数据过期和接口错误均有明确状态。

------------------------------------------------------------------------

## 10. 配置项

建议增加以下环境变量或复用现有配置中心：

``` env
GITHUB_TOKEN=
GITHUB_API_BASE_URL=https://api.github.com
GITHUB_TRENDING_WEEKLY_URL=https://github.com/trending?since=weekly

GITHUB_RANKING_PAGE_SIZE=100
GITHUB_ALL_STARS_LIMIT=100
GITHUB_AI_TOPIC_PAGE_SIZE=100

GITHUB_REFRESH_CRON=0 8 * * *
GITHUB_TIMEZONE=Asia/Shanghai

GITHUB_HTTP_TIMEOUT_MS=15000
GITHUB_MAX_RETRIES=3
GITHUB_AI_TAXONOMY_VERSION=v1
```

说明：

-   `GITHUB_TOKEN` 可选，但建议配置只用于读取公开数据的 Token，以提升
    API 限额和运行稳定性。
-   不申请写仓库、创建 Issue、修改代码等权限。
-   不在前端暴露 Token。
-   Topic 查询词库建议放在数据库配置或
    `github-ai-topics.yml`，便于维护。
-   如果 ARGUS 已有统一的外部 API
    凭证配置，应优先复用，不要重复建设密钥管理。

------------------------------------------------------------------------

## 11. 测试用例与验收标准

### 11.1 采集测试

1.  Trending Weekly 正常 HTML 能解析出仓库名称、描述、语言、累计 Star
    和原始位置。
2.  Trending HTML 结构变化时解析器能明确报错，不会写入空榜单。
3.  Trending 页面仓库顺序与生成的 `source_rank` 一致。
4.  不会将周榜按 Star 总数二次排序。
5.  Search API `sort=stars&order=desc` 返回结果按累计 Star 降序。
6.  Search API 分页和 Top 1,000 限制处理正确。
7.  Search API `incomplete_results=true` 时能标记数据不完整。
8.  某个 AI Topic 查询失败时，其他 Topic 查询仍能完成。
9.  多个 Topic 返回同一仓库时，只生成一条仓库记录。
10. 仓库改名后以 GitHub Repository ID 识别同一仓库，更新 `full_name`。

### 11.2 AI 分类测试

1.  带有 `llm`、`ai-agent`、`mcp`、`rag` 等强 Topic 的项目能正确分类。
2.  Description 明确为 AI Agent 或模型推理服务的项目能识别。
3.  普通项目仅在 README 中偶然提到 AI 时，不应直接纳入。
4.  同一项目命中多个 Topic 时允许多个分类，但只出现一次。
5.  管理员手动排除的项目不会被自动规则重新纳入。
6.  管理员手动纳入的项目不会被自动规则覆盖。
7.  分类规则升级后可识别 `taxonomy_version` 并按策略重新分类。

### 11.3 榜单测试

1.  全站周榜严格保持 GitHub Trending 原始顺序。
2.  AI 周榜是全站周榜的过滤子集，原始先后顺序不变。
3.  AI 周榜同时展示 AI 子榜序号和全站原始位置。
4.  全站总榜按累计 Star 降序。
5.  AI 总榜按累计 Star 降序。
6.  同一仓库不会在同一榜单中重复出现。
7.  刷新失败时旧榜单仍可正常访问。
8.  前端不展示任何 Star 增长或增长率字段。

### 11.4 API / UI / 运行测试

1.  四个 Tab 能独立加载正确榜单。
2.  语言、AI 分类、关键词筛选正常。
3.  周榜筛选后不改变项目之间的原始顺序。
4.  数据更新时间展示准确。
5.  手动刷新只创建后台任务，HTTP 请求不会长时间阻塞。
6.  API 限流时不会无限重试。
7.  GitHub Token 不出现在浏览器请求、前端 bundle 和日志中。
8.  桌面、平板和移动端布局正常。
9.  无数据、采集失败、部分 Topic 失败和数据过期状态均有明确提示。

### 11.5 MVP 验收条件

-   四个榜单全部可用。
-   Trending 周榜保留 GitHub 原始顺序。
-   两个总榜都按累计 Star 排名。
-   AI 分类结果可解释、可人工修正。
-   定时刷新和手动刷新可用。
-   失败时有缓存回退和运行日志。
-   不新增独立数据库、独立调度系统或付费数据服务。
-   不包含 Star 增长计算和每日 Star 历史快照。

------------------------------------------------------------------------

## 12. 分阶段开发顺序

### Phase 0：现有工程审查

-   阅读 AIHOT / ARGUS 项目结构。
-   确认现有 Resource、Source、Worker、Job、收藏和权限模型。
-   确认现有依赖中是否已有 HTML parser、HTTP client 和 pg-boss。
-   运行项目并记录基线测试结果。
-   输出复用清单和改造文件清单。

验收：不修改核心业务逻辑，明确最小接入点。

### Phase 1：GitHub 采集 Adapter

-   实现 Trending Weekly HTML Adapter。
-   实现 Search API Adapter。
-   建立 HTML fixture 和解析测试。
-   完成 Repository 标准化与去重。
-   实现限流、超时、重试和失败缓存。

验收：可以在后台任务中稳定获取全站周榜和累计 Star 总榜候选数据。

### Phase 2：AI 项目识别

-   建立 Topic 查询词库。
-   实现多 Topic Search 和结果合并。
-   实现规则分类与多标签。
-   实现人工 include / exclude 覆盖。
-   生成 AI 周榜和 AI 总榜。

验收：四个榜单的数据口径和排序规则正确。

### Phase 3：数据库与后端 API

-   复用或扩展仓库资源模型。
-   建立当前榜单数据和采集运行记录。
-   实现榜单查询、详情、分类和管理接口。
-   加入定时任务和手动刷新任务。
-   实现事务替换和失败回退。

验收：API 返回稳定、数据可追溯、任务幂等。

### Phase 4：前端榜单页面

-   在 ARGUS 资源库中增加 GitHub 开源榜单入口。
-   实现四个 Tab。
-   实现项目卡片、分页、搜索、语言筛选和 AI 分类筛选。
-   显示数据更新时间和失败状态。
-   按 `design.md` 完成响应式样式。

验收：页面可完整浏览四个榜单，视觉与 ARGUS 一致。

### Phase 5：联调与交付

-   完成端到端测试。
-   验证 Token 安全、API 限额和失败回退。
-   验证定时任务和手动刷新。
-   更新 `.env.example`、README 和部署文档。
-   输出测试报告、改动文件清单和已知限制。

验收：在现有 ARGUS 部署环境中可稳定运行。

------------------------------------------------------------------------

## 13. 已知限制与产品文案

必须在实现和页面说明中如实表达以下限制：

1.  GitHub Trending 没有公开的完整 API，周榜通过公开 HTML
    页面采集；页面结构变化时需要维护解析器。
2.  GitHub Trending 的完整排名算法没有公开可复算规则。ARGUS 只保留
    GitHub 原始顺序，不宣称自己复刻了算法。
3.  AI 周榜是全站 Trending Weekly 中 AI 项目的过滤子集，不是 GitHub
    全站所有 AI 项目的完整周榜。
4.  GitHub Search API 每个查询最多返回 1,000 条结果；全站累计 Star
    总榜不能宣称覆盖全部公开仓库。
5.  AI 总榜依赖 Topic 查询和分类规则，未打 Topic 标签的 AI
    仓库可能被遗漏；可以通过人工纳入规则补充。
6.  榜单只反映采集时间点的数据，页面必须显示最近更新时间。

推荐页面说明：

-   全站周榜：`排名沿用 GitHub Trending Weekly 官方页面顺序。`
-   全站总榜：`按 GitHub 公开仓库累计 Star 数排序。`
-   AI
    周榜：`从 GitHub Trending Weekly 中筛选 AI 相关项目，保留官方原始顺序。`
-   AI
    总榜：`基于 GitHub Topics 与仓库信息识别 AI 项目，并按累计 Star 数排序。`

------------------------------------------------------------------------

## 14. 官方参考资料

-   GitHub Trending Weekly：<https://github.com/trending?since=weekly>
-   GitHub 官方 Trending
    说明：<https://github.blog/news-insights/company-news/explore-what-is-trending-on-github/>
-   GitHub REST API ---
    Search：<https://docs.github.com/en/rest/search/search>
-   GitHub 搜索语法 --- Repository / Topic /
    Stars：<https://docs.github.com/en/search-github/searching-on-github/searching-for-repositories>
-   GitHub REST API Rate
    Limits：<https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api>
-   ARGUS 上游基础工程 AIHOT：<https://github.com/KKKKhazix/AIHOT>

------------------------------------------------------------------------

## 15. 最终执行摘要

本模块只做四个榜单：

1.  **全站周榜**：抓取 GitHub Trending Weekly，保留官方顺序。
2.  **全站总榜**：GitHub Search API，按累计 Star 降序。
3.  **AI 周榜**：从全站周榜中筛选 AI 项目，保留官方顺序。
4.  **AI 总榜**：通过 AI Topic 查询发现项目，分类后按累计 Star 降序。

技术上复用 ARGUS 现有 TypeScript /
Node.js、Fastify、PostgreSQL、pg-boss、React Router 和 Docker Compose。

**不做 Star 增长计算、不保存每日 Star 快照、不引入 GH
Archive、不购买第三方数据服务、不另建一套技术栈。**
