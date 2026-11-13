import type { AdminNavCounts } from "@aihot/contracts/admin";
import { TRACKS } from "@aihot/industry/selection";
import { sql } from "../db.ts";
import { serverModules } from "../modules.ts";
import { awaitingRelease } from "../providers/receipts.ts";

/**
 * Items waiting for the admin, on the navigation: new feedback, failing sources, receipts and deliveries in
 * doubt, the learning boundary cases held for a human decision, and what the modules count.
 */
export async function navCounts(): Promise<AdminNavCounts> {
  const [[c], counts] = await Promise.all([
    sql<AdminNavCounts[]>`
    SELECT (SELECT count(*)::int FROM feedback WHERE status = 'new') AS feedback,
           (SELECT count(*)::int FROM sources WHERE enabled AND health = 'failing') AS sources,
           (SELECT count(*)::int FROM receipts WHERE ${awaitingRelease()}) + (SELECT count(*)::int FROM deliveries WHERE status = 'unknown') AS runs,
           (SELECT count(*)::int FROM articles a JOIN sources s ON s.id = a.source_id
             WHERE ${TRACKS.learning} = ANY (s.tags)
               AND NOT EXISTS (SELECT 1 FROM editorial_overrides o WHERE o.article_id = a.id)
               AND (SELECT x.output->>'review' FROM analyses x WHERE x.article_id = a.id ORDER BY x.id DESC LIMIT 1) = 'true') AS review`,
    Promise.all(serverModules().flatMap((m) => Object.entries(m.admin?.counts ?? {}).map(async ([key, count]) => [key, await count()] as const))),
  ]);
  return { ...c, ...Object.fromEntries(counts) };
}
