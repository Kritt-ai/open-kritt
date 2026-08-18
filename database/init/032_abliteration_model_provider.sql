-- 032_abliteration_model_provider.sql
-- Allow the Abliteration provider on AI generation jobs. Abliteration runs on
-- the Codex harness through its OpenAI-compatible endpoint.

ALTER TABLE public.generations
    DROP CONSTRAINT IF EXISTS generations_model_provider_check;

ALTER TABLE public.generations
    ADD CONSTRAINT generations_model_provider_check
    CHECK (model_provider IN ('codex', 'claude', 'openrouter', 'abliteration'));

ALTER TABLE public.generations
    DROP CONSTRAINT IF EXISTS generations_check;

ALTER TABLE public.generations
    ADD CONSTRAINT generations_check
    CHECK (
        (model_provider = 'codex' AND harness = 'codex') OR
        (model_provider = 'claude' AND harness = 'claude-code') OR
        (model_provider = 'abliteration' AND harness = 'codex') OR
        model_provider = 'openrouter'
    );
