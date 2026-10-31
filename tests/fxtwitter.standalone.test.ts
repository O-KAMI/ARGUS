// FxTwitter is the free first layer for X accounts: its timeline page becomes the same candidates the
// paid search stored, reposts keep the original post, quotes keep their original, and replies stay out.
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { fetchFxSource } from "@aihot/backend/sources/x";

const now = Math.floor(Date.now() / 1000);
const own = {
  type: "status", id: "100", url: "https://x.com/bob/status/100", text: "My own post",
  author: { id: "2", name: "Bob", screen_name: "bob", avatar_url: "https://img.example/bob.jpg" },
  created_timestamp: now - 60,
};
const repost = {
  type: "status", id: "90", url: "https://x.com/alice/status/90", text: "Alice's post, reposted",
  author: { id: "1", name: "Alice", screen_name: "alice", avatar_url: "https://img.example/alice.jpg" },
  reposted_by: { id: "2", name: "Bob", screen_name: "bob" },
  created_timestamp: now - 120,
};
const quote = {
  type: "status", id: "80", url: "https://x.com/bob/status/80", text: "Quoting this",
  author: { id: "2", name: "Bob", screen_name: "bob" },
  created_timestamp: now - 180,
  quote: { type: "status", id: "70", url: "https://x.com/carol/status/70", text: "Original quoted",
    author: { id: "3", name: "Carol", screen_name: "carol" }, created_timestamp: now - 240 },
};
const reply = {
  type: "status", id: "60", url: "https://x.com/bob/status/60", text: "A reply",
  author: { id: "2", name: "Bob", screen_name: "bob" },
  replying_to: { screen_name: "alice", status: "50" },
  created_timestamp: now - 300,
};
const media = {
  type: "status", id: "40", url: "https://x.com/bob/status/40", text: "With media",
  author: { id: "2", name: "Bob", screen_name: "bob" },
  created_timestamp: now - 360,
  media: { all: [{ id: "1", type: "photo", url: "https://img.example/p.jpg", width: 1200, height: 800 }] },
};
const fixture = { code: 200, results: [own, repost, quote, reply, media], cursor: { top: null, bottom: null } };

let server: http.Server;
let base = "";
let hits = 0;
let flaky = false;
let paged: Record<string, typeof fixture> | null = null;
let requested: string[] = [];
let networkFailures = 0;
let networkHits: Record<string, number> = {};

const source = (publisherRole?: string) => ({
  id: "x-bob", name: "Bob", kind: "x_search" as const,
  config: { query: "from:bob -filter:replies", searchType: "Latest", provider: "fxtwitter", ...(publisherRole ? { publisherRole } : {}) },
  tier: "T2", participation_mode: "editorial" as const, first_party: false, interval_minutes: 30, enabled: true,
  cursor: null as null | { lastTweetId?: string; fxBacklog?: unknown }, fail_count: 0,
});

before(async () => {
  config.allowPrivateNetworkFetch = true;
  server = http.createServer((req, res) => {
    hits += 1;
    const cursor = new URL(req.url ?? "", "http://stub").searchParams.get("cursor") ?? "";
    requested.push(cursor);
    res.setHeader("content-type", "application/json");
    if ((networkHits[cursor] ?? 0) < networkFailures) {
      networkHits[cursor] = (networkHits[cursor] ?? 0) + 1;
      req.socket.destroy();
      return;
    }
    // The endpoint sometimes answers 404 for a page that exists; the adapter retries it.
    if (flaky && hits <= 2) {
      res.statusCode = 404;
      res.end(JSON.stringify({ code: 404, results: [], cursor: { top: null, bottom: null } }));
      return;
    }
    res.end(JSON.stringify(paged?.[cursor] ?? fixture));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address");
  base = `http://127.0.0.1:${address.port}`;
  config.fxTwitterBaseUrl = base;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("reposts keep the original post, quotes keep the quoted original, replies stay out", async () => {
  const read = await fetchFxSource(source() as never);
  const urls = read.candidates.map((c) => c.url);
  assert.ok(urls.includes("https://x.com/bob/status/100"), "own post");
  assert.ok(urls.includes("https://x.com/alice/status/90"), "reposted original");
  assert.ok(urls.includes("https://x.com/bob/status/80"), "quote post");
  assert.ok(urls.includes("https://x.com/bob/status/40"), "media post");
  assert.ok(!urls.includes("https://x.com/bob/status/60"), "a reply is not the account's timeline");
  assert.equal(read.lastId, "100");

  const reposted = read.candidates.find((c) => c.url.endsWith("/status/90"))!;
  assert.equal(reposted.author, "alice");
  assert.equal(reposted.xPost?.repostedBy?.handle, "bob", "the followed account is kept as the reposter");
  assert.equal(reposted.xPost?.authorName, "Alice");

  const quoted = read.candidates.find((c) => c.url.endsWith("/status/80"))!;
  assert.equal(quoted.xPost?.quoted?.handle, "carol");
  assert.match(quoted.bodyText ?? "", /Original quoted/);

  const withMedia = read.candidates.find((c) => c.url.endsWith("/status/40"))!;
  assert.equal(withMedia.media?.length, 1);
  assert.equal(withMedia.media?.[0]?.kind, "image");
});

test("a verified publisher keeps its own thread replies", async () => {
  const thread = { ...fixture, results: [{ ...reply, replying_to: { screen_name: "bob", status: "50" } }] };
  const original = fixture.results;
  fixture.results = thread.results as never;
  try {
    const read = await fetchFxSource(source("organization") as never);
    assert.equal(read.candidates.length, 1, "self-thread reply is part of the announcement");
  } finally {
    fixture.results = original as never;
  }
});

test("a 404 on a page that exists is retried before failing", async () => {
  flaky = true;
  hits = 0;
  try {
    const read = await fetchFxSource(source() as never);
    assert.ok(read.candidates.length > 0);
    assert.equal(hits, 3, "two 404s then the page");
  } finally {
    flaky = false;
  }
});

const post = (id: number, ageHours = 1) => ({ ...own, id: String(id), url: `https://x.com/bob/status/${id}`, created_timestamp: now - ageHours * 3600 });
const page = (ids: number[], next: string | null, ageHours = 1): typeof fixture => ({
  code: 200, results: ids.map((id) => post(id, ageHours)), cursor: { top: null, bottom: next },
} as unknown as typeof fixture);

test("a first import keeps its older cursor and finishes it on the next run without rereading pages", async () => {
  paged = {
    "": page([400, 390], "p2"),
    p2: page([380, 370], "p3"),
    p3: page([360, 350], "p4"),
    p4: page([340, 330], null),
  };
  requested = [];
  hits = 0;
  try {
    const firstSource = source();
    const first = await fetchFxSource(firstSource as never);
    assert.equal(first.candidates.length, 6, "the page budget bounds one run");
    assert.equal(first.pages, 3);
    assert.equal(first.truncated, true);
    assert.equal(first.fxBacklog?.[0]?.next, "p4");
    assert.equal(first.fxRequests, 3, "the free path has no receipts and counts only raw requests");
    assert.equal(first.receiptIds.length, 0);

    firstSource.cursor = { lastTweetId: first.lastId ?? undefined, fxBacklog: first.fxBacklog };
    const second = await fetchFxSource(firstSource as never);
    assert.equal(second.truncated, false);
    assert.equal(second.fxBacklog?.length, 0);
    assert.equal(second.pages, 1, "the newest page is still checked");
    assert.equal(second.backlogPages, 1, "the remaining budget advances the old stretch");
    assert.deepEqual(requested, ["", "p2", "p3", "", "p4"], "completed pages are not bought again");
  } finally {
    paged = null;
  }
});

test("retries consume one shared raw-request budget instead of multiplying the page bound", async () => {
  paged = { "": page([400, 390], "p2"), p2: page([380, 370], "p3"), p3: page([360, 350], "p4") };
  requested = [];
  hits = 0;
  networkFailures = 5;
  networkHits = {};
  try {
    const read = await fetchFxSource(source() as never);
    assert.equal(read.pages, 2, "each page needed six attempts, including network retries");
    assert.equal(read.fxRequests, 12);
    assert.equal(hits, 12);
    assert.deepEqual([...new Set(requested)], ["", "p2"], "no request is started after the budget is spent");
    assert.equal(read.fxBacklog?.[0]?.next, "p3");
  } finally {
    networkFailures = 0;
    paged = null;
  }
});

test("an outage hole is paged only until the old watermark is met", async () => {
  paged = { "": page([130, 120], "p2"), p2: page([110, 100], "unused") };
  requested = [];
  try {
    const withGap = source();
    withGap.cursor = { lastTweetId: "100" };
    const read = await fetchFxSource(withGap as never);
    assert.equal(read.pages, 2);
    assert.equal(read.backlogPages, 0);
    assert.equal(read.fxBacklog?.length, 0);
    assert.deepEqual(requested, ["", "p2"]);

    requested = [];
    paged[""] = page([100, 90], "unused");
    const covered = await fetchFxSource(withGap as never);
    assert.equal(covered.pages, 1, "a normal newest page does not backfill every run");
    assert.deepEqual(requested, [""]);
  } finally {
    paged = null;
  }
});

test("the first-import time floor stops older pages and excludes old non-reposts", async () => {
  paged = { "": page([200], "p2"), p2: page([190], "never", 24 * 8) };
  requested = [];
  try {
    const read = await fetchFxSource(source() as never);
    assert.equal(read.pages, 2);
    assert.deepEqual(read.candidates.map((c) => c.url), ["https://x.com/bob/status/200"]);
    assert.equal(read.fxBacklog?.length, 0, "crossing the time floor is a boundary, not a deferred backlog");
    assert.deepEqual(requested, ["", "p2"]);
  } finally {
    paged = null;
  }
});
