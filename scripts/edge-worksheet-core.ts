// The boundary-case worksheet: what the operator reads, what they fill, and how a filled sheet is read
// back. Pure on purpose — the sampling and the writing live in edge-worksheet.ts, so this can be tested
// without a database.
//
// Unlike the blind gold worksheet (gold-worksheet-core.ts), this sheet is NOT blind: it names the content
// kind and shows the model's reason, because the operator is confirming the boundary cases the learning
// track held (level `edge`), not measuring the threshold independently. The kinds are the rubric's own
// content types, so a label per kind becomes a per-kind rule the rubric can carry.
//
// Nothing the operator reads is stored: `labelSelection` rebuilds the gold case from the article as
// `loadAnalyzeInput` sees it, so the flattened, truncated text below is a reading aid only.
import { z } from "zod";
import { LEARNING_KINDS } from "@aihot/industry/selection";
// Type-only: labeling.ts accepts the label, so it owns the vocabulary, but importing it as a value would
// drag a database into this file's tests.
import type { GoldSplit } from "@aihot/backend/admin/labeling";
import { cell, flatten, interleave, parseCsv, splitOf } from "./gold-worksheet-core.ts";

/** How many boundary cases to draw per content kind. A kind with fewer takes all of them. */
export const KIND_QUOTA = 6;

/** The sampling stratum a kind's boundary cases travel as, stored in selection_gold.sampling_context. */
export function edgeStratum(kind: string): string {
  return `edge:${kind}`;
}

/** The sheet's columns, in order. The last two are the operator's; everything before them is read-only. */
export const EDGE_COLUMNS = ["序号", "类别", "id", "信源", "发布时间", "标题", "摘要", "推荐理由", "原文链接", "决定", "理由"] as const;

export interface EdgeRow {
  index: number;
  kind: string;
  id: string;
  source: string;
  publishedAt: string;
  title: string;
  summary: string;
  reason: string;
  url: string;
}

/** How much of each text field the sheet shows: enough to judge, one line so the sheet stays readable. */
const LIMITS = { title: 120, summary: 400, reason: 400 } as const;

export function toEdgeCsv(rows: EdgeRow[]): string {
  const head = EDGE_COLUMNS.map(cell).join(",");
  const body = rows.map((r) => [
    r.index, r.kind, r.id, r.source, r.publishedAt,
    flatten(r.title).slice(0, LIMITS.title), flatten(r.summary).slice(0, LIMITS.summary),
    flatten(r.reason).slice(0, LIMITS.reason), r.url, "", "",
  ].map(cell).join(","));
  // The BOM is what makes Excel read the file as UTF-8 instead of the platform's legacy encoding.
  return `\uFEFF${[head, ...body].join("\r\n")}\r\n`;
}

/**
 * The sheet's row order: the kinds dealt round-robin rather than one after another, so a sheet stopped
 * halfway still covers every kind. Reuses the blind worksheet's interleave for the same reason.
 */
export function dealByKind<T>(groups: readonly (readonly T[])[]): T[] {
  return interleave(groups);
}

/** What the operator may write in 决定: a public decision to move, so not the gold vocabulary's `either`. */
export const EDGE_DECISIONS = ["select", "reject"] as const;

const FilledRow = z.object({
  index: z.coerce.number().int().positive(),
  kind: z.string().trim(),
  id: z.string().trim().min(1),
  decision: z.string().trim().toLowerCase(),
  reason: z.string().trim(),
});

export interface EdgeLabel {
  id: string;
  decision: "select" | "reject";
  reason: string;
  kind: string;
  stratum: string;
  split: GoldSplit;
  index: number;
}

export interface EdgeFilledSheet {
  labels: EdgeLabel[];
  /** Rows left blank on purpose: no decision yet, so nothing is written for them. */
  skipped: number;
  /** Rows that cannot be applied, each with why. A sheet with any of these is refused whole. */
  errors: string[];
}

/**
 * Read a filled sheet. Strict on purpose: a typo in 决定 silently becoming "reject" would poison the
 * calibration, so anything that is not a blank cell or one of the two words is an error, and so is a
 * label with no reason (the schema behind `labelSelection` requires one).
 */
export function readEdgeFilled(text: string): EdgeFilledSheet {
  const rows = parseCsv(text);
  const [head, ...body] = rows;
  const errors: string[] = [];
  if (!head) return { labels: [], skipped: 0, errors: ["the file is empty"] };
  const at = (name: string) => EDGE_COLUMNS.indexOf(name as (typeof EDGE_COLUMNS)[number]);
  const expected = EDGE_COLUMNS.map(String);
  if (head.length < expected.length || expected.some((c, i) => head[i] !== c)) {
    return { labels: [], skipped: 0, errors: [`the header is not the sheet this script wrote: ${head.join(",")}`] };
  }
  const labels: EdgeLabel[] = [];
  let skipped = 0;
  const seen = new Set<string>();
  body.forEach((raw, n) => {
    const line = n + 2;
    const parsed = FilledRow.safeParse({
      index: raw[at("序号")] ?? "", kind: raw[at("类别")] ?? "", id: raw[at("id")] ?? "",
      decision: raw[at("决定")] ?? "", reason: raw[at("理由")] ?? "",
    });
    if (!parsed.success) { errors.push(`第 ${line} 行读不出来：${parsed.error.issues[0]?.message ?? "格式不对"}`); return; }
    if (seen.has(parsed.data.id)) { errors.push(`第 ${line} 行的 id ${parsed.data.id} 在表里出现过两次`); return; }
    seen.add(parsed.data.id);
    if (!(LEARNING_KINDS as readonly string[]).includes(parsed.data.kind)) {
      errors.push(`第 ${line} 行的类别 ${parsed.data.kind} 不是学习轨的内容类型`); return;
    }
    if (parsed.data.decision === "") { skipped++; return; }
    if (!(EDGE_DECISIONS as readonly string[]).includes(parsed.data.decision)) {
      errors.push(`第 ${line} 行的决定「${parsed.data.decision}」不是 select / reject，也不是空`);
      return;
    }
    if (parsed.data.reason === "") {
      errors.push(`第 ${line} 行没有填理由（一句话就够，日后校准要拿它当证据）`);
      return;
    }
    labels.push({
      id: parsed.data.id, decision: parsed.data.decision as EdgeLabel["decision"], reason: parsed.data.reason,
      kind: parsed.data.kind, stratum: edgeStratum(parsed.data.kind), split: splitOf(parsed.data.id), index: parsed.data.index,
    });
  });
  return { labels, skipped, errors };
}