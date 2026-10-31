# ARGUS Phase 0–1 交付记录

- 日期：2026-10-30
- 上游基线：`KKKKhazix/AIHOT`，commit `c535666`
- 方案：`ARGUS_最终版开发方案.md` V1.0 Final
- 设计：`design.md` V1.0 Final（东方水墨 / 自然编辑风）

## 1. Phase 0 基线审查

### 1.1 技术栈与进程

| 项 | 实际实现 |
|---|---|
| 语言/运行时 | TypeScript / Node.js 24+（本机 26.8.2） |
| 前端 | React Router 7 服务端渲染，Tailwind CSS 4 |
| API | Fastify |
| 数据库 | PostgreSQL 17，迁移在 `database/migrations/`（64 个） |
| 队列 | pg-boss |
| 部署 | Docker Compose（db / setup / api / worker / web / caddy） |
| 模型 | OpenAI 兼容接口，步骤级模型配置在 `site/models.ts` |

### 1.2 复用清单

直接复用，不改核心：

- 六种信源 Adapter：`rss`、`web_list`、`json_list`、`x_search`、`mp_account`、`external`。
- 内容入库、精确去重、正文提取、付费请求回执与预算熔断。
- 预筛、两次独立评分、中文标题/摘要/推荐理由、结构化、事件聚类、综述。
- 日报 / 周报 / 月报、热点、主题页、搜索、收藏、后台、RSS / API v1 / MCP / llms.txt。
- 公开读取层 `packages/backend/src/publication/`。

按方案扩展：

- `site/`：品牌、文案、导航、Logo、条款、manifest、changelog。
- `industry/`：主题、标签、信源、提示词、门槛。
- `apps/web` + `apps/api`：首页品牌首屏、私有访问门禁。
- `scripts/smoke.ts`：私有部署的会话 Cookie 支持。

### 1.3 基线测试（改品牌前）

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm test`（PostgreSQL 17） | 947 个用例，946 通过，1 失败 |
| 失败用例 | `tests/outbound-protocol.standalone.test.ts` 的 secure-proxy TLS 用例：`TypeError: fetch failed` |

该失败在改品牌前即存在，属于本机 Node 26 / TLS 代理环境差异；不是本次改动引入。

## 2. Phase 1 已交付

### 2.1 品牌与视觉

- `site/site.ts`：站名 ARGUS、主标语、描述、关键词、MCP 前缀 `argus`、抓取 UA `ARGUSBot/1.0`、关于页与卡片文案。
- `site/brand/Logo.tsx`：`BrandMark`（圆形观测之眼 + 三层山峦 + 朱印点）、`Wordmark`（衬线字标 + 副标题）、`RingMark`。
- `site/brand/logo.svg`、`favicon.svg`、`icon.png`（512）、`icon-192.png`、`apple-icon.png`（180）、`favicon.ico`（16/32/48）。
- `apps/web/app/app.css`：
  - 设计令牌：`--bg #F5F2EB`、`--surface #FBF9F4`、`--ink #242521`、`--ink-3 #555750`、`--line #DEDAD1`、`--seal-red #B65E52`。
  - 交互色改为墨褐 `#655B4D`，印章红只用于小面积标记。
  - 新增衬线字体栈 `--font-serif`、`brand-hero` 山水纹理与深色主题映射。
- `apps/web/app/routes/home.tsx`：首页品牌首屏（主标语、辅助文案、说明），仅未筛选时显示。
- `apps/web/app/routes/about.tsx`：关于页大标题改为衬线。
- 导航：首页、全部情报、热点、AI 日报、主题知识库、收藏与待读、Agent 接入、关于 ARGUS、更新日志、反馈。
- `site/public/robots.txt`：私有站点禁止收录；`manifest.webmanifest` 改为纸白主题色；`changelog.json` 更新为 ARGUS 上线记录。

### 2.2 私有访问

设计：**Web 文档门禁 + API 统一门禁 + SSR 内部令牌**。

- `packages/backend/src/config.ts`
  - `PRIVATE_ACCESS`（默认 false，`.env.example` 默认 true）
  - `INTERNAL_TOKEN`（web ↔ api 的服务端渲染共享密钥）
- `apps/api/src/private.ts`
  - `PRIVATE_ACCESS=true` 时拦截除 `/api/auth/*`、`/api/admin/*`、`/api/health`、`/api/ingest/*` 与品牌静态资源外的所有请求。
  - 有会话 Cookie 放行；SSR 携带正确 `x-argus-internal` 放行；否则 401。
  - 在 `onSend` 统一覆盖路由自带的缓存头，强制 `Cache-Control: private, no-store`、`Vary: Cookie`，防止共享缓存保存登录后的数据。
  - 缺失或过短的 `INTERNAL_TOKEN` 时拒绝启动。
- `apps/web/server.ts`
  - 非 API 请求先向 `/api/auth/check` 校验会话；未登录 302 到 `/admin/login?return=…`。
  - `.data` 请求未登录返回 401，避免把 HTML 登录页塞进路由数据。
  - 私有模式下所有页面 `private, no-store` + `X-Robots-Tag: noindex, nofollow`。
  - 签名静态资源、登录页、健康检查放行。
- `packages/backend/src/admin/auth.ts`
  - `safeReturn` 支持任意同站路径（登录后回到原页面），拒绝协议相对、`javascript:`、`data:`、API 路径与超长路径。
- `apps/web/app/routes/admin-login.tsx`：登录后回到原页面；文案改为“私有站点 / 访问密码”。
- `apps/web/app/routes/more.tsx`：新增“账户”分组，含“关注源与采集”和“退出登录”。
- `.env.example`、`scripts/init-env.ts`、`docker-compose.yml`：生成并透传 `PRIVATE_ACCESS`、`INTERNAL_TOKEN`。

### 2.3 AI 主题与信源

- `industry/topics.json`
  - 新增：`UI/UX 与 AI 设计`、`RAG 与数据工程`。
  - 调整：`Vibe Coding / AI 编程`、`Agent / Skills / MCP`、`产品发布与行业趋势`、`MCP 与工具生态`。
- `industry/taxonomy.ts`：标签词表新增 `设计/交互`。
- `industry/sources.json`：新增 5 个已验证可访问的 RSS（arXiv cs.AI、arXiv cs.CL、Hacker News、LangChain Blog、Vercel Blog），共 23 个首批信源。
- 未接入（留待 Phase 3）：YouTube / Bilibili 视频 Adapter、X 账号（需 SocialData 凭证）、Reddit（本机网络超时）。

## 3. 验证结果

### 3.1 类型与构建

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run build -w @aihot/web` | 通过 |
| `npm test` | 948 用例，947 通过，1 失败 |
| 新增 `tests/private-access.test.ts` | 通过（未授权 401、SSR 令牌 200、伪造令牌 401、公开端点 200、强缓存头） |

唯一失败：

- `outbound-protocol.standalone.test.ts` secure-proxy：基线已存在，属本机 Node 26/TLS 环境差异；相关代码未改动。

### 3.2 私有访问实测

| 场景 | 结果 |
|---|---|
| 未登录访问 `/` | 302 → `/admin/login?return=%2F`，`no-store` + `noindex` |
| 未登录访问 `/api/site/timeline`（直连 api） | 401 |
| 登录后 `/api/site/timeline` 响应头 | `cache-control: private, no-store`、`vary: Cookie` |
| 未登录访问 `/api/v1/items`、`/api/mcp`、`/feed.xml`（直连 api） | 401 |
| 未登录访问 `/feed.xml`、`/sitemap.xml`、`/llms.txt`（经 web） | 302 登录页 |
| `/api/health` | 200 |
| `/robots.txt`、`/manifest.webmanifest`、`/icon.png` | 200（公开品牌资源） |
| 密码登录 | 303 → 原页面，设置 HttpOnly / SameSite=Lax / 30 天会话 |
| 登录后 `/`、`/feed.xml`、`/api/v1/items`、`/api/site/meta`、`/sitemap.xml`、`/llms.txt` | 200 |
| 退出登录 | 303，旧 Cookie 再访问 `/` 回到登录页 |

`node scripts/smoke.ts` 带 `SMOKE_COOKIE` 运行：全部检查通过（含 MCP initialize）。

### 3.3 页面检查

Playwright + 系统 Chrome，桌面 1440×1000、平板 900×1000、手机 390×844：

- 截图：`../../artifacts/screenshots/{desktop,tablet,mobile}-{login,home,topics,about}.png`
- 检查：首页品牌首屏、登录页、主题目录、关于页在三种宽度下布局正常；无页面级脚本错误（登录前有预期内的 401 资源请求）。
- 浅色与深色主题均按设计令牌渲染；浅色为默认验收视觉。

## 4. 已知限制与后续

- Phase 2 的真实内容生成需要 `LLM_API_KEY`；当前 `.env` 关闭采集与模型调用，页面为真实空状态，未填充任何虚构内容。
- 视频（YouTube / Bilibili）与 X 账号接入属 Phase 3；当前框架的 `x_search` 需要第三方凭证。
- 订阅者共享同一访问密码；多用户/多租户与角色权限不在首期范围。
- 搜索引擎与公开 RSS/API 在私有模式下不可用，这是方案要求的行为；如需对外开放，应新增独立的公开视图与权限策略，而不是关闭门禁。
- 上游 TLS 代理用例在本机 Node 26 下失败，需在 Node 24 LTS 或 CI 环境复核。
