// Local regression probe. Uses the built web server and an in-memory API. No site database or credentials.
// From the repository root: node docs/plans/audit-2026-11-04/reproduce-private-read.mjs
import { randomBytes } from "node:crypto";
import { request } from "node:http";
import { fakeApi, feedItem, startWebServer } from "../../../apps/web/tests/web-server.ts";

const token = randomBytes(32).toString("hex");
const sessionCookie = "audit_session=" + randomBytes(32).toString("hex");
const marker = "ARGUS_AUDIT_PRIVATE_CANARY";
const api = fakeApi((url, response, incoming) => {
  if (url.pathname === "/api/auth/check") {
    response.statusCode = incoming.headers.cookie === sessionCookie ? 204 : 401;
    return {};
  }
  if (incoming.headers["x-argus-internal"] !== token) {
    response.statusCode = 401;
    return {};
  }
  if (url.pathname === "/api/site/hot") {
    return { computedAt: null, windowHours: 48, entries: [], announcements: [feedItem({ id: "canary", title: marker })] };
  }
});
const web = await startWebServer(api, {
  WEB_HOST: "127.0.0.1", PRIVATE_ACCESS: "true", INTERNAL_TOKEN: token,
});
try {
  const cases = [
    { path: "/hot", signedIn: true },
    { path: "/hot", signedIn: false },
    { path: "/assets/%2e%2e/hot", signedIn: false },
    { path: "/admin/login/../../hot.data", signedIn: false },
  ];
  for (const { path, signedIn } of cases) {
    const result = await new Promise((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port: web.port, path, headers: signedIn ? { cookie: sessionCookie } : {} }, res => {
        let body = "";
        res.on("data", chunk => { body += chunk; });
        res.on("end", () => resolve({ path, signedIn, status: res.statusCode, privateContent: body.includes(marker) }));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end();
    });
    console.log(JSON.stringify(result));
    if (result.privateContent !== signedIn || (signedIn && result.status !== 200)) process.exitCode = 1;
  }
} finally {
  await web.stop();
}
