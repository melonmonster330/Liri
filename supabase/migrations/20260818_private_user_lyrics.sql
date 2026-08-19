-- Private per-user lyric overrides and catalogue-review candidates.

CREATE TABLE IF NOT EXISTS public.user_track_lyrics (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  itunes_track_id     bigint NOT NULL,
  lrc_raw             text,
  lyrics_plain        text,
  is_instrumental     boolean NOT NULL DEFAULT false,
  share_for_catalog   boolean NOT NULL DEFAULT false,
  review_status       text NOT NULL DEFAULT 'private',
  review_note         text,
  reviewed_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_track_lyrics_content_check CHECK (
    is_instrumental OR lrc_raw IS NOT NULL OR lyrics_plain IS NOT NULL
  ),
  CONSTRAINT user_track_lyrics_review_status_check CHECK (
    review_status IN ('private', 'pending', 'promoted', 'rejected', 'needs_review')
  ),
  UNIQUE (user_id, itunes_track_id)
);

CREATE INDEX IF NOT EXISTS idx_user_track_lyrics_catalog_review
  ON public.user_track_lyrics (review_status, updated_at)
  WHERE share_for_catalog = true;

ALTER TABLE public.user_track_lyrics ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own lyrics" ON public.user_track_lyrics;
DROP POLICY IF EXISTS "Users insert own lyrics" ON public.user_track_lyrics;
DROP POLICY IF EXISTS "Users update own lyrics" ON public.user_track_lyrics;
DROP POLICY IF EXISTS "Users delete own lyrics" ON public.user_track_lyrics;

CREATE POLICY "Users read own lyrics"
  ON public.user_track_lyrics FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users insert own lyrics"
  ON public.user_track_lyrics FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update own lyrics"
  ON public.user_track_lyrics FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users delete own lyrics"
  ON public.user_track_lyrics FOR DELETE
  USING (auth.uid() = user_id);

-- Canonical lyrics are service-managed. Authenticated clients previously had
-- unrestricted UPDATE access, which made personal edits global.
DROP POLICY IF EXISTS "Auth insert track lyrics" ON public.track_lyrics;
DROP POLICY IF EXISTS "Auth update track lyrics" ON public.track_lyrics;
