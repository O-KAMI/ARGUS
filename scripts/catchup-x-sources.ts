// Re-queues X sources that never got a cursor, so the worker reads their first free FxTwitter page now
// instead of waiting for the normal schedule. The worker still follows FxTwitter → RSS → SocialData;
// SocialData stays behind the budget, and a source whose FxTwitter answers 404 keeps using its RSS.
//   node --env-file=.env scripts/catchup-x-sources.ts [--dry-run]
import { closeDb, sql } from "@aihot/backend/db";

const dryRun = process.argv.includes("--dry-run");
const pending = await sql<Array<{ id: string }>>`
  SELECT id FROM sources
  WHERE kind = 'x_search' AND enabled AND (cursor IS NULL OR cursor->>'lastTweetId' IS NULL)
  ORDER BY id`;
console.log(`待首抓的 X 信源：${pending.length} 个；优先走免费的 FxTwitter。`);
if (dryRun || pending.length === 0) {
  console.log(pending.map((p) => p.id).join("\n"));
  await closeDb();
  process.exit(0);
}
await sql`UPDATE sources SET next_fetch_at = now() WHERE id IN ${sql(pending.map((p) => p.id))}`;
console.log(`已排队 ${pending.length} 个；worker 会按 FxTwitter → RSS → SocialData 读取。`);
await closeDb();
