-- Explanation supplied by the harness when it returns stub=true/results=[].
ALTER TABLE workflows.step_metadata
    ADD COLUMN IF NOT EXISTS stub_explanation text;
