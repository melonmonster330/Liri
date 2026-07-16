-- Count album plays, not songs played.
--
-- get_collection_play_counts previously returned COUNT(*) of listening_events
-- per album, which counts every song row — a 12-track side inflated a single
-- listen into 12 "plays". A play should mean "the record was put on", i.e. an
-- album load. Dropping a record on fires one recognition/shazam/turntable_jump
-- event and the rest of the side plays through as auto_advance rows, so we count
-- only the non-auto_advance events. Null-safe: legacy rows with a null source
-- still count as a play (matches stats.html's `source !== "auto_advance"`).

CREATE OR REPLACE FUNCTION get_collection_play_counts()
RETURNS TABLE(collection_id text, play_count bigint)
LANGUAGE sql STABLE SECURITY INVOKER
AS $$
  SELECT
    itunes_collection_id::text AS collection_id,
    COUNT(*) FILTER (WHERE source IS DISTINCT FROM 'auto_advance') AS play_count
  FROM listening_events
  WHERE itunes_collection_id IS NOT NULL
    AND user_id = auth.uid()
  GROUP BY itunes_collection_id
  ORDER BY play_count DESC;
$$;
