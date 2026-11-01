// Failure mode: a report mirrored from another catalogue carries that catalogue's own Chinese copy and its
// own number, and no model of this site was ever called for it — yet the card said AI 评分 and the page
// said AI 导读, which claims both as this site's judgement.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import { fakeApi, itemDetail, startWebServer, visit, type WebServer } from "./web-server.ts";

test("a mirrored report says the copy and the number are the catalogue's own", async () => {
  const api = fakeApi((url) => {
    if (url.pathname === "/api/site/items/mirrored") {
      return itemDetail({ id: "mirrored", title: "镜像的一条", platform: "aihot", source: { name: "行业镜像" }, body: null, markdownAvailable: false });
    }
    if (url.pathname === "/api/site/items/own") return itemDetail({ id: "own", title: "本站的一条" });
  });
  const browser = await chromium.launch({ channel: "chromium" });
  let web: WebServer | undefined;
  try {
    web = await startWebServer(api);
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    const read = async (id: string) => {
      await visit(page, `${web!.origin}/items/${id}`);
      return page.locator("body").innerText();
    };

    const mirrored = await read("mirrored");
    assert.match(mirrored, /镜像评分/, "the number is the catalogue's own, and the page says so");
    assert.doesNotMatch(mirrored, /AI 评分/, "no model of this site scored it");
    assert.doesNotMatch(mirrored, /AI 导读/, "the Chinese summary is copied as it was read, not written here");
    assert.match(mirrored, /这条来自行业镜像/, "the page states what this site mirrors and what it does not fetch");

    const own = await read("own");
    assert.match(own, /AI 评分/, "a report of this site's own keeps the score's name");
    assert.match(own, /AI 导读/, "and so keeps its digest");
    assert.doesNotMatch(own, /这条来自行业镜像/);
  } finally {
    await browser.close();
    await web?.stop();
  }
});
