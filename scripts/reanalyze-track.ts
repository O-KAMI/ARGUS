// Re-judges the articles of sources whose track changed after they were analysed. Tagging a source
// `track:learning` only affects what arrives next: everything already in `analyses` was judged by the
// news standard, at the news threshold, and would stay that way forever. This walks those articles
// through the same pipeline the worker uses (editorial/analyze.ts, then publication/publish.ts), so the
// site's current content is judged by the standard its source actually belongs to.
//
// It is not a retroactive re-judging of history under a revised wording. Each run appends a new
// `analyses` row and leaves the old one intact, and the row records the prompt version that produced it,
// so the news-track judgement stays auditable and comparable. What changes is which judgement the
// publication shows.
//
// Only the score step is paid: the prefilter, structure and writing receipts are keyed on prompt
// versions this does not change, so they reuse. Two score calls per article.
//
// Event grouping is NOT re-run here (it needs the worker's queues). Facts and stories keep the
// membership they were grouped with; re-grouping is a separate pass.
//
// Usage:
//   node --env-file=.env scripts/reanalyze-track.ts [--dry-run] [--limit 50] [--concurrency 4]
//     [--track learning] [--source <id>]
import { parseArgs } from "node:util";
import { closeDb, sql } from "@aihot/backend/db";
import { analyzeArticle } from "@aihot/backend/editorial/analyze";
import { publishArticle } from "@aihot/backend/publication/publish";
import { TRACKS, type Track } from "@aihot/industry/selection";

const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    limit: { type: "string" },
    concurrency: { type: "string" },
    track: { type: "string", default: "learning" },
    source: { type: "string" },
  },
});

const track = values.track as Track;
if (track !== "learning" && track !== "news") throw new Error(`--track must be learning or news, got ${values.track}`);
const limit = values.limit ? Number.parseInt(values.limit, 10) : null;
const concurrency = Math.max(1, values.concurrency ? Number.parseInt(values.concurrency, 10) : 4);
const tag = track === "learning" ? TRACKS.learning : null;

/** Articles whose newest analysis was produced by a different track's score wording than their source now has. */
async function pending(): Promise<{ id: string; source: string; score: number | null; selected: boolean }[]> {
  // The learning wording's version contains `selection-score-learning`; the news one contains
  // `selection-score@`, which the learning string also starts with — hence the `@`.
  const marker = track === "learning" ? "selection-score-learning" : "selection-score@";
  const rows = await sql<{ id: string; source: string; score: number | null; selected: boolean }[]>`
    SELECT a.id, a.source_id AS source, latest.score, latest.selected
    FROM articles a
    JOIN sources s ON s.id = a.source_id
    JOIN LATERAL (
      SELECT an.prompt_version, an.score, an.selected FROM analyses an
      WHERE an.article_id = a.id ORDER BY an.id DESC LIMIT 1
    ) latest ON true
    WHERE s.participation_mode = 'editorial'
      AND NOT (latest.prompt_version LIKE '%' || ${track === "learning" ? "selection-score-learning" : "selection-score@"} || '%')
      ${tag ? sql`AND ${tag} = ANY(s.tags)` : sql`AND NOT (${TRACKS.learning} = ANY(s.tags))`}
      ${values.source ? sql`AND a.source_id = ${values.source}` : sql``}
    ORDER BY a.published_at DESC NULLS LAST
    ${limit ? sql`LIMIT ${limit}` : sql``}`;
  return rows;
}

async function counts(): Promise<Record<string, number>> {
  const [row] = await sql<Record<string, number>[]>`
    SELECT count(*)::int AS articles,
           count(*) FILTER (WHERE p.selected)::int AS selected,
           count(*) FILTER (WHERE p.visibility = 'public')::int AS public
    FROM articles a LEFT JOIN publications p ON p.article_id = a.id
    JOIN sources s ON s.id = a.source_id
    ${tag ? sql`WHERE ${tag} = ANY(s.tags)` : sql``}`;
  return row!;
}

const before = await counts();
const queue = await pending();
console.log(`track=${track}  pending=${queue.length}  concurrency=${concurrency}${values["dry-run"] ? "  DRY RUN" : ""}`);
console.log(`before: ${JSON.stringify(before)}`);
if (values["dry-run"]) {
  for (const r of queue.slice(0, 20)) console.log(`  would re-judge ${r.id} (${r.source}) score=${r.score} selected=${r.selected}`);
  if (queue.length > 20) console.log(`  … and ${queue.length - 20} more`);
  await closeDb();
  process.exit(0);
}

const tally = { done: 0, selected: 0, blocked: 0, unknown: 0, stale: 0, skipped: 0, failed: 0 };
let cursor = 0;
const started = Date.now();

async function worker(slot: number): Promise<void> {
  while (cursor < queue.length) {
    const item = queue[cursor++];
    try {
      const result = await analyzeArticle(item.id);
      if (!result) { tally.skipped++; continue; }
      if (result.stale) { tally.stale++; continue; }
      if (result.needsBody || !result.output) { tally.skipped++; continue; }
      await publishArticle(item.id);
      tally.done++;
      if (result.output.relevance === "block") tally.blocked++;
      else if (result.output.relevance === "unknown") tally.unknown++;
      if (result.output.selected) tally.selected++;
      if (tally.done % 25 === 0) {
        const perMin = Math.round((tally.done / ((Date.now() - started) / 60000)) * 10) / 10;
        console.log(`  [${slot}] ${tally.done}/${queue.length} selected=${tally.selected} ${perMin}/min`);
      }
    } catch (error) {
      tally.failed++;
      console.error(`  [${slot}] ${item.id} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, (_, i) => worker(i)));
const after = await counts();
console.log(`tally: ${JSON.stringify(tally)}`);
console.log(`after:  ${JSON.stringify(after)}`);
console.log(`elapsed: ${Math.round((Date.now() - started) / 1000)}s`);
await closeDb();
// Other handles (provider sockets, timers) outlive closeDb, so without this the process sits idle for
// hours after printing its tally and reads like a run still in progress.
process.exit(tally.failed > 0 ? 1 : 0);
