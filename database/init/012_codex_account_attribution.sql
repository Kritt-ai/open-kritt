ALTER TABLE workflows.step_metadata
    ADD COLUMN IF NOT EXISTS codex_source_home text,
    ADD COLUMN IF NOT EXISTS codex_account_id text,
    ADD COLUMN IF NOT EXISTS codex_account_email text;

ALTER TABLE workflows.post_process_metadata
    ADD COLUMN IF NOT EXISTS codex_source_home text,
    ADD COLUMN IF NOT EXISTS codex_account_id text,
    ADD COLUMN IF NOT EXISTS codex_account_email text;
