-- Support newest-activity-first pagination on the scans page.
CREATE INDEX IF NOT EXISTS scans_updated_at_id_idx
    ON public.scans USING btree (updated_at DESC, id DESC);
