// Universal TV-browser sender. The TV opens /tv, displays a four-digit room
// code, and listens for updates to that room through Supabase Realtime.

const { useState, useEffect, useRef, useCallback } = React;

export function useTVSession({ client, user, mode, song, lyrics, playbackTime, isPaused }) {
  const [connected, setConnected] = useState(false);
  const [roomCode, setRoomCode] = useState(() => {
    try { return localStorage.getItem("liri_tv_room") || ""; } catch { return ""; }
  });
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState(null);
  const snapshotRef = useRef(null);
  const roomCodeRef = useRef(roomCode);

  roomCodeRef.current = roomCode;
  snapshotRef.current = {
    song_title: song?.title || "",
    song_artist: song?.artist || "",
    artwork_url: song?.artwork || null,
    lyrics_json: Array.isArray(lyrics) ? lyrics : [],
    initial_position: Number.isFinite(playbackTime) ? playbackTime : 0,
    // These fields are intentionally represented through the existing schema:
    // initial_position is refreshed once per second, so a paused clock remains
    // fixed while a playing clock advances with the phone.
    detected_at: new Date().toISOString(),
    is_active: true,
  };

  const publish = useCallback(async () => {
    const code = roomCodeRef.current;
    if (!code || !user?.id) return false;
    const { error: updateError } = await client.from("cast_sessions").upsert({
      room_code: code,
      user_id: user.id,
      ...snapshotRef.current,
    }, { onConflict: "room_code" });
    if (updateError) {
      setError(updateError.code === "42501"
        ? "That TV code is already in use. Refresh the TV screen for a new code."
        : "Liri couldn't update the TV. Check both devices' connections.");
      return false;
    }
    setError(null);
    return true;
  }, [client, user?.id]);

  const connect = useCallback(async rawCode => {
    const code = String(rawCode || "").replace(/\D/g, "").slice(0, 4);
    if (!/^\d{4}$/.test(code)) {
      setError("Enter the four-digit code shown on your TV.");
      return false;
    }
    if (!user?.id) {
      setError("Sign in to Liri before connecting a TV.");
      return false;
    }
    setConnecting(true);
    setError(null);
    roomCodeRef.current = code;
    setRoomCode(code);
    const ok = await publish();
    setConnecting(false);
    if (!ok) return false;
    setConnected(true);
    try { localStorage.setItem("liri_tv_room", code); } catch {}
    return true;
  }, [publish, user?.id]);

  const disconnect = useCallback(async () => {
    const code = roomCodeRef.current;
    setConnected(false);
    if (code && user?.id) {
      await client.from("cast_sessions").update({
        is_active: false,
        detected_at: new Date().toISOString(),
      }).eq("room_code", code).eq("user_id", user.id);
    }
  }, [client, user?.id]);

  // Keep the TV clock anchored without sending the phone's high-frequency UI
  // ticks. Song, lyrics, nudges, and pause changes also publish immediately.
  useEffect(() => {
    if (!connected) return;
    publish();
    const timer = setInterval(publish, isPaused ? 3000 : 1000);
    return () => clearInterval(timer);
  }, [connected, song, lyrics, mode, isPaused, publish]);

  useEffect(() => () => {
    // Best-effort only: page teardown cannot reliably await a network request.
    if (connected) disconnect();
  }, [connected, disconnect]);

  return { connected, connecting, roomCode, error, connect, disconnect };
}
