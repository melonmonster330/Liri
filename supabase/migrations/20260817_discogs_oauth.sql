-- ============================================================
-- Discogs OAuth + collection sync — tables
-- Run in the Supabase SQL editor. Safe to re-run (IF NOT EXISTS).
--
-- Both tables hold OAuth token secrets, so they are SERVICE-ROLE ONLY:
-- RLS is enabled with NO client policies, meaning the anon/authenticated
-- roles can't read or write them. The app only ever touches these through
-- the server endpoints (api/discogs-*.js), which use the service role key.
-- The browser never sees a user's Discogs tokens.
-- ============================================================


-- -----------------------------------------------------------
-- discogs_oauth_pending
-- Short-lived request tokens created during the OAuth handshake.
-- One row per in-flight "Connect Discogs" attempt. The callback
-- looks the row up by oauth_token to recover the request-token
-- secret and which Liri user started the flow. Deleted on success;
-- stale rows (>15 min) can be swept.
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS discogs_oauth_pending (
  oauth_token         text        PRIMARY KEY,       -- request token
  oauth_token_secret  text        NOT NULL,          -- request token secret
  user_id             uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE discogs_oauth_pending ENABLE ROW LEVEL SECURITY;
-- No policies: service role only.


-- -----------------------------------------------------------
-- user_discogs_accounts
-- One row per Liri user who has connected a Discogs account.
-- Holds the long-lived OAuth access token (does not expire unless
-- the user revokes it on Discogs). Used server-side to read the
-- user's collection on their behalf.
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_discogs_accounts (
  user_id             uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  discogs_user_id     bigint,
  discogs_username    text        NOT NULL,
  oauth_token         text        NOT NULL,          -- access token
  oauth_token_secret  text        NOT NULL,          -- access token secret (never sent to client)
  connected_at        timestamptz NOT NULL DEFAULT now(),
  last_synced_at      timestamptz
);

CREATE INDEX IF NOT EXISTS idx_user_discogs_accounts_username
  ON user_discogs_accounts (lower(discogs_username));

ALTER TABLE user_discogs_accounts ENABLE ROW LEVEL SECURITY;
-- No policies: service role only. Clients read connection status via
-- /api/discogs-status (which returns username + timestamps, never tokens).


-- -----------------------------------------------------------
-- user_discogs_collection
-- Staging table for records imported from a user's Discogs collection.
-- Deliberately SEPARATE from user_library so a raw Discogs record that
-- hasn't been matched to iTunes yet can't reach the turntable picker
-- (which keys strictly on itunes_collection_id). Enrichment matches
-- each row to iTunes lazily and promotes matched albums into user_library.
--
-- Keyed on (user_id, discogs_release_id, discogs_instance_id) because
-- Discogs allows owning multiple copies of the same release, each with
-- its own instance id — so re-imports update instead of duplicating.
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_discogs_collection (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  discogs_release_id    bigint      NOT NULL,
  discogs_instance_id   bigint      NOT NULL DEFAULT 0,   -- 0 = single/unknown copy
  artist_name           text,
  album_name            text,
  release_year          int,
  thumb_url             text,                              -- list-level thumbnail from the collection API
  itunes_collection_id  text,                              -- filled in later by enrichment (nullable on import)
  enrichment_status     text        NOT NULL DEFAULT 'owned',  -- owned → enriching → ready | unavailable
  added_at              timestamptz NOT NULL DEFAULT now(), -- when Discogs says it was added to their collection
  imported_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, discogs_release_id, discogs_instance_id)
);

CREATE INDEX IF NOT EXISTS idx_user_discogs_collection_user
  ON user_discogs_collection (user_id, added_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_discogs_collection_status
  ON user_discogs_collection (user_id, enrichment_status);

ALTER TABLE user_discogs_collection ENABLE ROW LEVEL SECURITY;

-- Users may read their own imported collection (no secrets here).
CREATE POLICY "Users read own discogs collection"
  ON user_discogs_collection FOR SELECT
  USING (auth.uid() = user_id);

-- Writes happen server-side (service role) during import/enrichment.
</content>
