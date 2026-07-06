-- ============================================================
-- Liri — fix like_count not incrementing on other people's posts
--
-- bump_post_like_count() maintains the denormalized posts.like_count
-- from INSERT/DELETE on likes. It was NOT security definer, so it ran
-- with the liker's privileges — and posts RLS (posts_update_own) only
-- lets you UPDATE your OWN posts. Result: liking someone else's post
-- inserted the like row but the count update was silently filtered by
-- RLS, so counts never moved for anyone but the author.
--
-- SECURITY DEFINER runs the counter as the function owner (bypasses
-- RLS), which is the correct pattern for a trigger-maintained counter.
--
-- Also backfills like_count from the actual likes rows to repair any
-- counts that drifted while the bug was live.
--
-- Safe to re-run.
-- ============================================================

CREATE OR REPLACE FUNCTION public.bump_post_like_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

-- Repair counts that drifted while the trigger was blocked.
UPDATE public.posts p
SET like_count = COALESCE((SELECT count(*) FROM public.likes l WHERE l.post_id = p.id), 0);
