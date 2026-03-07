import { useState, useEffect, useRef, useCallback } from "react";

/* ─── LRC Parser ─────────────────────────────────────────── */
function parseLRC(lrc) {
  const lines = lrc.split("\n");
  const result = [];
  const re = /\[(\d{2}):(\d{2})[.:](\d{2,3})\](.*)/;
  for (const line of lines) {
    const m = line.match(re);
    if (m) {
      const ms = m[3].padEnd(3, "0").slice(0, 3);
      const t = parseInt(m[1]) * 60 + parseInt(m[2]) + parseInt(ms) / 1000;
      const text = m[4].trim();
      if (text) result.push({ time: t, text });
    }
  }
  return result.sort((a, b) => a.time - b.time);
}

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

/* ─── Sub-components ────────────────────────────────────────── */
function WaveAnimation({ active }) {
  const heights = [24, 38, 52, 44, 32, 48, 36, 52, 40, 28, 44, 34];
  return (
    <div style={{ display: "flex", gap: "5px", alignItems: "center", height: "56px", justifyContent: "center" }}>
      {heights.map((h, i) => (
        <div
          key={i}
          style={{
            width: "4px",
            borderRadius: "3px",
            background: `linear-gradient(to top, #d4a846, #e8a0a8)`,
            height: active ? `${h}px` : "4px",
            animation: active ? `wave-${i % 4} ${0.6 + i * 0.08}s ease-in-out infinite alternate` : "none",
            transition: "height 0.4s ease",
            opacity: active ? 1 : 0.35,
          }}
        />
      ))}
      <style>{`
        @keyframes wave-0 { from { transform: scaleY(0.3); } to { transform: scaleY(1); } }
        @keyframes wave-1 { from { transform: scaleY(0.5); } to { transform: scaleY(1); } }
        @keyframes wave-2 { from { transform: scaleY(0.2); } to { transform: scaleY(0.9); } }
        @keyframes wave-3 { from { transform: scaleY(0.6); } to { transform: scaleY(1); } }
      `}</style>
    </div>
  );
}

function VinylSpinner({ spinning }) {
  return (
    <div style={{ width: "88px", height: "88px", margin: "0 auto", animation: spinning ? "vinyl-spin 1.8s linear infinite" : "none" }}>
      <svg viewBox="0 0 100 100" style={{ width: "100%", height: "100%" }}>
        <defs>
          <radialGradient id="vg" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#2a2438" />
            <stop offset="100%" stopColor="#0d0a14" />
          </radialGradient>
        </defs>
        <circle cx="50" cy="50" r="49" fill="url(#vg)" stroke="#2a2438" strokeWidth="1.5" />
        {[44, 38, 32, 26, 20].map((r, i) => (
          <circle key={i} cx="50" cy="50" r={r} fill="none" stroke="#1e1a2a" strokeWidth="1" />
        ))}
        <circle cx="50" cy="50" r="11" fill="#d4a846" opacity="0.9" />
        <circle cx="50" cy="50" r="4" fill="#0a0a14" />
      </svg>
      <style>{`@keyframes vinyl-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function ProgressRing({ progress }) {
  const r = 38;
  const circ = 2 * Math.PI * r;
  const dash = circ * progress;
  return (
    <svg width="96" height="96" style={{ transform: "rotate(-90deg)" }}>
      <circle cx="48" cy="48" r={r} fill="none" stroke="#1e1a2e" strokeWidth="4" />
      <circle
        cx="48" cy="48" r={r}
        fill="none"
        stroke="url(#pg)"
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray={`${dash} ${circ}`}
        style={{ transition: "stroke-dasharray 0.1s linear" }}
      />
      <defs>
        <linearGradient id="pg" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#d4a846" />
          <stop offset="100%" stopColor="#e8a0a8" />
        </linearGradient>
      </defs>
    </svg>
  );
}

/* ─── Main App ─────────────────────────────────────────────── */
export default function Liri() {
  const [mode, setMode] = useState("idle"); // idle | listening | detecting | confirmed | syncing | error
  const [detectedSong, setDetectedSong] = useState(null);
  const [lyrics, setLyrics] = useState([]);
  const [hasLyrics, setHasLyrics] = useState(true);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [playbackTime, setPlaybackTime] = useState(0);
  const [error, setError] = useState(null);
  const [listenProgress, setListenProgress] = useState(0);
  const [apiKey, setApiKey] = useState("");
  const [showSettings, setShowSettings] = useState(false);

  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const streamRef = useRef(null);
  const syncIntervalRef = useRef(null);
  const syncStartRef = useRef(null);
  const detectedAtRef = useRef(null);
  const initialPosRef = useRef(0);
  const lyricsRef = useRef([]);
  const progressTimerRef = useRef(null);
  const currentLineRef = useRef(null);

  useEffect(() => { lyricsRef.current = lyrics; }, [lyrics]);

  useEffect(() => {
    if (currentLineRef.current && mode === "syncing") {
      currentLineRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [currentIndex, mode]);

  useEffect(() => {
    return () => {
      clearAll();
    };
  }, []);

  function clearAll() {
    if (syncIntervalRef.current) clearInterval(syncIntervalRef.current);
    if (progressTimerRef.current) clearInterval(progressTimerRef.current);
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
  }

  /* ─── Audio Capture ─── */
  const startListening = async () => {
    setError(null);
    setMode("listening");
    setListenProgress(0);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      let mimeType = "audio/webm";
      if (!MediaRecorder.isTypeSupported("audio/webm")) {
        mimeType = MediaRecorder.isTypeSupported("audio/ogg") ? "audio/ogg" : "";
      }

      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      const chunks = [];
      audioChunksRef.current = chunks;

      recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
      recorder.onstop = async () => {
        setMode("detecting");
        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        stream.getTracks().forEach(t => t.stop());
        await detectSong(blob);
      };

      recorder.start(200);

      let elapsed = 0;
      progressTimerRef.current = setInterval(() => {
        elapsed += 100;
        setListenProgress(Math.min(elapsed / 8000, 1));
        if (elapsed >= 8000) {
          clearInterval(progressTimerRef.current);
          if (recorder.state === "recording") recorder.stop();
        }
      }, 100);

    } catch (err) {
      setError("Microphone access denied. Please allow mic access in your browser and try again.");
      setMode("error");
    }
  };

  /* ─── Song Detection via AudD ─── */
  const detectSong = async (blob) => {
    try {
      const fd = new FormData();
      fd.append("file", blob, "sample.webm");
      fd.append("return", "timecode,spotify,apple_music");
      if (apiKey) fd.append("api_token", apiKey);

      const res = await fetch("https://api.audd.io/", { method: "POST", body: fd });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();

      if (data.status === "success" && data.result) {
        const r = data.result;
        const artwork =
          r.spotify?.album?.images?.[0]?.url ||
          r.apple_music?.artwork?.url?.replace("{w}x{h}", "300x300") ||
          null;

        const tcParts = (r.timecode || "0:00").split(":");
        const tcSecs = parseInt(tcParts[0] || 0) * 60 + parseFloat(tcParts[1] || 0);

        detectedAtRef.current = Date.now();
        initialPosRef.current = tcSecs;

        const song = { title: r.title, artist: r.artist, album: r.album, artwork, timecode: r.timecode || "0:00" };
        setDetectedSong(song);

        const found = await loadLyrics(r.title, r.artist);
        setHasLyrics(found);
        setMode("confirmed");

      } else if (data.error?.error_code === 901) {
        setError("Daily recognition limit reached. Add a free AudD API key in Settings to continue.");
        setMode("error");
      } else {
        setError("Couldn't identify the song. Make sure your record is playing clearly and try again.");
        setMode("error");
      }
    } catch (err) {
      setError("Connection failed. Check your internet and try again.");
      setMode("error");
    }
  };

  /* ─── Lyric Fetch from lrclib.net ─── */
  const loadLyrics = async (title, artist) => {
    try {
      const r1 = await fetch(
        `https://lrclib.net/api/search?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`
      );
      const list1 = await r1.json();
      const exact = list1.find(x => x.syncedLyrics);
      if (exact) {
        setLyrics(parseLRC(exact.syncedLyrics));
        return true;
      }

      const r2 = await fetch(
        `https://lrclib.net/api/search?q=${encodeURIComponent(artist + " " + title)}`
      );
      const list2 = await r2.json();
      const fuzzy = list2.find(x => x.syncedLyrics);
      if (fuzzy) {
        setLyrics(parseLRC(fuzzy.syncedLyrics));
        return true;
      }

      const plain = [...list1, ...list2].find(x => x.plainLyrics);
      if (plain) {
        const lines = plain.plainLyrics.split("\n").filter(l => l.trim()).map((text, i) => ({ time: i * 4, text }));
        setLyrics(lines);
        return true;
      }

      return false;
    } catch {
      return false;
    }
  };

  /* ─── Sync Engine ─── */
  const startSync = useCallback(() => {
    const delay = detectedAtRef.current ? (Date.now() - detectedAtRef.current) / 1000 : 0;
    initialPosRef.current = initialPosRef.current + delay;
    syncStartRef.current = Date.now();

    setMode("syncing");
    setCurrentIndex(0);

    if (syncIntervalRef.current) clearInterval(syncIntervalRef.current);
    syncIntervalRef.current = setInterval(() => {
      const elapsed = (Date.now() - syncStartRef.current) / 1000;
      const t = initialPosRef.current + elapsed;
      setPlaybackTime(t);

      const lrc = lyricsRef.current;
      if (!lrc.length) return;

      let idx = 0;
      for (let i = 0; i < lrc.length; i++) {
        if (lrc[i].time <= t) idx = i;
        else break;
      }
      setCurrentIndex(idx);
    }, 80);
  }, []);

  const nudge = (secs) => {
    initialPosRef.current = Math.max(0, initialPosRef.current + secs);
  };

  const reset = () => {
    clearAll();
    setMode("idle");
    setDetectedSong(null);
    setLyrics([]);
    setCurrentIndex(0);
    setError(null);
    setListenProgress(0);
    setHasLyrics(true);
  };

  /* ─── Shared UI Tokens ─── */
  const gold = "#d4a846";
  const rose = "#e8a0a8";
  const cream = "#f0e6d3";
  const bg = "#0a0a14";
  const dim = "rgba(240,230,211,0.35)";
  const faint = "rgba(240,230,211,0.12)";

  const Btn = ({ onClick, children, variant = "primary", style = {} }) => {
    const base = {
      border: "none", borderRadius: "50px", cursor: "pointer",
      fontFamily: "inherit", letterSpacing: "2px", textTransform: "uppercase",
      fontSize: "13px", fontWeight: "600", transition: "opacity 0.2s", ...style,
    };
    if (variant === "primary") return (
      <button onClick={onClick} style={{ ...base, background: `linear-gradient(135deg, ${gold}, ${rose})`, color: bg, padding: "14px 44px" }}>
        {children}
      </button>
    );
    if (variant === "ghost") return (
      <button onClick={onClick} style={{ ...base, background: "none", border: `1px solid ${gold}`, color: gold, padding: "10px 28px" }}>
        {children}
      </button>
    );
    if (variant === "text") return (
      <button onClick={onClick} style={{ ...base, background: "none", border: "none", color: "#555", fontSize: "12px", padding: "8px 16px", letterSpacing: "1px" }}>
        {children}
      </button>
    );
  };

  /* ─── Render ─────────────────────────────────────────────── */
  const hasBg = detectedSong?.artwork;

  return (
    <div style={{ minHeight: "100vh", background: bg, color: cream, fontFamily: "'Georgia', 'Times New Roman', serif", position: "relative", overflow: "hidden", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>

      {/* Blurred artwork background */}
      {hasBg && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 0,
          backgroundImage: `url(${detectedSong.artwork})`,
          backgroundSize: "cover", backgroundPosition: "center",
          filter: "blur(60px) brightness(0.18) saturate(1.5)",
          transform: "scale(1.1)",
        }} />
      )}

      {/* Header */}
      <div style={{ position: "fixed", top: 0, left: 0, right: 0, zIndex: 50, padding: "18px 24px", display: "flex", justifyContent: "space-between", alignItems: "center", background: "linear-gradient(to bottom, rgba(10,10,20,0.9) 0%, transparent 100%)" }}>
        <div style={{ fontSize: "18px", letterSpacing: "10px", color: gold, fontWeight: "300", fontFamily: "Georgia, serif" }}>LIRI</div>
        <button onClick={() => setShowSettings(!showSettings)} style={{ background: "none", border: "none", color: gold, cursor: "pointer", fontSize: "18px", opacity: 0.6, padding: "4px" }}>
          ⚙
        </button>
      </div>

      {/* Settings Drawer */}
      {showSettings && (
        <div style={{ position: "fixed", top: "60px", right: "20px", background: "#111124", border: "1px solid #2a2a3e", borderRadius: "14px", padding: "20px", width: "300px", zIndex: 100, boxShadow: "0 8px 40px rgba(0,0,0,0.6)" }}>
          <div style={{ fontSize: "11px", letterSpacing: "2px", color: gold, marginBottom: "10px", textTransform: "uppercase" }}>AudD API Key</div>
          <input
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            placeholder="Paste your key here..."
            style={{ width: "100%", background: "#0a0a14", border: "1px solid #2a2a3e", color: cream, padding: "10px 12px", borderRadius: "8px", fontSize: "13px", boxSizing: "border-box", fontFamily: "monospace", outline: "none" }}
          />
          <div style={{ fontSize: "11px", color: "#4a4a5e", marginTop: "8px", lineHeight: "1.6" }}>
            Free keys at <span style={{ color: gold }}>audd.io</span>. Without a key you get ~10 detections/day — plenty for testing.
          </div>
        </div>
      )}

      {/* ── IDLE ── */}
      {mode === "idle" && (
        <div style={{ textAlign: "center", position: "relative", zIndex: 10, padding: "24px" }}>
          <VinylSpinner spinning={false} />
          <div style={{ marginTop: "28px", marginBottom: "6px", fontSize: "11px", letterSpacing: "4px", color: gold, textTransform: "uppercase" }}>
            Taylor Swift Edition
          </div>
          <div style={{ color: "#3a3a50", fontSize: "22px", marginBottom: "8px", letterSpacing: "1px" }}>· · ·</div>
          <div style={{ fontSize: "14px", color: "#5a5a7a", marginBottom: "44px", maxWidth: "260px", lineHeight: "1.8", margin: "0 auto 44px" }}>
            Put on a record, then tap Listen and hold your device close to the speakers.
          </div>
          <Btn onClick={startListening} variant="primary">Listen</Btn>
        </div>
      )}

      {/* ── LISTENING ── */}
      {mode === "listening" && (
        <div style={{ textAlign: "center", position: "relative", zIndex: 10, padding: "24px" }}>
          <div style={{ position: "relative", width: "96px", height: "96px", margin: "0 auto 24px" }}>
            <div style={{ position: "absolute", inset: 0 }}>
              <ProgressRing progress={listenProgress} />
            </div>
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <WaveAnimation active={true} />
            </div>
          </div>
          <div style={{ fontSize: "20px", marginBottom: "8px", color: cream }}>Listening…</div>
          <div style={{ fontSize: "13px", color: "#4a4a6a" }}>Hold your device near the speakers</div>
        </div>
      )}

      {/* ── DETECTING ── */}
      {mode === "detecting" && (
        <div style={{ textAlign: "center", position: "relative", zIndex: 10, padding: "24px" }}>
          <VinylSpinner spinning={true} />
          <div style={{ marginTop: "24px", fontSize: "18px", color: cream }}>Matching song…</div>
          <div style={{ fontSize: "12px", color: "#4a4a6a", marginTop: "8px", letterSpacing: "1px" }}>Just a moment</div>
        </div>
      )}

      {/* ── ERROR ── */}
      {mode === "error" && (
        <div style={{ textAlign: "center", maxWidth: "320px", position: "relative", zIndex: 10, padding: "24px" }}>
          <div style={{ fontSize: "36px", marginBottom: "20px" }}>🎵</div>
          <div style={{ color: rose, marginBottom: "28px", lineHeight: "1.7", fontSize: "15px" }}>{error}</div>
          <Btn onClick={reset} variant="ghost">Try Again</Btn>
        </div>
      )}

      {/* ── CONFIRMED ── */}
      {mode === "confirmed" && detectedSong && (
        <div style={{ textAlign: "center", maxWidth: "380px", position: "relative", zIndex: 10, padding: "24px" }}>
          {detectedSong.artwork && (
            <img
              src={detectedSong.artwork}
              alt="album art"
              style={{ width: "130px", height: "130px", borderRadius: "10px", marginBottom: "24px", boxShadow: "0 12px 48px rgba(0,0,0,0.7)", display: "block", margin: "0 auto 24px" }}
            />
          )}
          <div style={{ fontSize: "10px", letterSpacing: "4px", color: gold, marginBottom: "10px", textTransform: "uppercase" }}>
            ✦ Identified ✦
          </div>
          <div style={{ fontSize: "26px", fontWeight: "bold", color: "#fff", marginBottom: "6px", lineHeight: "1.2" }}>
            {detectedSong.title}
          </div>
          <div style={{ color: "#7a7a9a", marginBottom: "4px", fontSize: "14px" }}>{detectedSong.artist}</div>
          <div style={{ color: "#4a4a6a", fontSize: "12px", marginBottom: "16px" }}>{detectedSong.album}</div>
          <div style={{ fontSize: "12px", marginBottom: "32px", display: "flex", justifyContent: "center", gap: "16px", flexWrap: "wrap" }}>
            <span style={{ color: gold }}>Detected at {detectedSong.timecode}</span>
            {hasLyrics
              ? <span style={{ color: "#6aaa8a" }}>· Synced lyrics ready ✓</span>
              : <span style={{ color: "#8a6a4a" }}>· No synced lyrics found</span>
            }
          </div>
          <Btn onClick={startSync} variant="primary" style={{ display: "inline-block", marginBottom: "12px" }}>
            Start Lyrics
          </Btn>
          <div style={{ marginTop: "12px" }}>
            <Btn onClick={reset} variant="text">Not this song? Try again</Btn>
          </div>
        </div>
      )}

      {/* ── SYNCING ── */}
      {mode === "syncing" && (
        <div style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column", zIndex: 10 }}>

          {/* Song pill */}
          <div style={{ paddingTop: "70px", paddingBottom: "12px", textAlign: "center", flexShrink: 0, background: "linear-gradient(to bottom, rgba(10,10,20,0.95) 60%, transparent)" }}>
            <div style={{ display: "inline-flex", alignItems: "center", gap: "10px", background: "rgba(255,255,255,0.05)", padding: "8px 16px", borderRadius: "50px", border: "1px solid rgba(255,255,255,0.08)" }}>
              {detectedSong?.artwork && <img src={detectedSong.artwork} alt="" style={{ width: "24px", height: "24px", borderRadius: "4px" }} />}
              <span style={{ fontSize: "12px", color: cream, letterSpacing: "1px" }}>{detectedSong?.title}</span>
              <span style={{ fontSize: "11px", color: "#4a4a6a" }}>{formatTime(playbackTime)}</span>
            </div>
          </div>

          {/* Lyric Display */}
          <div style={{ flex: 1, overflow: "hidden", position: "relative", display: "flex", flexDirection: "column", justifyContent: "center" }}>
            <div style={{ overflowY: "auto", padding: "10vh 24px", scrollBehavior: "smooth", height: "100%" }}>
              {lyrics.length > 0 ? (
                lyrics.map((line, i) => {
                  const dist = i - currentIndex;
                  if (dist < -6 || dist > 6) return null;
                  const isCurrent = dist === 0;

                  let fontSize, color, opacity, weight, scale, blur;
                  if (isCurrent) {
                    fontSize = "28px"; color = "#ffffff"; opacity = 1;
                    weight = "700"; scale = 1; blur = 0;
                  } else if (Math.abs(dist) === 1) {
                    fontSize = "19px"; color = cream; opacity = 0.55;
                    weight = "400"; scale = 0.97; blur = 0;
                  } else if (Math.abs(dist) === 2) {
                    fontSize = "15px"; color = cream; opacity = 0.28;
                    weight = "400"; scale = 0.94; blur = 0;
                  } else {
                    fontSize = "13px"; color = cream; opacity = 0.12;
                    weight = "400"; scale = 0.92; blur = 1;
                  }

                  return (
                    <div
                      key={i}
                      ref={isCurrent ? currentLineRef : null}
                      style={{
                        textAlign: "center",
                        padding: "10px 16px",
                        fontSize,
                        fontWeight: weight,
                        color,
                        opacity,
                        transform: `scale(${scale})`,
                        filter: blur ? `blur(${blur}px)` : "none",
                        transition: "all 0.35s cubic-bezier(0.4, 0, 0.2, 1)",
                        lineHeight: "1.45",
                        letterSpacing: isCurrent ? "0.4px" : "0",
                        textShadow: isCurrent ? `0 0 40px rgba(212,168,70,0.3)` : "none",
                        cursor: "default",
                      }}
                    >
                      {line.text}
                    </div>
                  );
                })
              ) : (
                <div style={{ textAlign: "center", color: "#3a3a5a", fontSize: "15px" }}>
                  <div style={{ marginBottom: "8px" }}>No synced lyrics found for this track</div>
                  <div style={{ fontSize: "12px", color: "#2a2a4a" }}>Detected at {detectedSong?.timecode}</div>
                </div>
              )}
            </div>
            {/* Gradient fade edges */}
            <div style={{ position: "absolute", top: "70px", left: 0, right: 0, height: "120px", background: "linear-gradient(to bottom, rgba(10,10,20,0.98), transparent)", pointerEvents: "none" }} />
            <div style={{ position: "absolute", bottom: "80px", left: 0, right: 0, height: "120px", background: "linear-gradient(to top, rgba(10,10,20,0.98), transparent)", pointerEvents: "none" }} />
          </div>

          {/* Controls */}
          <div style={{ padding: "16px 24px 32px", display: "flex", justifyContent: "center", alignItems: "center", gap: "12px", flexShrink: 0, background: "linear-gradient(to top, rgba(10,10,20,1) 70%, transparent)" }}>
            <button
              onClick={() => nudge(-5)}
              style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", color: cream, padding: "9px 18px", borderRadius: "20px", cursor: "pointer", fontSize: "12px", letterSpacing: "1px", fontFamily: "inherit" }}
            >
              ← 5s
            </button>
            <button
              onClick={() => nudge(-2)}
              style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", color: cream, padding: "9px 14px", borderRadius: "20px", cursor: "pointer", fontSize: "12px", letterSpacing: "1px", fontFamily: "inherit" }}
            >
              ← 2s
            </button>
            <button
              onClick={reset}
              style={{ background: "rgba(212,168,70,0.12)", border: `1px solid ${gold}`, color: gold, padding: "9px 22px", borderRadius: "20px", cursor: "pointer", fontSize: "12px", letterSpacing: "1.5px", fontFamily: "inherit", textTransform: "uppercase" }}
            >
              ■ Stop
            </button>
            <button
              onClick={() => nudge(2)}
              style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", color: cream, padding: "9px 14px", borderRadius: "20px", cursor: "pointer", fontSize: "12px", letterSpacing: "1px", fontFamily: "inherit" }}
            >
              2s →
            </button>
            <button
              onClick={() => nudge(5)}
              style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", color: cream, padding: "9px 18px", borderRadius: "20px", cursor: "pointer", fontSize: "12px", letterSpacing: "1px", fontFamily: "inherit" }}
            >
              5s →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
