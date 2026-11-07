// Failure cases: an origin-form // path is read as a URL authority and throws a 500; an unknown
// double-slash path becomes a different host's root; HEAD or single-fetch data follows another rule.
// And the private reader boundary: an exempt prefix must not carry a request to a different resource.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdir } from "node:fs/promises";
import { request } from "node:http";
import { after, before, describe, test } from "node:test";
import { fakeApi, feedItem, startWebServer, type WebServer } from "./web-server.ts";

let web: WebServer;
const upstreamPaths: string[] = [];
const api = fakeApi((url, _res, req) => {
  upstreamPaths.push(req.url ?? "");
  if (url.pathname === "/api/site/timeline") return { cards: [], nextCursor: null, dayCounts: {}, hot: [], filters: { category: null, channel: null, tag: null } };
  if (url.pathname === "/api/site/hot") return { computedAt: null, windowHours: 48, entries: [], announcements: [] };
  if (url.pathname === "/api/site/topics") return { groups: [], topics: [] };
});

before(async () => { web = await startWebServer(api); });
after(() => web.stop());

function raw(path: string, method: "GET" | "HEAD" | "POST", opts: { port?: number; headers?: import("node:http").OutgoingHttpHeaders; body?: string } = {}) {
  return new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: opts.port ?? web.port, path, method, headers: opts.headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(opts.body);
  });
}

test("origin-form slashes keep the router's homepage and unknown-route semantics", async () => {
  for (const method of ["GET", "HEAD"] as const) {
    const home = await raw("/", method);
    assert.equal(home.status, 200, web.logs());
    for (const path of ["//", "////", "//?category=ai-models"]) {
      const res = await raw(path, method);
      assert.equal(res.status, 200, `${method} ${path}: ${web.logs()}`);
      assert.equal(res.headers["content-type"], home.headers["content-type"]);
      assert.match(res.headers["cache-control"] ?? "", /^public, max-age=\d+, s-maxage=\d+, must-revalidate$/);
      if (method === "HEAD") assert.equal(res.body, "");
    }
    for (const path of ["/unknown-page", "//unknown-page", "//evil.invalid/unknown-page", "//unknown-page.data?token=private"]) {
      const res = await raw(path, method);
      assert.equal(res.status, 404, `${method} ${path}: ${web.logs()}`);
      assert.equal(res.headers["cache-control"], "private, no-store");
      if (method === "HEAD") assert.equal(res.body, "");
    }
  }
  assert.equal(web.logs(), "");
  assert.ok(upstreamPaths.every((path) => path.startsWith("/api/site/")));
});

describe("private reader boundary", () => {
  const marker = "ARGUS_PRIVATE_CANARY";
  const token = randomBytes(32).toString("hex");
  const session = `audit_session=${randomBytes(32).toString("hex")}`;
  const ingestToken = randomBytes(24).toString("hex");
  const ingestCalls: Array<string | undefined> = [];
  let gated: WebServer;

  const api = fakeApi((url, res, req) => {
    if (url.pathname === "/api/auth/check") {
      res.statusCode = req.headers.cookie === session ? 204 : 401;
      return {};
    }
    if (url.pathname === "/api/ingest/items") {
      ingestCalls.push(req.headers.authorization);
      const ok = req.headers.authorization === `Bearer ${ingestToken}`;
      res.statusCode = ok ? 200 : 401;
      return ok ? { ok, marker } : { ok };
    }
    // The api exempts sign-in and health from its own session check, so they arrive without the SSR token.
    if (url.pathname === "/api/health" || url.pathname.startsWith("/api/auth/")) return {};
    if (req.headers["x-argus-internal"] !== token) { res.statusCode = 401; return {}; }
    if (url.pathname === "/api/site/timeline") return { cards: [], nextCursor: null, dayCounts: {}, hot: [], filters: { category: null, channel: null, tag: null } };
    if (url.pathname === "/api/site/hot") return { computedAt: null, windowHours: 48, entries: [], announcements: [feedItem({ id: "canary", title: marker })] };
    if (url.pathname === "/api/site/topics") return { groups: [], topics: [] };
  });

  before(async () => { gated = await startWebServer(api, { PRIVATE_ACCESS: "true", INTERNAL_TOKEN: token }); });
  after(() => gated.stop());

  const read = (path: string, headers: import("node:http").OutgoingHttpHeaders = {}) =>
    raw(path, "GET", { port: gated.port, headers });

  test("an exempt prefix never carries an anonymous reader to another resource", async () => {
    // Each of these matched an exempt prefix as a raw string while the router resolved it to /hot.
    for (const path of [
      "/assets/%2e%2e/hot", "/assets/../hot", "/assets/%2e%2e%2fhot", "/assets/..%2Fhot",
      "/admin/login/../../hot.data", "/admin/login/../hot", "/%2e%2e/hot", "/./hot",
      "/robots.txt/../hot", "/api/auth/../site/hot", "/api/health/../site/hot", "/assets/%2e%2e/hot.data",
    ]) {
      const res = await read(path);
      assert.ok([302, 400, 401, 404].includes(res.status), `${path} answered ${res.status}`);
      assert.ok(!res.body.includes(marker), `${path} leaked private content`);
    }
    assert.equal((await read("/hot")).status, 302);
    assert.equal((await read("/hot.data")).status, 401);
    assert.ok(!(await read("/hot.data")).body.includes(marker));
  });

  test("a build asset that matches no file is a 404, not a rendered page", async () => {
    for (const path of ["/assets/no-such-asset.js", "/assets/no-such-asset.data", "/assets/no-such-asset.js.data"]) {
      const res = await read(path);
      assert.equal(res.status, 404, path);
      assert.ok(!res.body.includes(marker), path);
    }
    const [asset] = await readdir(new URL("../build/client/assets/", import.meta.url));
    const served = await read(`/assets/${asset}`);
    assert.equal(served.status, 200, "a real build asset stays reachable without a session");
  });

  test("sign-in and health stay reachable, and a signed-in reader still gets the page and its data", async () => {
    assert.equal((await read("/admin/login")).status, 200);
    assert.equal((await read("/api/health")).status, 200);
    for (const path of ["/hot", "/hot.data"]) {
      const res = await read(path, { cookie: session });
      assert.equal(res.status, 200, `${path}: ${gated.logs()}`);
      assert.ok(res.body.includes(marker), `${path} lost its private content`);
    }
  });

  test("the ingest push is forwarded to the api's own Bearer check, never to the reader gate", async () => {
    const push = (headers: import("node:http").OutgoingHttpHeaders) =>
      raw("/api/ingest/items", "POST", { port: gated.port, headers: { "content-type": "application/json", ...headers }, body: '{"items":[]}' });

    const accepted = await push({ authorization: `Bearer ${ingestToken}` });
    assert.equal(accepted.status, 200);
    assert.ok(accepted.body.includes(marker), "the api's ingest handler answered");

    for (const headers of [{ authorization: "Bearer wrong" }, {}, { cookie: session }]) {
      const res = await push(headers);
      assert.equal(res.status, 401, `the api refuses, the web process must not redirect: ${JSON.stringify(headers)}`);
      assert.ok(!res.body.includes(marker));
    }
    assert.equal(ingestCalls.length, 4, "every push reached the api handler");
  });

  test("a misspelled private switch refuses to start instead of publishing the site", async () => {
    const outcome = await startWebServer(fakeApi(), { PRIVATE_ACCESS: "ture", INTERNAL_TOKEN: token })
      .then((server) => ({ server }), (error: unknown) => ({ error: String(error) }));
    if ("server" in outcome) {
      await outcome.server.stop();
      assert.fail("a misspelled PRIVATE_ACCESS started the site");
    }
    assert.match(outcome.error, /PRIVATE_ACCESS must be true or false/);
  });
});
