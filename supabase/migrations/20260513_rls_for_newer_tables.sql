-- ============================================================
-- Liri — RLS for newer tables (added after the 20260323 sweep)
-- Triggered by Supabase Advisor warnings 2026-05-11:
--   • rls_disabled_in_public      — at least one table has RLS off
--   • sensitive_columns_exposed   — user_email / user_id columns readable
--
-- Tables covered (referenced from app/src/main.js + app/library.html
-- but missing from earlier security migrations):
--   user_library     — per-user library (replaces user_vinyl_library)
--   catalogue        — shared album metadata (joined from user_library)
--   album_tracks     — shared track listing per iTunes collection
--   track_lyrics     — shared LRC cache (replaces liri_lyric_cache)
--   vinyl_sides      — shared side mapping per pressing
--   bug_reports      — user-submitted bug reports (user_email, free text)
--   button_events    — UI analytics (user_id + session_id + button_name)
--
-- Safe to run on an existing database. Uses IF EXISTS so missing
-- tables won't error. DROP POLICY IF EXISTS before CREATE so this
-- is fully re-runnable.
-- Run in the Supabase SQL editor as the postgres / service role.
-- ============================================================


-- ─────────────────────────────────────────────────────────────
-- 1. ENABLE RLS ON ALL NEWER TABLES
--    DO blocks make this safe if a table doesn't exist yet.
-- ─────────────────────────────────────────────────────────────

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='user_library')
    THEN ALTER TABLE public.user_library  ENABLE ROW LEVEL SECURITY; END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='catalogue')
    THEN ALTER TABLE public.catalogue     ENABLE ROW LEVEL SECURITY; END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='album_tracks')
    THEN ALTER TABLE public.album_tracks  ENABLE ROW LEVEL SECURITY; END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='track_lyrics')
    THEN ALTER TABLE public.track_lyrics  ENABLE ROW LEVEL SECURITY; END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='vinyl_sides')
    THEN ALTER TABLE public.vinyl_sides   ENABLE ROW LEVEL SECURITY; END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='bug_reports')
    THEN ALTER TABLE public.bug_reports   ENABLE ROW LEVEL SECURITY; END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='button_events')
    THEN ALTER TABLE public.button_events ENABLE ROW LEVEL SECURITY; END IF;
END $$;


-- ─────────────────────────────────────────────────────────────
-- 2. user_library — per-user (replaces user_vinyl_library pattern)
--    Users manage only their own rows. CASCADE on auth.users delete
--    is handled at the table level (not policy).
-- ─────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Users manage own library" ON public.user_library;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='user_library') THEN
    CREATE POLICY "Users manage own library"
      ON public.user_library FOR ALL
      USING       (auth.uid() = user_id)
      WITH CHECK  (auth.uid() = user_id);
  END IF;
END $$;


-- ─────────────────────────────────────────────────────────────
-- 3. catalogue — shared album metadata (joined from user_library)
--    Public read. Auth insert/update so add-vinyl flow can write.
--    No DELETE policy — service_role only.
-- ─────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Public read catalogue"  ON public.catalogue;
DROP POLICY IF EXISTS "Auth insert catalogue"  ON public.catalogue;
DROP POLICY IF EXISTS "Auth update catalogue"  ON public.catalogue;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='catalogue') THEN
    CREATE POLICY "Public read catalogue"
      ON public.catalogue FOR SELECT USING (true);
    CREATE POLICY "Auth insert catalogue"
      ON public.catalogue FOR INSERT
      WITH CHECK (auth.uid() IS NOT NULL);
    CREATE POLICY "Auth update catalogue"
      ON public.catalogue FOR UPDATE
      USING (auth.uid() IS NOT NULL);
  END IF;
END $$;


-- ─────────────────────────────────────────────────────────────
-- 4. album_tracks — shared track listing per iTunes collection.
--    Same shape as vinyl_tracks: public read, auth insert.
-- ─────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Public read album tracks" ON public.album_tracks;
DROP POLICY IF EXISTS "Auth insert album tracks" ON public.album_tracks;
DROP POLICY IF EXISTS "Auth update album tracks" ON public.album_tracks;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='album_tracks') THEN
    CREATE POLICY "Public read album tracks"
      ON public.album_tracks FOR SELECT USING (true);
    CREATE POLICY "Auth insert album tracks"
      ON public.album_tracks FOR INSERT
      WITH CHECK (auth.uid() IS NOT NULL);
    CREATE POLICY "Auth update album tracks"
      ON public.album_tracks FOR UPDATE
      USING (auth.uid() IS NOT NULL);
  END IF;
END $$;


-- ─────────────────────────────────────────────────────────────
-- 5. track_lyrics — shared LRC cache. Public read, auth write.
--    Same pattern as the older liri_lyric_cache.
-- ─────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Public read track lyrics" ON public.track_lyrics;
DROP POLICY IF EXISTS "Auth insert track lyrics" ON public.track_lyrics;
DROP POLICY IF EXISTS "Auth update track lyrics" ON public.track_lyrics;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='track_lyrics') THEN
    CREATE POLICY "Public read track lyrics"
      ON public.track_lyrics FOR SELECT USING (true);
    CREATE POLICY "Auth insert track lyrics"
      ON public.track_lyrics FOR INSERT
      WITH CHECK (auth.uid() IS NOT NULL);
    CREATE POLICY "Auth update track lyrics"
      ON public.track_lyrics FOR UPDATE
      USING (auth.uid() IS NOT NULL);
  END IF;
END $$;


-- ─────────────────────────────────────────────────────────────
-- 6. vinyl_sides — shared side mapping per pressing.
-- ─────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Public read vinyl sides" ON public.vinyl_sides;
DROP POLICY IF EXISTS "Auth insert vinyl sides" ON public.vinyl_sides;
DROP POLICY IF EXISTS "Auth update vinyl sides" ON public.vinyl_sides;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='vinyl_sides') THEN
    CREATE POLICY "Public read vinyl sides"
      ON public.vinyl_sides FOR SELECT USING (true);
    CREATE POLICY "Auth insert vinyl sides"
      ON public.vinyl_sides FOR INSERT
      WITH CHECK (auth.uid() IS NOT NULL);
    CREATE POLICY "Auth update vinyl sides"
      ON public.vinyl_sides FOR UPDATE
      USING (auth.uid() IS NOT NULL);
  END IF;
END $$;


-- ─────────────────────────────────────────────────────────────
-- 7. bug_reports — INSERT only from clients. NO read policy.
--
-- This table contains user_email + freeform description text. It is
-- the most likely cause of the "sensitive_columns_exposed" advisor
-- warning. Lock it down:
--   • Anyone (anon + auth) can INSERT a report (so logged-out users
--     can still report bugs).
--   • Clients cannot SELECT — Helen reads these via the Supabase
--     dashboard (service_role bypasses RLS).
-- ─────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Anyone insert bug reports" ON public.bug_reports;
DROP POLICY IF EXISTS "No client read bug reports" ON public.bug_reports;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='bug_reports') THEN
    CREATE POLICY "Anyone insert bug reports"
      ON public.bug_reports FOR INSERT
      WITH CHECK (true);
    -- No SELECT/UPDATE/DELETE policies — service_role only.
  END IF;
END $$;


-- ─────────────────────────────────────────────────────────────
-- 8. button_events — UI analytics. INSERT from anyone, read own only.
--    Mirrors the listening_events / flip_events pattern.
-- ─────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Anyone insert button events"   ON public.button_events;
DROP POLICY IF EXISTS "Users read own button events"  ON public.button_events;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='button_events') THEN
    CREATE POLICY "Anyone insert button events"
      ON public.button_events FOR INSERT
      WITH CHECK (auth.uid() = user_id OR user_id IS NULL);
    CREATE POLICY "Users read own button events"
      ON public.button_events FOR SELECT
      USING (auth.uid() = user_id);
  END IF;
END $$;


-- ─────────────────────────────────────────────────────────────
-- DONE. Verify in the Supabase dashboard:
--   Authentication → Policies → confirm RLS green dot on every
--   table in the public schema.
-- ─────────────────────────────────────────────────────────────
