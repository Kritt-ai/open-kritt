-- Let a workflow attach scan configuration and extra inputs as workspace files.
-- Additive and idempotent; existing workflows keep the previous prompt-only behavior.

ALTER TABLE public.llm_workflows
    ADD COLUMN IF NOT EXISTS include_context_files boolean DEFAULT false NOT NULL;

COMMENT ON COLUMN public.llm_workflows.include_context_files IS
    'When true, scan configuration and extra inputs are attached to each job workspace and referenced from the prompt.';
