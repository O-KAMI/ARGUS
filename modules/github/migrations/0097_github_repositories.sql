-- GitHub 仓库主数据：一个仓库一条。Trending 页面不给 Repository ID，所以内部主键是自己的 pk，
-- GitHub 的 Repository ID 和 owner/repo 各是一个唯一键：ID 已知时以它认出改名过的仓库，
-- 只有页面来源时以 full_name 认，等总榜或 Topic 采集补上 ID。
-- AI 分类结果和采集元数据放在一起，避免为一次刷新再建一张表。
CREATE TABLE IF NOT EXISTS github_repositories (
  pk BIGSERIAL PRIMARY KEY,
  github_id BIGINT,
  node_id TEXT,
  full_name TEXT NOT NULL,
  owner_login TEXT NOT NULL,
  name TEXT NOT NULL,
  html_url TEXT NOT NULL,
  description TEXT,
  homepage TEXT,
  language TEXT,
  stargazers_count INTEGER NOT NULL DEFAULT 0,
  forks_count INTEGER,
  open_issues_count INTEGER,
  license_spdx_id TEXT,
  topics JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_fork BOOLEAN NOT NULL DEFAULT false,
  is_archived BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  pushed_at TIMESTAMPTZ,
  is_ai BOOLEAN NOT NULL DEFAULT false,
  ai_primary_category TEXT,
  ai_categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  classification_method TEXT NOT NULL DEFAULT 'topic',
  classification_confidence NUMERIC(4,3) NOT NULL DEFAULT 0,
  matched_topics JSONB NOT NULL DEFAULT '[]'::jsonb,
  manual_override TEXT,
  taxonomy_version TEXT NOT NULL DEFAULT 'v1',
  classified_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT github_repositories_full_name_key UNIQUE (full_name),
  CONSTRAINT github_repositories_manual_override_check CHECK (manual_override IS NULL OR manual_override IN ('include', 'exclude'))
);
