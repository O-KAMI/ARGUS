CREATE INDEX CONCURRENTLY IF NOT EXISTS github_runs_recent_idx ON github_collection_runs (source_type, started_at DESC);
