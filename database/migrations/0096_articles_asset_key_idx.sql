CREATE INDEX CONCURRENTLY IF NOT EXISTS articles_asset_key_idx ON articles (asset_key) WHERE asset_key IS NOT NULL;
