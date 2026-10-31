// PRIVATE_ACCESS: reader pages and machine exits need a session; SSR reaches the api with INTERNAL_TOKEN.
// The env is set before the app (and its config) is imported, because the switch is read once at startup.
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";

const INTERNAL = "private-access-test-internal-token-0123456789";
process.env.PRIVATE_ACCESS = "true";
process.env.INTERNAL_TOKEN = INTERNAL;

const { buildApp } = await import("../apps/api/src/app.ts");
const { closeDb } = await import("@aihot/backend/db");
const { stopBoss } = await import("@aihot/backend/jobs/queue");
const app = await buildApp();
after(async () => {
  await app.close();
  await stopBoss();
  await closeDb();
});

test("private access admits only a session, the SSR token, or the public endpoints", async () => {
  for (const url of ["/api/site/timeline", "/api/v1/items", "/feed.xml", "/api/mcp", "/sitemap.xml", "/llms.txt"]) {
    const denied = await app.inject({ url, headers: url === "/api/mcp" ? { "content-type": "application/json" } : {} });
    assert.equal(denied.statusCode, 401, url);
    assert.match(String(denied.headers["cache-control"]), /no-store/, url);
  }

  for (const url of ["/api/health", "/api/auth/options", "/robots.txt", "/manifest.webmanifest", "/icon.png"]) {
    const allowed = await app.inject({ url });
    assert.equal(allowed.statusCode, 200, url);
  }

  const ssr = await app.inject({ url: "/api/site/timeline", headers: { "x-argus-internal": INTERNAL } });
  assert.equal(ssr.statusCode, 200, "the web process renders pages with the shared token");
  assert.equal(String(ssr.headers["cache-control"]), "private, no-store");

  const forged = await app.inject({ url: "/api/site/timeline", headers: { "x-argus-internal": `${INTERNAL}x` } });
  assert.equal(forged.statusCode, 401);
});
