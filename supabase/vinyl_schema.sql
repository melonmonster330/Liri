-- ============================================================
-- Liri Database Schema
-- Run once in the Supabase SQL editor (safe to re-run — uses IF NOT EXISTS)
-- Last updated: 2026-03-22
-- ============================================================


-- -----------------------------------------------------------
-- vinyl_releases
-- One row per unique pressing / edition of a record.
-- The same album (e.g. Abbey Road) can have many rows:
--   UK original, US pressing, 2019 remaster, colored vinyl, etc.
-- Populated by add-vinyl.html. Read by index.html and library.html.
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS vinyl_releases (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  itunes_collection_id  text,                           -- iTunes collectionId (text, matches user_vinyl_library)
  album_name            text        NOT NULL,
  artist_name           text        NOT NULL,
  release_year          int,
  record_label          text,
  catalog_number        text,                           -- e.g. "PCS 7088" — strongest unique identifier
  country               text,
  edition               text,                           -- e.g. "Target Exclusive", "Box Set"
  version_note          text,                           -- e.g. "Red vinyl", "2023 Remaster"
  disc_count            int         NOT NULL DEFAULT 1,
  artwork_url           text,
  submitted_by          uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  confirmed_count       int         NOT NULL DEFAULT 1,
  is_verified           boolean     NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vinyl_releases_itunes
  ON vinyl_releases (itunes_collection_id);

CREATE INDEX IF NOT EXISTS idx_vinyl_releases_album_artist
  ON vinyl_releases (lower(album_name), lower(artist_name));

ALTER TABLE vinyl_releases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read releases"
  ON vinyl_releases FOR SELECT USING (true);

CREATE POLICY "Auth insert releases"
  ON vinyl_releases FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Submitter update releases"
  ON vinyl_releases FOR UPDATE
  USING (auth.uid() = submitted_by);

CREATE POLICY "Auth delete releases"
  ON vinyl_releases FOR DELETE
  USING (auth.uid() IS NOT NULL);

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON vinyl_releases
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- -----------------------------------------------------------
-- vinyl_tracks
-- One row per track per pressing, with exact side/position data.
-- Positions follow vinyl convention: A1, A2, B1, B2, C1, ...
-- Populated by add-vinyl.html. Read by index.html for turntable mode.
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS vinyl_tracks (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id            uuid        NOT NULL REFERENCES vinyl_releases(id) ON DELETE CASCADE,
  disc_number           int         NOT NULL DEFAULT 1,  -- which LP (1, 2, 3 ...)
  side                  text        NOT NULL,             -- "A", "B", "C", "D" ...
  position              text        NOT NULL,             -- "A1", "A2", "B1" ...
  track_number_on_side  int         NOT NULL,             -- 1, 2, 3 ... within the side
  title                 text        NOT NULL,
  duration_ms           int,                              -- from iTunes
  itunes_track_id       text,                             -- iTunes trackId (nullable)
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vinyl_tracks_release
  ON vinyl_tracks (release_id, disc_number, side, track_number_on_side);

ALTER TABLE vinyl_tracks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read tracks"
  ON vinyl_tracks FOR SELECT USING (true);

CREATE POLICY "Auth insert tracks"
  ON vinyl_tracks FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Auth delete tracks"
  ON vinyl_tracks FOR DELETE
  USING (auth.uid() IS NOT NULL);


-- -----------------------------------------------------------
-- user_vinyl_library
-- A user's personal "my records" list.
-- Lightweight — only needs an iTunes collection ID.
-- Populated by add-vinyl.html. Powers the turntable album picker.
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_vinyl_library (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  itunes_collection_id  text        NOT NULL,
  album_name            text        NOT NULL,
  artist_name           text        NOT NULL,
  artwork_url           text,
  added_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, itunes_collection_id)
);

CREATE INDEX IF NOT EXISTS idx_user_vinyl_library_user
  ON user_vinyl_library (user_id, added_at DESC);

ALTER TABLE user_vinyl_library ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own vinyl library"
  ON user_vinyl_library FOR ALL
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);


-- -----------------------------------------------------------
-- liri_lyric_cache
-- Synced LRC lyrics cached per track, shared across all users.
-- Populated sequentially at add-vinyl time (300ms between tracks).
-- Read by index.html at turntable album selection — no LRCLib calls at play time.
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS liri_lyric_cache (
  itunes_track_id       bigint      PRIMARY KEY,          -- iTunes trackId (numeric)
  itunes_collection_id  bigint      NOT NULL,              -- iTunes collectionId (numeric)
  track_name            text        NOT NULL,
  artist_name           text        NOT NULL,
  album_name            text,
  track_number          int,
  disc_number           int,
  synced_lyrics         text        NOT NULL,              -- LRC format timestamped lyrics
  cached_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lyric_cache_collection
  ON liri_lyric_cache (itunes_collection_id);

ALTER TABLE liri_lyric_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read lyric cache"
  ON liri_lyric_cache FOR SELECT USING (true);

CREATE POLICY "Auth insert lyric cache"
  ON liri_lyric_cache FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Auth update lyric cache"
  ON liri_lyric_cache FOR UPDATE
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Auth delete lyric cache"
  ON liri_lyric_cache FOR DELETE
  USING (auth.uid() IS NOT NULL);


-- -----------------------------------------------------------
-- user_usage
-- Freemium recognition counter per user.
-- 10 free recognitions per account; test@test.com is unlimited.
-- Read and upserted by index.html on every recognition.
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_usage (
  user_id             uuid    PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  recognition_count   int     NOT NULL DEFAULT 0,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE user_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own usage"
  ON user_usage FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users insert own usage"
  ON user_usage FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update own usage"
  ON user_usage FOR UPDATE
  USING (auth.uid() = user_id);


-- -----------------------------------------------------------
-- song_history
-- Per-user listening history — last 50 shown in sidebar.
-- Inserted on every recognition and auto-advance in index.html.
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS song_history (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title       text        NOT NULL,
  artist      text        NOT NULL,
  album       text,
  artwork_url text,
  listened_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_song_history_user
  ON song_history (user_id, listened_at DESC);

ALTER TABLE song_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own history"
  ON song_history FOR ALL
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);


-- -----------------------------------------------------------
-- listening_events
-- Full analytics log — every recognition and auto-advance.
-- Never updated or deleted. Used by get_collection_play_counts() RPC
-- to sort albums by most-played in vinyl.html.
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS listening_events (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  session_id            text,                             -- random UUID per app session
  track_title           text        NOT NULL,
  artist_name           text,
  album_name            text,
  artwork_url           text,
  genre                 text,
  itunes_track_id       bigint,
  itunes_collection_id  bigint,
  vinyl_release_id      uuid        REFERENCES vinyl_releases(id) ON DELETE SET NULL,
  vinyl_mode_on         boolean     NOT NULL DEFAULT false,
  source                text,                             -- "recognition" | "auto_advance"
  platform              text,                             -- "web" | "ios"
  country_code          text,
  playback_offset_s     int,
  track_duration_s      int,
  acr_confidence        numeric,
  logged_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_listening_events_collection
  ON listening_events (itunes_collection_id);

CREATE INDEX IF NOT EXISTS idx_listening_events_user
  ON listening_events (user_id, logged_at DESC);

ALTER TABLE listening_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Auth insert listening events"
  ON listening_events FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Users read own listening events"
  ON listening_events FOR SELECT
  USING (auth.uid() = user_id);


-- -----------------------------------------------------------
-- flip_events
-- Analytics log for vinyl side flips (user-triggered or heuristic).
-- Inserted by index.html when a side change is detected.
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS flip_events (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  session_id            text,
  vinyl_release_id      uuid        REFERENCES vinyl_releases(id) ON DELETE SET NULL,
  itunes_collection_id  bigint,
  album_name            text,
  artist_name           text,
  from_side             text,                             -- e.g. "A"
  to_side               text,                             -- e.g. "B"
  detection_method      text,                             -- "heuristic" | "user_confirmed"
  logged_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_flip_events_user
  ON flip_events (user_id, logged_at DESC);

ALTER TABLE flip_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Auth insert flip events"
  ON flip_events FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Users read own flip events"
  ON flip_events FOR SELECT
  USING (auth.uid() = user_id);


-- -----------------------------------------------------------
-- cast_sessions
-- Real-time Chromecast / TV browser sync state.
-- One row per room code. Upserted when a song is identified,
-- updated when user nudges timing. Read by the TV receiver page.
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS cast_sessions (
  room_code         text        PRIMARY KEY,
  user_id           uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  song_title        text,
  song_artist       text,
  artwork_url       text,
  lyrics_json       jsonb,                               -- parsed LRC array
  initial_position  numeric,                             -- playback offset in seconds
  detected_at       timestamptz,
  is_active         boolean     NOT NULL DEFAULT true,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE cast_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read cast sessions"
  ON cast_sessions FOR SELECT USING (true);

CREATE POLICY "Auth upsert cast sessions"
  ON cast_sessions FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Auth update cast sessions"
  ON cast_sessions FOR UPDATE
  USING (auth.uid() IS NOT NULL);


-- -----------------------------------------------------------
-- RPC: get_collection_play_counts
-- Returns play counts per itunes_collection_id from listening_events.
-- Used by vinyl.html to sort a user's library by most-played.
-- -----------------------------------------------------------
CREATE OR REPLACE FUNCTION get_collection_play_counts()
RETURNS TABLE(collection_id text, play_count bigint)
LANGUAGE sql STABLE
AS $$
  SELECT
    itunes_collection_id::text AS collection_id,
    COUNT(*)                   AS play_count
  FROM listening_events
  WHERE itunes_collection_id IS NOT NULL
  GROUP BY itunes_collection_id
  ORDER BY play_count DESC;
$$;
