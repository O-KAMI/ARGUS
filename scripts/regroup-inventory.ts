// What re-grouping the learning track would cost, computed without spending anything.
//
// The articles were re-judged under the learning wording, but their facts and stories were grouped
// under the news wording, and nothing re-runs that automatically: `sweepUngrouped()` only picks up
// `grouping_status = 'pending'`, so a `complete` article waits for an explicit `requestRegroup()`.
// That is a paid pass, so the owner wants the bill first.
//
// This script reads. It calls the same recall the worker's `decide()` calls
// (`relatedPosts` / `recallFacts` / `candidateViews` / `recallSelectedBackground`, the same constants
// and the same query text), and it stops there: no model call, no enqueue, no write. Recall is the
// free half of the decision — with no embedding key configured it is shared-character-bigram scoring
// done in this process — so the candidate sets below are exactly what the paid half would be shown.
//
// It then classifies every article by the branch `decide()` takes before it buys anything, and prices
// the paid half with the token averages of the receipts of the same kind already in this database.
// The relation a model would answer is not computable here; what is computable is how many articles
// get a chance to merge at all, which bounds the consolidation from above.
//
// Usage:
//   DATABASE_URL=postgres://localhost:5433/argus node --env-file=.env scripts/regroup-inventory.ts [--track learning] [--limit 40]
import { parseArgs } from "node:util";
import { closeDb, sql } from "@aihot/backend/db";
import { isHistorical } from "@aihot/backend/content/materials";
import { latestCompositeCondition } from "@aihot/backend/publication/scope";
import { candidateViews, recallFacts, recallSelectedBackground, relatedPosts } from "@aihot/backend/events/recall";
import { reportText } from "@aihot/backend/events/relate";
import { embeddingsAvailable } from "@aihot/backend/providers/embeddings";

/** The numbers `decide()` is built from; a regroup passes none of them, so they must match by hand. */
const RECALL_MIN_COSINE = 0.6;
const RECALL_TOP_FACTS = 10;

const { values } = parseArgs({ options: { track: { type: "string", default: "learning" }, limit: { type: "string" }, selected: { type: "boolean", default: false } } });
const track = values.track as "learning" | "news";
const limit = values.limit ? Number.parseInt(values.limit, 10) : null;
const selectedOnly = values.selected;

if (embeddingsAvailable()) throw new Error("an embedding key is configured: recall would buy embedding calls. Unset it, or do not run this here.");

// ---- scope, and the branches that cost nothing -----------------------------------------------
const rows = await sql<{ id: string }[]>`
  SELECT a.id FROM articles a JOIN sources s ON s.id = a.source_id
  LEFT JOIN publications p ON p.article_id = a.id
  WHERE ${track === "learning" ? sql`'track:learning'=ANY(s.tags)` : sql`NOT 'track:learning'=ANY(s.tags)`}
    AND a.grouping_status = 'complete' ${selectedOnly ? sql`AND coalesce(p.selected, false)` : sql``}
  ORDER BY a.discovered_at, a.id ${limit ? sql`LIMIT ${limit}` : sql``}`;
const ids = rows.map((r) => r.id);
const articles = await sql<{
  id: string; title: string; url: string; asset_key: string | null; x_post: any; backfill: boolean;
  revision: number; discovered_at: Date; published_at: Date | null; selected: boolean;
  manual: boolean; fact_id: number | null; story_id: number | null; relevance: string | null; composite: boolean;
}[]>`
  SELECT a.id, a.title, a.url, a.asset_key, a.x_post, a.backfill, a.revision, a.discovered_at, a.published_at,
         coalesce(p.selected, false) AS selected,
         EXISTS (SELECT 1 FROM fact_articles m WHERE m.article_id = a.id AND m.manual)
           OR EXISTS (SELECT 1 FROM grouping_overrides o WHERE o.article_id = a.id) AS manual,
         fa.fact_id, f.story_id, an.relevance, ${latestCompositeCondition(sql`a.id`)} AS composite
  FROM articles a
  LEFT JOIN publications p ON p.article_id = a.id
  LEFT JOIN LATERAL (SELECT x.fact_id, ft.story_id FROM fact_articles x JOIN facts ft ON ft.id = x.fact_id
                     WHERE x.article_id = a.id AND x.role IN ('primary','report')
                     ORDER BY (x.role='primary') DESC, x.created_at LIMIT 1) fa ON true
  LEFT JOIN facts f ON f.id = fa.fact_id
  LEFT JOIN LATERAL (SELECT relevance FROM analyses z WHERE z.article_id = a.id
                     ORDER BY z.input_revision DESC, z.id DESC LIMIT 1) an ON true
  WHERE a.id = ANY(${ids})`;

const branch = { manual: 0, historical: 0, noPass: 0, toRecall: 0 } as Record<string, number>;
const todo: (typeof articles)[number][] = [];
for (const a of articles) {
  if (a.manual) branch.manual++;
  else if (isHistorical({ backfill: a.backfill, published_at: a.published_at, discovered_at: new Date(a.discovered_at) })) branch.historical++;
  else if (a.relevance !== "pass") branch.noPass++;
  else { branch.toRecall++; todo.push(a); }
}

// ---- the free half, run for real --------------------------------------------------------------
type Row = { a: (typeof articles)[number]; same: any; selectedSame: boolean; facts: number[]; stories: number[]; reading: number; ownFactRecalled: boolean };
const seen: Row[] = [];
for (const a of todo) {
  const [analysis] = await sql<{ summary_zh: string | null; title_zh: string | null }[]>`
    SELECT summary_zh, title_zh FROM analyses WHERE article_id = ${a.id} ORDER BY input_revision DESC, id DESC LIMIT 1`;
  const query = reportText(analysis?.title_zh || a.title, analysis?.summary_zh);
  const { sameUrl, sameAsset, referenced } = await relatedPosts(a);
  const same = sameUrl ?? sameAsset;
  const selectedSame = !!same && !a.composite && (await candidateViews([{ factId: same.fact_id, storyId: same.story_id, factTitle: same.fact_title, score: 1 }]))[0]?.selected === true;
  const recalled = selectedSame ? [] : await recallFacts(a.id, query, RECALL_MIN_COSINE, RECALL_TOP_FACTS, [...referenced, ...(same ? [same] : [])]);
  const cands = selectedSame ? [] : await candidateViews(recalled);
  const reading = selectedSame ? [] : await recallSelectedBackground(a.id, query, RECALL_MIN_COSINE, cands.map((c) => c.factId));
  seen.push({ a, same, selectedSame, facts: cands.map((c) => c.factId), stories: [...new Set(cands.map((c) => c.storyId))], reading: reading.length, ownFactRecalled: !!a.fact_id && cands.some((c) => c.factId === a.fact_id) });
}

// The upper bound on how few groups this could end with: articles join whatever fact they can recall
// at all, transitively. Every one of these edges still needs a model to answer SAME_OCCURRENCE.
const parent = new Map<string, string>();
const find = (x: string): string => { const p = parent.get(x); return !p ? x : (parent.set(x, find(p)), parent.get(x)!); };
const union = (x: string, y: string) => { const [a, b] = [find(x), find(y)]; if (a !== b) parent.set(a, b); };
for (const r of seen) {
  union(`a:${r.a.id}`, `f:${r.selectedSame ? r.same.fact_id : r.facts[0] ?? `own:${r.a.fact_id ?? r.a.id}`}`);
  for (const f of r.facts) union(`a:${r.a.id}`, `f:${f}`);
}
const clusters = new Set(seen.map((r) => find(`a:${r.a.id}`)));

// ---- the paid half, priced from this database's own receipts -----------------------------------
const paid = await sql<{ purpose: string; n: bigint; tokens: bigint }[]>`
  SELECT purpose, count(*) AS n, coalesce(sum((usage->>'total_tokens')::bigint), 0) AS tokens
  FROM receipts WHERE purpose IN ('group_article','group_review','group_story','group_story_review','story_digest')
  GROUP BY purpose`;
const avg = new Map(paid.map((p) => [p.purpose, Number(p.tokens) / Number(p.n)]));
const judge = seen.filter((r) => !r.selectedSame && (r.facts.length || r.reading)).length;
const identityFree = seen.filter((r) => r.selectedSame).length;
const noCandidate = seen.length - judge - identityFree;
const confirmRate = Number(paid.find((p) => p.purpose === "group_review")?.n ?? 0) / Number(paid.find((p) => p.purpose === "group_article")?.n ?? 1);
const consolidateRate = Number(paid.find((p) => p.purpose === "group_story")?.n ?? 0) / Number(paid.find((p) => p.purpose === "group_article")?.n ?? 1);
// A report that leaves a story with nothing left in it empties it, and an emptied story is rebuilt.
const emptied = await sql<{ n: bigint }[]>`
  SELECT count(*) AS n FROM (
    SELECT f.story_id FROM fact_articles fa JOIN facts f ON f.id = fa.fact_id
    WHERE fa.article_id = ANY(${ids}) AND fa.role IN ('primary','report') AND f.story_id IS NOT NULL
    GROUP BY f.story_id HAVING count(*) = 1) s`;
const digestStories = Number(emptied[0]?.n ?? 0);
const landing = new Set(seen.flatMap((r) => (r.selectedSame ? [r.same.story_id] : r.stories)));
const tokens = judge * avg.get("group_article")! + Math.round(judge * confirmRate) * avg.get("group_review")!
  + Math.round(judge * consolidateRate) * avg.get("group_story")! + digestStories * avg.get("story_digest")!;

const historicalHeld = await sql<{ n: bigint }[]>`
  SELECT count(*) AS n FROM fact_articles fa JOIN articles a ON a.id = fa.article_id JOIN sources s ON s.id = a.source_id
  WHERE 'track:learning'=ANY(s.tags) AND a.grouping_status='complete' AND a.backfill
    AND (a.published_at IS NULL OR a.discovered_at - a.published_at > interval '48 hours') AND fa.role IN ('primary','report')`;
const pct = (n: number, d: number) => `${d ? Math.round((n / d) * 1000) / 10 : 0}%`;
console.log(`轨道 ${track} · grouping_status=complete：${articles.length} 篇${limit ? `（--limit ${limit}）` : ""}
  其中读者看到的精选 ${articles.filter((a) => a.selected).length} 篇${selectedOnly ? "（本次只取精选）" : ""}

到模型之前就返回的分支（0 次调用）
  人工决定（requestRegroup 对它空手返回）  ${branch.manual}
  历史资料（按原文时间归档）              ${branch.historical}  其中当前挂着成员关系 ${Number(historicalHeld[0]?.n ?? 0)} 篇
  当前修订未通过内容分析                  ${branch.noPass}
  → 会走到召回                           ${branch.toRecall}

召回（本地词法，本次实际跑了 ${seen.length} 篇，未调用任何模型）
  同 URL / 同 asset 且该事实已入选：不判   ${identityFree}
  召不到任何东西：独自开一条新事件         ${noCandidate}  ${pct(noCandidate, seen.length)}
  要买一次批量判定                         ${judge}  ${pct(judge, seen.length)}
  同组里还有别的文章被召回（可能回原组）  ${seen.filter((r) => r.ownFactRecalled).length}  ${pct(seen.filter((r) => r.ownFactRecalled).length, seen.length)}
  组数上界（把所有召回边都算成合并）        ${clusters.size} 组，收 ${seen.length} 篇

账单（按本库同模式回执的 token 均值，单价库里没有记录）
  group_article ${judge} 次 × ${Math.round(avg.get("group_article")!)} tokens
  group_review  ${Math.round(judge * confirmRate)} 次（实测比率 ${Math.round(confirmRate * 100)}%，只有模型答 SAME_OCCURRENCE 且相似度低于 0.85 才买）
  group_story   ${Math.round(judge * consolidateRate)} 次（实测比率 ${Math.round(consolidateRate * 100)}%）
  story_digest  ≤${digestStories} 次（会被清空的 story；落点涉及 ${landing.size} 个 story，
              同 story 的摘要任务用 singletonKey 合并，且提示词与报道未变时 composeStoryDigest 复用已付答案）
  合计约 ${(tokens / 1000).toFixed(0)}k tokens；cost 列在回执里是空的，金额要你自己按网关价格算
`);
await closeDb();
process.exit(0);
