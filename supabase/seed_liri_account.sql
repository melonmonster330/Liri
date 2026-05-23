-- ============================================================
-- Liri — seed the official @liri announcement account
--
-- PREREQ: run migration 20260522c_official_accounts.sql first
-- (adds profiles.is_official).
--
-- Run this in the Supabase SQL editor as postgres / service role.
-- Idempotent: re-running is safe.
--
-- What it does:
--   1. Inserts an auth.users row with a known UUID and a random
--      strong password (you'll never need to sign in as it manually).
--   2. The existing on-signup trigger creates a profiles row with
--      a random username.
--   3. UPDATE customizes that profile: username='liri',
--      display_name='Liri', bio, privacy=public, is_official=true.
--
-- If you'd rather create the account by signing up through the app
-- first, skip step 1 below and just run the UPDATE at the bottom
-- using the new account's UUID.
-- ============================================================

DO $$
DECLARE
  liri_id uuid := '00000000-0000-0000-0000-00000000l1r1';
BEGIN
  -- can't put non-hex chars in uuid literal; build it deterministic
  liri_id := '00000000-0000-0000-0000-000000000001'::uuid;

  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = liri_id) THEN
    INSERT INTO auth.users (
      instance_id, id, aud, role,
      email, encrypted_password,
      email_confirmed_at, created_at, updated_at,
      raw_app_meta_data, raw_user_meta_data,
      is_super_admin, confirmation_token,
      email_change, email_change_token_new, recovery_token
    ) VALUES (
      '00000000-0000-0000-0000-000000000000',
      liri_id,
      'authenticated', 'authenticated',
      'liri@getliri.com',
      crypt(encode(gen_random_bytes(24), 'hex'), gen_salt('bf')),
      now(), now(), now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      '{"system_account": true}'::jsonb,
      false, '', '', '', ''
    );
  END IF;

  -- The on_auth_user_created_profile trigger has now created a
  -- profiles row with a random username. Customize it.
  UPDATE public.profiles
     SET username     = 'liri',
         display_name = 'Liri',
         bio          = 'The official Liri account. Announcements, updates, and the occasional record we''re obsessed with.',
         privacy      = 'public',
         is_official  = true
   WHERE id = liri_id;
END $$;

-- Sanity check: confirm the account exists and looks right.
SELECT id, username, display_name, privacy, is_official
  FROM public.profiles
 WHERE id = '00000000-0000-0000-0000-000000000001'::uuid;
