-- A platform's pool pages and capped counts keep their time order without scanning the other platforms.
CREATE INDEX CONCURRENTLY IF NOT EXISTS publications_pool_platform_timeline_idx
  ON publications (platform, timeline_at DESC, article_id DESC)
  INCLUDE (category, channel, source_id, selected, visible_after)
  WHERE visibility = 'public' AND eligible;
