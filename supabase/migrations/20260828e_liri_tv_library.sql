-- Standalone Samsung TV browsing uses the device secret, never a stored user
-- access token. These RPCs expose only the linked account's library data.
CREATE OR REPLACE FUNCTION get_liri_tv_library(p_device_id uuid, p_token text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions
AS $$
DECLARE
  device_row liri_devices;
  albums jsonb;
BEGIN
  SELECT * INTO device_row FROM liri_devices
  WHERE id = p_device_id
    AND token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');
  IF device_row.id IS NULL OR device_row.user_id IS NULL THEN
    RAISE EXCEPTION 'TV is not linked';
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'collectionId', ul.itunes_collection_id::text,
    'album', coalesce(c.album_name, ''),
    'artist', coalesce(c.artist_name, ''),
    'artwork', c.artwork_url
  ) ORDER BY ul.added_at DESC), '[]'::jsonb)
  INTO albums
  FROM user_library ul
  LEFT JOIN catalogue c ON c.itunes_collection_id::text = ul.itunes_collection_id::text
  WHERE ul.user_id = device_row.user_id;

  RETURN jsonb_build_object('name', device_row.name, 'albums', albums);
END;
$$;

CREATE OR REPLACE FUNCTION get_liri_tv_album(
  p_device_id uuid, p_token text, p_collection_id text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions
AS $$
DECLARE
  device_row liri_devices;
  tracks jsonb;
BEGIN
  SELECT * INTO device_row FROM liri_devices
  WHERE id = p_device_id
    AND token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');
  IF device_row.id IS NULL OR device_row.user_id IS NULL THEN
    RAISE EXCEPTION 'TV is not linked';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM user_library ul
    WHERE ul.user_id = device_row.user_id
      AND ul.itunes_collection_id::text = p_collection_id
  ) THEN RAISE EXCEPTION 'Album not in library'; END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', at.itunes_track_id::text,
    'title', at.track_name,
    'artist', at.artist_name,
    'number', at.track_number,
    'lrc', tl.lrc_raw,
    'plainLyrics', tl.lyrics_plain
  ) ORDER BY at.disc_number, at.track_number), '[]'::jsonb)
  INTO tracks
  FROM album_tracks at
  LEFT JOIN track_lyrics tl ON tl.itunes_track_id::text = at.itunes_track_id::text
  WHERE at.itunes_collection_id::text = p_collection_id;

  RETURN jsonb_build_object('tracks', tracks);
END;
$$;

REVOKE ALL ON FUNCTION get_liri_tv_library(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION get_liri_tv_album(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_liri_tv_library(uuid,text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION get_liri_tv_album(uuid,text,text) TO anon, authenticated;
