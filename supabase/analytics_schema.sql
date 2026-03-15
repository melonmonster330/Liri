-- ─────────────────────────────────────────────────────────────────────────────
-- Liri Analytics Schema
-- Run once in the Supabase SQL editor.
-- Can be run independently — no dependency on vinyl_schema.sql.
-- vinyl_release_id columns store the UUID as plain text references (no FK
-- constraint) so the order you run the two schema files doesn't matter.
--
-- Tables:
--   listening_events  — every song played (recognition + auto-advance)
--   flip_events       — every vinyl side-flip detected
--
-- Views (for Helen's internal rolling dashboard):
--   v_dau_30d         — daily active users, last 30 days
--   v_top_tracks_30d  — top 20 tracks by listen count, last 30 days
--   v_top_artists_30d — top 20 artists, last 30 days
--   v_top_albums_30d  — top 20 albums, last 30 days
--   v_vinyl_mode_rate — % of listens with vinyl mode on, by week
--   v_flip_methods    — flip detection method breakdown (db / learned / heuristic)
--   v_geo_30d         — listen counts by country, last 30 days
--
-- Function:
--   get_user_wrapped(user_id, year) — returns a JSON blob of per-user Wrapped stats
-- ─────────────────────────────────────────────────────────────────────────────


-- ── listening_events ─────────────────────────────────────────────────────────
-- One row per song played. Covers both manual recognition and vinyl auto-advance.

CREATE TABLE IF NOT EXISTS listening_events (
  id                   uuid        DEFAULT gen_random_uuid() PRIMARY KEY,

  -- Identity (nullable so anon listens are still captured)
  user_id              uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  session_id           text,       -- persistent anon ID from localStorage (liri_session_id)

  -- Track info
  track_title          text        NOT NULL,
  artist_name          text        NOT NULL,
  album_name           text,
  artwork_url          text,
  genre                text,       -- primary genre from ACRCloud (e.g. "Pop", "Rock")

  -- Cross-reference keys
  itunes_track_id      bigint,
  itunes_collection_id bigint,
  vinyl_release_id     uuid,       -- soft ref to vinyl_releases.id (no FK so schema is order-independent)

  -- Context
  vinyl_mode_on        boolean     DEFAULT false,
  source               text        DEFAULT 'recognition',  -- 'recognition' | 'auto_advance'
  platform             text,       -- 'web' | 'ios'
  country_code         text,       -- ISO 3166-1 alpha-2 (from Vercel x-vercel-ip-country header)

  -- Playback detail
  playback_offset_s    int,        -- where in the track the user was when it was identified
  track_duration_s     int,        -- full track length in seconds

  -- Recognition quality
  acr_confidence       int,        -- ACRCloud score (0–100); null for auto-advance rows

  listened_at          timestamptz DEFAULT now() NOT NULL
);

-- Indexes used by the analytics views below
CREATE INDEX IF NOT EXISTS idx_le_user_id      ON listening_events (user_id);
CREATE INDEX IF NOT EXISTS idx_le_listened_at  ON listening_events (listened_at DESC);
CREATE INDEX IF NOT EXISTS idx_le_artist       ON listening_events (artist_name);
CREATE INDEX IF NOT EXISTS idx_le_album        ON listening_events (album_name);
CREATE INDEX IF NOT EXISTS idx_le_collection   ON listening_events (itunes_collection_id);
CREATE INDEX IF NOT EXISTS idx_le_country      ON listening_events (country_code);
CREATE INDEX IF NOT EXISTS idx_le_source       ON listening_events (source);

-- RLS: users can read/write their own rows; anon can insert (for session-based rows)
ALTER TABLE listening_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own listening events"
  ON listening_events FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users insert own listening events"
  ON listening_events FOR INSERT
  WITH CHECK (auth.uid() = user_id OR user_id IS NULL);


-- ── flip_events ───────────────────────────────────────────────────────────────
-- One row every time a side-flip is detected and the "Time to flip!" screen appears.

CREATE TABLE IF NOT EXISTS flip_events (
  id                   uuid        DEFAULT gen_random_uuid() PRIMARY KEY,

  user_id              uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  session_id           text,

  -- Album context
  vinyl_release_id     uuid,       -- soft ref to vinyl_releases.id (no FK so schema is order-independent)
  itunes_collection_id bigint,
  album_name           text,
  artist_name          text,

  -- Flip detail
  from_side            text,       -- 'A', 'B', 'C', etc.
  to_side              text,       -- 'B', 'C', 'D', etc.
  detection_method     text,       -- 'db' | 'learned' | 'heuristic'

  flipped_at           timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fe_user_id    ON flip_events (user_id);
CREATE INDEX IF NOT EXISTS idx_fe_flipped_at ON flip_events (flipped_at DESC);
CREATE INDEX IF NOT EXISTS idx_fe_release_id ON flip_events (vinyl_release_id);

ALTER TABLE flip_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own flip events"
  ON flip_events FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users insert own flip events"
  ON flip_events FOR INSERT
  WITH CHECK (auth.uid() = user_id OR user_id IS NULL);


-- ─────────────────────────────────────────────────────────────────────────────
-- ANALYTICS VIEWS  (query these directly in the Supabase SQL editor)
-- These bypass RLS — run them as the postgres/service role in the SQL editor.
-- ─────────────────────────────────────────────────────────────────────────────

-- Daily active users — last 30 days
CREATE OR REPLACE VIEW v_dau_30d AS
SELECT
  date_trunc('day', listened_at)::date AS day,
  COUNT(DISTINCT COALESCE(user_id::text, session_id))  AS active_users,
  COUNT(*)                                              AS total_listens
FROM listening_events
WHERE listened_at >= now() - interval '30 days'
GROUP BY 1
ORDER BY 1 DESC;


-- Top 20 tracks — last 30 days
CREATE OR REPLACE VIEW v_top_tracks_30d AS
SELECT
  track_title,
  artist_name,
  COUNT(*)                                                    AS plays,
  COUNT(DISTINCT COALESCE(user_id::text, session_id))        AS unique_listeners
FROM listening_events
WHERE listened_at >= now() - interval '30 days'
GROUP BY 1, 2
ORDER BY plays DESC
LIMIT 20;


-- Top 20 artists — last 30 days
CREATE OR REPLACE VIEW v_top_artists_30d AS
SELECT
  artist_name,
  COUNT(*)                                                    AS plays,
  COUNT(DISTINCT COALESCE(user_id::text, session_id))        AS unique_listeners,
  COUNT(DISTINCT track_title)                                 AS unique_tracks
FROM listening_events
WHERE listened_at >= now() - interval '30 days'
GROUP BY 1
ORDER BY plays DESC
LIMIT 20;


-- Top 20 albums — last 30 days
CREATE OR REPLACE VIEW v_top_albums_30d AS
SELECT
  album_name,
  artist_name,
  COUNT(*)                                                    AS plays,
  COUNT(DISTINCT COALESCE(user_id::text, session_id))        AS unique_listeners
FROM listening_events
WHERE listened_at >= now() - interval '30 days'
  AND album_name IS NOT NULL
GROUP BY 1, 2
ORDER BY plays DESC
LIMIT 20;


-- Vinyl mode usage rate — by week
CREATE OR REPLACE VIEW v_vinyl_mode_rate AS
SELECT
  date_trunc('week', listened_at)::date       AS week,
  COUNT(*)                                    AS total_listens,
  COUNT(*) FILTER (WHERE vinyl_mode_on)       AS vinyl_listens,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE vinyl_mode_on) / NULLIF(COUNT(*), 0), 1
  )                                           AS vinyl_pct
FROM listening_events
WHERE listened_at >= now() - interval '90 days'
GROUP BY 1
ORDER BY 1 DESC;


-- Flip detection method breakdown — last 30 days
CREATE OR REPLACE VIEW v_flip_methods AS
SELECT
  detection_method,
  COUNT(*)                                    AS flips,
  COUNT(DISTINCT COALESCE(user_id::text, session_id)) AS unique_users
FROM flip_events
WHERE flipped_at >= now() - interval '30 days'
GROUP BY 1
ORDER BY flips DESC;


-- Listen counts by country — last 30 days
CREATE OR REPLACE VIEW v_geo_30d AS
SELECT
  COALESCE(country_code, 'Unknown')                          AS country,
  COUNT(*)                                                   AS listens,
  COUNT(DISTINCT COALESCE(user_id::text, session_id))        AS unique_listeners
FROM listening_events
WHERE listened_at >= now() - interval '30 days'
GROUP BY 1
ORDER BY listens DESC;


-- Source breakdown (recognition vs auto-advance) — last 30 days
CREATE OR REPLACE VIEW v_source_breakdown_30d AS
SELECT
  source,
  COUNT(*)                                                   AS listens,
  COUNT(DISTINCT COALESCE(user_id::text, session_id))        AS unique_users
FROM listening_events
WHERE listened_at >= now() - interval '30 days'
GROUP BY 1
ORDER BY listens DESC;


-- ─────────────────────────────────────────────────────────────────────────────
-- get_user_wrapped(p_user_id, p_year)
-- Returns a single JSON blob of Wrapped stats for a given user + year.
-- Example: SELECT get_user_wrapped('abc-123-...', 2025);
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION get_user_wrapped(p_user_id uuid, p_year int)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'year',             p_year,

    -- Totals
    'total_listens',    COUNT(*),
    'unique_tracks',    COUNT(DISTINCT lower(track_title || '|' || artist_name)),
    'unique_artists',   COUNT(DISTINCT lower(artist_name)),
    'unique_albums',    COUNT(DISTINCT lower(coalesce(album_name, ''))),
    'vinyl_listens',    COUNT(*) FILTER (WHERE vinyl_mode_on),
    'vinyl_pct',        ROUND(100.0 * COUNT(*) FILTER (WHERE vinyl_mode_on) / NULLIF(COUNT(*), 0), 1),

    -- Top 5 tracks
    'top_tracks', (
      SELECT jsonb_agg(t ORDER BY t->>'play_count' DESC)
      FROM (
        SELECT jsonb_build_object(
          'title',      track_title,
          'artist',     artist_name,
          'play_count', COUNT(*)
        ) AS t
        FROM listening_events
        WHERE user_id = p_user_id
          AND EXTRACT(YEAR FROM listened_at) = p_year
        GROUP BY track_title, artist_name
        ORDER BY COUNT(*) DESC
        LIMIT 5
      ) sub
    ),

    -- Top 5 artists
    'top_artists', (
      SELECT jsonb_agg(a ORDER BY a->>'play_count' DESC)
      FROM (
        SELECT jsonb_build_object(
          'artist',     artist_name,
          'play_count', COUNT(*)
        ) AS a
        FROM listening_events
        WHERE user_id = p_user_id
          AND EXTRACT(YEAR FROM listened_at) = p_year
        GROUP BY artist_name
        ORDER BY COUNT(*) DESC
        LIMIT 5
      ) sub
    ),

    -- Top album
    'top_album', (
      SELECT jsonb_build_object('album', album_name, 'artist', artist_name, 'plays', COUNT(*))
      FROM listening_events
      WHERE user_id = p_user_id
        AND EXTRACT(YEAR FROM listened_at) = p_year
        AND album_name IS NOT NULL
      GROUP BY album_name, artist_name
      ORDER BY COUNT(*) DESC
      LIMIT 1
    ),

    -- Top genre
    'top_genre', (
      SELECT genre
      FROM listening_events
      WHERE user_id = p_user_id
        AND EXTRACT(YEAR FROM listened_at) = p_year
        AND genre IS NOT NULL
      GROUP BY genre
      ORDER BY COUNT(*) DESC
      LIMIT 1
    ),

    -- Vinyl flips
    'total_flips', (
      SELECT COUNT(*)
      FROM flip_events
      WHERE user_id = p_user_id
        AND EXTRACT(YEAR FROM flipped_at) = p_year
    ),

    -- First song of the year
    'first_song', (
      SELECT jsonb_build_object('title', track_title, 'artist', artist_name, 'listened_at', listened_at)
      FROM listening_events
      WHERE user_id = p_user_id
        AND EXTRACT(YEAR FROM listened_at) = p_year
      ORDER BY listened_at ASC
      LIMIT 1
    ),

    -- Most active month
    'most_active_month', (
      SELECT to_char(date_trunc('month', listened_at), 'Month YYYY')
      FROM listening_events
      WHERE user_id = p_user_id
        AND EXTRACT(YEAR FROM listened_at) = p_year
      GROUP BY date_trunc('month', listened_at)
      ORDER BY COUNT(*) DESC
      LIMIT 1
    )

  ) INTO result
  FROM listening_events
  WHERE user_id = p_user_id
    AND EXTRACT(YEAR FROM listened_at) = p_year;

  RETURN COALESCE(result, '{}'::jsonb);
END;
$$;
