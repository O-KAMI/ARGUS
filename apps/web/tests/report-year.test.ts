// Cross-year ambiguity of the report pages' printed calendar days (features/report/format.ts).
// Failure cases, the same class as day-header-year.test.ts: on 2 January 2027 the phone switcher's
// chip for the 31 December issue reads "12月31日" and the "前一日" link on the 1 January issue reads
// "前一日 · 12月31日" — both read as 2027's. The follow-up badge in ReportPaper.tsx and the calendar
// grid's hover labels print the same bare 月日 and now go through the same year-carrying monthDay.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chipLabel, headline, neighbourLabel, windowLine } from "../app/features/report/format.ts";

const index = [
  { key: "2026-12-31", issueNumber: 400, title: "第400期" },
  { key: "2027-01-01", issueNumber: 401, title: "第401期" },
];

test("the phone chip names the year of another Beijing year", () => {
  assert.equal(chipLabel("daily", "2027-01-02", index, "2027-01-02"), "今天");
  assert.equal(chipLabel("daily", "2027-01-01", index, "2027-01-02"), "1月1日");
  assert.equal(chipLabel("daily", "2026-12-31", index, "2027-01-02"), "2026年12月31日");
});

test("the window line uses the issue's saved Beijing boundaries across a year", () => {
  assert.equal(windowLine("2026-12-30T16:00:00.000Z", "2026-12-31T16:00:00.000Z"),
    "收录北京时间 2026-12-31 00:00 — 2027-01-01 00:00（不含终点）");
  assert.equal(windowLine("2026-12-31T00:00:00.000Z", "2027-01-01T00:00:00.000Z"),
    "收录北京时间 2026-12-31 08:00 — 2027-01-01 08:00（不含终点）", "historical 08:00 windows are not relabelled");
});

test("a daily without a lead uses window-neutral wording", () => {
  assert.equal(headline("daily", "2027-01-01", 4), "本期的 4 件 AI 大事");
});

test("the prev/next-day links name the year across the year boundary", () => {
  // 31 December 2026, 23:30 Beijing time: the year has not turned for the clock.
  const endOfYear = Date.parse("2026-12-31T23:30:00+08:00");
  assert.equal(neighbourLabel("daily", "2026-12-30", "prev", endOfYear), "前一日 · 12月30日");
  assert.equal(neighbourLabel("daily", "2027-01-01", "prev", endOfYear), "前一日 · 2027年1月1日");
  // On 1 January 2027 the previous issue was another Beijing year's.
  const newYear = Date.parse("2027-01-01T08:00:00+08:00");
  assert.equal(neighbourLabel("daily", "2026-12-31", "prev", newYear), "前一日 · 2026年12月31日");
  assert.equal(neighbourLabel("daily", "2027-01-02", "next", newYear), "后一日 · 1月2日");
});
