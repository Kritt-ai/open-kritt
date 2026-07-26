-- Widen the generation effort constraint to the union supported by the
-- current provider harnesses. Individual model catalogs narrow this list.

ALTER TABLE public.generations
    DROP CONSTRAINT IF EXISTS generations_thinking_effort_check;

ALTER TABLE public.generations
    ADD CONSTRAINT generations_thinking_effort_check
    CHECK (thinking_effort IN ('default', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'));
