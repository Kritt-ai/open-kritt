-- Record supplemental retry lineage so each failed run exposes at most one
-- durable retry action. Additive and idempotent for existing installations.

ALTER TABLE workflows.supplemental_post_script_runs
    ADD COLUMN IF NOT EXISTS retry_of_run_id bigint;

CREATE UNIQUE INDEX IF NOT EXISTS supplemental_post_script_runs_retry_of_run_id_key
    ON workflows.supplemental_post_script_runs USING btree (retry_of_run_id);

COMMENT ON COLUMN workflows.supplemental_post_script_runs.retry_of_run_id IS
    'The failed supplemental run retried by this run; each run can be retried at most once.';
