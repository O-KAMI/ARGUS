// The rows this module keeps about the addresses it reads (aihot_mirror_state). One row per address, the
// answer stored as it came, and the bookkeeping that makes the next read conditional: the ETag, the wait a
// Retry-After asked for, and what the last attempt ended in. The rows of one pass are written together, so
// the ranking the public surfaces read is never one address ahead of the other.
import { sql, type Db } from "@aihot/backend/db";
import type { UpstreamPolicy } from "./upstream.ts";

export interface EndpointRow {
  endpoint: string;
  etag: string | null;
  holdUntil: Date | null;
  lastStatus: number | null;
  lastCount: number | null;
  lastOkAt: Date | null;
  lastError: string | null;
  policy: UpstreamPolicy | null;
  /** The answer as it came; null until the address has been read whole once. */
  answer: unknown;
  updatedAt: Date | null;
}

/** A row as the next pass writes it: every field whole, so a value left out is a value cleared on purpose. */
export interface EndpointSave {
  endpoint: string;
  etag: string | null;
  holdUntil: Date | null;
  lastStatus: number | null;
  lastCount: number | null;
  lastOkAt: Date | null;
  lastError: string | null;
  policy: UpstreamPolicy | null;
  answer: unknown;
}

const rowOf = (row: {
  endpoint: string; etag: string | null; hold_until: Date | null; last_status: number | null; last_count: number | null;
  last_ok_at: Date | null; last_error: string | null; policy: UpstreamPolicy | null; answer: unknown; updated_at: Date | null;
}): EndpointRow => ({
  endpoint: row.endpoint,
  etag: row.etag,
  holdUntil: row.hold_until,
  lastStatus: row.last_status,
  lastCount: row.last_count,
  lastOkAt: row.last_ok_at,
  lastError: row.last_error,
  policy: row.policy,
  answer: row.answer,
  updatedAt: row.updated_at,
});

type Stored = Parameters<typeof rowOf>[0];

export async function readEndpoints(endpoints: readonly string[], db: Db = sql): Promise<Map<string, EndpointRow>> {
  if (!endpoints.length) return new Map();
  const rows = await db<Stored[]>`
    SELECT endpoint, etag, hold_until, last_status, last_count, last_ok_at, last_error, policy, answer, updated_at
    FROM aihot_mirror_state WHERE endpoint = ANY(${endpoints})`;
  return new Map(rows.map((row) => [row.endpoint, rowOf(row)]));
}

/** Every row, for the owner's alerts and for a status read: what the mirror last heard from each address. */
export async function endpointStates(db: Db = sql): Promise<EndpointRow[]> {
  return (await db<Stored[]>`
    SELECT endpoint, etag, hold_until, last_status, last_count, last_ok_at, last_error, policy, answer, updated_at
    FROM aihot_mirror_state ORDER BY endpoint`).map(rowOf);
}

/**
 * The next row from the one before it and what this pass learned. Fields the pass says nothing about keep
 * their value, which is the whole point: an address that could not be read leaves the ranking as it was.
 */
export function nextSave(previous: EndpointRow | null, endpoint: string, patch: Partial<Omit<EndpointSave, "endpoint">>): EndpointSave {
  return {
    endpoint,
    etag: patch.etag !== undefined ? patch.etag : previous?.etag ?? null,
    holdUntil: patch.holdUntil !== undefined ? patch.holdUntil : previous?.holdUntil ?? null,
    lastStatus: patch.lastStatus !== undefined ? patch.lastStatus : previous?.lastStatus ?? null,
    lastCount: patch.lastCount !== undefined ? patch.lastCount : previous?.lastCount ?? null,
    lastOkAt: patch.lastOkAt !== undefined ? patch.lastOkAt : previous?.lastOkAt ?? null,
    lastError: patch.lastError !== undefined ? patch.lastError : previous?.lastError ?? null,
    policy: patch.policy !== undefined ? patch.policy : previous?.policy ?? null,
    answer: patch.answer !== undefined ? patch.answer : previous?.answer ?? null,
  };
}

/** The rows of one pass, in one transaction. */
export async function saveEndpoints(saves: readonly EndpointSave[], db: Db = sql): Promise<void> {
  if (!saves.length) return;
  const write = async (d: Db) => {
    for (const save of saves) {
      await d`
        INSERT INTO aihot_mirror_state (endpoint, etag, hold_until, last_status, last_count, last_ok_at, last_error, policy, answer, updated_at)
        VALUES (${save.endpoint}, ${save.etag}, ${save.holdUntil}, ${save.lastStatus}, ${save.lastCount}, ${save.lastOkAt},
          ${save.lastError}, ${sql.json(save.policy as never)}, ${sql.json(save.answer as never)}, now())
        ON CONFLICT (endpoint) DO UPDATE SET
          etag = EXCLUDED.etag, hold_until = EXCLUDED.hold_until, last_status = EXCLUDED.last_status,
          last_count = EXCLUDED.last_count, last_ok_at = EXCLUDED.last_ok_at, last_error = EXCLUDED.last_error,
          policy = EXCLUDED.policy, answer = EXCLUDED.answer, updated_at = now()`;
    }
  };
  if ("begin" in db) await (db as typeof sql).begin(write);
  else await write(db);
}

/** How long an address is held off by the wait its last answer asked for; null when it may be read now. */
export function heldFor(row: EndpointRow | null, now: Date): number | null {
  if (!row?.holdUntil) return null;
  const ms = row.holdUntil.getTime() - now.getTime();
  return ms > 0 ? Math.ceil(ms / 1000) : null;
}
