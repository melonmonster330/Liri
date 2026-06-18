-- ============================================================
-- Liri — auto-post visibility (social pivot, step 1b)
--
-- Replaces the boolean profiles.auto_post_plays with a 4-value
-- text column auto_post_visibility: off | private | friends | public.
-- Existing TRUE values become 'private' (a safe default — anyone
-- who had auto-post on probably didn't want it broadcast publicly).
--
-- Safe to re-run.
-- ============================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS auto_post_visibility text
    NOT NULL DEFAULT 'off'
    CHECK (auto_post_visibility IN ('off','private','friends','public'));

-- Migrate any existing TRUE values from the boolean column.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='profiles' AND column_name='auto_post_plays'
  ) THEN
    UPDATE public.profiles
       SET auto_post_visibility = 'private'
     WHERE auto_post_plays = true
       AND auto_post_visibility = 'off';

    ALTER TABLE public.profiles DROP COLUMN auto_post_plays;
  END IF;
END $$;
