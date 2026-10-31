// Fills publications.platform for the rows published before migration 0090 added the column. A release
// migration may not rewrite a table, so this is the bounded, observable operation that does: it derives
// each row with the rule publishing itself uses (publication/rules.ts platformOf), leaves a row that
// already has a platform alone, and re-publishes nothing.
//   node --env-file=.env scripts/backfill-publications-platform.ts [--dry-run] [--batch 500]
import { parseArgs } from "node:util";
import { closeDb, sql } from "@aihot/backend/db";
import { platformOf } from "@aihot/backend/publication/rules";

const { values } = parseArgs({ options: { "dry-run": { type: "boolean" }, batch: { type: "string" } } });
const dryRun = !!values["dry-run"];
const batch = Math.max(1, Number(values.batch ?? 500));

const distribution = async (title: string) => {
  const rows = await sql<Array<{ platform: string | null; n: number }>>`
    SELECT platform, count(*)::int AS n FROM publications GROUP BY platform ORDER BY platform`;
  console.log(`${title}：${rows.map((r) => `${r.platform ?? "未回填"} ${r.n}`).join("，") || "（空表）"}`);
  return rows;
};

await distribution("回填前");
let seen = 0;
const derived: Record<string, number> = {};
for (let cursor = "";;) {
  const rows = await sql<Array<{ article_id: string; channel: "news" | "x"; url: string; kind: string }>>`
    SELECT p.article_id, p.channel, p.url, s.kind FROM publications p JOIN sources s ON s.id = p.source_id
    WHERE p.platform IS NULL AND p.article_id > ${cursor} ORDER BY p.article_id LIMIT ${batch}`;
  if (rows.length === 0) break;
  cursor = rows[rows.length - 1]!.article_id;
  const byPlatform = new Map<string, string[]>();
  for (const row of rows) {
    const platform = platformOf(row.kind, row.channel, row.url);
    derived[platform] = (derived[platform] ?? 0) + 1;
    byPlatform.set(platform, [...byPlatform.get(platform) ?? [], row.article_id]);
  }
  if (!dryRun) {
    for (const [platform, ids] of byPlatform) {
      await sql`UPDATE publications SET platform = ${platform} WHERE platform IS NULL AND article_id IN ${sql(ids)}`;
    }
  }
  seen += rows.length;
  console.log(`${dryRun ? "待回填" : "已回填"} ${seen} 行：${Object.entries(derived).map(([p, n]) => `${p} ${n}`).join("，")}`);
}
const after = await distribution(dryRun ? "未写入，库里仍是" : "回填后");
const missing = after.find((r) => r.platform === null)?.n ?? 0;
// publications.source_id has no foreign key: a row whose source is gone cannot be judged and stays unset.
if (!dryRun && missing > 0) console.error(`仍有 ${missing} 行没有平台：它们的信源已不在 sources 里，判定不出来，需要人工核对。`);
await closeDb();
