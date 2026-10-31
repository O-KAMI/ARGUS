// Reader-side privacy gate: when PRIVATE_ACCESS=true every public read (pages, RSS, API, MCP, media)
// needs the signed-in session. The web process renders pages with INTERNAL_TOKEN instead of a cookie.
// Admin and sign-in endpoints keep their own guards; health stays open for probes.
import type { FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { config } from "@aihot/backend/config";
import { sessionPrincipal } from "@aihot/backend/admin/auth";
import { sendProblem } from "./http/respond.ts";

const PUBLIC_ASSET = /^\/(?:robots\.txt|manifest\.webmanifest|favicon\.ico|favicon\.svg|icon\.png|icon-192\.png|apple-icon\.png)$/;

const OWN_GUARD = [
  /^\/api\/auth\//,
  /^\/api\/admin\//,
  /^\/api\/health$/,
  /^\/api\/ingest\//,
  // Brand and install assets carry no reader content and are needed on the sign-in page.
  /^\/(?:robots\.txt|manifest\.webmanifest|favicon\.ico|favicon\.svg|icon\.png|icon-192\.png|apple-icon\.png)$/,
];

function internalRequest(header: string | undefined): boolean {
  const expected = config.internalToken;
  if (!expected || expected.length < 32 || typeof header !== "string" || header.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

export function registerPrivateAccess(app: FastifyInstance): void {
  if (!config.privateAccess) return;
  if (!config.internalToken || config.internalToken.length < 32) {
    throw new Error("PRIVATE_ACCESS requires INTERNAL_TOKEN (at least 32 characters) shared by the web and api processes");
  }
  // Routes set their own cache lifetimes; in a private deployment no authenticated answer may enter a
  // shared cache, even when a route meant it to be public. Brand assets are read without a session.
  app.addHook("onSend", async (req, reply, payload) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (!PUBLIC_ASSET.test(path)) reply.header("Cache-Control", "private, no-store").header("Vary", "Cookie");
    return payload;
  });
  app.addHook("onRequest", async (req, reply) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (OWN_GUARD.some((pattern) => pattern.test(path)) || internalRequest(req.headers["x-argus-internal"] as string | undefined)) return;
    reply.header("Cache-Control", "private, no-store").header("Vary", "Cookie");
    if (await sessionPrincipal(req.headers.cookie)) return;
    return sendProblem(req, reply, { status: 401, code: "unauthorized", detail: "Sign in to read ARGUS." });
  });
}
