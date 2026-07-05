-- ============================================================
-- Liri — follower/following lists + follow-request visibility
--
-- 1. follow_list(profile, kind) RPC
--    Returns the accepted follower or following profiles for a
--    given profile, enforcing the privacy tiers server-side:
--      · the profile owner always sees their own lists
--      · public profiles      → anyone (authenticated) can see
--      · friends-only profile → only mutual friends can see
--      · private profile      → owner only
--    SECURITY DEFINER so the owner can see followers whose own
--    profiles are private (normal RLS would hide those rows).
--
-- 2. profiles_follow_party_select RLS policy
--    Lets you SELECT the profile of anyone with a follow edge
--    to/from you (pending or accepted). Needed so the
--    notifications panel can show who sent a follow request,
--    even when the requester's profile is private.
--
-- Safe to re-run.
-- ============================================================

CREATE OR REPLACE FUNCTION public.follow_list(p_profile uuid, p_kind text)
RETURNS TABLE (
  id           uuid,
  username     text,
  display_name text,
  avatar_url   text,
  is_official  boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_privacy text;
  v_allowed boolean := false;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN;
  END IF;
  IF p_kind NOT IN ('followers', 'following') THEN
    RAISE EXCEPTION 'follow_list: kind must be followers or following';
  END IF;

  SELECT p.privacy::text INTO v_privacy FROM public.profiles p WHERE p.id = p_profile;
  IF v_privacy IS NULL THEN
    RETURN; -- no such profile
  END IF;

  IF auth.uid() = p_profile THEN
    v_allowed := true;                       -- own lists, always
  ELSIF v_privacy = 'public' THEN
    v_allowed := true;                       -- public account
  ELSIF v_privacy = 'friends' THEN
    v_allowed :=                             -- mutual friends only
          EXISTS (SELECT 1 FROM public.follows a
                  WHERE a.follower_id = auth.uid() AND a.followed_id = p_profile
                    AND a.status = 'accepted')
      AND EXISTS (SELECT 1 FROM public.follows b
                  WHERE b.follower_id = p_profile AND b.followed_id = auth.uid()
                    AND b.status = 'accepted');
  END IF;
  -- v_privacy = 'private' and not the owner → not allowed

  IF NOT v_allowed THEN
    RETURN;
  END IF;

  IF p_kind = 'followers' THEN
    RETURN QUERY
      SELECT pr.id, pr.username::text, pr.display_name, pr.avatar_url, pr.is_official
      FROM public.follows f
      JOIN public.profiles pr ON pr.id = f.follower_id
      WHERE f.followed_id = p_profile AND f.status = 'accepted'
      ORDER BY f.created_at DESC;
  ELSE
    RETURN QUERY
      SELECT pr.id, pr.username::text, pr.display_name, pr.avatar_url, pr.is_official
      FROM public.follows f
      JOIN public.profiles pr ON pr.id = f.followed_id
      WHERE f.follower_id = p_profile AND f.status = 'accepted'
      ORDER BY f.created_at DESC;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.follow_list(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.follow_list(uuid, text) TO authenticated;

-- ─────────────────────────────────────────────────────────────
-- Profiles of your follow-parties are visible to you (so the
-- follow-request panel can render private requesters).
-- follows policies don't reference profiles, so no RLS recursion.
-- ─────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS profiles_follow_party_select ON public.profiles;
CREATE POLICY profiles_follow_party_select ON public.profiles
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.follows f
    WHERE (f.follower_id = profiles.id AND f.followed_id = auth.uid())
       OR (f.followed_id = profiles.id AND f.follower_id = auth.uid())
  ));
