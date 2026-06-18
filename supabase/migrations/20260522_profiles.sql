-- ============================================================
-- Liri — profiles table (social pivot, step 1)
--
-- Adds public.profiles, one row per auth.users user.
-- Auto-created on signup via trigger. Existing users backfilled
-- with a random username (user_<8hex>); they can change it later
-- via the username-change flow.
--
-- Privacy is stored here but enforced by app logic + future RLS
-- once the follow graph exists. For now: profiles are readable by
-- their owner and (for public profiles) by anyone authenticated.
--
-- Safe to re-run.
-- Run in the Supabase SQL editor as postgres / service role.
-- ============================================================

-- citext for case-insensitive unique usernames
CREATE EXTENSION IF NOT EXISTS citext;

-- ─────────────────────────────────────────────────────────────
-- 1. profiles table
-- ─────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE profile_privacy AS ENUM ('private','friends','public');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.profiles (
  id              uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username        citext UNIQUE NOT NULL,
  display_name    text,
  avatar_url      text,
  bio             text,
  privacy         profile_privacy NOT NULL DEFAULT 'private',
  auto_post_plays boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- enforce username shape: 3-20 chars, lowercase a-z, 0-9, underscore
  CONSTRAINT profiles_username_format CHECK (username ~ '^[a-z0-9_]{3,20}$')
);

CREATE INDEX IF NOT EXISTS profiles_username_idx ON public.profiles (username);

-- ─────────────────────────────────────────────────────────────
-- 2. Random username helper + signup trigger
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.generate_random_username()
RETURNS citext
LANGUAGE plpgsql
AS $$
DECLARE
  candidate citext;
  tries int := 0;
BEGIN
  LOOP
    candidate := ('user_' || substring(md5(random()::text || clock_timestamp()::text) FROM 1 FOR 8))::citext;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.profiles WHERE username = candidate);
    tries := tries + 1;
    IF tries > 10 THEN
      RAISE EXCEPTION 'could not generate unique username after 10 tries';
    END IF;
  END LOOP;
  RETURN candidate;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_new_user_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, username)
  VALUES (NEW.id, public.generate_random_username())
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_profile ON auth.users;
CREATE TRIGGER on_auth_user_created_profile
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_profile();

-- ─────────────────────────────────────────────────────────────
-- 3. updated_at maintenance
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.touch_profiles_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_touch_updated_at ON public.profiles;
CREATE TRIGGER profiles_touch_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.touch_profiles_updated_at();

-- ─────────────────────────────────────────────────────────────
-- 4. Backfill existing users
-- ─────────────────────────────────────────────────────────────

INSERT INTO public.profiles (id, username)
SELECT u.id, public.generate_random_username()
FROM auth.users u
LEFT JOIN public.profiles p ON p.id = u.id
WHERE p.id IS NULL;

-- ─────────────────────────────────────────────────────────────
-- 5. RLS
--    For MVP step 1: owner full access; public profiles readable
--    by any authenticated user. Friends-only/private filtering
--    is handled in app code (will tighten once follows table lands).
-- ─────────────────────────────────────────────────────────────

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS profiles_owner_select ON public.profiles;
CREATE POLICY profiles_owner_select ON public.profiles
  FOR SELECT TO authenticated
  USING (id = auth.uid());

DROP POLICY IF EXISTS profiles_public_select ON public.profiles;
CREATE POLICY profiles_public_select ON public.profiles
  FOR SELECT TO authenticated
  USING (privacy = 'public');

DROP POLICY IF EXISTS profiles_owner_update ON public.profiles;
CREATE POLICY profiles_owner_update ON public.profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- No INSERT policy needed — the SECURITY DEFINER trigger handles it.
-- No DELETE policy — profiles cascade-delete with auth.users.
