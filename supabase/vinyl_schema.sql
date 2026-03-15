-- ============================================================
-- Liri Vinyl Database — run this once in the Supabase SQL editor
-- ============================================================

-- -----------------------------------------------------------
-- vinyl_releases
-- One row per unique pressing / edition of a record.
-- The same album (e.g. Abbey Road) can have many rows:
--   UK original, US pressing, 2019 remaster, colored vinyl, etc.
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS vinyl_releases (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Link to iTunes for auto-populate (can be null for manual entries)
  itunes_collection_id  text,

  -- Core album identity
  album_name            text        NOT NULL,
  artist_name           text        NOT NULL,

  -- Pressing / edition details (what makes each version unique)
  release_year          int,
  record_label          text,
  catalog_number        text,       -- e.g. "PCS 7088" — strongest unique identifier
  country               text,       -- country of this pressing
  edition               text,       -- e.g. "Target Exclusive", "Box Set"
  version_note          text,       -- e.g. "Red vinyl", "Picture disc", "2023 Remaster"

  -- Physical format
  disc_count            int         NOT NULL DEFAULT 1,   -- number of LPs in the release

  -- Artwork (from iTunes or user-supplied)
  artwork_url           text,

  -- Community health
  submitted_by          uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  confirmed_count       int         NOT NULL DEFAULT 1,
  is_verified           boolean     NOT NULL DEFAULT false,  -- manually verified by Liri team

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------
-- vinyl_tracks
-- One row per track, with exact side / position metadata.
-- positions follow vinyl convention: A1, A2, B1, B2, C1, ...
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS vinyl_tracks (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id            uuid        NOT NULL REFERENCES vinyl_releases(id) ON DELETE CASCADE,

  -- Physical location on the record
  disc_number           int         NOT NULL DEFAULT 1,  -- which LP (1, 2, 3 ...)
  side                  text        NOT NULL,            -- "A", "B", "C", "D" ...
  position              text        NOT NULL,            -- "A1", "A2", "B1" ...
  track_number_on_side  int         NOT NULL,            -- 1, 2, 3 ... within the side

  -- Track info
  title                 text        NOT NULL,
  duration_ms           int,                            -- from iTunes
  itunes_track_id       text,                           -- reference back to iTunes

  created_at            timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------
-- user_vinyl_library  — personal "my records" list per user
-- Lightweight: only requires an iTunes collection ID, no
-- dependency on a community vinyl_releases entry existing.
-- Powers the "What's on the turntable?" selector in the app.
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

CREATE POLICY "users manage own vinyl library"
  ON user_vinyl_library FOR ALL
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- -----------------------------------------------------------
-- user_vinyl_collections  (future — tag records you own)
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_vinyl_collections (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  release_id            uuid        NOT NULL REFERENCES vinyl_releases(id) ON DELETE CASCADE,
  added_at              timestamptz NOT NULL DEFAULT now(),
  notes                 text,       -- personal notes ("Got this at Amoeba 2024")
  UNIQUE (user_id, release_id)
);

-- -----------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_vinyl_releases_itunes
  ON vinyl_releases (itunes_collection_id);

CREATE INDEX IF NOT EXISTS idx_vinyl_releases_album_artist
  ON vinyl_releases (lower(album_name), lower(artist_name));

CREATE INDEX IF NOT EXISTS idx_vinyl_tracks_release
  ON vinyl_tracks (release_id, disc_number, side, track_number_on_side);

CREATE INDEX IF NOT EXISTS idx_user_vinyl_collections_user
  ON user_vinyl_collections (user_id);

-- -----------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------
ALTER TABLE vinyl_releases         ENABLE ROW LEVEL SECURITY;
ALTER TABLE vinyl_tracks           ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_vinyl_collections ENABLE ROW LEVEL SECURITY;

-- vinyl_releases: anyone can read; authenticated users can submit
CREATE POLICY "Public read releases"
  ON vinyl_releases FOR SELECT USING (true);

CREATE POLICY "Auth insert releases"
  ON vinyl_releases FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Submitter update releases"
  ON vinyl_releases FOR UPDATE
  USING (auth.uid() = submitted_by);

-- vinyl_tracks: same pattern
CREATE POLICY "Public read tracks"
  ON vinyl_tracks FOR SELECT USING (true);

CREATE POLICY "Auth insert tracks"
  ON vinyl_tracks FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

-- user_vinyl_collections: users manage only their own rows
CREATE POLICY "Own collection only"
  ON user_vinyl_collections FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- -----------------------------------------------------------
-- Auto-update updated_at on vinyl_releases
-- -----------------------------------------------------------
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON vinyl_releases
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- -----------------------------------------------------------
-- Play count aggregation for vinyl library ordering
-- Returns play counts per itunes_collection_id from listening_events.
-- Used by vinyl.html to sort releases by most played on Liri.
-- Run this once in the Supabase SQL editor to create the RPC.
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
