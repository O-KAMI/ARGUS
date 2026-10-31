import { gate, tag } from "./setup.ts";
// A daily carries technical directions only, and a selected item released across its midnight cutoff
// must appear in the next issue exactly once.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { beijingAt } from "@aihot/contracts/time";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle, publishArticleTx } from "@aihot/backend/publication/publish";
import { composeDaily } from "@aihot/backend/reports/compose";
import { candidates, countNonTechnicalCandidates } from "@aihot/backend/reports/edition";

const T = tag();
const SOURCE = `test-report-boundary-${T}`;
const dailyAt = (date: string, seconds = 0) => new Date(beijingAt(date, "00:00").getTime() + seconds * 1000);
/** A daily carries technical directions only, so a fixture report needs one of the pack's field tags. */
const FIELD_TAG = "Agent";

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at)
            VALUES (${SOURCE}, 'Report boundary test', 'rss', 'T1', 'editorial', '2100-01-01')`;
});
after(async () => {
  await stopBoss();
  await closeDb();
});

async function analyzed(label: string, timelineAt: Date, tags: string[] = [FIELD_TAG]): Promise<string> {
  const { articleId, backfill } = await upsertMaterial({
    sourceId: SOURCE,
    url: `https://example.com/report-boundary-${T}-${label}`,
    title: `Report boundary ${label}`,
    bodyText: `Report boundary ${label} body`,
    bodyStatus: "ok",
    publishedAt: timelineAt,
    discoveredAt: timelineAt,
    via: "fetch",
  });
  assert.equal(backfill, false);
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, tags, title_zh, summary_zh, score, selected)
            VALUES (${articleId}, 1, 'rule', 'pass', 'ai-models', ${tags}, ${`标题 ${label}`}, ${`摘要 ${label}`}, 90, true)`;
  return articleId;
}

async function selected(label: string, timelineAt: Date, releasedAt: Date, tags?: string[]): Promise<string> {
  const articleId = await analyzed(label, timelineAt, tags);
  const published = await publishArticle(articleId, { now: releasedAt, releasedAt });
  assert.equal(published?.selected, true);
  return articleId;
}

test("a daily carries technical directions only, and what the rule kept out is counted", async () => {
  const date = "2020-06-02";
  const start = dailyAt("2020-06-01");
  const end = dailyAt(date);
  const noon = dailyAt("2020-06-01", 12 * 3600);
  const technical = await selected("technical", noon, noon);
  const governance = await selected("governance", noon, noon, ["政策/监管"]);

  const found = new Set((await candidates(start, end)).map((c) => c.itemId));
  assert.equal(found.has(technical), true, "a selected public report carrying a technical-direction tag is a candidate");
  assert.equal(found.has(governance), false, "a selected public report with no technical direction is not");
  assert.equal(await countNonTechnicalCandidates(start, end), 1, "the rule kept it out of a period it is otherwise in, not an empty query");

  await composeDaily(date);
  const [issue] = await sql<{ content: { sections: Array<{ items: Array<{ itemId: string }> }>; flashes: Array<{ itemId: string }> } }[]>`
    SELECT content FROM reports WHERE kind = 'daily' AND key = ${date}`;
  const cited = new Set([...issue!.content.sections.flatMap((s) => s.items), ...issue!.content.flashes].map((i) => i.itemId));
  assert.deepEqual(cited, new Set([technical]));
});

test("reports assign delayed and boundary releases to the period readers first see them", async () => {
  const onTime = await selected("on-time", dailyAt("2020-01-02", -120), dailyAt("2020-01-02", -60));
  const delayed = await selected("delayed", dailyAt("2020-01-02", -60), dailyAt("2020-01-02", 120));
  const atBoundary = await selected("at-boundary", dailyAt("2020-01-02", -60), dailyAt("2020-01-02"));
  const groupedBefore = await analyzed("grouped-before", dailyAt("2020-01-02", -120));
  await publishArticle(groupedBefore, { now: dailyAt("2020-01-02", -120) });
  await sql`UPDATE articles SET grouping_status = 'complete', grouped_at = ${dailyAt("2020-01-02", -60)} WHERE id = ${groupedBefore}`;
  await publishArticle(groupedBefore, { now: dailyAt("2020-01-02", -50) });
  const groupedLate = await analyzed("grouped-late", dailyAt("2020-01-02", -120));
  await publishArticle(groupedLate, { now: dailyAt("2020-01-02", -120) }); // waits for identity confirmation
  await sql`UPDATE articles SET grouping_status = 'complete', grouped_at = ${dailyAt("2020-01-02", -10)} WHERE id = ${groupedLate}`;
  const boundary = dailyAt("2020-01-02");
  const previous = new Set((await candidates(dailyAt("2020-01-01"), boundary)).map((c) => c.itemId));

  assert.equal(previous.has(onTime), true);
  assert.equal(previous.has(groupedBefore), true);
  for (const id of [delayed, atBoundary, groupedLate]) assert.equal(previous.has(id), false);

  await composeDaily("2020-01-02");
  await publishArticle(groupedLate, { now: dailyAt("2020-01-02", 10) });
  const [release] = await sql<{ visible_after: Date }[]>`SELECT visible_after FROM publications WHERE article_id = ${groupedLate}`;
  assert.equal(release!.visible_after.toISOString(), dailyAt("2020-01-02", 10).toISOString());
  const next = new Set((await candidates(boundary, dailyAt("2020-01-03"))).map((c) => c.itemId));
  assert.equal(next.has(onTime), false);
  assert.equal(next.has(groupedBefore), false);
  for (const id of [delayed, atBoundary, groupedLate]) assert.equal(next.has(id), true);
  await composeDaily("2020-01-03");
  const reports = await sql<{ key: string; content: { sections: Array<{ items: Array<{ itemId: string }> }>; flashes: Array<{ itemId: string }> } }[]>`
    SELECT key, content FROM reports WHERE kind = 'daily' AND key IN ('2020-01-02', '2020-01-03')`;
  // An issue carries an item as an entry or as a flash (one source fills at most two entries).
  const items = (key: string) => {
    const content = reports.find((r) => r.key === key)!.content;
    return new Set([...content.sections.flatMap((s) => s.items), ...content.flashes].map((i) => i.itemId));
  };
  assert.equal(items("2020-01-02").has(onTime), true);
  assert.equal(items("2020-01-02").has(groupedBefore), true);
  assert.equal(items("2020-01-02").has(delayed), false);
  assert.equal(items("2020-01-02").has(atBoundary), false);
  assert.equal(items("2020-01-02").has(groupedLate), false);
  assert.equal(items("2020-01-03").has(onTime), false);
  assert.equal(items("2020-01-03").has(groupedBefore), false);
  assert.equal(items("2020-01-03").has(delayed), true);
  assert.equal(items("2020-01-03").has(atBoundary), true);
  assert.equal(items("2020-01-03").has(groupedLate), true);
});

/** Observe an actual PostgreSQL lock wait before advancing the clock or releasing the transaction. */
async function waitForBlocked(blocker: number, operation: Promise<unknown>) {
  const deadline = performance.now() + 5_000;
  while (!(await sql`SELECT 1 FROM pg_stat_activity WHERE ${blocker} = ANY(pg_blocking_pids(pid))`)[0]) {
    if (performance.now() >= deadline) assert.fail("operation did not wait for the held transaction");
    await Promise.race([operation.then(() => assert.fail("operation finished before the held transaction committed")), delay(10)]);
  }
}

for (const lock of ["article", "fact seat", "report snapshot"] as const) {
  test(`a release waiting for the ${lock} lock uses the time after the cutoff`, async (t) => {
    const id = await analyzed(`waiting-${lock}`, dailyAt("2020-01-02", -120));
    await publishArticle(id, { now: dailyAt("2020-01-02", -120) });
    await sql`UPDATE articles SET grouping_status = 'complete', grouped_at = ${dailyAt("2020-01-02", -60)} WHERE id = ${id}`;
    const [fact] = lock === "fact seat" ? await sql<{ id: number }[]>`INSERT INTO facts (public_id, title) VALUES (${`report-seat-${T}`}, 'fact') RETURNING id` : [];
    if (fact) await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact.id}, ${id}, 'report')`;
    const acquired = gate<number>();
    const release = gate();
    const holding = sql.begin(async (tx) => {
      if (lock === "article") await tx`SELECT 1 FROM articles WHERE id = ${id} FOR UPDATE`;
      else if (fact) await tx`SELECT pg_advisory_xact_lock(hashtext(${`seat:${fact.id}`}))`;
      else await tx`SELECT pg_advisory_xact_lock(hashtext('report_candidates'))`;
      const [row] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      acquired.open(row!.pid);
      await release.promise;
    });
    let publication: Promise<unknown> | undefined;
    try {
      const pid = await Promise.race([acquired.promise, holding.then(() => assert.fail("lock holder exited before acquiring its lock"))]);
      t.mock.timers.enable({ apis: ["Date"], now: dailyAt("2020-01-02", -1) });
      publication = publishArticle(id);
      await waitForBlocked(pid, publication);
      t.mock.timers.setTime(dailyAt("2020-01-02", 10).getTime());
      release.open();
      await holding;
      await publication;

      const [published] = await sql<{ visible_after: Date; visible_at: Date }[]>`
        SELECT p.visible_after, l.visible_at FROM publications p JOIN selected_ledger l ON l.article_id = p.article_id
        WHERE p.article_id = ${id} ORDER BY l.seq DESC LIMIT 1`;
      assert.equal(published!.visible_after.toISOString(), dailyAt("2020-01-02", 10).toISOString());
      assert.equal(published!.visible_at.toISOString(), published!.visible_after.toISOString());
      const boundary = dailyAt("2020-01-02");
      assert.equal((await candidates(dailyAt("2020-01-01"), boundary)).some((c) => c.itemId === id), false);
      assert.equal((await candidates(boundary, dailyAt("2020-01-03"))).some((c) => c.itemId === id), true);
    } finally {
      release.open();
      await Promise.allSettled([holding, publication]);
    }
  });
}

test("daily composition waits for a pre-cutoff release to commit instead of losing it between issues", async (t) => {
  const id = await analyzed("commit-after-cutoff", dailyAt("2020-01-04", -120));
  await publishArticle(id, { now: dailyAt("2020-01-04", -120) });
  await sql`UPDATE articles SET grouping_status = 'complete', grouped_at = ${dailyAt("2020-01-04", -60)} WHERE id = ${id}`;
  t.mock.timers.enable({ apis: ["Date"], now: dailyAt("2020-01-04", -1) });
  const written = gate<number>();
  const commit = gate();
  const publication = sql.begin(async (tx) => {
    await publishArticleTx(tx, id);
    const [row] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    written.open(row!.pid);
    await commit.promise;
  });
  let report: ReturnType<typeof composeDaily> | undefined;
  try {
    const pid = await Promise.race([written.promise, publication.then(() => assert.fail("publication exited before the commit gate"))]);
    t.mock.timers.setTime(dailyAt("2020-01-04", 10).getTime());
    report = composeDaily("2020-01-04");
    await waitForBlocked(pid, report);
    commit.open();
    await publication;
    await report;
    await assert.rejects(composeDaily("2020-01-05"), /nothing judged/);
    const reports = await sql<{ key: string; content: { sections: Array<{ items: Array<{ itemId: string }> }> } }[]>`
      SELECT key, content FROM reports WHERE kind = 'daily' AND key IN ('2020-01-04', '2020-01-05')`;
    const hasItem = (key: string) => reports.find((r) => r.key === key)!.content.sections.some((s) => s.items.some((item) => item.itemId === id));
    assert.equal(hasItem("2020-01-04"), true);
    assert.equal(reports.some((r) => r.key === "2020-01-05"), false);
    assert.equal((await candidates(dailyAt("2020-01-04"), dailyAt("2020-01-05"))).some((c) => c.itemId === id), false);
  } finally {
    commit.open();
    await Promise.allSettled([publication, report]);
  }
});
