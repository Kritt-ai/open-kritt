-- Durable executor sub-status for long-running task progress.

ALTER TABLE workflows.step_metadata
    ADD COLUMN IF NOT EXISTS phase text;

ALTER TABLE workflows.post_process_metadata
    ADD COLUMN IF NOT EXISTS phase text;
