// Failure mode: the ranking numbers a screen reader reads. Ranks 4–10 are rows whose number carried
// `热度排名第 N 位`, but ranks 1–3 are cards that show `NO.01` and said nothing — so the same list
// announced its lower half and left the top three, the entries a reader most needs placed, unlabelled.
// No browser: the labels are server-rendered, and a Chromium here competes for CPU with the timing tests.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { HotEntryView, HotResponse } from "@aihot/contracts/site";
import { fakeApi, startWebServer, type WebServer } from "./web-server.ts";

const entry = (rank: number): HotEntryView => ({
  rank, story: { publicId: `s${rank}`, title: `热点 ${rank}` }, heat: 100 - rank, trend: "flat", trendPct: 0,
  badges: [], participantCount: 3, sourceCount: 2, sourceNames: ["甲媒体", "乙账号"], participants: [],
  spark: Array.from({ length: 24 }, (_, i) => i + rank), summary: "一句话摘要", latest: null, cover: null,
});

const hot: HotResponse = { computedAt: "2026-10-31T08:00:00.000Z", windowHours: 48, entries: [1, 2, 3, 4, 5].map(entry), announcements: [] };

test("every ranking number says which place it is, in the cards as well as the rows", async () => {
  const api = fakeApi((url) => (url.pathname === "/api/site/hot" ? hot : undefined));
  let web: WebServer | undefined;
  try {
    web = await startWebServer(api);
    const html = await (await fetch(`${web.origin}/hot`)).text();
    for (const rank of [1, 2, 3, 4, 5]) {
      assert.ok(html.includes(`aria-label="热度排名第 ${rank} 位"`), `rank ${rank}'s number is announced (ranks 1-3 are cards, not rows)`);
    }
    assert.equal(html.match(/热度排名第 \d+ 位/g)?.length, hot.entries.length, "one label per entry, none duplicated");
  } finally {
    await web?.stop();
  }
});
