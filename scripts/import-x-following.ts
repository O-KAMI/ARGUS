// Imports the X accounts someone follows as x_search sources, one per account. SocialData is paid per
// returned user and per search; the script prints the counts and inserts nothing until the first page is read.
//   node --env-file=.env scripts/import-x-following.ts --user <user_id|@handle> [--dry-run] [--limit N] [--hot-signal]
// SOCIALDATA_API_KEY must be in the backend environment. Duplicate handles are skipped; existing sources are
// never overwritten.
import { closeDb, sql } from "@aihot/backend/db";
import { guardedFetch } from "@aihot/backend/lib/http-fetch";

const args = process.argv.slice(2);
const valueOf = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const userArg = valueOf("--user")?.replace(/^@/, "").trim();
const dryRun = args.includes("--dry-run");
const limit = Number(valueOf("--limit") ?? 0);
const hotSignal = args.includes("--hot-signal");
const apiKey = process.env.SOCIALDATA_API_KEY;
const base = (process.env.SOCIALDATA_BASE_URL ?? "https://api.socialdata.tools").replace(/\/$/, "");

if (!userArg) {
  console.error("用法：node --env-file=.env scripts/import-x-following.ts --user <X 数字 ID 或 @handle> [--dry-run] [--limit N] [--hot-signal]");
  process.exit(1);
}
if (!apiKey) {
  console.error("缺少 SOCIALDATA_API_KEY：先把它写进 .env，再运行本脚本。");
  process.exit(1);
}

// SocialData rejects every request on a zero balance, including the free 3/minute. Check before
// reading anything, so a misconfigured key fails fast instead of producing a wall of 402s.
const balance = await guardedFetch(`${base}/user/balance`, {
  headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
  timeoutMs: 15_000,
  maxBytes: 64 * 1024,
  route: "direct",
});
const balanceBody = balance.status >= 200 && balance.status < 300
  ? JSON.parse(balance.text()) as { balance_usd?: number }
  : null;
if (typeof balanceBody?.balance_usd === "number" && balanceBody.balance_usd <= 0) {
  console.error(`SocialData 余额为 ${balanceBody.balance_usd}；余额必须为正才能导入。`);
  process.exit(1);
}
const [budget] = await sql<{ per_minute: number }[]>`SELECT per_minute FROM budgets WHERE service = 'socialdata'`;
if (!budget || budget.per_minute <= 0) {
  console.error("SocialData 预算为 0（当前禁止计费）；先确认是否接受按量计费，再调整 budgets.socialdata.per_minute。");
  process.exit(1);
}

interface SdUser {
  id?: number;
  id_str?: string;
  screen_name: string;
  name?: string;
}

// The runtime budget only covers backend calls. This script talks to SocialData directly, so it
// throttles itself to the same 3 requests/minute and never crosses into billable requests.
let lastCall = 0;
async function api<T>(path: string): Promise<T> {
  const wait = 20_000 - (Date.now() - lastCall);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastCall = Date.now();
  const res = await guardedFetch(`${base}${path}`, {
    headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
    timeoutMs: 30_000,
    maxBytes: 8 * 1024 * 1024,
    route: "direct",
  });
  const text = res.text();
  if (res.status < 200 || res.status >= 300) throw new Error(`SocialData ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as T;
}

/** A numeric id is used as is; a handle is resolved through the user lookup, then a recent post. */
async function resolveUserId(input: string): Promise<string> {
  if (/^\d+$/.test(input)) return input;
  try {
    const user = await api<SdUser>(`/twitter/user/${encodeURIComponent(input)}`);
    if (user.id_str ?? user.id) return String(user.id_str ?? user.id);
  } catch {
    // Older deployments of the API only expose search; fall through to the post author.
  }
  const search = await api<{ tweets?: Array<{ user?: SdUser }> }>(`/twitter/search?${new URLSearchParams({ query: `from:${input}`, type: "Latest" })}`);
  const found = search.tweets?.find((t) => t.user?.screen_name?.toLowerCase() === input.toLowerCase())?.user;
  if (!found) throw new Error(`找不到 @${input} 的用户 ID；请直接传 X 数字 ID（可用 SocialData 或第三方查询）。`);
  const id = found.id_str ?? found.id;
  if (id === undefined) throw new Error(`SocialData 没有返回 @${input} 的数字 ID。`);
  return String(id);
}

function sourceId(handle: string): string {
  // X handles allow [A-Za-z0-9_]; source ids allow [a-z0-9-]. A hyphen never appears in a handle, so
  // replacing underscores keeps two different handles apart.
  return `x-${handle.toLowerCase().replace(/_/g, "-")}`;
}

const userId = await resolveUserId(userArg);
console.log(`读取用户 ${userId} 的关注列表${dryRun ? "（试运行，不写入）" : ""}…`);

const users: SdUser[] = [];
let cursor: string | null = null;
for (;;) {
  const page: { users?: SdUser[]; next_cursor?: string | null } = await api(
    `/twitter/user/${encodeURIComponent(userId)}/following${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
  );
  users.push(...(page.users ?? []));
  cursor = page.next_cursor ?? null;
  if (!cursor || (limit > 0 && users.length >= limit)) break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
const chosen = limit > 0 ? users.slice(0, limit) : users;
console.log(`关注 ${users.length} 个账号，本次处理 ${chosen.length} 个。`);

let added = 0;
let skipped = 0;
for (const user of chosen) {
  const handle = String(user.screen_name ?? "").trim();
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
    skipped += 1;
    continue;
  }
  const id = sourceId(handle);
  const name = user.name ? `${user.name} (@${handle})` : `X · @${handle}`;
  const config = { query: `from:${handle} -filter:replies`, searchType: "Latest", provider: "fxtwitter" };
  if (dryRun) {
    console.log(`将创建 ${id}  ${name}`);
    added += 1;
    continue;
  }
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO sources (id, name, kind, config, tier, first_party, owner_entity_id, participation_mode, interval_minutes, tags, site_fulltext, syndicate_fulltext, enabled, next_fetch_at)
    VALUES (${id}, ${name}, 'x_search', ${sql.json(config as never)}, 'T2', false, null,
            ${hotSignal ? "hot_signal" : "editorial"}, 360, ${["X"]}, false, false, true, now())
    ON CONFLICT (id) DO NOTHING RETURNING id`;
  if (row) added += 1;
  else skipped += 1;
}
console.log(`${dryRun ? "将创建" : "已创建"} ${added} 个 X 信源，跳过 ${skipped} 个（已存在或用户名无效）。`);
if (added > 0) console.log("worker 会按抓取间隔自动开始；要立刻抓一轮，可在后台“信源”页点试抓。");
await closeDb();
