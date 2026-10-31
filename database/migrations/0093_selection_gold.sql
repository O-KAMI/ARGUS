-- The human calibration evidence behind the selection standard: one row per labelled item, holding the
-- material as the site saw it, the source facts that fix its track and threshold, and the decision.
-- In the database rather than a gold jsonl file: the api writes files that do not persist inside a
-- container, and scripts/eval-selection.ts exports these rows to the jsonl it reads.
-- case_id is the article id, so re-labelling replaces the item's one current human answer instead of
-- adding a second row the gold reader would reject as a duplicate case; every change stays in audit_log.
CREATE TABLE selection_gold (
  case_id text PRIMARY KEY,
  article_id text NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  track text NOT NULL,
  material jsonb NOT NULL,
  source_facts jsonb NOT NULL,
  sampling_context jsonb NOT NULL DEFAULT '{}',
  decision text NOT NULL,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
