-- ============================================================
-- Liri — official accounts flag (social pivot, step 1c)
--
-- Adds profiles.is_official boolean (default false). Used to mark
-- the Liri announcement account (and any future system accounts)
-- so the UI can render a verified-style badge and tighter styling.
--
-- Safe to re-run.
-- ============================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_official boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS profiles_is_official_idx
  ON public.profiles (is_official)
  WHERE is_official = true;
