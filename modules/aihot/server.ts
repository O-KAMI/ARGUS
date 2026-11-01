// The industry-mirror module's backend sockets (packages/backend/src/modules.ts): the ranking it publishes
// in place of the engine's own, the pass that keeps it, the platform its reports came from, and its share
// of the retention run.
//
// The module reads one public catalogue and republishes what it read. It calls no model and spends no
// budget, so it declares no `models` step and its articles are settled at ingest (backend/mirror.ts). Its
// schedule follows its own valve rather than the engine's COLLECT_ENABLED, so a worker can mirror a public
// catalogue while collection of this site's own sources stays off (backend/config.ts).
import type { Finding } from "@aihot/backend/notify/feishu";
import { defineServerModule } from "@aihot/backend/modules";
import { aihotConfig, MIRROR_SOURCE_ID, mirrorEnabled } from "./backend/config.ts";
import { mirroredHot, paceOf } from "./backend/hot.ts";
import { ensureMirrorSource, retireMirrored } from "./backend/mirror.ts";
import { mirrorOnce } from "./backend/pass.ts";
import { endpointStates } from "./backend/state.ts";

/** A ranking this site has not read for this long is stale enough to tell the owner about. */
const STALE_AFTER_MS = 2 * 3600_000;

async function mirrorAlerts(now: number): Promise<Finding[]> {
  if (!mirrorEnabled()) return [];
  const rows = await endpointStates();
  if (!rows.length) {
    return [{
      key: "aihot.mirror.never-read", level: "today", title: "行业镜像还没有读到过任何内容",
      impact: "热点榜显示的是本站自己的口径，而不是镜像的榜单。",
      action: "看一次 aihot.mirror 任务的运行记录，确认上游地址可达。",
    }];
  }
  const stale = rows.filter((row) => !row.lastOkAt || now - row.lastOkAt.getTime() > STALE_AFTER_MS);
  if (!stale.length) return [];
  return [{
    key: "aihot.mirror.stale", level: "today",
    title: `行业镜像有 ${stale.length} 个地址超过两小时没有读到`,
    impact: "榜单和镜像的资讯会停在上一次读到的内容，页面上仍会显示读取时间。",
    heals: "上游恢复后下一次定时读取会自己接上。",
    action: "看 aihot.mirror 的运行记录里的 last_error；若是限速，等它自己放开。",
    detail: stale.map((row) => `${row.endpoint}: ${row.lastError ?? "未读到"}（上次成功 ${row.lastOkAt?.toISOString() ?? "无"}）`).join("；"),
    since: stale.flatMap((row) => (row.lastOkAt ? [row.lastOkAt] : []))[0] ?? new Date(now),
  }];
}

export default defineServerModule({
  name: "aihot",
  // A mirrored report is its own card: it never shares a fact's display seat with a report of this site's
  // own sources, and its selection stays upstream's own decision.
  independentSelectedSources: [MIRROR_SOURCE_ID],
  // Its reports carry the publisher's addresses, so no host rule and no account kind can name the platform.
  platforms: { aihot: [MIRROR_SOURCE_ID] },
  hot: mirroredHot,
  schedules: [
    {
      name: "aihot.mirror",
      cron: aihotConfig.refreshCron,
      missed: "once",
      when: mirrorEnabled,
      run: () => mirrorOnce("schedule"),
    },
  ],
  sourceKinds: {
    external: {
      // The admin's manual fetch on the mirror's source runs a pass at once. Any other external source only
      // receives reports (sources/collect.ts), so there is nothing for this hook to do for it either.
      fetchNow: async (source) =>
        source.id === MIRROR_SOURCE_ID ? await mirrorOnce("admin") : { skipped: "external sources only receive reports" },
      // Resuming the mirror's source must not lose the row's own shape, which only this module writes.
      resumed: async (sourceId) => {
        if (sourceId === MIRROR_SOURCE_ID) await ensureMirrorSource();
      },
    },
  },
  alerts: mirrorAlerts,
  retention: async (now) => ({ aihot_mirror_retired: await retireMirrored(now) }),
  llms: () => ({ pace: [`行业镜像${paceOf(aihotConfig.refreshCron)}上游的公开榜单与精选`] }),
});
