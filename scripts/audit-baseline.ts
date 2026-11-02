// The audit's §15 asks for numbers the code cannot prove by itself: how far apart the two model scores sit,
// how behind a source's published-time watermark is, how the mirrored window's reads line up. This reads the
// database only — no upstream request, no model call, no budget — and prints the current baseline so a target
// can be set against a measured fact instead of a guess.
//   node --env-file=.env scripts/audit-baseline.ts
import { closeDb, sql } from "@aihot/backend/db";

const line = (label: string, value: string) => console.log(`${label.padEnd(30, " ")}${value}`);
const num = (value: unknown): string => value === null || value === undefined ? "—" : String(value);

const score = await sql<{ n: string; mean: string | null; p50: string | null; p90: string | null; max: string | null; cross: string | null }[]>`
  WITH pairs AS (
    SELECT abs((output->'scores'->>0)::int - (output->'scores'->>1)::int) AS gap,
      ((output->'scores'->>0)::int >= (output->>'threshold')::int) AS first_in,
      ((output->'scores'->>1)::int >= (output->>'threshold')::int) AS second_in
    FROM analyses
    WHERE jsonb_typeof(output->'scores') = 'array' AND jsonb_array_length(output->'scores') = 2
      AND output ? 'threshold'
  )
  SELECT count(*) AS n, round(avg(gap), 1) AS mean,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY gap)::numeric(6,1) AS p50,
    percentile_cont(0.9) WITHIN GROUP (ORDER BY gap)::numeric(6,1) AS p90,
    max(gap) AS max,
    count(*) FILTER (WHERE first_in IS DISTINCT FROM second_in) AS cross
  FROM pairs`;
line("双评样本（次）", num(score[0]?.n));
line("分差 均值 / P50 / P90 / 最大", `${num(score[0]?.mean)} / ${num(score[0]?.p50)} / ${num(score[0]?.p90)} / ${num(score[0]?.max)}`);
const cross = await sql<{ tier: string; n: string; cross: string }[]>`
  SELECT s.tier, count(*)::text AS n,
    count(*) FILTER (WHERE ((output->'scores'->>0)::int >= (output->>'threshold')::int)
      IS DISTINCT FROM ((output->'scores'->>1)::int >= (output->>'threshold')::int))::text AS cross
  FROM analyses a JOIN articles ar ON ar.id = a.article_id JOIN sources s ON s.id = ar.source_id
  WHERE jsonb_typeof(a.output->'scores') = 'array' AND jsonb_array_length(a.output->'scores') = 2 AND a.output ? 'threshold'
  GROUP BY 1 ORDER BY count(*) DESC`;
line("两次评分跨越门槛的次数", `${num(score[0]?.cross)} / ${num(score[0]?.n)} 次双评（${score[0]?.n === "0" ? "—" : Math.round(Number(score[0]?.cross ?? 0) / Math.max(1, Number(score[0]?.n)) * 100)}%）`);
for (const row of cross) line(`  层级 ${row.tier}`, `${row.n} 次双评，跨门槛 ${row.cross}`);

const gold = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM selection_gold`;
line("人工金标条数", `${num(gold[0]?.n)}${gold[0]?.n === "0" ? " → 精选 Precision / Recall / MAE 现在还算不出来" : ""}`);

const water = await sql<{ sources: string; behind: string; empty: string; never: string }[]>`
  SELECT count(*) FILTER (WHERE s.enabled)::text AS sources,
    count(*) FILTER (WHERE s.enabled AND w.lag_min > 6 * 60)::text AS behind,
    count(*) FILTER (WHERE s.enabled AND coalesce(r.runs, 0) > 0 AND coalesce(r.found, 0) = 0)::text AS empty,
    count(*) FILTER (WHERE s.enabled AND s.last_ok_at IS NULL)::text AS never
  FROM sources s
  LEFT JOIN LATERAL (
    SELECT (EXTRACT(EPOCH FROM now() - max(a.published_at)) / 60)::int AS lag_min
    FROM articles a WHERE a.source_id = s.id AND a.published_at IS NOT NULL
  ) w ON TRUE
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS runs, sum(f.found_count)::int AS found FROM fetch_runs f
    WHERE f.source_id = s.id AND f.started_at > now() - interval '24 hours'
  ) r ON TRUE`;
line("在用信源 / 水位超 6 小时", `${num(water[0]?.sources)} / ${num(water[0]?.behind)}`);
line("24 小时内有抓取但零收录的信源", `${num(water[0]?.empty)}（账号本身没发新内容时这是正常的）`);
line("从未成功读到的信源", num(water[0]?.never));

const runShape = await sql<{ runs: string; with_detail: string; keys: string }[]>`
  SELECT count(*)::text AS runs,
    count(*) FILTER (WHERE detail IS NOT NULL)::text AS with_detail,
    coalesce((SELECT string_agg(k, ', ' ORDER BY k) FROM (SELECT DISTINCT jsonb_object_keys(detail) k FROM fetch_runs WHERE detail IS NOT NULL) x), '—') AS keys
  FROM fetch_runs WHERE started_at > now() - interval '7 days'`;
line("7 天内抓取记录（含 detail）", `${num(runShape[0]?.runs)}（${num(runShape[0]?.with_detail)}）`);
line("detail 里的键", num(runShape[0]?.keys));

// 采集完整性不是没有指标：抓取记录自己带了页数、终止原因与截断标记，这里量的是它有多常被用到。
const completeness = await sql<{ layer: string; runs: string; pages: string; trunc: string; max: string }[]>`
  SELECT coalesce(NULLIF(detail->>'layer', ''), '(未标注)') AS layer, count(*)::text AS runs,
    count(*) FILTER (WHERE detail ? 'pages')::text AS pages,
    count(*) FILTER (WHERE (detail->>'truncated')::boolean)::text AS trunc,
    coalesce(max((detail->>'pages')::int), 0)::text AS max
  FROM fetch_runs WHERE started_at > now() - interval '7 days' GROUP BY 1 ORDER BY count(*) DESC`;
console.log("\n抓取分页完整性（按采集层）：");
for (const row of completeness) line(`  ${row.layer}`, `${row.runs} 次 · 记页数 ${row.pages} · 截断 ${row.trunc} · 最多 ${row.max} 页`);

const group = await sql<{ pending: string; complete: string; stories: string; singletons: string; manual: string }[]>`
  SELECT (SELECT count(*) FROM articles WHERE grouping_status = 'pending')::text AS pending,
    (SELECT count(*) FROM articles WHERE grouping_status = 'complete')::text AS complete,
    (SELECT count(*) FROM stories WHERE merged_into IS NULL)::text AS stories,
    (SELECT count(*) FROM stories s WHERE merged_into IS NULL AND (SELECT count(*) FROM facts f WHERE f.story_id = s.id) = 1)::text AS singletons,
    (SELECT count(*) FROM facts WHERE manual)::text AS manual`;
line("待归并 / 已归并（篇）", `${num(group[0]?.pending)} / ${num(group[0]?.complete)}`);
line("事件数 / 只有一个事实的事件", `${num(group[0]?.stories)} / ${num(group[0]?.singletons)}`);
line("人工决定的事实条数", num(group[0]?.manual));

const mirror = await sql<{ endpoint: string; status: string; count: string; ok: string; error: string }[]>`
  SELECT endpoint, coalesce(last_status::text, '—') status, coalesce(last_count::text, '—') count,
    to_char(last_ok_at, 'MM-DD HH24:MI') ok, coalesce(last_error, '—') error
  FROM aihot_mirror_state ORDER BY endpoint`;
console.log("\n镜像三个地址（快照时间差与截断都从这里读）：");
for (const row of mirror) line(`  ${row.endpoint.slice(0, 34)}`, `${row.status} · ${row.count} 条 · 上次成功 ${row.ok} · ${row.error.slice(0, 40)}`);

const skew = await sql<{ skew: string | null }[]>`
  SELECT round((EXTRACT(EPOCH FROM (max(last_ok_at) - min(last_ok_at))) / 60)::numeric, 1)::text AS skew
  FROM aihot_mirror_state WHERE last_ok_at IS NOT NULL`;
line("当前快照时间偏差（分钟）", num(skew[0]?.skew));

const mirrored = await sql<{ articles: string; reports: string }[]>`
  SELECT (SELECT count(*) FROM articles WHERE source_id = 'aihot-mirror')::text AS articles,
    (SELECT count(*) FROM publications p JOIN articles a ON a.id = p.article_id WHERE a.source_id = 'aihot-mirror')::text AS reports`;
line("镜像入库材料 / 已发布报道", `${num(mirrored[0]?.articles)} / ${num(mirrored[0]?.reports)}`);

await closeDb();
process.exit(0);
