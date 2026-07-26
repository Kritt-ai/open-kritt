-- 002_additive_columns.sql
-- Additive, non-destructive columns required by the open-kritt UI.
-- Safe to run on an existing database created by 001_create_workflow_tables.sql.

-- Workflows and post-scripts carry a human description in the UI (cards + detail headers).
ALTER TABLE public.llm_workflows
    ADD COLUMN IF NOT EXISTS description text;

ALTER TABLE public.post_scripts
    ADD COLUMN IF NOT EXISTS description text;

-- Non-terminal steps always write to the shared step_results table; give the column a
-- sensible default so the API only has to set it explicitly for terminal steps.
ALTER TABLE public.steps
    ALTER COLUMN output_table SET DEFAULT 'workflows.step_results';

-- Executor queue reconstruction and processed-empty-output support.
ALTER TABLE workflows.step_results
    ADD COLUMN IF NOT EXISTS prev_id bigint,
    ADD COLUMN IF NOT EXISTS prev_table text,
    ADD COLUMN IF NOT EXISTS repeat_run integer;

ALTER TABLE workflows.step_metadata
    ADD COLUMN IF NOT EXISTS prev_id bigint,
    ADD COLUMN IF NOT EXISTS prev_table text,
    ADD COLUMN IF NOT EXISTS repeat_run integer,
    ADD COLUMN IF NOT EXISTS status text,
    ADD COLUMN IF NOT EXISTS error text,
    ADD COLUMN IF NOT EXISTS stub boolean DEFAULT false;

UPDATE workflows.step_metadata SET stub = false WHERE stub IS NULL;

ALTER TABLE workflows.step_metadata
    ALTER COLUMN stub SET DEFAULT false,
    ALTER COLUMN stub SET NOT NULL;

-- Helpful indexes for the read paths the UI hits most often.
CREATE INDEX IF NOT EXISTS scans_status_idx ON public.scans USING btree (status);
CREATE INDEX IF NOT EXISTS scans_inserted_at_idx ON public.scans USING btree (inserted_at DESC);
CREATE INDEX IF NOT EXISTS vulnerabilities_scan_id_idx ON workflows.vulnerabilities USING btree (scan_id);
CREATE INDEX IF NOT EXISTS vulnerabilities_rank_idx ON workflows.vulnerabilities USING btree (scan_id, rank);
CREATE INDEX IF NOT EXISTS step_results_scan_lineage_idx ON workflows.step_results USING btree (scan_id, step_id, repeat_run, prev_table, prev_id);
CREATE INDEX IF NOT EXISTS step_metadata_scan_lineage_idx ON workflows.step_metadata USING btree (scan_id, step_id, repeat_run, prev_table, prev_id, status);
CREATE INDEX IF NOT EXISTS vulnerabilities_scan_lineage_idx ON workflows.vulnerabilities USING btree (scan_id, repeat_run, prev_table, prev_id);
