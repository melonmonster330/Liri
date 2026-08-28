CREATE OR REPLACE FUNCTION publish_liri_session(
  p_device_id text,
  p_device_name text,
  p_song_title text,
  p_song_artist text,
  p_song_album text,
  p_artwork_url text,
  p_lyrics_json jsonb,
  p_playback_position numeric,
  p_paused boolean,
  p_mode text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_session liri_active_sessions;
  different_song boolean;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in required'; END IF;
  SELECT * INTO current_session FROM liri_active_sessions WHERE user_id = auth.uid() FOR UPDATE;
  different_song := current_session.user_id IS NULL
    OR lower(current_session.song_title) <> lower(coalesce(p_song_title, ''))
    OR lower(current_session.song_artist) <> lower(coalesce(p_song_artist, ''));

  IF current_session.user_id IS NOT NULL
     AND current_session.owner_device_id <> p_device_id
     AND current_session.active
     AND NOT different_song THEN
    UPDATE liri_active_sessions SET
      lyrics_json = CASE
        WHEN jsonb_array_length(coalesce(p_lyrics_json, '[]'::jsonb)) > 0
          THEN p_lyrics_json
        ELSE lyrics_json
      END,
      artwork_url = coalesce(p_artwork_url, artwork_url),
      song_album = coalesce(nullif(p_song_album, ''), song_album),
      revision = revision + 1,
      updated_at = now()
    WHERE user_id = auth.uid();
    RETURN false;
  END IF;

  INSERT INTO liri_active_sessions (
    user_id, owner_device_id, owner_device_name, song_title, song_artist,
    song_album, artwork_url, lyrics_json, playback_position, paused,
    anchor_at, mode, active, revision, updated_at
  ) VALUES (
    auth.uid(), p_device_id, left(coalesce(p_device_name, 'Liri'), 80),
    coalesce(p_song_title, ''), coalesce(p_song_artist, ''), coalesce(p_song_album, ''),
    p_artwork_url, coalesce(p_lyrics_json, '[]'::jsonb), greatest(coalesce(p_playback_position, 0), 0),
    coalesce(p_paused, false), now(), coalesce(p_mode, 'syncing'), true, 1, now()
  ) ON CONFLICT (user_id) DO UPDATE SET
    owner_device_id = EXCLUDED.owner_device_id,
    owner_device_name = EXCLUDED.owner_device_name,
    song_title = EXCLUDED.song_title,
    song_artist = EXCLUDED.song_artist,
    song_album = EXCLUDED.song_album,
    artwork_url = EXCLUDED.artwork_url,
    lyrics_json = EXCLUDED.lyrics_json,
    playback_position = EXCLUDED.playback_position,
    paused = EXCLUDED.paused,
    anchor_at = now(), mode = EXCLUDED.mode, active = true,
    revision = liri_active_sessions.revision + 1, updated_at = now();
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION publish_liri_session(text,text,text,text,text,text,jsonb,numeric,boolean,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION publish_liri_session(text,text,text,text,text,text,jsonb,numeric,boolean,text) TO authenticated;
