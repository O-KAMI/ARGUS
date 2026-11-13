// Re-judges stock whose newest judgement no longer matches the wording its source should use, walking
// it through the same pipeline the worker uses (editorial/analyze.ts, then publication/publish.ts). The
// wording can drift two ways, picked with --by:
//   track (default): the source's track changed after the article was judged (e.g. tagged
//     `track:learning`, but the stock was judged by the news standard). Matches by prompt NAME.
//   hash: the track is unchanged but its score rubric was revised — same prompt name, new content hash.
//     Matches by the current score version, so a calibration re-judges exactly the stock it applies to.
//
// It is not a retroactive re-judging of history under a revised wording. Each run appends a new
// `analyses` row and leaves the old one intact, and the row records the prompt version that produced it,
// so the earlier judgement stays auditable and comparable. What changes is which judgement the
// publication shows.
//
// Only the score step re-pays for a wording change: the prefilter, structure and writing receipts are
// keyed on prompt versions this does not change, so they reuse. The learning track takes one score call
// per article, the news track two. An article that newly reaches the understand step (it was below the
// floor before and is not now) pays that one call as well; the rest reuse.
//
// Event grouping is NOT re-run here (it needs the worker's queues). Facts and stories keep the
// membership they were grouped with; re-grouping is a separate pass.
//
// Usage:
//   node --env-file=.env scripts/reanalyze-track.ts [--dry-run] [--limit 50] [--concurrency 4]
//     [--track learning] [--by track|hash] [--source <id>]
import { parseArgs } from "node:util";
import { closeDb, sql } from "@aihot/backend/db";
import { analyzeArticle, PROMPT_VERSIONS } from "@aihot/backend/editorial/analyze";
import { publishArticle } from "@aihot/backend/publication/publish";
import { TRACKS, type Track } from "@aihot/industry/selection";

const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    limit: { type: "string" },
    concurrency: { type: "string" },
    track: { type: "string", default: "learning" },
    by: { type: "string", default: "track" },
    source: { type: "string" },
  },
});

const track = values.track as Track;
if (track !== "learning" && track !== "news") throw new Error(`--track must be learning or news, got ${values.track}`);
const by = values.by;
if (by !== "track" && by !== "hash") throw new Error(`--by must be track or hash, got ${values.by}`);
const limit = values.limit ? Number.parseInt(values.limit, 10) : null;
const concurrency = Math.max(1, values.concurrency ? Number.parseInt(values.concurrency, 10) : 4);
const tag = track === "learning" ? TRACKS.learning : null;
// The track's current score wording, as stored on each judgement (`name@hash`).
const currentScore = track === "learning" ? PROMPT_VERSIONS.scoreLearning : PROMPT_VERSIONS.score;
// The learning wording is `selection-score-learning@…`; the news one is `selection-score@…`. The learning
// string also starts with `selection-score`, so the news marker carries the `@` to tell them apart.
const nameMarker = track === "learning" ? "selection-score-learning@" : "selection-score@";

/**
 * Articles whose newest analysis was produced by wording their source should no longer use:
 * `--by track` picks the other track's wording (by name); `--by hash` picks this track's wording at an
 * older content hash than the current rubric.
 */
async function pending(): Promise<{ id: string; source: string; score: number | null; selected: boolean }[]> {
  const drift = by === "hash"
    ? sql`latest.prompt_version LIKE '%' || ${nameMarker} || '%' AND latest.prompt_version NOT LIKE '%' || ${currentScore} || '%'`
    : sql`NOT (latest.prompt_version LIKE '%' || ${nameMarker} || '%')`;
  const rows = await sql<{ id: string; source: string; score: number | null; selected: boolean }[]>`
    SELECT a.id, a.source_id AS source, latest.score, latest.selected
    FROM articles a
    JOIN sources s ON s.id = a.source_id
    JOIN LATERAL (
      SELECT an.prompt_version, an.score, an.selected FROM analyses an
      WHERE an.article_id = a.id ORDER BY an.id DESC LIMIT 1
    ) latest ON true
    WHERE s.participation_mode = 'editorial'
      AND ${drift}
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
console.log(`track=${track}  by=${by}  pending=${queue.length}  concurrency=${concurrency}${values["dry-run"] ? "  DRY RUN" : ""}`);
console.log(`current score wording: ${currentScore}`);
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
