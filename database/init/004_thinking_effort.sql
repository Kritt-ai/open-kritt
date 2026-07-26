-- 004_thinking_effort.sql
-- Adds the reasoning/thinking effort selected for a scan. Additive and idempotent.
-- The model catalog narrows the supported effort union per provider/model.
ALTER TABLE public.scans
    ADD COLUMN IF NOT EXISTS thinking_effort text;

-- Temporary compatibility shim for local databases that already applied the
-- branch-only reasoning_effort migration before main introduced thinking_effort.
ALTER TABLE public.scans
    ADD COLUMN IF NOT EXISTS reasoning_effort text;

UPDATE public.scans
SET thinking_effort = coalesce(
    nullif(thinking_effort, ''),
    reasoning_effort,
    extras->>'thinking_effort',
    extras->>'reasoning_effort',
    'medium'
)
WHERE thinking_effort IS NULL OR thinking_effort = '';

-- Keep the legacy reasoning_effort column when present. The application reads
-- thinking_effort, but forward-only migrations must not destroy user data.
