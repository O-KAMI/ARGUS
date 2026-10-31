-- 采集运行记录：后台状态、故障排查和“最近一次成功采集时间”。不保存 Star 时间序列。
CREATE TABLE IF NOT EXISTS github_collection_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  items_count INTEGER,
  error_message TEXT,
  incomplete_results BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT github_collection_runs_source_type_check CHECK (source_type IN ('trending', 'search_all', 'search_ai')),
  CONSTRAINT github_collection_runs_status_check CHECK (status IN ('running', 'success', 'partial', 'failed'))
);
