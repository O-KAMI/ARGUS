// One-off: fill articles.asset_key for material stored before the column existed, using the same regex
// ingest uses. A bulk backfill never goes into a release migration.
//   node --env-file=.env scripts/backfill-asset-key.ts
import { closeDb, sql } from "@aihot/backend/db";
import { assetKey } from "@aihot/backend/lib/asset-key";

const rows = await sql<{ id: string; url: string; title: string; body_text: string | null; excerpt: string | null; x_post: { text?: string; quoted?: { text?: string } } | null }[]>`
  SELECT id, url, title, body_text, excerpt, x_post FROM articles`;
let filled = 0;
for (const row of rows) {
  const key = assetKey([row.body_text, row.excerpt, row.x_post?.text, row.x_post?.quoted?.text, row.title].filter(Boolean).join("\n"), row.url);
  await sql`UPDATE articles SET asset_key = ${key} WHERE id = ${row.id} AND asset_key IS DISTINCT FROM ${key}`;
  if (key) filled++;
}
const [total] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM articles WHERE asset_key IS NOT NULL`;
const shared = await sql<{ asset_key: string; n: number }[]>`
  SELECT asset_key, count(*)::int AS n FROM articles WHERE asset_key IS NOT NULL
  GROUP BY asset_key HAVING count(*) > 1 ORDER BY n DESC LIMIT 10`;
console.log(`scanned ${rows.length} · filled ${filled} · articles with an asset key ${total?.n ?? 0}`);
for (const row of shared) console.log(`  ${row.n} × ${row.asset_key}`);
await closeDb();
process.exit(0);
