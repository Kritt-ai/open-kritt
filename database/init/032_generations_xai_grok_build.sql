-- Allow xAI Grok Build generations alongside existing provider/harness pairs.
-- All migrations replay on startup: preserve the DeepSeek/Codex pair admitted
-- by 033, otherwise existing valid rows fail before replay can reach 033.

ALTER TABLE public.generations
    DROP CONSTRAINT IF EXISTS generations_model_provider_check;

ALTER TABLE public.generations
    ADD CONSTRAINT generations_model_provider_check
    CHECK (model_provider IN ('codex', 'claude', 'openrouter', 'xai', 'deepseek'));

ALTER TABLE public.generations
    DROP CONSTRAINT IF EXISTS generations_harness_check;

ALTER TABLE public.generations
    ADD CONSTRAINT generations_harness_check
    CHECK (harness IN ('codex', 'claude-code', 'grok-build'));

ALTER TABLE public.generations
    DROP CONSTRAINT IF EXISTS generations_check;

ALTER TABLE public.generations
    ADD CONSTRAINT generations_check
    CHECK (
        (model_provider = 'codex' AND harness = 'codex') OR
        (model_provider = 'claude' AND harness = 'claude-code') OR
        model_provider = 'openrouter' OR
        (model_provider = 'xai' AND harness = 'grok-build') OR
        (model_provider = 'deepseek' AND harness = 'codex')
    );
