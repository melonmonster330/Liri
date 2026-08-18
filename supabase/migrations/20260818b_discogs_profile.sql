-- Store a bit of Discogs profile info so the Settings section can show who
-- you're connected as (email, avatar, collection size). Populated lazily by
-- /api/discogs-status on first read. Depends on 20260817_discogs_oauth.sql.
-- Safe to re-run.

ALTER TABLE user_discogs_accounts ADD COLUMN IF NOT EXISTS discogs_email          text;
ALTER TABLE user_discogs_accounts ADD COLUMN IF NOT EXISTS discogs_avatar_url     text;
ALTER TABLE user_discogs_accounts ADD COLUMN IF NOT EXISTS discogs_num_collection int;
