-- 005_repo_kind.sql
-- A scan target (and each dependency) can be a remote git URL or a local repo.
-- Additive and idempotent.

-- 'remote' | 'local' for the scan's primary target.
ALTER TABLE public.scans
    ADD COLUMN IF NOT EXISTS repo_kind text;

-- Structured dependency list: array of { kind, repo_full, commit_sha }.
-- The legacy text[] `dependencies` column is kept populated with the addresses/names.
ALTER TABLE public.scans
    ADD COLUMN IF NOT EXISTS dependencies_detail jsonb;
