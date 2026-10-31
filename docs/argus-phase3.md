# ARGUS 第三阶段交接：重要公告、日报自然日、信源复现与 FxTwitter backlog

本阶段只做正确性与完整性修复，不改架构：公开读取层、回执预算、事件归组和发布主链保持原样。

## 1. 重要公告（与热榜分离）

- `packages/backend/src/publication/hot.ts` 新增 `loadImportantAnnouncements`：只读已公开、已精选、已发布且 `first_party` 的内容，按发布时间倒序，最多 6 条。
- `HotResponse.announcements` 为新契约字段；`loadHot` 并行读取排名与公告，无排名时仍返回公告。
- `apps/web/app/routes/hot.tsx` 单独成区展示，文案写明“已精选的一手官方发布，按发布时间排列，不参与跨源讨论热度排名”，公告没有 heat/rank；桌面标题的持续 ping 已移除。
- 验证：`tests/publication.test.ts` 24/24；`apps/web/tests/cache.test.ts` 公告 SSR 专项；`page-width.test.ts` 布局断言；系统 Chrome 桌面/手机截图 `light-*-hot-announcements-7.png`。

## 2. 日报迁移到上海自然日

- 窗口改为 `[D-1 00:00, D 00:00)`，刊期与 08:00 出刊不变；`REPORT_VERSION` 追加 `+daily-beijing-natural-day-v1`。
- 周报/月报汇总窗口同步为自然日边界；空刊、补刊、告警（出刊后两小时）口径同步。
- `ReportDetail.windowStart/windowEnd` 暴露每期实际保存的窗口；历史刊仍显示原窗口，URL 不变；日报文案改“本期”。
- 切换刊与前一旧刊重叠的 00:00–08:00 依靠事件归组与近 7 期记忆抑制，测试覆盖不重复头版、无窗口缺口。
- 验证：报告数据库测试、Web 报告测试与 standalone 全绿（见下）。

## 3. 信源复现

- `industry/sources.json` 由当前运行库只读导出：44 个 X（全部启用）+ 35 个 RSS（19 启用、16 暂停作第二层），共 79 条；无重复 ID/feed/query，无密钥、游标或健康状态。
- 空 `argus_test` seed 后逐字段核对 0 缺失、0 额外、0 不匹配；运行库未做写入。
- 关于页的 X44/RSS19 是启用口径，交付记录的 RSS35 是总数口径，二者不冲突。

## 4. FxTwitter 有界 backlog

- 读取顺序 FxTwitter → 账号 RSS → SocialData；免费路径无回执。
- 边界：每源每轮最多 3 页、回溯最多 7 天、含重试最多 12 次原始请求、最多保存 3 个 continuation（超限计入 dropped）。
- 有 backlog 时仍先读最新一页；continuation 保留原始 watermark 与时间_floor_，跨轮续传不从头回溯。
- FxTwitter continuation 与 SocialData 付费游标分开保存；分片采集只收 SocialData 源。
- 验证：`tests/fxtwitter.standalone.test.ts` 7/7；X/采集数据库回归全绿。

## 5. 验证汇总（本阶段结束时）

- `npm run typecheck` 通过。
- 数据库全量 `npm test`：977 项，976 通过；唯一失败为 `outbound secure-proxy` 用例，属本机代理基线问题（见 runbook 记忆），非产品回归。
- `npm run test:standalone`：250 项，249 通过；同一代理基线用例失败。
- `npm run build -w @aihot/web` 后 `node --test apps/web/tests/*.test.ts`：68/68（含 Chromium/WebKit 引擎用例；引擎包经 npmmirror 手动放置到 `~/Library/Caches/ms-playwright/{chromium-1228,webkit-2311}`）。
- 带读者会话的 `scripts/smoke.ts` 对验收站全部通过。

## 6. 未决事项

1. 人工精选金标（100–200 条 `.data/gold.jsonl`）未建立：提示词五轴分项、60/65/76 门槛与跨供应商 fallback 一律未动，等人工标注后再校准（第四阶段前置）。
2. 评分/归组排队时延、Embedding 用量与真实 token/金额成本未测量；无数据前不改并发。
3. Phase 4 专用 YouTube/Bilibili Adapter、字幕、章节、时间戳未开始。
4. 验收库尚无已发布日报，`windowLine` 的真实数据展示只能由 fixture 与报告测试覆盖；首次真实出刊后需肉眼复核报头窗口文案。
5. 品牌字标仍用 Georgia/Times 字体栈，本地授权 WOFF2 子集未接入（第一阶段遗留）。
