-- 当前榜单：只保留每个 board_type 的最新一版，刷新成功时在事务里整批替换。
CREATE TABLE IF NOT EXISTS github_ranking_entries (
  id BIGSERIAL PRIMARY KEY,
  board_type TEXT NOT NULL,
  repository_id BIGINT NOT NULL REFERENCES github_repositories (pk) ON DELETE CASCADE,
  rank INTEGER NOT NULL,
  source_rank INTEGER,
  fetched_at TIMESTAMPTZ NOT NULL,
  source_url TEXT NOT NULL,
  CONSTRAINT github_ranking_entries_board_repository_key UNIQUE (board_type, repository_id),
  CONSTRAINT github_ranking_entries_board_type_check CHECK (board_type IN ('all_weekly', 'all_stars', 'ai_weekly', 'ai_stars'))
);
