// The hand-labelling worksheet: what the operator reads, what they fill, and how a filled sheet is read
// back. Pure on purpose — the sampling and the writing live in gold-worksheet.ts, so this can be tested
// without a database.
//
// Two rules shape the columns:
//
// 1. The sheet never shows what the model decided. No score, no level, no "currently selected": a human
//    who can see the machine's answer stops being an independent measurement, and the whole point of the
//    gold set is to tell the threshold whether it is wrong. The stratum a row was drawn from therefore
//    travels as an opaque code, and the legend stays in this file.
// 2. Nothing the operator reads is stored. `labelSelection` rebuilds the gold case from the article as
//    `loadAnalyzeInput` sees it, so the flattened, truncated text below is a reading aid only — a sheet
//    that shows less than the model saw cannot make the gold row worse.
import { z } from "zod";
import { sha256 } from "@aihot/backend/lib/ids";
// Type-only: labeling.ts accepts the label, so it owns the vocabulary, but importing it as a value would
// drag a database into this file's tests.
import type { GoldSplit } from "@aihot/backend/admin/labeling";

/**
 * The strata, keyed by the score pair already stored (rule A leaves `s2` null when the first level was
 * decisive). Names go into `samplingContext.samplingStratum`; codes go onto the sheet. The rare pairs are
 * the informative ones — a second call that vetoed, or a first call that would have — so the sampler takes
 * all of those and only samples the two large agreeing piles.
 *
 * `future`: whether rule A can still produce this pair. It asks a second time only when the first level is
 * `edge`, so a decisive first call now stores a single score (`s2` null) and the four pairs that pair a
 * decisive first level with a second opinion are legacy — they are what the stock was judged with before
 * the rule changed, and they stay in the design because the threshold they straddle is the one being
 * calibrated, but a sheet drawn from new material will fill only the five marked `future`.
 */
export const STRATA = [
  { code: "s1", name: "hit", s1: 90, s2: null, take: 8, future: true },
  { code: "s2", name: "hit-clear", s1: 90, s2: 90, take: 8, future: false },
  { code: "s3", name: "hit-edge", s1: 90, s2: 60, take: 99, future: false },
  { code: "s4", name: "hit-veto", s1: 90, s2: 20, take: 99, future: false },
  { code: "s5", name: "edge-raise", s1: 60, s2: 90, take: 99, future: true },
  { code: "s6", name: "edge-keep", s1: 60, s2: 60, take: 14, future: true },
  { code: "s7", name: "edge-veto", s1: 60, s2: 20, take: 99, future: true },
  { code: "s8", name: "miss-near", s1: 20, s2: 60, take: 99, future: false },
  { code: "s9", name: "miss-clear", s1: 20, s2: 20, take: 14, future: false },
  { code: "s10", name: "miss", s1: 20, s2: null, take: 8, future: true },
] as const;

/**
 * The sheet's row order: the strata dealt round-robin rather than one after another. A hand-filled sheet is
 * usually stopped halfway — the operator runs out of evening, not out of rows — and a stopped sheet should
 * still be a stratified sample. Read in order it is: the first row of every stratum, then the second of
 * every stratum that has one, so any prefix covers the whole score range.
 */
export function interleave<T>(groups: readonly (readonly T[])[]): T[] {
  const out: T[] = [];
  for (let round = 0; ; round++) {
    let took = 0;
    for (const group of groups) if (round < group.length) { out.push(group[round]!); took++; }
    if (!took) return out;
  }
}

export type StratumCode = (typeof STRATA)[number]["code"];

const byCode = new Map<string, (typeof STRATA)[number]>(STRATA.map((s) => [s.code, s]));
const byPair = new Map<string, (typeof STRATA)[number]>(STRATA.map((s) => [`${s.s1}|${s.s2}`, s]));

/** The stratum a stored score pair was drawn from, or null when the pair is not one of the three levels. */
export function stratumOf(s1: number, s2: number | null): (typeof STRATA)[number] | null {
  return byPair.get(`${s1}|${s2}`) ?? null;
}

/** The readable stratum name an opaque sheet code stands for; null for a code this file did not issue. */
export function stratumName(code: string): string | null {
  return byCode.get(code)?.name ?? null;
}

/** How many rows of each stratum to ask for. `99` means "all of them". */
export function stratumQuota(code: string): number {
  return byCode.get(code)?.take ?? 0;
}

/**
 * Which half of the calibration set a case belongs to. Hashed from the id, not drawn at random, so the
 * same article is in the same half on every sheet — a holdout that moves between runs is not a holdout.
 */
export function splitOf(articleId: string): GoldSplit {
  return Number.parseInt(sha256(`gold-split:${articleId}`).slice(0, 8), 16) % 4 === 0 ? "holdout" : "development";
}

/** The halves this file may write, tied to the vocabulary `labelSelection` accepts. */
const SPLIT_VALUES = ["development", "holdout"] as const satisfies readonly GoldSplit[];

/** The sheet's columns, in order. The last two are the operator's; everything before them is read-only. */
export const COLUMNS = ["序号", "代号", "集合", "id", "信源", "发布时间", "原文", "原文链接", "决定", "理由"] as const;

export interface WorksheetRow {
  index: number;
  code: StratumCode;
  split: GoldSplit;
  id: string;
  source: string;
  publishedAt: string;
  text: string;
  url: string;
}

/** How much of a post the sheet shows. The scorer sees all of it; a reader deciding 精选 does not need more. */
export const TEXT_LIMIT = 700;

/** One cell, RFC 4180: everything quoted, embedded quotes doubled, no bare newlines to confuse a reader. */
const cell = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`;

/** Flatten a post to one line: a cell that wraps makes a 128-row sheet unreadable in a spreadsheet. */
export const flatten = (text: string) => text.replace(/\s+/g, " ").trim();

export function toCsv(rows: WorksheetRow[]): string {
  const head = COLUMNS.map(cell).join(",");
  const body = rows.map((r) => [
    r.index, r.code, r.split, r.id, r.source, r.publishedAt,
    flatten(r.text).slice(0, TEXT_LIMIT), r.url, "", "",
  ].map(cell).join(","));
  // The BOM is what makes Excel read the file as UTF-8 instead of the platform's legacy encoding.
  return `\uFEFF${[head, ...body].join("\r\n")}\r\n`;
}

/** A spreadsheet's own parser, so a filled sheet can be read back: quoted fields, doubled quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const body = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (quoted) {
      if (c !== '"') { field += c; continue; }
      if (body[i + 1] === '"') { field += '"'; i++; continue; }
      quoted = false;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && body[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((v) => v !== "")) rows.push(row);
      row = [];
      continue;
    }
    field += c;
  }
  row.push(field);
  if (row.some((v) => v !== "")) rows.push(row);
  return rows;
}

/**
 * What the operator may write in 决定. Deliberately not the gold vocabulary's full `select|reject|either`:
 * one label does two things (`labelSelection` moves the public decision *and* stores the evidence), and
 * "either is acceptable" has no public decision to move. A row the operator cannot call is left blank and
 * reported as skipped; writing `either` needs the hand-written jsonl path in docs/selection.md instead.
 */
export const DECISIONS = ["select", "reject"] as const;

const FilledRow = z.object({
  index: z.coerce.number().int().positive(),
  code: z.string().trim(),
  split: z.enum(SPLIT_VALUES),
  id: z.string().trim().min(1),
  decision: z.string().trim().toLowerCase(),
  reason: z.string().trim(),
});

export interface FilledLabel {
  id: string;
  decision: "select" | "reject";
  reason: string;
  stratum: string;
  split: GoldSplit;
  index: number;
}

export interface FilledSheet {
  labels: FilledLabel[];
  /** Rows left blank on purpose: no decision yet, so nothing is written for them. */
  skipped: number;
  /** Rows that cannot be applied, each with why. A sheet with any of these is refused whole. */
  errors: string[];
}

/**
 * Read a filled sheet. Strict on purpose: a typo in 决定 silently becoming "reject" would poison the
 * calibration, so anything that is not a blank cell or one of the three words is an error, and so is a
 * label with no reason (the schema behind `labelSelection` requires one, and a bare 精选/不精选 with no
 * reason is not evidence anyone can audit later).
 */
export function readFilled(text: string): FilledSheet {
  const rows = parseCsv(text);
  const [head, ...body] = rows;
  const errors: string[] = [];
  if (!head) return { labels: [], skipped: 0, errors: ["the file is empty"] };
  const at = (name: string) => COLUMNS.indexOf(name as (typeof COLUMNS)[number]);
  const expected = COLUMNS.map(String);
  if (head.length < expected.length || expected.some((c, i) => head[i] !== c)) {
    return { labels: [], skipped: 0, errors: [`the header is not the sheet this script wrote: ${head.join(",")}`] };
  }
  const labels: FilledLabel[] = [];
  let skipped = 0;
  const seen = new Set<string>();
  body.forEach((raw, n) => {
    const line = n + 2;
    const parsed = FilledRow.safeParse({
      index: raw[at("序号")] ?? "", code: raw[at("代号")] ?? "", split: raw[at("集合")] ?? "",
      id: raw[at("id")] ?? "", decision: raw[at("决定")] ?? "", reason: raw[at("理由")] ?? "",
    });
    if (!parsed.success) { errors.push(`第 ${line} 行读不出来：${parsed.error.issues[0]?.message ?? "格式不对"}`); return; }
    if (seen.has(parsed.data.id)) { errors.push(`第 ${line} 行的 id ${parsed.data.id} 在表里出现过两次`); return; }
    seen.add(parsed.data.id);
    const stratum = stratumName(parsed.data.code);
    if (!stratum) { errors.push(`第 ${line} 行的代号 ${parsed.data.code} 不是本脚本发出的`); return; }
    if (parsed.data.decision === "") { skipped++; return; }
    if (!(DECISIONS as readonly string[]).includes(parsed.data.decision)) {
      errors.push(`第 ${line} 行的决定「${parsed.data.decision}」不是 select / reject，也不是空`);
      return;
    }
    if (parsed.data.reason === "") {
      errors.push(`第 ${line} 行没有填理由（一句话就够，日后校准要拿它当证据）`);
      return;
    }
    labels.push({
      id: parsed.data.id, decision: parsed.data.decision as FilledLabel["decision"],
      reason: parsed.data.reason, stratum, split: parsed.data.split, index: parsed.data.index,
    });
  });
  return { labels, skipped, errors };
}
