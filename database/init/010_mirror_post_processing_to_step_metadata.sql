-- Mirror post-processing telemetry into workflows.step_metadata for a unified
-- executor-attempt audit trail. Workflow queue rebuilds only use kind='step'.
ALTER TABLE workflows.step_metadata
    ADD COLUMN IF NOT EXISTS kind text DEFAULT 'step',
    ADD COLUMN IF NOT EXISTS post_process_metadata_id bigint,
    ADD COLUMN IF NOT EXISTS post_script_id bigint,
    ADD COLUMN IF NOT EXISTS post_script_name text,
    ADD COLUMN IF NOT EXISTS vulnerability_id bigint,
    ADD COLUMN IF NOT EXISTS target_vulnerability_ids bigint[] DEFAULT ARRAY[]::bigint[],
    ADD COLUMN IF NOT EXISTS batch_index integer,
    ADD COLUMN IF NOT EXISTS output_json jsonb,
    ADD COLUMN IF NOT EXISTS model text,
    ADD COLUMN IF NOT EXISTS harness text,
    ADD COLUMN IF NOT EXISTS thinking_effort text,
    ADD COLUMN IF NOT EXISTS model_provider text,
    ADD COLUMN IF NOT EXISTS subagent_count integer DEFAULT 0;

ALTER TABLE workflows.post_process_metadata
    ADD COLUMN IF NOT EXISTS model_provider text,
    ADD COLUMN IF NOT EXISTS subagent_count integer DEFAULT 0;

UPDATE workflows.step_metadata SET kind = 'step' WHERE kind IS NULL;
UPDATE workflows.step_metadata
SET target_vulnerability_ids = ARRAY[]::bigint[]
WHERE target_vulnerability_ids IS NULL;
UPDATE workflows.step_metadata SET subagent_count = 0 WHERE subagent_count IS NULL;
UPDATE workflows.post_process_metadata SET subagent_count = 0 WHERE subagent_count IS NULL;

ALTER TABLE workflows.step_metadata
    ALTER COLUMN kind SET DEFAULT 'step',
    ALTER COLUMN kind SET NOT NULL,
    ALTER COLUMN target_vulnerability_ids SET DEFAULT ARRAY[]::bigint[],
    ALTER COLUMN target_vulnerability_ids SET NOT NULL,
    ALTER COLUMN subagent_count SET DEFAULT 0,
    ALTER COLUMN subagent_count SET NOT NULL;

ALTER TABLE workflows.post_process_metadata
    ALTER COLUMN subagent_count SET DEFAULT 0,
    ALTER COLUMN subagent_count SET NOT NULL;

CREATE INDEX IF NOT EXISTS step_metadata_kind_scan_idx
    ON workflows.step_metadata USING btree (kind, scan_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS step_metadata_post_process_metadata_unique
    ON workflows.step_metadata USING btree (post_process_metadata_id)
    WHERE kind <> 'step' AND post_process_metadata_id IS NOT NULL;

INSERT INTO workflows.step_metadata (
    scan_id, workflow_id, step_id, prev_id, prev_table, repeat_run,
    status, phase, error, kind, post_process_metadata_id, post_script_id,
    post_script_name, vulnerability_id, target_vulnerability_ids, batch_index,
    prompt_template, prompt_filled, output_json, checked_out_commit,
    run_started_at, run_time_ms, raw_token_usage, token_count_cached_input,
    token_count_input, token_count_output, token_count_reasoning_output,
    token_count_total, codex_session_id, codex_source_home, codex_account_id,
    codex_account_email, model, harness, thinking_effort, model_provider,
    subagent_count,
    inserted_at, updated_at
)
SELECT
    p.scan_id,
    p.workflow_id,
    0,
    p.vulnerability_id,
    CASE WHEN p.vulnerability_id IS NULL THEN NULL ELSE 'workflows.vulnerabilities' END,
    1,
    p.status,
    p.phase,
    p.error,
    p.kind,
    p.id,
    p.post_script_id,
    p.post_script_name,
    p.vulnerability_id,
    p.target_vulnerability_ids,
    p.batch_index,
    p.prompt_template,
    p.prompt_filled,
    p.output_json,
    p.checked_out_commit,
    p.run_started_at,
    p.run_time_ms,
    p.raw_token_usage,
    p.token_count_cached_input,
    p.token_count_input,
    p.token_count_output,
    p.token_count_reasoning_output,
    p.token_count_total,
    p.codex_session_id,
    p.codex_source_home,
    p.codex_account_id,
    p.codex_account_email,
    p.model,
    p.harness,
    p.thinking_effort,
    p.model_provider,
    p.subagent_count,
    p.inserted_at,
    p.updated_at
FROM workflows.post_process_metadata p
ON CONFLICT (post_process_metadata_id)
    WHERE kind <> 'step' AND post_process_metadata_id IS NOT NULL
DO UPDATE SET
    scan_id = EXCLUDED.scan_id,
    workflow_id = EXCLUDED.workflow_id,
    prev_id = EXCLUDED.prev_id,
    prev_table = EXCLUDED.prev_table,
    repeat_run = EXCLUDED.repeat_run,
    status = EXCLUDED.status,
    phase = EXCLUDED.phase,
    error = EXCLUDED.error,
    kind = EXCLUDED.kind,
    post_script_id = EXCLUDED.post_script_id,
    post_script_name = EXCLUDED.post_script_name,
    vulnerability_id = EXCLUDED.vulnerability_id,
    target_vulnerability_ids = EXCLUDED.target_vulnerability_ids,
    batch_index = EXCLUDED.batch_index,
    prompt_template = EXCLUDED.prompt_template,
    prompt_filled = EXCLUDED.prompt_filled,
    output_json = EXCLUDED.output_json,
    checked_out_commit = EXCLUDED.checked_out_commit,
    run_started_at = EXCLUDED.run_started_at,
    run_time_ms = EXCLUDED.run_time_ms,
    raw_token_usage = EXCLUDED.raw_token_usage,
    token_count_cached_input = EXCLUDED.token_count_cached_input,
    token_count_input = EXCLUDED.token_count_input,
    token_count_output = EXCLUDED.token_count_output,
    token_count_reasoning_output = EXCLUDED.token_count_reasoning_output,
    token_count_total = EXCLUDED.token_count_total,
    codex_session_id = EXCLUDED.codex_session_id,
    codex_source_home = EXCLUDED.codex_source_home,
    codex_account_id = EXCLUDED.codex_account_id,
    codex_account_email = EXCLUDED.codex_account_email,
    model = EXCLUDED.model,
    harness = EXCLUDED.harness,
    thinking_effort = EXCLUDED.thinking_effort,
    model_provider = EXCLUDED.model_provider,
    subagent_count = EXCLUDED.subagent_count,
    updated_at = EXCLUDED.updated_at;
