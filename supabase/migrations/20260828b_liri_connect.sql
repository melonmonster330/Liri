-- Liri Connect: durable cross-device listening sessions and secure TV linking.
-- TVs never receive a Supabase user token. They authenticate to narrowly scoped
-- SECURITY DEFINER RPCs with a random per-device secret stored only on-device.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS liri_devices (
  id               uuid        PRIMARY KEY,
  user_id          uuid        REFERENCES auth.users(id) ON DELETE CASCADE,
  name             text        NOT NULL DEFAULT 'Liri TV',
  platform         text        NOT NULL DEFAULT 'samsung-tv',
  activation_code  text        UNIQUE,
  token_hash       text        NOT NULL,
  activated_at     timestamptz,
  activation_expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS liri_active_sessions (
  user_id           uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  owner_device_id   text        NOT NULL,
  owner_device_name text        NOT NULL,
  song_title        text        NOT NULL DEFAULT '',
  song_artist       text        NOT NULL DEFAULT '',
  song_album        text        NOT NULL DEFAULT '',
  artwork_url       text,
  lyrics_json       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  playback_position numeric     NOT NULL DEFAULT 0,
  paused             boolean     NOT NULL DEFAULT false,
  anchor_at          timestamptz NOT NULL DEFAULT now(),
  mode               text        NOT NULL DEFAULT 'syncing',
  active             boolean     NOT NULL DEFAULT true,
  revision           bigint      NOT NULL DEFAULT 1,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE liri_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE liri_active_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own Liri devices" ON liri_devices;
CREATE POLICY "Users read own Liri devices"
  ON liri_devices FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users rename own Liri devices" ON liri_devices;
CREATE POLICY "Users rename own Liri devices"
  ON liri_devices FOR UPDATE USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users read own active session" ON liri_active_sessions;
CREATE POLICY "Users read own active session"
  ON liri_active_sessions FOR SELECT USING (auth.uid() = user_id);

-- A pending TV registers itself. Re-registering an existing device is allowed
-- only when the caller proves possession of its original secret.
CREATE OR REPLACE FUNCTION register_liri_device(
  p_device_id uuid,
  p_token text,
  p_activation_code text,
  p_name text DEFAULT 'Samsung TV',
  p_platform text DEFAULT 'samsung-tv'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  existing_hash text;
  supplied_hash text := encode(extensions.digest(p_token, 'sha256'), 'hex');
BEGIN
  IF p_token IS NULL OR length(p_token) < 32 OR p_activation_code !~ '^\d{6}$' THEN
    RAISE EXCEPTION 'Invalid device registration';
  END IF;

  SELECT token_hash INTO existing_hash FROM liri_devices WHERE id = p_device_id;
  IF existing_hash IS NOT NULL AND existing_hash <> supplied_hash THEN
    RAISE EXCEPTION 'Invalid device secret';
  END IF;

  INSERT INTO liri_devices (
    id, token_hash, activation_code, name, platform,
    activation_expires_at, last_seen_at
  ) VALUES (
    p_device_id, supplied_hash, p_activation_code,
    left(coalesce(nullif(p_name, ''), 'Samsung TV'), 80),
    left(coalesce(nullif(p_platform, ''), 'samsung-tv'), 40),
    now() + interval '15 minutes', now()
  )
  ON CONFLICT (id) DO UPDATE SET
    activation_code = CASE WHEN liri_devices.user_id IS NULL THEN EXCLUDED.activation_code ELSE liri_devices.activation_code END,
    activation_expires_at = CASE WHEN liri_devices.user_id IS NULL THEN EXCLUDED.activation_expires_at ELSE liri_devices.activation_expires_at END,
    last_seen_at = now();

  RETURN jsonb_build_object('registered', true);
END;
$$;

CREATE OR REPLACE FUNCTION activate_liri_device(
  p_activation_code text,
  p_name text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  activated liri_devices;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in required'; END IF;

  UPDATE liri_devices SET
    user_id = auth.uid(),
    name = left(coalesce(nullif(p_name, ''), name), 80),
    activated_at = now(),
    activation_code = NULL,
    last_seen_at = now()
  WHERE activation_code = p_activation_code
    AND activation_expires_at > now()
    AND (user_id IS NULL OR user_id = auth.uid())
  RETURNING * INTO activated;

  IF activated.id IS NULL THEN RAISE EXCEPTION 'Invalid or expired TV code'; END IF;
  RETURN jsonb_build_object('id', activated.id, 'name', activated.name, 'platform', activated.platform);
END;
$$;

-- The current source publishes only while it owns the session. A newly
-- detected song can take ownership, which is how playback naturally follows a
-- user who starts a different record on another device.
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
    -- The source may finish fetching lyrics/artwork just after ownership moves
    -- to the TV. Allow that metadata to arrive without reclaiming playback.
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

CREATE OR REPLACE FUNCTION get_liri_tv_state(p_device_id uuid, p_token text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  device_row liri_devices;
  session_row liri_active_sessions;
  position_now numeric;
BEGIN
  SELECT * INTO device_row FROM liri_devices
  WHERE id = p_device_id AND token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');
  IF device_row.id IS NULL THEN RAISE EXCEPTION 'Invalid device'; END IF;
  UPDATE liri_devices SET last_seen_at = now() WHERE id = p_device_id;

  IF device_row.user_id IS NULL THEN
    RETURN jsonb_build_object('activated', false, 'name', device_row.name);
  END IF;
  SELECT * INTO session_row FROM liri_active_sessions WHERE user_id = device_row.user_id;
  IF session_row.user_id IS NULL OR NOT session_row.active THEN
    RETURN jsonb_build_object('activated', true, 'name', device_row.name, 'hasSession', false);
  END IF;
  position_now := session_row.playback_position + CASE WHEN session_row.paused THEN 0
    ELSE extract(epoch FROM (now() - session_row.anchor_at)) END;
  RETURN jsonb_build_object(
    'activated', true, 'name', device_row.name, 'hasSession', true,
    'isOwner', session_row.owner_device_id = p_device_id::text,
    'ownerDeviceId', session_row.owner_device_id,
    'ownerDeviceName', session_row.owner_device_name,
    'song', jsonb_build_object('title', session_row.song_title, 'artist', session_row.song_artist,
      'album', session_row.song_album, 'artwork', session_row.artwork_url),
    'lyrics', session_row.lyrics_json, 'playbackTime', position_now,
    'paused', session_row.paused, 'mode', session_row.mode,
    'revision', session_row.revision, 'sentAt', floor(extract(epoch FROM now()) * 1000)
  );
END;
$$;

CREATE OR REPLACE FUNCTION move_liri_session_to_tv(p_device_id uuid, p_token text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  device_row liri_devices;
  session_row liri_active_sessions;
  position_now numeric;
BEGIN
  SELECT * INTO device_row FROM liri_devices
  WHERE id = p_device_id AND user_id IS NOT NULL
    AND token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');
  IF device_row.id IS NULL THEN RAISE EXCEPTION 'Invalid device'; END IF;
  SELECT * INTO session_row FROM liri_active_sessions WHERE user_id = device_row.user_id FOR UPDATE;
  IF session_row.user_id IS NULL OR NOT session_row.active THEN RAISE EXCEPTION 'No active session'; END IF;
  position_now := session_row.playback_position + CASE WHEN session_row.paused THEN 0
    ELSE extract(epoch FROM (now() - session_row.anchor_at)) END;
  UPDATE liri_active_sessions SET
    owner_device_id = p_device_id::text, owner_device_name = device_row.name,
    playback_position = position_now, anchor_at = now(),
    revision = revision + 1, updated_at = now()
  WHERE user_id = device_row.user_id
  RETURNING * INTO session_row;
  RETURN get_liri_tv_state(p_device_id, p_token);
END;
$$;

CREATE OR REPLACE FUNCTION update_liri_session_from_tv(
  p_device_id uuid, p_token text, p_playback_position numeric, p_paused boolean
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE device_user uuid;
BEGIN
  SELECT user_id INTO device_user FROM liri_devices
  WHERE id = p_device_id AND token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');
  IF device_user IS NULL THEN RAISE EXCEPTION 'Invalid device'; END IF;
  UPDATE liri_active_sessions SET
    playback_position = greatest(coalesce(p_playback_position, 0), 0),
    paused = coalesce(p_paused, false), anchor_at = now(),
    revision = revision + 1, updated_at = now()
  WHERE user_id = device_user AND owner_device_id = p_device_id::text;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION register_liri_device(uuid,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION activate_liri_device(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION publish_liri_session(text,text,text,text,text,text,jsonb,numeric,boolean,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION get_liri_tv_state(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION move_liri_session_to_tv(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION update_liri_session_from_tv(uuid,text,numeric,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION register_liri_device(uuid,text,text,text,text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION activate_liri_device(text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION publish_liri_session(text,text,text,text,text,text,jsonb,numeric,boolean,text) TO authenticated;
GRANT EXECUTE ON FUNCTION get_liri_tv_state(uuid,text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION move_liri_session_to_tv(uuid,text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION update_liri_session_from_tv(uuid,text,numeric,boolean) TO anon, authenticated;
