-- Generation provider/harness validation is application-owned. The provider
-- set can include user-defined OpenAI-compatible providers, so hard-coded DB
-- CHECK constraints break enqueue before the engine can claim the job.

ALTER TABLE public.generations
    DROP CONSTRAINT IF EXISTS generations_model_provider_check;

ALTER TABLE public.generations
    DROP CONSTRAINT IF EXISTS generations_harness_check;

ALTER TABLE public.generations
    DROP CONSTRAINT IF EXISTS generations_check;

ALTER TABLE public.generations
    DROP CONSTRAINT IF EXISTS generations_model_provider_nonempty_check;

ALTER TABLE public.generations
    DROP CONSTRAINT IF EXISTS generations_harness_nonempty_check;

ALTER TABLE public.generations
    ADD CONSTRAINT generations_model_provider_nonempty_check
    CHECK (length(btrim(model_provider)) BETWEEN 1 AND 63);

ALTER TABLE public.generations
    ADD CONSTRAINT generations_harness_nonempty_check
    CHECK (length(btrim(harness)) BETWEEN 1 AND 80);
