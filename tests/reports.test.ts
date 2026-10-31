// Reports: a scheduled run that starts late still writes the issue it was due for, never one whose
// window is still open; a daily whose window nothing was judged in is refused rather than published as a
// quiet day; and an older weekly that froze no summaries shows the cited articles' public summaries.
import { editionAt, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { beijingAt } from "@aihot/contracts/time";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";
import { loadReport } from "@aihot/backend/publication/reports";
import { composeDaily, dueDaily, dueMonthly, dueWeekly } from "@aihot/backend/reports/compose";
import { SITE } from "@aihot/site";

const T = tag();
const SOURCE = `test-reports-${T}`;
const WEEK = "2098-W20";
/** A daily carries technical directions only, so a fixture report needs one of the pack's field tags. */
const FIELD_TAG = "Agent";
before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES (${SOURCE}, 'Reports', 'rss', 'T1', 'editorial', '2100-01-01')`;
});
after(async () => {
  await stopBoss();
  await closeDb();
});

async function reportItem(label: string, at: Date, selected = true): Promise<string> {
  const id = `reports-${tag()}-${label}`;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at)
    VALUES (${id}, ${SOURCE}, ${id}, ${`https://example.com/${id}`}, ${id}, ${at}, ${at})`;
  await sql`INSERT INTO publications (article_id, title, source_id, channel, url, discovered_at, timeline_at, sort_at, eligible, selected, visible_after, visibility, score, tags)
    VALUES (${id}, ${id}, ${SOURCE}, 'news', ${`https://example.com/${id}`}, ${at}, ${at}, ${at}, true, ${selected}, ${at}, 'public', ${selected ? 90 : 40}, ${[FIELD_TAG]})`;
  return id;
}

function citedIds(content: { sections?: Array<{ items?: Array<{ itemId: string }> }>; flashes?: Array<{ itemId: string }> }): Set<string> {
  return new Set([...(content.sections ?? []).flatMap((s) => s.items ?? []), ...(content.flashes ?? [])].map((i) => i.itemId));
}

test("a late run writes the issue that was due, not today's", () => {
  assert.equal(dueDaily(editionAt("daily", "2026-09-29", 6)), "2026-09-29");
  assert.equal(dueDaily(editionAt("daily", "2026-09-30", -60)), "2026-09-29", "the 29th's run delayed until just before the next issue");
  assert.equal(dueWeekly(editionAt("weekly", "2026-09-28")), "2026-W39");
  assert.equal(dueWeekly(editionAt("weekly", "2026-10-05", -60)), "2026-W39", "Monday before its edition time: the next week is not due yet");
  assert.equal(dueWeekly(editionAt("weekly", "2026-10-05", 60)), "2026-W40");
  assert.equal(dueMonthly(editionAt("monthly", "2026-10-01")), "2026-09");
  assert.equal(dueMonthly(editionAt("monthly", "2026-10-01", -60)), "2026-08");
  assert.equal(dueMonthly(editionAt("monthly", "2027-01-15")), "2026-12");
});

test("a daily with nothing judged in its window is refused, not published as a quiet day", async () => {
  const date = "2098-01-15";
  await assert.rejects(composeDaily(date), /nothing judged/);
  const [row] = await sql`SELECT 1 FROM reports WHERE kind = 'daily' AND key = ${date}`;
  assert.equal(row, undefined);
});

for (const date of ["2097-10-02", "2097-11-01", "2098-01-01"]) {
  test(`daily ${date} covers the preceding Beijing calendar day across its boundary`, async () => {
    const end = beijingAt(date, "00:00");
    const start = new Date(end.getTime() - 86400000);
    const before = await reportItem("before", new Date(start.getTime() - 1));
    const first = await reportItem("first", start);
    const last = await reportItem("last", new Date(end.getTime() - 1));
    const next = await reportItem("next", end);

    await composeDaily(date);
    const [row] = await sql<{ window_start: Date; window_end: Date; content: any }[]>`SELECT window_start, window_end, content FROM reports WHERE kind = 'daily' AND key = ${date}`;
    assert.equal(row!.window_start.toISOString(), start.toISOString());
    assert.equal(row!.window_end.toISOString(), end.toISOString());
    assert.deepEqual(citedIds(row!.content), new Set([first, last]));
    assert.equal(citedIds(row!.content).has(before), false);
    assert.equal(citedIds(row!.content).has(next), false);
    assert.match(row!.content.generator.version, /daily-beijing-natural-day-v1/);

    const detail = await loadReport("daily", date);
    assert.equal(detail?.windowStart, start.toISOString());
    assert.equal(detail?.windowEnd, end.toISOString());
  });
}

test("a judged but unselected natural-day window publishes a quiet issue with midnight wording", async () => {
  const date = "2097-10-10";
  const end = beijingAt(date, "00:00");
  await reportItem("quiet", new Date(end.getTime() - 3600_000), false);
  await composeDaily(date);
  const [row] = await sql<{ content: any }[]>`SELECT content FROM reports WHERE kind = 'daily' AND key = ${date}`;
  assert.equal(row!.content.metrics.totalEvents, 0);
  assert.equal(row!.content.generator.judgedReports, 1);
  assert.equal(row!.content.lead.title, "昨日安静，无大事发生");
  assert.match(row!.content.lead.leadParagraph, /10 月 9 日 00:00 至 10 月 10 日 00:00/);
});

test("the first natural-day issue suppresses the old issue's overlap without rewriting it or leaving a gap", async () => {
  const date = "2097-10-04";
  const previousKey = "2097-10-03";
  const start = new Date(beijingAt(date, "00:00").getTime() - 86400000);
  const end = beijingAt(date, "00:00");
  const oldStart = beijingAt("2097-10-02", "08:00");
  const oldEnd = beijingAt(previousKey, "08:00");
  const overlap = await reportItem("overlap", beijingAt(previousKey, "04:00"));
  const fresh = await reportItem("fresh", beijingAt(previousKey, "12:00"));
  const oldContent = {
    date: previousKey,
    leadItemId: overlap,
    lead: { title: "旧刊头条", leadParagraph: "旧刊导语" },
    highlights: [],
    sections: [{ label: "行业动态", items: [{ itemId: overlap, title: "旧刊头条" }] }],
    flashes: [],
    metrics: { totalEvents: 1 },
  };
  const generatedAt = new Date("2097-10-03T00:00:00.000Z");
  await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at)
    VALUES ('daily', ${previousKey}, ${oldStart}, ${oldEnd}, ${sql.json(oldContent as never)}, ${generatedAt})`;

  await composeDaily(date);
  const [current] = await sql<{ content: any; window_start: Date; window_end: Date }[]>`SELECT content, window_start, window_end FROM reports WHERE kind = 'daily' AND key = ${date}`;
  assert.equal(citedIds(current!.content).has(overlap), false, "the previous old-window issue suppresses the shared 00:00–08:00 event");
  assert.equal(citedIds(current!.content).has(fresh), true, "08:00–24:00 remains covered by the switch issue");
  assert.equal(current!.content.leadItemId, fresh, "the old issue's head does not lead again");
  assert.equal(current!.window_start.toISOString(), start.toISOString());
  assert.equal(current!.window_end.toISOString(), end.toISOString());
  assert.ok(oldEnd > start && oldStart < start, "the old and new windows overlap without a coverage gap");

  const [old] = await sql<{ content: any; window_start: Date; window_end: Date; generated_at: Date }[]>`SELECT content, window_start, window_end, generated_at FROM reports WHERE kind = 'daily' AND key = ${previousKey}`;
  assert.deepEqual(old!.content, oldContent);
  assert.equal(old!.window_start.toISOString(), oldStart.toISOString());
  assert.equal(old!.window_end.toISOString(), oldEnd.toISOString());
  assert.equal(old!.generated_at.toISOString(), generatedAt.toISOString());
});

test("automatic catch-up preserves an old issue; an explicit rerun revises it onto the natural-day window", async () => {
  const date = "2097-10-05";
  const id = await reportItem("rerun", beijingAt("2097-10-04", "12:00"));
  const oldStart = beijingAt("2097-10-04", "08:00");
  const oldEnd = beijingAt(date, "08:00");
  const oldContent = { date, sections: [], flashes: [], metrics: { totalEvents: 0 }, marker: "published-history" };
  await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at)
    VALUES ('daily', ${date}, ${oldStart}, ${oldEnd}, ${sql.json(oldContent as never)}, '2097-10-05T00:00:00Z')`;

  await composeDaily(date);
  const [untouched] = await sql<{ content: any; window_start: Date; window_end: Date }[]>`SELECT content, window_start, window_end FROM reports WHERE kind = 'daily' AND key = ${date}`;
  assert.deepEqual(untouched!.content, oldContent);
  assert.equal(untouched!.window_start.toISOString(), oldStart.toISOString());
  assert.equal(untouched!.window_end.toISOString(), oldEnd.toISOString());

  await composeDaily(date, "manual natural-day rerun");
  const [rerun] = await sql<{ content: any; revision: number; window_start: Date; window_end: Date }[]>`SELECT content, revision, window_start, window_end FROM reports WHERE kind = 'daily' AND key = ${date}`;
  assert.equal(rerun!.revision, 2);
  assert.equal(citedIds(rerun!.content).has(id), true);
  assert.equal(rerun!.window_start.toISOString(), beijingAt("2097-10-04", "00:00").toISOString());
  assert.equal(rerun!.window_end.toISOString(), beijingAt(date, "00:00").toISOString());
  const [revision] = await sql<{ content: any; reason: string }[]>`SELECT v.content, v.reason FROM report_revisions v JOIN reports r ON r.id = v.report_id WHERE r.kind = 'daily' AND r.key = ${date}`;
  assert.deepEqual(revision!.content, oldContent);
  assert.equal(revision!.reason, "manual natural-day rerun");
});

test("a weekly that froze no summaries shows the articles' public summaries", async () => {
  // Found, published and released a minute ago: a rolling window that ends at the reader's clock holds it.
  const minuteAgo = new Date(Date.now() - 60_000);
  const { articleId } = await upsertMaterial({ sourceId: SOURCE, url: `https://example.com/${T}`, title: `R ${T}`, bodyText: "b", bodyHtml: "<p>b</p>", bodyStatus: "ok", via: "fetch", publishedAt: minuteAgo, discoveredAt: minuteAgo });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected)
            VALUES (${articleId}, 1, 'rule', 'pass', 'industry', ${`标题-${T}`}, ${`公开摘要-${T}`}, 80, true)`;
  await publishArticle(articleId, { releasedAt: minuteAgo });
  const content = { kind: "weekly", title: `${SITE.name} 周报 · ${WEEK}`, overview: "o", themes: [{ heading: "h", summary: "s", storyRefs: [{ itemId: articleId, title: `标题-${T}`, sourceName: "Old aggregator", sourceId: "old-source", firstParty: false, sourceUrl: "https://example.com" }] }] };
  await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at, origin)
            VALUES ('weekly', ${WEEK}, now(), now(), ${sql.json(content as never)}, now(), 'imported')`;
  const report = await loadReport("weekly", WEEK);
  assert.equal(report?.sections[0]?.items[0]?.summary, `公开摘要-${T}`);
  assert.equal(report?.sections[0]?.items[0]?.sourceName, "Reports");
  assert.equal(report?.sections[0]?.items[0]?.firstParty, true, "a frozen citation cannot override verified current provenance");
  await sql`UPDATE sources SET tier = 'T1_5', first_party = true WHERE id = ${SOURCE}`;
  await publishArticle(articleId);
  assert.equal((await loadReport("weekly", WEEK))?.sections[0]?.items[0]?.firstParty, false);
});
