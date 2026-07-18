// Desktop Chrome Google Cast sender for Liri's custom lyrics receiver.
// Intentionally web-only: iOS/Capacitor sender support is a separate project.

const { useState, useEffect, useRef, useCallback } = React;

const CAST_APP_ID = "2FBB66AA";
const CAST_NAMESPACE = "urn:x-cast:com.getliri.lyrics";
const CAST_SDK_URL = "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";

let castContext = null;
let castLoadPromise = null;

function loadCastSdk() {
  if (castLoadPromise) return castLoadPromise;
  castLoadPromise = new Promise((resolve, reject) => {
    if (!window.chrome || window.Capacitor) {
      reject(new Error("Google Cast is available in desktop Chrome"));
      return;
    }

    const finish = isAvailable => {
      if (!isAvailable || !window.cast?.framework || !window.chrome?.cast) {
        reject(new Error("No Google Cast devices are available"));
        return;
      }
      try {
        castContext = window.cast.framework.CastContext.getInstance();
        castContext.setOptions({
          receiverApplicationId: CAST_APP_ID,
          autoJoinPolicy: window.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
        });
        resolve(castContext);
      } catch (error) {
        reject(error);
      }
    };

    window.__onGCastApiAvailable = finish;
    const existing = document.querySelector(`script[src="${CAST_SDK_URL}"]`);
    if (!existing) {
      const script = document.createElement("script");
      script.src = CAST_SDK_URL;
      script.async = true;
      script.onerror = () => reject(new Error("Could not load Google Cast"));
      document.head.appendChild(script);
    } else if (window.cast?.framework) {
      finish(true);
    }
  });
  return castLoadPromise;
}

export function useCast({ mode, song, lyrics, playbackTime, isPaused }) {
  const supported = !window.Capacitor && !!window.chrome;
  const [ready, setReady] = useState(false);
  const [connected, setConnected] = useState(false);
  const [deviceName, setDeviceName] = useState(null);
  const [error, setError] = useState(null);
  const snapshotRef = useRef(null);

  const castSong = song ? {
    title: song.title || "",
    artist: song.artist || "",
    album: song.album || "",
    artwork: song.artwork || null,
  } : null;
  const castPlaybackTime = Number.isFinite(playbackTime) ? playbackTime : 0;
  snapshotRef.current = {
    // SESSION_START plus the legacy aliases keeps preview senders compatible
    // with the receiver URL currently registered in the Cast Console. The new
    // receiver treats every message as a fresh timing anchor.
    type: "SESSION_START",
    mode,
    song: castSong,
    lyrics: Array.isArray(lyrics) ? lyrics : [],
    playbackTime: castPlaybackTime,
    paused: !!isPaused,
    sentAt: Date.now(),
    songTitle: castSong?.title || "",
    songArtist: castSong?.artist || "",
    artworkUrl: castSong?.artwork || null,
    initialPos: castPlaybackTime,
    detectedAt: Date.now(),
  };

  const refreshSession = useCallback(() => {
    const session = castContext?.getCurrentSession?.();
    setConnected(!!session);
    setDeviceName(session?.getCastDevice?.()?.friendlyName || null);
  }, []);

  useEffect(() => {
    if (!supported) return;
    let active = true;
    let context = null;
    let sessionListener = null;

    loadCastSdk().then(ctx => {
      if (!active) return;
      context = ctx;
      setReady(true);
      setError(null);
      sessionListener = refreshSession;
      context.addEventListener(window.cast.framework.CastContextEventType.SESSION_STATE_CHANGED, sessionListener);
      refreshSession();
    }).catch(err => {
      if (active) setError(err?.message || "Google Cast is unavailable");
    });

    return () => {
      active = false;
      if (context && sessionListener) {
        context.removeEventListener(window.cast.framework.CastContextEventType.SESSION_STATE_CHANGED, sessionListener);
      }
    };
  }, [supported, refreshSession]);

  const sendState = useCallback(async () => {
    const session = castContext?.getCurrentSession?.();
    if (!session) return false;
    const message = { ...snapshotRef.current, sentAt: Date.now() };
    try {
      await session.sendMessage(CAST_NAMESPACE, message);
      setError(null);
      return true;
    } catch (err) {
      setError(err?.message || "Could not update the TV");
      return false;
    }
  }, []);

  // The receiver interpolates its own clock; this anchor corrects network delay,
  // manual nudges and timer drift without flooding Cast with 80ms UI ticks.
  useEffect(() => {
    if (!connected) return;
    sendState();
    const timer = setInterval(sendState, 1000);
    return () => clearInterval(timer);
  }, [connected, song, lyrics, mode, isPaused, sendState]);

  const requestSession = useCallback(async () => {
    setError(null);
    try {
      const context = await loadCastSdk();
      await context.requestSession();
      refreshSession();
      // The session-state event can precede receiver readiness by a beat.
      setTimeout(sendState, 400);
      return true;
    } catch (err) {
      const cancelled = err === "cancel" || err?.code === "cancel";
      if (!cancelled) setError(err?.description || err?.message || "Could not start casting");
      return false;
    }
  }, [refreshSession, sendState]);

  const stopSession = useCallback(async () => {
    try {
      const session = castContext?.getCurrentSession?.();
      await session?.sendMessage?.(CAST_NAMESPACE, { type: "SESSION_END" });
    } catch {}
    castContext?.endCurrentSession?.(true);
    setConnected(false);
    setDeviceName(null);
  }, []);

  return { supported, ready, connected, deviceName, error, requestSession, stopSession };
}
