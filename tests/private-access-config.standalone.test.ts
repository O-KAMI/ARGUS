// The default private contract needs no environment opt-in, and initialization never enables it without a token.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { FastifyInstance } from "fastify";

delete process.env.PRIVATE_ACCESS;
delete process.env.INTERNAL_TOKEN;
const { config } = await import("@aihot/backend/config");
const { registerPrivateAccess } = await import("../apps/api/src/private.ts");

test("private access defaults on when the environment does not set it", () => {
  assert.equal(config.privateAccess, true);
});

test("private access without an internal token fails explicitly", () => {
  assert.equal(config.internalToken, null);
  assert.throws(
    () => registerPrivateAccess({} as FastifyInstance),
    /PRIVATE_ACCESS requires INTERNAL_TOKEN \(at least 32 characters\)/,
  );
});

test("init-env generates the internal token before enabling private access", () => {
  const repo = path.resolve(import.meta.dirname, "..");
  const directory = mkdtempSync(path.join(tmpdir(), "private-init-"));
  try {
    copyFileSync(path.join(repo, ".env.example"), path.join(directory, ".env.example"));
    const result = spawnSync(process.execPath, [path.join(repo, "scripts/init-env.ts")], {
      cwd: directory,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const generated = readFileSync(path.join(directory, ".env"), "utf8");
    assert.match(generated, /^INTERNAL_TOKEN=[0-9a-f]{64}$/m);
    assert.match(generated, /^PRIVATE_ACCESS=true$/m);
    const tokenAt = generated.indexOf("INTERNAL_TOKEN=");
    const privateAt = generated.indexOf("PRIVATE_ACCESS=");
    assert.ok(tokenAt >= 0 && privateAt > tokenAt, "the token is in place before private access is enabled");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
