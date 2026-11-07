// The ranking's effective snapshot: home and the hot page read the same moment and say the same thing
// about it, so a stale reading is never drawn as today's. A mirrored ranking takes the oldest reading
// it is made of; this site's own takes its computation time.
import type { HotResponse } from "@aihot/contracts/site";
import { beijingDate, monthDay } from "@aihot/contracts/time";
import { monthDayTime } from "../../lib/format";

export interface HotSnapshot {
  /** The moment the ranking actually read, as ISO; null when the api named none. */
  asOf: string | null;
  /** Its Beijing calendar day, and today's: a heading may only say 今日 when they agree. */
  day: string | null;
  today: string;
  /** Behind the upstream's pace, or a reading from before today: the page owes the reader a hint. */
  stale: boolean;
  /** The two halves of a mirrored ranking came from different passes. */
  mixed: boolean;
}

export function hotSnapshot(hot: HotResponse, now = Date.now()): HotSnapshot {
  const asOf = hot.mirror?.asOf ?? hot.computedAt ?? null;
  const parsed = asOf === null ? NaN : Date.parse(asOf);
  const day = Number.isNaN(parsed) ? null : beijingDate(parsed);
  const today = beijingDate(now);
  return {
    asOf,
    day,
    today,
    stale: hot.mirror?.stale === true || (day !== null && day < today),
    mixed: hot.mirror?.mixed === true,
  };
}

/** The home board's heading: 今日热点 only for today's reading, otherwise the snapshot's own date. */
export function hotHeading(snap: HotSnapshot): string {
  return snap.day === null || snap.day === snap.today ? "今日热点" : `${monthDay(snap.day, snap.today)}热点快照`;
}

/** The shared staleness hint, in the words both pages use; null when the reading needs no hint. */
export function hotReadingNote(snap: HotSnapshot): string | null {
  if (snap.asOf === null) return null;
  if (snap.mixed) return `两份读数分属不同时刻（${monthDayTime(snap.asOf)} 起），顺序是混合快照`;
  if (snap.stale) return `读数截至 ${monthDayTime(snap.asOf)}${snap.day !== null && snap.day < snap.today ? "，不是今天的数据" : ""}`;
  return null;
}