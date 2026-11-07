-- Complement to aihot-src/scripts/audit-baseline.ts. No credentials, queries or outputs containing article content.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL TIME ZONE 'Asia/Shanghai';

SELECT now() AS observed_at, current_database() AS database,
       pg_size_pretty(pg_database_size(current_database())) AS database_size;
SELECT kind, enabled, count(*) FROM sources GROUP BY 1, 2 ORDER BY 1, 2;
SELECT max(started_at) AS latest_fetch FROM fetch_runs;
SELECT max(started_at) AS latest_recorded_job FROM job_runs;

-- A pending row is not necessarily eligible for the editorial sweep.
SELECT a.processing_state, count(*) AS pending,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM analyses an WHERE an.article_id = a.id
           AND an.input_revision = a.revision AND an.relevance = 'pass'
       )) AS current_revision_pass
FROM articles a WHERE a.grouping_status = 'pending' GROUP BY 1 ORDER BY 1;

SELECT count(*) AS keyed_materials, count(DISTINCT asset_key) AS distinct_keys
FROM articles WHERE asset_key IS NOT NULL;
SELECT count(*) AS multi_material_assets, count(*) FILTER (WHERE facts = 1) AS single_fact_assets
FROM (SELECT a.asset_key, count(DISTINCT fa.fact_id) AS facts
      FROM articles a JOIN fact_articles fa ON fa.article_id = a.id
      WHERE a.asset_key IS NOT NULL GROUP BY a.asset_key HAVING count(DISTINCT a.id) > 1) x;

SELECT kind, key, generated_at FROM reports ORDER BY kind, key;
SELECT status, count(*) FROM job_runs WHERE job = 'reports.compose' GROUP BY 1;
SELECT board_type, count(*) AS entries, min(fetched_at) AS oldest_row_at
FROM github_ranking_entries GROUP BY 1 ORDER BY 1;
SELECT source_type, status, count(*) FROM github_collection_runs GROUP BY 1, 2 ORDER BY 1, 2;

SELECT count(*) AS migrations, count(checksum) AS recorded_checksums FROM schema_migrations;
SELECT indexrelid::regclass AS invalid_index FROM pg_index WHERE NOT indisvalid;
SELECT conname AS unvalidated_constraint FROM pg_constraint
WHERE NOT convalidated AND connamespace = 'public'::regnamespace;
SELECT count(*) AS backup_setting_rows FROM settings WHERE key = 'backup.last';
SELECT status, count(*) FROM job_runs WHERE job = 'ops.backup' GROUP BY 1;
COMMIT;
