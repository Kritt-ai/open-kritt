ALTER TABLE public.scans
    ADD COLUMN IF NOT EXISTS job_limit integer,
    ADD COLUMN IF NOT EXISTS jobs_started integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_resumed_at timestamp with time zone;

ALTER TABLE public.scans
    DROP CONSTRAINT IF EXISTS scans_job_limit_positive;

ALTER TABLE public.scans
    ADD CONSTRAINT scans_job_limit_positive
    CHECK (job_limit IS NULL OR job_limit > 0);

WITH logical_jobs AS (
    SELECT scan_id
    FROM workflows.step_metadata
    WHERE coalesce(kind, 'step') = 'step'
    GROUP BY scan_id, step_id, coalesce(prev_id, 0), coalesce(prev_table, ''), coalesce(repeat_run, 1)

    UNION ALL

    SELECT scan_id
    FROM workflows.post_process_metadata
    GROUP BY scan_id, id
), counts AS (
    SELECT scan_id, count(*)::integer AS jobs_started
    FROM logical_jobs
    GROUP BY scan_id
)
UPDATE public.scans AS scan
SET jobs_started = counts.jobs_started
FROM counts
WHERE scan.id = counts.scan_id
  AND scan.jobs_started = 0;
