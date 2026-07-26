-- 006_consume_all_previous.sql
-- When true, this step's depth runs a SINGLE agent that receives the full array
-- of the previous depth's outputs as {{multi_output_depth_<prev>}}, instead of
-- one agent per previous result. Shared across siblings of the same depth.
-- Additive and idempotent.
ALTER TABLE public.steps
    ADD COLUMN IF NOT EXISTS consume_all_previous boolean NOT NULL DEFAULT false;
