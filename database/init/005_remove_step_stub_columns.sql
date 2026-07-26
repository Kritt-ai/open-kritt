-- Stub is not a workflow-step property. It is only a harness response outcome
-- tracked on workflows.step_metadata for completed empty-output lineages. Keep
-- any legacy columns in place: forward-only migrations must not destroy data,
-- and the application safely ignores these compatibility columns.

ALTER TABLE workflows.step_metadata
    ADD COLUMN IF NOT EXISTS stub boolean DEFAULT false;

UPDATE workflows.step_metadata SET stub = false WHERE stub IS NULL;

ALTER TABLE workflows.step_metadata
    ALTER COLUMN stub SET DEFAULT false,
    ALTER COLUMN stub SET NOT NULL;
