import { SITE } from "@aihot/site";
import { useState } from "react";
import { Link } from "react-router";
import type { Route } from "./+types/labeling";
import type { AdminLabelDecision, AdminLabeling, AdminLabelingRow } from "@aihot/contracts/admin";
import { adminGet } from "../../lib/admin.server";
import { useAdminAction } from "../../features/admin/action";
import { bj } from "../../features/admin/format";
import { TIER_LABEL } from "../../features/admin/labels";
import { AdminPage, Badge, Button, ButtonLink, Card, Empty, Field, FilterChips, Input, Pager, ReasonDialog, Stat, Time } from "../../features/admin/ui";

export async function loader({ request }: Route.LoaderArgs) {
  return adminGet<AdminLabeling>(request, `/api/admin/labeling${new URL(request.url).search}`);
}

export const meta: Route.MetaFunction = () => [{ title: `精选标注 · ${SITE.name} 后台` }];

function LabelCard({ row }: { row: AdminLabelingRow }) {
  const { run, pending } = useAdminAction();
  const [ask, setAsk] = useState<AdminLabelDecision | null>(null);
  const [stratum, setStratum] = useState("");
  const submit = async (decision: AdminLabelDecision, reason: string) =>
    (await run("POST", `/api/admin/labeling/${row.id}`, {
      decision, reason, version: row.override_version, ...(stratum.trim() ? { stratum: stratum.trim() } : {}),
    }, { label: `label-${row.id}-${decision}`, success: decision === "select" ? "已标为精选，并写进公开精选" : "已标为不精选，并从公开精选撤下" })) !== null;
  return (
    <article className="rounded-panel bg-surface p-4 ring-1 ring-line">
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
        <span className="font-medium text-ink-2">{row.source_name}</span>
        <Badge tone="muted">{TIER_LABEL[row.tier] ?? row.tier}</Badge>
        {row.scored_learning
          ? <Badge tone="accent" title="这条的评分出自学习轨自己的评分标准">学习轨评分</Badge>
          : <Badge tone="warn" title="这条的评分出自新闻轨的标准（selection-score），学习轨的标准还没在它上面跑过">按新闻轨标准评分</Badge>}
        {row.score !== null && <span className="num">评分 {row.score}</span>}
        {row.analysis_selected && <Badge tone="ok">模型判为精选</Badge>}
        {row.relevance !== "pass" && <Badge tone="warn" title="结构化或文案没有完成，公开池里按未定处理">相关性 {row.relevance ?? "未知"}</Badge>}
        {row.published_selected ? <Badge tone="ok">公开精选中</Badge> : <Badge tone="muted">不在公开精选</Badge>}
        {row.override_selected !== null && <Badge tone="info" title={`人工设置 v${row.override_version}`}>人工设为{row.override_selected ? "精选" : "不精选"}</Badge>}
        {row.visibility && row.visibility !== "public" && <Badge tone="bad">公开范围 {row.visibility}</Badge>}
        <Time at={row.published_at ?? row.discovered_at} title={`收录于 ${bj(row.discovered_at, true)}`} />
      </div>
      <p className="mt-2.5 text-[14.5px] leading-relaxed text-ink">{row.title_zh || row.title}</p>
      {row.title_zh && row.title_zh !== row.title && <p className="mt-1 text-[12.5px] leading-relaxed text-ink-4">{row.title}</p>}
      {row.summary_zh && <p className="mt-2 text-[13.5px] leading-relaxed text-ink-2">{row.summary_zh}</p>}
      {row.reason_zh && <p className="mt-2 border-l-2 border-line pl-3 text-[13px] leading-relaxed text-ink-3">{row.reason_zh}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2 text-[12.5px] text-ink-4">
        <a className="text-accent hover:underline" href={row.url} target="_blank" rel="noreferrer">原文</a>
        <Link className="text-accent hover:underline" to={`/admin/content/${row.id}`}>内容诊断</Link>
        {row.analyzed_at && <span className="num">评分于 {bj(row.analyzed_at, true)}</span>}
        {row.category && <span>{row.category}</span>}
        {row.gold
          ? <span>你在 {bj(row.gold.created_at, true)} 标为{row.gold.decision === "select" ? "精选" : "不精选"}（{row.gold.actor}）</span>
          : <span>还没有人工标注</span>}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button tone={row.gold?.decision === "select" ? "primary" : "secondary"} busy={pending === `label-${row.id}-select`} onClick={() => setAsk("select")}>
          {row.gold?.decision === "select" ? "仍标为精选" : "标为精选"}
        </Button>
        <Button tone={row.gold?.decision === "reject" ? "primary" : "secondary"} busy={pending === `label-${row.id}-reject`} onClick={() => setAsk("reject")}>
          {row.gold?.decision === "reject" ? "仍标为不精选" : "标为不精选"}
        </Button>
      </div>
      <ReasonDialog
        open={ask !== null}
        title={ask === "select" ? "标为精选" : "标为不精选"}
        confirmLabel="标注并生效"
        busy={pending !== null}
        description={
          ask === "select"
            ? "这条会立刻按人工精选重新发布（走内容诊断里同一套人工设置，带版本检查与审计），同时把你的判断写进 selection_gold，作为校准学习轨门槛的样本。"
            : "这条会立刻按人工不精选重新发布（走内容诊断里同一套人工设置，带版本检查与审计），同时把你的判断写进 selection_gold，作为校准学习轨门槛的样本。"
        }
        onClose={() => setAsk(null)}
        onSubmit={(reason) => (ask === null ? false : submit(ask, reason))}
      >
        <Field label="分组（选填）" hint="你自己的一类，比如“教程”“观点”“发布”。导出金标集后，评测会按它分开看错在哪一类。">
          <Input value={stratum} onChange={(e) => setStratum(e.target.value)} placeholder="留空就不分组" maxLength={60} />
        </Field>
      </ReasonDialog>
    </article>
  );
}

function EmptyLabeling({ counts, state }: { counts: AdminLabeling["counts"]; state: AdminLabeling["state"] }) {
  if (counts.scored === 0) {
    return (
      <Empty>
        没有可标注的内容。学习轨信源共收进 {counts.items} 条，其中没有一条留下评分：被预筛拦下的、和只有标题还在等材料的，都不会出现在这里。
        等采集和处理跑过之后再来看。
      </Empty>
    );
  }
  if (state === "labelled" && counts.labelled === 0) return <Empty>还没有标注过任何内容。切到“待标注”开始。</Empty>;
  if (state === "awaiting") {
    return (
      <Empty>
        待标注的都已经标完了：{counts.scored} 条有评分的内容里，{counts.labelled} 条有人工标注。
        切到“已标注”可以回看和改口，或者等新内容收进来。
      </Empty>
    );
  }
  return <Empty>这一页没有内容。</Empty>;
}

export default function Labeling({ loaderData }: Route.ComponentProps) {
  const { rows, counts, state, page } = loaderData;
  return (
    <AdminPage
      title="精选标注"
      subtitle="学习轨信源里已经评过分的内容，一条一条给出你自己的判断：能不能提高你的 AI 水平。每标注一条，公开精选立刻按你的判断生效，同时这条判断会存进 selection_gold，作为校准门槛的人工样本。这里不调用任何模型，显示的评分是已经存下的那一次。"
      actions={<ButtonLink to="/admin/selectbench">SelectBench</ButtonLink>}
    >
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="学习轨内容" value={counts.items} hint="带 track:learning 标记的信源收进来的全部条目" />
        <Stat label="有评分" value={counts.scored} hint="只有评过分的才拿来标注" />
        <Stat label="已标注" value={counts.labelled} tone={counts.labelled ? "ok" : undefined} hint="校准建议 30–50 条" />
        <Stat label="待标注" value={counts.awaiting} tone={counts.awaiting ? "warn" : undefined} />
      </div>
      <Card
        title="标注"
        right={<FilterChips param="state" options={[{ value: "awaiting", label: "待标注", count: counts.awaiting }, { value: "labelled", label: "已标注", count: counts.labelled }, { value: "all", label: "全部", count: counts.scored }]} />}
        pad={false}
      >
        {rows.length ? (
          <div className="divide-y divide-line">
            {rows.map((row) => <LabelCard key={row.id} row={row} />)}
          </div>
        ) : (
          <EmptyLabeling counts={counts} state={state} />
        )}
      </Card>
      <Pager page={page} hasMore={rows.length === 50} />
      <p className="mt-4 text-[12.5px] leading-relaxed text-ink-4">
        校准办法：先在这里标 30–50 条，再跑 <code className="num">node --env-file=.env scripts/eval-selection.ts --export-gold</code> 导出金标集，
        用 <code className="num">--track learning</code> 在 40–90 之间扫描门槛，找 FP/FN 的拐点，然后把门槛定下来（见 docs/selection.md）。
        门槛只能用你在这里标注的样本校准：不用模型给自己打分，也不拿上游站点旧的精选当人工证据。
      </p>
    </AdminPage>
  );
}
