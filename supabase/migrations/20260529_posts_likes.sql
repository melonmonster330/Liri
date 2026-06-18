-- ============================================================
-- Liri — posts + likes (social pivot, steps 3 & 5)
--
-- Posts are anchored to an album, a track, or a LYRIC QUOTE (the
-- Liri-unique hook). Likes are a simple join table with a
-- denormalized like_count on posts for cheap feed rendering.
--
-- Album/track references use the existing catalogue IDs:
--   collection_id = catalogue.itunes_collection_id (Discogs release id)
--   track_id      = album_tracks.itunes_track_id
-- We DON'T hard-FK to catalogue/album_tracks — a post should survive
-- catalogue edits — so we also denormalize the display fields
-- (album/artist/track names, artwork) onto the post. Feed renders with
-- zero joins.
--
-- Lyric posts additionally store the quoted text and an optional
-- timestamp window (start/end ms) so a future premium feature can play
-- the matching ~seconds of audio for that line.
--
-- Visibility is per-post (an auto-post can be private even on a public
-- profile). RLS enforces who can SELECT a post:
--   author always; 'public' to anyone; 'friends' to mutual follows;
--   'private' to author only.
--
-- Safe to re-run.
-- Run in the Supabase SQL editor as postgres / service role.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE post_kind AS ENUM ('album','track','lyric');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE post_source AS ENUM ('manual','auto');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Reuse profile_privacy ('private','friends','public') for per-post visibility.

-- ─────────────────────────────────────────────────────────────
-- 1. posts
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.posts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  kind           post_kind NOT NULL,
  source         post_source NOT NULL DEFAULT 'manual',
  visibility     profile_privacy NOT NULL DEFAULT 'public',

  -- catalogue references (not FK'd on purpose — survive catalogue edits)
  collection_id  bigint,                 -- album (all kinds reference one)
  track_id       bigint,                 -- track + lyric posts

  -- denormalized display fields (render feed without joins)
  album_name     text,
  artist_name    text,
  track_name     text,
  artwork_url    text,

  -- lyric-quote posts
  lyric_text     text,                   -- the quoted line(s)
  lyric_start_ms integer,                -- for future audio-clip playback
  lyric_end_ms   integer,

  caption        text,
  like_count     integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),

  -- shape guarantees per kind
  CONSTRAINT posts_album_has_collection CHECK (kind <> 'album' OR collection_id IS NOT NULL),
  CONSTRAINT posts_track_has_track      CHECK (kind <> 'track' OR track_id IS NOT NULL),
  CONSTRAINT posts_lyric_has_text       CHECK (kind <> 'lyric' OR (track_id IS NOT NULL AND lyric_text IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS posts_author_idx     ON public.posts (author_id, created_at DESC);
CREATE INDEX IF NOT EXISTS posts_created_idx    ON public.posts (created_at DESC);
CREATE INDEX IF NOT EXISTS posts_visibility_idx ON public.posts (visibility, created_at DESC);

-- ─────────────────────────────────────────────────────────────
-- 2. likes
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.likes (
  post_id    uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);

CREATE INDEX IF NOT EXISTS likes_user_idx ON public.likes (user_id);

-- ─────────────────────────────────────────────────────────────
-- 3. like_count maintenance (denormalized for cheap feeds)
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.bump_post_like_count()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    UPDATE public.posts SET like_count = like_count + 1 WHERE id = NEW.post_id;
  ELSIF (TG_OP = 'DELETE') THEN
    UPDATE public.posts SET like_count = GREATEST(like_count - 1, 0) WHERE id = OLD.post_id;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS likes_bump_count ON public.likes;
CREATE TRIGGER likes_bump_count
  AFTER INSERT OR DELETE ON public.likes
  FOR EACH ROW EXECUTE FUNCTION public.bump_post_like_count();

-- ─────────────────────────────────────────────────────────────
-- 4. Visibility helper — can the current user see a given author's
--    post at a given visibility? Reused by posts + likes RLS.
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.can_see_post(p_author uuid, p_visibility profile_privacy)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    p_author = auth.uid()
    OR p_visibility = 'public'
    OR (
      p_visibility = 'friends'
      AND EXISTS (SELECT 1 FROM public.follows f
                  WHERE f.follower_id = auth.uid() AND f.followed_id = p_author
                    AND f.status = 'accepted')
      AND EXISTS (SELECT 1 FROM public.follows f
                  WHERE f.follower_id = p_author AND f.followed_id = auth.uid()
                    AND f.status = 'accepted')
    );
$$;

-- ─────────────────────────────────────────────────────────────
-- 5. RLS — posts
-- ─────────────────────────────────────────────────────────────

ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS posts_select_visible ON public.posts;
CREATE POLICY posts_select_visible ON public.posts
  FOR SELECT TO authenticated
  USING (public.can_see_post(author_id, visibility));

DROP POLICY IF EXISTS posts_insert_self ON public.posts;
CREATE POLICY posts_insert_self ON public.posts
  FOR INSERT TO authenticated
  WITH CHECK (author_id = auth.uid());

DROP POLICY IF EXISTS posts_update_own ON public.posts;
CREATE POLICY posts_update_own ON public.posts
  FOR UPDATE TO authenticated
  USING (author_id = auth.uid())
  WITH CHECK (author_id = auth.uid());

DROP POLICY IF EXISTS posts_delete_own ON public.posts;
CREATE POLICY posts_delete_own ON public.posts
  FOR DELETE TO authenticated
  USING (author_id = auth.uid());

-- ─────────────────────────────────────────────────────────────
-- 6. RLS — likes
--    You can like / unlike any post you're allowed to see, and you
--    can see likes on posts you can see.
-- ─────────────────────────────────────────────────────────────

ALTER TABLE public.likes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS likes_select_visible ON public.likes;
CREATE POLICY likes_select_visible ON public.likes
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.posts p
                 WHERE p.id = likes.post_id
                   AND public.can_see_post(p.author_id, p.visibility)));

DROP POLICY IF EXISTS likes_insert_self ON public.likes;
CREATE POLICY likes_insert_self ON public.likes
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (SELECT 1 FROM public.posts p
                WHERE p.id = likes.post_id
                  AND public.can_see_post(p.author_id, p.visibility))
  );

DROP POLICY IF EXISTS likes_delete_self ON public.likes;
CREATE POLICY likes_delete_self ON public.likes
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());
