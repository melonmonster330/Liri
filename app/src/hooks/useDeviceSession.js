// Account-owned devices and listening sessions.
//
// This is deliberately separate from useCast: Cast mirrors a sender-owned
// lyric clock, while account device handoff transfers clock authority between
// independent Liri clients.

const { useState, useEffect, useRef, useCallback } = React;

const HEARTBEAT_MS = 10000;

function makeInstallationId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
  );
}

function getInstallationId() {
  try {
    let id = localStorage.getItem("liri_device_installation_id");
    if (!id) {
      id = makeInstallationId();
      localStorage.setItem("liri_device_installation_id", id);
    }
    return id;
  } catch {
    return makeInstallationId();
  }
}

function getPlatform() {
  if (window.Capacitor) return /iPhone|iPad|iPod/i.test(navigator.userAgent) ? "ios" : "android";
  return "web";
}

function getDefaultName() {
  const platform = getPlatform();
  if (platform === "ios") return "This iPhone";
  if (platform === "android") return "This phone";
  return "This computer";
}

function getSavedName() {
  try { return localStorage.getItem("liri_device_name") || getDefaultName(); }
  catch { return getDefaultName(); }
}

export function useDeviceSession({ sb, user, appVersion = "1.0.0" }) {
  const [device, setDevice] = useState(null);
  const [devices, setDevices] = useState([]);
  const [liveSession, setLiveSession] = useState(null);
  const [pendingCommands, setPendingCommands] = useState([]);
  const [error, setError] = useState(null);
  const deviceRef = useRef(null);
  const liveSessionRef = useRef(null);
  const userId = user?.id || null;

  useEffect(() => { deviceRef.current = device; }, [device]);
  useEffect(() => { liveSessionRef.current = liveSession; }, [liveSession]);

  const loadAccountState = useCallback(async () => {
    if (!userId) return;
    const [deviceResult, sessionResult] = await Promise.all([
      sb.from("account_devices")
        .select("*")
        .is("revoked_at", null)
        .order("last_seen_at", { ascending: false }),
      sb.from("listening_sessions")
        .select("*")
        .maybeSingle(),
    ]);
    if (deviceResult.error) throw deviceResult.error;
    if (sessionResult.error) throw sessionResult.error;
    setDevices(deviceResult.data || []);
    setLiveSession(sessionResult.data || null);
    liveSessionRef.current = sessionResult.data || null;
  }, [sb, userId]);

  const loadPendingCommands = useCallback(async currentDeviceId => {
    if (!userId || !currentDeviceId) return;
    const { data, error: commandError } = await sb.from("device_commands")
      .select("*")
      .eq("target_device_id", currentDeviceId)
      .is("acknowledged_at", null)
      .order("created_at", { ascending: true });
    if (commandError) throw commandError;
    setPendingCommands(data || []);
  }, [sb, userId]);

  useEffect(() => {
    if (!userId) {
      setDevice(null);
      setDevices([]);
      setLiveSession(null);
      setPendingCommands([]);
      setError(null);
      return;
    }

    let active = true;
    let heartbeatTimer = null;
    let channel = null;

    const start = async () => {
      try {
        const { data: registered, error: registerError } = await sb.rpc("register_account_device", {
          p_installation_id: getInstallationId(),
          p_name: getSavedName(),
          p_platform: getPlatform(),
          p_model: navigator.userAgent || null,
          p_app_version: appVersion,
        });
        if (registerError) throw registerError;
        if (!active) return;

        setDevice(registered);
        deviceRef.current = registered;
        await Promise.all([loadAccountState(), loadPendingCommands(registered.id)]);
        if (!active) return;

        const heartbeat = async () => {
          const current = deviceRef.current;
          if (!current) return;
          const { error: heartbeatError } = await sb.rpc("heartbeat_account_device", {
            p_device_id: current.id,
          });
          if (heartbeatError && active) setError(heartbeatError.message);
        };
        heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);

        channel = sb.channel(`device-session:${userId}`)
          .on("postgres_changes", {
            event: "*", schema: "public", table: "account_devices",
            filter: `user_id=eq.${userId}`,
          }, () => loadAccountState().catch(err => active && setError(err.message)))
          .on("postgres_changes", {
            event: "*", schema: "public", table: "listening_sessions",
            filter: `user_id=eq.${userId}`,
          }, () => loadAccountState().catch(err => active && setError(err.message)))
          .on("postgres_changes", {
            event: "INSERT", schema: "public", table: "device_commands",
            filter: `target_device_id=eq.${registered.id}`,
          }, () => loadPendingCommands(registered.id).catch(err => active && setError(err.message)))
          .subscribe(status => {
            if (active && (status === "CHANNEL_ERROR" || status === "TIMED_OUT")) {
              setError("Device updates are temporarily unavailable");
            }
          });
      } catch (err) {
        if (active) setError(err?.message || "Could not register this Liri device");
      }
    };

    start();
    return () => {
      active = false;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (channel) sb.removeChannel(channel);
    };
  }, [sb, userId, appVersion, loadAccountState, loadPendingCommands]);

  const publishSession = useCallback(async snapshot => {
    if (!deviceRef.current) throw new Error("This device is not registered yet");
    const generation = liveSessionRef.current?.owner_generation || 1;
    const { data, error: publishError } = await sb.rpc("publish_listening_session", {
      p_device_id: deviceRef.current.id,
      p_owner_generation: generation,
      p_status: snapshot.status,
      p_song: snapshot.song || {},
      p_lyrics: snapshot.lyrics || [],
      p_album_context: snapshot.albumContext || null,
      p_track_index: snapshot.trackIndex ?? null,
      p_position_seconds: Math.max(0, Number(snapshot.positionSeconds) || 0),
      p_position_recorded_at: snapshot.positionRecordedAt || new Date().toISOString(),
    });
    if (publishError) throw publishError;
    setLiveSession(data);
    liveSessionRef.current = data;
    return data;
  }, [sb]);

  const transferSession = useCallback(async (targetDeviceId, positionSeconds) => {
    const currentSession = liveSessionRef.current;
    if (!deviceRef.current || !currentSession) throw new Error("No live session to transfer");
    const { data, error: transferError } = await sb.rpc("transfer_listening_session", {
      p_session_id: currentSession.id,
      p_source_device_id: deviceRef.current.id,
      p_target_device_id: targetDeviceId,
      p_position_seconds: Math.max(0, Number(positionSeconds) || 0),
      p_position_recorded_at: new Date().toISOString(),
    });
    if (transferError) throw transferError;
    setLiveSession(data);
    liveSessionRef.current = data;
    return data;
  }, [sb]);

  const sendCommand = useCallback(async (kind, payload = {}) => {
    const currentSession = liveSessionRef.current;
    if (!deviceRef.current || !currentSession) throw new Error("No live session to control");
    const { data, error: commandError } = await sb.rpc("queue_device_command", {
      p_session_id: currentSession.id,
      p_source_device_id: deviceRef.current.id,
      p_kind: kind,
      p_payload: payload,
    });
    if (commandError) throw commandError;
    return data;
  }, [sb]);

  const acknowledgeCommand = useCallback(async commandId => {
    if (!deviceRef.current) throw new Error("This device is not registered yet");
    const { error: acknowledgeError } = await sb.rpc("acknowledge_device_command", {
      p_command_id: commandId,
      p_target_device_id: deviceRef.current.id,
    });
    if (acknowledgeError) throw acknowledgeError;
    setPendingCommands(current => current.filter(command => command.id !== commandId));
  }, [sb]);

  const renameDevice = useCallback(async name => {
    const trimmed = String(name || "").trim();
    if (!trimmed) throw new Error("Device name is required");
    try { localStorage.setItem("liri_device_name", trimmed); } catch {}
    const { data, error: renameError } = await sb.rpc("register_account_device", {
      p_installation_id: getInstallationId(),
      p_name: trimmed,
      p_platform: getPlatform(),
      p_model: navigator.userAgent || null,
      p_app_version: appVersion,
    });
    if (renameError) throw renameError;
    setDevice(data);
    deviceRef.current = data;
    await loadAccountState();
    return data;
  }, [sb, appVersion, loadAccountState]);

  return {
    device,
    devices,
    liveSession,
    pendingCommands,
    error,
    isOwner: !!device && liveSession?.owner_device_id === device.id,
    refresh: loadAccountState,
    publishSession,
    transferSession,
    sendCommand,
    acknowledgeCommand,
    renameDevice,
  };
}
