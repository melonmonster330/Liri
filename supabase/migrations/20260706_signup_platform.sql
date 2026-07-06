-- ============================================================
-- Liri — record where a user signed up (web vs iOS App Store)
--
-- The app passes { signup_platform: 'ios' | 'web' } in the signUp
-- metadata. The profile-creation trigger copies it onto the profile
-- so the admin dashboard can show acquisition source.
--
-- Existing users have NULL here; the admin falls back to inferring
-- from their listening_events.platform.
--
-- Safe to re-run.
-- ============================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS signup_platform text
    CHECK (signup_platform IN ('ios', 'web'));

-- Recreate the signup trigger to also stamp signup_platform from the
-- auth metadata the app sends at sign-up time.
CREATE OR REPLACE FUNCTION public.handle_new_user_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_platform text := NEW.raw_user_meta_data->>'signup_platform';
BEGIN
  IF v_platform IS NOT NULL AND v_platform NOT IN ('ios', 'web') THEN
    v_platform := NULL;
  END IF;
  INSERT INTO public.profiles (id, username, signup_platform)
  VALUES (NEW.id, public.generate_random_username(), v_platform)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;
