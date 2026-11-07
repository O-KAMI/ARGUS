// The publication ledger the runs page shows (audit 2026-11-04 四.9): the backfill loop starts at the
// earliest issue it can see, so a gap before the first one was never explained. Here every day from the
// stated start date carries a status — published, quiet, upstream not ready, or missing with its reason
// and window — and the weeklies and monthlies name the periods they cover and the ones they lack.
import { addDays, beijingAt, isoWeekLabel, isoWeekRange, monthRange } from "@aihot/contracts/time";
import { sql } from "../db.ts";
import { backupConfigured } from "../operations/backup.ts";
import { dueDaily, dueMonthly, dueWeekly } from "./compose.ts";

export interface ReportDayStatus {
  key: string;
  status: "published" | "quiet" | "upstream" | "missing";
  entries: number | null;
  reason: string | null;
  window: { start: string; end: string } | null;
}

export interface ReportsStatus {
  /** The first day the site means to publish; days before it are not gaps. */
  startDaily: string | null;
  startSource: "setting" | "first-issue" | "none";
  days: ReportDayStatus[];
  weekly: { covered: string[]; missing: string[] };
  monthly: { covered: string[]; missing: string[] };
}

const isValidDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);
const nextWeek = (label: string) => isoWeekLabel(addDays(isoWeekRange(label)!.start, 7));
const nextMonth = (label: string) => addDays(monthRange(label)!.end, 1).slice(0, 7);
const windowOf = (key: string) => {
  const end = beijingAt(key, "00:00");
  return { start: new Date(end.getTime() - 86400000).toISOString(), end: end.toISOString() };
};

export async function reportsStatus(now = new Date()): Promise<ReportsStatus> {
  const [startRow] = await sql<{ value: unknown }[]>`SELECT value FROM settings WHERE key = 'reports.start_daily'`;
  const stored = typeof startRow?.value === "string" && isValidDay(startRow.value) ? startRow.value : null;
  const [firstRow] = await sql<{ first: string | null }[]>`SELECT min(key) AS first FROM reports WHERE kind = 'daily'`;
  const startDaily = stored ?? firstRow?.first ?? null;
  const have = new Map((await sql<{ key: string; entries: number }[]>`
    SELECT key, coalesce((content->'metrics'->>'totalEvents')::int, 0) AS entries FROM reports WHERE kind = 'daily'`)
    .map((row) => [row.key, row.entries]));

  const days: ReportDayStatus[] = [];
  const due = dueDaily(now);
  if (startDaily) for (let key = startDaily; key <= due; key = addDays(key, 1)) {
    const entries = have.get(key);
    const window = windowOf(key);
    if (entries !== undefined) {
      days.push({ key, status: entries > 0 ? "published" : "quiet", entries, reason: entries > 0 ? null : "窗口内没有新入选，仍出一期空刊", window });
      continue;
    }
    // A missing day is the exception, so its two questions are asked one day at a time: was anything
    // judged in its window, and did an attempt fail with a reason?
    const [{ judged }] = await sql<{ judged: number }[]>`
      SELECT count(*)::int AS judged FROM publications
      WHERE selected AND timeline_at >= ${window.start} AND timeline_at < ${window.end}`;
    if (judged === 0) {
      days.push({ key, status: "upstream", entries: null, reason: "窗口内没有任何已判定报道：上游未就绪，或分析没有跑", window });
      continue;
    }
    const [attempt] = await sql<{ error: string | null }[]>`
      SELECT left(error, 300) AS error FROM job_runs
      WHERE job = 'reports.compose' AND status = 'failed' AND error LIKE ${`%${key}%`}
      ORDER BY started_at DESC LIMIT 1`;
    days.push({
      key, status: "missing", entries: null,
      reason: attempt?.error ? `最近一次补刊失败：${attempt.error}` : "没有尝试记录：该期到期时 worker 可能停着，下次运行会补",
      window,
    });
  }

  const [firstDaily] = await sql<{ first: string | null }[]>`SELECT min(key) AS first FROM reports WHERE kind = 'daily'`;
  const periods = async (kind: "weekly" | "monthly") => {
    const covered = (await sql<{ key: string }[]>`SELECT key FROM reports WHERE kind = ${kind} ORDER BY key`).map((row) => row.key);
    const missing: string[] = [];
    if (firstDaily?.first) {
      const dueLabel = kind === "weekly" ? dueWeekly(now) : dueMonthly(now);
      const firstLabel = kind === "weekly" ? isoWeekLabel(firstDaily.first) : firstDaily.first.slice(0, 7);
      const endsBefore = (label: string) => (kind === "weekly" ? isoWeekRange(label)!.end : monthRange(label)!.end) < firstDaily.first!;
      for (let label = firstLabel; label <= dueLabel; label = kind === "weekly" ? nextWeek(label) : nextMonth(label)) {
        if (!endsBefore(label) && !covered.includes(label)) missing.push(label);
      }
    }
    return { covered, missing };
  };
  return {
    startDaily,
    startSource: stored ? "setting" : firstRow?.first ? "first-issue" : "none",
    days,
    weekly: await periods("weekly"),
    monthly: await periods("monthly"),
  };
}

/** The owner's monthly isolated restore, recorded by hand: the third of the backup's three facts. */
export async function recordRestoreVerified(note: string, actor: string): Promise<{ at: string; note: string | null }> {
  const value = { at: new Date().toISOString(), note: note.trim() ? note.trim().slice(0, 200) : null };
  await sql`INSERT INTO settings (key, value, updated_by) VALUES ('backup.restore_verified', ${sql.json(value as never)}, ${actor})
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
  return value;
}

/** The three facts a personal site's backup story needs: configured, last success, restore verified. */
export async function backupFacts(): Promise<{ configured: boolean; last: { at: string; uploaded: boolean; filesError?: string } | null; restoreVerified: { at: string; note: string | null } | null }> {
  const [last] = await sql<{ value: { at: string; uploaded: boolean; filesError?: string } | null }[]>`SELECT value FROM settings WHERE key = 'backup.last'`;
  const [verified] = await sql<{ value: { at: string; note: string | null } | null }[]>`SELECT value FROM settings WHERE key = 'backup.restore_verified'`;
  return { configured: backupConfigured(), last: last?.value ?? null, restoreVerified: verified?.value ?? null };
}
