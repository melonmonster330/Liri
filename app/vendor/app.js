(() => {
  // app/base/lib/text.js
  function parseLRC(lrc) {
    const re = /\[(\d{2}):(\d{2})[.:](\d{2,3})\](.*)/;
    return lrc.split("\n").reduce((acc, line) => {
      const m = line.match(re);
      if (!m) return acc;
      const t = parseInt(m[1]) * 60 + parseInt(m[2]) + parseInt(m[3].padEnd(3, "0").slice(0, 3)) / 1e3;
      const text = m[4].trim();
      if (text) acc.push({ time: t, text });
      return acc;
    }, []).sort((a, b) => a.time - b.time);
  }
  function formatTime(s) {
    return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
  }
  function normText(s) {
    return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }
  function timeAgo(iso) {
    const diff = (Date.now() - new Date(iso)) / 1e3;
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  // app/base/lib/whisper.js
  var WHISPER_PROXY = window.Capacitor ? "https://www.getliri.com/api/whisper" : "/api/whisper";

  // app/base/lib/sides.js
  function getSideForIndex(idx, track, vinylSides, dbTracks) {
    const v = vinylSides?.[idx];
    if (v?.side) return v.side;
    if (dbTracks?.length) {
      const titleNorm = normText(track?.trackName);
      if (titleNorm) {
        const titled = dbTracks.find((d) => d.title && normText(d.title) === titleNorm);
        if (titled?.side) return titled.side;
      }
      const dbAt = dbTracks[idx];
      if (dbAt?.side) return dbAt.side;
    }
    return null;
  }
  function getSideGroups(tracks, vinylSides, dbTracks) {
    if (!tracks?.length) return [];
    const sides = tracks.map((t, i) => getSideForIndex(i, t, vinylSides, dbTracks));
    const haveAnyReal = sides.some((s) => !!s);
    if (haveAnyReal) {
      const map = {};
      tracks.forEach((t, i) => {
        const s = sides[i] || "?";
        if (!map[s]) map[s] = [];
        map[s].push({ track: t, idx: i });
      });
      return Object.entries(map).sort(([a], [b]) => a.localeCompare(b)).map(([side, group]) => ({ side, tracks: group }));
    }
    const mid = Math.ceil(tracks.length / 2);
    return [
      { side: "A", tracks: tracks.slice(0, mid).map((t, i) => ({ track: t, idx: i })) },
      { side: "B", tracks: tracks.slice(mid).map((t, i) => ({ track: t, idx: mid + i })) }
    ].filter((g) => g.tracks.length > 0);
  }

  // app/base/lib/notifications.js
  function getLocalNotif() {
    return window.Capacitor?.Plugins?.LocalNotifications ?? null;
  }
  function userOptedIn() {
    return localStorage.getItem("liri_flip_notify") === "true";
  }
  function showFlipPushNotification(song) {
    if (!userOptedIn()) return;
    const title = "Time to flip! \u{1F4BF}";
    const body = song ? `${song.artist} \u2014 ${song.album || "Side A done"}` : "Your side has ended \u2014 flip the record";
    if (window.Capacitor) {
      try {
        getLocalNotif()?.schedule({ notifications: [{ id: 1001, title, body }] });
      } catch {
      }
    } else {
      if (Notification.permission !== "granted") return;
      try {
        new Notification(title, { body, icon: song?.artwork || void 0, tag: "liri-flip" });
      } catch {
      }
    }
  }
  function showAlbumEndPushNotification(song) {
    if (!userOptedIn()) return;
    const title = "That's the album! \u{1F3B6}";
    const body = song ? `${song.artist} \u2014 ${song.album || "Album complete"}` : "Put on your next record to keep going";
    if (window.Capacitor) {
      try {
        getLocalNotif()?.schedule({ notifications: [{ id: 1002, title, body }] });
      } catch {
      }
    } else {
      if (Notification.permission !== "granted") return;
      try {
        new Notification(title, { body, icon: song?.artwork || void 0, tag: "liri-album-end" });
      } catch {
      }
    }
  }

  // app/base/components/Vinyl.js
  function Vinyl({ size = 120, spinning = false }) {
    return /* @__PURE__ */ React.createElement("div", {
      style: {
        width: size,
        height: size,
        margin: "0 auto",
        animation: spinning ? "vinyl-spin 2s linear infinite" : "none",
        flexShrink: 0
      }
    }, /* @__PURE__ */ React.createElement(
      "svg",
      {
        viewBox: "0 0 100 100",
        style: { width: "100%", height: "100%" }
      },
      /* @__PURE__ */ React.createElement("defs", null, /* @__PURE__ */ React.createElement(
        "radialGradient",
        {
          id: "vg2",
          cx: "50%",
          cy: "50%",
          r: "50%"
        },
        /* @__PURE__ */ React.createElement("stop", { offset: "0%", stopColor: "#1e1828" }),
        /* @__PURE__ */ React.createElement("stop", { offset: "70%", stopColor: "#0a0812" }),
        /* @__PURE__ */ React.createElement("stop", { offset: "100%", stopColor: "#050508" })
      )),
      /* @__PURE__ */ React.createElement("circle", { cx: "50", cy: "50", r: "49", fill: "url(#vg2)" }),
      [46, 42, 38, 34, 30, 26, 22].map((r, i) => /* @__PURE__ */ React.createElement("circle", {
        key: i,
        cx: "50",
        cy: "50",
        r,
        fill: "none",
        stroke: "rgba(255,255,255,0.04)",
        strokeWidth: "0.8"
      })),
      /* @__PURE__ */ React.createElement("circle", { cx: "50", cy: "50", r: "10", fill: "#d4a846", opacity: "0.85" }),
      /* @__PURE__ */ React.createElement("circle", { cx: "50", cy: "50", r: "3.5", fill: "#080810" })
    ));
  }

  // app/base/components/WaveAnimation.js
  var { useRef, useEffect } = React;
  var BAR_MULTS = [0.55, 0.85, 1, 0.75, 0.95, 0.65, 0.9, 0.7, 1, 0.6, 0.8, 0.5];
  function WaveAnimation({ active, size = 1, analyserRef, level }) {
    const barRefs = useRef([]);
    const rafRef = useRef(null);
    const smoothRef = useRef(new Float32Array(BAR_MULTS.length));
    const histRef = useRef([]);
    useEffect(() => {
      if (!level || level <= 0) {
        histRef.current = [];
        return;
      }
      const now = Date.now();
      histRef.current.push({ t: now, v: level });
      histRef.current = histRef.current.filter((e) => now - e.t < 3e3);
    }, [level]);
    useEffect(() => {
      if (!active) {
        cancelAnimationFrame(rafRef.current);
        return;
      }
      let freqBuf = null;
      let smoothedEnergy = 0;
      const n = BAR_MULTS.length;
      const tick = () => {
        const an = analyserRef?.current;
        const now = Date.now();
        if (an) {
          if (!freqBuf || freqBuf.length !== an.frequencyBinCount) {
            freqBuf = new Uint8Array(an.frequencyBinCount);
          }
          an.getByteFrequencyData(freqBuf);
          const firstBin = 1, lastBin = Math.min(freqBuf.length - 2, 14);
          let sum = 0;
          for (let b = firstBin; b <= lastBin; b++) sum += freqBuf[b];
          const rawEnergy = sum / ((lastBin - firstBin + 1) * 255);
          smoothedEnergy += rawEnergy > smoothedEnergy ? (rawEnergy - smoothedEnergy) * 0.3 : (rawEnergy - smoothedEnergy) * 0.05;
          const t = now * 22e-4;
          BAR_MULTS.forEach((mult, i) => {
            const phase = i / (n - 1) * Math.PI * 2.4;
            const wave = (Math.sin(t + phase) + 1) / 2;
            const base = Math.max(0.07, smoothedEnergy);
            const target = base * 0.45 + wave * base * 0.9 * mult;
            const prev = smoothRef.current[i];
            smoothRef.current[i] = prev + (target - prev) * 0.09;
            const h = Math.max(3, smoothRef.current[i] * 68) * size;
            if (barRefs.current[i]) barRefs.current[i].style.height = h + "px";
          });
        } else if (histRef.current.length > 0) {
          const v = histRef.current[histRef.current.length - 1]?.v || 0;
          BAR_MULTS.forEach((mult, i) => {
            const prev = smoothRef.current[i];
            smoothRef.current[i] = v > prev ? prev + (v - prev) * 0.45 : prev * 0.92;
            const h = Math.max(4, Math.pow(smoothRef.current[i], 0.38) * 58 * mult) * size;
            if (barRefs.current[i]) barRefs.current[i].style.height = h + "px";
          });
        } else {
          const t = now * 1e-3;
          BAR_MULTS.forEach((mult, i) => {
            const sinVal = (Math.sin(t * (1.8 + i * 0.18) + i * 0.72) + 1) / 2;
            const h = Math.max(3, 48 * 0.55 * mult * (0.45 + 0.55 * sinVal)) * size;
            if (barRefs.current[i]) barRefs.current[i].style.height = h + "px";
          });
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(rafRef.current);
    }, [active]);
    return /* @__PURE__ */ React.createElement("div", {
      style: {
        display: "flex",
        gap: `${4 * size}px`,
        alignItems: "center",
        height: `${52 * size}px`,
        justifyContent: "center"
      }
    }, BAR_MULTS.map((mult, i) => /* @__PURE__ */ React.createElement("div", {
      key: i,
      ref: (el) => barRefs.current[i] = el,
      style: {
        width: `${3 * size}px`,
        borderRadius: "2px",
        background: "linear-gradient(to top, #d4a846, #c9807a)",
        height: `${3 * size}px`,
        opacity: active ? 1 : 0.3
      }
    })));
  }

  // app/base/components/ProgressRing.js
  var { useState, useEffect: useEffect2 } = React;
  function ProgressRing({ size = 96 }) {
    const r = size / 2 - 5;
    const circ = 2 * Math.PI * r;
    const [t, setT] = useState(0);
    useEffect2(() => {
      const start = Date.now();
      const id = setInterval(() => setT((Date.now() - start) % 3e4 / 3e4), 50);
      return () => clearInterval(id);
    }, []);
    return /* @__PURE__ */ React.createElement(
      "svg",
      {
        width: size,
        height: size,
        style: { transform: "rotate(-90deg)" }
      },
      /* @__PURE__ */ React.createElement("circle", {
        cx: size / 2,
        cy: size / 2,
        r,
        fill: "none",
        stroke: "rgba(255,255,255,0.06)",
        strokeWidth: "3"
      }),
      /* @__PURE__ */ React.createElement("circle", {
        cx: size / 2,
        cy: size / 2,
        r,
        fill: "none",
        strokeWidth: "3",
        strokeLinecap: "round",
        stroke: "url(#pg2)",
        strokeDasharray: `${circ * t} ${circ}`
      }),
      /* @__PURE__ */ React.createElement(
        "defs",
        null,
        /* @__PURE__ */ React.createElement(
          "linearGradient",
          {
            id: "pg2",
            x1: "0%",
            y1: "0%",
            x2: "100%",
            y2: "0%"
          },
          /* @__PURE__ */ React.createElement("stop", { offset: "0%", stopColor: "#d4a846" }),
          /* @__PURE__ */ React.createElement("stop", { offset: "100%", stopColor: "#e8a0a8" })
        )
      )
    );
  }

  // app/ios/shazam.js
  function getPlugin() {
    const np = window.Capacitor?.nativePromise;
    if (!np) return null;
    return {
      findMatch: (opts) => np("ShazamPlugin", "findMatch", opts || {}),
      cancel: () => np("ShazamPlugin", "cancel", {}),
      waitForSilence: (opts) => np("ShazamPlugin", "waitForSilence", opts || {})
    };
  }
  var Shazam = {
    findMatch: (opts) => {
      const p = getPlugin();
      if (!p) return Promise.reject(new Error("ShazamPlugin unavailable"));
      return p.findMatch(opts);
    },
    cancel: () => {
      getPlugin()?.cancel().catch(() => {
      });
    },
    waitForSilence: (opts) => {
      const p = getPlugin();
      if (!p) return Promise.resolve({ silence: false });
      return p.waitForSilence(opts);
    }
  };

  // app/ios/iap.js
  function getLiriIAP() {
    return window.Capacitor?.Plugins?.LiriIAP ?? null;
  }

  // app/src/main.js
  var {
    useState: useState2,
    useEffect: useEffect3,
    useRef: useRef2,
    useCallback
  } = React;
  if (typeof supabase === "undefined") {
    document.getElementById("root").innerHTML = '<div style="min-height:100vh;background:#080810;display:flex;align-items:center;justify-content:center;font-family:system-ui;color:#e8a0a8;text-align:center;padding:32px">Could not load auth library.<br><small style="color:#333;margin-top:8px;display:block">Check your connection and reload</small></div>';
    throw new Error("Supabase not loaded");
  }
  var sb = supabase.createClient("https://xjdjpaxgymgbvcwmvorc.supabase.co", "sb_publishable_C-NBnfg0ltAoUi46XQTUjA_ozjZW_Nd");
  var APP_VERSION = "1.1.4";
  var IS_IOS = !!window.Capacitor;
  var TRANSCRIBE_PROXY = window.Capacitor ? "https://www.getliri.com/api/transcribe" : "/api/transcribe";
  var ITUNES_PROXY = window.Capacitor ? "https://www.getliri.com/api/itunes-lookup" : "/api/itunes-lookup";
  var styleEl = document.createElement("style");
  styleEl.textContent = `
      @keyframes vinyl-spin { to { transform: rotate(360deg); } }
      @keyframes wave-0 { from { transform: scaleY(0.3); } to { transform: scaleY(1); } }
      @keyframes wave-1 { from { transform: scaleY(0.5); } to { transform: scaleY(1); } }
      @keyframes wave-2 { from { transform: scaleY(0.2); } to { transform: scaleY(0.9); } }
      @keyframes wave-3 { from { transform: scaleY(0.6); } to { transform: scaleY(1); } }
      @keyframes fade-up  { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes slide-up    { from { transform: translateY(100%); } to { transform: translateY(0); } }
      @keyframes slide-right { from { transform: translateX(100%); } to { transform: translateX(0); } }
      @keyframes pulse    { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
      .safe-top { padding-top: max(96px, calc(env(safe-area-inset-top) + 52px)) !important; }
      .safe-bottom { padding-bottom: max(48px, calc(env(safe-area-inset-bottom) + 28px)) !important; }
    `;
  document.head.appendChild(styleEl);
  function Liri() {
    const [mode, setMode] = useState2("idle");
    const [detectedSong, setDetectedSong] = useState2(null);
    const [identifiedBy, setIdentifiedBy] = useState2(null);
    const [songDuration, setSongDuration] = useState2(null);
    const [lyrics, setLyrics] = useState2([]);
    const [currentIndex, setCurrentIndex] = useState2(0);
    const [playbackTime, setPlaybackTime] = useState2(0);
    const [error, setError] = useState2(null);
    const [listenProgress, setListenProgress] = useState2(0);
    const [liveTranscript, setLiveTranscript] = useState2("");
    const [listenAttempt, setListenAttempt] = useState2(0);
    const [listenSecs, setListenSecs] = useState2(0);
    const [showSettings, setShowSettings] = useState2(false);
    const [isWide, setIsWide] = useState2(() => window.innerWidth >= 768);
    useEffect3(() => {
      const onResize = () => setIsWide(window.innerWidth >= 768);
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    }, []);
    const [isLandscape, setIsLandscape] = useState2(() => window.innerWidth > window.innerHeight && window.innerWidth >= 600);
    useEffect3(() => {
      const onResize = () => setIsLandscape(window.innerWidth > window.innerHeight && window.innerWidth >= 600);
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    }, []);
    const [controlsVisible, setControlsVisible] = useState2(true);
    const controlsHideTimerRef = useRef2(null);
    const [showBugReport, setShowBugReport] = useState2(false);
    const [bugText, setBugText] = useState2("");
    const [bugSending, setBugSending] = useState2(false);
    const [bugSent, setBugSent] = useState2(false);
    const [showPremiumInfo, setShowPremiumInfo] = useState2(false);
    const [showDeleteAccount, setShowDeleteAccount] = useState2(false);
    const [deleteWorking, setDeleteWorking] = useState2(false);
    const [deleteError, setDeleteError] = useState2(null);
    const [showChangePw, setShowChangePw] = useState2(false);
    const [changePwNew, setChangePwNew] = useState2("");
    const [changePwConfirm, setChangePwConfirm] = useState2("");
    const [changePwWorking, setChangePwWorking] = useState2(false);
    const [changePwError, setChangePwError] = useState2(null);
    const [changePwDone, setChangePwDone] = useState2(false);
    const [showHistory, setShowHistory] = useState2(false);
    const [showTrackList, setShowTrackList] = useState2(false);
    const [collapsedSides, setCollapsedSides] = useState2(/* @__PURE__ */ new Set());
    const toggleSideCollapse = (side) => setCollapsedSides((prev) => {
      const n = new Set(prev);
      n.has(side) ? n.delete(side) : n.add(side);
      return n;
    });
    const [user, setUser] = useState2(null);
    const [authLoading, setAuthLoading] = useState2(true);
    const [authMode, setAuthMode] = useState2("signin");
    const [authEmail, setAuthEmail] = useState2("");
    const [authPassword, setAuthPassword] = useState2("");
    const [authConfirmPw, setAuthConfirmPw] = useState2("");
    const [authName, setAuthName] = useState2("");
    const [authError, setAuthError] = useState2(null);
    const [authWorking, setAuthWorking] = useState2(false);
    const [authSheet, setAuthSheet] = useState2(null);
    const [authVerifyPending, setAuthVerifyPending] = useState2(false);
    const isUnlimited = (u) => true;
    const [userTier, setUserTier] = useState2("free");
    const [albumCount, setAlbumCount] = useState2(0);
    const [upgradeWorking, setUpgradeWorking] = useState2(false);
    const sessionTokenRef = useRef2(null);
    const [history, setHistory] = useState2([]);
    const [historyLoading, setHistoryLoading] = useState2(false);
    const vinylMode = true;
    const autoAdvanceFiredRef = useRef2(false);
    const [turntableAlbum, setTurntableAlbum] = useState2(() => {
      try {
        return JSON.parse(localStorage.getItem("liri_turntable") || "null");
      } catch {
        return null;
      }
    });
    const [showAlbumPicker, setShowAlbumPicker] = useState2(false);
    const [userLibrary, setUserLibrary] = useState2([]);
    const [libLoading, setLibLoading] = useState2(false);
    const [turntableTracksLoading, setTurntableTracksLoading] = useState2(false);
    const [turntableTracksProgress, setTurntableTracksProgress] = useState2({ percent: 0, stage: "" });
    const turntableAlbumRef = useRef2(turntableAlbum);
    const turntableTracksRef = useRef2([]);
    const turntableMatchedIdxRef = useRef2(-1);
    const turntableLyricsCacheRef = useRef2({});
    const wordsDataRef = useRef2({});
    const autoRetryCountRef = useRef2(0);
    const [albumTracks, setAlbumTracks] = useState2([]);
    const [currentTrackIndex, setCurrentTrackIndex] = useState2(-1);
    const albumTracksRef = useRef2([]);
    const currentTrackIndexRef = useRef2(-1);
    const [isResyncing, setIsResyncing] = useState2(false);
    const [isNeedleDrop, setIsNeedleDrop] = useState2(false);
    const [keepScreenAwake, setKeepScreenAwake] = useState2(() => localStorage.getItem("liri_keep_awake") === "true");
    const wakeLockRef = useRef2(null);
    const [isPaused, setIsPaused] = useState2(false);
    const [kbToast, setKbToast] = useState2(null);
    const kbToastTimerRef = useRef2(null);
    const [shouldAdvanceTrack, setShouldAdvanceTrack] = useState2(false);
    const [sideEndReason, setSideEndReason] = useState2("failed");
    const [sideEndNextDiscInfo, setSideEndNextDiscInfo] = useState2(null);
    const flipChimeTimersRef = useRef2([]);
    const flipStartDelayMsRef = useRef2(0);
    const [albumCollectionId, setAlbumCollectionId] = useState2(null);
    const albumCollectionIdRef = useRef2(null);
    const albumTpsRef = useRef2(0);
    const [vinylDbRelease, setVinylDbRelease] = useState2(null);
    const vinylDbReleaseRef = useRef2(null);
    const vinylSidesRef = useRef2([]);
    const [flipSound, setFlipSound] = useState2(() => localStorage.getItem("liri_flip_sound") !== "false");
    const [flipNotify, setFlipNotify] = useState2(() => localStorage.getItem("liri_flip_notify") === "true");
    const [notifyDenied, setNotifyDenied] = useState2(false);
    const [nudgeMenu, setNudgeMenu] = useState2(null);
    const nudgeMenuTimerRef = useRef2(null);
    const [showOnboarding, setShowOnboarding] = useState2(() => !localStorage.getItem("liri_onboarding_done"));
    const [onboardingStep, setOnboardingStep] = useState2(0);
    const ONBOARDING_STEPS = 5;
    const dismissOnboarding = () => {
      localStorage.setItem("liri_onboarding_done", "true");
      setShowOnboarding(false);
    };
    useEffect3(() => {
      if (user) dismissOnboarding();
    }, [user]);
    const sessionId = React.useMemo(() => {
      let sid = localStorage.getItem("liri_session_id");
      if (!sid) {
        sid = ("10000000-1000-4000-8000" + -1e11).replace(/[018]/g, (c) => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
        localStorage.setItem("liri_session_id", sid);
      }
      return sid;
    }, []);
    const streamRef = useRef2(null);
    const speechRecRef = useRef2(null);
    const analyserNodeRef = useRef2(null);
    const audioCtxRef = useRef2(null);
    const chimeCtxRef = useRef2(null);
    const syncIntervalRef = useRef2(null);
    const syncStartRef = useRef2(null);
    const detectedAtRef = useRef2(null);
    const initialPosRef = useRef2(0);
    const userNudgeRef = useRef2(0);
    const syncCalcRef = useRef2(null);
    const recordingStartRef = useRef2(null);
    const lyricsRef = useRef2([]);
    const progressTimerRef = useRef2(null);
    const currentLineRef = useRef2(null);
    const creditsRef = useRef2(null);
    const userScrollingRef = useRef2(false);
    const [userScrolling, setUserScrolling] = useState2(false);
    const scrollInhibitTimer = useRef2(null);
    const listenSessionRef = useRef2(0);
    const attemptLogRef = useRef2([]);
    const lastRecordingRef = useRef2(null);
    const recognitionWonRef = useRef2(false);
    const [audioLevel, setAudioLevel] = useState2(0);
    const [lastSong, setLastSong] = useState2(null);
    const [hoverNudge, setHoverNudge] = useState2(null);
    useEffect3(() => {
      lyricsRef.current = lyrics;
    }, [lyrics]);
    useEffect3(() => {
      albumTracksRef.current = albumTracks;
    }, [albumTracks]);
    useEffect3(() => {
      currentTrackIndexRef.current = currentTrackIndex;
    }, [currentTrackIndex]);
    useEffect3(() => {
      vinylDbReleaseRef.current = vinylDbRelease;
    }, [vinylDbRelease]);
    useEffect3(() => {
      albumCollectionIdRef.current = albumCollectionId;
    }, [albumCollectionId]);
    const getAlbumSideData = (cid) => {
      if (!cid) return null;
      try {
        return JSON.parse(localStorage.getItem(`liri_album_sides_${cid}`) || "null");
      } catch {
        return null;
      }
    };
    const saveAlbumSideData = (cid, sides, totalTracks) => {
      if (!cid || !totalTracks) return;
      const tps = Math.ceil(totalTracks / sides);
      const existing = getAlbumSideData(cid) || {};
      const data = {
        ...existing,
        tps,
        sides,
        totalTracks,
        confirmed: (existing.confirmed || 0) + 1
      };
      localStorage.setItem(`liri_album_sides_${cid}`, JSON.stringify(data));
      albumTpsRef.current = tps;
    };
    const fetchVinylRelease = async (collectionId) => {
      try {
        const {
          data
        } = await sb.from("vinyl_releases").select("*, vinyl_tracks(*)").eq("itunes_collection_id", collectionId).order("confirmed_count", {
          ascending: false
        }).limit(1).single();
        return data || null;
      } catch {
        return null;
      }
    };
    const autoPopulateVinylSides = async (collectionId, albumName, artistName) => {
      try {
        const {
          data: existing
        } = await sb.from("vinyl_releases").select("id").eq("itunes_collection_id", String(collectionId)).maybeSingle();
        if (existing) return existing.id;
        const norm = normText;
        const normAlbum = norm(albumName);
        const normArtist = norm(artistName);
        const normAlbumBase = norm(albumName.split("(")[0].trim());
        const search = await fetch(`/api/discogs-lookup?q=${encodeURIComponent(artistName + " " + albumName)}&per_page=10`).then((r) => r.json()).catch(() => null);
        if (!search?.results?.length) return null;
        const candidates = search.results.filter((r) => {
          const t = norm(r.title || "");
          return t.includes(normArtist) && (t.includes(normAlbum) || t.includes(normAlbumBase));
        }).slice(0, 5);
        if (!candidates.length) candidates.push(...search.results.slice(0, 3));
        let bestDetail = null;
        let bestSideCount = 0;
        for (const candidate of candidates) {
          const detail = await fetch(`/api/discogs-lookup?id=${candidate.id}`).then((r) => r.json()).catch(() => null);
          if (!detail?.tracklist?.length) continue;
          const sideCount = new Set(detail.tracklist.map((t) => (t.position || "").toUpperCase().match(/^([A-Z])/)?.[1]).filter(Boolean)).size;
          if (sideCount > bestSideCount) {
            bestSideCount = sideCount;
            bestDetail = detail;
          }
          if (bestSideCount >= 6) break;
        }
        if (!bestDetail || bestSideCount === 0) return null;
        const hasSidePos = bestDetail.tracklist.some((t) => /^[A-Z]\d/i.test(t.position || ""));
        if (!hasSidePos) return null;
        const {
          data: rel,
          error: relErr
        } = await sb.from("vinyl_releases").insert({
          itunes_collection_id: String(collectionId),
          album_name: albumName,
          artist_name: artistName,
          release_year: bestDetail.year || null,
          record_label: bestDetail.labels?.[0]?.name || null,
          disc_count: Math.ceil(bestSideCount / 2) || 1
        }).select("id").single();
        if (relErr || !rel) return null;
        const rows = [];
        for (const track of bestDetail.tracklist) {
          const pos = (track.position || "").toUpperCase();
          const m = pos.match(/^([A-Z])(\d+)/);
          if (!m) continue;
          let durationMs = null;
          if (track.duration) {
            const parts = track.duration.split(":");
            if (parts.length === 2) durationMs = (parseInt(parts[0]) * 60 + parseInt(parts[1])) * 1e3;
          }
          rows.push({
            release_id: rel.id,
            disc_number: Math.ceil((m[1].charCodeAt(0) - 64) / 2),
            side: m[1],
            position: pos,
            track_number_on_side: parseInt(m[2]),
            title: track.title,
            duration_ms: durationMs,
            itunes_track_id: null
          });
        }
        if (rows.length > 0) await sb.from("vinyl_tracks").insert(rows);
        return rel.id;
      } catch {
        return null;
      }
    };
    const normTitle = normText;
    const getDbSideEndIndices = (itunesTracks, dbTracks) => {
      const sideGroups = {};
      dbTracks.forEach((t) => {
        if (!sideGroups[t.side]) sideGroups[t.side] = [];
        sideGroups[t.side].push(t);
      });
      const sides = Object.keys(sideGroups).sort();
      const result = [];
      sides.slice(0, -1).forEach((side) => {
        const sorted = sideGroups[side].sort((a, b) => a.track_number_on_side - b.track_number_on_side);
        const lastTitle = normTitle(sorted[sorted.length - 1]?.title);
        const idx = itunesTracks.findIndex((t) => normTitle(t.trackName) === lastTitle);
        if (idx >= 0) result.push(idx);
      });
      result.push(itunesTracks.length - 1);
      return result;
    };
    const playFlipChime = () => {
      if (localStorage.getItem("liri_flip_sound") === "false") return;
      try {
        const ctx = chimeCtxRef.current || new (window.AudioContext || window.webkitAudioContext)();
        const play = () => {
          [[523.25, 0], [659.25, 0.35], [783.99, 0.7]].forEach(([freq, delay]) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.type = "sine";
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0, ctx.currentTime + delay);
            gain.gain.linearRampToValueAtTime(0.3, ctx.currentTime + delay + 0.02);
            gain.gain.exponentialRampToValueAtTime(1e-3, ctx.currentTime + delay + 1.6);
            osc.start(ctx.currentTime + delay);
            osc.stop(ctx.currentTime + delay + 1.6);
          });
        };
        if (ctx.state === "suspended") {
          ctx.resume().then(play);
        } else {
          play();
        }
      } catch {
      }
    };
    const scheduleFlipChimes = (song) => {
      flipChimeTimersRef.current.forEach(clearTimeout);
      flipChimeTimersRef.current = [1e4, 2e4, 3e4, 6e4].map(
        (delay, i) => setTimeout(() => {
          playFlipChime();
          if (i === 0) showFlipPushNotification(song);
        }, delay)
      );
    };
    const cancelFlipChimes = () => {
      flipChimeTimersRef.current.forEach(clearTimeout);
      flipChimeTimersRef.current = [];
    };
    const bumpControls = () => {
      setControlsVisible(true);
      clearTimeout(controlsHideTimerRef.current);
      controlsHideTimerRef.current = setTimeout(() => setControlsVisible(false), 3500);
    };
    const enableFlipNotify = async () => {
      if (window.Capacitor) {
        try {
          const { display } = await (getLocalNotif()?.requestPermissions() ?? Promise.resolve({ display: "denied" }));
          if (display === "granted") {
            setFlipNotify(true);
            localStorage.setItem("liri_flip_notify", "true");
            setNotifyDenied(false);
          } else {
            setNotifyDenied(true);
            setFlipNotify(false);
            localStorage.setItem("liri_flip_notify", "false");
          }
        } catch {
          setNotifyDenied(true);
        }
      } else {
        const perm = await Notification.requestPermission();
        if (perm === "granted") {
          setFlipNotify(true);
          localStorage.setItem("liri_flip_notify", "true");
          setNotifyDenied(false);
        } else {
          setNotifyDenied(true);
          setFlipNotify(false);
          localStorage.setItem("liri_flip_notify", "false");
        }
      }
    };
    const fetchUsage = async () => {
    };
    const fetchHistory = async (u) => {
      if (!u) return;
      setHistoryLoading(true);
      const {
        data
      } = await sb.from("song_history").select("*").eq("user_id", u.id).order("listened_at", {
        ascending: false
      }).limit(50);
      setHistory(data || []);
      setHistoryLoading(false);
    };
    const saveToHistory = async (u, song) => {
      if (!u) return;
      await sb.from("song_history").insert({
        user_id: u.id,
        title: song.title,
        artist: song.artist,
        album: song.album || null,
        artwork_url: song.artwork || null
      });
    };
    const logListeningEvent = async (params) => {
      try {
        await sb.from("listening_events").insert({
          user_id: params.userId || null,
          session_id: sessionId,
          track_title: params.title,
          artist_name: params.artist,
          album_name: params.album || null,
          artwork_url: params.artwork || null,
          genre: params.genre || null,
          itunes_track_id: params.itunesTrackId ? Number(params.itunesTrackId) : null,
          itunes_collection_id: params.collectionId ? Number(params.collectionId) : null,
          vinyl_release_id: params.vinylReleaseId || null,
          vinyl_mode_on: params.vinylModeOn ?? false,
          source: params.source || "recognition",
          platform: window.Capacitor ? "ios" : "web",
          country_code: params.countryCode || null,
          playback_offset_s: params.offsetSecs != null ? Math.round(params.offsetSecs) : null,
          track_duration_s: params.durationSecs != null ? Math.round(params.durationSecs) : null,
          acr_confidence: params.acrScore || null
        });
      } catch (e) {
        console.error("logListeningEvent failed:", e.message);
      }
    };
    const logFlipEvent = async (params) => {
      try {
        await sb.from("flip_events").insert({
          user_id: params.userId || null,
          session_id: sessionId,
          vinyl_release_id: params.vinylReleaseId || null,
          itunes_collection_id: params.collectionId ? Number(params.collectionId) : null,
          album_name: params.album || null,
          artist_name: params.artist || null,
          from_side: params.fromSide || null,
          to_side: params.toSide || null,
          detection_method: params.method || "heuristic"
        });
      } catch (e) {
        console.error("logFlipEvent failed:", e.message);
      }
    };
    useEffect3(() => {
      sb.auth.getSession().then(({
        data: {
          session
        }
      }) => {
        const u = session?.user || null;
        sessionTokenRef.current = session?.access_token || null;
        setUser(u);
        setAuthLoading(false);
        if (u) {
          fetchUsage(u);
          fetchHistory(u);
          fetch(`${window.Capacitor ? "https://www.getliri.com" : ""}/api/subscription-status`, { headers: { "Authorization": `Bearer ${session.access_token}` } }).then((r) => r.ok ? r.json() : null).then((d) => {
            if (d?.tier) {
              setUserTier(d.tier);
              setAlbumCount(d.albumCount || 0);
            }
          }).catch(() => {
          });
          syncAppleSubscription(session.access_token);
        }
      });
      const {
        data: {
          subscription
        }
      } = sb.auth.onAuthStateChange((_e, s) => {
        if (_e === "PASSWORD_RECOVERY") {
          setShowChangePw(true);
          setChangePwError(null);
          setChangePwNew("");
          setChangePwConfirm("");
          setChangePwDone(false);
        }
        const u = s?.user || null;
        sessionTokenRef.current = s?.access_token || null;
        setUser(u);
        if (u) {
          fetchUsage(u);
          fetchHistory(u);
          fetch(`${window.Capacitor ? "https://www.getliri.com" : ""}/api/subscription-status`, { headers: { "Authorization": `Bearer ${s.access_token}` } }).then((r) => r.ok ? r.json() : null).then((d) => {
            if (d?.tier) setUserTier(d.tier);
          }).catch(() => {
          });
        }
      });
      return () => subscription.unsubscribe();
    }, []);
    const [iapPrice, setIapPrice] = useState2("$5.99/mo");
    const [iapWorking, setIapWorking] = useState2(false);
    useEffect3(() => {
      const iap = getLiriIAP();
      if (!IS_IOS || !iap) return;
      iap.fetchProduct().then((p) => {
        if (p?.displayPrice) setIapPrice(`${p.displayPrice}/mo`);
      }).catch(() => {
      });
    }, []);
    const syncAppleSubscription = async (token) => {
      const iap = getLiriIAP();
      if (!IS_IOS || !iap) return;
      try {
        const status = await iap.getSubscriptionStatus();
        if (status?.isActive && status?.signedTransaction) {
          const r = await fetch("https://www.getliri.com/api/stripe-checkout", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
            body: JSON.stringify({ appleTransaction: status.signedTransaction })
          });
          if (r.ok) setUserTier("premium");
        }
      } catch {
      }
    };
    const upgradeWithApple = async () => {
      const iap = getLiriIAP();
      if (!iap) {
        alert("In-app purchases are not available right now. Please try again or contact support.");
        return;
      }
      setIapWorking(true);
      try {
        const result = await iap.purchase();
        if (result?.signedTransaction) {
          const token = sessionTokenRef.current;
          const r = await fetch("https://www.getliri.com/api/stripe-checkout", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
            body: JSON.stringify({ appleTransaction: result.signedTransaction })
          });
          const data = await r.json();
          if (data.tier === "premium") {
            setUserTier("premium");
            setAlbumCount((prev) => prev);
          } else {
            alert(data.error || "Could not verify purchase. Please contact support.");
          }
        }
      } catch (e) {
        if (e?.message !== "cancelled") alert("Purchase failed. Please try again.");
      } finally {
        setIapWorking(false);
      }
    };
    const restoreApplePurchases = async () => {
      const iap = getLiriIAP();
      if (!iap) {
        alert("Restore is not available right now.");
        return;
      }
      setIapWorking(true);
      try {
        const status = await iap.restorePurchases();
        if (status?.isActive && status?.signedTransaction) {
          const token = sessionTokenRef.current;
          const r = await fetch("https://www.getliri.com/api/stripe-checkout", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
            body: JSON.stringify({ appleTransaction: status.signedTransaction })
          });
          if ((await r.json()).tier === "premium") setUserTier("premium");
          else alert("No active subscription found.");
        } else {
          alert("No active subscription found.");
        }
      } catch {
        alert("Restore failed. Please try again.");
      } finally {
        setIapWorking(false);
      }
    };
    const upgradeToStripe = async () => {
      setUpgradeWorking(true);
      try {
        const { data: { session: s } } = await sb.auth.getSession();
        const token = s?.access_token || sessionTokenRef.current;
        const res = await fetch("/api/stripe-checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` }
        });
        const json = await res.json().catch(() => ({}));
        if (json.url) {
          window.location.href = json.url;
        } else {
          alert(json.error || "Could not start checkout. Please try again.");
          setUpgradeWorking(false);
        }
      } catch {
        alert("Network error \u2014 please try again.");
        setUpgradeWorking(false);
      }
    };
    const handleAuth = async () => {
      setAuthError(null);
      if (authMode === "signup") {
        if (!authName.trim()) {
          setAuthError("Please enter your name.");
          return;
        }
        if (!authEmail.trim()) {
          setAuthError("Please enter your email.");
          return;
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(authEmail.trim())) {
          setAuthError("Please enter a valid email address.");
          return;
        }
        if (authPassword.length < 8) {
          setAuthError("Password must be at least 8 characters.");
          return;
        }
        if (authPassword !== authConfirmPw) {
          setAuthError("Passwords don't match.");
          return;
        }
      } else {
        if (!authEmail.trim() || !authPassword) {
          setAuthError("Please enter your email and password.");
          return;
        }
      }
      setAuthWorking(true);
      try {
        if (authMode === "signup") {
          const {
            error: error2
          } = await sb.auth.signUp({
            email: authEmail.trim(),
            password: authPassword,
            options: {
              emailRedirectTo: "https://getliri.com/app",
              data: {
                name: authName.trim()
              }
            }
          });
          if (error2) throw error2;
          setAuthVerifyPending(true);
        } else {
          const {
            error: error2
          } = await sb.auth.signInWithPassword({
            email: authEmail.trim(),
            password: authPassword
          });
          if (error2) throw error2;
          setAuthSheet(null);
        }
      } catch (e) {
        setAuthError(e.message);
      } finally {
        setAuthWorking(false);
      }
    };
    const handleForgotPassword = async () => {
      if (!authEmail.trim()) {
        setAuthError("Enter your email address first.");
        return;
      }
      setAuthWorking(true);
      const {
        error: error2
      } = await sb.auth.resetPasswordForEmail(authEmail.trim(), {
        redirectTo: "https://getliri.com/app"
      });
      setAuthWorking(false);
      setAuthError(error2 ? error2.message : "Password reset link sent \u2014 check your email.");
    };
    const handleResendVerification = async () => {
      setAuthWorking(true);
      const {
        error: error2
      } = await sb.auth.resend({
        type: "signup",
        email: authEmail.trim()
      });
      setAuthWorking(false);
      setAuthError(error2 ? error2.message : "Verification email resent!");
    };
    const handleSignOut = async () => {
      await sb.auth.signOut();
      setShowSettings(false);
      reset();
    };
    const handleChangePassword = async () => {
      setChangePwError(null);
      if (changePwNew.length < 8) {
        setChangePwError("Password must be at least 8 characters.");
        return;
      }
      if (changePwNew !== changePwConfirm) {
        setChangePwError("Passwords don't match.");
        return;
      }
      setChangePwWorking(true);
      const { error: error2 } = await sb.auth.updateUser({ password: changePwNew });
      setChangePwWorking(false);
      if (error2) {
        setChangePwError(error2.message);
        return;
      }
      setChangePwDone(true);
      setTimeout(() => {
        setShowChangePw(false);
        setChangePwNew("");
        setChangePwConfirm("");
        setChangePwDone(false);
      }, 2e3);
    };
    const handleDeleteAccount = async () => {
      setDeleteWorking(true);
      setDeleteError(null);
      try {
        const { data: { session } } = await sb.auth.getSession();
        const token = session?.access_token || sessionTokenRef.current;
        if (!token) throw new Error("Not signed in");
        const resp = await fetch(`${window.Capacitor ? "https://www.getliri.com" : ""}/api/delete-account`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` }
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || "Delete failed");
        await sb.auth.signOut();
        setShowDeleteAccount(false);
        setShowSettings(false);
        reset();
      } catch (e) {
        setDeleteError(e.message);
        setDeleteWorking(false);
      }
    };
    const submitBugReport = async () => {
      if (!bugText.trim()) return;
      setBugSending(true);
      try {
        await sb.from("bug_reports").insert({
          user_id: user?.id || null,
          user_email: user?.email || null,
          app_version: APP_VERSION,
          platform: window.Capacitor ? "ios" : "web",
          description: bugText.trim(),
          meta: {
            userAgent: navigator.userAgent,
            screen: `${window.screen.width}x${window.screen.height}`,
            mode,
            detectedSong: detectedSong?.title || null
          }
        });
        setBugSent(true);
        setBugText("");
        setTimeout(() => {
          setShowBugReport(false);
          setBugSent(false);
        }, 2e3);
      } catch (e) {
        console.error("bug report failed:", e);
      }
      setBugSending(false);
    };
    const fetchTurntableTracks = async (collectionId) => {
      setTurntableTracksLoading(true);
      setTurntableTracksProgress({ percent: 0, stage: "Loading tracks\u2026" });
      turntableTracksRef.current = [];
      turntableLyricsCacheRef.current = {};
      vinylSidesRef.current = [];
      try {
        const alb = turntableAlbumRef.current;
        const artistName = alb?.artist_name || "";
        const albumName = alb?.album_name || "";
        const { data: trackRows } = await sb.from("album_tracks").select("itunes_track_id, track_name, artist_name, track_number, disc_number, duration_ms").eq("itunes_collection_id", collectionId).order("disc_number", { ascending: true }).order("track_number", { ascending: true });
        if (trackRows?.length > 0) {
          turntableTracksRef.current = trackRows.map((t) => ({
            trackName: t.track_name,
            artistName: t.artist_name || artistName,
            collectionName: albumName,
            trackId: t.itunes_track_id || null,
            trackTimeMillis: t.duration_ms || null,
            trackNumber: t.track_number || 1,
            discNumber: t.disc_number || 1
          }));
          setTurntableTracksProgress({ percent: 60, stage: "Loading lyrics\u2026" });
          const { data: lrcRows } = await sb.from("track_lyrics").select("itunes_track_id, lrc_raw, words_json, lyrics_plain").in("itunes_track_id", trackRows.map((t) => t.itunes_track_id).filter(Boolean));
          const cache = {};
          for (const row of lrcRows || []) {
            if (row.itunes_track_id) {
              let wordsJson = row.words_json || null;
              if (typeof wordsJson === "string") {
                try {
                  wordsJson = JSON.parse(wordsJson);
                } catch {
                  wordsJson = null;
                }
              }
              cache[String(row.itunes_track_id)] = {
                lrc_raw: row.lrc_raw || null,
                words_json: Array.isArray(wordsJson) ? wordsJson : null,
                lyrics_plain: row.lyrics_plain || null
              };
            }
          }
          console.log("[turntable] lrcRows:", (lrcRows || []).length, "cache entries:", Object.keys(cache).length, "tracks:", trackRows.length);
          const missingTracks = trackRows.filter((t) => t.itunes_track_id && !cache[String(t.itunes_track_id)]);
          if (missingTracks.length > 0) {
            await Promise.all(missingTracks.map(async (t) => {
              try {
                const p = new URLSearchParams({ track_name: t.track_name, artist_name: t.artist_name || artistName, album_name: albumName });
                if (t.duration_ms) p.set("duration", String(Math.round(t.duration_ms / 1e3)));
                const r = await fetch(`https://lrclib.net/api/get?${p}`, { headers: { "Lrclib-Client": "Liri/1.1 (https://getliri.com)" } });
                if (!r.ok) return;
                const d = await r.json();
                if (d?.syncedLyrics || d?.plainLyrics) {
                  cache[String(t.itunes_track_id)] = { lrc_raw: d.syncedLyrics || null, words_json: null, lyrics_plain: d.plainLyrics || null };
                  console.log("[turntable] fetched missing lyrics for:", t.track_name);
                }
              } catch {
              }
            }));
          }
          turntableLyricsCacheRef.current = cache;
          setTurntableTracksProgress({ percent: 90, stage: "Loading side data\u2026" });
          vinylSidesRef.current = [];
          {
            const { data: sidesRows } = await sb.from("vinyl_sides").select("side, side_track_number, position").eq("itunes_collection_id", collectionId).order("side", { ascending: true }).order("side_track_number", { ascending: true });
            const seen = /* @__PURE__ */ new Set();
            const sorted = [];
            for (const s of sidesRows || []) {
              const key = `${s.side}|${s.side_track_number}`;
              if (!seen.has(key)) {
                seen.add(key);
                sorted.push(s);
              }
            }
            if (sorted.length >= trackRows.length) vinylSidesRef.current = sorted;
          }
          let dbRelease = await fetchVinylRelease(collectionId);
          if (!dbRelease?.vinyl_tracks?.length && !vinylSidesRef.current.length) {
            await autoPopulateVinylSides(collectionId, albumName, artistName);
            dbRelease = await fetchVinylRelease(collectionId);
          }
          if (dbRelease?.vinyl_tracks?.length > 0) {
            setVinylDbRelease(dbRelease);
            vinylDbReleaseRef.current = dbRelease;
          } else {
            setVinylDbRelease(null);
            vinylDbReleaseRef.current = null;
          }
        } else {
          console.warn("[turntable] no tracks found for:", collectionId);
        }
      } catch (e) {
        turntableTracksRef.current = [];
        console.error("[turntable] fetch error:", e);
      }
      setTurntableTracksLoading(false);
      setTurntableTracksProgress({ percent: 100, stage: "" });
    };
    useEffect3(() => {
      turntableAlbumRef.current = turntableAlbum;
      turntableMatchedIdxRef.current = -1;
      if (turntableAlbum) {
        localStorage.setItem("liri_turntable", JSON.stringify(turntableAlbum));
        fetchTurntableTracks(turntableAlbum.itunes_collection_id);
      } else {
        localStorage.removeItem("liri_turntable");
        turntableTracksRef.current = [];
        setTurntableTracksLoading(false);
      }
    }, [turntableAlbum]);
    const fetchUserLibrary = async (uid, autoSelect = false) => {
      setLibLoading(true);
      try {
        const {
          data
        } = await sb.from("user_library").select("*, catalogue(album_name, artist_name, artwork_url, itunes_collection_id)").eq("user_id", uid).order("added_at", {
          ascending: false
        });
        const library = (data || []).map((row) => ({
          ...row,
          album_name: row.catalogue?.album_name || row.album_name || "",
          artist_name: row.catalogue?.artist_name || row.artist_name || "",
          artwork_url: row.catalogue?.artwork_url || row.artwork_url || null
        }));
        setUserLibrary(library);
        if (library.length === 0) {
          setTurntableAlbum(null);
        } else {
          const saved = localStorage.getItem("liri_turntable");
          if (saved) {
            try {
              const parsed = JSON.parse(saved);
              const stillExists = library.some((a) => String(a.itunes_collection_id) === String(parsed.itunes_collection_id));
              if (!stillExists) setTurntableAlbum(null);
            } catch {
              setTurntableAlbum(null);
            }
          }
        }
        if (autoSelect && !localStorage.getItem("liri_turntable") && library.length > 0) {
          const {
            data: plays
          } = await sb.from("listening_events").select("itunes_collection_id").eq("user_id", uid).not("itunes_collection_id", "is", null);
          if (plays?.length > 0) {
            const counts = {};
            for (const row of plays) counts[row.itunes_collection_id] = (counts[row.itunes_collection_id] || 0) + 1;
            const topId = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
            const topAlbum = library.find((a) => String(a.itunes_collection_id) === String(topId));
            if (topAlbum) setTurntableAlbum({
              itunes_collection_id: topAlbum.itunes_collection_id,
              album_name: topAlbum.album_name,
              artist_name: topAlbum.artist_name,
              artwork_url: topAlbum.artwork_url
            });
          } else {
            const a = library[0];
            setTurntableAlbum({
              itunes_collection_id: a.itunes_collection_id,
              album_name: a.album_name,
              artist_name: a.artist_name,
              artwork_url: a.artwork_url
            });
          }
        }
      } catch {
      }
      setLibLoading(false);
    };
    useEffect3(() => {
      if (user) fetchUserLibrary(user.id, true);
    }, [user]);
    useEffect3(() => {
      if (mode !== "listening") {
        setListenSecs(0);
        setShowTrackList(false);
        return;
      }
      const id = setInterval(() => setListenSecs((s) => s + 1), 1e3);
      return () => clearInterval(id);
    }, [mode]);
    useEffect3(() => {
      if (mode === "confirmed" && detectedSong) {
        startSync();
        userScrollingRef.current = false;
        setUserScrolling(false);
      }
    }, [mode, detectedSong]);
    useEffect3(() => {
      if (!window.Capacitor) return;
      if (mode !== "syncing") return;
      let cancelled = false;
      const startTimer = setTimeout(async () => {
        if (cancelled) return;
        try {
          const result = await Shazam.waitForSilence({ timeout: 3e5 });
          if (cancelled || !result.silence) return;
          console.log("[silence] gap detected \u2014 advancing track");
          const tTracks = turntableTracksRef.current;
          const tIdx = turntableMatchedIdxRef.current;
          if (tTracks.length > 0 && tIdx >= 0 && tIdx < tTracks.length - 1) {
            advanceToNextTrack(tTracks, tIdx);
          }
        } catch (e) {
          console.warn("[silence] waitForSilence failed:", e);
        }
      }, 2e3);
      return () => {
        cancelled = true;
        clearTimeout(startTimer);
        Shazam.cancel();
      };
    }, [mode]);
    useEffect3(() => {
      if (userScrollingRef.current) return;
      if (currentLineRef.current && mode === "syncing") currentLineRef.current.scrollIntoView({
        behavior: "smooth",
        block: "center"
      });
    }, [currentIndex, mode]);
    const seekToLine = (i) => {
      const targetTime = lyricsRef.current[i]?.time;
      if (targetTime == null) return;
      initialPosRef.current = targetTime;
      syncStartRef.current = Date.now();
      setCurrentIndex(i);
      setPlaybackTime(targetTime);
      userScrollingRef.current = false;
      setUserScrolling(false);
    };
    const refollow = () => {
      userScrollingRef.current = false;
      setUserScrolling(false);
      currentLineRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "center"
      });
    };
    useEffect3(() => {
      if (mode !== "syncing" || !lyrics.length) return;
      const lastTime = lyrics[lyrics.length - 1].time;
      if (playbackTime >= lastTime + 6 && creditsRef.current) creditsRef.current.scrollIntoView({
        behavior: "smooth",
        block: "center"
      });
    }, [Math.floor(playbackTime), mode, lyrics.length]);
    useEffect3(() => {
      if (mode !== "syncing") return;
      const lastLyricTime = lyrics.length > 0 ? lyrics[lyrics.length - 1].time : null;
      const tIdx = turntableMatchedIdxRef.current;
      const trackDuration = tIdx >= 0 ? (turntableTracksRef.current[tIdx]?.trackTimeMillis ?? 0) / 1e3 || null : null;
      const effectiveDuration = songDuration ?? trackDuration ?? (lastLyricTime ? lastLyricTime + 3 : null);
      if (!effectiveDuration) return;
      if (playbackTime >= effectiveDuration && !autoAdvanceFiredRef.current) {
        autoAdvanceFiredRef.current = true;
        setShouldAdvanceTrack(true);
      }
    }, [playbackTime, songDuration, lyrics, mode]);
    useEffect3(() => {
      if (!shouldAdvanceTrack) return;
      setShouldAdvanceTrack(false);
      const tTracks = turntableTracksRef.current;
      const tIdx = turntableMatchedIdxRef.current;
      const tracks = tTracks.length > 0 ? tTracks : albumTracksRef.current;
      const idx = tTracks.length > 0 && tIdx >= 0 ? tIdx : currentTrackIndexRef.current;
      if (tracks.length > 0 && idx >= 0) {
        advanceToNextTrack(tracks, idx);
      } else {
        setSideEndReason("flip");
        scheduleFlipChimes(detectedSong);
        if (detectedSong) setLastSong(detectedSong);
        setMode("side-end");
      }
    }, [shouldAdvanceTrack]);
    useEffect3(() => () => {
      clearInterval(syncIntervalRef.current);
      clearInterval(progressTimerRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    }, []);
    useEffect3(() => {
      if (mode !== "side-end") cancelFlipChimes();
    }, [mode]);
    const handleMatch = async (data, isAutoAdvance) => {
      const m = data.metadata.music[0];
      const duration = m.duration_ms ? m.duration_ms / 1e3 : null;
      const acrScore = m.score || null;
      const acrGenre = m.genres?.[0]?.name || null;
      const countryCode = data._liri?.country_code || null;
      detectedAtRef.current = recordingStartRef.current || Date.now();
      syncCalcRef.current = {
        startPos: (m.play_offset_ms || 0) / 1e3,
        phraseOffset: 0,
        recStart: detectedAtRef.current
      };
      initialPosRef.current = (m.play_offset_ms || 0) / 1e3;
      autoAdvanceFiredRef.current = false;
      autoRetryCountRef.current = 0;
      const spotifyArt = m.external_metadata?.spotify?.album?.images?.[0]?.url || null;
      const title = m.title;
      const artist = m.artists?.[0]?.name || "Unknown Artist";
      const artwork2 = spotifyArt || null;
      if (!spotifyArt) {
        fetch(`${ITUNES_PROXY}?term=${encodeURIComponent(artist + " " + title)}&entity=song&limit=1`).then((r) => r.json()).then((itunes) => {
          const art = itunes.results?.[0]?.artworkUrl100?.replace("100x100bb", "600x600bb") || null;
          if (art) setDetectedSong((s) => s ? {
            ...s,
            artwork: art
          } : s);
        }).catch(() => {
        });
      }
      const song = {
        title,
        artist,
        album: m.album?.name || "",
        artwork: artwork2
      };
      setDetectedSong(song);
      setIdentifiedBy("acr");
      setSongDuration(duration);
      await loadLyrics(title, artist);
      setMode("confirmed");
      saveToHistory(user, song);
      fetchHistory(user);
      fetchAlbumTracks(title, artist).then(async ({
        tracks,
        collectionId
      }) => {
        setAlbumTracks(tracks);
        setAlbumCollectionId(collectionId);
        const tIdx = tracks.findIndex((t) => t.trackName?.toLowerCase() === title.toLowerCase());
        setCurrentTrackIndex(tIdx >= 0 ? tIdx : 0);
        const itunesTrack = tIdx >= 0 ? tracks[tIdx] : null;
        logListeningEvent({
          userId: user?.id,
          title,
          artist,
          album: song.album,
          artwork: song.artwork,
          genre: acrGenre,
          itunesTrackId: itunesTrack?.trackId,
          collectionId,
          vinylReleaseId: null,
          vinylModeOn: vinylMode,
          source: "recognition",
          countryCode,
          offsetSecs: (m.play_offset_ms || 0) / 1e3,
          durationSecs: duration,
          acrScore
        });
        if (!collectionId || tracks.length === 0) return;
        const dbRelease = await fetchVinylRelease(collectionId);
        if (dbRelease?.vinyl_tracks?.length > 0) {
          setVinylDbRelease(dbRelease);
          albumTpsRef.current = 0;
          return;
        }
        autoPopulateVinylSides(collectionId, song.album, artist).catch(() => {
        });
        const stored = getAlbumSideData(collectionId);
        if (stored?.tps) {
          albumTpsRef.current = stored.tps;
          return;
        }
        albumTpsRef.current = 0;
      }).catch(() => {
      });
    };
    const matchTranscriptToTracks = (transcript, tracks, wordsData, logRef) => {
      const normWord = (w) => w.toLowerCase().replace(/[^a-z0-9']/g, "");
      const editDist = (a, b) => {
        if (Math.abs(a.length - b.length) > 2) return 99;
        const dp = Array.from({ length: a.length + 1 }, (_, i) => i);
        for (let j = 1; j <= b.length; j++) {
          let prev = dp[0];
          dp[0] = j;
          for (let i = 1; i <= a.length; i++) {
            const temp = dp[i];
            dp[i] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[i], dp[i - 1]);
            prev = temp;
          }
        }
        return dp[a.length];
      };
      const fuzzyEq = (a, b) => {
        if (a === b) return true;
        if (!a || !b) return false;
        if (a.length <= 3 || b.length <= 3) return false;
        return editDist(a, b) <= (a.length <= 6 ? 1 : 2);
      };
      const heardWords = transcript.toLowerCase().split(/\s+/).map(normWord).filter((w) => w.length > 1);
      if (logRef) logRef.push(`match: ${heardWords.length} words from transcript`);
      if (!heardWords.length) return null;
      const baseName = (n) => (n || "").toLowerCase().replace(/\s*[\(\[].*/, "").trim();
      const seenNames = /* @__PURE__ */ new Set();
      const tracksWithWords = tracks.map((t) => {
        const data = wordsData[t.trackId];
        if (!data?.words?.length) return null;
        const base = baseName(t.trackName);
        if (seenNames.has(base)) return null;
        seenNames.add(base);
        return {
          ...t,
          wordArr: data.words.map((w) => w.word),
          // already normalised at store time
          wordTimings: data.words,
          // [{word, start_ms}] for position lookup
          lrc_raw: data.lrc_raw,
          lyrics_plain: data.lyrics_plain
        };
      }).filter(Boolean);
      if (logRef) logRef.push(`match: ${tracksWithWords.length}/${tracks.length} tracks have lyrics`);
      console.log("[match] tracksWithWords:", tracksWithWords.length, "/", tracks.length, "| heardWords:", heardWords.slice(0, 8).join(" "));
      if (tracksWithWords.length > 0) console.log("[match] sample track words:", tracksWithWords[0]?.trackName, tracksWithWords[0]?.wordArr?.slice(0, 10));
      if (!tracksWithWords.length) return null;
      const MIN_RUN = 3;
      for (let len = MIN_RUN; len <= heardWords.length; len++) {
        for (let start = 0; start <= heardWords.length - len; start++) {
          const phrase = heardWords.slice(start, start + len);
          const hits = tracksWithWords.filter((t) => {
            let count = 0;
            const arr2 = t.wordArr;
            for (let i = 0; i <= arr2.length - len; i++) {
              let ok = true;
              for (let j = 0; j < len; j++) {
                if (!fuzzyEq(arr2[i + j], phrase[j])) {
                  ok = false;
                  break;
                }
              }
              if (ok) {
                count++;
                if (count > 1) return false;
              }
            }
            return count === 1;
          });
          if (hits.length !== 1) continue;
          const match = hits[0];
          let matchWordIdx = -1;
          const arr = match.wordArr;
          for (let i = 0; i <= arr.length - len; i++) {
            let ok = true;
            for (let j = 0; j < len; j++) {
              if (!fuzzyEq(arr[i + j], phrase[j])) {
                ok = false;
                break;
              }
            }
            if (ok) {
              matchWordIdx = i;
              break;
            }
          }
          const startPos = matchWordIdx >= 0 ? match.wordTimings[matchWordIdx].start_ms / 1e3 : 0;
          const lyrics2 = match.lrc_raw ? parseLRC(match.lrc_raw) : (match.lyrics_plain || "").split("\n").filter((l) => l.trim()).map((text, i) => ({ time: i * 4, text }));
          if (logRef) logRef.push(`match: unique run (${len}w) \u2192 "${match.trackName}" at ${startPos.toFixed(1)}s`);
          return { track: match, lyrics: lyrics2, startPos, score: len, phraseWordStart: start, totalWords: heardWords.length };
        }
      }
      if (logRef) logRef.push(`match: no unique run yet \u2014 keep listening`);
      return null;
    };
    const logButtonEvent = async (buttonName) => {
      try {
        await sb.from("button_events").insert({
          user_id: user?.id || null,
          session_id: sessionId,
          button_name: buttonName,
          track_title: detectedSong?.title || null,
          artist_name: detectedSong?.artist || null,
          album_name: detectedSong?.album || null,
          itunes_collection_id: albumCollectionIdRef?.current ? Number(albumCollectionIdRef.current) : null,
          platform: window.Capacitor ? "ios" : "web"
        });
      } catch (e) {
      }
    };
    const handleNoMatch = (isAutoAdvance, stage = "acr") => {
      if (isAutoAdvance) {
        autoRetryCountRef.current += 1;
        if (autoRetryCountRef.current < 2) {
          setTimeout(() => startListening(true), 4e3);
        } else {
          autoRetryCountRef.current = 0;
          setSideEndReason("failed");
          if (detectedSong) setLastSong(detectedSong);
          setMode("side-end");
        }
      } else {
        const log = attemptLogRef.current;
        const summary = log.length ? log.join("\n") : "No attempts logged";
        setError(`No match found

${summary}

Move closer to your speakers and try again.`);
        setMode("error");
      }
    };
    const MAX_ATTEMPTS = 6;
    const startListeningSpeech = async (isAutoAdvance = false) => {
      if (!isAutoAdvance) {
        try {
          if (!chimeCtxRef.current) {
            chimeCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
          } else if (chimeCtxRef.current.state === "suspended") {
            chimeCtxRef.current.resume();
          }
        } catch {
        }
      }
      clearInterval(progressTimerRef.current);
      const session = ++listenSessionRef.current;
      attemptLogRef.current = [];
      recognitionWonRef.current = false;
      turntableMatchedIdxRef.current = -1;
      setError(null);
      setShowTrackList(false);
      setMode("listening");
      setListenProgress(0);
      setLiveTranscript("");
      setListenAttempt(1);
      setAudioLevel(0);
      clearInterval(syncIntervalRef.current);
      const tracks = turntableTracksRef.current;
      if (!tracks.length) {
        setError("Album tracks still loading \u2014 try again in a moment.");
        setMode("error");
        return;
      }
      const lrcCache = turntableLyricsCacheRef.current;
      const isNative = !!window.Capacitor;
      const wordsData = {};
      for (const track of tracks) {
        if (!track.trackId) continue;
        const entry = lrcCache[String(track.trackId)];
        if (!entry) continue;
        let words = Array.isArray(entry.words_json) ? entry.words_json : [];
        if (!words.length && entry.lrc_raw) {
          for (const line of parseLRC(entry.lrc_raw)) {
            for (const raw of (line.text || "").split(/\s+/)) {
              const word = raw.toLowerCase().replace(/[^a-z0-9']/g, "");
              if (word) words.push({ word, start_ms: Math.round(line.time * 1e3) });
            }
          }
        }
        if (!words.length && entry.lyrics_plain) {
          entry.lyrics_plain.split("\n").filter((l) => l.trim()).forEach((line, li) => {
            for (const raw of line.split(/\s+/)) {
              const word = raw.toLowerCase().replace(/[^a-z0-9']/g, "");
              if (word) words.push({ word, start_ms: li * 4e3 });
            }
          });
        }
        wordsData[track.trackId] = { words, lrc_raw: entry.lrc_raw, lyrics_plain: entry.lyrics_plain };
      }
      wordsDataRef.current = wordsData;
      if (!isNative) {
        setMode("idle");
        setShowTrackList(true);
        speechRecRef.current = { stop: () => {
        } };
        return;
      }
      const pulseId = setInterval(() => setAudioLevel(0.15 + Math.sin(Date.now() / 400) * 0.1), 80);
      const stopShazam = () => {
        clearInterval(pulseId);
        setAudioLevel(0);
        Shazam.cancel();
      };
      speechRecRef.current = { stop: stopShazam };
      const buildLyrics = (track) => {
        const entry = lrcCache[String(track.trackId)];
        if (!entry) return [];
        if (entry.lrc_raw) return parseLRC(entry.lrc_raw);
        return (entry.lyrics_plain || "").split("\n").filter((l) => l.trim()).map((text, i) => ({ time: i * 4, text }));
      };
      const commitShazamMatch = (track, offsetSecs) => {
        if (listenSessionRef.current !== session || recognitionWonRef.current) return;
        recognitionWonRef.current = true;
        stopShazam();
        const ta = turntableAlbumRef.current;
        const matchedIdx = tracks.indexOf(track);
        turntableMatchedIdxRef.current = matchedIdx >= 0 ? matchedIdx : 0;
        const song = { title: track.trackName, artist: track.artistName || ta?.artist_name || "", album: ta?.album_name || "", artwork: ta?.artwork_url || null };
        const lyrics2 = buildLyrics(track);
        setIdentifiedBy("shazam");
        detectedAtRef.current = Date.now();
        syncCalcRef.current = { startPos: offsetSecs, phraseOffset: 0, recStart: Date.now() };
        initialPosRef.current = offsetSecs;
        autoAdvanceFiredRef.current = false;
        autoRetryCountRef.current = 0;
        setDetectedSong(song);
        setSongDuration(track.trackTimeMillis ? track.trackTimeMillis / 1e3 : null);
        setLyrics(lyrics2);
        lyricsRef.current = lyrics2;
        setMode("confirmed");
        saveToHistory(user, song);
        fetchHistory(user);
        logListeningEvent({ userId: user?.id, title: track.trackName, artist: track.artistName || ta?.artist_name || "", album: ta?.album_name || "", artwork: ta?.artwork_url || null, itunesTrackId: track.trackId, collectionId: ta?.itunes_collection_id || track.collectionId, vinylReleaseId: null, vinylModeOn: true, source: "shazam", offsetSecs, durationSecs: track.trackTimeMillis ? track.trackTimeMillis / 1e3 : null });
        const at = turntableTracksRef.current;
        setAlbumTracks(at);
        setAlbumCollectionId(ta?.itunes_collection_id ? String(ta.itunes_collection_id) : null);
        setCurrentTrackIndex(matchedIdx >= 0 ? matchedIdx : 0);
      };
      try {
        const result = await Shazam.findMatch({ timeout: 15e3 });
        if (listenSessionRef.current !== session) return;
        if (!result.matched) {
          clearInterval(pulseId);
          setAudioLevel(0);
          setShowTrackList(true);
          return;
        }
        const { title, artist, offset, matchTime } = result;
        console.log("[shazam] match:", title, "by", artist, "offset:", Number(offset).toFixed(1) + "s");
        const elapsed = (Date.now() - matchTime) / 1e3;
        const adjustedOffset = Math.max(0, offset + elapsed);
        const norm = normText;
        const matchedTrack = tracks.find((t) => norm(t.trackName) === norm(title)) || tracks.find((t) => norm(title).includes(norm(t.trackName)) && norm(t.trackName).length > 3) || tracks.find((t) => norm(t.trackName).includes(norm(title)) && norm(title).length > 3);
        if (!matchedTrack) {
          console.log("[shazam] matched title not in album:", title, "\u2014 showing track list");
          clearInterval(pulseId);
          setAudioLevel(0);
          setShowTrackList(true);
          return;
        }
        commitShazamMatch(matchedTrack, adjustedOffset);
      } catch (err) {
        if (listenSessionRef.current !== session) return;
        console.error("[shazam] findMatch error:", err?.message || JSON.stringify(err));
        clearInterval(pulseId);
        setAudioLevel(0);
        setShowTrackList(true);
      }
    };
    const startListening = async (isAutoAdvance = false) => {
      if (!turntableAlbumRef.current) {
        setError("Select an album first.");
        setMode("error");
        return;
      }
      return startListeningSpeech(isAutoAdvance);
    };
    const loadLyrics = async (trackId, title, artist) => {
      try {
        if (trackId) {
          const { data } = await sb.from("track_lyrics").select("lrc_raw, lyrics_plain").eq("itunes_track_id", trackId).maybeSingle();
          if (data?.lrc_raw) {
            const parsed = parseLRC(data.lrc_raw);
            setLyrics(parsed);
            lyricsRef.current = parsed;
            return;
          }
          if (data?.lyrics_plain) {
            const parsed = data.lyrics_plain.split("\n").filter((l) => l.trim()).map((text, i) => ({ time: i * 4, text }));
            setLyrics(parsed);
            lyricsRef.current = parsed;
            return;
          }
        }
      } catch {
      }
      setLyrics([]);
      lyricsRef.current = [];
    };
    const startSync = useCallback(() => {
      autoAdvanceFiredRef.current = false;
      if (syncCalcRef.current) {
        const {
          startPos,
          phraseOffset,
          recStart
        } = syncCalcRef.current;
        syncCalcRef.current = null;
        initialPosRef.current = Math.max(0, startPos - phraseOffset + (Date.now() - recStart) / 1e3);
      }
      if (flipStartDelayMsRef.current > 0) {
        initialPosRef.current = -flipStartDelayMsRef.current / 1e3;
        flipStartDelayMsRef.current = 0;
      }
      syncStartRef.current = Date.now();
      const lrc0 = lyricsRef.current;
      const t0 = initialPosRef.current;
      let initIdx = -1;
      if (lrc0.length > 0 && t0 >= lrc0[0].time) {
        for (let i = 0; i < lrc0.length; i++) {
          if (lrc0[i].time <= t0) initIdx = i;
          else break;
        }
      }
      setMode("syncing");
      setCurrentIndex(initIdx);
      clearInterval(syncIntervalRef.current);
      syncIntervalRef.current = setInterval(() => {
        const t = initialPosRef.current + (Date.now() - syncStartRef.current) / 1e3;
        setPlaybackTime(t < 0 ? 0 : t);
        const lrc = lyricsRef.current;
        if (!lrc.length) return;
        if (t < lrc[0].time) {
          setCurrentIndex(-1);
          return;
        }
        let idx = 0;
        for (let i = 0; i < lrc.length; i++) {
          if (lrc[i].time <= t) idx = i;
          else break;
        }
        setCurrentIndex(idx);
      }, 80);
    }, []);
    const togglePause = () => {
      if (isPaused) {
        initialPosRef.current = playbackTime;
        syncStartRef.current = Date.now();
        syncIntervalRef.current = setInterval(() => {
          const t = initialPosRef.current + (Date.now() - syncStartRef.current) / 1e3;
          setPlaybackTime(t);
          const lrc = lyricsRef.current;
          if (!lrc.length) return;
          if (t < lrc[0].time) {
            setCurrentIndex(-1);
            return;
          }
          let idx = 0;
          for (let i = 0; i < lrc.length; i++) {
            if (lrc[i].time <= t) idx = i;
            else break;
          }
          setCurrentIndex(idx);
        }, 80);
        setIsPaused(false);
      } else {
        clearInterval(syncIntervalRef.current);
        setIsPaused(true);
      }
    };
    const nudge = (s) => {
      userNudgeRef.current += s;
      initialPosRef.current = Math.max(0, initialPosRef.current + s);
    };
    const handleNudge = (s) => {
      nudge(s);
      const side = s < 0 ? "left" : "right";
      clearTimeout(nudgeMenuTimerRef.current);
      setNudgeMenu(side);
      nudgeMenuTimerRef.current = setTimeout(() => setNudgeMenu(null), 2500);
    };
    const showKbToast = (msg) => {
      clearTimeout(kbToastTimerRef.current);
      setKbToast(msg);
      kbToastTimerRef.current = setTimeout(() => setKbToast(null), 1400);
    };
    useEffect3(() => {
      const onKey = (e) => {
        if (mode !== "syncing") return;
        if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          nudge(-1);
          showKbToast("\u2190 \u22121s");
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          nudge(1);
          showKbToast("\u2192 +1s");
        } else if (e.key === " ") {
          e.preventDefault();
          togglePause();
          showKbToast(isPaused ? "\u25B6 Resume" : "\u23F8 Pause");
        }
      };
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }, [mode, isPaused]);
    const fetchAlbumTracks = async (title, artist) => {
      try {
        const search = await fetch(`${ITUNES_PROXY}?term=${encodeURIComponent(artist + " " + title)}&entity=song&limit=10`).then((r) => r.json());
        const results = (search.results || []).filter((r) => r.wrapperType === "track");
        if (!results.length) return {
          tracks: [],
          collectionId: null
        };
        results.sort((a, b) => (b.trackCount || 0) - (a.trackCount || 0));
        const hit = results[0];
        if (!hit?.collectionId) return {
          tracks: [],
          collectionId: null
        };
        const lookup = await fetch(`${ITUNES_PROXY}?id=${hit.collectionId}&entity=song`).then((r) => r.json());
        const tracks = (lookup.results || []).filter((t) => t.wrapperType === "track").sort((a, b) => a.trackNumber - b.trackNumber);
        return {
          tracks,
          collectionId: String(hit.collectionId)
        };
      } catch {
        return {
          tracks: [],
          collectionId: null
        };
      }
    };
    const deriveSideFromIndex = (idx, tracks) => {
      if (tracks.length === 0 || idx < 0) return null;
      const t = tracks[idx];
      const hasMultiDisc = tracks.some((x) => x.discNumber > 1);
      if (hasMultiDisc && t?.discNumber) {
        const discTracks = tracks.filter((x) => x.discNumber === t.discNumber).sort((a, b) => a.trackNumber - b.trackNumber);
        const posInDisc = discTracks.findIndex((x) => x.trackId === t.trackId);
        const totalMs = discTracks.reduce((s, x) => s + (x.trackTimeMillis || 0), 0);
        let sideBreak = Math.ceil(discTracks.length / 2) - 1;
        if (totalMs > 0) {
          let cumMs = 0;
          for (let i = 0; i < discTracks.length - 1; i++) {
            cumMs += discTracks[i].trackTimeMillis || 0;
            if (cumMs >= totalMs / 2) {
              sideBreak = i;
              break;
            }
          }
        }
        const isSecondHalf = posInDisc > sideBreak;
        const sideLetter = String.fromCharCode(65 + (t.discNumber - 1) * 2 + (isSecondHalf ? 1 : 0));
        const trackOnSide = isSecondHalf ? posInDisc - sideBreak : posInDisc + 1;
        return {
          side: sideLetter,
          track: trackOnSide
        };
      }
      const sideEnds = getSideEndIndices(tracks, 0);
      for (let s = 0; s < sideEnds.length; s++) {
        if (idx <= sideEnds[s]) {
          const side = String.fromCharCode(65 + s);
          const prevEnd = s === 0 ? -1 : sideEnds[s - 1];
          const trackOnSide = idx - prevEnd;
          return {
            side,
            track: trackOnSide
          };
        }
      }
      return {
        track: idx + 1
      };
    };
    const getSideInfo = () => {
      const resolveVinylTrack = (trackName, idx, vinylTracks) => {
        if (!vinylTracks?.length) return null;
        const maxNum = Math.max(...vinylTracks.map((v) => v.track_number_on_side || 0));
        const isSeq = maxNum > 0 && maxNum === vinylTracks.length;
        if (isSeq) return vinylTracks.find((v) => v.track_number_on_side === idx + 1) || null;
        return vinylTracks.find((v) => normTitle(v.title) === normTitle(trackName)) || vinylTracks.find((v) => v.track_number_on_side === idx + 1) || null;
      };
      const vinylTrackToSideInfo = (vt, vinylTracks) => {
        if (!vt?.side) return null;
        const maxNum = Math.max(...vinylTracks.map((v) => v.track_number_on_side || 0));
        const isSeq = maxNum > 0 && maxNum === vinylTracks.length;
        const track = isSeq ? vinylTracks.filter((v) => v.side === vt.side && v.track_number_on_side <= vt.track_number_on_side).length : vt.track_number_on_side;
        return {
          side: vt.side.toUpperCase(),
          track
        };
      };
      const tTracks = turntableTracksRef.current;
      const tIdx = turntableMatchedIdxRef.current;
      if (turntableAlbum && tTracks.length > 0 && tIdx >= 0) {
        const sideRow = vinylSidesRef.current[tIdx];
        if (sideRow?.side) return { side: sideRow.side.toUpperCase(), track: sideRow.side_track_number };
        const vinylTracks = vinylDbRelease?.vinyl_tracks;
        if (vinylTracks?.length > 0) {
          const vt = resolveVinylTrack(tTracks[tIdx]?.trackName, tIdx, vinylTracks);
          const si = vinylTrackToSideInfo(vt, vinylTracks);
          if (si) return si;
        }
        return deriveSideFromIndex(tIdx, tTracks) || { track: tIdx + 1 };
      }
      if (albumTracks.length > 0 && currentTrackIndex >= 0) {
        const vinylTracks = vinylDbRelease?.vinyl_tracks;
        if (vinylTracks?.length > 0) {
          const vt = resolveVinylTrack(albumTracks[currentTrackIndex]?.trackName, currentTrackIndex, vinylTracks);
          const si = vinylTrackToSideInfo(vt, vinylTracks);
          if (si) return si;
        }
        return deriveSideFromIndex(currentTrackIndex, albumTracks) || {
          track: currentTrackIndex + 1
        };
      }
      return null;
    };
    const getSideEndsFromSidesMap = (tracks, sidesArr) => {
      if (!sidesArr.length) return null;
      const ends = [];
      for (let i = 0; i < tracks.length; i++) {
        const thisSide = sidesArr[i]?.side?.toUpperCase();
        const nextSide = i + 1 < tracks.length ? sidesArr[i + 1]?.side?.toUpperCase() : null;
        if (thisSide && (nextSide === null || thisSide !== nextSide)) ends.push(i);
      }
      return ends.length ? ends : null;
    };
    const getSideEndIndices = (tracks, tps) => {
      if (tracks.length <= 1) return [];
      if (tps > 0) {
        const ends2 = [];
        for (let i = tps - 1; i < tracks.length; i += tps) ends2.push(i);
        if (ends2[ends2.length - 1] !== tracks.length - 1) ends2.push(tracks.length - 1);
        return ends2;
      }
      if (tracks.length <= 4) return [tracks.length - 1];
      const totalMs = tracks.reduce((s, t) => s + (t.trackTimeMillis || 0), 0);
      const SIDE_MS = 20 * 60 * 1e3;
      const numSides = totalMs > 0 ? Math.max(2, Math.round(totalMs / SIDE_MS)) : 2;
      if (!totalMs) {
        const perSide = Math.ceil(tracks.length / numSides);
        const ends2 = [];
        for (let i = perSide - 1; i < tracks.length - 1; i += perSide) ends2.push(i);
        ends2.push(tracks.length - 1);
        return ends2;
      }
      const targetMs = totalMs / numSides;
      const ends = [];
      let cumulative = 0;
      for (let i = 0; i < tracks.length - 1; i++) {
        cumulative += tracks[i].trackTimeMillis || 0;
        if (cumulative >= targetMs * (ends.length + 1) && ends.length < numSides - 1) ends.push(i);
      }
      ends.push(tracks.length - 1);
      return ends;
    };
    const advanceToNextTrack = async (tracks, idx) => {
      const nextIdx = idx + 1;
      clearInterval(syncIntervalRef.current);
      setPlaybackTime(0);
      const dbRelease = vinylDbReleaseRef.current;
      const effectiveTps = albumTpsRef.current > 0 ? albumTpsRef.current : 0;
      const sideEnds = getSideEndsFromSidesMap(tracks, vinylSidesRef.current) ?? (dbRelease?.vinyl_tracks?.length > 0 ? getDbSideEndIndices(tracks, dbRelease.vinyl_tracks) : getSideEndIndices(tracks, effectiveTps));
      const isLastTrack = idx === tracks.length - 1;
      const isSideEnd = sideEnds.includes(idx);
      if (isLastTrack) {
        showAlbumEndPushNotification(detectedSong);
        setSideEndReason("album-end");
        if (detectedSong) setLastSong(detectedSong);
        setTimeout(() => setMode("side-end"), 4e3);
        return;
      }
      if (isSideEnd) {
        setSideEndNextDiscInfo(getNextDiscInfo());
        setSideEndReason("flip");
        scheduleFlipChimes(detectedSong);
        const sideIdx = sideEnds.indexOf(idx);
        const method = dbRelease?.vinyl_tracks?.length > 0 ? "db" : albumTpsRef.current > 0 ? "learned" : "heuristic";
        logFlipEvent({
          userId: user?.id,
          vinylReleaseId: dbRelease?.id || null,
          collectionId: albumCollectionIdRef?.current || null,
          album: detectedSong?.album,
          artist: detectedSong?.artist,
          fromSide: "ABCDEFGH"[sideIdx] || null,
          toSide: "ABCDEFGH"[sideIdx + 1] || null,
          method
        });
        if (detectedSong) setLastSong(detectedSong);
        setTimeout(() => setMode("side-end"), 4e3);
        return;
      }
      const next = tracks[nextIdx];
      const nextTitle = next.trackName;
      const nextArtist = next.artistName || detectedSong?.artist || "";
      const nextArtwork = next.artworkUrl100?.replace("100x100bb", "600x600bb") || detectedSong?.artwork;
      const nextDuration = next.trackTimeMillis ? next.trackTimeMillis / 1e3 : null;
      const nextSong = {
        title: nextTitle,
        artist: nextArtist,
        album: next.collectionName || "",
        artwork: nextArtwork
      };
      setCurrentTrackIndex(nextIdx);
      turntableMatchedIdxRef.current = nextIdx;
      detectedAtRef.current = Date.now();
      setDetectedSong(nextSong);
      setSongDuration(nextDuration);
      const nextTrackData = wordsDataRef.current?.[next.trackId];
      if (nextTrackData?.lrc_raw) {
        const parsed = parseLRC(nextTrackData.lrc_raw);
        setLyrics(parsed);
        lyricsRef.current = parsed;
      } else if (nextTrackData?.lyrics_plain) {
        const parsed = nextTrackData.lyrics_plain.split("\n").filter((l) => l.trim()).map((text, i) => ({ time: i * 4, text }));
        setLyrics(parsed);
        lyricsRef.current = parsed;
      } else {
        setLyrics([]);
        lyricsRef.current = [];
      }
      initialPosRef.current = Math.max(0, userNudgeRef.current);
      syncCalcRef.current = { startPos: userNudgeRef.current, phraseOffset: 0, recStart: Date.now() };
      saveToHistory(user, nextSong);
      fetchHistory(user);
      logListeningEvent({
        userId: user?.id,
        title: nextTitle,
        artist: nextArtist,
        album: next.collectionName || detectedSong?.album,
        artwork: nextArtwork,
        itunesTrackId: next.trackId,
        collectionId: albumCollectionIdRef?.current || null,
        vinylReleaseId: vinylDbReleaseRef.current?.id || null,
        vinylModeOn: vinylMode,
        source: "auto_advance",
        durationSecs: nextDuration
      });
      setMode("confirmed");
    };
    const jumpToTrackIdx = (idx) => {
      const tracks = turntableTracksRef.current;
      const track = tracks[idx];
      if (!track) return;
      listenSessionRef.current++;
      clearInterval(progressTimerRef.current);
      speechRecRef.current?.stop?.();
      const ta = turntableAlbumRef.current;
      const song = {
        title: track.trackName,
        artist: track.artistName || ta?.artist_name || "",
        album: ta?.album_name || track.collectionName || "",
        artwork: ta?.artwork_url || track.artworkUrl100?.replace("100x100bb", "600x600bb") || null
      };
      setCurrentTrackIndex(idx);
      turntableMatchedIdxRef.current = idx;
      setAlbumTracks(tracks);
      setAlbumCollectionId(ta?.itunes_collection_id ? String(ta.itunes_collection_id) : null);
      detectedAtRef.current = Date.now();
      setDetectedSong(song);
      setSongDuration(track.trackTimeMillis ? track.trackTimeMillis / 1e3 : null);
      setIdentifiedBy("manual");
      const lrcEntry = turntableLyricsCacheRef.current[String(track.trackId)] || wordsDataRef.current?.[track.trackId];
      if (lrcEntry?.lrc_raw) {
        const parsed = parseLRC(lrcEntry.lrc_raw);
        setLyrics(parsed);
        lyricsRef.current = parsed;
      } else if (lrcEntry?.lyrics_plain) {
        const parsed = lrcEntry.lyrics_plain.split("\n").filter((l) => l.trim()).map((text, i) => ({ time: i * 4, text }));
        setLyrics(parsed);
        lyricsRef.current = parsed;
      } else {
        setLyrics([]);
        lyricsRef.current = [];
      }
      initialPosRef.current = Math.max(0, userNudgeRef.current);
      syncCalcRef.current = { startPos: userNudgeRef.current, phraseOffset: 0, recStart: Date.now() };
      autoAdvanceFiredRef.current = false;
      autoRetryCountRef.current = 0;
      saveToHistory(user, song);
      setShowTrackList(false);
      setMode("confirmed");
    };
    const manualFlipToNextSide = async () => {
      try {
        if (!chimeCtxRef.current) {
          chimeCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
        } else if (chimeCtxRef.current.state === "suspended") {
          chimeCtxRef.current.resume();
        }
      } catch {
      }
      const tracks = turntableTracksRef.current;
      if (!tracks.length) return;
      const curIdx = turntableMatchedIdxRef.current >= 0 ? turntableMatchedIdxRef.current : currentTrackIndexRef.current;
      const dbRelease = vinylDbReleaseRef.current;
      const effectiveTps = albumTpsRef.current > 0 ? albumTpsRef.current : 0;
      const sideEnds = getSideEndsFromSidesMap(tracks, vinylSidesRef.current) ?? (dbRelease?.vinyl_tracks?.length > 0 ? getDbSideEndIndices(tracks, dbRelease.vinyl_tracks) : getSideEndIndices(tracks, effectiveTps));
      for (let s = 0; s < sideEnds.length; s++) {
        if (curIdx <= sideEnds[s]) {
          const nextFirst = sideEnds[s] + 1;
          if (nextFirst >= tracks.length) {
            setSideEndReason("album-end");
            setMode("side-end");
            return;
          }
          cancelFlipChimes();
          flipStartDelayMsRef.current = 1e4;
          jumpToTrackIdx(nextFirst);
          return;
        }
      }
      setSideEndReason("album-end");
      setMode("side-end");
    };
    const getNextSideLetter = () => {
      const tracks = turntableTracksRef.current;
      if (!tracks.length) return null;
      const curIdx = turntableMatchedIdxRef.current >= 0 ? turntableMatchedIdxRef.current : currentTrackIndexRef.current;
      const dbRelease = vinylDbReleaseRef.current;
      const effectiveTps = albumTpsRef.current > 0 ? albumTpsRef.current : 0;
      const sideEnds = getSideEndsFromSidesMap(tracks, vinylSidesRef.current) ?? (dbRelease?.vinyl_tracks?.length > 0 ? getDbSideEndIndices(tracks, dbRelease.vinyl_tracks) : getSideEndIndices(tracks, effectiveTps));
      for (let s = 0; s < sideEnds.length; s++) {
        if (curIdx <= sideEnds[s] && sideEnds[s] + 1 < tracks.length) {
          return "ABCDEFGH"[s + 1] || null;
        }
      }
      return null;
    };
    const getNextDiscInfo = () => {
      const tracks = turntableTracksRef.current;
      if (!tracks.length) return null;
      const curIdx = turntableMatchedIdxRef.current >= 0 ? turntableMatchedIdxRef.current : currentTrackIndexRef.current;
      const dbRelease = vinylDbReleaseRef.current;
      const effectiveTps = albumTpsRef.current > 0 ? albumTpsRef.current : 0;
      const sideEnds = getSideEndsFromSidesMap(tracks, vinylSidesRef.current) ?? (dbRelease?.vinyl_tracks?.length > 0 ? getDbSideEndIndices(tracks, dbRelease.vinyl_tracks) : getSideEndIndices(tracks, effectiveTps));
      for (let s = 0; s < sideEnds.length; s++) {
        if (curIdx <= sideEnds[s] && sideEnds[s] + 1 < tracks.length) {
          const curDisc = tracks[curIdx] ? tracks[curIdx].discNumber || 1 : 1;
          const nextDisc = tracks[sideEnds[s] + 1] ? tracks[sideEnds[s] + 1].discNumber || 1 : 1;
          const nextSide = "ABCDEFGH"[s + 1] || null;
          return { isNewDisc: nextDisc !== curDisc, nextDisc, nextSide };
        }
      }
      return null;
    };
    const resync = async () => {
      if (isResyncing || !IS_IOS) return;
      setIsResyncing(true);
      try {
        const result = await Shazam.findMatch({ timeout: 1e4 });
        if (!result.matched) {
          setIsResyncing(false);
          return;
        }
        const { title, offset, matchTime } = result;
        const elapsed = (Date.now() - matchTime) / 1e3;
        const adjustedOffset = Math.max(0, offset + elapsed);
        const curIdx = currentTrackIndexRef.current;
        const track = curIdx >= 0 ? turntableTracksRef.current[curIdx] : null;
        if (!track) {
          setIsResyncing(false);
          return;
        }
        const norm = normText;
        if (!norm(title).includes(norm(track.trackName)) && !norm(track.trackName).includes(norm(title))) {
          setIsResyncing(false);
          return;
        }
        initialPosRef.current = adjustedOffset;
        syncStartRef.current = Date.now();
        syncCalcRef.current = null;
      } catch (err) {
        console.error("[resync] error:", err);
      }
      setIsResyncing(false);
    };
    const reset = () => {
      cancelFlipChimes();
      flipStartDelayMsRef.current = 0;
      clearInterval(syncIntervalRef.current);
      clearInterval(progressTimerRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      try {
        speechRecRef.current?.stop();
      } catch {
      }
      speechRecRef.current = null;
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {
        });
        audioCtxRef.current = null;
      }
      analyserNodeRef.current = null;
      setAudioLevel(0);
      autoAdvanceFiredRef.current = false;
      autoRetryCountRef.current = 0;
      if (detectedSong) setLastSong(detectedSong);
      setMode("idle");
      setDetectedSong(null);
      setIdentifiedBy(null);
      setSongDuration(null);
      setLyrics([]);
      setCurrentIndex(0);
      setError(null);
      setListenProgress(0);
      setPlaybackTime(0);
      setAlbumTracks([]);
      setCurrentTrackIndex(-1);
      setShouldAdvanceTrack(false);
      setIsResyncing(false);
      setIsPaused(false);
      setSideEndReason("failed");
      setAlbumCollectionId(null);
      setVinylDbRelease(null);
      albumTpsRef.current = 0;
      vinylDbReleaseRef.current = null;
      vinylSidesRef.current = [];
      userNudgeRef.current = 0;
    };
    const jumpToTrack = (idx) => {
      if (detectedSong) setLastSong(detectedSong);
      clearInterval(syncIntervalRef.current);
      clearInterval(progressTimerRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {
        });
        audioCtxRef.current = null;
      }
      analyserNodeRef.current = null;
      autoAdvanceFiredRef.current = false;
      autoRetryCountRef.current = 0;
      userScrollingRef.current = false;
      setUserScrolling(false);
      setCurrentTrackIndex(idx);
      currentTrackIndexRef.current = idx;
      setCurrentIndex(-1);
      setError(null);
      setListenProgress(0);
      setPlaybackTime(0);
      setShouldAdvanceTrack(false);
      setIsResyncing(false);
      const ta = turntableAlbumRef.current;
      if (ta) {
        const track = turntableTracksRef.current[idx];
        if (!track) return;
        const song = {
          title: track.trackName,
          artist: track.artistName || ta.artist_name || "",
          album: ta.album_name || "",
          artwork: ta.artwork_url || null
        };
        const trackData = wordsDataRef.current?.[track.trackId];
        const lrc = trackData?.lrc_raw;
        const lyrics2 = lrc ? parseLRC(lrc) : trackData?.lyrics_plain ? trackData.lyrics_plain.split("\n").filter((l) => l.trim()).map((text, i) => ({ time: i * 4, text })) : [];
        const duration = track.trackTimeMillis ? track.trackTimeMillis / 1e3 : null;
        initialPosRef.current = 0;
        detectedAtRef.current = null;
        turntableMatchedIdxRef.current = idx;
        setDetectedSong(song);
        setIdentifiedBy("manual");
        setSongDuration(duration);
        setLyrics(lyrics2);
        lyricsRef.current = lyrics2;
        setAlbumTracks(turntableTracksRef.current);
        setAlbumCollectionId(ta.itunes_collection_id ? String(ta.itunes_collection_id) : null);
        setMode("confirmed");
        saveToHistory(user, song);
        fetchHistory(user);
        logListeningEvent({
          userId: user?.id,
          title: song.title,
          artist: song.artist,
          album: song.album,
          artwork: song.artwork,
          itunesTrackId: track.trackId,
          collectionId: ta.itunes_collection_id,
          vinylReleaseId: vinylDbReleaseRef.current?.id || null,
          vinylModeOn: vinylMode,
          source: "turntable_jump",
          durationSecs: duration
        });
      } else {
        setDetectedSong(null);
        setIdentifiedBy(null);
        setSongDuration(null);
        setLyrics([]);
        setTimeout(() => startListening(false), 150);
      }
    };
    useEffect3(() => {
      const acquire = async () => {
        if (!keepScreenAwake || !("wakeLock" in navigator)) return;
        try {
          wakeLockRef.current = await navigator.wakeLock.request("screen");
        } catch {
        }
      };
      const release = () => {
        wakeLockRef.current?.release();
        wakeLockRef.current = null;
      };
      const onVisibility = () => {
        if (document.visibilityState === "visible" && keepScreenAwake) acquire();
      };
      if (keepScreenAwake) {
        acquire();
        document.addEventListener("visibilitychange", onVisibility);
      } else release();
      return () => {
        release();
        document.removeEventListener("visibilitychange", onVisibility);
      };
    }, [keepScreenAwake]);
    useEffect3(() => {
      if (mode === "syncing" && isLandscape) {
        bumpControls();
      } else {
        clearTimeout(controlsHideTimerRef.current);
        setControlsVisible(true);
      }
    }, [mode, isLandscape]);
    if (authLoading) return /* @__PURE__ */ React.createElement("div", {
      style: {
        minHeight: "100vh",
        background: "#080810",
        display: "flex",
        alignItems: "center",
        justifyContent: "center"
      }
    }, /* @__PURE__ */ React.createElement(Vinyl, {
      spinning: true,
      size: 80
    }));
    if (!user) {
      const inp = {
        width: "100%",
        background: "rgba(255,255,255,0.05)",
        border: "1px solid rgba(255,255,255,0.1)",
        color: "#f0e6d3",
        padding: "16px 18px",
        borderRadius: "14px",
        fontSize: "16px",
        fontFamily: "inherit",
        transition: "border-color 0.2s"
      };
      const openSheet = (mode2) => {
        setAuthMode(mode2);
        setAuthError(null);
        setAuthEmail("");
        setAuthPassword("");
        setAuthConfirmPw("");
        setAuthName("");
        setAuthVerifyPending(false);
        setAuthSheet(mode2);
      };
      const featureSvgs = {
        identify: /* @__PURE__ */ React.createElement("svg", { width: "22", height: "22", viewBox: "0 0 24 24", fill: "none", stroke: "#d4a846", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round" }, /* @__PURE__ */ React.createElement("path", { d: "M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" }), /* @__PURE__ */ React.createElement("path", { d: "M19 10v2a7 7 0 0 1-14 0v-2" }), /* @__PURE__ */ React.createElement("line", { x1: "12", y1: "19", x2: "12", y2: "23" }), /* @__PURE__ */ React.createElement("line", { x1: "8", y1: "23", x2: "16", y2: "23" })),
        sync: /* @__PURE__ */ React.createElement("svg", { width: "22", height: "22", viewBox: "0 0 24 24", fill: "none", stroke: "#d4a846", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round" }, /* @__PURE__ */ React.createElement("line", { x1: "3", y1: "6", x2: "21", y2: "6" }), /* @__PURE__ */ React.createElement("line", { x1: "3", y1: "12", x2: "15", y2: "12" }), /* @__PURE__ */ React.createElement("line", { x1: "3", y1: "18", x2: "18", y2: "18" })),
        auto: /* @__PURE__ */ React.createElement("svg", { width: "22", height: "22", viewBox: "0 0 24 24", fill: "none", stroke: "#d4a846", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round" }, /* @__PURE__ */ React.createElement("circle", { cx: "12", cy: "12", r: "10" }), /* @__PURE__ */ React.createElement("circle", { cx: "12", cy: "12", r: "3" }))
      };
      const features = [{
        icon: featureSvgs.identify,
        label: "Identify",
        sub: "Recognises what's playing in seconds"
      }, {
        icon: featureSvgs.sync,
        label: "Sync",
        sub: "Lyrics scroll line by line in real time"
      }, {
        icon: featureSvgs.auto,
        label: "Auto Mode",
        sub: "Follows along as you flip each side"
      }];
      return /* @__PURE__ */ React.createElement("div", {
        style: {
          minHeight: "100vh",
          background: "#080810",
          color: "#f0e6d3",
          fontFamily: "-apple-system,BlinkMacSystemFont,'SF Pro Display','Helvetica Neue',sans-serif",
          position: "relative",
          overflow: "hidden"
        }
      }, /* @__PURE__ */ React.createElement("div", {
        style: {
          position: "fixed",
          top: "20%",
          left: "50%",
          transform: "translateX(-50%)",
          width: "400px",
          height: "400px",
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(212,168,70,0.07) 0%, transparent 70%)",
          pointerEvents: "none"
        }
      }), /* @__PURE__ */ React.createElement("div", {
        style: {
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "100vh",
          padding: "max(60px,calc(env(safe-area-inset-top)+40px)) 32px max(120px,calc(env(safe-area-inset-bottom)+100px))",
          textAlign: "center"
        }
      }, /* @__PURE__ */ React.createElement(Vinyl, {
        size: 130,
        spinning: false
      }), /* @__PURE__ */ React.createElement("div", {
        style: {
          marginTop: "32px",
          fontSize: "11px",
          letterSpacing: "5px",
          color: "rgba(212,168,70,0.6)",
          textTransform: "uppercase",
          marginBottom: "10px"
        }
      }, "Welcome to"), /* @__PURE__ */ React.createElement("div", {
        style: {
          fontSize: "52px",
          letterSpacing: "18px",
          color: "#d4a846",
          fontWeight: "300",
          lineHeight: 1
        }
      }, "LIRI"), /* @__PURE__ */ React.createElement("div", {
        style: {
          fontSize: "13px",
          color: "rgba(255,255,255,0.25)",
          letterSpacing: "3px",
          textTransform: "uppercase",
          marginTop: "10px",
          marginBottom: "52px"
        }
      }, "Lyrics for Vinyl"), /* @__PURE__ */ React.createElement("div", {
        style: {
          display: "flex",
          gap: "12px",
          marginBottom: "56px",
          flexWrap: "wrap",
          justifyContent: "center"
        }
      }, features.map((f) => /* @__PURE__ */ React.createElement("div", {
        key: f.label,
        style: {
          background: "rgba(255,255,255,0.03)",
          border: "1px solid rgba(255,255,255,0.07)",
          borderRadius: "16px",
          padding: "16px 18px",
          minWidth: "100px",
          flex: "0 0 auto"
        }
      }, /* @__PURE__ */ React.createElement("div", {
        style: {
          fontSize: "22px",
          marginBottom: "6px"
        }
      }, f.icon), /* @__PURE__ */ React.createElement("div", {
        style: {
          fontSize: "12px",
          fontWeight: "600",
          color: "#f0e6d3",
          marginBottom: "3px"
        }
      }, f.label), /* @__PURE__ */ React.createElement("div", {
        style: {
          fontSize: "10px",
          color: "rgba(255,255,255,0.25)",
          lineHeight: "1.4"
        }
      }, f.sub)))), /* @__PURE__ */ React.createElement("div", {
        style: {
          display: "flex",
          flexDirection: "column",
          gap: "12px",
          width: "100%",
          maxWidth: "320px"
        }
      }, /* @__PURE__ */ React.createElement("button", {
        onClick: () => openSheet("signup"),
        style: {
          background: "linear-gradient(135deg, #d4a846, #c9807a)",
          color: "#080810",
          border: "none",
          borderRadius: "14px",
          padding: "18px",
          fontSize: "15px",
          fontWeight: "700",
          letterSpacing: "0.5px",
          cursor: "pointer",
          fontFamily: "inherit",
          boxShadow: "0 8px 32px rgba(212,168,70,0.25)"
        }
      }, "Get Started \u2014 it's free"), /* @__PURE__ */ React.createElement("button", {
        onClick: () => openSheet("signin"),
        style: {
          background: "rgba(255,255,255,0.05)",
          color: "rgba(255,255,255,0.6)",
          border: "1px solid rgba(255,255,255,0.1)",
          borderRadius: "14px",
          padding: "16px",
          fontSize: "14px",
          cursor: "pointer",
          fontFamily: "inherit"
        }
      }, "Sign In"))), authSheet && /* @__PURE__ */ React.createElement("div", {
        onClick: () => {
          if (!authVerifyPending && authSheet !== "signup") setAuthSheet(null);
        },
        style: {
          position: "fixed",
          inset: 0,
          zIndex: 300,
          background: "rgba(0,0,0,0.5)",
          backdropFilter: "blur(6px)"
        }
      }, /* @__PURE__ */ React.createElement("div", {
        onClick: (e) => e.stopPropagation(),
        style: {
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          background: "#0f0f1c",
          borderRadius: "24px 24px 0 0",
          padding: "8px 28px max(40px,calc(env(safe-area-inset-bottom)+28px))",
          animation: "slide-up 0.3s ease",
          maxWidth: "520px",
          margin: "0 auto"
        }
      }, !authVerifyPending && /* @__PURE__ */ React.createElement("div", {
        onClick: () => {
          if (authSheet !== "signup") setAuthSheet(null);
        },
        style: {
          padding: "12px 0 20px",
          cursor: authSheet !== "signup" ? "pointer" : "default",
          textAlign: "center"
        }
      }, /* @__PURE__ */ React.createElement("div", {
        style: {
          width: "40px",
          height: "4px",
          borderRadius: "2px",
          background: "rgba(255,255,255,0.12)",
          display: "inline-block"
        }
      })), authVerifyPending ? /* @__PURE__ */ React.createElement("div", {
        style: {
          textAlign: "center",
          padding: "24px 0 8px",
          animation: "fade-up 0.3s ease"
        }
      }, /* @__PURE__ */ React.createElement("div", {
        style: {
          fontSize: "52px",
          marginBottom: "20px"
        }
      }, /* @__PURE__ */ React.createElement("svg", { width: "1em", height: "1em", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round" }, /* @__PURE__ */ React.createElement("path", { d: "M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" }), /* @__PURE__ */ React.createElement("polyline", { points: "22,6 12,13 2,6" }))), /* @__PURE__ */ React.createElement("h2", {
        style: {
          fontSize: "22px",
          fontWeight: "700",
          color: "#f0e6d3",
          marginBottom: "10px"
        }
      }, "Check your email"), /* @__PURE__ */ React.createElement("p", {
        style: {
          fontSize: "14px",
          color: "rgba(255,255,255,0.4)",
          lineHeight: "1.7",
          marginBottom: "8px"
        }
      }, "We sent a verification link to"), /* @__PURE__ */ React.createElement("p", {
        style: {
          fontSize: "14px",
          fontWeight: "600",
          color: "#d4a846",
          marginBottom: "28px"
        }
      }, authEmail), /* @__PURE__ */ React.createElement("p", {
        style: {
          fontSize: "13px",
          color: "rgba(255,255,255,0.3)",
          lineHeight: "1.7",
          marginBottom: "28px",
          maxWidth: "260px",
          margin: "0 auto 28px"
        }
      }, "Click the link in that email to confirm your account, then come back and sign in."), authError && /* @__PURE__ */ React.createElement("div", {
        style: {
          fontSize: "13px",
          color: authError.includes("resent") || authError.includes("sent") ? "#6aaa8a" : "#e8a0a8",
          textAlign: "center",
          marginBottom: "16px",
          lineHeight: "1.6"
        }
      }, authError), /* @__PURE__ */ React.createElement("button", {
        onClick: handleResendVerification,
        disabled: authWorking,
        style: {
          background: "none",
          border: "1px solid rgba(255,255,255,0.12)",
          color: "rgba(255,255,255,0.4)",
          borderRadius: "50px",
          padding: "10px 24px",
          fontSize: "13px",
          cursor: "pointer",
          fontFamily: "inherit",
          marginBottom: "14px",
          opacity: authWorking ? 0.5 : 1
        }
      }, authWorking ? "Sending\u2026" : "Resend email"), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("button", {
        onClick: () => openSheet("signin"),
        style: {
          background: "none",
          border: "none",
          color: "rgba(255,255,255,0.25)",
          cursor: "pointer",
          fontSize: "13px",
          fontFamily: "inherit"
        }
      }, "Already confirmed? Sign in \u2192"))) : authSheet === "signup" ? (
        /* ── Sign Up form ── */
        /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("h2", {
          style: {
            fontSize: "22px",
            fontWeight: "600",
            color: "#f0e6d3",
            textAlign: "center",
            marginBottom: "6px"
          }
        }, "Create your account"), /* @__PURE__ */ React.createElement("p", {
          style: {
            fontSize: "14px",
            color: "rgba(255,255,255,0.25)",
            textAlign: "center",
            marginBottom: "24px"
          }
        }, "Free to start \u2014 no credit card"), /* @__PURE__ */ React.createElement("div", {
          style: {
            display: "flex",
            flexDirection: "column",
            gap: "10px"
          }
        }, /* @__PURE__ */ React.createElement("input", {
          type: "text",
          placeholder: "Your name",
          value: authName,
          onChange: (e) => setAuthName(e.target.value),
          onKeyDown: (e) => e.key === "Enter" && handleAuth(),
          style: inp,
          autoFocus: true
        }), /* @__PURE__ */ React.createElement("input", {
          type: "email",
          placeholder: "Email",
          value: authEmail,
          onChange: (e) => setAuthEmail(e.target.value),
          onKeyDown: (e) => e.key === "Enter" && handleAuth(),
          style: inp
        }), /* @__PURE__ */ React.createElement("input", {
          type: "password",
          placeholder: "Password (min 8 characters)",
          value: authPassword,
          onChange: (e) => setAuthPassword(e.target.value),
          onKeyDown: (e) => e.key === "Enter" && handleAuth(),
          style: inp
        }), /* @__PURE__ */ React.createElement("input", {
          type: "password",
          placeholder: "Confirm password",
          value: authConfirmPw,
          onChange: (e) => setAuthConfirmPw(e.target.value),
          onKeyDown: (e) => e.key === "Enter" && handleAuth(),
          style: {
            ...inp,
            borderColor: authConfirmPw && authConfirmPw !== authPassword ? "rgba(232,160,168,0.5)" : inp.borderColor
          }
        })), authError && /* @__PURE__ */ React.createElement("div", {
          style: {
            fontSize: "13px",
            color: "#e8a0a8",
            textAlign: "center",
            margin: "12px 0 0",
            lineHeight: "1.6"
          }
        }, authError), /* @__PURE__ */ React.createElement("button", {
          onClick: handleAuth,
          disabled: authWorking,
          style: {
            width: "100%",
            marginTop: "18px",
            background: "linear-gradient(135deg, #d4a846, #c9807a)",
            color: "#080810",
            border: "none",
            borderRadius: "14px",
            padding: "18px",
            fontSize: "15px",
            fontWeight: "700",
            letterSpacing: "0.5px",
            cursor: authWorking ? "wait" : "pointer",
            opacity: authWorking ? 0.6 : 1,
            fontFamily: "inherit",
            transition: "opacity 0.2s"
          }
        }, authWorking ? "Creating account\u2026" : "Create Account"), /* @__PURE__ */ React.createElement("div", {
          style: {
            textAlign: "center",
            marginTop: "16px"
          }
        }, /* @__PURE__ */ React.createElement("button", {
          onClick: () => openSheet("signin"),
          style: {
            background: "none",
            border: "none",
            color: "rgba(255,255,255,0.3)",
            cursor: "pointer",
            fontSize: "13px",
            fontFamily: "inherit"
          }
        }, "Already have an account? Sign in \u2192")))
      ) : (
        /* ── Sign In form ── */
        /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("h2", {
          style: {
            fontSize: "22px",
            fontWeight: "600",
            color: "#f0e6d3",
            textAlign: "center",
            marginBottom: "6px"
          }
        }, "Welcome back"), /* @__PURE__ */ React.createElement("p", {
          style: {
            fontSize: "14px",
            color: "rgba(255,255,255,0.25)",
            textAlign: "center",
            marginBottom: "24px"
          }
        }, "Sign in to continue listening"), /* @__PURE__ */ React.createElement("div", {
          style: {
            display: "flex",
            flexDirection: "column",
            gap: "10px"
          }
        }, /* @__PURE__ */ React.createElement("input", {
          type: "email",
          placeholder: "Email",
          value: authEmail,
          onChange: (e) => setAuthEmail(e.target.value),
          onKeyDown: (e) => e.key === "Enter" && handleAuth(),
          style: inp,
          autoFocus: true
        }), /* @__PURE__ */ React.createElement("input", {
          type: "password",
          placeholder: "Password",
          value: authPassword,
          onChange: (e) => setAuthPassword(e.target.value),
          onKeyDown: (e) => e.key === "Enter" && handleAuth(),
          style: inp
        })), authError && /* @__PURE__ */ React.createElement("div", {
          style: {
            fontSize: "13px",
            color: authError.includes("reset") || authError.includes("sent") ? "#6aaa8a" : "#e8a0a8",
            textAlign: "center",
            margin: "12px 0 0",
            lineHeight: "1.6"
          }
        }, authError), /* @__PURE__ */ React.createElement("button", {
          onClick: handleAuth,
          disabled: authWorking,
          style: {
            width: "100%",
            marginTop: "18px",
            background: "linear-gradient(135deg, #d4a846, #c9807a)",
            color: "#080810",
            border: "none",
            borderRadius: "14px",
            padding: "18px",
            fontSize: "15px",
            fontWeight: "700",
            letterSpacing: "0.5px",
            cursor: authWorking ? "wait" : "pointer",
            opacity: authWorking ? 0.6 : 1,
            fontFamily: "inherit",
            transition: "opacity 0.2s"
          }
        }, authWorking ? "Signing in\u2026" : "Sign In"), /* @__PURE__ */ React.createElement("div", {
          style: {
            textAlign: "center",
            marginTop: "16px",
            display: "flex",
            flexDirection: "column",
            gap: "8px"
          }
        }, /* @__PURE__ */ React.createElement("button", {
          onClick: () => openSheet("signup"),
          style: {
            background: "none",
            border: "none",
            color: "rgba(255,255,255,0.3)",
            cursor: "pointer",
            fontSize: "13px",
            fontFamily: "inherit"
          }
        }, "New here? Create an account \u2192"), /* @__PURE__ */ React.createElement("button", {
          onClick: handleForgotPassword,
          disabled: authWorking,
          style: {
            background: "none",
            border: "none",
            color: "rgba(255,255,255,0.18)",
            cursor: "pointer",
            fontSize: "12px",
            fontFamily: "inherit",
            padding: "12px 16px",
            margin: "-12px -16px",
            minHeight: "44px",
            minWidth: "44px"
          }
        }, "Forgot password?")))
      ))));
    }
    const isSyncing = mode === "syncing";
    const artwork = detectedSong?.artwork;
    return /* @__PURE__ */ React.createElement("div", {
      style: {
        minHeight: "100vh",
        background: "#080810",
        color: "#f0e6d3",
        fontFamily: "-apple-system,BlinkMacSystemFont,'SF Pro Display','Helvetica Neue',sans-serif",
        position: "relative",
        overflow: "hidden"
      }
    }, artwork && /* @__PURE__ */ React.createElement("div", {
      style: {
        position: "fixed",
        inset: "-20px",
        zIndex: 0,
        backgroundImage: `url(${artwork})`,
        backgroundSize: "cover",
        backgroundPosition: "center",
        filter: "blur(80px) brightness(0.15) saturate(2)",
        transition: "opacity 1s ease",
        opacity: isSyncing ? 1 : 0.4
      }
    }), /* @__PURE__ */ React.createElement("div", {
      style: {
        position: "fixed",
        inset: 0,
        zIndex: 1,
        background: "linear-gradient(to bottom, rgba(8,8,16,0.6) 0%, rgba(8,8,16,0.3) 40%, rgba(8,8,16,0.7) 100%)",
        pointerEvents: "none"
      }
    }), showOnboarding && /* @__PURE__ */ React.createElement("div", {
      style: {
        position: "fixed",
        inset: 0,
        zIndex: 500,
        background: "rgba(8,8,16,0.96)",
        backdropFilter: "blur(12px)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "40px 32px"
      }
    }, onboardingStep < ONBOARDING_STEPS - 1 && /* @__PURE__ */ React.createElement("button", {
      onClick: dismissOnboarding,
      style: {
        position: "absolute",
        top: "max(24px, calc(env(safe-area-inset-top) + 12px))",
        right: "24px",
        background: "none",
        border: "none",
        color: "rgba(255,255,255,0.25)",
        cursor: "pointer",
        fontSize: "14px",
        fontFamily: "inherit"
      }
    }, "Skip"), onboardingStep === 0 && /* @__PURE__ */ React.createElement("div", {
      style: {
        textAlign: "center",
        animation: "fade-up 0.4s ease both"
      }
    }, /* @__PURE__ */ React.createElement(Vinyl, {
      size: 120,
      spinning: false
    }), /* @__PURE__ */ React.createElement("div", {
      style: {
        marginTop: "28px",
        fontSize: "13px",
        letterSpacing: "4px",
        color: "#d4a846",
        textTransform: "uppercase",
        marginBottom: "8px"
      }
    }, "Welcome to"), /* @__PURE__ */ React.createElement("div", {
      style: {
        fontSize: "40px",
        letterSpacing: "16px",
        color: "#d4a846",
        fontWeight: "300",
        marginBottom: "12px"
      }
    }, "LIRI"), /* @__PURE__ */ React.createElement("div", {
      style: {
        fontSize: "16px",
        color: "rgba(255,255,255,0.35)",
        letterSpacing: "2px",
        marginBottom: "40px"
      }
    }, "Lyrics for Vinyl"), /* @__PURE__ */ React.createElement("p", {
      style: {
        fontSize: "17px",
        color: "rgba(255,255,255,0.6)",
        lineHeight: "1.8",
        maxWidth: "280px",
        margin: "0 auto 48px"
      }
    }, "Put a record on. Hold your phone near the speakers. Watch the lyrics scroll by \u2014 line by line, in sync."), /* @__PURE__ */ React.createElement("button", {
      onClick: () => setOnboardingStep(1),
      style: {
        background: "linear-gradient(135deg, #d4a846, #c9807a)",
        color: "#080810",
        border: "none",
        borderRadius: "50px",
        padding: "18px 52px",
        fontSize: "15px",
        fontWeight: "700",
        cursor: "pointer",
        fontFamily: "inherit",
        letterSpacing: "1px",
        boxShadow: "0 8px 32px rgba(212,168,70,0.3)"
      }
    }, "Let's go \u2192")), onboardingStep === 1 && /* @__PURE__ */ React.createElement("div", {
      style: {
        textAlign: "center",
        animation: "fade-up 0.4s ease both"
      }
    }, /* @__PURE__ */ React.createElement("div", {
      style: {
        marginBottom: "32px"
      }
    }, /* @__PURE__ */ React.createElement(WaveAnimation, {
      active: true,
      size: 1.2
    })), /* @__PURE__ */ React.createElement("div", {
      style: {
        fontSize: "26px",
        fontWeight: "700",
        color: "#f0e6d3",
        marginBottom: "16px"
      }
    }, "Hold it close"), /* @__PURE__ */ React.createElement("p", {
      style: {
        fontSize: "15px",
        color: "rgba(255,255,255,0.5)",
        lineHeight: "1.9",
        maxWidth: "280px",
        margin: "0 auto 48px"
      }
    }, IS_IOS ? /* @__PURE__ */ React.createElement(React.Fragment, null, "When your record is playing, tap ", /* @__PURE__ */ React.createElement("strong", { style: { color: "#d4a846" } }, "Listen"), ". Liri uses Shazam to find your place in the song and syncs the lyrics in real time.") : "Add your albums to your library, then tap any track to start. Liri syncs the lyrics in real time \u2014 line by line."), /* @__PURE__ */ React.createElement("div", {
      style: {
        display: "flex",
        gap: "16px",
        justifyContent: "center",
        alignItems: "center"
      }
    }, /* @__PURE__ */ React.createElement("button", {
      onClick: () => setOnboardingStep(0),
      style: {
        background: "none",
        border: "1px solid rgba(255,255,255,0.1)",
        color: "rgba(255,255,255,0.3)",
        borderRadius: "50px",
        padding: "12px 24px",
        fontSize: "13px",
        cursor: "pointer",
        fontFamily: "inherit"
      }
    }, "\u2190 Back"), /* @__PURE__ */ React.createElement("button", {
      onClick: () => setOnboardingStep(2),
      style: {
        background: "linear-gradient(135deg, #d4a846, #c9807a)",
        color: "#080810",
        border: "none",
        borderRadius: "50px",
        padding: "14px 36px",
        fontSize: "14px",
        fontWeight: "700",
        cursor: "pointer",
        fontFamily: "inherit"
      }
    }, "Next \u2192"))), onboardingStep === 2 && /* @__PURE__ */ React.createElement("div", {
      style: {
        textAlign: "center",
        animation: "fade-up 0.4s ease both"
      }
    }, /* @__PURE__ */ React.createElement("div", {
      style: {
        fontSize: "72px",
        marginBottom: "24px",
        filter: "drop-shadow(0 0 20px rgba(212,168,70,0.4))"
      }
    }, /* @__PURE__ */ React.createElement("svg", { width: "1em", height: "1em", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round" }, /* @__PURE__ */ React.createElement("circle", { cx: "12", cy: "12", r: "10" }), /* @__PURE__ */ React.createElement("polyline", { points: "12 6 12 12 16 14" }))), /* @__PURE__ */ React.createElement("div", {
      style: {
        fontSize: "26px",
        fontWeight: "700",
        color: "#f0e6d3",
        marginBottom: "16px"
      }
    }, "Your listening history"), /* @__PURE__ */ React.createElement("p", {
      style: {
        fontSize: "15px",
        color: "rgba(255,255,255,0.5)",
        lineHeight: "1.9",
        maxWidth: "280px",
        margin: "0 auto 32px"
      }
    }, "Every song you identify gets saved automatically. Tap the ", /* @__PURE__ */ React.createElement("strong", {
      style: {
        color: "#d4a846"
      }
    }, "clock icon"), " anytime to see what's been spinning on your turntable."), /* @__PURE__ */ React.createElement("div", {
      style: {
        background: "rgba(255,255,255,0.04)",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: "16px",
        padding: "12px 16px",
        maxWidth: "280px",
        margin: "0 auto 40px",
        textAlign: "left"
      }
    }, [{
      title: "Blue in Green",
      artist: "Miles Davis"
    }, {
      title: "God Only Knows",
      artist: "The Beach Boys"
    }, {
      title: "In the Aeroplane",
      artist: "Neutral Milk Hotel"
    }].map((s, i) => /* @__PURE__ */ React.createElement("div", {
      key: i,
      style: {
        display: "flex",
        alignItems: "center",
        gap: "12px",
        padding: "8px 0",
        borderBottom: i < 2 ? "1px solid rgba(255,255,255,0.05)" : "none"
      }
    }, /* @__PURE__ */ React.createElement("div", {
      style: {
        width: "36px",
        height: "36px",
        borderRadius: "6px",
        background: "rgba(212,168,70,0.15)",
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: "14px"
      }
    }, /* @__PURE__ */ React.createElement("svg", { width: "1em", height: "1em", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round" }, /* @__PURE__ */ React.createElement("path", { d: "M9 18V5l12-2v13" }), /* @__PURE__ */ React.createElement("circle", { cx: "6", cy: "18", r: "3" }), /* @__PURE__ */ React.createElement("circle", { cx: "18", cy: "16", r: "3" }))), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", {
      style: {
        fontSize: "13px",
        fontWeight: "600",
        color: "#f0e6d3"
      }
    }, s.title), /* @__PURE__ */ React.createElement("div", {
      style: {
        fontSize: "11px",
        color: "rgba(255,255,255,0.35)"
      }
    }, s.artist))))), /* @__PURE__ */ React.createElement("div", {
      style: {
        display: "flex",
        gap: "16px",
        justifyContent: "center",
        alignItems: "center"
      }
    }, /* @__PURE__ */ React.createElement("button", {
      onClick: () => setOnboardingStep(1),
      style: {
        background: "none",
        border: "1px solid rgba(255,255,255,0.1)",
        color: "rgba(255,255,255,0.3)",
        borderRadius: "50px",
        padding: "12px 24px",
        fontSize: "13px",
        cursor: "pointer",
        fontFamily: "inherit"
      }
    }, "\u2190 Back"), /* @__PURE__ */ React.createElement("button", {
      onClick: () => setOnboardingStep(3),
      style: {
        background: "linear-gradient(135deg, #d4a846, #c9807a)",
        color: "#080810",
        border: "none",
        borderRadius: "50px",
        padding: "14px 36px",
        fontSize: "14px",
        fontWeight: "700",
        cursor: "pointer",
        fontFamily: "inherit"
      }
    }, "Next \u2192"))), onboardingStep === 3 && /* @__PURE__ */ React.createElement("div", {
      style: {
        textAlign: "center",
        animation: "fade-up 0.4s ease both"
      }
    }, /* @__PURE__ */ React.createElement("div", {
      style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "16px",
        marginBottom: "28px"
      }
    }, /* @__PURE__ */ React.createElement(Vinyl, {
      size: 80,
      spinning: false
    }), /* @__PURE__ */ React.createElement("div", {
      style: {
        width: "52px",
        height: "30px",
        borderRadius: "15px",
        background: "linear-gradient(135deg, #d4a846, #c9807a)",
        position: "relative",
        flexShrink: 0
      }
    }, /* @__PURE__ */ React.createElement("div", {
      style: {
        position: "absolute",
        top: "5px",
        right: "5px",
        width: "20px",
        height: "20px",
        borderRadius: "50%",
        background: "white",
        boxShadow: "0 1px 4px rgba(0,0,0,0.3)"
      }
    }))), /* @__PURE__ */ React.createElement("div", {
      style: {
        fontSize: "26px",
        fontWeight: "700",
        color: "#f0e6d3",
        marginBottom: "16px"
      }
    }, "Auto Mode"), /* @__PURE__ */ React.createElement("p", {
      style: {
        fontSize: "15px",
        color: "rgba(255,255,255,0.5)",
        lineHeight: "1.9",
        maxWidth: "280px",
        margin: "0 auto 32px"
      }
    }, "Liri automatically listens for the next song as each track ends. No tapping, no fiddling \u2014 just the music."), /* @__PURE__ */ React.createElement("div", {
      style: {
        background: "rgba(212,168,70,0.07)",
        border: "1px solid rgba(212,168,70,0.15)",
        borderRadius: "14px",
        padding: "12px 16px",
        maxWidth: "260px",
        margin: "0 auto 40px",
        fontSize: "13px",
        color: "rgba(255,255,255,0.35)",
        lineHeight: "1.7"
      }
    }, "\u2726 Listens for the next song \u2014 flip the record when you're ready"), /* @__PURE__ */ React.createElement("div", {
      style: {
        display: "flex",
        gap: "16px",
        justifyContent: "center",
        alignItems: "center"
      }
    }, /* @__PURE__ */ React.createElement("button", {
      onClick: () => setOnboardingStep(2),
      style: {
        background: "none",
        border: "1px solid rgba(255,255,255,0.1)",
        color: "rgba(255,255,255,0.3)",
        borderRadius: "50px",
        padding: "12px 24px",
        fontSize: "13px",
        cursor: "pointer",
        fontFamily: "inherit"
      }
    }, "\u2190 Back"), /* @__PURE__ */ React.createElement("button", {
      onClick: () => setOnboardingStep(4),
      style: {
        background: "linear-gradient(135deg, #d4a846, #c9807a)",
        color: "#080810",
        border: "none",
        borderRadius: "50px",
        padding: "14px 36px",
        fontSize: "14px",
        fontWeight: "700",
        cursor: "pointer",
        fontFamily: "inherit"
      }
    }, "Next \u2192"))), onboardingStep === 4 && /* @__PURE__ */ React.createElement("div", {
      style: {
        textAlign: "center",
        animation: "fade-up 0.4s ease both",
        maxWidth: "320px",
        margin: "0 auto"
      }
    }, /* @__PURE__ */ React.createElement(Vinyl, {
      size: 64,
      spinning: false
    }), /* @__PURE__ */ React.createElement("div", {
      style: {
        marginTop: "16px",
        fontSize: "11px",
        letterSpacing: "4px",
        color: "rgba(212,168,70,0.5)",
        textTransform: "uppercase",
        marginBottom: "6px"
      }
    }, "Liri"), /* @__PURE__ */ React.createElement("div", {
      style: {
        fontSize: "12px",
        color: "rgba(255,255,255,0.2)",
        marginBottom: "32px"
      }
    }, "\xA9 ", (/* @__PURE__ */ new Date()).getFullYear(), " Liri. All rights reserved."), /* @__PURE__ */ React.createElement("div", {
      style: {
        background: "rgba(212,168,70,0.06)",
        border: "1px solid rgba(212,168,70,0.12)",
        borderRadius: "16px",
        padding: "18px 20px",
        marginBottom: "24px"
      }
    }, /* @__PURE__ */ React.createElement("div", {
      style: {
        fontSize: "13px",
        color: "rgba(212,168,70,0.7)",
        letterSpacing: "2px",
        textTransform: "uppercase",
        marginBottom: "10px"
      }
    }, "To the artists"), /* @__PURE__ */ React.createElement("p", {
      style: {
        fontSize: "13px",
        color: "rgba(255,255,255,0.4)",
        lineHeight: "1.8"
      }
    }, "The lyrics displayed in Liri belong to the artists, songwriters, and publishers who created them. We're just here to help you feel every word.")), /* @__PURE__ */ React.createElement("div", {
      style: {
        marginBottom: "36px"
      }
    }, /* @__PURE__ */ React.createElement("div", {
      style: {
        fontSize: "11px",
        color: "rgba(255,255,255,0.2)",
        letterSpacing: "2px",
        textTransform: "uppercase",
        marginBottom: "14px"
      }
    }, "Made possible by"), /* @__PURE__ */ React.createElement("div", {
      style: {
        display: "flex",
        flexDirection: "column",
        gap: "8px"
      }
    }, (IS_IOS ? [{
      name: "ShazamKit",
      role: "Song recognition"
    }, {
      name: "LRCLib",
      role: "Synced lyrics"
    }, {
      name: "Discogs",
      role: "Album & track data"
    }] : [{
      name: "LRCLib",
      role: "Synced lyrics"
    }, {
      name: "Discogs",
      role: "Album & track data"
    }]).map((c) => /* @__PURE__ */ React.createElement("div", {
      key: c.name,
      style: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "8px 14px",
        background: "rgba(255,255,255,0.03)",
        borderRadius: "10px"
      }
    }, /* @__PURE__ */ React.createElement("span", {
      style: {
        fontSize: "13px",
        color: "rgba(255,255,255,0.55)",
        fontWeight: "500"
      }
    }, c.name), /* @__PURE__ */ React.createElement("span", {
      style: {
        fontSize: "11px",
        color: "rgba(255,255,255,0.2)"
      }
    }, c.role))))), /* @__PURE__ */ React.createElement("button", {
      onClick: dismissOnboarding,
      style: {
        background: "linear-gradient(135deg, #d4a846, #c9807a)",
        color: "#080810",
        border: "none",
        borderRadius: "50px",
        padding: "18px 52px",
        fontSize: "15px",
        fontWeight: "700",
        cursor: "pointer",
        fontFamily: "inherit",
        letterSpacing: "1px",
        boxShadow: "0 8px 32px rgba(212,168,70,0.3)"
      }
    }, "Start listening \u2192"), /* @__PURE__ */ React.createElement("div", {
      style: {
        marginTop: "14px"
      }
    }, /* @__PURE__ */ React.createElement("button", {
      onClick: () => setOnboardingStep(3),
      style: {
        background: "none",
        border: "none",
        color: "rgba(255,255,255,0.2)",
        cursor: "pointer",
        fontSize: "13px",
        fontFamily: "inherit"
      }
    }, "\u2190 Back"))), /* @__PURE__ */ React.createElement("div", {
      style: {
        position: "absolute",
        bottom: "max(40px, calc(env(safe-area-inset-bottom) + 24px))",
        left: 0,
        right: 0,
        display: "flex",
        justifyContent: "center",
        gap: "8px"
      }
    }, Array.from({
      length: ONBOARDING_STEPS
    }).map((_, i) => /* @__PURE__ */ React.createElement("div", {
      key: i,
      onClick: () => setOnboardingStep(i),
      style: {
        width: i === onboardingStep ? "20px" : "6px",
        height: "6px",
        borderRadius: "3px",
        background: i === onboardingStep ? "#d4a846" : "rgba(255,255,255,0.15)",
        transition: "all 0.3s ease",
        cursor: "pointer"
      }
    })))), showAlbumPicker && /* @__PURE__ */ React.createElement("div", {
      onClick: () => setShowAlbumPicker(false),
      style: {
        position: "fixed",
        inset: 0,
        zIndex: 200,
        background: "rgba(0,0,0,0.6)",
        backdropFilter: "blur(4px)",
        cursor: "pointer"
      }
    }, /* @__PURE__ */ React.createElement("div", {
      onClick: (e) => e.stopPropagation(),
      style: {
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        background: "#0f0f1c",
        borderRadius: "24px 24px 0 0",
        maxHeight: "80vh",
        display: "flex",
        flexDirection: "column",
        boxShadow: "0 -8px 48px rgba(0,0,0,0.6)",
        animation: "slide-up 0.3s ease"
      }
    }, /* @__PURE__ */ React.createElement("div", {
      style: {
        display: "flex",
        justifyContent: "center",
        padding: "12px 0 4px"
      }
    }, /* @__PURE__ */ React.createElement("div", {
      style: {
        width: 36,
        height: 4,
        borderRadius: 2,
        background: "rgba(255,255,255,0.12)"
      }
    })), /* @__PURE__ */ React.createElement("div", {
      style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "12px 24px 16px"
      }
    }, /* @__PURE__ */ React.createElement("div", {
      style: {
        fontSize: 18,
        fontWeight: 700
      }
    }, "What's on the turntable?"), /* @__PURE__ */ React.createElement("button", {
      onClick: () => setShowAlbumPicker(false),
      style: {
        background: "rgba(255,255,255,0.07)",
        border: "none",
        color: "rgba(255,255,255,0.5)",
        width: 30,
        height: 30,
        borderRadius: "50%",
        cursor: "pointer",
        fontSize: 14,
        fontFamily: "inherit"
      }
    }, /* @__PURE__ */ React.createElement("svg", { width: "12", height: "12", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2.5", strokeLinecap: "round" }, /* @__PURE__ */ React.createElement("line", { x1: "18", y1: "6", x2: "6", y2: "18" }), /* @__PURE__ */ React.createElement("line", { x1: "6", y1: "6", x2: "18", y2: "18" })))), /* @__PURE__ */ React.createElement("div", {
      style: {
        overflowY: "auto",
        padding: "0 24px",
        flex: 1,
        paddingBottom: "max(24px, env(safe-area-inset-bottom))",
        WebkitOverflowScrolling: "touch"
      }
    }, turntableAlbum && /* @__PURE__ */ React.createElement("button", {
      onClick: () => {
        setTurntableAlbum(null);
        setShowAlbumPicker(false);
      },
      style: {
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "7px 0",
        background: "none",
        border: "none",
        borderBottom: "1px solid rgba(255,255,255,0.04)",
        cursor: "pointer",
        fontFamily: "inherit",
        color: "rgba(255,255,255,0.3)",
        fontSize: 12,
        textAlign: "left",
        marginBottom: 2
      }
    }, /* @__PURE__ */ React.createElement("div", {
      style: {
        width: 28,
        height: 28,
        borderRadius: 6,
        background: "rgba(255,255,255,0.03)",
        border: "1px dashed rgba(255,255,255,0.08)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 13,
        flexShrink: 0
      }
    }, /* @__PURE__ */ React.createElement("svg", { width: "12", height: "12", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2.5", strokeLinecap: "round" }, /* @__PURE__ */ React.createElement("line", { x1: "18", y1: "6", x2: "6", y2: "18" }), /* @__PURE__ */ React.createElement("line", { x1: "6", y1: "6", x2: "18", y2: "18" }))), /* @__PURE__ */ React.createElement("span", null, "Clear selection")), libLoading ? /* @__PURE__ */ React.createElement("div", {
      style: {
        display: "flex",
        justifyContent: "center",
        padding: "32px 0"
      }
    }, /* @__PURE__ */ React.createElement("div", {
      style: {
        width: 24,
        height: 24,
        borderRadius: "50%",
        border: "2px solid rgba(255,255,255,0.06)",
        borderTopColor: "#d4a846",
        animation: "spin 0.8s linear infinite"
      }
    })) : userLibrary.length === 0 ? /* @__PURE__ */ React.createElement("div", {
      style: {
        textAlign: "center",
        padding: "40px 0",
        color: "rgba(255,255,255,0.2)"
      }
    }, /* @__PURE__ */ React.createElement("div", {
      style: {
        fontSize: 40,
        marginBottom: 12,
        opacity: 0.3
      }
    }, /* @__PURE__ */ React.createElement("svg", { width: "1em", height: "1em", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round" }, /* @__PURE__ */ React.createElement("circle", { cx: "12", cy: "12", r: "10" }), /* @__PURE__ */ React.createElement("circle", { cx: "12", cy: "12", r: "3" }))), /* @__PURE__ */ React.createElement("div", {
      style: {
        fontSize: 15,
        fontWeight: 600,
        color: "rgba(255,255,255,0.35)",
        marginBottom: 8
      }
    }, "Your library is empty"), /* @__PURE__ */ React.createElement("div", {
      style: {
        fontSize: 13,
        color: "rgba(255,255,255,0.2)",
        marginBottom: 20,
        lineHeight: 1.6
      }
    }, "Head to My Records to add your first album.")) : userLibrary.map((album) => {
      const isSelected = turntableAlbum?.itunes_collection_id === album.itunes_collection_id;
      return /* @__PURE__ */ React.createElement("button", {
        key: album.id,
        onClick: () => {
          setTurntableAlbum({
            itunes_collection_id: album.itunes_collection_id,
            album_name: album.album_name,
            artist_name: album.artist_name,
            artwork_url: album.artwork_url
          });
          setShowAlbumPicker(false);
        },
        style: {
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "12px 0",
          background: "none",
          border: "none",
          borderBottom: "1px solid rgba(255,255,255,0.04)",
          cursor: "pointer",
          fontFamily: "inherit",
          textAlign: "left"
        }
      }, album.artwork_url ? /* @__PURE__ */ React.createElement("img", {
        src: album.artwork_url,
        alt: "",
        style: {
          width: 44,
          height: 44,
          borderRadius: 7,
          objectFit: "cover",
          flexShrink: 0,
          opacity: isSelected ? 1 : 0.85
        }
      }) : /* @__PURE__ */ React.createElement("div", {
        style: {
          width: 44,
          height: 44,
          borderRadius: 7,
          background: "rgba(255,255,255,0.04)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 20,
          flexShrink: 0
        }
      }, /* @__PURE__ */ React.createElement("svg", { width: "1em", height: "1em", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round" }, /* @__PURE__ */ React.createElement("circle", { cx: "12", cy: "12", r: "10" }), /* @__PURE__ */ React.createElement("circle", { cx: "12", cy: "12", r: "3" }))), /* @__PURE__ */ React.createElement("div", {
        style: {
          flex: 1,
          minWidth: 0
        }
      }, /* @__PURE__ */ React.createElement("div", {
        style: {
          fontSize: 14,
          fontWeight: isSelected ? 700 : 500,
          color: isSelected ? "#d4a846" : "#f0e6d3",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap"
        }
      }, album.album_name), /* @__PURE__ */ React.createElement("div", {
        style: {
          fontSize: 12,
          color: "rgba(255,255,255,0.4)",
          marginTop: 2
        }
      }, album.artist_name)), isSelected && /* @__PURE__ */ React.createElement("span", {
        style: {
          fontSize: 14,
          color: "#d4a846",
          flexShrink: 0
        }
      }, "\u2713"));
    }), /* @__PURE__ */ React.createElement("div", {
      style: {
        textAlign: "center",
        padding: "20px 0 4px"
      }
    }, /* @__PURE__ */ React.createElement("a", {
      href: window.Capacitor ? "/library.html" : "/library",
      style: {
        fontSize: 12,
        color: "rgba(255,255,255,0.2)",
        textDecoration: "none"
      }
    }, "Manage My Records \u2192"))))), showTrackList && !window.Capacitor && /* @__PURE__ */ React.createElement("div", {
      onClick: () => setShowTrackList(false),
      style: { position: "fixed", inset: 0, zIndex: 201, background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)", cursor: "pointer", display: "flex", alignItems: "flex-end", justifyContent: "center" }
    }, /* @__PURE__ */ React.createElement("div", {
      onClick: (e) => e.stopPropagation(),
      style: { width: "100%", maxWidth: "520px", background: "#0f0f1c", borderRadius: "24px 24px 0 0", maxHeight: "80vh", display: "flex", flexDirection: "column", boxShadow: "0 -8px 48px rgba(0,0,0,0.6)", animation: "slide-up 0.3s ease" }
    }, /* @__PURE__ */ React.createElement("div", {
      style: { display: "flex", justifyContent: "center", padding: "12px 0 4px" }
    }, /* @__PURE__ */ React.createElement("div", {
      style: { width: 36, height: 4, borderRadius: 2, background: "rgba(255,255,255,0.12)" }
    })), /* @__PURE__ */ React.createElement("div", {
      style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 24px 16px" }
    }, /* @__PURE__ */ React.createElement("div", {
      style: { fontSize: 18, fontWeight: 700, color: "#f0e6d3" }
    }, "Pick a track"), /* @__PURE__ */ React.createElement("button", {
      onClick: () => setShowTrackList(false),
      style: { background: "rgba(255,255,255,0.07)", border: "none", color: "rgba(255,255,255,0.5)", width: 30, height: 30, borderRadius: "50%", cursor: "pointer", fontSize: 18, lineHeight: "1", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "inherit" }
    }, "\xD7")), /* @__PURE__ */ React.createElement("div", {
      style: { overflowY: "auto", WebkitOverflowScrolling: "touch", padding: "0 24px 40px", display: "flex", flexDirection: "column", gap: "20px" }
    }, (() => {
      const _wt = turntableTracksRef.current;
      if (!_wt.length) return null;
      const _groups = getSideGroups(_wt, vinylSidesRef.current, vinylDbRelease?.vinyl_tracks);
      return _groups.map(({ side, tracks }) => /* @__PURE__ */ React.createElement(
        "div",
        { key: side },
        /* @__PURE__ */ React.createElement("div", {
          style: { fontSize: "10px", letterSpacing: "2px", textTransform: "uppercase", color: "rgba(212,168,70,0.8)", fontWeight: "700", marginBottom: "10px", paddingBottom: "6px", borderBottom: "1px solid rgba(255,255,255,0.06)" }
        }, "Side ", side),
        /* @__PURE__ */ React.createElement("div", {
          style: { display: "flex", flexDirection: "column", gap: "4px" }
        }, tracks.map(({ track: t, idx: i }) => /* @__PURE__ */ React.createElement("button", {
          key: i,
          onClick: () => jumpToTrackIdx(i),
          style: { background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: "10px", padding: "11px 16px", color: "#f0e6d3", fontSize: "14px", cursor: "pointer", fontFamily: "inherit", textAlign: "left", display: "flex", alignItems: "center", gap: "12px" }
        }, /* @__PURE__ */ React.createElement("span", {
          style: { color: "rgba(255,255,255,0.25)", fontSize: "12px", minWidth: "20px", flexShrink: 0 }
        }, i + 1), t.trackName)))
      ));
    })()))), showSettings && /* @__PURE__ */ React.createElement("div", {
      onClick: () => setShowSettings(false),
      style: {
        position: "fixed",
        inset: 0,
        zIndex: 200,
        background: isWide ? "rgba(0,0,0,0.25)" : "rgba(0,0,0,0.5)",
        backdropFilter: isWide ? "none" : "blur(4px)",
        cursor: "pointer"
      }
    }, /* @__PURE__ */ React.createElement("div", {
      onClick: (e) => e.stopPropagation(),
      style: isWide ? {
        position: "fixed",
        top: 0,
        right: 0,
        bottom: 0,
        width: "340px",
        background: "#0f0f1c",
        borderRadius: "20px 0 0 20px",
        overflowY: "auto",
        WebkitOverflowScrolling: "touch",
        boxShadow: "-8px 0 48px rgba(0,0,0,0.7)",
        animation: "slide-right 0.28s cubic-bezier(0.4,0,0.2,1)",
        zIndex: 201
      } : {
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        background: "#0f0f1c",
        borderRadius: "24px 24px 0 0",
        maxHeight: "88vh",
        overflowY: "auto",
        WebkitOverflowScrolling: "touch",
        boxShadow: "0 -8px 48px rgba(0,0,0,0.6)",
        animation: "slide-up 0.3s ease",
        zIndex: 201
      }
    }, isWide ? /* @__PURE__ */ React.createElement("div", {
      style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "max(72px, calc(env(safe-area-inset-top) + 52px)) 20px 8px"
      }
    }, /* @__PURE__ */ React.createElement("div", {
      style: {
        fontSize: "13px",
        fontWeight: "700",
        letterSpacing: "2px",
        color: "rgba(255,255,255,0.25)",
        textTransform: "uppercase"
      }
    }, "Settings"), /* @__PURE__ */ React.createElement("button", {
      onClick: () => setShowSettings(false),
      style: {
        background: "rgba(255,255,255,0.07)",
        border: "none",
        color: "rgba(255,255,255,0.4)",
        borderRadius: "50%",
        width: "28px",
        height: "28px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: "14px",
        cursor: "pointer",
        fontFamily: "inherit",
        padding: 0
      }
    }, "\xD7")) : /* @__PURE__ */ React.createElement("div", {
      onClick: () => setShowSettings(false),
      onTouchStart: (e) => {
        e.currentTarget._touchStartY = e.touches[0].clientY;
      },
      onTouchEnd: (e) => {
        if (e.changedTouches[0].clientY - (e.currentTarget._touchStartY || 0) > 60) setShowSettings(false);
      },
      style: {
        padding: "12px 24px 4px",
        cursor: "pointer"
      }
    }, /* @__PURE__ */ React.createElement("div", {
      style: {
        width: "40px",
        height: "4px",
        borderRadius: "2px",
        background: "rgba(255,255,255,0.12)",
        margin: "0 auto"
      }
    })), /* @__PURE__ */ React.createElement(
      "div",
      {
        style: {
          padding: isWide ? "12px 20px max(20px, calc(env(safe-area-inset-bottom) + 16px))" : "16px 24px max(32px, calc(env(safe-area-inset-bottom) + 24px))"
        }
      },
      (() => {
        const displayName = user?.user_metadata?.name || "";
        const initial = (displayName?.[0] || user?.email?.[0] || "?").toUpperCase();
        return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("button", {
          onClick: () => {
            clearInterval(syncIntervalRef.current);
            reset();
            setShowSettings(false);
          },
          style: {
            width: "100%",
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.08)",
            color: "rgba(255,255,255,0.5)",
            borderRadius: "14px",
            padding: "13px 16px",
            fontSize: "14px",
            cursor: "pointer",
            fontFamily: "inherit",
            marginBottom: "20px",
            textAlign: "left",
            display: "flex",
            alignItems: "center",
            gap: "8px"
          }
        }, /* @__PURE__ */ React.createElement("svg", { width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", style: { marginRight: "6px", flexShrink: 0 } }, /* @__PURE__ */ React.createElement("path", { d: "M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" }), /* @__PURE__ */ React.createElement("polyline", { points: "9 22 9 12 15 12 15 22" })), "Home"), /* @__PURE__ */ React.createElement("div", {
          style: {
            display: "flex",
            alignItems: "center",
            gap: "14px",
            marginBottom: "28px"
          }
        }, /* @__PURE__ */ React.createElement("div", {
          style: {
            width: "48px",
            height: "48px",
            borderRadius: "50%",
            background: "linear-gradient(135deg, #d4a846, #c9807a)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "18px",
            fontWeight: "700",
            color: "#080810",
            flexShrink: 0
          }
        }, initial), /* @__PURE__ */ React.createElement("div", {
          style: {
            minWidth: 0
          }
        }, displayName ? /* @__PURE__ */ React.createElement("div", {
          style: {
            fontSize: "15px",
            fontWeight: "600",
            color: "#f0e6d3",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap"
          }
        }, displayName) : null, /* @__PURE__ */ React.createElement("div", {
          style: {
            fontSize: displayName ? "12px" : "15px",
            fontWeight: displayName ? "400" : "600",
            color: displayName ? "rgba(255,255,255,0.35)" : "#f0e6d3",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap"
          }
        }, user?.email), /* @__PURE__ */ React.createElement("div", {
          style: {
            fontSize: "12px",
            color: "rgba(255,255,255,0.3)",
            marginTop: "2px"
          }
        }, userTier === "premium" ? /* @__PURE__ */ React.createElement("span", {
          onClick: () => {
            setShowSettings(false);
            setShowPremiumInfo(true);
          },
          style: { cursor: "pointer", color: "#d4a846", display: "inline-flex", alignItems: "center", gap: "4px" }
        }, /* @__PURE__ */ React.createElement("svg", { width: "10", height: "10", viewBox: "0 0 24 24", fill: "#d4a846" }, /* @__PURE__ */ React.createElement("path", { d: "M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z" })), "Liri Premium") : "Liri"))));
      })(),
      /* ── Plan card ── */
      userTier !== "premium" ? /* @__PURE__ */ React.createElement(
        "div",
        {
          style: { background: "rgba(212,168,70,0.06)", border: "1px solid rgba(212,168,70,0.15)", borderRadius: "16px", padding: "14px 16px", marginBottom: "16px" }
        },
        /* @__PURE__ */ React.createElement(
          "div",
          { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "10px" } },
          /* @__PURE__ */ React.createElement(
            "div",
            null,
            /* @__PURE__ */ React.createElement("div", { style: { fontSize: "13px", fontWeight: "600", color: "#f0e6d3" } }, "Free plan"),
            /* @__PURE__ */ React.createElement("div", { style: { fontSize: "11px", color: "rgba(255,255,255,0.3)", marginTop: "2px" } }, `${albumCount}/10 records used`)
          ),
          IS_IOS ? /* @__PURE__ */ React.createElement("button", {
            onClick: upgradeWithApple,
            disabled: iapWorking,
            style: { background: "linear-gradient(135deg,#d4a846,#c9807a)", color: "#080810", border: "none", borderRadius: "50px", padding: "7px 14px", fontSize: "12px", fontWeight: "700", cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap", opacity: iapWorking ? 0.6 : 1 }
          }, iapWorking ? "\u2026" : `${iapPrice}`) : /* @__PURE__ */ React.createElement("button", {
            onClick: () => {
              window.location.href = "/library?upgrade=true";
            },
            style: { background: "linear-gradient(135deg,#d4a846,#c9807a)", color: "#080810", border: "none", borderRadius: "50px", padding: "7px 14px", fontSize: "12px", fontWeight: "700", cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }
          }, "Upgrade \u2192")
        ),
        /* @__PURE__ */ React.createElement(
          "div",
          { style: { width: "100%", height: "3px", borderRadius: "2px", background: "rgba(255,255,255,0.08)", overflow: "hidden" } },
          /* @__PURE__ */ React.createElement("div", { style: { height: "100%", borderRadius: "2px", background: albumCount >= 8 ? "#c9807a" : "#d4a846", width: `${Math.min(100, albumCount / 10 * 100)}%`, transition: "width 0.4s ease" } })
        )
      ) : null,
      /* ── Liri Premium row (always visible) ── */
      /* @__PURE__ */ React.createElement(
        "button",
        {
          onClick: () => {
            setShowSettings(false);
            setShowPremiumInfo(true);
          },
          style: { width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", background: userTier === "premium" ? "rgba(212,168,70,0.06)" : "rgba(255,255,255,0.04)", border: `1px solid ${userTier === "premium" ? "rgba(212,168,70,0.2)" : "rgba(255,255,255,0.08)"}`, borderRadius: "16px", padding: "14px 16px", marginBottom: "16px", cursor: "pointer", fontFamily: "inherit", textAlign: "left" }
        },
        /* @__PURE__ */ React.createElement(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "12px" } },
          /* @__PURE__ */ React.createElement("svg", { width: "16", height: "16", viewBox: "0 0 24 24", fill: "#d4a846" }, /* @__PURE__ */ React.createElement("path", { d: "M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z" })),
          /* @__PURE__ */ React.createElement(
            "div",
            null,
            /* @__PURE__ */ React.createElement("div", { style: { fontSize: "13px", fontWeight: "600", color: userTier === "premium" ? "#d4a846" : "#f0e6d3" } }, "Liri Premium"),
            /* @__PURE__ */ React.createElement("div", { style: { fontSize: "11px", color: "rgba(255,255,255,0.3)", marginTop: "2px" } }, userTier === "premium" ? "Active \xB7 Unlimited access" : "Unlimited library, lyrics & more")
          )
        ),
        /* @__PURE__ */ React.createElement(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "6px" } },
          userTier === "premium" && /* @__PURE__ */ React.createElement("div", { style: { fontSize: "10px", color: "rgba(212,168,70,0.6)", fontWeight: "700", letterSpacing: "0.5px" } }, "ACTIVE"),
          /* @__PURE__ */ React.createElement("svg", { width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: "rgba(255,255,255,0.2)", strokeWidth: "2", strokeLinecap: "round" }, /* @__PURE__ */ React.createElement("polyline", { points: "9 18 15 12 9 6" }))
        )
      ),
      /* @__PURE__ */ React.createElement("div", {
        style: {
          background: "rgba(255,255,255,0.03)",
          border: "1px solid rgba(255,255,255,0.07)",
          borderRadius: "16px",
          padding: "16px 18px",
          marginBottom: "16px"
        }
      }, /* @__PURE__ */ React.createElement("div", {
        style: {
          fontSize: "14px",
          fontWeight: "600",
          color: "#f0e6d3",
          marginBottom: "12px"
        }
      }, "Flip reminders"), /* @__PURE__ */ React.createElement("div", {
        style: {
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "14px"
        }
      }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", {
        style: {
          fontSize: "13px",
          color: "#f0e6d3"
        }
      }, "Sound chime"), /* @__PURE__ */ React.createElement("div", {
        style: {
          fontSize: "11px",
          color: "rgba(255,255,255,0.3)",
          marginTop: "2px"
        }
      }, "Plays a tone when it's time to flip")), /* @__PURE__ */ React.createElement("div", {
        onClick: () => {
          const v = !flipSound;
          setFlipSound(v);
          localStorage.setItem("liri_flip_sound", String(v));
        },
        style: {
          width: "40px",
          height: "24px",
          borderRadius: "12px",
          background: flipSound ? "linear-gradient(135deg,#d4a846,#c9807a)" : "rgba(255,255,255,0.1)",
          cursor: "pointer",
          position: "relative",
          transition: "background 0.2s",
          flexShrink: 0
        }
      }, /* @__PURE__ */ React.createElement("div", {
        style: {
          position: "absolute",
          top: "3px",
          left: flipSound ? "19px" : "3px",
          width: "18px",
          height: "18px",
          borderRadius: "50%",
          background: "white",
          transition: "left 0.2s",
          boxShadow: "0 1px 4px rgba(0,0,0,0.3)"
        }
      }))), /* @__PURE__ */ React.createElement("div", {
        style: {
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between"
        }
      }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", {
        style: {
          fontSize: "13px",
          color: "#f0e6d3"
        }
      }, "Push notification"), /* @__PURE__ */ React.createElement("div", {
        style: {
          fontSize: "11px",
          color: "rgba(255,255,255,0.3)",
          marginTop: "2px",
          lineHeight: "1.5"
        }
      }, "Alerts you even when the screen is off")), /* @__PURE__ */ React.createElement("div", {
        onClick: () => {
          if (!flipNotify) {
            enableFlipNotify();
          } else {
            setFlipNotify(false);
            localStorage.setItem("liri_flip_notify", "false");
          }
        },
        style: {
          width: "40px",
          height: "24px",
          borderRadius: "12px",
          background: flipNotify ? "linear-gradient(135deg,#d4a846,#c9807a)" : "rgba(255,255,255,0.1)",
          cursor: "pointer",
          position: "relative",
          transition: "background 0.2s",
          flexShrink: 0
        }
      }, /* @__PURE__ */ React.createElement("div", {
        style: {
          position: "absolute",
          top: "3px",
          left: flipNotify ? "19px" : "3px",
          width: "18px",
          height: "18px",
          borderRadius: "50%",
          background: "white",
          transition: "left 0.2s",
          boxShadow: "0 1px 4px rgba(0,0,0,0.3)"
        }
      }))), notifyDenied && /* @__PURE__ */ React.createElement("div", {
        style: {
          fontSize: "11px",
          color: "#e8a0a8",
          marginTop: "8px",
          lineHeight: "1.5"
        }
      }, "Notifications were blocked. Enable them in your browser settings.")),
      /* @__PURE__ */ React.createElement("div", {
        style: {
          background: "rgba(255,255,255,0.03)",
          border: "1px solid rgba(255,255,255,0.07)",
          borderRadius: "16px",
          padding: "16px 18px",
          marginBottom: "16px"
        }
      }, /* @__PURE__ */ React.createElement("div", {
        onClick: () => {
          window.location.href = window.Capacitor ? "/library.html" : "/library";
        },
        style: {
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          cursor: "pointer"
        }
      }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", {
        style: {
          fontSize: "13px",
          color: "#d4a846"
        }
      }, "My Records"), /* @__PURE__ */ React.createElement("div", {
        style: {
          fontSize: "11px",
          color: "rgba(255,255,255,0.3)",
          marginTop: "2px"
        }
      }, "Your personal vinyl library")), /* @__PURE__ */ React.createElement("div", {
        style: {
          color: "rgba(212,168,70,0.5)",
          fontSize: "18px"
        }
      }, "\u203A"))),
      /* @__PURE__ */ React.createElement("div", {
        style: {
          borderTop: "1px solid rgba(255,255,255,0.07)",
          paddingTop: "20px",
          marginBottom: "20px"
        }
      }, /* @__PURE__ */ React.createElement("div", {
        onClick: () => {
          const next = !keepScreenAwake;
          setKeepScreenAwake(next);
          localStorage.setItem("liri_keep_awake", next ? "true" : "false");
        },
        style: {
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "14px 0",
          cursor: "pointer",
          borderBottom: "1px solid rgba(255,255,255,0.05)",
          marginBottom: "20px"
        }
      }, /* @__PURE__ */ React.createElement("div", {
        style: { display: "flex", alignItems: "center", gap: "12px" }
      }, /* @__PURE__ */ React.createElement("div", {
        style: {
          width: "32px",
          height: "32px",
          borderRadius: "8px",
          background: "rgba(255,255,255,0.06)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center"
        }
      }, /* @__PURE__ */ React.createElement("svg", {
        width: "16",
        height: "16",
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: "2",
        style: { color: "rgba(255,255,255,0.5)" }
      }, /* @__PURE__ */ React.createElement("circle", {
        cx: "12",
        cy: "12",
        r: "4"
      }), /* @__PURE__ */ React.createElement("path", {
        d: "M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"
      }))), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", {
        style: { fontSize: "14px", color: "rgba(255,255,255,0.85)", fontWeight: "500" }
      }, "Keep screen on"), /* @__PURE__ */ React.createElement("div", {
        style: { fontSize: "11px", color: "rgba(255,255,255,0.35)", marginTop: "2px" }
      }, "Prevent display from sleeping"))), /* @__PURE__ */ React.createElement("div", {
        style: {
          width: "44px",
          height: "26px",
          borderRadius: "13px",
          background: keepScreenAwake ? "rgba(212,168,70,0.9)" : "rgba(255,255,255,0.1)",
          position: "relative",
          transition: "background 0.2s"
        }
      }, /* @__PURE__ */ React.createElement("div", {
        style: {
          position: "absolute",
          top: "3px",
          left: keepScreenAwake ? "21px" : "3px",
          width: "20px",
          height: "20px",
          borderRadius: "50%",
          background: "white",
          transition: "left 0.2s"
        }
      }))), /* @__PURE__ */ React.createElement("div", {
        style: {
          fontSize: "11px",
          letterSpacing: "2px",
          color: "rgba(255,255,255,0.2)",
          textTransform: "uppercase",
          marginBottom: "12px"
        }
      }, "Credits"), /* @__PURE__ */ React.createElement("div", {
        style: {
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "8px 16px",
          marginBottom: "14px"
        }
      }, (IS_IOS ? [{
        name: "ShazamKit",
        role: "Song recognition"
      }, {
        name: "LRCLib",
        role: "Synced lyrics"
      }, {
        name: "Discogs",
        role: "Album & track data"
      }] : [{
        name: "LRCLib",
        role: "Synced lyrics"
      }, {
        name: "Discogs",
        role: "Album & track data"
      }]).map((c) => /* @__PURE__ */ React.createElement("div", {
        key: c.name
      }, /* @__PURE__ */ React.createElement("div", {
        style: {
          fontSize: "12px",
          color: "rgba(255,255,255,0.5)",
          fontWeight: "600"
        }
      }, c.name), /* @__PURE__ */ React.createElement("div", {
        style: {
          fontSize: "10px",
          color: "rgba(255,255,255,0.25)",
          marginTop: "1px"
        },
        dangerouslySetInnerHTML: {
          __html: c.role
        }
      })))), /* @__PURE__ */ React.createElement("div", {
        style: {
          fontSize: "11px",
          color: "rgba(255,255,255,0.15)",
          lineHeight: "1.7"
        }
      }, "\xA9 ", (/* @__PURE__ */ new Date()).getFullYear(), " Liri. All rights reserved.", /* @__PURE__ */ React.createElement("br", null), "Music rights belong to their respective artists, labels, and publishers.")),
      !showBugReport ? /* @__PURE__ */ React.createElement("button", {
        onClick: () => setShowBugReport(true),
        style: {
          width: "100%",
          background: "rgba(255,255,255,0.04)",
          border: "1px solid rgba(255,255,255,0.08)",
          color: "rgba(255,255,255,0.4)",
          borderRadius: "14px",
          padding: "14px",
          fontSize: "14px",
          cursor: "pointer",
          fontFamily: "inherit",
          marginBottom: "10px"
        }
      }, /* @__PURE__ */ React.createElement("svg", { width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", style: { marginRight: "6px", verticalAlign: "middle" } }, /* @__PURE__ */ React.createElement("circle", { cx: "12", cy: "12", r: "10" }), /* @__PURE__ */ React.createElement("line", { x1: "12", y1: "8", x2: "12", y2: "12" }), /* @__PURE__ */ React.createElement("line", { x1: "12", y1: "16", x2: "12.01", y2: "16" })), "Report a bug") : /* @__PURE__ */ React.createElement("div", {
        style: {
          background: "rgba(255,255,255,0.04)",
          border: "1px solid rgba(255,255,255,0.1)",
          borderRadius: "16px",
          padding: "16px",
          marginBottom: "10px",
          animation: "fade-up 0.2s ease"
        }
      }, /* @__PURE__ */ React.createElement("div", {
        style: {
          fontSize: "13px",
          fontWeight: "600",
          color: "rgba(255,255,255,0.6)",
          marginBottom: "10px"
        }
      }, "What's going wrong?"), /* @__PURE__ */ React.createElement("textarea", {
        value: bugText,
        onChange: (e) => setBugText(e.target.value),
        placeholder: "Describe the bug \u2014 what happened, what you expected...",
        rows: 4,
        style: {
          width: "100%",
          background: "rgba(255,255,255,0.05)",
          border: "1px solid rgba(255,255,255,0.1)",
          borderRadius: "10px",
          padding: "12px",
          color: "#f0e6d3",
          fontSize: "13px",
          fontFamily: "inherit",
          resize: "none",
          outline: "none",
          lineHeight: "1.5"
        }
      }), /* @__PURE__ */ React.createElement("div", {
        style: {
          display: "flex",
          gap: "8px",
          marginTop: "10px"
        }
      }, /* @__PURE__ */ React.createElement("button", {
        onClick: () => {
          setShowBugReport(false);
          setBugText("");
        },
        style: {
          flex: 1,
          background: "none",
          border: "1px solid rgba(255,255,255,0.08)",
          color: "rgba(255,255,255,0.3)",
          borderRadius: "10px",
          padding: "10px",
          fontSize: "13px",
          cursor: "pointer",
          fontFamily: "inherit"
        }
      }, "Cancel"), /* @__PURE__ */ React.createElement("button", {
        onClick: submitBugReport,
        disabled: bugSending || !bugText.trim(),
        style: {
          flex: 2,
          background: bugSent ? "rgba(100,200,100,0.15)" : "linear-gradient(135deg,#d4a846,#c9807a)",
          border: "none",
          borderRadius: "10px",
          padding: "10px",
          fontSize: "13px",
          fontWeight: "600",
          color: bugSent ? "#6fcf97" : "#080810",
          cursor: "pointer",
          fontFamily: "inherit",
          opacity: !bugText.trim() || bugSending ? 0.5 : 1
        }
      }, bugSent ? "\u2713 Sent!" : bugSending ? "Sending\u2026" : "Send report"))),
      /* @__PURE__ */ React.createElement("button", {
        onClick: () => {
          setShowSettings(false);
          setShowChangePw(true);
          setChangePwError(null);
          setChangePwNew("");
          setChangePwConfirm("");
          setChangePwDone(false);
        },
        style: { width: "100%", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.4)", borderRadius: "14px", padding: "14px", fontSize: "14px", cursor: "pointer", fontFamily: "inherit", marginBottom: "8px" }
      }, "Change Password"),
      /* @__PURE__ */ React.createElement("button", {
        onClick: handleSignOut,
        style: {
          width: "100%",
          background: "rgba(255,255,255,0.04)",
          border: "1px solid rgba(255,255,255,0.08)",
          color: "rgba(255,255,255,0.4)",
          borderRadius: "14px",
          padding: "14px",
          fontSize: "14px",
          cursor: "pointer",
          fontFamily: "inherit"
        }
      }, "Sign Out"),
      IS_IOS && /* @__PURE__ */ React.createElement("button", {
        onClick: restoreApplePurchases,
        disabled: iapWorking,
        style: { width: "100%", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.4)", borderRadius: "14px", padding: "14px", fontSize: "14px", cursor: "pointer", fontFamily: "inherit", marginTop: "8px", opacity: iapWorking ? 0.6 : 1 }
      }, "Restore Purchases"),
      /* @__PURE__ */ React.createElement("button", {
        onClick: () => {
          setShowDeleteAccount(true);
          setDeleteError(null);
        },
        style: {
          width: "100%",
          background: "transparent",
          border: "none",
          color: "rgba(220,80,80,0.5)",
          borderRadius: "14px",
          padding: "10px",
          fontSize: "12px",
          cursor: "pointer",
          fontFamily: "inherit",
          marginTop: "4px"
        }
      }, "Delete Account"),
      /* @__PURE__ */ React.createElement("div", {
        style: {
          textAlign: "center",
          marginTop: "16px",
          fontSize: "11px",
          color: "rgba(255,255,255,0.1)"
        }
      }, "Liri v", APP_VERSION, " \xB7 getliri.com")
    ))), showPremiumInfo && /* @__PURE__ */ React.createElement("div", {
      onClick: () => setShowPremiumInfo(false),
      style: { position: "fixed", inset: 0, zIndex: 400, background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)", display: "flex", alignItems: "flex-end", justifyContent: "center" }
    }, /* @__PURE__ */ React.createElement(
      "div",
      {
        onClick: (e) => e.stopPropagation(),
        style: { background: "#0f0f1c", borderRadius: "24px 24px 0 0", padding: "28px 28px max(40px,calc(env(safe-area-inset-bottom)+28px))", maxWidth: "520px", width: "100%", border: "1px solid rgba(255,255,255,0.07)" }
      },
      /* @__PURE__ */ React.createElement("div", { style: { width: "40px", height: "4px", borderRadius: "2px", background: "rgba(255,255,255,0.12)", margin: "0 auto 24px" } }),
      /* @__PURE__ */ React.createElement(
        "div",
        { style: { display: "flex", alignItems: "center", gap: "10px", marginBottom: "6px" } },
        /* @__PURE__ */ React.createElement("svg", { width: "18", height: "18", viewBox: "0 0 24 24", fill: "#d4a846" }, /* @__PURE__ */ React.createElement("path", { d: "M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z" })),
        /* @__PURE__ */ React.createElement("div", { style: { fontSize: "18px", fontWeight: "700", color: "#f0e6d3" } }, "Liri Premium")
      ),
      /* @__PURE__ */ React.createElement("div", { style: { fontSize: "13px", color: "rgba(255,255,255,0.35)", marginBottom: "24px" } }, userTier === "premium" ? "Your plan includes:" : "Everything in Premium:"),
      /* @__PURE__ */ React.createElement(
        "div",
        { style: { background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: "16px", padding: "4px 0", marginBottom: "24px" } },
        [
          ["Unlimited vinyl library", "Add as many records as you want"],
          ["Lyrics for every track", "Synced line by line as your record plays"],
          ["Play history & stats", "See everything you've listened to"],
          ["Flip reminders", "Sound and notification alerts"],
          ["Cancel anytime", "Manage in iOS Settings \u2192 Subscriptions"]
        ].map(
          ([title, sub], i, arr) => /* @__PURE__ */ React.createElement(
            "div",
            { key: title, style: { display: "flex", alignItems: "center", gap: "14px", padding: "13px 18px", borderBottom: i < arr.length - 1 ? "1px solid rgba(255,255,255,0.04)" : "none" } },
            /* @__PURE__ */ React.createElement("svg", { width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: "#d4a846", strokeWidth: "2.5", strokeLinecap: "round", flexShrink: "0" }, /* @__PURE__ */ React.createElement("path", { d: "M20 6L9 17l-5-5" })),
            /* @__PURE__ */ React.createElement(
              "div",
              null,
              /* @__PURE__ */ React.createElement("div", { style: { fontSize: "13px", color: "#f0e6d3", fontWeight: "500" } }, title),
              /* @__PURE__ */ React.createElement("div", { style: { fontSize: "11px", color: "rgba(255,255,255,0.3)", marginTop: "2px" } }, sub)
            )
          )
        )
      ),
      userTier === "premium" ? IS_IOS && /* @__PURE__ */ React.createElement("button", {
        onClick: () => window.open("https://apps.apple.com/account/subscriptions", "_system"),
        style: { width: "100%", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.4)", borderRadius: "14px", padding: "14px", fontSize: "14px", cursor: "pointer", fontFamily: "inherit", marginBottom: "8px" }
      }, "Manage Subscription") : IS_IOS ? /* @__PURE__ */ React.createElement("button", {
        onClick: upgradeWithApple,
        disabled: iapWorking,
        style: { width: "100%", background: iapWorking ? "rgba(255,255,255,0.05)" : "linear-gradient(135deg,#d4a846,#c9807a)", color: iapWorking ? "rgba(255,255,255,0.3)" : "#080810", border: "none", borderRadius: "14px", padding: "17px", fontSize: "16px", fontWeight: "700", cursor: iapWorking ? "default" : "pointer", fontFamily: "inherit", marginBottom: "12px" }
      }, iapWorking ? "Opening\u2026" : `Get Premium \xB7 ${iapPrice}`) : /* @__PURE__ */ React.createElement("button", {
        onClick: upgradeToStripe,
        disabled: upgradeWorking,
        style: { width: "100%", background: upgradeWorking ? "rgba(255,255,255,0.05)" : "linear-gradient(135deg,#d4a846,#c9807a)", color: upgradeWorking ? "rgba(255,255,255,0.3)" : "#080810", border: "none", borderRadius: "14px", padding: "17px", fontSize: "16px", fontWeight: "700", cursor: upgradeWorking ? "default" : "pointer", fontFamily: "inherit", marginBottom: "12px" }
      }, upgradeWorking ? "Opening checkout\u2026" : "Get Premium \xB7 $2/mo"),
      /* @__PURE__ */ React.createElement(
        "p",
        { style: { fontSize: "11px", color: "rgba(255,255,255,0.25)", textAlign: "center", margin: "12px 0 4px", lineHeight: "1.6" } },
        "By subscribing you agree to the ",
        /* @__PURE__ */ React.createElement("a", { href: "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/", target: "_blank", rel: "noopener", style: { color: "rgba(255,255,255,0.45)", textDecoration: "underline" } }, "Terms of Use"),
        " and ",
        /* @__PURE__ */ React.createElement("a", { href: "https://getliri.com/privacy", target: "_blank", rel: "noopener", style: { color: "rgba(255,255,255,0.45)", textDecoration: "underline" } }, "Privacy Policy"),
        "."
      ),
      /* @__PURE__ */ React.createElement("button", {
        onClick: () => setShowPremiumInfo(false),
        style: { width: "100%", background: "none", border: "none", color: "rgba(255,255,255,0.2)", fontSize: "13px", cursor: "pointer", fontFamily: "inherit", padding: "8px" }
      }, "Close")
    )), showChangePw && /* @__PURE__ */ React.createElement("div", {
      onClick: () => {
        if (!changePwWorking && !changePwDone) setShowChangePw(false);
      },
      style: { position: "fixed", inset: 0, zIndex: 400, background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)", display: "flex", alignItems: "flex-end", justifyContent: "center" }
    }, /* @__PURE__ */ React.createElement(
      "div",
      {
        onClick: (e) => e.stopPropagation(),
        style: { background: "#0f0f1c", borderRadius: "24px 24px 0 0", padding: "28px 28px max(40px,calc(env(safe-area-inset-bottom)+28px))", maxWidth: "520px", width: "100%", border: "1px solid rgba(255,255,255,0.07)" }
      },
      /* @__PURE__ */ React.createElement("div", { style: { width: "40px", height: "4px", borderRadius: "2px", background: "rgba(255,255,255,0.12)", margin: "0 auto 20px" } }),
      /* @__PURE__ */ React.createElement("div", { style: { fontSize: "20px", fontWeight: "700", color: "#f0e6d3", textAlign: "center", marginBottom: "20px" } }, changePwDone ? "Password updated \u2713" : "Change Password"),
      changePwDone ? null : /* @__PURE__ */ React.createElement(
        React.Fragment,
        null,
        /* @__PURE__ */ React.createElement(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "10px", marginBottom: "16px" } },
          /* @__PURE__ */ React.createElement("input", { type: "password", placeholder: "New password (min 8 characters)", value: changePwNew, onChange: (e) => setChangePwNew(e.target.value), onKeyDown: (e) => e.key === "Enter" && handleChangePassword(), autoFocus: true, style: { width: "100%", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "#f0e6d3", padding: "16px 18px", borderRadius: "14px", fontSize: "16px", fontFamily: "inherit" } }),
          /* @__PURE__ */ React.createElement("input", { type: "password", placeholder: "Confirm new password", value: changePwConfirm, onChange: (e) => setChangePwConfirm(e.target.value), onKeyDown: (e) => e.key === "Enter" && handleChangePassword(), style: { width: "100%", background: "rgba(255,255,255,0.05)", border: `1px solid ${changePwConfirm && changePwConfirm !== changePwNew ? "rgba(232,160,168,0.5)" : "rgba(255,255,255,0.1)"}`, color: "#f0e6d3", padding: "16px 18px", borderRadius: "14px", fontSize: "16px", fontFamily: "inherit" } })
        ),
        changePwError && /* @__PURE__ */ React.createElement("div", { style: { fontSize: "13px", color: "#e8a0a8", textAlign: "center", marginBottom: "12px" } }, changePwError),
        /* @__PURE__ */ React.createElement("button", { onClick: handleChangePassword, disabled: changePwWorking, style: { width: "100%", background: "linear-gradient(135deg,#d4a846,#c9807a)", color: "#080810", border: "none", borderRadius: "14px", padding: "18px", fontSize: "15px", fontWeight: "700", cursor: changePwWorking ? "wait" : "pointer", opacity: changePwWorking ? 0.6 : 1, fontFamily: "inherit" } }, changePwWorking ? "Updating\u2026" : "Update Password")
      )
    )), showDeleteAccount && /* @__PURE__ */ React.createElement("div", {
      onClick: () => {
        if (!deleteWorking) setShowDeleteAccount(false);
      },
      style: { position: "fixed", inset: 0, zIndex: 300, background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", padding: "24px" }
    }, /* @__PURE__ */ React.createElement("div", {
      onClick: (e) => e.stopPropagation(),
      style: { background: "#0f0f1c", borderRadius: "20px", padding: "28px 24px", maxWidth: "320px", width: "100%", border: "1px solid rgba(220,80,80,0.2)" }
    }, /* @__PURE__ */ React.createElement("div", {
      style: { fontSize: "18px", fontWeight: "700", color: "#fff", marginBottom: "10px" }
    }, "Delete Account?"), /* @__PURE__ */ React.createElement("div", {
      style: { fontSize: "13px", color: "rgba(255,255,255,0.5)", lineHeight: "1.5", marginBottom: "20px" }
    }, "This permanently deletes your account, library, and listening history. This cannot be undone."), deleteError && /* @__PURE__ */ React.createElement("div", {
      style: { fontSize: "12px", color: "#e07070", marginBottom: "14px" }
    }, deleteError), /* @__PURE__ */ React.createElement("div", {
      style: { display: "flex", gap: "10px" }
    }, /* @__PURE__ */ React.createElement("button", {
      onClick: () => setShowDeleteAccount(false),
      disabled: deleteWorking,
      style: { flex: 1, background: "rgba(255,255,255,0.06)", border: "none", borderRadius: "12px", padding: "12px", fontSize: "14px", color: "rgba(255,255,255,0.6)", cursor: "pointer", fontFamily: "inherit" }
    }, "Cancel"), /* @__PURE__ */ React.createElement("button", {
      onClick: handleDeleteAccount,
      disabled: deleteWorking,
      style: { flex: 1, background: "rgba(200,60,60,0.7)", border: "none", borderRadius: "12px", padding: "12px", fontSize: "14px", fontWeight: "600", color: "#fff", cursor: deleteWorking ? "not-allowed" : "pointer", fontFamily: "inherit", opacity: deleteWorking ? 0.6 : 1 }
    }, deleteWorking ? "Deleting\u2026" : "Delete")))), showHistory && /* @__PURE__ */ React.createElement("div", {
      onClick: () => setShowHistory(false),
      style: {
        position: "fixed",
        inset: 0,
        zIndex: 200,
        background: "rgba(0,0,0,0.5)",
        backdropFilter: "blur(4px)"
      }
    }, /* @__PURE__ */ React.createElement("div", {
      onClick: (e) => e.stopPropagation(),
      style: {
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        background: "#0f0f1c",
        borderRadius: "24px 24px 0 0",
        maxHeight: "80vh",
        display: "flex",
        flexDirection: "column",
        boxShadow: "0 -8px 48px rgba(0,0,0,0.6)",
        animation: "slide-up 0.3s ease"
      }
    }, /* @__PURE__ */ React.createElement("div", {
      style: {
        padding: "12px 24px 0",
        flexShrink: 0
      }
    }, /* @__PURE__ */ React.createElement("div", {
      style: {
        width: "40px",
        height: "4px",
        borderRadius: "2px",
        background: "rgba(255,255,255,0.12)",
        margin: "0 auto 20px"
      }
    }), /* @__PURE__ */ React.createElement("div", {
      style: {
        fontSize: "11px",
        letterSpacing: "3px",
        color: "#d4a846",
        textTransform: "uppercase",
        marginBottom: "16px"
      }
    }, "Recently Played")), /* @__PURE__ */ React.createElement("div", {
      style: {
        overflowY: "auto",
        flex: 1,
        padding: "0 24px max(24px, calc(env(safe-area-inset-bottom) + 16px))"
      }
    }, historyLoading ? /* @__PURE__ */ React.createElement("div", {
      style: {
        textAlign: "center",
        color: "rgba(255,255,255,0.2)",
        padding: "32px 0"
      }
    }, "Loading\u2026") : history.length === 0 ? /* @__PURE__ */ React.createElement("div", {
      style: {
        textAlign: "center",
        color: "rgba(255,255,255,0.2)",
        padding: "32px 0",
        lineHeight: "1.8"
      }
    }, "No songs yet.", /* @__PURE__ */ React.createElement("br", null), "Start listening to build your history.") : history.map((item, i) => /* @__PURE__ */ React.createElement("div", {
      key: item.id,
      style: {
        display: "flex",
        alignItems: "center",
        gap: "12px",
        padding: "10px 0",
        borderBottom: i < history.length - 1 ? "1px solid rgba(255,255,255,0.05)" : "none"
      }
    }, item.artwork_url ? /* @__PURE__ */ React.createElement("img", {
      src: item.artwork_url,
      alt: "",
      style: {
        width: "44px",
        height: "44px",
        borderRadius: "8px",
        flexShrink: 0,
        objectFit: "cover"
      }
    }) : /* @__PURE__ */ React.createElement("div", {
      style: {
        width: "44px",
        height: "44px",
        borderRadius: "8px",
        background: "rgba(255,255,255,0.06)",
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: "18px"
      }
    }, /* @__PURE__ */ React.createElement("svg", { width: "1em", height: "1em", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round" }, /* @__PURE__ */ React.createElement("path", { d: "M9 18V5l12-2v13" }), /* @__PURE__ */ React.createElement("circle", { cx: "6", cy: "18", r: "3" }), /* @__PURE__ */ React.createElement("circle", { cx: "18", cy: "16", r: "3" }))), /* @__PURE__ */ React.createElement("div", {
      style: {
        flex: 1,
        minWidth: 0
      }
    }, /* @__PURE__ */ React.createElement("div", {
      style: {
        fontSize: "14px",
        fontWeight: "600",
        color: "#f0e6d3",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap"
      }
    }, item.title), /* @__PURE__ */ React.createElement("div", {
      style: {
        fontSize: "12px",
        color: "rgba(255,255,255,0.4)",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap"
      }
    }, item.artist)), /* @__PURE__ */ React.createElement("div", {
      style: {
        fontSize: "11px",
        color: "rgba(255,255,255,0.2)",
        flexShrink: 0
      }
    }, timeAgo(item.listened_at))))))), isSyncing && /* @__PURE__ */ React.createElement("div", {
      style: {
        position: "fixed",
        inset: 0,
        zIndex: 10,
        display: "flex",
        flexDirection: "column"
      },
      onPointerMove: isLandscape ? bumpControls : void 0,
      onTouchStart: isLandscape ? bumpControls : void 0
    }, kbToast && /* @__PURE__ */ React.createElement("div", {
      style: {
        position: "fixed",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        background: "rgba(20,20,30,0.92)",
        border: "1px solid rgba(255,255,255,0.12)",
        borderRadius: "16px",
        padding: "12px 24px",
        fontSize: "16px",
        fontWeight: "600",
        color: "#f0e6d3",
        zIndex: 100,
        pointerEvents: "none",
        animation: "fade-up 0.12s ease",
        backdropFilter: "blur(8px)"
      }
    }, kbToast), isLandscape && /* @__PURE__ */ React.createElement(
      "div",
      {
        style: {
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          height: "52px",
          display: "flex",
          alignItems: "center",
          padding: "0 16px",
          gap: "10px",
          background: "rgba(8,8,16,0.92)",
          backdropFilter: "blur(12px)",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
          zIndex: 20
        }
      },
      /* @__PURE__ */ React.createElement("button", {
        onClick: reset,
        style: { background: "none", border: "none", color: "rgba(255,255,255,0.45)", fontSize: "18px", cursor: "pointer", padding: "4px 8px 4px 0", lineHeight: 1, flexShrink: 0 }
      }, "\u2190"),
      artwork && /* @__PURE__ */ React.createElement("img", {
        src: artwork,
        alt: "",
        style: { width: "32px", height: "32px", borderRadius: "6px", flexShrink: 0, boxShadow: "0 2px 8px rgba(0,0,0,0.5)" }
      }),
      /* @__PURE__ */ React.createElement(
        "div",
        { style: { flex: 1, minWidth: 0 } },
        /* @__PURE__ */ React.createElement("div", { style: { fontSize: "13px", fontWeight: "600", color: "#f0e6d3", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, detectedSong?.title),
        /* @__PURE__ */ React.createElement("div", { style: { fontSize: "11px", color: "rgba(255,255,255,0.35)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, detectedSong?.artist)
      ),
      (() => {
        const si = getSideInfo();
        return si ? /* @__PURE__ */ React.createElement("div", { style: { fontSize: "10px", fontWeight: "700", letterSpacing: "2px", color: "rgba(212,168,70,0.85)", textTransform: "uppercase", flexShrink: 0 } }, si.side ? `Side ${si.side} \xB7 ${si.track}` : `Track ${si.track}`) : null;
      })(),
      /* @__PURE__ */ React.createElement("button", {
        onClick: () => setShowSettings(!showSettings),
        style: { background: "linear-gradient(135deg,#d4a846,#c9807a)", border: "none", borderRadius: "50%", width: "28px", height: "28px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "11px", fontWeight: "700", color: "#080810", cursor: "pointer", flexShrink: 0, padding: 0 }
      }, user?.email?.[0]?.toUpperCase() || "?")
    ), /* @__PURE__ */ React.createElement("div", {
      className: "safe-top",
      style: isLandscape ? {
        padding: "16px 20px 16px",
        display: "flex",
        flexDirection: "column",
        width: "270px",
        flexShrink: 0,
        position: "fixed",
        top: "57px",
        left: 0,
        bottom: "130px",
        background: "rgba(8,8,16,0.97)",
        borderRight: "1px solid rgba(255,255,255,0.06)",
        overflowY: "auto",
        zIndex: 15,
        opacity: controlsVisible ? 1 : 0,
        transition: "opacity 0.35s",
        pointerEvents: controlsVisible ? "auto" : "none"
      } : {
        padding: "0 20px 16px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        flexShrink: 0
      }
    }, /* @__PURE__ */ React.createElement("div", {
      style: {
        display: "flex",
        alignItems: "center",
        gap: "10px",
        flex: 1,
        minWidth: 0
      }
    }, /* @__PURE__ */ React.createElement("button", {
      onClick: reset,
      style: {
        background: "none",
        border: "none",
        color: "rgba(255,255,255,0.45)",
        fontSize: "20px",
        cursor: "pointer",
        padding: "4px 8px 4px 0",
        lineHeight: 1,
        flexShrink: 0
      },
      title: "Home"
    }, "\u2190"), artwork && /* @__PURE__ */ React.createElement("img", {
      src: artwork,
      alt: "",
      style: {
        width: "36px",
        height: "36px",
        borderRadius: "8px",
        flexShrink: 0,
        boxShadow: "0 4px 16px rgba(0,0,0,0.5)"
      }
    }), /* @__PURE__ */ React.createElement("div", {
      style: {
        minWidth: 0
      }
    }, /* @__PURE__ */ React.createElement("div", {
      style: {
        fontSize: "14px",
        fontWeight: "600",
        color: "#f0e6d3",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap"
      }
    }, detectedSong?.title), /* @__PURE__ */ React.createElement("div", {
      style: {
        fontSize: "12px",
        color: "rgba(255,255,255,0.4)",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap"
      }
    }, detectedSong?.artist), (() => {
      const si = getSideInfo();
      return si ? /* @__PURE__ */ React.createElement("div", {
        style: {
          marginTop: "4px",
          fontSize: "11px",
          fontWeight: "700",
          letterSpacing: "2px",
          color: "rgba(212,168,70,0.85)",
          textTransform: "uppercase"
        }
      }, si.side ? `Side ${si.side}  \xB7  Track ${si.track}` : `Track ${si.track}`) : null;
    })())), /* @__PURE__ */ React.createElement("div", {
      style: {
        display: "flex",
        alignItems: "center",
        gap: "12px",
        marginLeft: "12px",
        flexShrink: 0
      }
    }, songDuration && /* @__PURE__ */ React.createElement("div", {
      style: {
        fontSize: "11px",
        color: "rgba(255,255,255,0.2)"
      }
    }, formatTime(playbackTime), " / ", formatTime(songDuration)), !songDuration && /* @__PURE__ */ React.createElement("div", {
      style: {
        fontSize: "12px",
        color: "rgba(255,255,255,0.3)",
        fontVariantNumeric: "tabular-nums"
      }
    }, formatTime(playbackTime)), /* @__PURE__ */ React.createElement("button", {
      onClick: () => setShowSettings(!showSettings),
      style: {
        background: "linear-gradient(135deg, #d4a846, #c9807a)",
        border: "none",
        borderRadius: "50%",
        width: "30px",
        height: "30px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: "12px",
        fontWeight: "700",
        color: "#080810",
        cursor: "pointer",
        flexShrink: 0,
        padding: 0,
        boxShadow: "0 2px 8px rgba(212,168,70,0.35)"
      },
      title: "Account"
    }, user?.email?.[0]?.toUpperCase() || "?"))), /* @__PURE__ */ React.createElement("div", {
      style: isLandscape ? {
        height: "5px",
        background: "rgba(255,255,255,0.1)",
        cursor: "pointer",
        position: "fixed",
        top: "52px",
        left: 0,
        right: 0,
        zIndex: 19
      } : {
        height: "3px",
        background: "rgba(255,255,255,0.1)",
        flexShrink: 0,
        cursor: songDuration ? "pointer" : "default",
        position: "relative",
        display: "block"
      },
      onClick: (e) => {
        if (!songDuration) return;
        const r = e.currentTarget.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
        const targetTime = ratio * songDuration;
        initialPosRef.current = targetTime;
        syncStartRef.current = Date.now();
        setPlaybackTime(targetTime);
      }
    }, (() => {
      const effDur = songDuration ?? (lyrics.length > 0 ? lyrics[lyrics.length - 1].time + 30 : null);
      return effDur ? /* @__PURE__ */ React.createElement("div", {
        style: {
          height: "100%",
          background: "linear-gradient(to right, #d4a846, #c9807a)",
          width: `${Math.min(playbackTime / effDur * 100, 100)}%`,
          transition: "width 1s linear",
          borderRadius: "0 2px 2px 0"
        }
      }) : null;
    })()), /* @__PURE__ */ React.createElement("div", {
      style: {
        flex: 1,
        overflow: "hidden",
        position: "relative",
        paddingTop: isLandscape ? "57px" : 0
      }
    }, isResyncing && /* @__PURE__ */ React.createElement("div", {
      style: {
        position: "absolute",
        inset: 0,
        zIndex: 20,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(8,8,16,0.82)",
        backdropFilter: "blur(8px)",
        animation: "fade-up 0.2s ease both"
      }
    }, /* @__PURE__ */ React.createElement("div", {
      style: {
        position: "relative",
        width: "100px",
        height: "100px",
        marginBottom: "20px"
      }
    }, /* @__PURE__ */ React.createElement("div", {
      style: {
        position: "absolute",
        inset: 0
      }
    }, /* @__PURE__ */ React.createElement(ProgressRing, {
      size: 100
    })), /* @__PURE__ */ React.createElement("div", {
      style: {
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center"
      }
    }, /* @__PURE__ */ React.createElement(WaveAnimation, {
      active: true,
      analyserRef: analyserNodeRef,
      level: audioLevel,
      size: 0.85
    }))), /* @__PURE__ */ React.createElement("div", {
      style: {
        fontSize: "16px",
        fontWeight: "600",
        color: "rgba(255,255,255,0.7)"
      }
    }, "Resyncing\u2026")), /* @__PURE__ */ React.createElement("div", {
      style: {
        overflowY: "auto",
        height: "100%",
        padding: isLandscape ? "4vh 40px 0" : "8vh 28px 0",
        maxWidth: isLandscape ? "760px" : "none",
        marginLeft: isLandscape ? "auto" : void 0,
        marginRight: isLandscape ? "auto" : void 0
      },
      onTouchStart: () => {
        userScrollingRef.current = true;
        setUserScrolling(true);
      },
      onWheel: () => {
        userScrollingRef.current = true;
        setUserScrolling(true);
      }
    }, lyrics.length > 0 ? /* @__PURE__ */ React.createElement(React.Fragment, null, (() => {
      const curLine = lyrics[currentIndex];
      const nextLine = lyrics[currentIndex + 1];
      const lineDur = curLine && nextLine ? nextLine.time - curLine.time : 3;
      const transSec = Math.min(0.4, Math.max(0.1, lineDur * 0.35)).toFixed(2);
      const transition = `all ${transSec}s cubic-bezier(0.4,0,0.2,1)`;
      const lastLyricTime = lyrics.length > 0 ? lyrics[lyrics.length - 1].time : 0;
      const creditLines = [
        ...detectedSong?.title ? [{ text: detectedSong.title, time: lastLyricTime + 5, isCredit: true }] : [],
        ...detectedSong?.artist ? [{ text: detectedSong.artist, time: lastLyricTime + 8, isCredit: true }] : [],
        ...detectedSong?.album ? [{ text: detectedSong.album, time: lastLyricTime + 11, isCredit: true }] : [],
        { text: "Lyrics via LRCLib", time: lastLyricTime + 16, isCredit: true },
        { text: `\xA9 ${(/* @__PURE__ */ new Date()).getFullYear()} Liri \xB7 Music rights belong to their respective artists, labels & publishers.`, time: lastLyricTime + 20, isCredit: true }
      ];
      const allLines = [...lyrics, ...creditLines];
      const pastLastLyric = currentIndex >= lyrics.length - 1 && lyrics.length > 0;
      const effectiveIndex = pastLastLyric ? lyrics.length - 1 + creditLines.reduce((best, cl, ci) => playbackTime >= cl.time ? ci + 1 : best, 0) : currentIndex;
      return allLines.map((line, i) => {
        const dist = i - effectiveIndex;
        const cur = dist === 0;
        const near = Math.abs(dist) <= 3;
        const isCredit = !!line.isCredit;
        return /* @__PURE__ */ React.createElement("div", {
          key: i,
          ref: cur ? currentLineRef : i === lyrics.length ? creditsRef : null,
          onClick: () => cur ? refollow() : !isCredit && seekToLine(i),
          style: {
            textAlign: "center",
            padding: near ? "6px 0" : "3px 0",
            fontSize: isCredit ? cur ? "15px" : Math.abs(dist) <= 1 ? "13px" : "11px" : cur ? isLandscape ? "36px" : "32px" : Math.abs(dist) <= 1 ? isLandscape ? "24px" : "20px" : near ? isLandscape ? "20px" : "16px" : isLandscape ? "16px" : "13px",
            fontWeight: cur && !isCredit ? "700" : "400",
            color: cur ? isCredit ? "rgba(255,255,255,0.55)" : "#ffffff" : dist > 0 ? `rgba(255,255,255,${Math.max(isLandscape ? 0.18 : 0.07, (isLandscape ? 0.55 : 0.28) - Math.abs(dist) * (isLandscape ? 0.06 : 0.04))})` : `rgba(255,255,255,${Math.max(isLandscape ? 0.12 : 0.05, (isLandscape ? 0.35 : 0.18) - Math.abs(dist) * (isLandscape ? 0.04 : 0.02))})`,
            lineHeight: "1.4",
            transition: near ? transition : "none",
            textShadow: cur && !isCredit ? "0 0 60px rgba(212,168,70,0.4), 0 2px 20px rgba(0,0,0,0.8)" : "none",
            cursor: isCredit ? "default" : "pointer",
            letterSpacing: isCredit ? "0.2px" : "normal",
            maxWidth: isCredit ? "260px" : "none",
            margin: isCredit ? "0 auto" : "0"
          }
        }, line.text);
      });
    })(), /* @__PURE__ */ React.createElement("div", { style: { paddingBottom: "30vh" } })) : /* @__PURE__ */ React.createElement("div", {
      style: {
        textAlign: "center",
        color: "rgba(255,255,255,0.2)",
        fontSize: "16px",
        paddingTop: "30vh"
      }
    }, "No lyrics found for this track")), /* @__PURE__ */ React.createElement("div", {
      style: {
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        height: "15vh",
        background: "linear-gradient(to bottom, rgba(8,8,16,0.9), transparent)",
        pointerEvents: "none"
      }
    }), /* @__PURE__ */ React.createElement("div", {
      style: {
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        height: "20vh",
        background: "linear-gradient(to top, rgba(8,8,16,1), transparent)",
        pointerEvents: "none"
      }
    })), /* @__PURE__ */ React.createElement("div", {
      className: "safe-bottom",
      style: isLandscape ? {
        padding: "12px 20px max(12px, calc(env(safe-area-inset-bottom) + 8px))",
        position: "fixed",
        left: 0,
        bottom: 0,
        width: "270px",
        background: "rgba(8,8,16,0.97)",
        borderRight: "1px solid rgba(255,255,255,0.06)",
        borderTop: "1px solid rgba(255,255,255,0.05)",
        zIndex: 15,
        opacity: controlsVisible ? 1 : 0,
        transition: "opacity 0.35s",
        pointerEvents: controlsVisible ? "auto" : "none"
      } : {
        padding: "12px 20px 0",
        flexShrink: 0
      }
    }, /* @__PURE__ */ React.createElement("div", {
      style: {
        textAlign: "center",
        fontSize: "10px",
        letterSpacing: "2px",
        textTransform: "uppercase",
        marginBottom: "8px",
        color: isResyncing ? "#d4a846" : "rgba(255,255,255,0.18)",
        animation: isResyncing ? "pulse 1.2s ease-in-out infinite" : "none"
      }
    }, isResyncing ? "\u21BB listening for resync\u2026" : "\u2190 early \xB7 behind \u2192"), /* @__PURE__ */ React.createElement("div", {
      style: {
        display: "flex",
        justifyContent: "center",
        flexWrap: "wrap",
        gap: "6px",
        marginBottom: "10px"
      }
    }, /* @__PURE__ */ React.createElement("div", {
      style: {
        position: "relative"
      },
      onPointerEnter: () => setHoverNudge("left"),
      onPointerLeave: () => setHoverNudge(null)
    }, /* @__PURE__ */ React.createElement("button", {
      onClick: () => handleNudge(-1),
      style: {
        background: "rgba(255,255,255,0.07)",
        border: "1px solid rgba(255,255,255,0.15)",
        color: "rgba(255,255,255,0.7)",
        padding: isLandscape ? "7px 28px" : "9px 22px",
        borderRadius: "20px",
        cursor: "pointer",
        fontSize: isLandscape ? "13px" : "14px",
        fontFamily: "inherit",
        fontWeight: "600"
      }
    }, "\u22121s"), hoverNudge === "left" && /* @__PURE__ */ React.createElement("button", {
      onClick: () => handleNudge(-0.5),
      style: {
        position: "absolute",
        top: "calc(100% + 6px)",
        left: "50%",
        transform: "translateX(-50%)",
        whiteSpace: "nowrap",
        zIndex: 50,
        background: "rgba(20,20,30,0.95)",
        border: "1px solid rgba(255,255,255,0.12)",
        color: "rgba(255,255,255,0.5)",
        padding: "6px 16px",
        borderRadius: "16px",
        cursor: "pointer",
        fontSize: "11px",
        fontFamily: "inherit",
        animation: "fade-up 0.12s ease",
        boxShadow: "0 4px 16px rgba(0,0,0,0.5)"
      }
    }, "\u22120.5s")), /* @__PURE__ */ React.createElement("div", {
      style: {
        position: "relative"
      },
      onPointerEnter: () => setHoverNudge("right"),
      onPointerLeave: () => setHoverNudge(null)
    }, /* @__PURE__ */ React.createElement("button", {
      onClick: () => handleNudge(1),
      style: {
        background: "rgba(255,255,255,0.07)",
        border: "1px solid rgba(255,255,255,0.15)",
        color: "rgba(255,255,255,0.7)",
        padding: isLandscape ? "7px 28px" : "9px 22px",
        borderRadius: "20px",
        cursor: "pointer",
        fontSize: isLandscape ? "13px" : "14px",
        fontFamily: "inherit",
        fontWeight: "600"
      }
    }, "+1s"), hoverNudge === "right" && /* @__PURE__ */ React.createElement("button", {
      onClick: () => handleNudge(0.5),
      style: {
        position: "absolute",
        top: "calc(100% + 6px)",
        left: "50%",
        transform: "translateX(-50%)",
        whiteSpace: "nowrap",
        zIndex: 50,
        background: "rgba(20,20,30,0.95)",
        border: "1px solid rgba(255,255,255,0.12)",
        color: "rgba(255,255,255,0.5)",
        padding: "6px 16px",
        borderRadius: "16px",
        cursor: "pointer",
        fontSize: "11px",
        fontFamily: "inherit",
        animation: "fade-up 0.12s ease",
        boxShadow: "0 4px 16px rgba(0,0,0,0.5)"
      }
    }, "+0.5s"))), /* @__PURE__ */ React.createElement("div", {
      style: {
        display: "flex",
        justifyContent: "center",
        flexWrap: "wrap",
        gap: "6px",
        marginBottom: "8px"
      }
    }, userScrolling && /* @__PURE__ */ React.createElement("button", {
      onClick: refollow,
      style: {
        background: "rgba(212,168,70,0.12)",
        border: "1px solid rgba(212,168,70,0.3)",
        color: "rgba(212,168,70,0.8)",
        borderRadius: "50px",
        padding: isLandscape ? "7px 14px" : "10px 22px",
        fontSize: isLandscape ? "12px" : "13px",
        fontWeight: "500",
        cursor: "pointer",
        fontFamily: "inherit"
      }
    }, "\u2193 Follow"), /* @__PURE__ */ React.createElement("button", {
      onClick: togglePause,
      style: {
        background: isPaused ? "rgba(212,168,70,0.15)" : "rgba(255,255,255,0.07)",
        border: isPaused ? "1px solid rgba(212,168,70,0.4)" : "1px solid rgba(255,255,255,0.15)",
        color: isPaused ? "rgba(212,168,70,0.9)" : "rgba(255,255,255,0.55)",
        borderRadius: "50px",
        padding: isLandscape ? "7px 14px" : "10px 22px",
        fontSize: isLandscape ? "12px" : "13px",
        fontWeight: "500",
        cursor: "pointer",
        fontFamily: "inherit"
      }
    }, isPaused ? "\u25B6 Resume" : "|| Pause"), IS_IOS && /* @__PURE__ */ React.createElement("button", {
      onClick: () => {
        logButtonEvent("resync");
        resync();
      },
      disabled: isResyncing,
      style: {
        background: "rgba(255,255,255,0.07)",
        border: "1px solid rgba(255,255,255,0.15)",
        color: "rgba(255,255,255,0.55)",
        borderRadius: "50px",
        padding: isLandscape ? "7px 14px" : "10px 22px",
        fontSize: isLandscape ? "12px" : "13px",
        fontWeight: "500",
        cursor: isResyncing ? "wait" : "pointer",
        fontFamily: "inherit",
        opacity: isResyncing ? 0.4 : 1
      }
    }, "\u21BB Resync"), /* @__PURE__ */ React.createElement("button", {
      onClick: () => {
        logButtonEvent("wrong_song");
        reset();
        setTimeout(() => startListening(false), 150);
      },
      style: {
        background: "rgba(255,255,255,0.04)",
        border: "1px solid rgba(255,255,255,0.09)",
        color: "rgba(255,255,255,0.35)",
        borderRadius: "50px",
        padding: isLandscape ? "7px 14px" : "10px 22px",
        fontSize: isLandscape ? "12px" : "13px",
        cursor: "pointer",
        fontFamily: "inherit"
      }
    }, "Wrong song?")), (() => {
      const hasTT = turntableAlbum && turntableTracksRef.current.length > 0 && turntableMatchedIdxRef.current >= 0;
      const isTT = !vinylMode && hasTT;
      const isVM = vinylMode && (hasTT || albumTracks.length > 0) && currentTrackIndex >= 0;
      if (!isTT && !isVM) return null;
      const tIdx = hasTT ? turntableMatchedIdxRef.current : currentTrackIndex;
      const tTracks = hasTT ? turntableTracksRef.current : albumTracks;
      const atStart = tIdx <= 0;
      const atEnd = tIdx >= tTracks.length - 1;
      const nextTrackName = !atEnd ? tTracks[tIdx + 1]?.trackName || tTracks[tIdx + 1]?.title || null : null;
      const goPrev = () => hasTT ? advanceToNextTrack(turntableTracksRef.current, tIdx - 2) : jumpToTrack(Math.max(0, currentTrackIndex - 1));
      const goNext = () => hasTT ? advanceToNextTrack(turntableTracksRef.current, tIdx) : advanceToNextTrack(albumTracksRef.current, currentTrackIndexRef.current);
      return /* @__PURE__ */ React.createElement("div", {
        style: {
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: "8px",
          marginTop: "6px",
          marginBottom: "2px"
        }
      }, /* @__PURE__ */ React.createElement("button", {
        onClick: goPrev,
        disabled: atStart,
        style: {
          background: "none",
          border: "none",
          color: atStart ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.3)",
          cursor: atStart ? "default" : "pointer",
          fontSize: "12px",
          padding: "2px 6px",
          flexShrink: 0
        }
      }, "\u2190"), /* @__PURE__ */ React.createElement("div", {
        style: {
          textAlign: "center",
          maxWidth: "160px"
        }
      }, nextTrackName ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", {
        style: {
          fontSize: "8px",
          color: "rgba(255,255,255,0.15)",
          letterSpacing: "1px",
          textTransform: "uppercase",
          marginBottom: "1px"
        }
      }, "Next song"), /* @__PURE__ */ React.createElement("div", {
        style: {
          fontSize: "10px",
          color: "rgba(255,255,255,0.25)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap"
        }
      }, nextTrackName)) : /* @__PURE__ */ React.createElement("div", {
        style: {
          fontSize: "9px",
          color: "rgba(255,255,255,0.12)",
          letterSpacing: "0.5px"
        }
      }, "Last track")), /* @__PURE__ */ React.createElement("button", {
        onClick: goNext,
        disabled: atEnd,
        style: {
          background: "none",
          border: "none",
          color: atEnd ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.3)",
          cursor: atEnd ? "default" : "pointer",
          fontSize: "12px",
          padding: "2px 6px",
          flexShrink: 0
        }
      }, "\u2192"));
    })(), /* @__PURE__ */ React.createElement("div", {
      style: {
        textAlign: "center",
        marginTop: "6px",
        fontSize: "9px",
        color: "rgba(255,255,255,0.1)",
        letterSpacing: "1px"
      }
    }, "v", APP_VERSION))), !isSyncing && /* @__PURE__ */ React.createElement("div", {
      style: {
        position: "relative",
        zIndex: 10,
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column"
      }
    }, /* @__PURE__ */ React.createElement("div", {
      className: "safe-top",
      style: {
        padding: "0 20px 16px",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        flexShrink: 0
      }
    }, /* @__PURE__ */ React.createElement("button", {
      onClick: reset,
      style: {
        background: "none",
        border: "none",
        padding: 0,
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: "1px",
        fontFamily: "inherit"
      }
    }, /* @__PURE__ */ React.createElement("div", {
      style: {
        fontSize: "9px",
        letterSpacing: "1px",
        color: "rgba(255,255,255,0.15)",
        fontWeight: "400"
      }
    }, "v", APP_VERSION), /* @__PURE__ */ React.createElement("div", {
      style: {
        fontSize: "16px",
        letterSpacing: "10px",
        color: "#d4a846",
        fontWeight: "300"
      }
    }, "LIRI")), /* @__PURE__ */ React.createElement("div", {
      style: {
        display: "flex",
        gap: "12px",
        alignItems: "center"
      }
    }, /* @__PURE__ */ React.createElement("button", {
      onClick: () => {
        fetchHistory(user);
        setShowHistory(true);
      },
      style: {
        background: "none",
        border: "none",
        color: "rgba(255,255,255,0.35)",
        cursor: "pointer",
        fontSize: "18px",
        padding: "10px",
        lineHeight: 1
      },
      title: "History"
    }, /* @__PURE__ */ React.createElement("svg", { width: "1em", height: "1em", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round" }, /* @__PURE__ */ React.createElement("circle", { cx: "12", cy: "12", r: "10" }), /* @__PURE__ */ React.createElement("polyline", { points: "12 6 12 12 16 14" }))), /* @__PURE__ */ React.createElement("button", {
      onClick: () => setShowSettings(true),
      style: {
        background: "linear-gradient(135deg, #d4a846, #c9807a)",
        border: "none",
        borderRadius: "50%",
        width: "32px",
        height: "32px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: "13px",
        fontWeight: "700",
        color: "#080810",
        cursor: "pointer",
        flexShrink: 0,
        boxShadow: "0 2px 8px rgba(212,168,70,0.35)",
        padding: 0
      },
      title: "Account"
    }, user?.email?.[0]?.toUpperCase() || "?"))), /* @__PURE__ */ React.createElement("div", {
      style: {
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px 32px",
        textAlign: "center"
      }
    }, mode === "idle" && /* @__PURE__ */ React.createElement("div", {
      style: {
        animation: "fade-up 0.5s ease both",
        width: "100%",
        maxWidth: isLandscape ? "560px" : "320px"
      }
    }, /* @__PURE__ */ React.createElement(Vinyl, {
      size: 130,
      spinning: false
    }), lastSong && /* @__PURE__ */ React.createElement("div", {
      style: {
        marginBottom: "20px",
        padding: "10px 14px",
        background: "rgba(255,255,255,0.03)",
        border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: "14px",
        textAlign: "left"
      }
    }, /* @__PURE__ */ React.createElement("div", {
      style: {
        fontSize: "10px",
        letterSpacing: "2px",
        textTransform: "uppercase",
        color: "rgba(255,255,255,0.2)",
        marginBottom: "6px"
      }
    }, "Last played"), /* @__PURE__ */ React.createElement("div", {
      style: {
        fontSize: "14px",
        fontWeight: "600",
        color: "rgba(255,255,255,0.7)",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap"
      }
    }, lastSong.title), /* @__PURE__ */ React.createElement("div", {
      style: {
        fontSize: "12px",
        color: "rgba(255,255,255,0.3)",
        marginTop: "2px"
      }
    }, lastSong.artist)), /* @__PURE__ */ React.createElement("div", {
      style: {
        marginTop: "32px",
        marginBottom: "24px"
      }
    }, turntableAlbum ? (
      // Album selected — whole card is tappable to change
      /* @__PURE__ */ React.createElement("button", {
        onClick: () => {
          fetchUserLibrary(user.id);
          setShowAlbumPicker(true);
        },
        style: {
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: "12px",
          background: "rgba(255,255,255,0.04)",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: "16px",
          padding: "12px 14px",
          cursor: "pointer",
          fontFamily: "inherit",
          textAlign: "left"
        }
      }, turntableAlbum.artwork_url ? /* @__PURE__ */ React.createElement("img", {
        src: turntableAlbum.artwork_url,
        alt: "",
        style: {
          width: 48,
          height: 48,
          borderRadius: 8,
          objectFit: "cover",
          flexShrink: 0
        }
      }) : /* @__PURE__ */ React.createElement("div", {
        style: {
          width: 48,
          height: 48,
          borderRadius: 8,
          background: "rgba(255,255,255,0.05)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 22,
          flexShrink: 0
        }
      }, /* @__PURE__ */ React.createElement("svg", { width: "1em", height: "1em", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round" }, /* @__PURE__ */ React.createElement("circle", { cx: "12", cy: "12", r: "10" }), /* @__PURE__ */ React.createElement("circle", { cx: "12", cy: "12", r: "3" }))), /* @__PURE__ */ React.createElement("div", {
        style: {
          flex: 1,
          minWidth: 0,
          textAlign: "left"
        }
      }, /* @__PURE__ */ React.createElement("div", {
        style: {
          fontSize: "13px",
          fontWeight: 600,
          color: "#f0e6d3",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap"
        }
      }, turntableAlbum.album_name), /* @__PURE__ */ React.createElement("div", {
        style: {
          fontSize: "11px",
          color: "rgba(255,255,255,0.4)",
          marginTop: 2,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap"
        }
      }, turntableAlbum.artist_name)), turntableTracksLoading ? /* @__PURE__ */ React.createElement("div", {
        style: {
          width: 14,
          height: 14,
          borderRadius: "50%",
          border: "2px solid rgba(255,255,255,0.1)",
          borderTopColor: "#d4a846",
          animation: "spin 0.8s linear infinite",
          flexShrink: 0
        }
      }) : /* @__PURE__ */ React.createElement("span", {
        style: {
          fontSize: "11px",
          color: "rgba(255,255,255,0.3)",
          flexShrink: 0
        }
      }, "change"))
    ) : (
      // No album selected — prominent call to action
      /* @__PURE__ */ React.createElement("button", {
        onClick: () => {
          fetchUserLibrary(user.id);
          setShowAlbumPicker(true);
        },
        style: {
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: "12px",
          background: "rgba(212,168,70,0.06)",
          border: "1px solid rgba(212,168,70,0.2)",
          borderRadius: "16px",
          padding: "14px 16px",
          cursor: "pointer",
          fontFamily: "inherit",
          textAlign: "left"
        }
      }, /* @__PURE__ */ React.createElement("div", {
        style: {
          width: 40,
          height: 40,
          borderRadius: 8,
          background: "rgba(212,168,70,0.1)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 20,
          flexShrink: 0
        }
      }, /* @__PURE__ */ React.createElement("svg", { width: "1em", height: "1em", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round" }, /* @__PURE__ */ React.createElement("circle", { cx: "12", cy: "12", r: "10" }), /* @__PURE__ */ React.createElement("circle", { cx: "12", cy: "12", r: "3" }))), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", {
        style: {
          fontSize: "13px",
          fontWeight: 600,
          color: "rgba(212,168,70,0.9)"
        }
      }, "What's on the turntable?"), /* @__PURE__ */ React.createElement("div", {
        style: {
          fontSize: "11px",
          color: "rgba(255,255,255,0.35)",
          marginTop: 2
        }
      }, "Tap to choose a record from your library")))
    )), /* @__PURE__ */ React.createElement("button", {
      onClick: () => !turntableTracksLoading && startListening(false),
      style: {
        background: turntableTracksLoading ? "rgba(255,255,255,0.08)" : "linear-gradient(135deg, #d4a846, #c9807a)",
        color: turntableTracksLoading ? "rgba(255,255,255,0.3)" : "#080810",
        border: "none",
        borderRadius: "50px",
        padding: "18px 52px",
        fontSize: "15px",
        fontWeight: "700",
        letterSpacing: "1px",
        cursor: turntableTracksLoading ? "default" : "pointer",
        fontFamily: "inherit",
        boxShadow: turntableTracksLoading ? "none" : "0 8px 32px rgba(212,168,70,0.3)",
        width: "100%",
        transition: "all 0.2s"
      }
    }, turntableTracksLoading ? "Loading\u2026" : turntableAlbum ? "Find my place" : "Listen"), !turntableTracksLoading && turntableAlbum && currentTrackIndex >= 0 && getNextSideLetter() && /* @__PURE__ */ React.createElement("button", {
      onClick: manualFlipToNextSide,
      style: {
        marginTop: "10px",
        background: "none",
        border: "1px solid rgba(255,255,255,0.12)",
        color: "rgba(255,255,255,0.45)",
        borderRadius: "50px",
        padding: "12px 32px",
        fontSize: "13px",
        fontWeight: "600",
        cursor: "pointer",
        fontFamily: "inherit",
        width: "100%"
      }
    }, (function() {
      var _di = getNextDiscInfo();
      return _di && (_di.isNewDisc ? "Grab LP " + _di.nextDisc : "Flip to Side " + _di.nextSide);
    })())), mode === "listening" && /* @__PURE__ */ React.createElement(
      "div",
      {
        style: {
          animation: "fade-up 0.3s ease both",
          overflowY: showTrackList ? "auto" : "visible",
          maxHeight: showTrackList ? "75vh" : "none",
          width: "100%",
          WebkitOverflowScrolling: "touch"
        }
      },
      !(turntableAlbum && (!window.Capacitor || showTrackList)) && /* @__PURE__ */ React.createElement("div", {
        style: {
          position: "relative",
          width: "120px",
          height: "120px",
          margin: "0 auto 16px"
        }
      }, /* @__PURE__ */ React.createElement("div", {
        style: {
          position: "absolute",
          inset: 0
        }
      }, /* @__PURE__ */ React.createElement(ProgressRing, {
        size: 120
      })), /* @__PURE__ */ React.createElement("div", {
        style: {
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center"
        }
      }, /* @__PURE__ */ React.createElement(WaveAnimation, {
        active: true,
        analyserRef: analyserNodeRef,
        level: audioLevel
      }))),
      !turntableAlbum && listenAttempt <= MAX_ATTEMPTS && /* @__PURE__ */ React.createElement("div", {
        style: {
          marginBottom: "20px",
          fontSize: "11px",
          letterSpacing: "1.5px",
          textTransform: "uppercase",
          color: audioLevel > 0.05 ? "#d4a846" : "#c9807a",
          transition: "color 0.2s ease"
        }
      }, audioLevel > 0.25 ? "\u25CF Loud \u2014 perfect" : audioLevel > 0.05 ? "\u25CF Good signal" : "\u25CF Too quiet \u2014 move closer"),
      /* @__PURE__ */ React.createElement("div", {
        style: {
          fontSize: "22px",
          fontWeight: "600",
          color: "#f0e6d3",
          marginBottom: "10px",
          marginTop: !turntableAlbum && listenAttempt > MAX_ATTEMPTS ? "20px" : "0"
        }
      }, turntableAlbum ? window.Capacitor ? showTrackList ? "Can't find it automatically" : "Finding your place\u2026" : "Pick a track to start" : listenAttempt > MAX_ATTEMPTS ? "Matching by lyrics\u2026" : "Listening\u2026"),
      /* ── Manual track picker with side grouping ── */
      turntableAlbum && (showTrackList || !window.Capacitor) && turntableTracksRef.current.length > 0 && (() => {
        const allTracks = turntableTracksRef.current;
        const groups = getSideGroups(allTracks, vinylSidesRef.current, vinylDbRelease?.vinyl_tracks);
        const isWeb = !window.Capacitor;
        return /* @__PURE__ */ React.createElement(
          "div",
          {
            style: { marginTop: isWeb ? "8px" : "24px", width: "100%", maxWidth: "360px", textAlign: "left" }
          },
          // iOS only: toggle button to reveal/hide the list
          !isWeb && /* @__PURE__ */ React.createElement("button", {
            onClick: () => setShowTrackList((v) => !v),
            style: { fontSize: "11px", letterSpacing: "1.5px", textTransform: "uppercase", color: "rgba(255,255,255,0.35)", marginBottom: "10px", textAlign: "center", width: "100%", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }
          }, showTrackList ? "\u25B2 Or jump to a track" : "\u25BC Or jump to a track"),
          (isWeb || showTrackList) && /* @__PURE__ */ React.createElement("div", {
            style: { display: "flex", flexDirection: "column", gap: "12px", maxHeight: isWeb ? "60vh" : "45vh", overflowY: "auto", WebkitOverflowScrolling: "touch" }
          }, groups.map(
            ({ side, tracks }) => /* @__PURE__ */ React.createElement(
              "div",
              { key: side },
              /* @__PURE__ */ React.createElement(
                "button",
                {
                  onClick: () => toggleSideCollapse(side),
                  style: { display: "flex", alignItems: "center", gap: "8px", width: "100%", background: "none", border: "none", cursor: "pointer", padding: "4px 0 8px", fontFamily: "inherit" }
                },
                /* @__PURE__ */ React.createElement("span", { style: { fontSize: "10px", letterSpacing: "2px", textTransform: "uppercase", color: "rgba(212,168,70,0.8)", fontWeight: "700" } }, `Side ${side}`),
                /* @__PURE__ */ React.createElement("span", { style: { fontSize: "10px", color: "rgba(255,255,255,0.2)", marginLeft: "auto" } }, collapsedSides.has(side) ? "\u25BC" : "\u25B2")
              ),
              !collapsedSides.has(side) && /* @__PURE__ */ React.createElement("div", {
                style: { display: "flex", flexDirection: "column", gap: "4px" }
              }, tracks.map(
                ({ track: t, idx: i }) => /* @__PURE__ */ React.createElement(
                  "button",
                  {
                    key: i,
                    onClick: () => jumpToTrackIdx(i),
                    style: {
                      background: "rgba(255,255,255,0.04)",
                      border: "1px solid rgba(255,255,255,0.07)",
                      borderRadius: "10px",
                      padding: "9px 14px",
                      color: "#f0e6d3",
                      fontSize: "13px",
                      cursor: "pointer",
                      fontFamily: "inherit",
                      textAlign: "left",
                      display: "flex",
                      alignItems: "center",
                      gap: "10px"
                    }
                  },
                  /* @__PURE__ */ React.createElement("span", { style: { color: "rgba(255,255,255,0.25)", fontSize: "11px", minWidth: "16px" } }, i + 1),
                  t.trackName
                )
              ))
            )
          ))
        );
      })(),
      /* @__PURE__ */ React.createElement("div", {
        style: {
          display: "flex",
          gap: "12px",
          marginTop: "28px",
          justifyContent: "center"
        }
      }, /* @__PURE__ */ React.createElement("button", {
        onClick: () => {
          listenSessionRef.current++;
          clearInterval(progressTimerRef.current);
          streamRef.current?.getTracks().forEach((t) => t.stop());
          reset();
        },
        style: {
          background: "none",
          border: "1px solid rgba(255,255,255,0.12)",
          color: "rgba(255,255,255,0.4)",
          borderRadius: "50px",
          padding: "10px 26px",
          fontSize: "13px",
          cursor: "pointer",
          fontFamily: "inherit"
        }
      }, "Stop"), /* @__PURE__ */ React.createElement("button", {
        onClick: () => {
          listenSessionRef.current++;
          clearInterval(progressTimerRef.current);
          streamRef.current?.getTracks().forEach((t) => t.stop());
          startListening(false);
        },
        style: {
          background: "none",
          border: "1px solid rgba(255,255,255,0.12)",
          color: "rgba(255,255,255,0.3)",
          borderRadius: "50px",
          padding: "10px 26px",
          fontSize: "13px",
          cursor: "pointer",
          fontFamily: "inherit"
        }
      }, "\u21BA Try again"))
    ), mode === "detecting" && /* @__PURE__ */ React.createElement("div", {
      style: {
        animation: "fade-up 0.3s ease both"
      }
    }, /* @__PURE__ */ React.createElement(Vinyl, {
      size: 100,
      spinning: true
    }), /* @__PURE__ */ React.createElement("div", {
      style: {
        marginTop: "28px",
        fontSize: "20px",
        fontWeight: "600",
        color: "#f0e6d3",
        marginBottom: "8px"
      }
    }, "Identifying\u2026"), /* @__PURE__ */ React.createElement("div", {
      style: {
        fontSize: "14px",
        color: "rgba(255,255,255,0.3)"
      }
    }, "Just a moment"), /* @__PURE__ */ React.createElement("div", {
      style: {
        display: "flex",
        gap: "10px",
        justifyContent: "center",
        marginTop: "28px"
      }
    }, /* @__PURE__ */ React.createElement("button", {
      onClick: reset,
      style: {
        background: "none",
        border: "1px solid rgba(255,255,255,0.12)",
        color: "rgba(255,255,255,0.4)",
        borderRadius: "50px",
        padding: "10px 26px",
        fontSize: "13px",
        cursor: "pointer",
        fontFamily: "inherit"
      }
    }, "\u2190 Stop"), /* @__PURE__ */ React.createElement("button", {
      onClick: () => {
        listenSessionRef.current++;
        startListening(false);
      },
      style: {
        background: "none",
        border: "1px solid rgba(255,255,255,0.12)",
        color: "rgba(255,255,255,0.3)",
        borderRadius: "50px",
        padding: "10px 26px",
        fontSize: "13px",
        cursor: "pointer",
        fontFamily: "inherit"
      }
    }, "\u21BA Try again"))), mode === "error" && /* @__PURE__ */ React.createElement("div", {
      style: {
        maxWidth: "320px",
        animation: "fade-up 0.3s ease both"
      }
    }, /* @__PURE__ */ React.createElement("div", {
      style: {
        fontSize: "48px",
        marginBottom: "20px"
      }
    }, "\u{1F3B5}"), error?.split("\n\n").map((block, i) => /* @__PURE__ */ React.createElement("div", {
      key: i,
      onClick: i === 1 ? () => {
        navigator.clipboard?.writeText(block).catch(() => {
        });
      } : void 0,
      title: i === 1 ? "Tap to copy log" : void 0,
      style: {
        marginBottom: "12px",
        color: i === 0 ? "#e8a0a8" : "rgba(255,255,255,0.3)",
        fontSize: i === 0 ? "15px" : "11px",
        lineHeight: "1.7",
        fontFamily: i > 0 ? "monospace" : "inherit",
        whiteSpace: "pre-wrap",
        textAlign: i > 0 ? "left" : "center",
        background: i === 1 ? "rgba(255,255,255,0.04)" : "none",
        borderRadius: i === 1 ? "8px" : 0,
        padding: i === 1 ? "10px 12px" : 0,
        cursor: i === 1 ? "pointer" : "default",
        maxHeight: i === 1 ? "180px" : "none",
        overflowY: i === 1 ? "auto" : "visible"
      }
    }, block)), /* @__PURE__ */ React.createElement("div", {
      style: {
        display: "flex",
        gap: "10px",
        flexWrap: "wrap",
        justifyContent: "center",
        marginTop: "8px"
      }
    }, /* @__PURE__ */ React.createElement("button", {
      onClick: reset,
      style: {
        background: "none",
        border: "1px solid rgba(212,168,70,0.4)",
        color: "#d4a846",
        borderRadius: "50px",
        padding: "12px 32px",
        fontSize: "14px",
        cursor: "pointer",
        fontFamily: "inherit"
      }
    }, "Try Again"), lastRecordingRef.current && /* @__PURE__ */ React.createElement("button", {
      onClick: () => {
        const url = URL.createObjectURL(lastRecordingRef.current);
        const a = document.createElement("a");
        a.href = url;
        a.download = "liri-recording.webm";
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5e3);
      },
      style: {
        background: "none",
        border: "1px solid rgba(255,255,255,0.15)",
        color: "rgba(255,255,255,0.4)",
        borderRadius: "50px",
        padding: "12px 24px",
        fontSize: "12px",
        cursor: "pointer",
        fontFamily: "inherit"
      }
    }, "\u2193 recording"))), mode === "side-end" && /* @__PURE__ */ React.createElement("div", {
      style: {
        maxWidth: "300px",
        animation: "fade-up 0.3s ease both",
        textAlign: "center"
      }
    }, /* @__PURE__ */ React.createElement(Vinyl, {
      size: 100,
      spinning: false
    }), sideEndReason === "flip" && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", {
      style: {
        marginTop: "32px",
        fontSize: "22px",
        fontWeight: "700",
        color: "#f0e6d3",
        marginBottom: "12px"
      }
    }, sideEndNextDiscInfo && sideEndNextDiscInfo.isNewDisc ? "Time for LP " + sideEndNextDiscInfo.nextDisc + "! \u{1F4BF}" : "Time to flip! \u{1F4BF}"), /* @__PURE__ */ React.createElement("div", {
      style: {
        color: "rgba(255,255,255,0.4)",
        marginBottom: "36px",
        lineHeight: "1.8",
        fontSize: "15px"
      }
    }, sideEndNextDiscInfo && sideEndNextDiscInfo.isNewDisc ? "Grab LP " + sideEndNextDiscInfo.nextDisc + " and tap below." : "Flip the record, then tap below."), isNeedleDrop ? /* @__PURE__ */ React.createElement("div", {
      style: {
        marginTop: "8px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "10px",
        animation: "fade-up 0.3s ease both"
      }
    }, /* @__PURE__ */ React.createElement("div", {
      style: {
        width: "36px",
        height: "36px",
        border: "3px solid rgba(212,168,70,0.2)",
        borderTop: "3px solid #d4a846",
        borderRadius: "50%",
        animation: "spin 0.9s linear infinite"
      }
    }), /* @__PURE__ */ React.createElement("div", {
      style: { fontSize: "13px", color: "rgba(255,255,255,0.35)" }
    }, "Dropping needle\u2026")) : /* @__PURE__ */ React.createElement(React.Fragment, null, turntableTracksRef.current.length > 0 && (sideEndNextDiscInfo || getNextSideLetter()) && /* @__PURE__ */ React.createElement("button", {
      onClick: manualFlipToNextSide,
      style: {
        background: "linear-gradient(135deg, #d4a846, #c9807a)",
        color: "#080810",
        border: "none",
        borderRadius: "50px",
        padding: "14px 36px",
        fontSize: "14px",
        fontWeight: "700",
        cursor: "pointer",
        fontFamily: "inherit",
        width: "100%",
        marginBottom: "10px"
      }
    }, sideEndNextDiscInfo && sideEndNextDiscInfo.isNewDisc ? "Start Side " + sideEndNextDiscInfo.nextSide + " \u2192" : "Flip to Side " + (sideEndNextDiscInfo ? sideEndNextDiscInfo.nextSide : getNextSideLetter()) + " \u2192"), IS_IOS && /* @__PURE__ */ React.createElement("button", {
      onClick: () => {
        reset();
        setTimeout(() => startListening(false), 300);
      },
      style: {
        marginTop: "4px",
        marginBottom: "4px",
        background: "none",
        border: "none",
        color: "rgba(255,255,255,0.25)",
        fontSize: "13px",
        cursor: "pointer",
        fontFamily: "inherit"
      }
    }, "\u21BB Listen with Shazam"), lastSong && /* @__PURE__ */ React.createElement("button", {
      onClick: () => setMode("idle"),
      style: {
        marginTop: "4px",
        background: "none",
        border: "none",
        color: "rgba(255,255,255,0.25)",
        fontSize: "13px",
        cursor: "pointer",
        fontFamily: "inherit"
      }
    }, "\u2190 Back"))), sideEndReason === "album-end" && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", {
      style: {
        marginTop: "32px",
        fontSize: "22px",
        fontWeight: "700",
        color: "#f0e6d3",
        marginBottom: "12px"
      }
    }, "That's the album! \u{1F3B6}"), /* @__PURE__ */ React.createElement("div", {
      style: {
        color: "rgba(255,255,255,0.4)",
        marginBottom: "36px",
        lineHeight: "1.8",
        fontSize: "15px"
      }
    }, "Put on your next LP to keep going."), /* @__PURE__ */ React.createElement("button", {
      onClick: reset,
      style: {
        background: "linear-gradient(135deg, #d4a846, #c9807a)",
        color: "#080810",
        border: "none",
        borderRadius: "50px",
        padding: "14px 36px",
        fontSize: "14px",
        fontWeight: "700",
        cursor: "pointer",
        fontFamily: "inherit"
      }
    }, "New LP \u2192"), lastSong && /* @__PURE__ */ React.createElement("button", {
      onClick: () => setMode("idle"),
      style: {
        marginTop: "12px",
        background: "none",
        border: "none",
        color: "rgba(255,255,255,0.25)",
        fontSize: "13px",
        cursor: "pointer",
        fontFamily: "inherit"
      }
    }, "\u2190 Back")), sideEndReason === "failed" && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", {
      style: {
        marginTop: "32px",
        fontSize: "22px",
        fontWeight: "700",
        color: "#f0e6d3",
        marginBottom: "12px"
      }
    }, (function() {
      var _di = getNextDiscInfo();
      return _di && _di.isNewDisc ? "Time for LP " + _di.nextDisc + "?" : "Time to flip?";
    })()), /* @__PURE__ */ React.createElement("div", {
      style: {
        color: "rgba(255,255,255,0.4)",
        marginBottom: "36px",
        lineHeight: "1.8",
        fontSize: "15px"
      }
    }, (function() {
      var _di = getNextDiscInfo();
      return _di && _di.isNewDisc ? "Grab LP " + _di.nextDisc + " and tap below." : "Flip the record, then tap below.";
    })()), isNeedleDrop ? /* @__PURE__ */ React.createElement("div", {
      style: {
        marginTop: "8px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "10px",
        animation: "fade-up 0.3s ease both"
      }
    }, /* @__PURE__ */ React.createElement("div", {
      style: {
        width: "36px",
        height: "36px",
        border: "3px solid rgba(212,168,70,0.2)",
        borderTop: "3px solid #d4a846",
        borderRadius: "50%",
        animation: "spin 0.9s linear infinite"
      }
    }), /* @__PURE__ */ React.createElement("div", {
      style: { fontSize: "13px", color: "rgba(255,255,255,0.35)" }
    }, "Dropping needle\u2026")) : /* @__PURE__ */ React.createElement(React.Fragment, null, turntableTracksRef.current.length > 0 && (getNextDiscInfo() || getNextSideLetter()) && /* @__PURE__ */ React.createElement("button", {
      onClick: manualFlipToNextSide,
      style: {
        background: "linear-gradient(135deg, #d4a846, #c9807a)",
        color: "#080810",
        border: "none",
        borderRadius: "50px",
        padding: "14px 36px",
        fontSize: "14px",
        fontWeight: "700",
        cursor: "pointer",
        fontFamily: "inherit",
        width: "100%",
        marginBottom: "10px"
      }
    }, (function() {
      var _di = getNextDiscInfo();
      return _di && _di.isNewDisc ? "Start Side " + _di.nextSide + " \u2192" : "Flip to Side " + (_di ? _di.nextSide : getNextSideLetter()) + " \u2192";
    })()), IS_IOS && /* @__PURE__ */ React.createElement("button", {
      onClick: () => {
        reset();
        setTimeout(() => startListening(false), 300);
      },
      style: {
        marginTop: "4px",
        marginBottom: "4px",
        background: "none",
        border: "none",
        color: "rgba(255,255,255,0.25)",
        fontSize: "13px",
        cursor: "pointer",
        fontFamily: "inherit"
      }
    }, "\u21BB Listen with Shazam"), lastSong && /* @__PURE__ */ React.createElement("button", {
      onClick: () => setMode("idle"),
      style: {
        marginTop: "4px",
        background: "none",
        border: "none",
        color: "rgba(255,255,255,0.25)",
        fontSize: "13px",
        cursor: "pointer",
        fontFamily: "inherit"
      }
    }, "\u2190 Back")))), mode === "limit" && /* @__PURE__ */ React.createElement("div", {
      style: {
        maxWidth: "300px",
        animation: "fade-up 0.3s ease both",
        textAlign: "center"
      }
    }, /* @__PURE__ */ React.createElement(Vinyl, {
      size: 100,
      spinning: false
    }), /* @__PURE__ */ React.createElement("div", {
      style: {
        marginTop: "32px",
        fontSize: "22px",
        fontWeight: "700",
        color: "#f0e6d3",
        marginBottom: "12px"
      }
    }, "Your free crate is full"), /* @__PURE__ */ React.createElement("div", {
      style: {
        color: "rgba(255,255,255,0.4)",
        marginBottom: "36px",
        lineHeight: "1.8",
        fontSize: "15px"
      }
    }, "You've added 10 free records.", /* @__PURE__ */ React.createElement("br", null), "Upgrade to keep building your collection."), IS_IOS ? /* @__PURE__ */ React.createElement(
      React.Fragment,
      null,
      /* @__PURE__ */ React.createElement("button", {
        onClick: upgradeWithApple,
        disabled: iapWorking,
        style: { background: "linear-gradient(135deg,#d4a846,#c9807a)", color: "#080810", border: "none", borderRadius: "50px", padding: "14px 32px", fontSize: "14px", fontWeight: "700", cursor: "pointer", fontFamily: "inherit", marginBottom: "8px", width: "100%", opacity: iapWorking ? 0.6 : 1 }
      }, iapWorking ? "Processing\u2026" : `Subscribe \xB7 ${iapPrice}`),
      /* @__PURE__ */ React.createElement("button", {
        onClick: restoreApplePurchases,
        disabled: iapWorking,
        style: { background: "none", border: "none", color: "rgba(255,255,255,0.3)", fontSize: "12px", cursor: "pointer", fontFamily: "inherit", padding: "8px", marginBottom: "4px" }
      }, "Restore Purchases")
    ) : /* @__PURE__ */ React.createElement("button", {
      onClick: async () => {
        const { data: { session } } = await sb.auth.getSession();
        const token = session?.access_token || sessionTokenRef.current;
        if (!token) return;
        const res = await fetch("/api/stripe-checkout", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` } });
        const json = await res.json().catch(() => ({}));
        if (json.url) window.location.href = json.url;
      },
      style: {
        background: "linear-gradient(135deg,#d4a846,#c9807a)",
        color: "#080810",
        border: "none",
        borderRadius: "50px",
        padding: "14px 32px",
        fontSize: "14px",
        fontWeight: "700",
        cursor: "pointer",
        fontFamily: "inherit",
        marginBottom: "12px",
        width: "100%"
      }
    }, "Upgrade to Premium \u2192"), /* @__PURE__ */ React.createElement("button", {
      onClick: () => setMode("idle"),
      style: {
        background: "none",
        border: "1px solid rgba(255,255,255,0.1)",
        color: "rgba(255,255,255,0.3)",
        borderRadius: "50px",
        padding: "10px 28px",
        fontSize: "13px",
        cursor: "pointer",
        fontFamily: "inherit"
      }
    }, "Maybe later")))));
  }
  ReactDOM.createRoot(document.getElementById("root")).render(/* @__PURE__ */ React.createElement(Liri, null));
})();
