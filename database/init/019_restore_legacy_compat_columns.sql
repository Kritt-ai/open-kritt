-- Restore compatibility columns removed by early development migrations.
-- Additive, idempotent, and intentionally non-destructive.

ALTER TABLE public.scans
    ADD COLUMN IF NOT EXISTS reasoning_effort text;

ALTER TABLE public.steps
    ADD COLUMN IF NOT EXISTS stub boolean;

ALTER TABLE workflows.step_results
    ADD COLUMN IF NOT EXISTS stub boolean;

ALTER TABLE workflows.vulnerabilities
    ADD COLUMN IF NOT EXISTS stub boolean;
