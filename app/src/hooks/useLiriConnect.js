// Publishes the account's durable listening session and activates full Liri
// devices. Unlike Cast, ownership can move away and the source may disappear.

const { useState, useEffect, useRef, useCallback } = React;

function getOrCreateDeviceId() {
  try {
    let id = localStorage.getItem("liri_connect_device_id");
    if (!id) {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const h = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
      id = `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
      localStorage.setItem("liri_connect_device_id", id);
    }
    return id;
  } catch { return `web-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
}

function defaultDeviceName() {
  const ua = navigator.userAgent || "";
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  if (/Android/i.test(ua)) return "Android";
  if (/Macintosh/i.test(ua)) return "Mac";
  return "Web browser";
}

export function useLiriConnect({ client, user, mode, song, lyrics, playbackTime, isPaused }) {
  const deviceIdRef = useRef(getOrCreateDeviceId());
  const deviceNameRef = useRef(defaultDeviceName());
  const snapshotRef = useRef(null);
  const [movedAway, setMovedAway] = useState(false);
  const [activating, setActivating] = useState(false);
  const [activationError, setActivationError] = useState(null);
  const [activatedDevice, setActivatedDevice] = useState(null);

  snapshotRef.current = {
    p_device_id: deviceIdRef.current,
    p_device_name: deviceNameRef.current,
    p_song_title: song?.title || "",
    p_song_artist: song?.artist || "",
    p_song_album: song?.album || "",
    p_artwork_url: song?.artwork || null,
    p_lyrics_json: Array.isArray(lyrics) ? lyrics : [],
    p_playback_position: Number.isFinite(playbackTime) ? playbackTime : 0,
    p_paused: !!isPaused,
    p_mode: mode || "idle",
  };

  const publish = useCallback(async () => {
    if (!user?.id || !snapshotRef.current.p_song_title || mode !== "syncing") return false;
    const { data, error } = await client.rpc("publish_liri_session", snapshotRef.current);
    if (error) return false;
    setMovedAway(data === false);
    return data === true;
  }, [client, user?.id, mode]);

  useEffect(() => {
    if (!user?.id || !song?.title || mode !== "syncing") return;
    publish();
    const timer = setInterval(publish, 1000);
    return () => clearInterval(timer);
  }, [user?.id, song?.title, song?.artist, mode, isPaused, lyrics, publish]);

  const activateDevice = useCallback(async rawCode => {
    const code = String(rawCode || "").replace(/\D/g, "").slice(0, 6);
    if (!/^\d{6}$/.test(code)) {
      setActivationError("Enter the six-digit code shown by the Liri TV app.");
      return false;
    }
    if (!user?.id) {
      setActivationError("Sign in to link a Liri TV.");
      return false;
    }
    setActivating(true);
    setActivationError(null);
    const { data, error } = await client.rpc("activate_liri_device", {
      p_activation_code: code,
      p_name: "Living Room Frame",
    });
    setActivating(false);
    if (error) {
      setActivationError(error.message?.includes("expired") ? "That TV code expired. Refresh the TV app for a new one." : "Liri couldn't link that TV.");
      return false;
    }
    setActivatedDevice(data);
    await publish();
    return true;
  }, [client, user?.id, publish]);

  return {
    deviceId: deviceIdRef.current,
    deviceName: deviceNameRef.current,
    movedAway,
    activating,
    activationError,
    activatedDevice,
    activateDevice,
  };
}
