-- Cached, UI-safe model lists discovered from configured provider accounts.
-- The catalog refresher owns writes; this migration is safe to apply repeatedly.

CREATE TABLE IF NOT EXISTS public.model_catalogs (
    provider text PRIMARY KEY,
    models jsonb NOT NULL DEFAULT '[]'::jsonb,
    default_model text,
    fetched_at timestamp with time zone,
    last_error text,
    updated_at timestamp with time zone DEFAULT now()
);
