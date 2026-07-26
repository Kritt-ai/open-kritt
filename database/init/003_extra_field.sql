-- 003_extra_field.sql
-- Adds the optional dynamic "extra" context used by step prompts via {{extra.<key>}}.
-- Additive and idempotent; safe to run on an existing database.

-- Per-scan values supplied for the workflow's expected extra keys, e.g.
--   { "tenant_id": "acme", "feature_flag": "billing_v2" }
ALTER TABLE public.scans
    ADD COLUMN IF NOT EXISTS extra jsonb;

-- The distinct extra sub-keys referenced across a workflow's steps, e.g.
--   {tenant_id, feature_flag}
-- Derived from the steps' prompt content when the workflow is saved.
ALTER TABLE public.llm_workflows
    ADD COLUMN IF NOT EXISTS extra text[] DEFAULT ARRAY[]::text[];
