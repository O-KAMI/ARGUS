// The module's HTTP surface (方案 8 节): three public reads under /api/github, and the admin's refresh,
// status and classification override under /api/admin/github behind the engine's own sign-in. A manual
// refresh only enqueues; collection never runs inside an HTTP request.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sessionPrincipal, type AdminPrincipal } from "@aihot/backend/admin/auth";
import { enqueueOn } from "@aihot/backend/jobs/queue";
import { AI_CATEGORIES, BOARDS, PAGE_SIZES, type AiCategory, type BoardType } from "../contract.ts";
import { readBoard, readCategories, readRepository, readStatus, type BoardQuery } from "./api.ts";
import { githubRefreshQueue } from "./collect.ts";
import { setManualClassification } from "./store.ts";

const PUBLIC_CACHE = "public, max-age=60";
const MAX_KEYWORD = 100;

/** The engine's admin guard, in this module's own routes: a live session, and the CSRF token on writes. */
async function adminOf(req: FastifyRequest, reply: FastifyReply): Promise<AdminPrincipal | null> {
  reply.header("Cache-Control", "no-store");
  const principal = await sessionPrincipal(req.headers.cookie);
  if (!principal) {
    reply.code(401).send({ error: "unauthorized", detail: "先登录后台。" });
    return null;
  }
  if (req.method !== "GET" && req.method !== "HEAD" && req.headers["x-csrf-token"] !== principal.csrf) {
    reply.code(403).send({ error: "forbidden", detail: "CSRF token 缺失或已过期。" });
    return null;
  }
  return principal;
}

const badRequest = (reply: FastifyReply, detail: string) =>
  reply.code(400).header("Cache-Control", "no-store").send({ error: "invalid_request", detail });

const queryOf = (req: FastifyRequest): Record<string, string> => {
  const raw = (req.query ?? {}) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === "string").map(([k, v]) => [k, v as string]));
};

/** Reads the board and its filters; null when a parameter is not one this endpoint takes. */
function boardQuery(query: Record<string, string>): BoardQuery | null {
  const board = query.board;
  if (!board || !(BOARDS as readonly string[]).includes(board)) return null;
  const pageSize = Number.parseInt(query.pageSize ?? "20", 10);
  if (!Number.isFinite(pageSize) || !(PAGE_SIZES as readonly number[]).includes(pageSize)) return null;
  const page = Number.parseInt(query.page ?? "1", 10);
  if (!Number.isFinite(page) || page < 1 || page > 50) return null;
  const category = query.category;
  if (category && !(AI_CATEGORIES as readonly string[]).includes(category)) return null;
  const keyword = query.keyword?.trim().slice(0, MAX_KEYWORD) || null;
  return {
    board: board as BoardType,
    page,
    pageSize,
    language: query.language?.trim().slice(0, 60) || null,
    category: (category ?? null) as AiCategory | null,
    keyword,
  };
}

export function registerGithubRoutes(app: FastifyInstance): void {
  app.get("/api/github/rankings", async (req, reply) => {
    const parsed = boardQuery(queryOf(req));
    if (!parsed) return badRequest(reply, `board 只能是 ${BOARDS.join(" / ")}，pageSize 只能是 ${PAGE_SIZES.join(" / ")}。`);
    return reply.header("Cache-Control", PUBLIC_CACHE).send(await readBoard(parsed));
  });

  app.get("/api/github/categories", async (_req, reply) =>
    reply.header("Cache-Control", PUBLIC_CACHE).send(await readCategories()));

  app.get("/api/github/repositories/:repositoryId", async (req, reply) => {
    const id = Number.parseInt((req.params as { repositoryId: string }).repositoryId, 10);
    if (!Number.isFinite(id) || id <= 0) return badRequest(reply, "repositoryId 必须是一个正整数。");
    const detail = await readRepository(id);
    if (!detail) return reply.code(404).header("Cache-Control", "no-store").send({ error: "not_found", detail: "没有这个仓库。" });
    return reply.header("Cache-Control", PUBLIC_CACHE).send(detail);
  });

  app.get("/api/admin/github/status", async (req, reply) => {
    if (!(await adminOf(req, reply))) return reply;
    return reply.send(await readStatus());
  });

  // Only enqueues (方案 11.4 用例 5): the worker does the fetching, and a second press joins the same job.
  app.post("/api/admin/github/refresh", async (req, reply) => {
    const principal = await adminOf(req, reply);
    if (!principal) return reply;
    const id = await enqueueOn(githubRefreshQueue, { reason: `admin:${principal.name}` }, { singletonKey: "github-refresh" });
    return reply.code(202).send({ enqueued: id !== null, queue: githubRefreshQueue.name });
  });

  app.put("/api/admin/github/repositories/:repositoryId/classification", async (req, reply) => {
    if (!(await adminOf(req, reply))) return reply;
    const id = Number.parseInt((req.params as { repositoryId: string }).repositoryId, 10);
    if (!Number.isFinite(id) || id <= 0) return badRequest(reply, "repositoryId 必须是一个正整数。");
    const body = (req.body ?? {}) as { override?: unknown; primaryCategory?: unknown };
    const override = body.override;
    if (override !== null && override !== "include" && override !== "exclude") {
      return badRequest(reply, "override 只能是 include、exclude 或 null。");
    }
    const primaryCategory = typeof body.primaryCategory === "string" && (AI_CATEGORIES as readonly string[]).includes(body.primaryCategory)
      ? (body.primaryCategory as AiCategory)
      : null;
    if (override === "include" && !primaryCategory) return badRequest(reply, "手工纳入时要给出一个主分类。");
    const saved = await setManualClassification(id, override, primaryCategory);
    if (!saved) return reply.code(404).send({ error: "not_found", detail: "没有这个仓库。" });
    return reply.send({ repositoryId: id, override, primaryCategory });
  });
}
