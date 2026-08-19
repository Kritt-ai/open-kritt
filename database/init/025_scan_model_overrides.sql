-- Optional per-workflow-depth model configurations.
-- The existing scan model tuple remains the fallback for every depth without
-- an override and for post-processing jobs.

ALTER TABLE public.scans
    ADD COLUMN IF NOT EXISTS model_overrides jsonb DEFAULT '{}'::jsonb NOT NULL;

UPDATE public.scans
SET model_overrides = '{}'::jsonb
WHERE model_overrides IS NULL OR jsonb_typeof(model_overrides) <> 'object';

ALTER TABLE public.scans
    ALTER COLUMN model_overrides SET DEFAULT '{}'::jsonb,
    ALTER COLUMN model_overrides SET NOT NULL;
