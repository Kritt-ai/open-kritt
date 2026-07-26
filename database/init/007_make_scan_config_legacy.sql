-- 007_make_scan_config_legacy.sql
-- The JSON config column is retained only for legacy compatibility. Runtime
-- behavior reads the real scan columns, so new rows can safely default it empty.
ALTER TABLE public.scans
    ALTER COLUMN config SET DEFAULT '{}'::jsonb;
