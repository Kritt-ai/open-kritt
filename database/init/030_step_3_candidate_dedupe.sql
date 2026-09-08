-- Optionally classify depth-2 workflow inputs against already claimed inputs
-- before paying the cost of a full repository-backed verification run.
-- Additive and idempotent; existing workflows retain the previous behavior.

ALTER TABLE public.llm_workflows
    ADD COLUMN IF NOT EXISTS dedupe_step_3 boolean DEFAULT false NOT NULL;

COMMENT ON COLUMN public.llm_workflows.dedupe_step_3 IS
    'When true, depth-2 jobs run a tool-free Codex duplicate check before workspace setup.';

ALTER TABLE workflows.step_metadata
    ADD COLUMN IF NOT EXISTS duplicate_of_prev_id bigint;

COMMENT ON COLUMN workflows.step_metadata.duplicate_of_prev_id IS
    'Upstream step_results id selected by the optional depth-2 duplicate gate.';

CREATE INDEX IF NOT EXISTS step_metadata_duplicate_of_prev_id_idx
    ON workflows.step_metadata USING btree (scan_id, step_id, duplicate_of_prev_id)
    WHERE duplicate_of_prev_id IS NOT NULL;
