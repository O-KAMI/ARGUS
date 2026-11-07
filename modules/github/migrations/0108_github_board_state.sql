CREATE TABLE IF NOT EXISTS github_board_state (
  board_type text PRIMARY KEY,
  last_attempt_at timestamptz,
  last_complete_at timestamptz,
  version_at timestamptz,
  coverage text,
  entries integer NOT NULL DEFAULT 0,
  last_status text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
