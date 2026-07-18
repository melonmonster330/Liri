// Pair Liri's web player with the browser receiver on Samsung TVs.
// Supabase Realtime broadcast is transport only; lyric state is not persisted.

const { useState, useEffect, useRef, useCallback } = React;

export function useTvRoom({ sb, mode, song, lyrics, playbackTime, isPaused }) {
  const [roomCode, setRoomCode] = useState("");
  const [status, setStatus] = useState("idle"); // idle | connecting | connected
  const [error, setError] = useState(null);
  const channelRef = useRef(null);
  const snapshotRef = useRef(null);

  snapshotRef.current = {
    type: "STATE",
    mode,
    song: song ? {
      title: song.title || "",
      artist: song.artist || "",
      album: song.album || "",
      artwork: song.artwork || null,
    } : null,
    lyrics: Array.isArray(lyrics) ? lyrics : [],
    playbackTime: Number.isFinite(playbackTime) ? playbackTime : 0,
    paused: !!isPaused,
    sentAt: Date.now(),
  };

  const sendState = useCallback(async () => {
    if (!channelRef.current) return;
    try {
      await channelRef.current.send({
        type: "broadcast",
        event: "state",
        payload: { ...snapshotRef.current, sentAt: Date.now() },
      });
      setError(null);
    } catch (err) {
      setError(err?.message || "Could not update the TV");
    }
  }, []);

  const disconnect = useCallback(async () => {
    const channel = channelRef.current;
    channelRef.current = null;
    if (channel) {
      try {
        await channel.send({ type: "broadcast", event: "session-end", payload: {} });
      } catch {}
      try { await sb.removeChannel(channel); } catch {}
    }
    setStatus("idle");
    setRoomCode("");
    setError(null);
  }, [sb]);

  const connect = useCallback(async rawCode => {
    const code = String(rawCode || "").replace(/\D/g, "").slice(0, 4);
    if (!/^\d{4}$/.test(code)) {
      setError("Enter the four-digit code shown on the TV");
      return false;
    }
    if (channelRef.current) await disconnect();

    setRoomCode(code);
    setStatus("connecting");
    setError(null);
    const channel = sb.channel("cast:" + code, {
      config: { broadcast: { ack: true, self: false } },
    });
    channelRef.current = channel;
    channel
      .on("broadcast", { event: "receiver-ready" }, () => {
        setStatus("connected");
        sendState();
      })
      .subscribe(subscribeStatus => {
        if (subscribeStatus === "SUBSCRIBED") sendState();
        if (subscribeStatus === "CHANNEL_ERROR" || subscribeStatus === "TIMED_OUT") {
          setStatus("idle");
          setError("Could not connect to that TV. Check the code and try again.");
        }
      });
    return true;
  }, [sb, disconnect, sendState]);

  useEffect(() => {
    if (!channelRef.current) return;
    sendState();
    const timer = setInterval(sendState, 1000);
    return () => clearInterval(timer);
  }, [roomCode, song, lyrics, mode, isPaused, sendState]);

  useEffect(() => () => {
    if (channelRef.current) sb.removeChannel(channelRef.current);
  }, [sb]);

  return { roomCode, status, connected: status === "connected", error, connect, disconnect };
}
