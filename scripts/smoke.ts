// Opens the site's main pages and machine exits and checks each answers: the whole-site check after a
// deploy, and CI's check of the built site on an empty database.
//   node scripts/smoke.ts [--base http://localhost:3000] [--access public|private]
// A private site answers an anonymous reader with the sign-in wall, not with content; --access says which
// of the two contracts to hold it to, and defaults to what PRIVATE_ACCESS configured.
import { privateAccessFromEnv } from "@aihot/contracts/private-access";
import { SITE } from "@aihot/site";

function option(name: string): string | null {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] ?? null : null;
}
const base = option("--base") ?? process.env.SITE_URL ?? "http://localhost:3000";
// A private deployment (PRIVATE_ACCESS=true) needs a reader session: pass its Cookie header.
const cookie = process.env.SMOKE_COOKIE?.trim() || null;
const access = option("--access") ?? (privateAccessFromEnv(process.env.PRIVATE_ACCESS) ? "private" : "public");
if (access !== "public" && access !== "private") throw new Error("--access must be public or private");
/** Anonymous and private: the wall answers, so only the endpoints that carry no reader content may pass. */
const walls = access === "private" && !cookie;

const PAGES = ["/", "/all", "/hot", "/daily", "/daily/archive", "/topics", "/starred", "/agent", "/about", "/changelog", "/feedback", "/terms", "/privacy", "/more", "/github", "/admin/login"];
const MACHINE: Array<[path: string, type: RegExp]> = [
  ["/api/health", /json/],
  ["/api/v1/items", /json/],
  ["/api/v1/hot-topics", /json/],
  ["/api/v1/selected/snapshot", /json/],
  ["/api/github/rankings?board=all_weekly", /json/],
  ["/api/github/rankings?board=all_stars", /json/],
  ["/api/github/rankings?board=ai_weekly", /json/],
  ["/api/github/rankings?board=ai_stars", /json/],
  ["/feed.xml", /xml/],
  ["/feed/all.xml", /xml/],
  ["/llms.txt", /text\/plain/],
  ["/robots.txt", /text\/plain/],
  ["/sitemap.xml", /xml/],
  ["/manifest.webmanifest", /manifest/],
  ["/openapi-v1.json", /json/],
  ["/og/site.png", /image\/png/],
  ["/icon.png", /image\/png/],
  ["/favicon.ico", /icon/],
];
/** The web process lets these through without a session; they carry no reader content. */
const OPEN_WITHOUT_SESSION = new Set(["/api/health", "/robots.txt", "/manifest.webmanifest", "/icon.png", "/favicon.ico", "/admin/login"]);

let failed = 0;
/** The sign-in wall: a redirect to the login page, or the api's own 401. Never a body with content. */
function isWall(res: Response, body: string): boolean {
  if (res.status === 401) return true;
  return res.status === 302 && (res.headers.get("location") ?? "").startsWith("/admin/login") && body === "";
}
async function check(path: string, expect: (res: Response, body: string) => string | null) {
  try {
    const res = await fetch(base + path, { redirect: "manual", headers: cookie ? { cookie } : undefined, signal: AbortSignal.timeout(30_000) });
    const body = res.headers.get("content-type")?.startsWith("image/") ? "" : await res.text();
    const problem = walls && !OPEN_WITHOUT_SESSION.has(path)
      ? (isWall(res, body) ? null : `expected the sign-in wall, got HTTP ${res.status}`)
      : res.status !== 200 ? `HTTP ${res.status}` : expect(res, body);
    console.log(`${problem ? "✗" : "✓"} ${path}${problem ? `  ${problem}` : ""}`);
    if (problem) failed += 1;
  } catch (error) {
    console.log(`✗ ${path}  ${String(error)}`);
    failed += 1;
  }
}

// Pages write the name as HTML text: a name such as "MyF&B" appears as "MyF&amp;B".
const htmlName = SITE.name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
for (const path of PAGES) {
  // A signed-in smoke run is sent from the sign-in page to where it was headed; that page is only for visitors without a session.
  if (path === "/admin/login" && cookie) continue;
  await check(path, (_res, body) => (body.includes(SITE.name) || body.includes(htmlName) ? null : `the page does not name ${SITE.name}`));
}
for (const [path, type] of MACHINE) await check(path, (res) => (type.test(res.headers.get("content-type") ?? "") ? null : `content-type ${res.headers.get("content-type")}`));
// MCP: the handshake answers with the site's server name; an anonymous reader on a private site gets the wall.
const mcpRes = await fetch(`${base}/api/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(cookie ? { cookie } : {}) },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } }),
  redirect: "manual",
}).catch(() => null);
const mcp = mcpRes ? await mcpRes.text() : "unreachable";
const mcpOk = walls ? (mcpRes !== null && isWall(mcpRes, mcp)) : mcp.includes(`"name":"${SITE.mcpPrefix}"`);
console.log(`${mcpOk ? "✓" : "✗"} /api/mcp initialize${mcpOk ? "" : `  ${mcp.slice(0, 200)}`}`);
if (!mcpOk) failed += 1;

console.log(`\n${access} access, ${cookie ? "signed in" : "anonymous"}`);
console.log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);
