// The boundary-case worksheet: the learning track holds its `edge` level for a human (analyses.output
// .review='true'). Confirming all of them one by one is too many, so this draws a few per content kind,
// writes a sheet the operator fills in a spreadsheet, and reads the filled sheet back through the same
// `labelSelection` the admin page calls — one label resolves the hold (the editorial override) AND stores
// the gold row, with the kind carried as the sampling stratum so the calibration can read it per kind.
//
// The sheet is not blind: it names the kind and shows the model's reason, because the operator is
// confirming boundary cases, not measuring the threshold independently (that is gold-worksheet.ts).
//
// Nothing here calls a model. Generating reads the database; importing writes through the backend.
//
// Usage:
//   node --env-file=.env scripts/edge-worksheet.ts --out .data/edge-worksheet.csv
//   node --env-file=.env scripts/edge-worksheet.ts --import .data/edge-worksheet.csv           # dry run
//   node --env-file=.env scripts/edge-worksheet.ts --import .data/edge-worksheet.csv --live    # applies
import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { closeDb, sql } from "@aihot/backend/db";
import { labelSelection } from "@aihot/backend/admin/labeling";
import { PROMPT_VERSIONS } from "@aihot/backend/editorial/analyze";
import { TRACKS } from "@aihot/industry/selection";
import {
  dealByKind, EDGE_COLUMNS, edgeStratum, KIND_QUOTA, readEdgeFilled, toEdgeCsv, type EdgeRow,
} from "./edge-worksheet-core.ts";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    import: { type: "string" },
    live: { type: "boolean", default: false },
    actor: { type: "string", default: "edge-worksheet" },
    "per-kind": { type: "string" },
  },
});

if ((values.out === undefined) === (values.import === undefined)) {
  throw new Error("give exactly one of --out <file> (write a blank sheet) or --import <file> (apply a filled one)");
}
const perKind = Math.max(1, values["per-kind"] ? Number.parseInt(values["per-kind"], 10) : KIND_QUOTA);

interface Candidate {
  id: string;
  source_name: string;
  published_at: Date | null;
  url: string;
  title_zh: string | null;
  summary_zh: string | null;
  reason_zh: string | null;
  kind: string;
}

/** The held boundary pool: latest judgement is `edge` on the current rubric, no human decision yet. */
async function pool(): Promise<Candidate[]> {
  return sql<Candidate[]>`
    WITH latest AS (
      SELECT DISTINCT ON (a.id) a.id, a.url, a.published_at, s.name AS source_name,
             an.title_zh, an.summary_zh, an.reason_zh,
             an.output->'learningKinds'->>0 AS kind, an.output->>'review' AS review, an.prompt_version
      FROM articles a
      JOIN sources s ON s.id = a.source_id
      JOIN analyses an ON an.article_id = a.id
      WHERE s.participation_mode = 'editorial' AND ${TRACKS.learning} = ANY(s.tags)
      ORDER BY a.id, an.id DESC
    )
    SELECT l.id, l.url, l.published_at, l.source_name, l.title_zh, l.summary_zh, l.reason_zh, l.kind
    FROM latest l
    WHERE l.review = 'true'
      AND l.prompt_version LIKE '%' || ${PROMPT_VERSIONS.scoreLearning} || '%'
      AND l.kind IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM editorial_overrides o WHERE o.article_id = l.id)
      AND NOT EXISTS (SELECT 1 FROM selection_gold g WHERE g.article_id = l.id)`;
}

async function sample(): Promise<{ sheet: EdgeRow[]; byKind: Map<string, number>; poolSize: number }> {
  const rows = await pool();
  const groups = new Map<string, Candidate[]>();
  for (const r of rows) {
    const list = groups.get(r.kind) ?? [];
    list.push(r);
    groups.set(r.kind, list);
  }
  // Id order, not random(): the same database draws the same sheet, so re-running after an interrupted
  // session does not silently hand over a different set. Ids are random-looking, so this is not chronological.
  const keyed = (list: Candidate[]) => [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const kinds = [...groups.keys()].sort();
  const byKind = new Map<string, number>();
  const drawn = dealByKind(kinds.map((k) => {
    const list = keyed(groups.get(k)!);
    const take = list.slice(0, Math.min(perKind, list.length));
    byKind.set(k, take.length);
    return take;
  }));

  const sheet: EdgeRow[] = drawn.map((c, i) => ({
    index: i + 1,
    kind: c.kind,
    id: c.id,
    source: c.source_name,
    publishedAt: c.published_at ? c.published_at.toISOString().slice(0, 16).replace("T", " ") : "",
    title: c.title_zh ?? "",
    summary: c.summary_zh ?? "",
    reason: c.reason_zh ?? "",
    url: c.url,
  }));
  return { sheet, byKind, poolSize: rows.length };
}

async function generate(path: string) {
  const { sheet, byKind, poolSize } = await sample();
  await writeFile(path, toEdgeCsv(sheet), "utf8");
  console.log(`wrote ${sheet.length} rows to ${path}`);
  console.log(`columns: ${EDGE_COLUMNS.join(" | ")}   ← 填「决定」(select/reject，拿不准就留空) 与「理由」(一句话)`);
  console.log(`held boundary pool: ${poolSize}; drew ${sheet.length} (per-kind cap ${perKind})`);
  console.log("per kind:");
  for (const [k, n] of [...byKind].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`);
  console.log("rows are dealt round-robin across kinds, so labelling only the first N still covers every kind;");
  console.log("a row left blank is skipped, not guessed. The kind travels as the gold stratum (edge:<kind>).");
}

async function apply(path: string, live: boolean, actor: string) {
  const sheet = readEdgeFilled(await readFile(path, "utf8"));
  for (const e of sheet.errors) console.log(`✗ ${e}`);
  if (sheet.errors.length) {
    console.log(`\nrefused: ${sheet.errors.length} row(s) cannot be applied. Fix them and run again — nothing was written.`);
    process.exit(1);
  }
  console.log(`${sheet.labels.length} label(s) to apply, ${sheet.skipped} row(s) left blank, 0 errors.`);
  const tally = { applied: 0, failed: 0, select: 0, reject: 0 };
  for (const label of sheet.labels) {
    const [exists] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM articles WHERE id = ${label.id}`;
    if (!exists?.n) { console.log(`✗ #${label.index} ${label.id}: no such article`); tally.failed++; continue; }
    // The version is read fresh, not taken from the sheet: an override made in the admin page since the
    // sheet was written must win the conflict rather than be overwritten by a stale row.
    const version = await overrideVersion(label.id);
    if (!live) {
      console.log(`· #${label.index} ${label.id} → ${label.decision} (${label.stratum}/${label.split}, version ${version}) ${label.reason}`);
      tally.applied++;
      tally[label.decision]++;
      continue;
    }
    try {
      const result = await labelSelection(label.id, { decision: label.decision, reason: label.reason, version, stratum: label.stratum, split: label.split }, actor);
      console.log(`✓ #${label.index} ${label.id} → ${result.decision}, published selected=${result.selected}`);
      tally.applied++;
      tally[label.decision]++;
    } catch (error) {
      console.log(`✗ #${label.index} ${label.id}: ${error instanceof Error ? error.message : String(error)}`);
      tally.failed++;
    }
  }
  console.log(`\ntally: ${JSON.stringify(tally)}${live ? "" : "  (dry run — add --live to write)"}`);
  if (live && tally.applied > 0) {
    console.log("next: node --env-file=.env scripts/eval-selection.ts --track learning --split development");
    console.log("then: node --env-file=.env scripts/propose-rubric.ts --propose   (per-kind brief, owner approves --apply)");
  }
  process.exit(tally.failed > 0 ? 1 : 0);
}

/** What `listLabeling` shows the page as `override_version`: the count the optimistic lock compares against. */
async function overrideVersion(id: string): Promise<number> {
  const [row] = await sql<{ version: number }[]>`SELECT coalesce(o.version, 0)::int AS version FROM editorial_overrides o WHERE o.article_id = ${id}`;
  return row?.version ?? 0;
}

if (values.out) await generate(values.out);
else await apply(values.import!, values.live, values.actor);
await closeDb();
process.exit(0);