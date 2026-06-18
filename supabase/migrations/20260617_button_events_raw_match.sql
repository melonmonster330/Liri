-- Add raw recognition match fields to button_events so we can compare
-- what the recognition service returned vs. what was displayed to the user.
-- Nullable — older rows won't have this data.

ALTER TABLE public.button_events
  ADD COLUMN IF NOT EXISTS identified_by    text,  -- "shazam" | "acr" | "speech" | "manual"
  ADD COLUMN IF NOT EXISTS raw_match_title  text,  -- exact title string from recognition service
  ADD COLUMN IF NOT EXISTS raw_match_artist text;  -- exact artist string from recognition service
