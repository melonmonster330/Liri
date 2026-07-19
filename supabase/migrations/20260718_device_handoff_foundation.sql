-- ============================================================
-- Liri — account devices and live listening-session handoff
--
-- Adds the account-owned realtime foundation used by independent Liri
-- clients. Samsung TV is the first new client, but nothing here is
-- platform-specific.
--
-- Important invariant: only the current owner device, presenting the current
-- owner_generation, may publish the authoritative lyric-clock anchor.
-- All mutations go through narrow RPCs; clients receive SELECT-only RLS.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.account_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  installation_id text NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  platform text NOT NULL CHECK (platform IN (
    'web', 'ios', 'samsung_tv', 'apple_tv', 'android_tv', 'android'
  )),
  model text,
  app_version text,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (user_id, installation_id)
);

CREATE INDEX IF NOT EXISTS account_devices_user_last_seen_idx
  ON public.account_devices (user_id, last_seen_at DESC)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS public.listening_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  owner_device_id uuid NOT NULL REFERENCES public.account_devices(id),
  owner_generation bigint NOT NULL DEFAULT 1 CHECK (owner_generation > 0),
  status text NOT NULL CHECK (status IN ('playing', 'paused', 'ended')),
  song jsonb NOT NULL DEFAULT '{}'::jsonb,
  lyrics jsonb NOT NULL DEFAULT '[]'::jsonb,
  album_context jsonb,
  track_index integer,
  position_seconds numeric NOT NULL DEFAULT 0 CHECK (position_seconds >= 0),
  position_recorded_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS listening_sessions_owner_idx
  ON public.listening_sessions (owner_device_id);

CREATE TABLE IF NOT EXISTS public.device_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.listening_sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_device_id uuid NOT NULL REFERENCES public.account_devices(id),
  target_device_id uuid NOT NULL REFERENCES public.account_devices(id),
  owner_generation bigint NOT NULL CHECK (owner_generation > 0),
  kind text NOT NULL CHECK (kind IN (
    'take_ownership', 'pause', 'resume', 'seek', 'select_track', 'end'
  )),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz
);

CREATE INDEX IF NOT EXISTS device_commands_target_pending_idx
  ON public.device_commands (target_device_id, created_at)
  WHERE acknowledged_at IS NULL;

-- Optional convenience sign-in. This table has no client RLS policies and is
-- intentionally inaccessible through the publishable key. A server endpoint
-- may create/exchange hashed, short-lived, single-use codes later. TV-native
-- email/password sign-in remains the required standalone path.
CREATE TABLE IF NOT EXISTS public.device_activation_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id text NOT NULL,
  code_hash text NOT NULL UNIQUE,
  requested_device_name text,
  requested_platform text NOT NULL DEFAULT 'samsung_tv',
  approved_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  approved_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.account_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listening_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_activation_codes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own devices" ON public.account_devices;
CREATE POLICY "Users read own devices"
  ON public.account_devices FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users read own listening session" ON public.listening_sessions;
CREATE POLICY "Users read own listening session"
  ON public.listening_sessions FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users read own device commands" ON public.device_commands;
CREATE POLICY "Users read own device commands"
  ON public.device_commands FOR SELECT
  USING (auth.uid() = user_id);

-- No INSERT/UPDATE/DELETE policies. SECURITY DEFINER functions below validate
-- auth.uid(), device ownership, and generation before changing state.

CREATE OR REPLACE FUNCTION public.register_account_device(
  p_installation_id text,
  p_name text,
  p_platform text,
  p_model text DEFAULT NULL,
  p_app_version text DEFAULT NULL
)
RETURNS public.account_devices
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_existing public.account_devices;
  v_result public.account_devices;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF nullif(btrim(p_installation_id), '') IS NULL THEN
    RAISE EXCEPTION 'Installation ID is required' USING ERRCODE = '22023';
  END IF;
  IF nullif(btrim(p_name), '') IS NULL OR char_length(btrim(p_name)) > 80 THEN
    RAISE EXCEPTION 'Device name must be between 1 and 80 characters' USING ERRCODE = '22023';
  END IF;
  IF p_platform NOT IN ('web', 'ios', 'samsung_tv', 'apple_tv', 'android_tv', 'android') THEN
    RAISE EXCEPTION 'Unsupported device platform' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing
  FROM public.account_devices
  WHERE user_id = v_user_id
    AND installation_id = p_installation_id;

  IF v_existing.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'This device has been revoked' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.account_devices (
    user_id, installation_id, name, platform, model, app_version, last_seen_at
  ) VALUES (
    v_user_id, p_installation_id, btrim(p_name), p_platform,
    nullif(btrim(p_model), ''), nullif(btrim(p_app_version), ''), now()
  )
  ON CONFLICT (user_id, installation_id) DO UPDATE SET
    name = EXCLUDED.name,
    platform = EXCLUDED.platform,
    model = EXCLUDED.model,
    app_version = EXCLUDED.app_version,
    last_seen_at = now()
  RETURNING * INTO v_result;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.heartbeat_account_device(p_device_id uuid)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_seen_at timestamptz := now();
BEGIN
  UPDATE public.account_devices
  SET last_seen_at = v_seen_at
  WHERE id = p_device_id
    AND user_id = auth.uid()
    AND revoked_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active device not found' USING ERRCODE = '42501';
  END IF;
  RETURN v_seen_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.publish_listening_session(
  p_device_id uuid,
  p_owner_generation bigint,
  p_status text,
  p_song jsonb,
  p_lyrics jsonb,
  p_album_context jsonb,
  p_track_index integer,
  p_position_seconds numeric,
  p_position_recorded_at timestamptz DEFAULT now()
)
RETURNS public.listening_sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_session public.listening_sessions;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_status NOT IN ('playing', 'paused', 'ended') THEN
    RAISE EXCEPTION 'Invalid session status' USING ERRCODE = '22023';
  END IF;
  IF p_position_seconds IS NULL OR p_position_seconds < 0 THEN
    RAISE EXCEPTION 'Position must be zero or greater' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(COALESCE(p_song, '{}'::jsonb)) <> 'object'
     OR jsonb_typeof(COALESCE(p_lyrics, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'Invalid song or lyrics payload' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.account_devices
    WHERE id = p_device_id AND user_id = v_user_id AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Active device not found' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_session
  FROM public.listening_sessions
  WHERE user_id = v_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    IF COALESCE(p_owner_generation, 1) <> 1 THEN
      RAISE EXCEPTION 'A new session must start at generation 1' USING ERRCODE = '40001';
    END IF;
    INSERT INTO public.listening_sessions (
      user_id, owner_device_id, owner_generation, status, song, lyrics,
      album_context, track_index, position_seconds, position_recorded_at
    ) VALUES (
      v_user_id, p_device_id, 1, p_status, COALESCE(p_song, '{}'::jsonb),
      COALESCE(p_lyrics, '[]'::jsonb), p_album_context, p_track_index,
      p_position_seconds, COALESCE(p_position_recorded_at, now())
    ) RETURNING * INTO v_session;
  ELSE
    IF v_session.owner_device_id <> p_device_id
       OR v_session.owner_generation <> p_owner_generation THEN
      RAISE EXCEPTION 'Stale or non-owner clock publication' USING ERRCODE = '40001';
    END IF;
    UPDATE public.listening_sessions SET
      status = p_status,
      song = COALESCE(p_song, '{}'::jsonb),
      lyrics = COALESCE(p_lyrics, '[]'::jsonb),
      album_context = p_album_context,
      track_index = p_track_index,
      position_seconds = p_position_seconds,
      position_recorded_at = COALESCE(p_position_recorded_at, now()),
      updated_at = now()
    WHERE id = v_session.id
    RETURNING * INTO v_session;
  END IF;

  UPDATE public.account_devices
  SET last_seen_at = now()
  WHERE id = p_device_id;

  RETURN v_session;
END;
$$;

CREATE OR REPLACE FUNCTION public.transfer_listening_session(
  p_session_id uuid,
  p_source_device_id uuid,
  p_target_device_id uuid,
  p_position_seconds numeric,
  p_position_recorded_at timestamptz DEFAULT now()
)
RETURNS public.listening_sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_session public.listening_sessions;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_position_seconds IS NULL OR p_position_seconds < 0 THEN
    RAISE EXCEPTION 'Position must be zero or greater' USING ERRCODE = '22023';
  END IF;
  -- A controller may transfer ownership to itself (for example, selecting
  -- "This computer" while a TV owns the clock), so source and target are
  -- intentionally allowed to match.
  IF NOT EXISTS (
    SELECT 1 FROM public.account_devices
    WHERE id = p_source_device_id AND user_id = v_user_id AND revoked_at IS NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM public.account_devices
    WHERE id = p_target_device_id AND user_id = v_user_id AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Source or target device not found' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_session
  FROM public.listening_sessions
  WHERE id = p_session_id AND user_id = v_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Listening session not found' USING ERRCODE = '42501';
  END IF;

  UPDATE public.listening_sessions SET
    owner_device_id = p_target_device_id,
    owner_generation = owner_generation + 1,
    position_seconds = p_position_seconds,
    position_recorded_at = COALESCE(p_position_recorded_at, now()),
    updated_at = now()
  WHERE id = v_session.id
  RETURNING * INTO v_session;

  INSERT INTO public.device_commands (
    session_id, user_id, source_device_id, target_device_id,
    owner_generation, kind, payload
  ) VALUES (
    v_session.id, v_user_id, p_source_device_id, p_target_device_id,
    v_session.owner_generation, 'take_ownership',
    jsonb_build_object('position_seconds', p_position_seconds)
  );

  RETURN v_session;
END;
$$;

CREATE OR REPLACE FUNCTION public.queue_device_command(
  p_session_id uuid,
  p_source_device_id uuid,
  p_kind text,
  p_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS public.device_commands
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_session public.listening_sessions;
  v_command public.device_commands;
BEGIN
  IF p_kind NOT IN ('pause', 'resume', 'seek', 'select_track', 'end') THEN
    RAISE EXCEPTION 'Invalid command kind' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.account_devices
    WHERE id = p_source_device_id AND user_id = v_user_id AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Source device not found' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_session
  FROM public.listening_sessions
  WHERE id = p_session_id AND user_id = v_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Listening session not found' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.device_commands (
    session_id, user_id, source_device_id, target_device_id,
    owner_generation, kind, payload
  ) VALUES (
    v_session.id, v_user_id, p_source_device_id, v_session.owner_device_id,
    v_session.owner_generation, p_kind, COALESCE(p_payload, '{}'::jsonb)
  ) RETURNING * INTO v_command;

  RETURN v_command;
END;
$$;

CREATE OR REPLACE FUNCTION public.acknowledge_device_command(
  p_command_id uuid,
  p_target_device_id uuid
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_acknowledged_at timestamptz := now();
BEGIN
  UPDATE public.device_commands
  SET acknowledged_at = COALESCE(acknowledged_at, v_acknowledged_at)
  WHERE id = p_command_id
    AND user_id = auth.uid()
    AND target_device_id = p_target_device_id
    AND EXISTS (
      SELECT 1 FROM public.account_devices
      WHERE id = p_target_device_id
        AND user_id = auth.uid()
        AND revoked_at IS NULL
    );

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pending command not found for this device' USING ERRCODE = '42501';
  END IF;
  RETURN v_acknowledged_at;
END;
$$;

REVOKE ALL ON FUNCTION public.register_account_device(text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.heartbeat_account_device(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.publish_listening_session(uuid, bigint, text, jsonb, jsonb, jsonb, integer, numeric, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transfer_listening_session(uuid, uuid, uuid, numeric, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.queue_device_command(uuid, uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.acknowledge_device_command(uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.register_account_device(text, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.heartbeat_account_device(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.publish_listening_session(uuid, bigint, text, jsonb, jsonb, jsonb, integer, numeric, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.transfer_listening_session(uuid, uuid, uuid, numeric, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.queue_device_command(uuid, uuid, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.acknowledge_device_command(uuid, uuid) TO authenticated;

-- Supabase Realtime needs these tables in its publication. The block is safe to
-- re-run and avoids duplicate-object failures in environments already set up.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'account_devices'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.account_devices;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'listening_sessions'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.listening_sessions;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'device_commands'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.device_commands;
    END IF;
  END IF;
END;
$$;
