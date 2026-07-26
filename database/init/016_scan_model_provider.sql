-- 016_scan_model_provider.sql
-- Per-scan model provider selected in the New Scan UI and consumed by the executor.
-- Existing scans are explicitly backfilled to OpenRouter per the current default.

ALTER TABLE public.scans
    ADD COLUMN IF NOT EXISTS model_provider text DEFAULT 'openrouter';

UPDATE public.scans
SET model_provider = 'openrouter'
WHERE model_provider IS NULL OR model_provider = '';

ALTER TABLE public.scans
    ALTER COLUMN model_provider SET DEFAULT 'openrouter',
    ALTER COLUMN model_provider SET NOT NULL;
