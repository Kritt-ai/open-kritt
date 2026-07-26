ALTER TABLE workflows.step_metadata
    ADD COLUMN IF NOT EXISTS model_provider text,
    ADD COLUMN IF NOT EXISTS subagent_count integer DEFAULT 0;

ALTER TABLE workflows.post_process_metadata
    ADD COLUMN IF NOT EXISTS model_provider text,
    ADD COLUMN IF NOT EXISTS subagent_count integer DEFAULT 0;

UPDATE workflows.step_metadata SET subagent_count = 0 WHERE subagent_count IS NULL;
UPDATE workflows.post_process_metadata SET subagent_count = 0 WHERE subagent_count IS NULL;

ALTER TABLE workflows.step_metadata
    ALTER COLUMN subagent_count SET DEFAULT 0,
    ALTER COLUMN subagent_count SET NOT NULL;

ALTER TABLE workflows.post_process_metadata
    ALTER COLUMN subagent_count SET DEFAULT 0,
    ALTER COLUMN subagent_count SET NOT NULL;
