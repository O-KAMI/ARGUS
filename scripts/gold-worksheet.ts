// The hand-labelling worksheet: draws a stratified sample of learning-track items, writes a sheet the
// operator fills in a spreadsheet, and reads the filled sheet back through the same `labelSelection` the
// admin page calls — so one label still does both things (the public decision now, the gold row for
// scripts/eval-selection.ts) with the override's version check, audit trail and selected_ledger intact.
//
// The admin page already labels one item at a time. This exists because calibrating a threshold needs a
// hundred-odd decisions read as a set, and because the sheet can hide what the model decided (the page
// shows it, and a human who can see the machine's answer stops being an independent measurement).
//
// Nothing here calls a model. Generating reads the database; importing writes through the backend.
//
// Usage:
//   node --env-file=.env scripts/gold-worksheet.ts --out .data/gold-worksheet.csv
//   node --env-file=.env scripts/gold-worksheet.ts --import .data/gold-worksheet.csv           # dry run
//   node --env-file=.env scripts/gold-worksheet.ts --import .data/gold-worksheet.csv --live    # applies
import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { closeDb, sql } from "@aihot/backend/db";
import { labelSelection } from "@aihot/backend/admin/labeling";
import { loadAnalyzeInput } from "@aihot/backend/editorial/analyze";
import { translateInputOf } from "@aihot/backend/editorial/writing";
import { TRACKS } from "@aihot/industry/selection";
import { COLUMNS, interleave, splitOf, stratumOf, stratumQuota, toCsv, readFilled, STRATA, type WorksheetRow } from "./gold-worksheet-core.ts";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    import: { type: "string" },
    live: { type: "boolean", default: false },
    actor: { type: "string", default: "worksheet" },
  },
});

if ((values.out === undefined) === (values.import === undefined)) {
  throw new Error("give exactly one of --out <file> (write a blank sheet) or --import <file> (apply a filled one)");
}

interface Candidate {
  id: string;
  source_name: string;
  published_at: Date | null;
  url: string;
  s1: number;
  s2: number | null;
}

async function sample(): Promise<{ sheet: WorksheetRow[]; pool: number; offGrid: number }> {
  // Only items with a stored score the prefilter passed: a blocked item never reaches the public feeds, so
  // a human decision on it could not take effect, and an `unknown` prefilter withholds selection whatever
  // the score says (editorial/analyze.ts: `relevance === "pass" && scoresSelect(...)`).
  const rows = await sql<Candidate[]>`
    WITH latest AS (
      SELECT DISTINCT ON (a.id) a.id, a.url, a.published_at, s.name AS source_name,
             an.relevance, an.output->'scores' AS scores
      FROM articles a
      JOIN sources s ON s.id = a.source_id
      JOIN LATERAL (SELECT relevance, score, output FROM analyses x WHERE x.article_id = a.id ORDER BY x.id DESC LIMIT 1) an
        ON an.score IS NOT NULL
      WHERE ${TRACKS.learning} = ANY (s.tags)
        AND an.relevance = 'pass'
        AND jsonb_typeof(an.output->'scores') = 'array'
        AND NOT EXISTS (SELECT 1 FROM selection_gold g WHERE g.article_id = a.id)
    )
    SELECT id, url, published_at, source_name,
           (scores->>0)::int AS s1,
           CASE WHEN jsonb_array_length(scores) > 1 THEN (scores->>1)::int END AS s2
    FROM latest`;

  const byStratum = new Map<string, Candidate[]>();
  let offGrid = 0;
  for (const r of rows) {
    const stratum = stratumOf(r.s1, r.s2);
    // A score that is not one of the three levels: the news-track wording, which scores continuously. Those
    // articles are the ones still waiting on a human gate (§8.2.1 of 项目地图.md), and a decision on them
    // would be measured against a threshold their own track does not use — so they are reported, not drawn.
    if (!stratum) { offGrid++; continue; }
    const list = byStratum.get(stratum.code) ?? [];
    list.push(r);
    byStratum.set(stratum.code, list);
  }

  // Id order, not random(): the same database draws the same sheet, so re-running after an interrupted
  // session does not silently hand over a different set of items to label. Ids are random-looking, so this
  // is not a chronological sample either.
  const keyed = (list: Candidate[]) => [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const drawn = interleave(STRATA.map((s) => {
    const list = keyed(byStratum.get(s.code) ?? []);
    return list.slice(0, Math.min(stratumQuota(s.code), list.length));
  }));

  const sheet: WorksheetRow[] = [];
  for (const c of drawn) {
    const item = await loadAnalyzeInput(c.id);
    if (!item) continue;
    const t = translateInputOf(item);
    const quoted = t.quotedText ? `\n[引用${t.quotedAuthor ? ` @${t.quotedAuthor}` : ""}] ${t.quotedText}` : "";
    sheet.push({
      index: sheet.length + 1,
      code: stratumOf(c.s1, c.s2)!.code,
      split: splitOf(c.id),
      id: c.id,
      source: c.source_name,
      publishedAt: c.published_at ? c.published_at.toISOString().slice(0, 16).replace("T", " ") : "",
      text: `${t.text}${quoted}` || t.title,
      url: c.url,
    });
  }
  return { sheet, pool: rows.length, offGrid };
}

async function generate(path: string) {
  const { sheet, pool, offGrid } = await sample();
  await writeFile(path, toCsv(sheet), "utf8");
  const tally = new Map<string, number>();
  for (const r of sheet) tally.set(r.code, (tally.get(r.code) ?? 0) + 1);
  const splits = new Map<string, number>();
  for (const r of sheet) splits.set(r.split, (splits.get(r.split) ?? 0) + 1);
  console.log(`wrote ${sheet.length} rows to ${path}`);
  console.log(`columns: ${COLUMNS.join(" | ")}   ← 填「决定」(select/reject，拿不准就留空) 与「理由」(一句话)`);
  console.log(`splits: ${[...splits].map(([k, v]) => `${k}=${v}`).join(" ")}`);
  console.log(`pool: ${pool} scored learning-track items; drew ${sheet.length}, left out ${offGrid} whose score is not one of the three levels (news-track wording — see §8.2.1)`);
  // The legend is printed here and nowhere near the sheet: the operator must not be able to see which
  // pile a row came from, or the sample's scores leak into the judgement.
  console.log("strata legend (keep this out of the sheet):");
  for (const s of STRATA) {
    console.log(`  ${s.code} = ${s.name} (${s.s1}${s.s2 === null ? "" : `+${s.s2}`}) drew ${tally.get(s.code) ?? 0}${s.future ? "" : "  [rule A no longer produces this pair]"}`);
  }
  console.log("rows are dealt round-robin across the strata, so labelling only the first N still covers the whole range;");
  console.log("a row left blank is skipped, not guessed.");
}

async function apply(path: string, live: boolean, actor: string) {
  const sheet = readFilled(await readFile(path, "utf8"));
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
    console.log(`next: node --env-file=.env scripts/eval-selection.ts --track learning --split development`);
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
