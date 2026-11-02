// The module's own configuration: the valve that lets it talk to the catalogue it mirrors, the rhythm it
// asks at, and the names this site gives the material it brings in. The valve is the module's own rather
// than the engine's COLLECT_ENABLED, so a worker can mirror a public catalogue while collection of the
// site's own sources and every model call stay off (AGENTS.md: the owner opens those, not a schedule).
const env = process.env;

function str(name: string, fallback: string): string {
  const value = env[name];
  return value !== undefined && value !== "" ? value : fallback;
}

/** Whether the mirror may read upstream at all. Only the literal `true` opens it, like every other valve here. */
export const mirrorEnabled = () => env.AIHOT_MIRROR_ENABLED === "true";

/** The source every mirrored report belongs to; its id is what the module's sockets and queries name. */
export const MIRROR_SOURCE_ID = "aihot-mirror";

/**
 * What readers see as the material's source and as the ranking's origin. Deliberately not the upstream's
 * own name or mark: the site publishes a neutral label of its own and links the original instead.
 */
export const MIRROR_LABEL = "行业镜像";

/** How long mirrored material is kept. Upstream's own window is the same length, so nothing is archived. */
export const MIRROR_WINDOW_DAYS = 7;

/**
 * How far apart the three addresses' readings may be before the ranking this site publishes is a mixed
 * snapshot instead of one moment. Each address is allowed to fail on its own and keep its last reading, so
 * a hot list from one pass can be joined to a topic list from an earlier one. The schedule asks every 15
 * minutes, so a reading older than one interval came from an earlier pass: the pass reports the spread and
 * the page shows it, rather than drawing the two as one instant. `AIHOT_MIRROR_MAX_SKEW_MIN` overrides it.
 */
export const mirrorMaxSkewMinutes = (): number => {
  const value = Number(env.AIHOT_MIRROR_MAX_SKEW_MIN ?? "");
  return Number.isFinite(value) && value > 0 ? value : 15;
};

export const aihotConfig = {
  /** Upstream's terms ask a polling reader to ask no faster than once a minute; this asks four times an hour. */
  refreshCron: str("AIHOT_MIRROR_CRON", "*/15 * * * *"),
  mirrorWindowDays: MIRROR_WINDOW_DAYS,
  mirrorMaxSkewMinutes,
};

/** The reading interval the cron above asks for, in minutes; 15 when the schedule is not a simple every-N. */
export const mirrorIntervalMinutes = (): number => {
  const every = /^\*\/(\d+) \* \* \* \*$/.exec(aihotConfig.refreshCron);
  return every ? Math.max(1, Number(every[1])) : 15;
};

export type AihotConfig = typeof aihotConfig;
