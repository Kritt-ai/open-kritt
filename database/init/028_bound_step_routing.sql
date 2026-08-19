-- Optional one-to-one routing between sibling steps in adjacent workflow depths.
-- A NULL source keeps the existing broadcast behavior.

ALTER TABLE public.steps
  ADD COLUMN IF NOT EXISTS bound_source_step_id bigint;

CREATE INDEX IF NOT EXISTS steps_bound_source_step_id_idx
  ON public.steps (bound_source_step_id);

COMMENT ON COLUMN public.steps.bound_source_step_id IS
  'When set, this step only consumes outputs produced by the referenced step in the immediately previous depth.';
