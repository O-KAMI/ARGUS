-- What the mirror remembers about the catalogue it reads, one row per address: the ETag a conditional
-- request needs, the wait a rate-limit answer asked for, the answer's own licence terms, and the answer
-- itself. A reader therefore never downloads what it already has and never asks again inside a
-- Retry-After. The ranking rows hold only the latest reading (one row per address, overwritten), so the
-- mirror builds no historical archive of somebody else's ranking.
CREATE TABLE IF NOT EXISTS aihot_mirror_state (
  endpoint text PRIMARY KEY,
  etag text,
  hold_until timestamptz,
  last_status integer,
  last_count integer,
  last_ok_at timestamptz,
  last_error text,
  policy jsonb,
  answer jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
