-- ============================================================
-- Liri — follow graph (social pivot, step 2)
--
-- Asymmetric follows. follower_id → followed_id with a status:
--   'accepted' — visible immediately (public targets, or approved request)
--   'pending'  — follow request waiting on target's approval
--
-- "Friends" is the derived state where follows exist in BOTH
-- directions with status='accepted'.
--
-- RLS:
--   SELECT — either party can see the row (the follower and the followed)
--   INSERT — only the follower themselves can create it
--   DELETE — either party (unfollow OR decline a request)
--   UPDATE — only the followed (to accept a pending request)
--
-- Safe to re-run.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE follow_status AS ENUM ('pending','accepted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.follows (
  follower_id  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  followed_id  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status       follow_status NOT NULL DEFAULT 'accepted',
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followed_id),
  CONSTRAINT follows_no_self CHECK (follower_id <> followed_id)
);

CREATE INDEX IF NOT EXISTS follows_followed_idx ON public.follows (followed_id, status);
CREATE INDEX IF NOT EXISTS follows_follower_idx ON public.follows (follower_id, status);

-- ─────────────────────────────────────────────────────────────
-- RLS
-- ─────────────────────────────────────────────────────────────

ALTER TABLE public.follows ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS follows_select_party ON public.follows;
CREATE POLICY follows_select_party ON public.follows
  FOR SELECT TO authenticated
  USING (follower_id = auth.uid() OR followed_id = auth.uid());

DROP POLICY IF EXISTS follows_insert_self ON public.follows;
CREATE POLICY follows_insert_self ON public.follows
  FOR INSERT TO authenticated
  WITH CHECK (follower_id = auth.uid());

DROP POLICY IF EXISTS follows_delete_party ON public.follows;
CREATE POLICY follows_delete_party ON public.follows
  FOR DELETE TO authenticated
  USING (follower_id = auth.uid() OR followed_id = auth.uid());

DROP POLICY IF EXISTS follows_update_target ON public.follows;
CREATE POLICY follows_update_target ON public.follows
  FOR UPDATE TO authenticated
  USING (followed_id = auth.uid())
  WITH CHECK (followed_id = auth.uid());

-- ─────────────────────────────────────────────────────────────
-- Also: open up profile SELECT for username search.
--
-- The original profiles_public_select policy only let authenticated
-- users see profiles where privacy='public'. For user search we also
-- need to see 'friends' profiles in the list (so people can request
-- to follow). Private profiles stay hidden from search.
-- ─────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS profiles_discoverable_select ON public.profiles;
CREATE POLICY profiles_discoverable_select ON public.profiles
  FOR SELECT TO authenticated
  USING (privacy IN ('public','friends'));
