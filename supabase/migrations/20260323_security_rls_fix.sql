-- ============================================================
-- Liri Security Remediation Migration
-- Pentest findings: CPU Defender LLC, 2026-03-18
-- Resolves: LIR-001 (RLS disabled), LIR-002 (usage counter reset),
--           LIR-004 (cast session hijack), LIR-006 (activity exposure)
--
-- Safe to run on an existing database.
-- All DROP POLICY IF EXISTS before CREATE so this is re-runnable.
-- Run in the Supabase SQL editor as the postgres / service role.
-- ============================================================


-- ─────────────────────────────────────────────────────────────
-- 1. ENSURE RLS IS ENABLED ON ALL TABLES
--    No-ops if already enabled.
-- ─────────────────────────────────────────────────────────────

ALTER TABLE user_usage         ENABLE ROW LEVEL SECURITY;
ALTER TABLE song_history       ENABLE ROW LEVEL SECURITY;
ALTER TABLE cast_sessions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE listening_events   ENABLE ROW LEVEL SECURITY;
ALTER TABLE flip_events        ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_vinyl_library ENABLE ROW LEVEL SECURITY;
ALTER TABLE vinyl_releases     ENABLE ROW LEVEL SECURITY;
ALTER TABLE vinyl_tracks       ENABLE ROW LEVEL SECURITY;
ALTER TABLE liri_lyric_cache   ENABLE ROW LEVEL SECURITY;


-- ─────────────────────────────────────────────────────────────
-- 2. user_usage
--
-- LIR-002 FIX: Remove the client-side UPDATE policy.
-- Previously any authenticated user could write recognition_count = 0
-- for any user_id from the browser console, giving free unlimited access.
-- After this migration, UPDATE is service_role only.
-- /api/recognize must use the SUPABASE_SERVICE_ROLE_KEY to increment
-- the counter server-side after a successful recognition.
-- ─────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Users update own usage" ON user_usage;
DROP POLICY IF EXISTS "Users read own usage"   ON user_usage;
DROP POLICY IF EXISTS "Users insert own usage" ON user_usage;

-- Client can SELECT (to display count in the UI)
CREATE POLICY "Users read own usage"
  ON user_usage FOR SELECT
  USING (auth.uid() = user_id);

-- Client can INSERT the first row (when the user has never recognized a song)
CREATE POLICY "Users insert own usage"
  ON user_usage FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- No UPDATE policy for clients. UPDATE is service_role only.
-- ⚠️  After applying this migration, the client-side upsert in app.js
--     (sb.from("user_usage").upsert({...})) will silently fail because
--     upsert = INSERT + UPDATE and UPDATE is now blocked.
--     See Prompt 3 to move usage increment to /api/recognize server-side.


-- ─────────────────────────────────────────────────────────────
-- 3. cast_sessions
--
-- LIR-004 FIX: Restrict UPDATE to session owner.
-- Previously any authenticated user could overwrite any cast session,
-- allowing TV display takeover (inject arbitrary song/lyrics onto any TV).
-- SELECT stays public — the TV receiver page (tv.html) is unauthenticated
-- and needs to read sessions by room_code.
-- ─────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Public read cast sessions"  ON cast_sessions;
DROP POLICY IF EXISTS "Auth upsert cast sessions"  ON cast_sessions;
DROP POLICY IF EXISTS "Auth update cast sessions"  ON cast_sessions;
DROP POLICY IF EXISTS "Owner insert cast sessions" ON cast_sessions;
DROP POLICY IF EXISTS "Owner update cast sessions" ON cast_sessions;

-- TV display reads by room_code — must stay public
CREATE POLICY "Public read cast sessions"
  ON cast_sessions FOR SELECT USING (true);

-- Only the session owner can create their session
CREATE POLICY "Owner insert cast sessions"
  ON cast_sessions FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Only the session owner can update their session (no more TV takeover)
CREATE POLICY "Owner update cast sessions"
  ON cast_sessions FOR UPDATE
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);


-- ─────────────────────────────────────────────────────────────
-- 4. song_history — re-apply clean policy (LIR-006)
-- ─────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Users manage own history" ON song_history;

CREATE POLICY "Users manage own history"
  ON song_history FOR ALL
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);


-- ─────────────────────────────────────────────────────────────
-- 5. listening_events — re-apply (LIR-006)
--    Anonymous sessions (session_id only, no user_id) may INSERT.
--    Users may only SELECT their own rows.
-- ─────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Auth insert listening events"      ON listening_events;
DROP POLICY IF EXISTS "Users read own listening events"   ON listening_events;
DROP POLICY IF EXISTS "Users insert own listening events" ON listening_events;

CREATE POLICY "Users read own listening events"
  ON listening_events FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users insert own listening events"
  ON listening_events FOR INSERT
  WITH CHECK (auth.uid() = user_id OR user_id IS NULL);


-- ─────────────────────────────────────────────────────────────
-- 6. flip_events — re-apply (LIR-006)
-- ─────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Auth insert flip events"      ON flip_events;
DROP POLICY IF EXISTS "Users read own flip events"   ON flip_events;
DROP POLICY IF EXISTS "Users insert own flip events" ON flip_events;

CREATE POLICY "Users read own flip events"
  ON flip_events FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users insert own flip events"
  ON flip_events FOR INSERT
  WITH CHECK (auth.uid() = user_id OR user_id IS NULL);


-- ─────────────────────────────────────────────────────────────
-- 7. user_vinyl_library — re-apply (LIR-001)
-- ─────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Users manage own vinyl library" ON user_vinyl_library;

CREATE POLICY "Users manage own vinyl library"
  ON user_vinyl_library FOR ALL
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);


-- ─────────────────────────────────────────────────────────────
-- 8. vinyl_releases — shared reference data (LIR-001)
--    Public read, auth write, service_role DELETE only.
-- ─────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Public read releases"      ON vinyl_releases;
DROP POLICY IF EXISTS "Auth insert releases"      ON vinyl_releases;
DROP POLICY IF EXISTS "Submitter update releases" ON vinyl_releases;
DROP POLICY IF EXISTS "Auth delete releases"      ON vinyl_releases;

CREATE POLICY "Public read releases"
  ON vinyl_releases FOR SELECT USING (true);

CREATE POLICY "Auth insert releases"
  ON vinyl_releases FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Submitter update releases"
  ON vinyl_releases FOR UPDATE
  USING (auth.uid() = submitted_by);

-- No DELETE policy for clients — service_role only.


-- ─────────────────────────────────────────────────────────────
-- 9. vinyl_tracks — shared reference data (LIR-001)
-- ─────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Public read tracks" ON vinyl_tracks;
DROP POLICY IF EXISTS "Auth insert tracks" ON vinyl_tracks;
DROP POLICY IF EXISTS "Auth delete tracks" ON vinyl_tracks;

CREATE POLICY "Public read tracks"
  ON vinyl_tracks FOR SELECT USING (true);

CREATE POLICY "Auth insert tracks"
  ON vinyl_tracks FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

-- No DELETE policy for clients — service_role only.


-- ─────────────────────────────────────────────────────────────
-- 10. liri_lyric_cache — shared reference data (LIR-001)
-- ─────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Public read lyric cache"  ON liri_lyric_cache;
DROP POLICY IF EXISTS "Auth insert lyric cache"  ON liri_lyric_cache;
DROP POLICY IF EXISTS "Auth update lyric cache"  ON liri_lyric_cache;
DROP POLICY IF EXISTS "Auth delete lyric cache"  ON liri_lyric_cache;

CREATE POLICY "Public read lyric cache"
  ON liri_lyric_cache FOR SELECT USING (true);

CREATE POLICY "Auth insert lyric cache"
  ON liri_lyric_cache FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Auth update lyric cache"
  ON liri_lyric_cache FOR UPDATE
  USING (auth.uid() IS NOT NULL);

-- No DELETE policy for clients — service_role only.
