-- Let users manage their own imported Discogs collection from the client:
--   UPDATE — mark a record enriched (itunes_collection_id / enrichment_status)
--   DELETE — remove a record they don't want in their library
-- These rows hold no secrets (artist/album/thumb), so own-row access is safe.
-- Depends on 20260817_discogs_oauth.sql. Safe to re-run.

DROP POLICY IF EXISTS "Users update own discogs collection" ON user_discogs_collection;
CREATE POLICY "Users update own discogs collection"
  ON user_discogs_collection FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users delete own discogs collection" ON user_discogs_collection;
CREATE POLICY "Users delete own discogs collection"
  ON user_discogs_collection FOR DELETE
  USING (auth.uid() = user_id);
