-- Discogs OAuth: remember where the user started the connect flow, so the
-- callback can send them back to that page (e.g. /library) instead of /app.
-- Depends on 20260817_discogs_oauth.sql. Safe to re-run.

ALTER TABLE discogs_oauth_pending
  ADD COLUMN IF NOT EXISTS return_to text;
