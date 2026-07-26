-- 003_add_scan_extras.sql
-- Optional free-form scan metadata for engine/UI features that should not become
-- first-class columns.

ALTER TABLE public.scans
    ADD COLUMN IF NOT EXISTS extras jsonb;
