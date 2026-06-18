import { parseLRC, formatTime, timeAgo, normText } from "../base/lib/text.js";
import { startWhisperChunks } from "../base/lib/whisper.js";
import { getSideGroups }      from "../base/lib/sides.js";
import { showFlipPushNotification, showAlbumEndPushNotification, getLocalNotif } from "../base/lib/notifications.js";
import { Vinyl }          from "../base/components/Vinyl.js";
import { WaveAnimation }  from "../base/components/WaveAnimation.js";
import { ProgressRing }   from "../base/components/ProgressRing.js";
import { Shazam }         from "../ios/shazam.js";
import { getNativeAudio } from "../ios/audio.js";
import { getLiriIAP }     from "../ios/iap.js";

const {
  useState,
  useEffect,
  useRef,
  useCallback
} = React;
if (typeof supabase === 'undefined') {
  document.getElementById('root').innerHTML = '<div style="min-height:100vh;background:#080810;display:flex;align-items:center;justify-content:center;font-family:system-ui;color:#e8a0a8;text-align:center;padding:32px">Could not load auth library.<br><small style="color:#333;margin-top:8px;display:block">Check your connection and reload</small></div>';
  throw new Error('Supabase not loaded');
}
const sb = supabase.createClient("https://xjdjpaxgymgbvcwmvorc.supabase.co", "sb_publishable_C-NBnfg0ltAoUi46XQTUjA_ozjZW_Nd");
const APP_VERSION = "1.1.7";
const IS_IOS = !!window.Capacitor; // set once at load time — used for App Store compliance checks
const TRANSCRIBE_PROXY = window.Capacitor ? "https://www.getliri.com/api/transcribe"    : "/api/transcribe";
const ITUNES_PROXY   = window.Capacitor ? "https://www.getliri.com/api/itunes-lookup"   : "/api/itunes-lookup";
// Shazam + NativeAudio plugin bridges are imported from app/ios/.

//   3. Landing page feature cards (🎵 → sound/wave art, 💿 → vinyl art)
//      Note: ✦ (sparkle character) is intentional Liri type — keep it
//   4. Settings panel — consider a custom Liri icon or wordmark instead of generic text
// All original artwork should match the dark palette: deep navy #080810, gold #d4a846, rose #c9807a
// ─────────────────────────────────────────────────────────────────────────────────────────────


const PLAYBACK_OFFSET_CORRECTION = 4.0;
// Extra offset added when auto-advancing to next track (no re-listen),
// accounting for lyrics-fetch + state-update delay. Tune if still drifting.
const AUTO_ADVANCE_OFFSET = 2.0;
const styleEl = document.createElement("style");
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
  // ── Core state ──
  const [mode, setMode] = useState("idle");
  const [detectedSong, setDetectedSong] = useState(null);
  const [identifiedBy, setIdentifiedBy] = useState(null); // "speech"
  const [songDuration, setSongDuration] = useState(null); // seconds
  const [lyrics, setLyrics] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [playbackTime, setPlaybackTime] = useState(0);
  const [error, setError] = useState(null);
  const [listenProgress, setListenProgress] = useState(0);
  const [liveTranscript, setLiveTranscript] = useState("");
  const [listenAttempt, setListenAttempt] = useState(0); // which rolling attempt we're on
  const [listenSecs, setListenSecs] = useState(0); // real-time seconds counter (UI only)

  // ── UI panels ──
  const [showSettings, setShowSettings] = useState(false);
  const [isWide, setIsWide] = useState(() => window.innerWidth >= 768);
  useEffect(() => {
    const onResize = () => setIsWide(window.innerWidth >= 768);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const [isLandscape, setIsLandscape] = useState(() => window.innerWidth > window.innerHeight && window.innerWidth >= 600);
  useEffect(() => {
    const onResize = () => setIsLandscape(window.innerWidth > window.innerHeight && window.innerWidth >= 600);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const [controlsVisible, setControlsVisible] = useState(true);
  const controlsHideTimerRef = useRef(null);
  const [showBugReport, setShowBugReport] = useState(false);
  const [bugText, setBugText] = useState("");
  const [bugSending, setBugSending] = useState(false);
  const [bugSent, setBugSent] = useState(false);
  const [showPremiumInfo, setShowPremiumInfo] = useState(false);
  const [showDeleteAccount, setShowDeleteAccount] = useState(false);
  const [deleteWorking, setDeleteWorking] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  const [showChangePw, setShowChangePw] = useState(false);
  const [changePwNew, setChangePwNew] = useState("");
  const [changePwConfirm, setChangePwConfirm] = useState("");
  const [changePwWorking, setChangePwWorking] = useState(false);
  const [changePwError, setChangePwError] = useState(null);
  const [changePwDone, setChangePwDone] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showTrackList, setShowTrackList] = useState(false);
  const [showNowPlayingList, setShowNowPlayingList] = useState(false); // tracklist peek while listening
  const [collapsedSides, setCollapsedSides] = useState(new Set());
  const toggleSideCollapse = (side) => setCollapsedSides(prev => { const n = new Set(prev); n.has(side) ? n.delete(side) : n.add(side); return n; });

  // ── Auth ──
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authMode, setAuthMode] = useState("signin");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [showPw, setShowPw] = useState(false); // eyeball toggle for password fields
  const [authConfirmPw, setAuthConfirmPw] = useState("");
  const [authName, setAuthName] = useState("");
  const [authError, setAuthError] = useState(null);
  const [authWorking, setAuthWorking] = useState(false);
  const [authSheet, setAuthSheet] = useState(null);
  const [authVerifyPending, setAuthVerifyPending] = useState(false); // show email-confirm waiting screen

  // ── Usage ──
  const isUnlimited = u => true; // recognition is now free — no API costs at listen time

  // ── Subscription tier — fetched from /api/subscription-status on login ──
  const [userTier, setUserTier]       = useState("free"); // "free" | "premium"
  const [albumCount, setAlbumCount]   = useState(0);
  const [upgradeWorking, setUpgradeWorking] = useState(false);

  // ── Auth token ref — kept current for API Authorization headers ──
  const sessionTokenRef = useRef(null);

  // ── History ──
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // ── Vinyl auto mode (always on) ──
  const vinylMode = true;
  const autoAdvanceFiredRef = useRef(false);

  // ── Turntable: album the user has selected before listening ──
  const [turntableAlbum, setTurntableAlbum] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("liri_turntable") || "null");
    } catch {
      return null;
    }
  });
  const [showAlbumPicker, setShowAlbumPicker] = useState(false);
  const [userLibrary, setUserLibrary] = useState([]);
  const [libLoading, setLibLoading] = useState(false);
  const [turntableTracksLoading, setTurntableTracksLoading] = useState(false);
  const [turntableTracksProgress, setTurntableTracksProgress] = useState({ percent: 0, stage: "" });
  const turntableAlbumRef = useRef(turntableAlbum);
  const turntableTracksRef = useRef([]); // iTunes tracks for selected album (pre-fetched)
  const turntableMatchedIdxRef = useRef(-1); // 0-based index of last vinyl-matched track
  // turntableLyricsCacheRef: raw DB rows fetched once per album in fetchTurntableTracks.
  //   Shape: { [String(itunes_track_id)]: { lrc_raw, words_json, lyrics_plain } }
  //   Populated at album-select time so that startListeningSpeech has zero network
  //   latency when the mic opens. Lives for the lifetime of the selected album — reset
  //   to {} at the top of fetchTurntableTracks so stale data from the previous album
  //   never bleeds through.
  //
  // wordsDataRef: derived/processed form built at the START of each listening session
  //   inside startListeningSpeech. Shape: { [trackId]: { words, lrc_raw, lyrics_plain } }
  //   where `words` is a flat array of { word, start_ms } objects ready for matching.
  //   The derivation step handles the fallback chain (words_json → lrc_raw → lyrics_plain)
  //   so matchTranscriptToTracks only ever sees one consistent format.
  //   Also kept alive after the listen so jumpToTrack / resync can reuse it without
  //   another DB call.
  //
  // Summary: turntableLyricsCacheRef = "what came from the DB".
  //          wordsDataRef            = "what the matcher actually uses".
  const turntableLyricsCacheRef = useRef({}); // lrc_raw cache by trackId — loaded at album select, used in startListeningSpeech
  const wordsDataRef = useRef({}); // trackId → { words, lrc_raw, lyrics_plain } from track_lyrics table
  const autoRetryCountRef = useRef(0);

  // ── Album tracklist (for vinyl auto-advance without re-listening) ──
  const [albumTracks, setAlbumTracks] = useState([]);
  const [currentTrackIndex, setCurrentTrackIndex] = useState(-1);
  const albumTracksRef = useRef([]);
  const currentTrackIndexRef = useRef(-1);

  // ── Resync / advance flags ──
  const [isResyncing, setIsResyncing] = useState(false);
  const [isNeedleDrop, setIsNeedleDrop] = useState(false);
  const [keepScreenAwake, setKeepScreenAwake] = useState(() => localStorage.getItem("liri_keep_awake") === "true");
  const wakeLockRef = useRef(null);
  const [isPaused, setIsPaused] = useState(false);
  const [kbToast, setKbToast] = useState(null);
  const kbToastTimerRef = useRef(null);
  const [shouldAdvanceTrack, setShouldAdvanceTrack] = useState(false);
  const [sideEndReason, setSideEndReason] = useState("failed"); // "failed" | "flip" | "album-end"
  const [sideEndNextDiscInfo, setSideEndNextDiscInfo] = useState(null); // {isNewDisc, nextDisc, nextSide}
  const flipChimeTimersRef = useRef([]); // ids for the repeating flip-chime setTimeouts
  const flipStartDelayMsRef = useRef(0); // when set, startSync will hold playbackTime at 0 for this many ms (used after manual flip)

  // ── Per-album side learning (silent — no user-facing UI) ──
  const [albumCollectionId, setAlbumCollectionId] = useState(null);
  const albumCollectionIdRef = useRef(null);
  const albumTpsRef = useRef(0); // effective tps from localStorage learning or heuristic

  // ── Liri vinyl database ──
  const [vinylDbRelease, setVinylDbRelease] = useState(null);
  const vinylDbReleaseRef = useRef(null);
  // vinyl_sides: array of { side, side_track_number, position } sorted A1…B1…
  // Positionally indexed — vinylSidesRef.current[i] is the side for turntableTracksRef[i].
  const vinylSidesRef = useRef([]);

  // ── Flip notifications ──
  const [flipSound, setFlipSound] = useState(() => localStorage.getItem("liri_flip_sound") !== "false");
  const [flipNotify, setFlipNotify] = useState(() => localStorage.getItem("liri_flip_notify") === "true");
  const [notifyDenied, setNotifyDenied] = useState(false);

  // ── Nudge expand ──
  const [nudgeMenu, setNudgeMenu] = useState(null); // null | "left" | "right"
  const nudgeMenuTimerRef = useRef(null);

  // ── Onboarding ──
  const [showOnboarding, setShowOnboarding] = useState(() => !localStorage.getItem("liri_onboarding_done"));
  const [onboardingStep, setOnboardingStep] = useState(0);
  const ONBOARDING_STEPS = 6;
  const [coachStep, setCoachStep] = useState(0); // 0 none · 1 highlight Listen · 2 highlight Feed
  const dismissOnboarding = () => {
    localStorage.setItem("liri_onboarding_done", "true");
    setShowOnboarding(false);
  };
  // Skip onboarding for returning users — if auth resolves with a logged-in user, they've seen it
  useEffect(() => {
    if (user) dismissOnboarding();
  }, [user]);

  // ── Analytics: persistent anonymous session ID ──
  // Stays in localStorage forever so we can track listening patterns even
  // before a user creates an account. Once logged in, user_id takes over.
  const sessionId = React.useMemo(() => {
    let sid = localStorage.getItem("liri_session_id");
    if (!sid) {
      sid = ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
      localStorage.setItem("liri_session_id", sid);
    }
    return sid;
  }, []);

  // ── Refs ──
  const streamRef = useRef(null);
  const speechRecRef = useRef(null); // active SpeechRecognition instance (turntable mode)
  const analyserNodeRef = useRef(null); // AnalyserNode for frequency-bar wave
  const audioCtxRef = useRef(null); // AudioContext for the analyser
  const chimeCtxRef = useRef(null); // Persistent AudioContext unlocked on first Listen tap
  const syncIntervalRef = useRef(null);
  const syncStartRef = useRef(null);
  const detectedAtRef = useRef(null);
  const initialPosRef = useRef(0);
  const userNudgeRef = useRef(0); // cumulative nudge applied by user this session
  // Deferred timing: identification paths store { startPos, phraseOffset, recStart } here.
  // startSync reads it to compute initialPos at the last possible moment — capturing the
  // full elapsed time from recording start through Whisper API + React render.
  const syncCalcRef = useRef(null);
  const recordingStartRef = useRef(null); // wall-clock time when mic started recording
  const lyricsRef = useRef([]);
  const progressTimerRef = useRef(null);
  const currentLineRef = useRef(null);
  const creditsRef = useRef(null);
  const userScrollingRef = useRef(false); // true while user is browsing lyrics manually
  const [userScrolling, setUserScrolling] = useState(false); // reactive mirror for Follow button visibility
  const scrollInhibitTimer = useRef(null);
  const listenSessionRef = useRef(0); // increments on each startListening; guards stale async callbacks
  const attemptLogRef = useRef([]); // collects per-attempt debug info for the error screen
  const lastRecordingRef = useRef(null); // stores last recorded blob for debug download
  const recognitionWonRef = useRef(false); // true once recognition wins — prevents double-set
  const lastRawMatchRef = useRef(null); // { title, artist, identified_by } — raw match at recognition time
  const autoPostVisRef = useRef("off"); // user's auto_post_visibility: off|private|friends|public
  const autoPostedAlbumsRef = useRef(new Set()); // collection_ids auto-posted this app session (dedup)
  const [audioLevel, setAudioLevel] = useState(0); // 0–1 live mic amplitude (chunk-size proxy)
  const [lastSong, setLastSong] = useState(null);
  const [hoverNudge, setHoverNudge] = useState(null); // null | "left" | "right"

  useEffect(() => {
    lyricsRef.current = lyrics;
  }, [lyrics]);
  useEffect(() => {
    albumTracksRef.current = albumTracks;
  }, [albumTracks]);
  useEffect(() => {
    currentTrackIndexRef.current = currentTrackIndex;
  }, [currentTrackIndex]);
  useEffect(() => {
    vinylDbReleaseRef.current = vinylDbRelease;
  }, [vinylDbRelease]);
  useEffect(() => {
    albumCollectionIdRef.current = albumCollectionId;
  }, [albumCollectionId]);



  // ── Per-album side data (localStorage, keyed by iTunes collectionId) ──
  const getAlbumSideData = cid => {
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
  // ── Liri vinyl DB lookup ──
  const fetchVinylRelease = async collectionId => {
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

  // ── Auto-populate vinyl side data from MusicBrainz ──────────────────────────────
  // When an album is selected, query MusicBrainz for its vinyl tracklist (A1, B2…)
  // and store it in vinyl_releases + vinyl_tracks so getSideInfo can use real data.
  // Fire-and-forget — runs in background, silent on failure.
  const autoPopulateVinylSides = async (collectionId, albumName, artistName) => {
    try {
      // Already in DB? Skip.
      const {
        data: existing
      } = await sb.from("vinyl_releases").select("id").eq("itunes_collection_id", String(collectionId)).maybeSingle();
      if (existing) return existing.id;
      const norm = normText;
      const normAlbum = norm(albumName);
      const normArtist = norm(artistName);
      const normAlbumBase = norm(albumName.split("(")[0].trim());

      // 1. Search Discogs
      const search = await fetch(`/api/discogs-lookup?q=${encodeURIComponent(artistName + " " + albumName)}&per_page=10`).then(r => r.json()).catch(() => null);
      if (!search?.results?.length) return null;

      // 2. Shortlist candidates whose title contains artist + album (or base name)
      const candidates = search.results.filter(r => {
        const t = norm(r.title || "");
        return t.includes(normArtist) && (t.includes(normAlbum) || t.includes(normAlbumBase));
      }).slice(0, 5);
      if (!candidates.length) candidates.push(...search.results.slice(0, 3));

      // 3. Fetch details for candidates; pick the one with the MOST sides
      //    (6-sided 3LP beats a 4-sided reissue without bonus tracks)
      let bestDetail = null;
      let bestSideCount = 0;
      for (const candidate of candidates) {
        const detail = await fetch(`/api/discogs-lookup?id=${candidate.id}`).then(r => r.json()).catch(() => null);
        if (!detail?.tracklist?.length) continue;
        const sideCount = new Set(detail.tracklist.map(t => (t.position || "").toUpperCase().match(/^([A-Z])/)?.[1]).filter(Boolean)).size;
        if (sideCount > bestSideCount) {
          bestSideCount = sideCount;
          bestDetail = detail;
        }
        if (bestSideCount >= 6) break;
      }
      if (!bestDetail || bestSideCount === 0) return null;
      const hasSidePos = bestDetail.tracklist.some(t => /^[A-Z]\d/i.test(t.position || ""));
      if (!hasSidePos) return null;

      // 4. Insert vinyl_release
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

      // 5. Insert vinyl_tracks — Discogs positions are ground truth (A1, B1, …)
      const rows = [];
      for (const track of bestDetail.tracklist) {
        const pos = (track.position || "").toUpperCase();
        const m = pos.match(/^([A-Z])(\d+)/);
        if (!m) continue;
        let durationMs = null;
        if (track.duration) {
          const parts = track.duration.split(":");
          if (parts.length === 2) durationMs = (parseInt(parts[0]) * 60 + parseInt(parts[1])) * 1000;
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

  // Shared title normaliser: strip punctuation + lowercase so Discogs ↔ iTunes title
  // mismatches (feat., trailing periods, dashes, etc.) don't break side matching.
  const normTitle = normText;

  // Convert our DB track list into side-end indices that advanceToNextTrack can use.
  // Returns an array of iTunes track indices that are the last track of each side.
  const getDbSideEndIndices = (itunesTracks, dbTracks) => {
    const sideGroups = {};
    dbTracks.forEach(t => {
      if (!sideGroups[t.side]) sideGroups[t.side] = [];
      sideGroups[t.side].push(t);
    });
    const sides = Object.keys(sideGroups).sort();
    const result = [];
    // For every side except the last, find the last track of that side in the iTunes list
    sides.slice(0, -1).forEach(side => {
      const sorted = sideGroups[side].sort((a, b) => a.track_number_on_side - b.track_number_on_side);
      const lastTitle = normTitle(sorted[sorted.length - 1]?.title);
      const idx = itunesTracks.findIndex(t => normTitle(t.trackName) === lastTitle);
      if (idx >= 0) result.push(idx);
    });
    result.push(itunesTracks.length - 1); // album end
    return result;
  };

  // ── Flip notifications ──
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
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + 1.6);
          osc.start(ctx.currentTime + delay);
          osc.stop(ctx.currentTime + delay + 1.6);
        });
      };
      if (ctx.state === "suspended") { ctx.resume().then(play); } else { play(); }
    } catch {}
  };

  // Schedule flip chimes: every 10s for the first 30s, then one more 30s
  // later. Delays are measured from song end (the side-end card itself
  // appears 4s in). First fire also surfaces the push notification.
  const scheduleFlipChimes = (song) => {
    flipChimeTimersRef.current.forEach(clearTimeout);
    flipChimeTimersRef.current = [10000, 20000, 30000, 60000].map((delay, i) =>
      setTimeout(() => {
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
  // Notification helpers are imported from base/lib/notifications.js.
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

  // ── Usage fetch — removed (no API costs at listen time, no free limit) ──
  const fetchUsage = async () => {};

  // ── Load the user's auto-post preference (off|private|friends|public) ──
  const fetchAutoPostPref = async u => {
    if (!u) return;
    try {
      const { data } = await sb.from("profiles")
        .select("auto_post_visibility").eq("id", u.id).maybeSingle();
      autoPostVisRef.current = data?.auto_post_visibility || "off";
    } catch (e) { /* default stays "off" */ }
  };

  // ── History fetch ──
  const fetchHistory = async u => {
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

  // ── Save song to history ──
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

  // ── Analytics: log a song play to listening_events ──
  // Called for both manual recognitions and vinyl auto-advances.
  // Never throws — analytics must never block or break the UI.
  const logListeningEvent = async params => {
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

  // ── Social: auto-post the record you're spinning (if the user opted in) ──
  // Posts ONE album post per record per listening session — never per track —
  // so auto-advancing through a side doesn't spam the feed. Cross-session spam
  // is guarded by a 12h DB check. Never throws; social must not break playback.
  const maybeAutoPostPlay = async ({ userId, collectionId, album, artist, artwork }) => {
    try {
      const vis = autoPostVisRef.current;
      if (!userId || vis === "off") return;
      if (!collectionId) return;
      const key = String(collectionId);
      if (autoPostedAlbumsRef.current.has(key)) return; // already posted this session
      autoPostedAlbumsRef.current.add(key);

      // Cross-session dedup: skip if we auto-posted this album in the last 12h.
      const since = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
      const { data: recent } = await sb.from("posts")
        .select("id")
        .eq("author_id", userId)
        .eq("collection_id", Number(collectionId))
        .eq("source", "auto")
        .gte("created_at", since)
        .limit(1);
      if (recent && recent.length) return;

      await sb.from("posts").insert({
        author_id: userId,
        kind: "album",
        source: "auto",
        visibility: vis,
        collection_id: Number(collectionId),
        album_name: album || null,
        artist_name: artist || null,
        artwork_url: artwork || null,
      });
    } catch (e) {
      console.error("maybeAutoPostPlay failed:", e.message);
    }
  };

  // ── Analytics: log a vinyl side flip to flip_events ──
  const logFlipEvent = async params => {
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

  // ── Auth setup ──
  useEffect(() => {
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
        fetchAutoPostPref(u);
        fetch(`${window.Capacitor ? "https://www.getliri.com" : ""}/api/subscription-status`, { headers: { "Authorization": `Bearer ${session.access_token}` } })
          .then(r => r.ok ? r.json() : null).then(d => { if (d?.tier) { setUserTier(d.tier); setAlbumCount(d.albumCount || 0); } }).catch(() => {});
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
        fetchAutoPostPref(u);
        fetch(`${window.Capacitor ? "https://www.getliri.com" : ""}/api/subscription-status`, { headers: { "Authorization": `Bearer ${s.access_token}` } })
          .then(r => r.ok ? r.json() : null).then(d => { if (d?.tier) setUserTier(d.tier); }).catch(() => {});
      }
    });
    return () => subscription.unsubscribe();
  }, []);
  // ── Apple IAP ─────────────────────────────────────────────────────────────
  const [iapPrice,   setIapPrice]   = useState("$2.99/mo"); // overwritten by iap.fetchProduct() on mount
  const [premiumPlan, setPremiumPlan] = useState("monthly"); // "monthly" | "lifetime"
  const [iapWorking, setIapWorking] = useState(false);

  // Fetch live price from App Store on iOS (best-effort)
  useEffect(() => {
    const iap = getLiriIAP();
    if (!IS_IOS || !iap) return;
    iap.fetchProduct()
      .then(p => { if (p?.displayPrice) setIapPrice(`${p.displayPrice}/mo`); })
      .catch(() => {});
  }, []);

  // On iOS login, check for an active Apple subscription and sync with server
  const syncAppleSubscription = async (token) => {
    const iap = getLiriIAP();
    if (!IS_IOS || !iap) return;
    try {
      const status = await iap.getSubscriptionStatus();
      if (status?.isActive && status?.signedTransaction) {
        const r = await fetch("https://www.getliri.com/api/stripe-checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
          body: JSON.stringify({ appleTransaction: status.signedTransaction }),
        });
        if (r.ok) setUserTier("premium");
      }
    } catch {}
  };

  // plan: "monthly" (renewable sub) | "lifetime" (non-consumable)
  const upgradeWithApple = async (plan = "monthly") => {
    const iap = getLiriIAP();
    if (!iap) {
      alert("In-app purchases are not available right now. Please try again or contact support.");
      return;
    }
    setIapWorking(true);
    try {
      const result = plan === "lifetime"
        ? await iap.purchaseLifetime()
        : await iap.purchase();
      if (result?.signedTransaction) {
        const token = sessionTokenRef.current;
        const r = await fetch("https://www.getliri.com/api/stripe-checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
          body: JSON.stringify({ appleTransaction: result.signedTransaction, plan }),
        });
        const data = await r.json();
        if (data.tier === "premium" || data.tier === "lifetime") {
          setUserTier(data.tier);
          setAlbumCount(prev => prev); // keep count, limit lifted
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
    if (!iap) { alert("Restore is not available right now."); return; }
    setIapWorking(true);
    try {
      const status = await iap.restorePurchases();
      if (status?.isActive && status?.signedTransaction) {
        const token = sessionTokenRef.current;
        // restorePurchases tells us which product is active; pass the matching plan.
        const plan = status.isLifetime ? "lifetime" : "monthly";
        const r = await fetch("https://www.getliri.com/api/stripe-checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
          body: JSON.stringify({ appleTransaction: status.signedTransaction, plan }),
        });
        const data = await r.json();
        if (data.tier === "premium" || data.tier === "lifetime") setUserTier(data.tier);
        else alert("No active subscription found.");
      } else {
        alert("No active subscription found.");
      }
    } catch { alert("Restore failed. Please try again."); }
    finally { setIapWorking(false); }
  };

  // ── Upgrade via Stripe Checkout (web) ──
  // plan: "monthly" (recurring) | "lifetime" (one-time)
  const upgradeToStripe = async (plan = "monthly") => {
    setUpgradeWorking(true);
    try {
      const { data: { session: s } } = await sb.auth.getSession();
      const token = s?.access_token || sessionTokenRef.current;
      const res  = await fetch("/api/stripe-checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ plan }),
      });
      const json = await res.json().catch(() => ({}));
      if (json.url) { window.location.href = json.url; }
      else { alert(json.error || "Could not start checkout. Please try again."); setUpgradeWorking(false); }
    } catch { alert("Network error — please try again."); setUpgradeWorking(false); }
  };

  const handleAuth = async () => {
    setAuthError(null);
    // ── Client-side validation ──
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
          error
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
        if (error) throw error;
        // Show the email-verification waiting screen
        setAuthVerifyPending(true);
      } else {
        const {
          error
        } = await sb.auth.signInWithPassword({
          email: authEmail.trim(),
          password: authPassword
        });
        if (error) throw error;
        setAuthSheet(null);
      }
    } catch (e) {
      const m = (e?.message || "").toLowerCase();
      if (m.includes("invalid login") || m.includes("invalid credentials")) {
        setAuthError("That email or password doesn't look right. Try again, or reset your password below.");
      } else if (m.includes("email not confirmed")) {
        setAuthError("Please confirm your email first — check your inbox for the verification link.");
      } else {
        setAuthError(e?.message || "Something went wrong. Please try again.");
      }
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
      error
    } = await sb.auth.resetPasswordForEmail(authEmail.trim(), {
      redirectTo: "https://getliri.com/app"
    });
    setAuthWorking(false);
    setAuthError(error ? error.message : "Password reset link sent — check your email.");
  };
  const handleResendVerification = async () => {
    setAuthWorking(true);
    const {
      error
    } = await sb.auth.resend({
      type: "signup",
      email: authEmail.trim()
    });
    setAuthWorking(false);
    setAuthError(error ? error.message : "Verification email resent!");
  };
  const handleSignOut = async () => {
    await sb.auth.signOut();
    setShowSettings(false);
    reset();
  };
  const handleChangePassword = async () => {
    setChangePwError(null);
    if (changePwNew.length < 8) { setChangePwError("Password must be at least 8 characters."); return; }
    if (changePwNew !== changePwConfirm) { setChangePwError("Passwords don't match."); return; }
    setChangePwWorking(true);
    const { error } = await sb.auth.updateUser({ password: changePwNew });
    setChangePwWorking(false);
    if (error) { setChangePwError(error.message); return; }
    setChangePwDone(true);
    setTimeout(() => { setShowChangePw(false); setChangePwNew(""); setChangePwConfirm(""); setChangePwDone(false); }, 2000);
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
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
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

  // ── Bug report ──────────────────────────────────────────────────────────
  // SQL to run once in Supabase:
  //   create table bug_reports (
  //     id          uuid default gen_random_uuid() primary key,
  //     created_at  timestamptz default now(),
  //     user_id     uuid references auth.users(id),
  //     user_email  text,
  //     app_version text,
  //     platform    text,
  //     description text not null,
  //     meta        jsonb
  //   );
  //   alter table bug_reports enable row level security;
  //   create policy "users can insert own reports"
  //     on bug_reports for insert with check (auth.uid() = user_id);
  const submitBugReport = async () => {
    if (!bugText.trim()) return;
    setBugSending(true);
    try {
      // 1. Store in Supabase
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
      }, 2000);
    } catch (e) {
      console.error("bug report failed:", e);
    }
    setBugSending(false);
  };

  // ── Turntable album: sync to ref + localStorage, fetch tracks ──
  const fetchTurntableTracks = async collectionId => {
    setTurntableTracksLoading(true);
    setTurntableTracksProgress({ percent: 0, stage: "Loading tracks…" });

    // Clear refs IMMEDIATELY before any await so that if the user switches albums
    // mid-flight the old album's data never bleeds into the new session.
    // Without this a stale turntableTracksRef could cause matchTranscriptToTracks
    // to score against the wrong album's word list.
    turntableTracksRef.current = [];
    turntableLyricsCacheRef.current = {};
    vinylSidesRef.current = [];
    try {
      const alb = turntableAlbumRef.current;
      const artistName = alb?.artist_name || "";
      const albumName = alb?.album_name || "";

      // Load from album_tracks (not vinyl_releases).
      // vinyl_releases is a MusicBrainz-sourced table used for cover art / barcode
      // lookups — it does NOT contain per-track metadata (duration, track numbers, etc.).
      // album_tracks is populated from the iTunes Search API when a user adds an album
      // to their library and is the authoritative source for track order and IDs.
      // Using the wrong table would give us track shells with no duration or lyrics IDs.
      const { data: trackRows } = await sb
        .from("album_tracks")
        .select("itunes_track_id, track_name, artist_name, track_number, disc_number, duration_ms")
        .eq("itunes_collection_id", collectionId)
        .order("disc_number", { ascending: true })
        .order("track_number", { ascending: true });

      if (trackRows?.length > 0) {
        turntableTracksRef.current = trackRows.map(t => ({
          trackName: t.track_name,
          artistName: t.artist_name || artistName,
          collectionName: albumName,
          trackId: t.itunes_track_id || null,
          trackTimeMillis: t.duration_ms || null,
          trackNumber: t.track_number || 1,
          discNumber: t.disc_number || 1,
        }));

        setTurntableTracksProgress({ percent: 60, stage: "Loading lyrics…" });
        const { data: lrcRows } = await sb
          .from("track_lyrics")
          .select("itunes_track_id, lrc_raw, words_json, lyrics_plain")
          .in("itunes_track_id", trackRows.map(t => t.itunes_track_id).filter(Boolean));
        const cache = {};
        for (const row of lrcRows || []) {
          // Key as String() to guard against numeric vs string type mismatch.
          if (row.itunes_track_id) {
            // words_json is JSONB — on some Capacitor/WebView versions it can arrive
            // as a JSON string instead of a parsed array. Parse it defensively.
            let wordsJson = row.words_json || null;
            if (typeof wordsJson === "string") {
              try { wordsJson = JSON.parse(wordsJson); } catch { wordsJson = null; }
            }
            cache[String(row.itunes_track_id)] = {
              lrc_raw: row.lrc_raw || null,
              words_json: Array.isArray(wordsJson) ? wordsJson : null,
              lyrics_plain: row.lyrics_plain || null,
            };
          }
        }
        console.log("[turntable] lrcRows:", (lrcRows || []).length, "cache entries:", Object.keys(cache).length, "tracks:", trackRows.length);

        // Store in ref (not state) so startListeningSpeech can read it synchronously
        // without a re-render cycle. React state would be stale inside the closure.
        // We store the cached rows NOW (before any network gap-fill) so the user can
        // start listening immediately; gap-fill below mutates this same object.
        turntableLyricsCacheRef.current = cache;

        // ── Load vinyl side data from our own DB (fast) ──
        setTurntableTracksProgress({ percent: 90, stage: "Loading side data…" });

        // Primary: vinyl_sides — query by collection only, assign to tracks by sorted position index.
        // Track IDs in vinyl_sides may be synthetic Discogs values that don't match album_tracks IDs,
        // so we match positionally (sorted A1, A2…B1, B2…) rather than by ID.
        vinylSidesRef.current = []; // array indexed by track position, same order as trackRows
        {
          const { data: sidesRows } = await sb
            .from("vinyl_sides")
            .select("side, side_track_number, position")
            .eq("itunes_collection_id", collectionId)
            .order("side", { ascending: true })
            .order("side_track_number", { ascending: true });
          const seen = new Set();
          const sorted = [];
          for (const s of sidesRows || []) {
            const key = `${s.side}|${s.side_track_number}`;
            if (!seen.has(key)) { seen.add(key); sorted.push(s); }
          }
          // Only use if we have at least as many side rows as tracks (otherwise incomplete data)
          if (sorted.length >= trackRows.length) vinylSidesRef.current = sorted;
        }

        const dbRelease = await fetchVinylRelease(collectionId);
        if (dbRelease?.vinyl_tracks?.length > 0) {
          setVinylDbRelease(dbRelease);
          vinylDbReleaseRef.current = dbRelease;
        } else {
          setVinylDbRelease(null);
          vinylDbReleaseRef.current = null;
        }

        // ── The record is now playable — everything below is background enrichment ──
        // (lyric gap-fill over the network + Discogs side auto-populate). These used
        // to run synchronously and could hang for MINUTES on slow/rate-limited
        // requests, blocking the Listen button. They now run detached, with timeouts,
        // mutating the refs in place so a listen already in progress picks them up.
        setTurntableTracksLoading(false);
        setTurntableTracksProgress({ percent: 100, stage: "" });

        const missingTracks = trackRows.filter(t => t.itunes_track_id && !cache[String(t.itunes_track_id)]);
        (async () => {
          // Fill any missing lyrics from LRCLib (6s timeout each so one hung
          // connection can't stall the batch). Non-fatal — a track with no
          // lyrics just won't match.
          if (missingTracks.length > 0) {
            await Promise.all(missingTracks.map(async t => {
              try {
                const p = new URLSearchParams({ track_name: t.track_name, artist_name: t.artist_name || artistName, album_name: albumName });
                if (t.duration_ms) p.set("duration", String(Math.round(t.duration_ms / 1000)));
                const ac = new AbortController();
                const to = setTimeout(() => ac.abort(), 6000);
                const r = await fetch(`https://lrclib.net/api/get?${p}`, { headers: { "Lrclib-Client": "Liri/1.1 (https://getliri.com)" }, signal: ac.signal }).finally(() => clearTimeout(to));
                if (!r.ok) return;
                const d = await r.json();
                if (d?.syncedLyrics || d?.plainLyrics) {
                  cache[String(t.itunes_track_id)] = { lrc_raw: d.syncedLyrics || null, words_json: null, lyrics_plain: d.plainLyrics || null };
                }
              } catch {}
            }));
          }
          // If we still have no side data, try the Discogs auto-populate (slow —
          // sequential Discogs calls). Backgrounded so it never blocks listening.
          if (!vinylDbReleaseRef.current?.vinyl_tracks?.length && !vinylSidesRef.current.length) {
            try {
              await autoPopulateVinylSides(collectionId, albumName, artistName);
              const retry = await fetchVinylRelease(collectionId);
              if (retry?.vinyl_tracks?.length > 0) { setVinylDbRelease(retry); vinylDbReleaseRef.current = retry; }
            } catch {}
          }
        })();
        return; // loading already cleared; skip the trailing setters
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
  useEffect(() => {
    turntableAlbumRef.current = turntableAlbum;
    turntableMatchedIdxRef.current = -1; // reset stale match when album changes
    if (turntableAlbum) {
      localStorage.setItem("liri_turntable", JSON.stringify(turntableAlbum));
      fetchTurntableTracks(turntableAlbum.itunes_collection_id);
    } else {
      localStorage.removeItem("liri_turntable");
      turntableTracksRef.current = [];
      setTurntableTracksLoading(false);
    }
  }, [turntableAlbum]);

  // ── User's personal vinyl library (for the album picker) ──
  const fetchUserLibrary = async (uid, autoSelect = false) => {
    setLibLoading(true);
    try {
      const {
        data
      } = await sb.from("user_library").select("*, catalogue(album_name, artist_name, artwork_url, itunes_collection_id)").eq("user_id", uid).order("added_at", {
        ascending: false
      });
      const library = (data || []).map(row => ({
        ...row,
        album_name: row.catalogue?.album_name || row.album_name || "",
        artist_name: row.catalogue?.artist_name || row.artist_name || "",
        artwork_url: row.catalogue?.artwork_url || row.artwork_url || null,
      }));
      setUserLibrary(library);

      // If the saved album is no longer in the library (e.g. after data wipe), clear it
      if (library.length === 0) {
        setTurntableAlbum(null);
      } else {
        const saved = localStorage.getItem("liri_turntable");
        if (saved) {
          try {
            const parsed = JSON.parse(saved);
            const stillExists = library.some(a => String(a.itunes_collection_id) === String(parsed.itunes_collection_id));
            if (!stillExists) setTurntableAlbum(null);
          } catch {
            setTurntableAlbum(null);
          }
        }
      }

      // Auto-select most-played album when no album is set (first load only)
      if (autoSelect && !localStorage.getItem("liri_turntable") && library.length > 0) {
        const {
          data: plays
        } = await sb.from("listening_events").select("itunes_collection_id").eq("user_id", uid).not("itunes_collection_id", "is", null);
        if (plays?.length > 0) {
          const counts = {};
          for (const row of plays) counts[row.itunes_collection_id] = (counts[row.itunes_collection_id] || 0) + 1;
          const topId = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
          const topAlbum = library.find(a => String(a.itunes_collection_id) === String(topId));
          if (topAlbum) setTurntableAlbum({
            itunes_collection_id: topAlbum.itunes_collection_id,
            album_name: topAlbum.album_name,
            artist_name: topAlbum.artist_name,
            artwork_url: topAlbum.artwork_url
          });
        } else {
          // No play history — default to most recently added
          const a = library[0];
          setTurntableAlbum({
            itunes_collection_id: a.itunes_collection_id,
            album_name: a.album_name,
            artist_name: a.artist_name,
            artwork_url: a.artwork_url
          });
        }
      }
    } catch {}
    setLibLoading(false);
  };
  useEffect(() => {
    if (user) fetchUserLibrary(user.id, true);
  }, [user]);


  // ── Real-time seconds counter while listening (UI only — not tied to ACR attempts) ──
  useEffect(() => {
    if (mode !== "listening") {
      setListenSecs(0);
      setShowTrackList(false);
      return;
    }
    const id = setInterval(() => setListenSecs(s => s + 1), 1000);
    return () => clearInterval(id);
  }, [mode]);

  // ── Auto-start sync after detection ──
  useEffect(() => {
    if (mode === "confirmed" && detectedSong) {
      startSync();
      // Always re-enable auto-follow when a song is first confirmed
      userScrollingRef.current = false;
      setUserScrolling(false);
    }
  }, [mode, detectedSong]);

  // ── Silence gap detection: auto-advance track when vinyl gap is heard (iOS only) ──
  // Vinyl records have a ~1-2s silent gap between tracks. ShazamPlugin monitors mic
  // amplitude via waitForSilence() and we advance to the next track when it resolves.
  useEffect(() => {
    if (!window.Capacitor) return;
    if (mode !== "syncing") return;

    let cancelled = false;
    // Small delay so Shazam's audio session has time to fully tear down first
    const startTimer = setTimeout(async () => {
      if (cancelled) return;
      try {
        // waitForSilence resolves when a gap is detected or times out (5 min)
        const result = await Shazam.waitForSilence({ timeout: 300000 });
        if (cancelled || !result.silence) return;
        console.log("[silence] gap detected — advancing track");
        const tTracks = turntableTracksRef.current;
        const tIdx = turntableMatchedIdxRef.current;
        if (tTracks.length > 0 && tIdx >= 0 && tIdx < tTracks.length - 1) {
          advanceToNextTrack(tTracks, tIdx);
        }
      } catch (e) {
        console.warn("[silence] waitForSilence failed:", e);
      }
    }, 2000);

    return () => {
      cancelled = true;
      clearTimeout(startTimer);
      Shazam.cancel();
    };
  }, [mode]);

  // ── Scroll to current lyric (skip if user is manually browsing) ──
  useEffect(() => {
    if (userScrollingRef.current) return;
    if (currentLineRef.current && mode === "syncing") currentLineRef.current.scrollIntoView({
      behavior: "smooth",
      block: "center"
    });
  }, [currentIndex, mode]);

  // ── Tap-to-seek: jump sync to the tapped lyric line ──
  const seekToLine = i => {
    const targetTime = lyricsRef.current[i]?.time;
    if (targetTime == null) return;
    initialPosRef.current = targetTime;
    syncStartRef.current = Date.now();
    setCurrentIndex(i);
    setPlaybackTime(targetTime);
    userScrollingRef.current = false;
    setUserScrolling(false);
  };

  // ── Re-follow: re-enable auto-scroll and snap back to current line ──
  const refollow = () => {
    userScrollingRef.current = false;
    setUserScrolling(false);
    currentLineRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "center"
    });
  };

  // ── Scroll to credits once song passes the last lyric (outro roll) ──
  useEffect(() => {
    if (mode !== "syncing" || !lyrics.length) return;
    const lastTime = lyrics[lyrics.length - 1].time;
    if (playbackTime >= lastTime + 6 && creditsRef.current) creditsRef.current.scrollIntoView({
      behavior: "smooth",
      block: "center"
    });
  }, [Math.floor(playbackTime), mode, lyrics.length]);

  // ── Vinyl auto-advance: trigger when song nears its end ──
  useEffect(() => {
    if (mode !== "syncing") return;
    const lastLyricTime = lyrics.length > 0 ? lyrics[lyrics.length - 1].time : null;
    // Read duration from turntable track ref directly — more reliable than state
    // when songDuration hasn't updated yet for the new track.
    const tIdx = turntableMatchedIdxRef.current;
    const trackDuration = tIdx >= 0 ? (turntableTracksRef.current[tIdx]?.trackTimeMillis ?? 0) / 1000 || null : null;
    // Fallback: last lyric + 3s (was 30s — trimmed so same-side advance is immediate)
    const effectiveDuration = songDuration ?? trackDuration ?? (lastLyricTime ? lastLyricTime + 3 : null);
    if (!effectiveDuration) return;
    if (playbackTime >= effectiveDuration && !autoAdvanceFiredRef.current) {
      autoAdvanceFiredRef.current = true;
      setShouldAdvanceTrack(true);
    }
  }, [playbackTime, songDuration, lyrics, mode]);


  // ── Handle track advance (runs with fresh state) ──
  useEffect(() => {
    if (!shouldAdvanceTrack) return;
    setShouldAdvanceTrack(false);
    // Prefer turntable tracks — already loaded, correct version (no fetchAlbumTracks race)
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

  // ── Cleanup on unmount ──
  useEffect(() => () => {
    clearInterval(syncIntervalRef.current);
    clearInterval(progressTimerRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
  }, []);

  // ── Cancel flip chimes whenever we leave the side-end screen ──
  useEffect(() => {
    if (mode !== "side-end") cancelFlipChimes();
  }, [mode]);

  // ── Process a confirmed match — update all app state ──
  const handleMatch = async (data, isAutoAdvance) => {
    const m = data.metadata.music[0];
    const duration = m.duration_ms ? m.duration_ms / 1000 : null;
    const acrScore = m.score || null;
    const acrGenre = m.genres?.[0]?.name || null;
    const countryCode = data._liri?.country_code || null;

    // Store components for deferred timing calc in startSync.
    // play_offset_ms = song position at the START of the recorded clip.
    // phraseOffset = 0 (ACR timestamps the clip start, not a word position).
    // recStart = when recording began — startSync will add full elapsed time.
    detectedAtRef.current = recordingStartRef.current || Date.now();
    syncCalcRef.current = {
      startPos: (m.play_offset_ms || 0) / 1000,
      phraseOffset: 0,
      recStart: detectedAtRef.current
    };
    initialPosRef.current = (m.play_offset_ms || 0) / 1000; // rough estimate until startSync
    autoAdvanceFiredRef.current = false;
    autoRetryCountRef.current = 0;
    const spotifyArt = m.external_metadata?.spotify?.album?.images?.[0]?.url || null;
    const title = m.title;
    const artist = m.artists?.[0]?.name || "Unknown Artist";

    // Fetch artwork in background — don't block lyrics on an iTunes round-trip
    const artwork = spotifyArt || null;
    if (!spotifyArt) {
      fetch(`${ITUNES_PROXY}?term=${encodeURIComponent(artist + " " + title)}&entity=song&limit=1`).then(r => r.json()).then(itunes => {
        const art = itunes.results?.[0]?.artworkUrl100?.replace("100x100bb", "600x600bb") || null;
        if (art) setDetectedSong(s => s ? {
          ...s,
          artwork: art
        } : s);
      }).catch(() => {});
    }
    const song = {
      title,
      artist,
      album: m.album?.name || "",
      artwork
    };
    setDetectedSong(song);
    setIdentifiedBy("acr");
    lastRawMatchRef.current = { title, artist, identified_by: "acr" };
    setSongDuration(duration);
    await loadLyrics(title, artist);
    setMode("confirmed"); // triggers startSync immediately after lyrics are ready

    saveToHistory(user, song);
    fetchHistory(user);
    // cast removed
    fetchAlbumTracks(title, artist).then(async ({
      tracks,
      collectionId
    }) => {
      setAlbumTracks(tracks);
      setAlbumCollectionId(collectionId);
      const tIdx = tracks.findIndex(t => t.trackName?.toLowerCase() === title.toLowerCase());
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
        offsetSecs: (m.play_offset_ms || 0) / 1000,
        durationSecs: duration,
        acrScore
      });
      maybeAutoPostPlay({ userId: user?.id, collectionId, album: song.album, artist, artwork: song.artwork });
      if (!collectionId || tracks.length === 0) return;
      const dbRelease = await fetchVinylRelease(collectionId);
      if (dbRelease?.vinyl_tracks?.length > 0) {
        setVinylDbRelease(dbRelease);
        albumTpsRef.current = 0;
        return;
      }
      // No Discogs data yet — kick off a background fetch so it's ready next listen.
      autoPopulateVinylSides(collectionId, song.album, artist).catch(() => {});
      const stored = getAlbumSideData(collectionId);
      if (stored?.tps) {
        albumTpsRef.current = stored.tps;
        return;
      }
      albumTpsRef.current = 0;
    }).catch(() => {});
  };

  // ── Vinyl-aware track matching ──────────────────────────────────────────────
  // When the user has told us what album is on the turntable, fetch LRC lyrics
  // for ALL tracks in parallel and score the Whisper transcript against each.
  // Returns { track, lrcMatch, lyrics, startPos, score } or null.
  // Skips GPT entirely — much more accurate for obscure / re-recorded albums.
  // ── Unique consecutive-word match against cached lyrics ──
  // Tries word runs from 1 upward — shortest unique run wins.
  // A single rare word is enough if it appears in only one track.
  // Pure in-memory, no network calls.
  const matchTranscriptToTracks = (transcript, tracks, wordsData, logRef) => {
    // Normalise a single word: lowercase, strip non-alphanumeric except apostrophe
    const normWord = w => w.toLowerCase().replace(/[^a-z0-9']/g, "");

    // Fuzzy word equality: allow small edit-distance for Whisper transcription noise
    // Short words (≤3 chars) must match exactly — too risky to fuzz "I", "me", "the"
    // Medium words (4-6 chars): allow 1 edit; long words (7+): allow 2 edits
    const editDist = (a, b) => {
      if (Math.abs(a.length - b.length) > 2) return 99;
      const dp = Array.from({length: a.length + 1}, (_, i) => i);
      for (let j = 1; j <= b.length; j++) {
        let prev = dp[0]; dp[0] = j;
        for (let i = 1; i <= a.length; i++) {
          const temp = dp[i];
          dp[i] = a[i-1] === b[j-1] ? prev : 1 + Math.min(prev, dp[i], dp[i-1]);
          prev = temp;
        }
      }
      return dp[a.length];
    };
    const fuzzyEq = (a, b) => {
      if (a === b) return true;
      if (!a || !b) return false;
      if (a.length <= 3 || b.length <= 3) return false; // short words: exact only
      return editDist(a, b) <= (a.length <= 6 ? 1 : 2);
    };
    const heardWords = transcript.toLowerCase().split(/\s+/).map(normWord).filter(w => w.length > 1);
    if (logRef) logRef.push(`match: ${heardWords.length} words from transcript`);
    if (!heardWords.length) return null;

    // baseName strips suffixes like "(live)", "[bonus track]", "(remastered)" etc.
    // Albums that include both a studio take and a live/session version of the same
    // song would otherwise have two tracks with identical word sets. Without this
    // deduplication both tracks would match the same phrase, producing hits.length > 1
    // and breaking the uniqueness requirement. seenNames ensures only the FIRST
    // occurrence (by track order from the DB) is used as the canonical version.
    const baseName = n => (n || "").toLowerCase().replace(/\s*[\(\[].*/, "").trim();
    const seenNames = new Set();

    // Build per-track word arrays from words_json stored in Supabase
    const tracksWithWords = tracks.map(t => {
      const data = wordsData[t.trackId];
      if (!data?.words?.length) return null;
      const base = baseName(t.trackName);
      if (seenNames.has(base)) return null; // skip duplicates
      seenNames.add(base);
      return {
        ...t,
        wordArr: data.words.map(w => w.word), // already normalised at store time
        wordTimings: data.words,               // [{word, start_ms}] for position lookup
        lrc_raw: data.lrc_raw,
        lyrics_plain: data.lyrics_plain,
      };
    }).filter(Boolean);

    if (logRef) logRef.push(`match: ${tracksWithWords.length}/${tracks.length} tracks have lyrics`);
    console.log("[match] tracksWithWords:", tracksWithWords.length, "/", tracks.length, "| heardWords:", heardWords.slice(0, 8).join(" "));
    if (tracksWithWords.length > 0) console.log("[match] sample track words:", tracksWithWords[0]?.trackName, tracksWithWords[0]?.wordArr?.slice(0, 10));
    if (!tracksWithWords.length) return null;

    // MIN_RUN = 4: require at least 4 consecutive matching words before committing.
    // Why 4 and not lower?
    //   1-word match: too many false positives — common words like "love" appear in
    //     almost every track on the album.
    //   2-3 word match: still ambiguous on pop albums with similar lyric vocabulary.
    //   4+ word match: in practice almost always unique within an album AND across
    //     repeated choruses within a single track (uniqueness-within-track is also
    //     required — count > 1 → rejected).
    // Why not higher? Longer runs mean the user has to hold the mic for longer before
    // anything happens, degrading perceived responsiveness. 4 words ≈ 1–2 seconds of
    // speech, which feels instant.
    const MIN_RUN = 3; // 3 consecutive fuzzy-matching words is enough within a single album

    // Scan all possible windows of length MIN_RUN upward through the transcript.
    // Stops at the SHORTEST run that satisfies BOTH:
    //   (a) appears in exactly ONE track in the album (uniqueness across tracks)
    //   (b) appears exactly ONCE inside that track (not a repeated chorus fragment)
    // Requiring exactly-one-track (not "best scoring track") is intentional — if we
    // accepted a best-guess the lyrics display would start at the wrong song entirely
    // with no error shown to the user. Forcing strict uniqueness means we keep
    // listening until we are certain, which is always the right trade-off here.
    for (let len = MIN_RUN; len <= heardWords.length; len++) {
      for (let start = 0; start <= heardWords.length - len; start++) {
        const phrase = heardWords.slice(start, start + len);

        const hits = tracksWithWords.filter(t => {
          let count = 0;
          const arr = t.wordArr;
          for (let i = 0; i <= arr.length - len; i++) {
            let ok = true;
            for (let j = 0; j < len; j++) {
              if (!fuzzyEq(arr[i + j], phrase[j])) { ok = false; break; }
            }
            if (ok) { count++; if (count > 1) return false; } // repeats within track → not unique enough
          }
          return count === 1;
        });

        if (hits.length !== 1) continue; // not unique across tracks

        const match = hits[0];

        // Find the position (in seconds) of the matched phrase in this track.
        // matchWordIdx is the index into match.wordTimings of the first word of the
        // matched phrase. start_ms / 1000 gives the lyric display start position.
        // This is also returned as startPos, which flows into the sync offset formula
        // in startSync / startListeningSpeech.
        let matchWordIdx = -1;
        const arr = match.wordArr;
        for (let i = 0; i <= arr.length - len; i++) {
          let ok = true;
          for (let j = 0; j < len; j++) {
            if (!fuzzyEq(arr[i + j], phrase[j])) { ok = false; break; }
          }
          if (ok) { matchWordIdx = i; break; }
        }
        const startPos = matchWordIdx >= 0 ? (match.wordTimings[matchWordIdx].start_ms / 1000) : 0;

        // Build lyrics array for display — prefer timestamped LRC, fall back to plain
        const lyrics = match.lrc_raw
          ? parseLRC(match.lrc_raw)
          : (match.lyrics_plain || "").split("\n").filter(l => l.trim()).map((text, i) => ({ time: i * 4, text }));

        if (logRef) logRef.push(`match: unique run (${len}w) → "${match.trackName}" at ${startPos.toFixed(1)}s`);

        // phraseWordStart: the index (in heardWords[]) of the first word of the
        // matched phrase. Returned so the caller can calculate how far into the
        // live transcript the match landed — used in _phraseOffset to estimate how
        // many seconds of audio had already played before the matching words were
        // spoken. Without this, sync always assumes the match happened at the very
        // end of the recording window, causing a consistent early-offset bug.
        return { track: match, lyrics, startPos, score: len, phraseWordStart: start, totalWords: heardWords.length };
      }
    }

    if (logRef) logRef.push(`match: no unique run yet — keep listening`);
    return null;
  };

  // ── Analytics: log a button tap (resync / wrong_song) to button_events ──
  const logButtonEvent = async (buttonName) => {
    try {
      const raw = lastRawMatchRef.current;
      await sb.from("button_events").insert({
        user_id: user?.id || null,
        session_id: sessionId,
        button_name: buttonName,
        track_title: detectedSong?.title || null,
        artist_name: detectedSong?.artist || null,
        album_name: detectedSong?.album || null,
        itunes_collection_id: albumCollectionIdRef?.current ? Number(albumCollectionIdRef.current) : null,
        platform: window.Capacitor ? "ios" : "web",
        identified_by: raw?.identified_by || null,
        raw_match_title: raw?.title || null,
        raw_match_artist: raw?.artist || null,
      });
    } catch (e) { /* silently ignore — table may not exist yet */ }
  };

  // ── Handle final recognition failure ──
  const handleNoMatch = (isAutoAdvance, stage = "acr") => {
    if (isAutoAdvance) {
      autoRetryCountRef.current += 1;
      if (autoRetryCountRef.current < 2) {
        setTimeout(() => startListening(true), 4000);
      } else {
        autoRetryCountRef.current = 0;
        setSideEndReason("failed");
        if (detectedSong) setLastSong(detectedSong);
        setMode("side-end");
      }
    } else {
      const log = attemptLogRef.current;
      const summary = log.length ? log.join("\n") : "No attempts logged";
      setError(`No match found\n\n${summary}\n\nMove closer to your speakers and try again.`);
      setMode("error");
    }
  };

  const MAX_ATTEMPTS = 6; // used in listening UI progress display

  // ── Turntable mode: real-time speech recognition → lyric word match ──────────
  // When an album is selected in the library, Liri already has all lyrics cached.
  // Instead of recording + sending to ACRCloud/Whisper, we use the Web Speech API
  // to transcribe words in real time and match them against the known lyrics.
  // No server calls, no delays — match fires the moment enough words are recognised.
const startListeningSpeech = async (isAutoAdvance = false) => {
    // Unlock the chime AudioContext during this user-gesture window so it can
    // play later (auto-advance) without being blocked by autoplay policy.
    if (!isAutoAdvance) {
      try {
        if (!chimeCtxRef.current) {
          chimeCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
        } else if (chimeCtxRef.current.state === "suspended") {
          chimeCtxRef.current.resume();
        }
      } catch {}
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
    if (!tracks.length) { setError("Album tracks still loading — try again in a moment."); setMode("error"); return; }

    const lrcCache = turntableLyricsCacheRef.current;
    const isNative = !!window.Capacitor; // bridge is available by call time even if isNativePlatform() isn't

    // Build wordsData so resync (Whisper-based fine-tune) can match against lyrics
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
            if (word) words.push({ word, start_ms: Math.round(line.time * 1000) });
          }
        }
      }
      if (!words.length && entry.lyrics_plain) {
        entry.lyrics_plain.split("\n").filter(l => l.trim()).forEach((line, li) => {
          for (const raw of line.split(/\s+/)) {
            const word = raw.toLowerCase().replace(/[^a-z0-9']/g, "");
            if (word) words.push({ word, start_ms: li * 4000 });
          }
        });
      }
      wordsData[track.trackId] = { words, lrc_raw: entry.lrc_raw, lyrics_plain: entry.lyrics_plain };
    }
    wordsDataRef.current = wordsData;

    // ── Web: no fingerprinting available — show track list inside idle screen ───
    // Keep mode as "idle" so the idle container (which holds the track picker)
    // stays mounted. Setting mode to "listening" earlier would unmount it.
    if (!isNative) {
      setMode("idle");
      setShowTrackList(true);
      speechRecRef.current = { stop: () => {} };
      return;
    }

    // ── iOS: ShazamKit audio fingerprinting ──────────────────────────────────────
    // ShazamKit handles mic capture internally, so we don't open a MediaRecorder.
    // It returns the matched song title + predictedCurrentMatchOffset (seconds into
    // the track). We find the track in the album, look up its lyrics, and sync.

    const pulseId = setInterval(() => setAudioLevel(0.15 + Math.sin(Date.now() / 400) * 0.1), 80);

    const stopShazam = () => {
      clearInterval(pulseId);
      setAudioLevel(0);
      Shazam.cancel();
    };
    speechRecRef.current = { stop: stopShazam };

    // Helper: build lyrics array from the cached entry for a given track
    const buildLyrics = (track) => {
      const entry = lrcCache[String(track.trackId)];
      if (!entry) return [];
      if (entry.lrc_raw) return parseLRC(entry.lrc_raw);
      return (entry.lyrics_plain || "").split("\n").filter(l => l.trim()).map((text, i) => ({ time: i * 4, text }));
    };

    // Helper: commit a Shazam match — sets all state and transitions to "confirmed"
    const commitShazamMatch = (track, offsetSecs) => {
      if (listenSessionRef.current !== session || recognitionWonRef.current) return;
      recognitionWonRef.current = true;
      stopShazam();
      const ta = turntableAlbumRef.current;
      const matchedIdx = tracks.indexOf(track);
      turntableMatchedIdxRef.current = matchedIdx >= 0 ? matchedIdx : 0;
      const song = { title: track.trackName, artist: track.artistName || ta?.artist_name || "", album: ta?.album_name || "", artwork: ta?.artwork_url || null };
      const lyrics = buildLyrics(track);
      setIdentifiedBy("shazam");
      detectedAtRef.current = Date.now();
      syncCalcRef.current = { startPos: offsetSecs, phraseOffset: 0, recStart: Date.now() };
      initialPosRef.current = offsetSecs;
      autoAdvanceFiredRef.current = false;
      autoRetryCountRef.current = 0;
      setDetectedSong(song);
      setSongDuration(track.trackTimeMillis ? track.trackTimeMillis / 1000 : null);
      setLyrics(lyrics);
      lyricsRef.current = lyrics;
      setMode("confirmed");
      saveToHistory(user, song);
      fetchHistory(user);
      logListeningEvent({ userId: user?.id, title: track.trackName, artist: track.artistName || ta?.artist_name || "", album: ta?.album_name || "", artwork: ta?.artwork_url || null, itunesTrackId: track.trackId, collectionId: ta?.itunes_collection_id || track.collectionId, vinylReleaseId: null, vinylModeOn: true, source: "shazam", offsetSecs, durationSecs: track.trackTimeMillis ? track.trackTimeMillis / 1000 : null });
      maybeAutoPostPlay({ userId: user?.id, collectionId: ta?.itunes_collection_id || track.collectionId, album: ta?.album_name || "", artist: track.artistName || ta?.artist_name || "", artwork: ta?.artwork_url || null });
      const at = turntableTracksRef.current;
      setAlbumTracks(at);
      setAlbumCollectionId(ta?.itunes_collection_id ? String(ta.itunes_collection_id) : null);
      setCurrentTrackIndex(matchedIdx >= 0 ? matchedIdx : 0);
    };

    // ── Call findMatch — a single long-running promise (same pattern as NativeAudio.record) ──
    // Resolves with { matched: true, title, artist, offset, matchTime } or { matched: false }
    try {
      const result = await Shazam.findMatch({ timeout: 15000 });
      if (listenSessionRef.current !== session) return; // session changed while we waited

      if (!result.matched) {
        // Timeout with no match — show track list
        clearInterval(pulseId);
        setAudioLevel(0);
        setShowTrackList(true);
        return;
      }

      const { title, artist, offset, matchTime } = result;
      console.log("[shazam] match:", title, "by", artist, "offset:", Number(offset).toFixed(1) + "s");
      lastRawMatchRef.current = { title, artist, identified_by: "shazam" };

      // Adjust offset for time elapsed between Shazam capturing and JS receiving result
      const elapsed = (Date.now() - matchTime) / 1000;
      const adjustedOffset = Math.max(0, offset + elapsed);

      // Find the matched track within the selected album.
      // Strip ALL non-alphanumeric chars so curly vs straight apostrophes (' vs '),
      // dashes, parens, etc. don't break the lookup — Shazam/Apple Music titles use
      // curly punctuation, library titles may differ.
      // Fuzzy includes only fires when the shorter string is ≥60% the length of the
      // longer one — prevents "Hell" from matching "Hell Hath No Fury".
      const norm = normText;
      const fuzzyIncludes = (a, b) => {
        const [longer, shorter] = a.length >= b.length ? [a, b] : [b, a];
        return longer.includes(shorter) && shorter.length / longer.length >= 0.6;
      };
      const matchedTrack =
        tracks.find(t => norm(t.trackName) === norm(title)) ||
        tracks.find(t => fuzzyIncludes(norm(title), norm(t.trackName)) && norm(t.trackName).length > 3) ||
        tracks.find(t => fuzzyIncludes(norm(t.trackName), norm(title)) && norm(title).length > 3);

      if (!matchedTrack) {
        console.log("[shazam] matched title not in album:", title, "— showing track list");
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
    // Load from track_lyrics table (pre-fetched when album was added to library)
    try {
      if (trackId) {
        const { data } = await sb
          .from("track_lyrics")
          .select("lrc_raw, lyrics_plain")
          .eq("itunes_track_id", trackId)
          .maybeSingle();
        if (data?.lrc_raw) {
          const parsed = parseLRC(data.lrc_raw);
          setLyrics(parsed);
          lyricsRef.current = parsed;
          return;
        }
        if (data?.lyrics_plain) {
          const parsed = data.lyrics_plain.split("\n").filter(l => l.trim()).map((text, i) => ({ time: i * 4, text }));
          setLyrics(parsed);
          lyricsRef.current = parsed;
          return;
        }
      }
    } catch {}
    setLyrics([]);
    lyricsRef.current = [];
  };
  const startSync = useCallback(() => {
    // Safe to re-arm auto-advance now — new sync is actually starting
    autoAdvanceFiredRef.current = false;

    // syncCalcRef deferred timing calculation.
    // Why defer? When a match fires in onresult the React state update ("confirmed")
    // triggers a useEffect that calls startSync. By the time startSync actually runs,
    // (Date.now() - recStart) includes:
    //   • the time spent in the onresult handler
    //   • React's reconciliation + paint cycle
    //   • any Whisper API round-trip (for ACR-path matches)
    // …which can add up to ~0.5–1.5 s beyond what the elapsed calculation inside
    // onresult captured. By storing {startPos, phraseOffset, recStart} in syncCalcRef
    // and doing the final arithmetic HERE (rather than in onresult), the full latency
    // budget is automatically accounted for, producing a position that is consistently
    // in sync with what the speakers are actually playing.
    //
    // Formula: initialPos = startPos - phraseOffset + (Date.now() - recStart) / 1000
    //   startPos      — position in the track (seconds) where the matched phrase lives
    //   phraseOffset  — estimate of how far into the recording window the phrase started
    //                   (so we subtract it to roll back to the beginning of the window)
    //   elapsed       — total wall time since the mic opened, measured right now
    //
    // Net result: we land at the position in the track that corresponds to "right now",
    // not "when the match callback ran".
    if (syncCalcRef.current) {
      const {
        startPos,
        phraseOffset,
        recStart
      } = syncCalcRef.current;
      syncCalcRef.current = null;
      initialPosRef.current = Math.max(0, startPos - phraseOffset + (Date.now() - recStart) / 1000);
    }
    // Manual flip: park playbackTime at 0 while the user drops the needle.
    // We start the clock in the "past" so (Date.now() - syncStart)/1000 is
    // negative for the delay window; the interval below clamps display to 0.
    if (flipStartDelayMsRef.current > 0) {
      initialPosRef.current = -flipStartDelayMsRef.current / 1000;
      flipStartDelayMsRef.current = 0;
    }
    syncStartRef.current = Date.now();
    // Jump to correct starting index immediately so the scroll effect lands on the right
    // line without smooth-scrolling from 0 (which caused a ~3s visual lag on load).
    // Use -1 as sentinel when we're still in the intro (before the first lyric timestamp).
    const lrc0 = lyricsRef.current;
    const t0 = initialPosRef.current;
    let initIdx = -1;
    if (lrc0.length > 0 && t0 >= lrc0[0].time) {
      for (let i = 0; i < lrc0.length; i++) {
        if (lrc0[i].time <= t0) initIdx = i;else break;
      }
    }
    setMode("syncing");
    setCurrentIndex(initIdx);
    // A new sync is always live playback — clear any stale pause state so the
    // pause toggle stays consistent after skipping a track while paused.
    setIsPaused(false);
    clearInterval(syncIntervalRef.current);
    syncIntervalRef.current = setInterval(() => {
      const t = initialPosRef.current + (Date.now() - syncStartRef.current) / 1000;
      // Clamp displayed time to 0 during the manual-flip pause window.
      setPlaybackTime(t < 0 ? 0 : t);
      const lrc = lyricsRef.current;
      if (!lrc.length) return;
      // Stay at -1 (no highlight) until playback reaches the first lyric timestamp
      if (t < lrc[0].time) {
        setCurrentIndex(-1);
        return;
      }
      let idx = 0;
      for (let i = 0; i < lrc.length; i++) {
        if (lrc[i].time <= t) idx = i;else break;
      }
      setCurrentIndex(idx);
    }, 80);
  }, []);
  const togglePause = () => {
    if (isPaused) {
      // Resume: restart sync from current position
      initialPosRef.current = playbackTime;
      syncStartRef.current = Date.now();
      clearInterval(syncIntervalRef.current); // never leak a second interval
      syncIntervalRef.current = setInterval(() => {
        const t = initialPosRef.current + (Date.now() - syncStartRef.current) / 1000;
        setPlaybackTime(t);
        const lrc = lyricsRef.current;
        if (!lrc.length) return;
        if (t < lrc[0].time) {
          setCurrentIndex(-1);
          return;
        }
        let idx = 0;
        for (let i = 0; i < lrc.length; i++) {
          if (lrc[i].time <= t) idx = i;else break;
        }
        setCurrentIndex(idx);
      }, 80);
      setIsPaused(false);
    } else {
      // Pause: freeze lyrics at current position
      clearInterval(syncIntervalRef.current);
      setIsPaused(true);
    }
  };
  const nudge = s => {
    userNudgeRef.current += s;
    initialPosRef.current = Math.max(0, initialPosRef.current + s);
  };
  const handleNudge = s => {
    nudge(s);
    const side = s < 0 ? "left" : "right";
    clearTimeout(nudgeMenuTimerRef.current);
    setNudgeMenu(side);
    nudgeMenuTimerRef.current = setTimeout(() => setNudgeMenu(null), 2500);
  };

  const showKbToast = msg => {
    clearTimeout(kbToastTimerRef.current);
    setKbToast(msg);
    kbToastTimerRef.current = setTimeout(() => setKbToast(null), 1400);
  };

  useEffect(() => {
    const onKey = e => {
      if (mode !== "syncing") return;
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        nudge(-1);
        showKbToast("← −1s");
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        nudge(1);
        showKbToast("→ +1s");
      } else if (e.key === " ") {
        e.preventDefault();
        togglePause();
        showKbToast(isPaused ? "▶ Resume" : "⏸ Pause");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, isPaused]);

  // Fetch album tracklist
  const fetchAlbumTracks = async (title, artist) => {
    try {
      const search = await fetch(`${ITUNES_PROXY}?term=${encodeURIComponent(artist + " " + title)}&entity=song&limit=10`).then(r => r.json());
      const results = (search.results || []).filter(r => r.wrapperType === "track");
      if (!results.length) return {
        tracks: [],
        collectionId: null
      };
      // Prefer the LP: sort by trackCount descending so we get the full album
      // rather than a single (which would only have 1–2 tracks and break side detection)
      results.sort((a, b) => (b.trackCount || 0) - (a.trackCount || 0));
      const hit = results[0];
      if (!hit?.collectionId) return {
        tracks: [],
        collectionId: null
      };
      const lookup = await fetch(`${ITUNES_PROXY}?id=${hit.collectionId}&entity=song`).then(r => r.json());
      const tracks = (lookup.results || []).filter(t => t.wrapperType === "track").sort((a, b) => a.trackNumber - b.trackNumber);
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

  // ── Determine side-flip points ──
  // Returns an array of track indices that are the LAST track of each side.
  // e.g. for 12 tracks / 3 per side → [2, 5, 8, 11]
  // tracksPerSide=0 means auto-detect via duration (assumes 2 sides).
  // Returns { side: "A", track: 2 } for the current position when vinyl mode is on.
  // Uses Liri DB side data if available, otherwise derives from getSideEndIndices.
  // Derives a small helper from an index + track array — no state needed.
  const deriveSideFromIndex = (idx, tracks) => {
    if (tracks.length === 0 || idx < 0) return null;
    const t = tracks[idx];
    // Multi-disc release (e.g. 2-LP set): split each disc in half for A/B, C/D, E/F…
    const hasMultiDisc = tracks.some(x => x.discNumber > 1);
    if (hasMultiDisc && t?.discNumber) {
      const discTracks = tracks.filter(x => x.discNumber === t.discNumber).sort((a, b) => a.trackNumber - b.trackNumber);
      const posInDisc = discTracks.findIndex(x => x.trackId === t.trackId);
      // Find duration midpoint of this disc
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
    // Single-disc: split by cumulative duration
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

  // ── SOURCE OF TRUTH for side/track display ──────────────────────────────
  // This is the single source of truth for which side + track the user is on.
  // library.html uses the same norm() function and the same isSequential logic
  // to merge Discogs data — if you change the logic here, update library.html too.
  const getSideInfo = () => {
    // Resolve a vinyl DB entry for a given iTunes track name + 0-based index.
    // Handles sequential Discogs numbering (B5, F23 → match by index) vs per-side (B1, B2 → match by title).
    const resolveVinylTrack = (trackName, idx, vinylTracks) => {
      if (!vinylTracks?.length) return null;
      const maxNum = Math.max(...vinylTracks.map(v => v.track_number_on_side || 0));
      const isSeq = maxNum > 0 && maxNum === vinylTracks.length;
      if (isSeq) return vinylTracks.find(v => v.track_number_on_side === idx + 1) || null;
      return vinylTracks.find(v => normTitle(v.title) === normTitle(trackName)) || vinylTracks.find(v => v.track_number_on_side === idx + 1) || null;
    };

    // Convert a vinyl DB row to { side, track } for display.
    // For sequential numbering, recounts per-side position (B5 is shown as Side B · track 1).
    const vinylTrackToSideInfo = (vt, vinylTracks) => {
      if (!vt?.side) return null;
      const maxNum = Math.max(...vinylTracks.map(v => v.track_number_on_side || 0));
      const isSeq = maxNum > 0 && maxNum === vinylTracks.length;
      const track = isSeq ? vinylTracks.filter(v => v.side === vt.side && v.track_number_on_side <= vt.track_number_on_side).length : vt.track_number_on_side;
      return {
        side: vt.side.toUpperCase(),
        track
      };
    };

    // ── Path 2 first: Turntable mode — album pre-selected, track matched by vinyl-aware scan ──
    // Must check this before Path 1 — fetchAlbumTracks may load the wrong album version
    // (e.g. original instead of Taylor's Version) and produce the wrong track index.
    const tTracks = turntableTracksRef.current;
    const tIdx = turntableMatchedIdxRef.current;
    if (turntableAlbum && tTracks.length > 0 && tIdx >= 0) {
      // Primary: vinyl_sides positional array (same source as library.html)
      const sideRow = vinylSidesRef.current[tIdx];
      if (sideRow?.side) return { side: sideRow.side.toUpperCase(), track: sideRow.side_track_number };
      // Secondary: vinyl_tracks (Discogs title match)
      const vinylTracks = vinylDbRelease?.vinyl_tracks;
      if (vinylTracks?.length > 0) {
        const vt = resolveVinylTrack(tTracks[tIdx]?.trackName, tIdx, vinylTracks);
        const si = vinylTrackToSideInfo(vt, vinylTracks);
        if (si) return si;
      }
      return deriveSideFromIndex(tIdx, tTracks) || { track: tIdx + 1 };
    }

    // ── Path 1: Full vinyl auto-mode — albumTracks + currentTrackIndex ──
    if (albumTracks.length > 0 && currentTrackIndex >= 0) {
      const vinylTracks = vinylDbRelease?.vinyl_tracks;
      if (vinylTracks?.length > 0) {
        const vt = resolveVinylTrack(albumTracks[currentTrackIndex]?.trackName, currentTrackIndex, vinylTracks);
        const si = vinylTrackToSideInfo(vt, vinylTracks);
        if (si) return si;
      }
      // No DB data — derive side from duration heuristic
      return deriveSideFromIndex(currentTrackIndex, albumTracks) || {
        track: currentTrackIndex + 1
      };
    }
    return null;
  };
  // Returns side-end indices from vinylSidesRef array (same source as library.html).
  // A track is a side end when the next track has a different side letter.
  // Returns null when the array is empty so callers can fall back to heuristic.
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
      // User told us exactly how many tracks per side
      const ends = [];
      for (let i = tps - 1; i < tracks.length; i += tps) ends.push(i);
      // Make sure the last track of the album is always included
      if (ends[ends.length - 1] !== tracks.length - 1) ends.push(tracks.length - 1);
      return ends;
    }
    // Short releases (singles, EPs ≤4 tracks) are single-sided — just mark album-end
    if (tracks.length <= 4) return [tracks.length - 1];
    // Estimate number of sides from total runtime: typical vinyl side = ~20 min
    const totalMs = tracks.reduce((s, t) => s + (t.trackTimeMillis || 0), 0);
    const SIDE_MS = 20 * 60 * 1000;
    const numSides = totalMs > 0 ? Math.max(2, Math.round(totalMs / SIDE_MS)) : 2;
    if (!totalMs) {
      // No duration data — split evenly by track count
      const perSide = Math.ceil(tracks.length / numSides);
      const ends = [];
      for (let i = perSide - 1; i < tracks.length - 1; i += perSide) ends.push(i);
      ends.push(tracks.length - 1);
      return ends;
    }
    // Split by cumulative duration, targeting totalMs/numSides per side
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

  // ── Advance to the next track using the known tracklist (no re-listening) ──
  const advanceToNextTrack = async (tracks, idx) => {
    const nextIdx = idx + 1;

    // Stop the running sync interval immediately so stale playbackTime values
    // can't trigger a false auto-advance on the incoming track. Reset the
    // display to 0 so the UI reflects the new track from the start.
    clearInterval(syncIntervalRef.current);
    setPlaybackTime(0);

    // Priority: vinyl_sides (same source as library.html) → vinyl_tracks (Discogs title match) → heuristic
    const dbRelease = vinylDbReleaseRef.current;
    const effectiveTps = albumTpsRef.current > 0 ? albumTpsRef.current : 0;
    const sideEnds = getSideEndsFromSidesMap(tracks, vinylSidesRef.current)
      ?? (dbRelease?.vinyl_tracks?.length > 0 ? getDbSideEndIndices(tracks, dbRelease.vinyl_tracks) : getSideEndIndices(tracks, effectiveTps));
    const isLastTrack = idx === tracks.length - 1;
    const isSideEnd = sideEnds.includes(idx);
    if (isLastTrack) {
      showAlbumEndPushNotification(detectedSong);
      setSideEndReason("album-end");
      if (detectedSong) setLastSong(detectedSong);
      // Let the last lyric linger for a beat before showing the album-end card.
      setTimeout(() => setMode("side-end"), 4000);
      return;
    }
    if (isSideEnd) {
      setSideEndNextDiscInfo(getNextDiscInfo());
      setSideEndReason("flip");
      // Chime ~3s after the flip card appears (≈7s from song end).
      scheduleFlipChimes(detectedSong);

      // ── Log the flip event to analytics ──
      const sideIdx = sideEnds.indexOf(idx); // 0 = first flip (A→B), 1 = B→C, etc.
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
      // Let the last lyric linger for a beat before showing the flip card.
      setTimeout(() => setMode("side-end"), 4000);
      return;
    }
    const next = tracks[nextIdx];
    const nextTitle = next.trackName;
    const nextArtist = next.artistName || detectedSong?.artist || "";
    const nextArtwork = next.artworkUrl100?.replace("100x100bb", "600x600bb") || detectedSong?.artwork;
    const nextDuration = next.trackTimeMillis ? next.trackTimeMillis / 1000 : null;
    const nextSong = {
      title: nextTitle,
      artist: nextArtist,
      album: next.collectionName || "",
      artwork: nextArtwork
    };
    setCurrentTrackIndex(nextIdx);
    turntableMatchedIdxRef.current = nextIdx; // keep turntable index in sync
    detectedAtRef.current = Date.now();
    setDetectedSong(nextSong);
    setSongDuration(nextDuration);
    // Load lyrics from wordsDataRef (fetched from track_lyrics at listen start)
    const nextTrackData = wordsDataRef.current?.[next.trackId];
    if (nextTrackData?.lrc_raw) {
      const parsed = parseLRC(nextTrackData.lrc_raw);
      setLyrics(parsed);
      lyricsRef.current = parsed;
    } else if (nextTrackData?.lyrics_plain) {
      const parsed = nextTrackData.lyrics_plain.split("\n").filter(l => l.trim()).map((text, i) => ({ time: i * 4, text }));
      setLyrics(parsed);
      lyricsRef.current = parsed;
    } else {
      setLyrics([]);
      lyricsRef.current = [];
    }

    // Auto-advance always starts the new track from second 0 — we know exactly
    // where the needle is. Store a syncCalcRef so startSync accounts for the
    // React render delay between here and when the interval actually begins
    // (same deferred-timing pattern used by the speech recognition path).
    initialPosRef.current = Math.max(0, userNudgeRef.current);
    syncCalcRef.current = { startPos: userNudgeRef.current, phraseOffset: 0, recStart: Date.now() };
    saveToHistory(user, nextSong);
    fetchHistory(user);
    // cast removed

    // ── Log auto-advance to analytics ──
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
    setMode("confirmed"); // triggers startSync via useEffect
  };

  // ── Manual track jump — user picks a track from the list during listening ──
  // Stops the current recording session and jumps straight into confirmed mode
  // at position 0 for the chosen track. Same state setup as advanceToNextTrack.
  const jumpToTrackIdx = (idx) => {
    const tracks = turntableTracksRef.current;
    const track = tracks[idx];
    if (!track) return;
    // Kill the current listening session
    listenSessionRef.current++;
    clearInterval(progressTimerRef.current);
    speechRecRef.current?.stop?.();
    const ta = turntableAlbumRef.current;
    const song = {
      title: track.trackName,
      artist: track.artistName || ta?.artist_name || "",
      album: ta?.album_name || track.collectionName || "",
      artwork: ta?.artwork_url || track.artworkUrl100?.replace("100x100bb", "600x600bb") || null,
    };
    setCurrentTrackIndex(idx);
    turntableMatchedIdxRef.current = idx;
    setAlbumTracks(tracks);
    setAlbumCollectionId(ta?.itunes_collection_id ? String(ta.itunes_collection_id) : null);
    detectedAtRef.current = Date.now();
    setDetectedSong(song);
    setSongDuration(track.trackTimeMillis ? track.trackTimeMillis / 1000 : null);
    setIdentifiedBy("manual");
    // Load lyrics — prefer turntableLyricsCacheRef (always populated at album-select)
    // over wordsDataRef (only populated during a listening session)
    const lrcEntry = turntableLyricsCacheRef.current[String(track.trackId)]
      || wordsDataRef.current?.[track.trackId];
    if (lrcEntry?.lrc_raw) {
      const parsed = parseLRC(lrcEntry.lrc_raw);
      setLyrics(parsed); lyricsRef.current = parsed;
    } else if (lrcEntry?.lyrics_plain) {
      const parsed = lrcEntry.lyrics_plain.split("\n").filter(l => l.trim()).map((text, i) => ({ time: i * 4, text }));
      setLyrics(parsed); lyricsRef.current = parsed;
    } else {
      setLyrics([]); lyricsRef.current = [];
    }
    initialPosRef.current = Math.max(0, userNudgeRef.current);
    syncCalcRef.current = { startPos: userNudgeRef.current, phraseOffset: 0, recStart: Date.now() };
    autoAdvanceFiredRef.current = false;
    autoRetryCountRef.current = 0;
    saveToHistory(user, song);
    // Picking a record off the shelf (the main web flow) counts as spinning it —
    // auto-post the album. Dedup (per-session + 12h) is handled inside.
    maybeAutoPostPlay({ userId: user?.id, collectionId: ta?.itunes_collection_id, album: song.album, artist: song.artist, artwork: song.artwork });
    setShowTrackList(false);
    setMode("confirmed");
  };

  // ── Manual flip: jump straight to the first track of the next side ──
  // Skips Shazam entirely — user has physically flipped the record and just
  // wants lyrics to start from track 1 of the next side without re-identifying.
  const manualFlipToNextSide = async () => {
    try {
      if (!chimeCtxRef.current) {
        chimeCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      } else if (chimeCtxRef.current.state === "suspended") {
        chimeCtxRef.current.resume();
      }
    } catch {}
    const tracks = turntableTracksRef.current;
    if (!tracks.length) return;
    const curIdx = turntableMatchedIdxRef.current >= 0
      ? turntableMatchedIdxRef.current
      : currentTrackIndexRef.current;
    const dbRelease = vinylDbReleaseRef.current;
    const effectiveTps = albumTpsRef.current > 0 ? albumTpsRef.current : 0;
    const sideEnds = getSideEndsFromSidesMap(tracks, vinylSidesRef.current)
      ?? (dbRelease?.vinyl_tracks?.length > 0 ? getDbSideEndIndices(tracks, dbRelease.vinyl_tracks) : getSideEndIndices(tracks, effectiveTps));
    for (let s = 0; s < sideEnds.length; s++) {
      if (curIdx <= sideEnds[s]) {
        const nextFirst = sideEnds[s] + 1;
        if (nextFirst >= tracks.length) {
          setSideEndReason("album-end");
          setMode("side-end");
          return;
        }
        // Hop straight into the lyrics page; song progression is paused for
        // 10s while the user actually drops the needle on the new side.
        cancelFlipChimes();
        flipStartDelayMsRef.current = 10000;
        jumpToTrackIdx(nextFirst);
        return;
      }
    }
    // Past all known side ends
    setSideEndReason("album-end");
    setMode("side-end");
  };

  // Helper: next side letter based on current track position (for UI labels)
  const getNextSideLetter = () => {
    const tracks = turntableTracksRef.current;
    if (!tracks.length) return null;
    const curIdx = turntableMatchedIdxRef.current >= 0
      ? turntableMatchedIdxRef.current
      : currentTrackIndexRef.current;
    const dbRelease = vinylDbReleaseRef.current;
    const effectiveTps = albumTpsRef.current > 0 ? albumTpsRef.current : 0;
    const sideEnds = getSideEndsFromSidesMap(tracks, vinylSidesRef.current)
      ?? (dbRelease?.vinyl_tracks?.length > 0 ? getDbSideEndIndices(tracks, dbRelease.vinyl_tracks) : getSideEndIndices(tracks, effectiveTps));
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
    const curIdx = turntableMatchedIdxRef.current >= 0
      ? turntableMatchedIdxRef.current
      : currentTrackIndexRef.current;
    const dbRelease = vinylDbReleaseRef.current;
    const effectiveTps = albumTpsRef.current > 0 ? albumTpsRef.current : 0;
    const sideEnds = getSideEndsFromSidesMap(tracks, vinylSidesRef.current)
      ?? (dbRelease?.vinyl_tracks?.length > 0 ? getDbSideEndIndices(tracks, dbRelease.vinyl_tracks) : getSideEndIndices(tracks, effectiveTps));
    for (let s = 0; s < sideEnds.length; s++) {
      if (curIdx <= sideEnds[s] && sideEnds[s] + 1 < tracks.length) {
        const curDisc = tracks[curIdx] ? (tracks[curIdx].discNumber || 1) : 1;
        const nextDisc = tracks[sideEnds[s] + 1] ? (tracks[sideEnds[s] + 1].discNumber || 1) : 1;
        const nextSide = "ABCDEFGH"[s + 1] || null;
        return { isNewDisc: nextDisc !== curDisc, nextDisc: nextDisc, nextSide: nextSide };
      }
    }
    return null;
  };

  // ── Resync: use Shazam to snap position back to the actual record (iOS only) ──
  const resync = async () => {
    if (isResyncing || !IS_IOS) return;
    setIsResyncing(true);
    try {
      const result = await Shazam.findMatch({ timeout: 10000 });
      if (!result.matched) { setIsResyncing(false); return; }
      const { title, offset, matchTime } = result;
      const elapsed = (Date.now() - matchTime) / 1000;
      const adjustedOffset = Math.max(0, offset + elapsed);
      const curIdx = currentTrackIndexRef.current;
      const track = curIdx >= 0 ? turntableTracksRef.current[curIdx] : null;
      if (!track) { setIsResyncing(false); return; }
      const norm = normText;
      if (!norm(title).includes(norm(track.trackName)) && !norm(track.trackName).includes(norm(title))) {
        setIsResyncing(false); return;
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
    streamRef.current?.getTracks().forEach(t => t.stop());
    try { speechRecRef.current?.stop(); } catch {}
    speechRecRef.current = null;
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
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

  // ── Jump to a specific track index (vinyl mode back/forward) ──
  // In turntable mode: loads the track from cached data — no re-listening, no API calls.
  //   Starts lyrics from position 0; user can Resync if the position is off.
  // In non-turntable mode: falls back to re-listening (can't know position otherwise).
  const jumpToTrack = idx => {
    if (detectedSong) setLastSong(detectedSong);
    clearInterval(syncIntervalRef.current);
    clearInterval(progressTimerRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
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
      // ── Turntable mode: use cached tracklist + lyrics, start from position 0 ──
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
      const lyrics = lrc ? parseLRC(lrc) : (trackData?.lyrics_plain ? trackData.lyrics_plain.split("\n").filter(l => l.trim()).map((text, i) => ({ time: i * 4, text })) : []);
      const duration = track.trackTimeMillis ? track.trackTimeMillis / 1000 : null;
      initialPosRef.current = 0;
      detectedAtRef.current = null;
      turntableMatchedIdxRef.current = idx;
      setDetectedSong(song);
      setIdentifiedBy("manual");
      setSongDuration(duration);
      setLyrics(lyrics);
      lyricsRef.current = lyrics;
      setAlbumTracks(turntableTracksRef.current);
      setAlbumCollectionId(ta.itunes_collection_id ? String(ta.itunes_collection_id) : null);
      setMode("confirmed"); // triggers startSync + auto-follow via useEffect

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
      maybeAutoPostPlay({ userId: user?.id, collectionId: ta.itunes_collection_id, album: song.album, artist: song.artist, artwork: song.artwork });
    } else {
      // ── Non-turntable: must re-listen to find position ──
      setDetectedSong(null);
      setIdentifiedBy(null);
      setSongDuration(null);
      setLyrics([]);
      setTimeout(() => startListening(false), 150);
    }
  };

  // ── Screen wake lock ──
  useEffect(() => {
    const acquire = async () => {
      if (!keepScreenAwake || !("wakeLock" in navigator)) return;
      try { wakeLockRef.current = await navigator.wakeLock.request("screen"); } catch {}
    };
    const release = () => { wakeLockRef.current?.release(); wakeLockRef.current = null; };
    const onVisibility = () => { if (document.visibilityState === "visible" && keepScreenAwake) acquire(); };
    if (keepScreenAwake) { acquire(); document.addEventListener("visibilitychange", onVisibility); }
    else release();
    return () => { release(); document.removeEventListener("visibilitychange", onVisibility); };
  }, [keepScreenAwake]);

  // ── Landscape controls auto-hide ──
  // Must live here — BEFORE any conditional early returns — to satisfy React hooks rules.
  useEffect(() => {
    if (mode === "syncing" && isLandscape) {
      bumpControls();
    } else {
      clearTimeout(controlsHideTimerRef.current);
      setControlsVisible(true);
    }
  }, [mode, isLandscape]);

  // ─────────────────────────────────────────
  // AUTH LOADING
  // ─────────────────────────────────────────
  if (authLoading) return /*#__PURE__*/React.createElement("div", {
    style: {
      minHeight: "100vh",
      background: "#080810",
      display: "flex",
      alignItems: "center",
      justifyContent: "center"
    }
  }, /*#__PURE__*/React.createElement(Vinyl, {
    spinning: true,
    size: 80
  }));

  // ─────────────────────────────────────────
  // LANDING + AUTH
  // ─────────────────────────────────────────
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

    // authSheet: null | "signin" | "signup"
    const openSheet = mode => {
      setAuthMode(mode);
      setAuthError(null);
      setAuthEmail("");
      setAuthPassword("");
      setAuthConfirmPw("");
      setAuthName("");
      setAuthVerifyPending(false);
      setAuthSheet(mode);
    };
    const featureSvgs = {
      identify: /*#__PURE__*/React.createElement("svg", {width:"22",height:"22",viewBox:"0 0 24 24",fill:"none",stroke:"#d4a846",strokeWidth:"1.8",strokeLinecap:"round",strokeLinejoin:"round"}, /*#__PURE__*/React.createElement("path",{d:"M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"}), /*#__PURE__*/React.createElement("path",{d:"M19 10v2a7 7 0 0 1-14 0v-2"}), /*#__PURE__*/React.createElement("line",{x1:"12",y1:"19",x2:"12",y2:"23"}), /*#__PURE__*/React.createElement("line",{x1:"8",y1:"23",x2:"16",y2:"23"})),
      sync: /*#__PURE__*/React.createElement("svg", {width:"22",height:"22",viewBox:"0 0 24 24",fill:"none",stroke:"#d4a846",strokeWidth:"1.8",strokeLinecap:"round",strokeLinejoin:"round"}, /*#__PURE__*/React.createElement("line",{x1:"3",y1:"6",x2:"21",y2:"6"}), /*#__PURE__*/React.createElement("line",{x1:"3",y1:"12",x2:"15",y2:"12"}), /*#__PURE__*/React.createElement("line",{x1:"3",y1:"18",x2:"18",y2:"18"})),
      auto: /*#__PURE__*/React.createElement("svg", {width:"22",height:"22",viewBox:"0 0 24 24",fill:"none",stroke:"#d4a846",strokeWidth:"1.8",strokeLinecap:"round",strokeLinejoin:"round"}, /*#__PURE__*/React.createElement("circle",{cx:"12",cy:"12",r:"10"}), /*#__PURE__*/React.createElement("circle",{cx:"12",cy:"12",r:"3"}))
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
    return /*#__PURE__*/React.createElement("div", {
      style: {
        minHeight: "100vh",
        background: "#080810",
        color: "#f0e6d3",
        fontFamily: "-apple-system,BlinkMacSystemFont,'SF Pro Display','Helvetica Neue',sans-serif",
        position: "relative",
        overflow: "hidden"
      }
    }, /*#__PURE__*/React.createElement("div", {
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
    }), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "flex-start",
        minHeight: "100vh",
        padding: "max(80px,calc(env(safe-area-inset-top)+56px)) 32px max(90px,calc(env(safe-area-inset-bottom)+80px))",
        textAlign: "center",
        gap: "24px"
      }
    }, /*#__PURE__*/React.createElement(Vinyl, {
      size: 130,
      spinning: false
    }), /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: "32px",
        fontSize: "11px",
        letterSpacing: "5px",
        color: "rgba(212,168,70,0.6)",
        textTransform: "uppercase",
        marginBottom: "10px"
      }
    }, "Welcome to"), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: "52px",
        letterSpacing: "18px",
        color: "#d4a846",
        fontWeight: "300",
        lineHeight: 1
      }
    }, "LIRI"), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: "13px",
        color: "rgba(255,255,255,0.25)",
        letterSpacing: "3px",
        textTransform: "uppercase",
        marginTop: "10px",
        marginBottom: "52px"
      }
    }, "Lyrics for Vinyl"), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: "12px",
        marginBottom: "56px",
        flexWrap: "wrap",
        justifyContent: "center"
      }
    }, features.map(f => /*#__PURE__*/React.createElement("div", {
      key: f.label,
      style: {
        background: "rgba(255,255,255,0.03)",
        border: "1px solid rgba(255,255,255,0.07)",
        borderRadius: "16px",
        padding: "16px 18px",
        minWidth: "100px",
        flex: "0 0 auto"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: "22px",
        marginBottom: "6px"
      }
    }, f.icon), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: "12px",
        fontWeight: "600",
        color: "#f0e6d3",
        marginBottom: "3px"
      }
    }, f.label), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: "10px",
        color: "rgba(255,255,255,0.25)",
        lineHeight: "1.4"
      }
    }, f.sub)))), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        flexDirection: "column",
        gap: "12px",
        width: "100%",
        maxWidth: "320px"
      }
    }, /*#__PURE__*/React.createElement("button", {
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
    }, "Get Started \u2014 it's free"), /*#__PURE__*/React.createElement("button", {
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
    }, "Sign In"))), authSheet && /*#__PURE__*/React.createElement("div", {
      onClick: () => {
        // Don't close on backdrop tap during signup — too easy to lose a filled form
        if (!authVerifyPending && authSheet !== "signup") setAuthSheet(null);
      },
      style: {
        position: "fixed",
        inset: 0,
        zIndex: 300,
        background: "rgba(0,0,0,0.5)",
        backdropFilter: "blur(6px)"
      }
    }, /*#__PURE__*/React.createElement("div", {
      onClick: e => e.stopPropagation(),
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
    }, !authVerifyPending && /*#__PURE__*/React.createElement("div", {
      onClick: () => { if (authSheet !== "signup") setAuthSheet(null); },
      style: {
        padding: "12px 0 20px",
        cursor: authSheet !== "signup" ? "pointer" : "default",
        textAlign: "center"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        width: "40px",
        height: "4px",
        borderRadius: "2px",
        background: "rgba(255,255,255,0.12)",
        display: "inline-block"
      }
    })), authVerifyPending ? /*#__PURE__*/React.createElement("div", {
      style: {
        textAlign: "center",
        padding: "24px 0 8px",
        animation: "fade-up 0.3s ease"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: "52px",
        marginBottom: "20px"
      }
    }, /*#__PURE__*/React.createElement("svg", {width:"1em",height:"1em",viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:"1.5",strokeLinecap:"round",strokeLinejoin:"round"}, /*#__PURE__*/React.createElement("path",{d:"M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"}), /*#__PURE__*/React.createElement("polyline",{points:"22,6 12,13 2,6"}))), /*#__PURE__*/React.createElement("h2", {
      style: {
        fontSize: "22px",
        fontWeight: "700",
        color: "#f0e6d3",
        marginBottom: "10px"
      }
    }, "Check your email"), /*#__PURE__*/React.createElement("p", {
      style: {
        fontSize: "14px",
        color: "rgba(255,255,255,0.4)",
        lineHeight: "1.7",
        marginBottom: "8px"
      }
    }, "We sent a verification link to"), /*#__PURE__*/React.createElement("p", {
      style: {
        fontSize: "14px",
        fontWeight: "600",
        color: "#d4a846",
        marginBottom: "28px"
      }
    }, authEmail), /*#__PURE__*/React.createElement("p", {
      style: {
        fontSize: "13px",
        color: "rgba(255,255,255,0.3)",
        lineHeight: "1.7",
        marginBottom: "28px",
        maxWidth: "260px",
        margin: "0 auto 28px"
      }
    }, "Click the link in that email to confirm your account, then come back and sign in."), authError && /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: "13px",
        color: authError.includes("resent") || authError.includes("sent") ? "#6aaa8a" : "#e8a0a8",
        textAlign: "center",
        marginBottom: "16px",
        lineHeight: "1.6"
      }
    }, authError), /*#__PURE__*/React.createElement("button", {
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
    }, authWorking ? "Sending…" : "Resend email"), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("button", {
      onClick: () => openSheet("signin"),
      style: {
        background: "none",
        border: "none",
        color: "rgba(255,255,255,0.25)",
        cursor: "pointer",
        fontSize: "13px",
        fontFamily: "inherit"
      }
    }, "Already confirmed? Sign in \u2192"))) : authSheet === "signup" ?
    /*#__PURE__*/
    /* ── Sign Up form ── */
    React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("h2", {
      style: {
        fontSize: "22px",
        fontWeight: "600",
        color: "#f0e6d3",
        textAlign: "center",
        marginBottom: "6px"
      }
    }, "Create your account"), /*#__PURE__*/React.createElement("p", {
      style: {
        fontSize: "14px",
        color: "rgba(255,255,255,0.25)",
        textAlign: "center",
        marginBottom: "24px"
      }
    }, "Free to start \u2014 no credit card"), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        flexDirection: "column",
        gap: "10px"
      }
    }, /*#__PURE__*/React.createElement("input", {
      type: "text",
      placeholder: "Your name",
      value: authName,
      onChange: e => setAuthName(e.target.value),
      onKeyDown: e => e.key === "Enter" && handleAuth(),
      style: inp,
      autoFocus: true
    }), /*#__PURE__*/React.createElement("input", {
      type: "email",
      placeholder: "Email",
      value: authEmail,
      onChange: e => setAuthEmail(e.target.value),
      onKeyDown: e => e.key === "Enter" && handleAuth(),
      style: inp
    }), /*#__PURE__*/React.createElement("input", {
      type: "password",
      placeholder: "Password (min 8 characters)",
      value: authPassword,
      onChange: e => setAuthPassword(e.target.value),
      onKeyDown: e => e.key === "Enter" && handleAuth(),
      style: inp
    }), /*#__PURE__*/React.createElement("input", {
      type: "password",
      placeholder: "Confirm password",
      value: authConfirmPw,
      onChange: e => setAuthConfirmPw(e.target.value),
      onKeyDown: e => e.key === "Enter" && handleAuth(),
      style: {
        ...inp,
        borderColor: authConfirmPw && authConfirmPw !== authPassword ? "rgba(232,160,168,0.5)" : inp.borderColor
      }
    })), authError && /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: "13px",
        color: "#e8a0a8",
        textAlign: "center",
        margin: "12px 0 0",
        lineHeight: "1.6"
      }
    }, authError), /*#__PURE__*/React.createElement("button", {
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
    }, authWorking ? "Creating account…" : "Create Account"), /*#__PURE__*/React.createElement("div", {
      style: {
        textAlign: "center",
        marginTop: "16px"
      }
    }, /*#__PURE__*/React.createElement("button", {
      onClick: () => openSheet("signin"),
      style: {
        background: "none",
        border: "none",
        color: "rgba(255,255,255,0.3)",
        cursor: "pointer",
        fontSize: "13px",
        fontFamily: "inherit"
      }
    }, "Already have an account? Sign in \u2192"))) :
    /*#__PURE__*/
    /* ── Sign In form ── */
    React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("h2", {
      style: {
        fontSize: "22px",
        fontWeight: "600",
        color: "#f0e6d3",
        textAlign: "center",
        marginBottom: "6px"
      }
    }, "Welcome back"), /*#__PURE__*/React.createElement("p", {
      style: {
        fontSize: "14px",
        color: "rgba(255,255,255,0.25)",
        textAlign: "center",
        marginBottom: "24px"
      }
    }, "Sign in to continue listening"), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        flexDirection: "column",
        gap: "10px"
      }
    }, /*#__PURE__*/React.createElement("input", {
      type: "email",
      placeholder: "Email",
      value: authEmail,
      onChange: e => setAuthEmail(e.target.value),
      onKeyDown: e => e.key === "Enter" && handleAuth(),
      style: inp,
      autoFocus: true
    }), /*#__PURE__*/React.createElement("div", {
      style: { position: "relative" }
    }, /*#__PURE__*/React.createElement("input", {
      type: showPw ? "text" : "password",
      placeholder: "Password",
      value: authPassword,
      onChange: e => setAuthPassword(e.target.value),
      onKeyDown: e => e.key === "Enter" && handleAuth(),
      style: { ...inp, paddingRight: "48px" }
    }), /*#__PURE__*/React.createElement("button", {
      type: "button",
      onClick: () => setShowPw(v => !v),
      "aria-label": showPw ? "Hide password" : "Show password",
      style: { position: "absolute", right: "6px", top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "rgba(255,255,255,0.4)", cursor: "pointer", padding: "10px", display: "flex", alignItems: "center", fontFamily: "inherit" }
    }, showPw
      ? /*#__PURE__*/React.createElement("svg", { width: "20", height: "20", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round" }, /*#__PURE__*/React.createElement("path", { d: "M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" }), /*#__PURE__*/React.createElement("line", { x1: "1", y1: "1", x2: "23", y2: "23" }))
      : /*#__PURE__*/React.createElement("svg", { width: "20", height: "20", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round" }, /*#__PURE__*/React.createElement("path", { d: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" }), /*#__PURE__*/React.createElement("circle", { cx: "12", cy: "12", r: "3" }))
    ))), authError && /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: "13px",
        color: authError.includes("reset") || authError.includes("sent") ? "#6aaa8a" : "#e8a0a8",
        textAlign: "center",
        margin: "12px 0 0",
        lineHeight: "1.6"
      }
    }, authError), /*#__PURE__*/React.createElement("button", {
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
    }, authWorking ? "Signing in…" : "Sign In"), /*#__PURE__*/React.createElement("div", {
      style: {
        textAlign: "center",
        marginTop: "16px",
        display: "flex",
        flexDirection: "column",
        gap: "8px"
      }
    }, /*#__PURE__*/React.createElement("button", {
      onClick: () => openSheet("signup"),
      style: {
        background: "none",
        border: "none",
        color: "rgba(255,255,255,0.3)",
        cursor: "pointer",
        fontSize: "13px",
        fontFamily: "inherit"
      }
    }, "New here? Create an account \u2192"), /*#__PURE__*/React.createElement("button", {
      onClick: handleForgotPassword,
      disabled: authWorking,
      style: {
        background: "none",
        border: "none",
        color: "rgba(212,168,70,0.75)",
        cursor: "pointer",
        fontSize: "13px",
        fontWeight: "600",
        fontFamily: "inherit",
        padding: "12px 16px",
        margin: "-6px auto -12px",
        minHeight: "44px"
      }
    }, "Forgot your password?"))))));
  }

  // ─────────────────────────────────────────
  // MAIN APP
  // ─────────────────────────────────────────
  const isSyncing = mode === "syncing";

  const artwork = detectedSong?.artwork;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      minHeight: "100vh",
      background: "#080810",
      color: "#f0e6d3",
      fontFamily: "-apple-system,BlinkMacSystemFont,'SF Pro Display','Helvetica Neue',sans-serif",
      position: "relative",
      overflow: "hidden"
    }
  }, artwork && /*#__PURE__*/React.createElement("div", {
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
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: "fixed",
      inset: 0,
      zIndex: 1,
      background: "linear-gradient(to bottom, rgba(8,8,16,0.6) 0%, rgba(8,8,16,0.3) 40%, rgba(8,8,16,0.7) 100%)",
      pointerEvents: "none"
    }
  }), showOnboarding && /*#__PURE__*/React.createElement("div", {
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
  }, onboardingStep < ONBOARDING_STEPS - 1 && /*#__PURE__*/React.createElement("button", {
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
  }, "Skip"), onboardingStep === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      animation: "fade-up 0.4s ease both"
    }
  }, /*#__PURE__*/React.createElement(Vinyl, {
    size: 120,
    spinning: false
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: "28px",
      fontSize: "13px",
      letterSpacing: "4px",
      color: "#d4a846",
      textTransform: "uppercase",
      marginBottom: "8px"
    }
  }, "Welcome to"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "40px",
      letterSpacing: "16px",
      color: "#d4a846",
      fontWeight: "300",
      marginBottom: "12px"
    }
  }, "LIRI"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "16px",
      color: "rgba(255,255,255,0.35)",
      letterSpacing: "2px",
      marginBottom: "40px"
    }
  }, "Lyrics for Vinyl"), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: "17px",
      color: "rgba(255,255,255,0.6)",
      lineHeight: "1.8",
      maxWidth: "280px",
      margin: "0 auto 48px"
    }
  }, "Put a record on. Hold your phone near the speakers. Watch the lyrics scroll by \u2014 line by line, in sync."), /*#__PURE__*/React.createElement("button", {
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
  }, "Let's go \u2192")), onboardingStep === 1 && /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      animation: "fade-up 0.4s ease both"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: "32px"
    }
  }, /*#__PURE__*/React.createElement(WaveAnimation, {
    active: true,
    size: 1.2
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "26px",
      fontWeight: "700",
      color: "#f0e6d3",
      marginBottom: "16px"
    }
  }, "Hold it close"), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: "15px",
      color: "rgba(255,255,255,0.5)",
      lineHeight: "1.9",
      maxWidth: "280px",
      margin: "0 auto 48px"
    }
  }, IS_IOS ? /*#__PURE__*/React.createElement(React.Fragment, null, "When your record is playing, tap ", /*#__PURE__*/React.createElement("strong", { style: { color: "#d4a846" } }, "Listen"), ". Liri uses Shazam to find your place in the song and syncs the lyrics in real time.") : "Add your albums to your library, then tap any track to start. Liri syncs the lyrics in real time — line by line."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: "16px",
      justifyContent: "center",
      alignItems: "center"
    }
  }, /*#__PURE__*/React.createElement("button", {
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
  }, "\u2190 Back"), /*#__PURE__*/React.createElement("button", {
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
  }, "Next \u2192"))), onboardingStep === 2 && /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      animation: "fade-up 0.4s ease both"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "72px",
      marginBottom: "24px",
      filter: "drop-shadow(0 0 20px rgba(212,168,70,0.4))"
    }
  }, /*#__PURE__*/React.createElement("svg", {width:"1em",height:"1em",viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:"1.8",strokeLinecap:"round",strokeLinejoin:"round"}, /*#__PURE__*/React.createElement("circle",{cx:"12",cy:"12",r:"10"}), /*#__PURE__*/React.createElement("polyline",{points:"12 6 12 12 16 14"}))), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "26px",
      fontWeight: "700",
      color: "#f0e6d3",
      marginBottom: "16px"
    }
  }, "Your listening history"), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: "15px",
      color: "rgba(255,255,255,0.5)",
      lineHeight: "1.9",
      maxWidth: "280px",
      margin: "0 auto 32px"
    }
  }, "Every song you identify gets saved automatically. Tap the ", /*#__PURE__*/React.createElement("strong", {
    style: {
      color: "#d4a846"
    }
  }, "clock icon"), " anytime to see what's been spinning on your turntable."), /*#__PURE__*/React.createElement("div", {
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
  }].map((s, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: "flex",
      alignItems: "center",
      gap: "12px",
      padding: "8px 0",
      borderBottom: i < 2 ? "1px solid rgba(255,255,255,0.05)" : "none"
    }
  }, /*#__PURE__*/React.createElement("div", {
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
  }, /*#__PURE__*/React.createElement("svg", {width:"1em",height:"1em",viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:"2",strokeLinecap:"round",strokeLinejoin:"round"}, /*#__PURE__*/React.createElement("path",{d:"M9 18V5l12-2v13"}), /*#__PURE__*/React.createElement("circle",{cx:"6",cy:"18",r:"3"}), /*#__PURE__*/React.createElement("circle",{cx:"18",cy:"16",r:"3"}))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "13px",
      fontWeight: "600",
      color: "#f0e6d3"
    }
  }, s.title), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "11px",
      color: "rgba(255,255,255,0.35)"
    }
  }, s.artist))))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: "16px",
      justifyContent: "center",
      alignItems: "center"
    }
  }, /*#__PURE__*/React.createElement("button", {
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
  }, "\u2190 Back"), /*#__PURE__*/React.createElement("button", {
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
  }, "Next \u2192"))), onboardingStep === 3 && /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      animation: "fade-up 0.4s ease both"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      gap: "16px",
      marginBottom: "28px"
    }
  }, /*#__PURE__*/React.createElement(Vinyl, {
    size: 80,
    spinning: false
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      width: "52px",
      height: "30px",
      borderRadius: "15px",
      background: "linear-gradient(135deg, #d4a846, #c9807a)",
      position: "relative",
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
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
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "26px",
      fontWeight: "700",
      color: "#f0e6d3",
      marginBottom: "16px"
    }
  }, "Auto Mode"), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: "15px",
      color: "rgba(255,255,255,0.5)",
      lineHeight: "1.9",
      maxWidth: "280px",
      margin: "0 auto 32px"
    }
  }, "Liri automatically listens for the next song as each track ends. No tapping, no fiddling \u2014 just the music."), /*#__PURE__*/React.createElement("div", {
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
  }, "\u2726 Listens for the next song — flip the record when you're ready"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: "16px",
      justifyContent: "center",
      alignItems: "center"
    }
  }, /*#__PURE__*/React.createElement("button", {
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
  }, "\u2190 Back"), /*#__PURE__*/React.createElement("button", {
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
  }, "Next \u2192"))), onboardingStep === 4 && /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      animation: "fade-up 0.4s ease both"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "72px",
      marginBottom: "24px",
      color: "#d4a846",
      filter: "drop-shadow(0 0 20px rgba(212,168,70,0.4))"
    }
  }, /*#__PURE__*/React.createElement("svg", { width: "1em", height: "1em", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round" }, /*#__PURE__*/React.createElement("path", { d: "M4 6h16M4 12h16M4 18h10" }))), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "26px",
      fontWeight: "700",
      color: "#f0e6d3",
      marginBottom: "16px"
    }
  }, "Share the spin"), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: "15px",
      color: "rgba(255,255,255,0.5)",
      lineHeight: "1.9",
      maxWidth: "290px",
      margin: "0 auto 28px"
    }
  }, "Liri has a ", /*#__PURE__*/React.createElement("strong", { style: { color: "#d4a846" } }, "Feed"), ". Follow friends to see what they're spinning, share the record on your turntable, and post the lyric lines that hit hardest."), /*#__PURE__*/React.createElement("div", {
    style: {
      background: "rgba(212,168,70,0.07)",
      border: "1px solid rgba(212,168,70,0.15)",
      borderRadius: "14px",
      padding: "12px 16px",
      maxWidth: "280px",
      margin: "0 auto 40px",
      fontSize: "13px",
      color: "rgba(255,255,255,0.4)",
      lineHeight: "1.7",
      textAlign: "left"
    }
  }, "\u2726 Turn on auto-share in Settings and the record you play posts itself \u2014 you choose who sees it."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: "16px",
      justifyContent: "center",
      alignItems: "center"
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setOnboardingStep(3),
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
  }, "\u2190 Back"), /*#__PURE__*/React.createElement("button", {
    onClick: () => setOnboardingStep(5),
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
  }, "Next \u2192"))), onboardingStep === 5 && /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      animation: "fade-up 0.4s ease both",
      maxWidth: "320px",
      margin: "0 auto"
    }
  }, /*#__PURE__*/React.createElement(Vinyl, {
    size: 64,
    spinning: false
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: "16px",
      fontSize: "11px",
      letterSpacing: "4px",
      color: "rgba(212,168,70,0.5)",
      textTransform: "uppercase",
      marginBottom: "6px"
    }
  }, "Liri"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "12px",
      color: "rgba(255,255,255,0.2)",
      marginBottom: "32px"
    }
  }, "\xA9 ", new Date().getFullYear(), " Liri. All rights reserved."), /*#__PURE__*/React.createElement("div", {
    style: {
      background: "rgba(212,168,70,0.06)",
      border: "1px solid rgba(212,168,70,0.12)",
      borderRadius: "16px",
      padding: "18px 20px",
      marginBottom: "24px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "13px",
      color: "rgba(212,168,70,0.7)",
      letterSpacing: "2px",
      textTransform: "uppercase",
      marginBottom: "10px"
    }
  }, "To the artists"), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: "13px",
      color: "rgba(255,255,255,0.4)",
      lineHeight: "1.8"
    }
  }, "The lyrics displayed in Liri belong to the artists, songwriters, and publishers who created them. We're just here to help you feel every word.")), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: "36px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "11px",
      color: "rgba(255,255,255,0.2)",
      letterSpacing: "2px",
      textTransform: "uppercase",
      marginBottom: "14px"
    }
  }, "Made possible by"), /*#__PURE__*/React.createElement("div", {
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
  }]).map(c => /*#__PURE__*/React.createElement("div", {
    key: c.name,
    style: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      padding: "8px 14px",
      background: "rgba(255,255,255,0.03)",
      borderRadius: "10px"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: "13px",
      color: "rgba(255,255,255,0.55)",
      fontWeight: "500"
    }
  }, c.name), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: "11px",
      color: "rgba(255,255,255,0.2)"
    }
  }, c.role))))), /*#__PURE__*/React.createElement("button", {
    onClick: () => { dismissOnboarding(); setCoachStep(1); },
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
  }, "Show me around \u2192"), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: "14px"
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setOnboardingStep(4),
    style: {
      background: "none",
      border: "none",
      color: "rgba(255,255,255,0.2)",
      cursor: "pointer",
      fontSize: "13px",
      fontFamily: "inherit"
    }
  }, "\u2190 Back"))), /*#__PURE__*/React.createElement("div", {
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
  }).map((_, i) => /*#__PURE__*/React.createElement("div", {
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
  })))), coachStep > 0 && (() => {
    // ── Coach marks: spotlight the Listen button, then the Feed tab ──
    // The ring's huge box-shadow dims everything except the highlighted target.
    const sel = coachStep === 1 ? "#liri-listen-cta" : 'a[href="/app/feed.html"]';
    const el = typeof document !== "undefined" ? document.querySelector(sel) : null;
    const r = el ? el.getBoundingClientRect() : null;
    const isLast = coachStep === 2;
    const advance = () => { if (isLast) { setCoachStep(0); window.location.href = window.Capacitor ? "/library.html" : "/library"; } else { setCoachStep(2); } };
    const copy = coachStep === 1
      ? { title: "Tap Listen", body: "Put a record on, then hit Listen — Liri finds your place and scrolls the lyrics in time.", cta: "Next →" }
      : { title: "Your Feed", body: "See what friends are spinning, share your own records, and post the lyric lines that hit. It lives right here.", cta: "Add your first record →" };
    // Tooltip sits above the target (or centered if the target isn't on screen).
    const tipTop = r ? Math.max(20, r.top - 168) : null;
    return /*#__PURE__*/React.createElement("div", {
      onClick: advance,
      style: { position: "fixed", inset: 0, zIndex: 700, cursor: "pointer" }
    },
      r ? /*#__PURE__*/React.createElement("div", {
        style: { position: "fixed", left: r.left - 8, top: r.top - 8, width: r.width + 16, height: r.height + 16, borderRadius: "16px", border: "2px solid #d4a846", boxShadow: "0 0 0 9999px rgba(8,8,16,0.82)", pointerEvents: "none", transition: "all 0.25s ease" } })
        : /*#__PURE__*/React.createElement("div", { style: { position: "fixed", inset: 0, background: "rgba(8,8,16,0.82)" } }),
      /*#__PURE__*/React.createElement("div", {
        style: { position: "fixed", left: "50%", transform: "translateX(-50%)", top: tipTop != null ? tipTop : "auto", bottom: tipTop != null ? "auto" : "120px", width: "min(320px, calc(100vw - 48px))", background: "#13131f", border: "1px solid rgba(212,168,70,0.3)", borderRadius: "18px", padding: "20px", textAlign: "center", boxShadow: "0 12px 40px rgba(0,0,0,0.5)" }
      },
        /*#__PURE__*/React.createElement("div", { style: { fontSize: "10px", letterSpacing: "2px", textTransform: "uppercase", color: "rgba(212,168,70,0.6)", marginBottom: "8px" } }, `${coachStep} of 2`),
        /*#__PURE__*/React.createElement("div", { style: { fontSize: "19px", fontWeight: "700", color: "#f0e6d3", marginBottom: "8px" } }, copy.title),
        /*#__PURE__*/React.createElement("p", { style: { fontSize: "14px", color: "rgba(255,255,255,0.55)", lineHeight: "1.6", marginBottom: "18px" } }, copy.body),
        /*#__PURE__*/React.createElement("button", { onClick: advance, style: { background: "linear-gradient(135deg,#d4a846,#c9807a)", color: "#080810", border: "none", borderRadius: "50px", padding: "12px 28px", fontSize: "14px", fontWeight: "700", fontFamily: "inherit", cursor: "pointer" } }, copy.cta),
        /*#__PURE__*/React.createElement("div", { style: { marginTop: "10px" } },
          /*#__PURE__*/React.createElement("button", { onClick: (e) => { e.stopPropagation(); setCoachStep(0); }, style: { background: "none", border: "none", color: "rgba(255,255,255,0.3)", fontSize: "12px", fontFamily: "inherit", cursor: "pointer" } }, "Skip"))
      )
    );
  })(), showAlbumPicker && /*#__PURE__*/React.createElement("div", {
    onClick: () => setShowAlbumPicker(false),
    style: {
      position: "fixed",
      inset: 0,
      zIndex: 200,
      background: "rgba(0,0,0,0.6)",
      backdropFilter: "blur(4px)",
      cursor: "pointer"
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: e => e.stopPropagation(),
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
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "center",
      padding: "12px 0 4px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 36,
      height: 4,
      borderRadius: 2,
      background: "rgba(255,255,255,0.12)"
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "12px 24px 16px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 18,
      fontWeight: 700
    }
  }, "What's on the turntable?"), /*#__PURE__*/React.createElement("button", {
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
  }, /*#__PURE__*/React.createElement("svg", {width:"12",height:"12",viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:"2.5",strokeLinecap:"round"}, /*#__PURE__*/React.createElement("line",{x1:"18",y1:"6",x2:"6",y2:"18"}), /*#__PURE__*/React.createElement("line",{x1:"6",y1:"6",x2:"18",y2:"18"})))), /*#__PURE__*/React.createElement("div", {
    style: {
      overflowY: "auto",
      padding: "0 24px",
      flex: 1,
      paddingBottom: "max(24px, env(safe-area-inset-bottom))",
      WebkitOverflowScrolling: "touch"
    }
  }, turntableAlbum && /*#__PURE__*/React.createElement("button", {
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
  }, /*#__PURE__*/React.createElement("div", {
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
  }, /*#__PURE__*/React.createElement("svg", {width:"12",height:"12",viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:"2.5",strokeLinecap:"round"}, /*#__PURE__*/React.createElement("line",{x1:"18",y1:"6",x2:"6",y2:"18"}), /*#__PURE__*/React.createElement("line",{x1:"6",y1:"6",x2:"18",y2:"18"}))), /*#__PURE__*/React.createElement("span", null, "Clear selection")), libLoading ? /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "center",
      padding: "32px 0"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 24,
      height: 24,
      borderRadius: "50%",
      border: "2px solid rgba(255,255,255,0.06)",
      borderTopColor: "#d4a846",
      animation: "spin 0.8s linear infinite"
    }
  })) : userLibrary.length === 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      padding: "40px 0",
      color: "rgba(255,255,255,0.2)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 40,
      marginBottom: 12,
      opacity: 0.3
    }
  }, /*#__PURE__*/React.createElement("svg", {width:"1em",height:"1em",viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:"1.5",strokeLinecap:"round"}, /*#__PURE__*/React.createElement("circle",{cx:"12",cy:"12",r:"10"}), /*#__PURE__*/React.createElement("circle",{cx:"12",cy:"12",r:"3"}))), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 15,
      fontWeight: 600,
      color: "rgba(255,255,255,0.35)",
      marginBottom: 8
    }
  }, "Your library is empty"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: "rgba(255,255,255,0.2)",
      marginBottom: 20,
      lineHeight: 1.6
    }
  }, "Head to My Records to add your first album.")) : userLibrary.map(album => {
    const isSelected = turntableAlbum?.itunes_collection_id === album.itunes_collection_id;
    return /*#__PURE__*/React.createElement("button", {
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
    }, album.artwork_url ? /*#__PURE__*/React.createElement("img", {
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
    }) : /*#__PURE__*/React.createElement("div", {
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
    }, /*#__PURE__*/React.createElement("svg", {width:"1em",height:"1em",viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:"1.5",strokeLinecap:"round"}, /*#__PURE__*/React.createElement("circle",{cx:"12",cy:"12",r:"10"}), /*#__PURE__*/React.createElement("circle",{cx:"12",cy:"12",r:"3"}))), /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1,
        minWidth: 0
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 14,
        fontWeight: isSelected ? 700 : 500,
        color: isSelected ? "#d4a846" : "#f0e6d3",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap"
      }
    }, album.album_name), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 12,
        color: "rgba(255,255,255,0.4)",
        marginTop: 2
      }
    }, album.artist_name)), isSelected && /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 14,
        color: "#d4a846",
        flexShrink: 0
      }
    }, "\u2713"));
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      padding: "20px 0 4px"
    }
  }, /*#__PURE__*/React.createElement("a", {
    href: window.Capacitor ? "/library.html" : "/library",
    style: {
      fontSize: 12,
      color: "rgba(255,255,255,0.2)",
      textDecoration: "none"
    }
  }, "Manage My Records \u2192"))))), showTrackList && !window.Capacitor && /*#__PURE__*/React.createElement("div", {
    onClick: () => setShowTrackList(false),
    style: { position: "fixed", inset: 0, zIndex: 201, background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)", cursor: "pointer", display: "flex", alignItems: "flex-end", justifyContent: "center" }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: e => e.stopPropagation(),
    style: { width: "100%", maxWidth: "520px", background: "#0f0f1c", borderRadius: "24px 24px 0 0", maxHeight: "80vh", display: "flex", flexDirection: "column", boxShadow: "0 -8px 48px rgba(0,0,0,0.6)", animation: "slide-up 0.3s ease" }
  }, /*#__PURE__*/React.createElement("div", {
    style: { display: "flex", justifyContent: "center", padding: "12px 0 4px" }
  }, /*#__PURE__*/React.createElement("div", {
    style: { width: 36, height: 4, borderRadius: 2, background: "rgba(255,255,255,0.12)" }
  })), /*#__PURE__*/React.createElement("div", {
    style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 24px 16px" }
  }, /*#__PURE__*/React.createElement("div", {
    style: { fontSize: 18, fontWeight: 700, color: "#f0e6d3" }
  }, "Pick a track"), /*#__PURE__*/React.createElement("button", {
    onClick: () => setShowTrackList(false),
    style: { background: "rgba(255,255,255,0.07)", border: "none", color: "rgba(255,255,255,0.5)", width: 30, height: 30, borderRadius: "50%", cursor: "pointer", fontSize: 18, lineHeight: "1", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "inherit" }
  }, "\u00d7")), /*#__PURE__*/React.createElement("div", {
    style: { overflowY: "auto", WebkitOverflowScrolling: "touch", padding: "0 24px 40px", display: "flex", flexDirection: "column", gap: "20px" }
  }, (() => {
    const _wt = turntableTracksRef.current;
    if (!_wt.length) return null;
    const _groups = getSideGroups(_wt, vinylSidesRef.current, vinylDbRelease?.vinyl_tracks);
    return _groups.map(({ side, tracks }) => /*#__PURE__*/React.createElement("div", { key: side },
      /*#__PURE__*/React.createElement("div", {
        style: { fontSize: "10px", letterSpacing: "2px", textTransform: "uppercase", color: "rgba(212,168,70,0.8)", fontWeight: "700", marginBottom: "10px", paddingBottom: "6px", borderBottom: "1px solid rgba(255,255,255,0.06)" }
      }, "Side ", side),
      /*#__PURE__*/React.createElement("div", {
        style: { display: "flex", flexDirection: "column", gap: "4px" }
      }, tracks.map(({ track: t, idx: i }) => /*#__PURE__*/React.createElement("button", {
        key: i,
        onClick: () => jumpToTrackIdx(i),
        style: { background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: "10px", padding: "11px 16px", color: "#f0e6d3", fontSize: "14px", cursor: "pointer", fontFamily: "inherit", textAlign: "left", display: "flex", alignItems: "center", gap: "12px" }
      }, /*#__PURE__*/React.createElement("span", {
        style: { color: "rgba(255,255,255,0.25)", fontSize: "12px", minWidth: "20px", flexShrink: 0 }
      }, i + 1), t.trackName)))
    ));
  })()))), showSettings && /*#__PURE__*/React.createElement("div", {
    onClick: () => setShowSettings(false),
    style: {
      position: "fixed",
      inset: 0,
      zIndex: 200,
      background: isWide ? "rgba(0,0,0,0.25)" : "rgba(0,0,0,0.5)",
      backdropFilter: isWide ? "none" : "blur(4px)",
      cursor: "pointer"
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: e => e.stopPropagation(),
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
  }, isWide ? /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "max(72px, calc(env(safe-area-inset-top) + 52px)) 20px 8px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "13px",
      fontWeight: "700",
      letterSpacing: "2px",
      color: "rgba(255,255,255,0.25)",
      textTransform: "uppercase"
    }
  }, "Settings"), /*#__PURE__*/React.createElement("button", {
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
  }, "\xD7")) : /*#__PURE__*/React.createElement("div", {
    onClick: () => setShowSettings(false),
    onTouchStart: e => { e.currentTarget._touchStartY = e.touches[0].clientY; },
    onTouchEnd: e => { if (e.changedTouches[0].clientY - (e.currentTarget._touchStartY || 0) > 60) setShowSettings(false); },
    style: {
      padding: "12px 24px 4px",
      cursor: "pointer"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: "40px",
      height: "4px",
      borderRadius: "2px",
      background: "rgba(255,255,255,0.12)",
      margin: "0 auto"
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: isWide ? "12px 20px max(20px, calc(env(safe-area-inset-bottom) + 16px))" : "16px 24px max(32px, calc(env(safe-area-inset-bottom) + 24px))"
    }
  }, (() => {
    const displayName = user?.user_metadata?.name || "";
    const initial = (displayName?.[0] || user?.email?.[0] || "?").toUpperCase();
    return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("button", {
      onClick: () => { clearInterval(syncIntervalRef.current); reset(); setShowSettings(false); },
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
    }, /*#__PURE__*/React.createElement("svg", {width:"14",height:"14",viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:"2",strokeLinecap:"round",strokeLinejoin:"round",style:{marginRight:"6px",flexShrink:0}}, /*#__PURE__*/React.createElement("path",{d:"M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"}), /*#__PURE__*/React.createElement("polyline",{points:"9 22 9 12 15 12 15 22"})), "Home"), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        alignItems: "center",
        gap: "14px",
        marginBottom: "28px"
      }
    }, /*#__PURE__*/React.createElement("div", {
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
    }, initial), /*#__PURE__*/React.createElement("div", {
      style: {
        minWidth: 0
      }
    }, displayName ? /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: "15px",
        fontWeight: "600",
        color: "#f0e6d3",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap"
      }
    }, displayName) : null, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: displayName ? "12px" : "15px",
        fontWeight: displayName ? "400" : "600",
        color: displayName ? "rgba(255,255,255,0.35)" : "#f0e6d3",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap"
      }
    }, user?.email), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: "12px",
        color: "rgba(255,255,255,0.3)",
        marginTop: "2px"
      }
    }, userTier === "premium" ? /*#__PURE__*/React.createElement("span", {
      onClick: () => { setShowSettings(false); setShowPremiumInfo(true); },
      style: { cursor: "pointer", color: "#d4a846", display: "inline-flex", alignItems: "center", gap: "4px" }
    }, /*#__PURE__*/React.createElement("svg", { width: "10", height: "10", viewBox: "0 0 24 24", fill: "#d4a846" }, /*#__PURE__*/React.createElement("path", { d: "M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z" })), "Liri Premium") : "Liri"))));
  })(),

  /* ── Plan card ── */
  userTier !== "premium" ? /*#__PURE__*/React.createElement("div", {
    style: { background: "rgba(212,168,70,0.06)", border: "1px solid rgba(212,168,70,0.15)", borderRadius: "16px", padding: "14px 16px", marginBottom: "16px" }
  },
    /*#__PURE__*/React.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "10px" } },
      /*#__PURE__*/React.createElement("div", null,
        /*#__PURE__*/React.createElement("div", { style: { fontSize: "13px", fontWeight: "600", color: "#f0e6d3" } }, "Free plan"),
        /*#__PURE__*/React.createElement("div", { style: { fontSize: "11px", color: "rgba(255,255,255,0.3)", marginTop: "2px" } }, `${albumCount}/10 records used`)
      ),
      IS_IOS
        ? /*#__PURE__*/React.createElement("button", {
            onClick: upgradeWithApple,
            disabled: iapWorking,
            style: { background: "linear-gradient(135deg,#d4a846,#c9807a)", color: "#080810", border: "none", borderRadius: "50px", padding: "7px 14px", fontSize: "12px", fontWeight: "700", cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap", opacity: iapWorking ? 0.6 : 1 }
          }, iapWorking ? "…" : `${iapPrice}`)
        : /*#__PURE__*/React.createElement("button", {
            onClick: () => { window.location.href = "/library?upgrade=true"; },
            style: { background: "linear-gradient(135deg,#d4a846,#c9807a)", color: "#080810", border: "none", borderRadius: "50px", padding: "7px 14px", fontSize: "12px", fontWeight: "700", cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }
          }, "Upgrade →")
    ),
    /*#__PURE__*/React.createElement("div", { style: { width: "100%", height: "3px", borderRadius: "2px", background: "rgba(255,255,255,0.08)", overflow: "hidden" } },
      /*#__PURE__*/React.createElement("div", { style: { height: "100%", borderRadius: "2px", background: albumCount >= 8 ? "#c9807a" : "#d4a846", width: `${Math.min(100, (albumCount / 10) * 100)}%`, transition: "width 0.4s ease" } })
    )
  ) : null,

  /* ── Liri Premium row (always visible) ── */
  /*#__PURE__*/React.createElement("button", {
    onClick: () => { setShowSettings(false); setShowPremiumInfo(true); },
    style: { width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", background: userTier === "premium" ? "rgba(212,168,70,0.06)" : "rgba(255,255,255,0.04)", border: `1px solid ${userTier === "premium" ? "rgba(212,168,70,0.2)" : "rgba(255,255,255,0.08)"}`, borderRadius: "16px", padding: "14px 16px", marginBottom: "16px", cursor: "pointer", fontFamily: "inherit", textAlign: "left" }
  },
    /*#__PURE__*/React.createElement("div", { style: { display: "flex", alignItems: "center", gap: "12px" } },
      /*#__PURE__*/React.createElement("svg", { width: "16", height: "16", viewBox: "0 0 24 24", fill: "#d4a846" }, /*#__PURE__*/React.createElement("path", { d: "M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z" })),
      /*#__PURE__*/React.createElement("div", null,
        /*#__PURE__*/React.createElement("div", { style: { fontSize: "13px", fontWeight: "600", color: userTier === "premium" ? "#d4a846" : "#f0e6d3" } }, "Liri Premium"),
        /*#__PURE__*/React.createElement("div", { style: { fontSize: "11px", color: "rgba(255,255,255,0.3)", marginTop: "2px" } }, userTier === "premium" ? "Active · Unlimited access" : "Unlimited library, lyrics & more")
      )
    ),
    /*#__PURE__*/React.createElement("div", { style: { display: "flex", alignItems: "center", gap: "6px" } },
      userTier === "premium" && /*#__PURE__*/React.createElement("div", { style: { fontSize: "10px", color: "rgba(212,168,70,0.6)", fontWeight: "700", letterSpacing: "0.5px" } }, "ACTIVE"),
      /*#__PURE__*/React.createElement("svg", { width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: "rgba(255,255,255,0.2)", strokeWidth: "2", strokeLinecap: "round" }, /*#__PURE__*/React.createElement("polyline", { points: "9 18 15 12 9 6" }))
    )
  ),

  /*#__PURE__*/React.createElement("div", {
    style: {
      background: "rgba(255,255,255,0.03)",
      border: "1px solid rgba(255,255,255,0.07)",
      borderRadius: "16px",
      padding: "16px 18px",
      marginBottom: "16px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "14px",
      fontWeight: "600",
      color: "#f0e6d3",
      marginBottom: "12px"
    }
  }, "Flip reminders"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: "14px"
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "13px",
      color: "#f0e6d3"
    }
  }, "Sound chime"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "11px",
      color: "rgba(255,255,255,0.3)",
      marginTop: "2px"
    }
  }, "Plays a tone when it's time to flip")), /*#__PURE__*/React.createElement("div", {
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
  }, /*#__PURE__*/React.createElement("div", {
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
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between"
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "13px",
      color: "#f0e6d3"
    }
  }, "Push notification"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "11px",
      color: "rgba(255,255,255,0.3)",
      marginTop: "2px",
      lineHeight: "1.5"
    }
  }, "Alerts you even when the screen is off")), /*#__PURE__*/React.createElement("div", {
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
  }, /*#__PURE__*/React.createElement("div", {
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
  }))), notifyDenied && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "11px",
      color: "#e8a0a8",
      marginTop: "8px",
      lineHeight: "1.5"
    }
  }, "Notifications were blocked. Enable them in your browser settings.")), /*#__PURE__*/React.createElement("div", {
    style: {
      background: "rgba(255,255,255,0.03)",
      border: "1px solid rgba(255,255,255,0.07)",
      borderRadius: "16px",
      padding: "16px 18px",
      marginBottom: "16px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: () => { window.location.href = window.Capacitor ? "/library.html" : "/library"; },
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      cursor: "pointer"
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "13px",
      color: "#d4a846"
    }
  }, "My Records"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "11px",
      color: "rgba(255,255,255,0.3)",
      marginTop: "2px"
    }
  }, "Your personal vinyl library")), /*#__PURE__*/React.createElement("div", {
    style: {
      color: "rgba(212,168,70,0.5)",
      fontSize: "18px"
    }
  }, "\u203A"))), /*#__PURE__*/React.createElement("div", {
    style: {
      borderTop: "1px solid rgba(255,255,255,0.07)",
      paddingTop: "20px",
      marginBottom: "20px"
    }
  }, /*#__PURE__*/React.createElement("div", {
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
}, /*#__PURE__*/React.createElement("div", {
  style: {display: "flex", alignItems: "center", gap: "12px"}
}, /*#__PURE__*/React.createElement("div", {
  style: {
    width: "32px",
    height: "32px",
    borderRadius: "8px",
    background: "rgba(255,255,255,0.06)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center"
  }
}, /*#__PURE__*/React.createElement("svg", {
  width: "16",
  height: "16",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "2",
  style: {color: "rgba(255,255,255,0.5)"}
}, /*#__PURE__*/React.createElement("circle", {
  cx: "12", cy: "12", r: "4"
}), /*#__PURE__*/React.createElement("path", {
  d: "M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"
}))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
  style: {fontSize: "14px", color: "rgba(255,255,255,0.85)", fontWeight: "500"}
}, "Keep screen on"), /*#__PURE__*/React.createElement("div", {
  style: {fontSize: "11px", color: "rgba(255,255,255,0.35)", marginTop: "2px"}
}, "Prevent display from sleeping"))), /*#__PURE__*/React.createElement("div", {
  style: {
    width: "44px",
    height: "26px",
    borderRadius: "13px",
    background: keepScreenAwake ? "rgba(212,168,70,0.9)" : "rgba(255,255,255,0.1)",
    position: "relative",
    transition: "background 0.2s"
  }
}, /*#__PURE__*/React.createElement("div", {
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
}))), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "11px",
      letterSpacing: "2px",
      color: "rgba(255,255,255,0.2)",
      textTransform: "uppercase",
      marginBottom: "12px"
    }
  }, "Credits"), /*#__PURE__*/React.createElement("div", {
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
  }]).map(c => /*#__PURE__*/React.createElement("div", {
    key: c.name
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "12px",
      color: "rgba(255,255,255,0.5)",
      fontWeight: "600"
    }
  }, c.name), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "10px",
      color: "rgba(255,255,255,0.25)",
      marginTop: "1px"
    },
    dangerouslySetInnerHTML: {
      __html: c.role
    }
  })))), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "11px",
      color: "rgba(255,255,255,0.15)",
      lineHeight: "1.7"
    }
  }, "\xA9 ", new Date().getFullYear(), " Liri. All rights reserved.", /*#__PURE__*/React.createElement("br", null), "Music rights belong to their respective artists, labels, and publishers.")), !showBugReport ? /*#__PURE__*/React.createElement("button", {
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
  }, /*#__PURE__*/React.createElement("svg", {width:"14",height:"14",viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:"2",strokeLinecap:"round",strokeLinejoin:"round",style:{marginRight:"6px",verticalAlign:"middle"}}, /*#__PURE__*/React.createElement("circle",{cx:"12",cy:"12",r:"10"}), /*#__PURE__*/React.createElement("line",{x1:"12",y1:"8",x2:"12",y2:"12"}), /*#__PURE__*/React.createElement("line",{x1:"12",y1:"16",x2:"12.01",y2:"16"})), "Report a bug") : /*#__PURE__*/React.createElement("div", {
    style: {
      background: "rgba(255,255,255,0.04)",
      border: "1px solid rgba(255,255,255,0.1)",
      borderRadius: "16px",
      padding: "16px",
      marginBottom: "10px",
      animation: "fade-up 0.2s ease"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "13px",
      fontWeight: "600",
      color: "rgba(255,255,255,0.6)",
      marginBottom: "10px"
    }
  }, "What's going wrong?"), /*#__PURE__*/React.createElement("textarea", {
    value: bugText,
    onChange: e => setBugText(e.target.value),
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
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: "8px",
      marginTop: "10px"
    }
  }, /*#__PURE__*/React.createElement("button", {
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
  }, "Cancel"), /*#__PURE__*/React.createElement("button", {
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
  }, bugSent ? "✓ Sent!" : bugSending ? "Sending…" : "Send report"))), /*#__PURE__*/React.createElement("button", {
    onClick: () => { setShowSettings(false); setCoachStep(0); setOnboardingStep(0); setShowOnboarding(true); },
    style: { width: "100%", background: "rgba(212,168,70,0.08)", border: "1px solid rgba(212,168,70,0.2)", color: "rgba(212,168,70,0.85)", borderRadius: "14px", padding: "14px", fontSize: "14px", fontWeight: "600", cursor: "pointer", fontFamily: "inherit", marginBottom: "8px" }
  }, "How Liri works"), /*#__PURE__*/React.createElement("button", {
    onClick: () => { setShowSettings(false); setShowChangePw(true); setChangePwError(null); setChangePwNew(""); setChangePwConfirm(""); setChangePwDone(false); },
    style: { width: "100%", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.4)", borderRadius: "14px", padding: "14px", fontSize: "14px", cursor: "pointer", fontFamily: "inherit", marginBottom: "8px" }
  }, "Change Password"), /*#__PURE__*/React.createElement("button", {
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
  }, "Sign Out"), IS_IOS && /*#__PURE__*/React.createElement("button", {
    onClick: restoreApplePurchases,
    disabled: iapWorking,
    style: { width: "100%", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.4)", borderRadius: "14px", padding: "14px", fontSize: "14px", cursor: "pointer", fontFamily: "inherit", marginTop: "8px", opacity: iapWorking ? 0.6 : 1 }
  }, "Restore Purchases"), /*#__PURE__*/React.createElement("button", {
    onClick: () => { setShowDeleteAccount(true); setDeleteError(null); },
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
  }, "Delete Account"), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      marginTop: "16px",
      fontSize: "11px",
      color: "rgba(255,255,255,0.1)"
    }
  }, "Liri v", APP_VERSION, " \xB7 getliri.com")))), showPremiumInfo && /*#__PURE__*/React.createElement("div", {
    onClick: () => setShowPremiumInfo(false),
    style: { position: "fixed", inset: 0, zIndex: 400, background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)", display: "flex", alignItems: "flex-end", justifyContent: "center" }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: e => e.stopPropagation(),
    style: { background: "#0f0f1c", borderRadius: "24px 24px 0 0", padding: "28px 28px max(40px,calc(env(safe-area-inset-bottom)+28px))", maxWidth: "520px", width: "100%", border: "1px solid rgba(255,255,255,0.07)" }
  },
    /*#__PURE__*/React.createElement("div", { style: { width: "40px", height: "4px", borderRadius: "2px", background: "rgba(255,255,255,0.12)", margin: "0 auto 24px" } }),
    /*#__PURE__*/React.createElement("div", { style: { display: "flex", alignItems: "center", gap: "10px", marginBottom: "6px" } },
      /*#__PURE__*/React.createElement("svg", { width: "18", height: "18", viewBox: "0 0 24 24", fill: "#d4a846" }, /*#__PURE__*/React.createElement("path", { d: "M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z" })),
      /*#__PURE__*/React.createElement("div", { style: { fontSize: "18px", fontWeight: "700", color: "#f0e6d3" } }, "Liri Premium")
    ),
    /*#__PURE__*/React.createElement("div", { style: { fontSize: "13px", color: "rgba(255,255,255,0.35)", marginBottom: "24px" } }, userTier === "premium" ? "Your plan includes:" : "Everything in Premium:"),
    /*#__PURE__*/React.createElement("div", { style: { background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: "16px", padding: "4px 0", marginBottom: "24px" } },
      [["Unlimited vinyl library", "Add as many records as you want"],
       ["Lyrics for every track", "Synced line by line as your record plays"],
       ["Play history & stats", "See everything you've listened to"],
       ["Flip reminders", "Sound and notification alerts"],
       ["Cancel anytime", "Manage in iOS Settings → Subscriptions"]
      ].map(([title, sub], i, arr) =>
        /*#__PURE__*/React.createElement("div", { key: title, style: { display: "flex", alignItems: "center", gap: "14px", padding: "13px 18px", borderBottom: i < arr.length - 1 ? "1px solid rgba(255,255,255,0.04)" : "none" } },
          /*#__PURE__*/React.createElement("svg", { width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: "#d4a846", strokeWidth: "2.5", strokeLinecap: "round", flexShrink: "0" }, /*#__PURE__*/React.createElement("path", { d: "M20 6L9 17l-5-5" })),
          /*#__PURE__*/React.createElement("div", null,
            /*#__PURE__*/React.createElement("div", { style: { fontSize: "13px", color: "#f0e6d3", fontWeight: "500" } }, title),
            /*#__PURE__*/React.createElement("div", { style: { fontSize: "11px", color: "rgba(255,255,255,0.3)", marginTop: "2px" } }, sub)
          )
        )
      )
    ),
    userTier === "premium" || userTier === "lifetime"
      ? (IS_IOS && userTier === "premium" && /*#__PURE__*/React.createElement("button", {
          onClick: () => window.open("https://apps.apple.com/account/subscriptions", "_system"),
          style: { width: "100%", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.4)", borderRadius: "14px", padding: "14px", fontSize: "14px", cursor: "pointer", fontFamily: "inherit", marginBottom: "8px" }
        }, "Manage Subscription"))
      : /*#__PURE__*/React.createElement(React.Fragment, null,
          /* Monthly / Lifetime toggle */
          /*#__PURE__*/React.createElement("div", {
            style: { display: "flex", gap: "6px", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: "50px", padding: "4px", marginBottom: "16px" }
          },
            ["monthly", "lifetime"].map(p =>
              /*#__PURE__*/React.createElement("button", {
                key: p,
                onClick: () => setPremiumPlan(p),
                style: { flex: "1", background: premiumPlan === p ? "linear-gradient(135deg,#d4a846,#c9807a)" : "transparent", color: premiumPlan === p ? "#080810" : "rgba(255,255,255,0.5)", border: "none", borderRadius: "50px", padding: "9px 12px", fontSize: "12px", fontWeight: "700", cursor: "pointer", fontFamily: "inherit" }
              }, p === "monthly" ? "Monthly" : "Lifetime")
            )
          ),
          IS_IOS
            ? /*#__PURE__*/React.createElement("button", {
                onClick: () => upgradeWithApple(premiumPlan),
                disabled: iapWorking,
                style: { width: "100%", background: iapWorking ? "rgba(255,255,255,0.05)" : "linear-gradient(135deg,#d4a846,#c9807a)", color: iapWorking ? "rgba(255,255,255,0.3)" : "#080810", border: "none", borderRadius: "14px", padding: "17px", fontSize: "16px", fontWeight: "700", cursor: iapWorking ? "default" : "pointer", fontFamily: "inherit", marginBottom: "12px" }
              }, iapWorking ? "Opening…" : (premiumPlan === "monthly" ? `Get Premium · ${iapPrice}` : "Get Lifetime · $24.99"))
            : /*#__PURE__*/React.createElement("button", {
                onClick: () => upgradeToStripe(premiumPlan),
                disabled: upgradeWorking,
                style: { width: "100%", background: upgradeWorking ? "rgba(255,255,255,0.05)" : "linear-gradient(135deg,#d4a846,#c9807a)", color: upgradeWorking ? "rgba(255,255,255,0.3)" : "#080810", border: "none", borderRadius: "14px", padding: "17px", fontSize: "16px", fontWeight: "700", cursor: upgradeWorking ? "default" : "pointer", fontFamily: "inherit", marginBottom: "12px" }
              }, upgradeWorking ? "Opening checkout…" : (premiumPlan === "monthly" ? "Get Premium · $2/mo" : "Get Lifetime · $20"))
        ),
    /*#__PURE__*/React.createElement("p", { style: { fontSize: "11px", color: "rgba(255,255,255,0.25)", textAlign: "center", margin: "12px 0 4px", lineHeight: "1.6" } },
      "By subscribing you agree to the ",
      /*#__PURE__*/React.createElement("a", { href: "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/", target: "_blank", rel: "noopener", style: { color: "rgba(255,255,255,0.45)", textDecoration: "underline" } }, "Terms of Use"),
      " and ",
      /*#__PURE__*/React.createElement("a", { href: "https://getliri.com/privacy", target: "_blank", rel: "noopener", style: { color: "rgba(255,255,255,0.45)", textDecoration: "underline" } }, "Privacy Policy"),
      "."
    ),
    /*#__PURE__*/React.createElement("button", {
      onClick: () => setShowPremiumInfo(false),
      style: { width: "100%", background: "none", border: "none", color: "rgba(255,255,255,0.2)", fontSize: "13px", cursor: "pointer", fontFamily: "inherit", padding: "8px" }
    }, "Close")
  )), showChangePw && /*#__PURE__*/React.createElement("div", {
    onClick: () => { if (!changePwWorking && !changePwDone) setShowChangePw(false); },
    style: { position: "fixed", inset: 0, zIndex: 400, background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)", display: "flex", alignItems: "flex-end", justifyContent: "center" }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: e => e.stopPropagation(),
    style: { background: "#0f0f1c", borderRadius: "24px 24px 0 0", padding: "28px 28px max(40px,calc(env(safe-area-inset-bottom)+28px))", maxWidth: "520px", width: "100%", border: "1px solid rgba(255,255,255,0.07)" }
  }, /*#__PURE__*/React.createElement("div", { style: { width: "40px", height: "4px", borderRadius: "2px", background: "rgba(255,255,255,0.12)", margin: "0 auto 20px" } }),
  /*#__PURE__*/React.createElement("div", { style: { fontSize: "20px", fontWeight: "700", color: "#f0e6d3", textAlign: "center", marginBottom: "20px" } }, changePwDone ? "Password updated ✓" : "Change Password"),
  changePwDone ? null : /*#__PURE__*/React.createElement(React.Fragment, null,
    /*#__PURE__*/React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: "10px", marginBottom: "16px" } },
      /*#__PURE__*/React.createElement("input", { type: "password", placeholder: "New password (min 8 characters)", value: changePwNew, onChange: e => setChangePwNew(e.target.value), onKeyDown: e => e.key === "Enter" && handleChangePassword(), autoFocus: true, style: { width: "100%", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "#f0e6d3", padding: "16px 18px", borderRadius: "14px", fontSize: "16px", fontFamily: "inherit" } }),
      /*#__PURE__*/React.createElement("input", { type: "password", placeholder: "Confirm new password", value: changePwConfirm, onChange: e => setChangePwConfirm(e.target.value), onKeyDown: e => e.key === "Enter" && handleChangePassword(), style: { width: "100%", background: "rgba(255,255,255,0.05)", border: `1px solid ${changePwConfirm && changePwConfirm !== changePwNew ? "rgba(232,160,168,0.5)" : "rgba(255,255,255,0.1)"}`, color: "#f0e6d3", padding: "16px 18px", borderRadius: "14px", fontSize: "16px", fontFamily: "inherit" } })
    ),
    changePwError && /*#__PURE__*/React.createElement("div", { style: { fontSize: "13px", color: "#e8a0a8", textAlign: "center", marginBottom: "12px" } }, changePwError),
    /*#__PURE__*/React.createElement("button", { onClick: handleChangePassword, disabled: changePwWorking, style: { width: "100%", background: "linear-gradient(135deg,#d4a846,#c9807a)", color: "#080810", border: "none", borderRadius: "14px", padding: "18px", fontSize: "15px", fontWeight: "700", cursor: changePwWorking ? "wait" : "pointer", opacity: changePwWorking ? 0.6 : 1, fontFamily: "inherit" } }, changePwWorking ? "Updating…" : "Update Password")
  ))), showDeleteAccount && /*#__PURE__*/React.createElement("div", {
    onClick: () => { if (!deleteWorking) setShowDeleteAccount(false); },
    style: { position: "fixed", inset: 0, zIndex: 300, background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", padding: "24px" }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: e => e.stopPropagation(),
    style: { background: "#0f0f1c", borderRadius: "20px", padding: "28px 24px", maxWidth: "320px", width: "100%", border: "1px solid rgba(220,80,80,0.2)" }
  }, /*#__PURE__*/React.createElement("div", {
    style: { fontSize: "18px", fontWeight: "700", color: "#fff", marginBottom: "10px" }
  }, "Delete Account?"), /*#__PURE__*/React.createElement("div", {
    style: { fontSize: "13px", color: "rgba(255,255,255,0.5)", lineHeight: "1.5", marginBottom: "20px" }
  }, "This permanently deletes your account, library, and listening history. This cannot be undone."), deleteError && /*#__PURE__*/React.createElement("div", {
    style: { fontSize: "12px", color: "#e07070", marginBottom: "14px" }
  }, deleteError), /*#__PURE__*/React.createElement("div", {
    style: { display: "flex", gap: "10px" }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setShowDeleteAccount(false),
    disabled: deleteWorking,
    style: { flex: 1, background: "rgba(255,255,255,0.06)", border: "none", borderRadius: "12px", padding: "12px", fontSize: "14px", color: "rgba(255,255,255,0.6)", cursor: "pointer", fontFamily: "inherit" }
  }, "Cancel"), /*#__PURE__*/React.createElement("button", {
    onClick: handleDeleteAccount,
    disabled: deleteWorking,
    style: { flex: 1, background: "rgba(200,60,60,0.7)", border: "none", borderRadius: "12px", padding: "12px", fontSize: "14px", fontWeight: "600", color: "#fff", cursor: deleteWorking ? "not-allowed" : "pointer", fontFamily: "inherit", opacity: deleteWorking ? 0.6 : 1 }
  }, deleteWorking ? "Deleting…" : "Delete")))), showHistory && /*#__PURE__*/React.createElement("div", {
    onClick: () => setShowHistory(false),
    style: {
      position: "fixed",
      inset: 0,
      zIndex: 200,
      background: "rgba(0,0,0,0.5)",
      backdropFilter: "blur(4px)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: e => e.stopPropagation(),
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
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "12px 24px 0",
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: "40px",
      height: "4px",
      borderRadius: "2px",
      background: "rgba(255,255,255,0.12)",
      margin: "0 auto 20px"
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "11px",
      letterSpacing: "3px",
      color: "#d4a846",
      textTransform: "uppercase",
      marginBottom: "16px"
    }
  }, "Recently Played")), /*#__PURE__*/React.createElement("div", {
    style: {
      overflowY: "auto",
      flex: 1,
      padding: "0 24px max(24px, calc(env(safe-area-inset-bottom) + 16px))"
    }
  }, historyLoading ? /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      color: "rgba(255,255,255,0.2)",
      padding: "32px 0"
    }
  }, "Loading\u2026") : history.length === 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      color: "rgba(255,255,255,0.2)",
      padding: "32px 0",
      lineHeight: "1.8"
    }
  }, "No songs yet.", /*#__PURE__*/React.createElement("br", null), "Start listening to build your history.") : history.map((item, i) => /*#__PURE__*/React.createElement("div", {
    key: item.id,
    style: {
      display: "flex",
      alignItems: "center",
      gap: "12px",
      padding: "10px 0",
      borderBottom: i < history.length - 1 ? "1px solid rgba(255,255,255,0.05)" : "none"
    }
  }, item.artwork_url ? /*#__PURE__*/React.createElement("img", {
    src: item.artwork_url,
    alt: "",
    style: {
      width: "44px",
      height: "44px",
      borderRadius: "8px",
      flexShrink: 0,
      objectFit: "cover"
    }
  }) : /*#__PURE__*/React.createElement("div", {
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
  }, /*#__PURE__*/React.createElement("svg", {width:"1em",height:"1em",viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:"2",strokeLinecap:"round",strokeLinejoin:"round"}, /*#__PURE__*/React.createElement("path",{d:"M9 18V5l12-2v13"}), /*#__PURE__*/React.createElement("circle",{cx:"6",cy:"18",r:"3"}), /*#__PURE__*/React.createElement("circle",{cx:"18",cy:"16",r:"3"}))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "14px",
      fontWeight: "600",
      color: "#f0e6d3",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap"
    }
  }, item.title), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "12px",
      color: "rgba(255,255,255,0.4)",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap"
    }
  }, item.artist)), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "11px",
      color: "rgba(255,255,255,0.2)",
      flexShrink: 0
    }
  }, timeAgo(item.listened_at))))))), isSyncing && /*#__PURE__*/React.createElement("div", {
    style: {
      position: "fixed",
      inset: 0,
      zIndex: 10,
      display: "flex",
      flexDirection: "column"
    },
    onPointerMove: isLandscape ? bumpControls : undefined,
    onTouchStart: isLandscape ? bumpControls : undefined
  }, kbToast && /*#__PURE__*/React.createElement("div", {
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
  }, kbToast), isLandscape && /*#__PURE__*/React.createElement("div", {
    style: {
      position: "fixed", top: 0, left: 0, right: 0, height: "52px",
      display: "flex", alignItems: "center", padding: "0 16px", gap: "10px",
      background: "rgba(8,8,16,0.92)", backdropFilter: "blur(12px)",
      borderBottom: "1px solid rgba(255,255,255,0.06)", zIndex: 20
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: reset,
    style: { background: "none", border: "none", color: "rgba(255,255,255,0.45)", fontSize: "18px", cursor: "pointer", padding: "4px 8px 4px 0", lineHeight: 1, flexShrink: 0 }
  }, "\u2190"),
  artwork && /*#__PURE__*/React.createElement("img", {
    src: artwork, alt: "",
    style: { width: "32px", height: "32px", borderRadius: "6px", flexShrink: 0, boxShadow: "0 2px 8px rgba(0,0,0,0.5)" }
  }),
  /*#__PURE__*/React.createElement("div", { style: { flex: 1, minWidth: 0 } },
    /*#__PURE__*/React.createElement("div", { style: { fontSize: "13px", fontWeight: "600", color: "#f0e6d3", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, detectedSong?.title),
    /*#__PURE__*/React.createElement("div", { style: { fontSize: "11px", color: "rgba(255,255,255,0.35)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, detectedSong?.artist)
  ),
  (() => { const si = getSideInfo(); return si ? /*#__PURE__*/React.createElement("div", { style: { fontSize: "10px", fontWeight: "700", letterSpacing: "2px", color: "rgba(212,168,70,0.85)", textTransform: "uppercase", flexShrink: 0 } }, si.side ? `Side ${si.side} \xB7 ${si.track}` : `Track ${si.track}`) : null; })(),
  /*#__PURE__*/React.createElement("button", {
    onClick: () => setShowSettings(!showSettings),
    style: { background: "linear-gradient(135deg,#d4a846,#c9807a)", border: "none", borderRadius: "50%", width: "28px", height: "28px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "11px", fontWeight: "700", color: "#080810", cursor: "pointer", flexShrink: 0, padding: 0 }
  }, user?.email?.[0]?.toUpperCase() || "?")), /*#__PURE__*/React.createElement("div", {
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
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: "10px",
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("button", {
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
  }, "\u2190"), artwork && /*#__PURE__*/React.createElement("img", {
    src: artwork,
    alt: "",
    style: {
      width: "36px",
      height: "36px",
      borderRadius: "8px",
      flexShrink: 0,
      boxShadow: "0 4px 16px rgba(0,0,0,0.5)"
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "14px",
      fontWeight: "600",
      color: "#f0e6d3",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap"
    }
  }, detectedSong?.title), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "12px",
      color: "rgba(255,255,255,0.4)",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap"
    }
  }, detectedSong?.artist), (() => {
    const si = getSideInfo();
    return si ? /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: "4px",
        fontSize: "11px",
        fontWeight: "700",
        letterSpacing: "2px",
        color: "rgba(212,168,70,0.85)",
        textTransform: "uppercase"
      }
    }, si.side ? `Side ${si.side}  ·  Track ${si.track}` : `Track ${si.track}`) : null;
  })())), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: "12px",
      marginLeft: "12px",
      flexShrink: 0
    }
  }, songDuration && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "11px",
      color: "rgba(255,255,255,0.2)"
    }
  }, formatTime(playbackTime), " / ", formatTime(songDuration)), !songDuration && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "12px",
      color: "rgba(255,255,255,0.3)",
      fontVariantNumeric: "tabular-nums"
    }
  }, formatTime(playbackTime)), /*#__PURE__*/React.createElement("button", {
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
  }, user?.email?.[0]?.toUpperCase() || "?"))), /*#__PURE__*/React.createElement("div", {
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
    onClick: e => {
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
    return effDur ? /*#__PURE__*/React.createElement("div", {
      style: {
        height: "100%",
        background: "linear-gradient(to right, #d4a846, #c9807a)",
        width: `${Math.min(playbackTime / effDur * 100, 100)}%`,
        transition: "width 1s linear",
        borderRadius: "0 2px 2px 0"
      }
    }) : null;
  })()), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflow: "hidden",
      position: "relative",
      paddingTop: isLandscape ? "57px" : 0
    }
  }, isResyncing && /*#__PURE__*/React.createElement("div", {
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
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: "relative",
      width: "100px",
      height: "100px",
      marginBottom: "20px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      inset: 0
    }
  }, /*#__PURE__*/React.createElement(ProgressRing, {
    size: 100
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      inset: 0,
      display: "flex",
      alignItems: "center",
      justifyContent: "center"
    }
  }, /*#__PURE__*/React.createElement(WaveAnimation, {
    active: true,
    analyserRef: analyserNodeRef,
    level: audioLevel,
    size: 0.85
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "16px",
      fontWeight: "600",
      color: "rgba(255,255,255,0.7)"
    }
  }, "Resyncing\u2026")), /*#__PURE__*/React.createElement("div", {
    style: {
      overflowY: "auto",
      height: "100%",
      padding: isLandscape ? "4vh 40px 0" : "8vh 28px 0",
      maxWidth: isLandscape ? "760px" : "none",
      marginLeft: isLandscape ? "auto" : undefined,
      marginRight: isLandscape ? "auto" : undefined
    },
    onTouchStart: () => {
      userScrollingRef.current = true;
      setUserScrolling(true);
    },
    onWheel: () => {
      userScrollingRef.current = true;
      setUserScrolling(true);
    }
  }, lyrics.length > 0 ? /*#__PURE__*/React.createElement(React.Fragment, null, (() => {
    // Adaptive transition: scale with how long the current line lasts.
    // Fast rap/spoken sections have lines <1s apart — a 0.4s transition
    // overlaps and looks sluggish. Cap at 0.4s, floor at 0.1s.
    const curLine = lyrics[currentIndex];
    const nextLine = lyrics[currentIndex + 1];
    const lineDur = curLine && nextLine ? nextLine.time - curLine.time : 3;
    const transSec = Math.min(0.4, Math.max(0.1, lineDur * 0.35)).toFixed(2);
    const transition = `all ${transSec}s cubic-bezier(0.4,0,0.2,1)`;
    // Append credit lines after the last lyric so they scroll + highlight naturally
    const lastLyricTime = lyrics.length > 0 ? lyrics[lyrics.length - 1].time : 0;
    const creditLines = [
      ...(detectedSong?.title  ? [{ text: detectedSong.title,  time: lastLyricTime + 5,  isCredit: true }] : []),
      ...(detectedSong?.artist ? [{ text: detectedSong.artist, time: lastLyricTime + 8,  isCredit: true }] : []),
      ...(detectedSong?.album  ? [{ text: detectedSong.album,  time: lastLyricTime + 11, isCredit: true }] : []),
      { text: "Lyrics via LRCLib", time: lastLyricTime + 16, isCredit: true },
      { text: `© ${new Date().getFullYear()} Liri · Music rights belong to their respective artists, labels & publishers.`, time: lastLyricTime + 20, isCredit: true },
    ];
    // Effective current index across real lyrics + credits
    const allLines = [...lyrics, ...creditLines];
    const pastLastLyric = currentIndex >= lyrics.length - 1 && lyrics.length > 0;
    const effectiveIndex = pastLastLyric
      ? lyrics.length - 1 + creditLines.reduce((best, cl, ci) => playbackTime >= cl.time ? ci + 1 : best, 0)
      : currentIndex;
    return allLines.map((line, i) => {
      const dist = i - effectiveIndex;
      const cur = dist === 0;
      const near = Math.abs(dist) <= 3;
      const isCredit = !!line.isCredit;
      return /*#__PURE__*/React.createElement("div", {
        key: i,
        ref: cur ? currentLineRef : i === lyrics.length ? creditsRef : null,
        onClick: () => cur ? refollow() : (!isCredit && seekToLine(i)),
        style: {
          textAlign: "center",
          padding: near ? "6px 0" : "3px 0",
          fontSize: isCredit
            ? (cur ? "15px" : Math.abs(dist) <= 1 ? "13px" : "11px")
            : (cur ? (isLandscape ? "36px" : "32px") : Math.abs(dist) <= 1 ? (isLandscape ? "24px" : "20px") : near ? (isLandscape ? "20px" : "16px") : (isLandscape ? "16px" : "13px")),
          fontWeight: cur && !isCredit ? "700" : "400",
          color: cur
            ? (isCredit ? "rgba(255,255,255,0.55)" : "#ffffff")
            : dist > 0
              ? `rgba(255,255,255,${Math.max(isLandscape ? 0.18 : 0.07, (isLandscape ? 0.55 : 0.28) - Math.abs(dist) * (isLandscape ? 0.06 : 0.04))})`
              : `rgba(255,255,255,${Math.max(isLandscape ? 0.12 : 0.05, (isLandscape ? 0.35 : 0.18) - Math.abs(dist) * (isLandscape ? 0.04 : 0.02))})`,
          lineHeight: "1.4",
          transition: near ? transition : "none",
          textShadow: cur && !isCredit ? "0 0 60px rgba(212,168,70,0.4), 0 2px 20px rgba(0,0,0,0.8)" : "none",
          cursor: isCredit ? "default" : "pointer",
          letterSpacing: isCredit ? "0.2px" : "normal",
          maxWidth: isCredit ? "260px" : "none",
          margin: isCredit ? "0 auto" : "0",
        }
      }, line.text);
    });
  })(), /*#__PURE__*/React.createElement("div", { style: { paddingBottom: "30vh" } })) : /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      color: "rgba(255,255,255,0.2)",
      fontSize: "16px",
      paddingTop: "30vh"
    }
  }, "No lyrics found for this track")), /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      height: "15vh",
      background: "linear-gradient(to bottom, rgba(8,8,16,0.9), transparent)",
      pointerEvents: "none"
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      bottom: 0,
      left: 0,
      right: 0,
      height: "20vh",
      background: "linear-gradient(to top, rgba(8,8,16,1), transparent)",
      pointerEvents: "none"
    }
  })), /*#__PURE__*/React.createElement("div", {
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
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      fontSize: "10px",
      letterSpacing: "2px",
      textTransform: "uppercase",
      marginBottom: "8px",
      color: isResyncing ? "#d4a846" : "rgba(255,255,255,0.18)",
      animation: isResyncing ? "pulse 1.2s ease-in-out infinite" : "none"
    }
  }, isResyncing ? "↻ listening for resync…" : "← early · behind →"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "center",
      flexWrap: "wrap",
      gap: "6px",
      marginBottom: "10px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: "relative"
    },
    onPointerEnter: () => setHoverNudge("left"),
    onPointerLeave: () => setHoverNudge(null)
  }, /*#__PURE__*/React.createElement("button", {
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
  }, "\u22121s"), hoverNudge === "left" && /*#__PURE__*/React.createElement("button", {
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
  }, "\u22120.5s")), /*#__PURE__*/React.createElement("div", {
    style: {
      position: "relative"
    },
    onPointerEnter: () => setHoverNudge("right"),
    onPointerLeave: () => setHoverNudge(null)
  }, /*#__PURE__*/React.createElement("button", {
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
  }, "+1s"), hoverNudge === "right" && /*#__PURE__*/React.createElement("button", {
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
  }, "+0.5s"))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "center",
      flexWrap: "wrap",
      gap: "6px",
      marginBottom: "8px"
    }
  }, userScrolling && /*#__PURE__*/React.createElement("button", {
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
  }, "\u2193 Follow"), /*#__PURE__*/React.createElement("button", {
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
  }, isPaused ? "▶ Resume" : "|| Pause"), IS_IOS && /*#__PURE__*/React.createElement("button", {
    onClick: () => { logButtonEvent("resync"); resync(); },
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
  }, "\u21BB Resync"), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      logButtonEvent("wrong_song");
      reset();
      setShowTrackList(true);
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
    // Prefer library (turntableTracksRef) over iTunes (albumTracks) whenever available
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
    return /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "8px",
        marginTop: "6px",
        marginBottom: "2px"
      }
    }, /*#__PURE__*/React.createElement("button", {
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
    }, "\u2190"), /*#__PURE__*/React.createElement("div", {
      style: {
        textAlign: "center",
        maxWidth: "160px"
      }
    }, nextTrackName ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: "8px",
        color: "rgba(255,255,255,0.15)",
        letterSpacing: "1px",
        textTransform: "uppercase",
        marginBottom: "1px"
      }
    }, "Next song"), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: "10px",
        color: "rgba(255,255,255,0.25)",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap"
      }
    }, nextTrackName)) : /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: "9px",
        color: "rgba(255,255,255,0.12)",
        letterSpacing: "0.5px"
      }
    }, "Last track")), /*#__PURE__*/React.createElement("button", {
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
  })(), (() => {
    // \u2500\u2500 Tracklist peek while listening \u2500\u2500
    // A toggle that reveals where you are on the record: every track, the
    // current one highlighted, how many you've passed and how many remain.
    const hasTT = turntableAlbum && turntableTracksRef.current.length > 0 && turntableMatchedIdxRef.current >= 0;
    const tIdx = hasTT ? turntableMatchedIdxRef.current : currentTrackIndex;
    const tTracks = hasTT ? turntableTracksRef.current : albumTracks;
    if (tTracks.length === 0 || tIdx < 0) return null;
    const remaining = tTracks.length - tIdx - 1;
    const nameOf = t => t?.trackName || t?.title || "";
    const jumpTo = i => { hasTT ? jumpToTrackIdx(i) : jumpToTrack(i); setShowNowPlayingList(false); };
    return /*#__PURE__*/React.createElement(React.Fragment, null,
      /*#__PURE__*/React.createElement("button", {
        onClick: () => setShowNowPlayingList(v => !v),
        style: {
          display: "block", margin: "8px auto 0", background: "rgba(255,255,255,0.05)",
          border: "1px solid rgba(255,255,255,0.1)", color: "rgba(255,255,255,0.45)",
          borderRadius: "50px", padding: "6px 16px", fontSize: "11px", fontWeight: "600",
          letterSpacing: "0.5px", cursor: "pointer", fontFamily: "inherit"
        }
      }, `\u2630  Track ${tIdx + 1} of ${tTracks.length}`),
      showNowPlayingList && /*#__PURE__*/React.createElement("div", {
        onClick: () => setShowNowPlayingList(false),
        style: { position: "fixed", inset: 0, zIndex: 600, background: "rgba(8,8,16,0.75)", backdropFilter: "blur(6px)", display: "flex", flexDirection: "column", justifyContent: "flex-end" }
      }, /*#__PURE__*/React.createElement("div", {
        onClick: e => e.stopPropagation(),
        style: { background: "#0e0e1a", borderRadius: "20px 20px 0 0", border: "1px solid rgba(255,255,255,0.09)", maxHeight: "80vh", display: "flex", flexDirection: "column", paddingBottom: "max(24px, calc(env(safe-area-inset-bottom) + 12px))" }
      },
        /*#__PURE__*/React.createElement("div", {
          style: { padding: "18px 20px 12px", borderBottom: "1px solid rgba(255,255,255,0.06)" }
        },
          /*#__PURE__*/React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
            /*#__PURE__*/React.createElement("div", { style: { fontSize: "16px", fontWeight: "700", color: "#f0e6d3" } }, turntableAlbum?.album_name || "This record"),
            /*#__PURE__*/React.createElement("button", { onClick: () => setShowNowPlayingList(false), style: { background: "rgba(255,255,255,0.07)", border: "none", color: "rgba(255,255,255,0.6)", borderRadius: "50%", width: "30px", height: "30px", fontSize: "17px", cursor: "pointer", fontFamily: "inherit" } }, "\u00d7")),
          /*#__PURE__*/React.createElement("div", { style: { fontSize: "12px", color: "rgba(212,168,70,0.85)", marginTop: "4px" } },
            `${tIdx + 1} of ${tTracks.length} played \u00b7 ${remaining} left on the record`)),
        /*#__PURE__*/React.createElement("div", {
          style: { overflowY: "auto", padding: "8px 0" }
        }, tTracks.map((t, i) => {
          const isCur = i === tIdx, isPast = i < tIdx;
          return /*#__PURE__*/React.createElement("button", {
            key: i, onClick: () => jumpTo(i),
            style: {
              display: "flex", alignItems: "center", gap: "12px", width: "100%", textAlign: "left",
              background: isCur ? "rgba(212,168,70,0.12)" : "none", border: "none",
              borderLeft: isCur ? "3px solid #d4a846" : "3px solid transparent",
              padding: "11px 18px", cursor: "pointer", fontFamily: "inherit"
            }
          },
            /*#__PURE__*/React.createElement("div", { style: { width: "20px", flexShrink: 0, fontSize: "12px", color: isCur ? "#d4a846" : "rgba(255,255,255,0.3)", textAlign: "center" } },
              isCur ? "\u25b6" : isPast ? "\u2713" : String(i + 1)),
            /*#__PURE__*/React.createElement("div", { style: { flex: 1, minWidth: 0, fontSize: "14px", fontWeight: isCur ? "700" : "500", color: isCur ? "#f0e6d3" : isPast ? "rgba(255,255,255,0.35)" : "rgba(240,230,211,0.8)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, nameOf(t)),
            t.trackTimeMillis ? /*#__PURE__*/React.createElement("div", { style: { flexShrink: 0, fontSize: "12px", color: "rgba(255,255,255,0.3)", fontVariantNumeric: "tabular-nums" } }, formatTime(t.trackTimeMillis / 1000)) : null);
        }))))
    );
  })(), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      marginTop: "6px",
      fontSize: "9px",
      color: "rgba(255,255,255,0.1)",
      letterSpacing: "1px"
    }
  }, "v", APP_VERSION))), !isSyncing && /*#__PURE__*/React.createElement("div", {
    style: {
      position: "relative",
      zIndex: 10,
      minHeight: "100vh",
      display: "flex",
      flexDirection: "column"
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "safe-top",
    style: {
      padding: "0 20px 16px",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("button", {
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
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "9px",
      letterSpacing: "1px",
      color: "rgba(255,255,255,0.15)",
      fontWeight: "400"
    }
  }, "v", APP_VERSION), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "16px",
      letterSpacing: "10px",
      color: "#d4a846",
      fontWeight: "300"
    }
  }, "LIRI")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: "12px",
      alignItems: "center"
    }
  }, /*#__PURE__*/React.createElement("button", {
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
  }, /*#__PURE__*/React.createElement("svg", {width:"1em",height:"1em",viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:"1.8",strokeLinecap:"round",strokeLinejoin:"round"}, /*#__PURE__*/React.createElement("circle",{cx:"12",cy:"12",r:"10"}), /*#__PURE__*/React.createElement("polyline",{points:"12 6 12 12 16 14"}))), /*#__PURE__*/React.createElement("button", {
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
  }, user?.email?.[0]?.toUpperCase() || "?"))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      padding: "8px 32px 96px",
      textAlign: "center"
    }
  }, mode === "idle" && /*#__PURE__*/React.createElement("div", {
    style: {
      animation: "fade-up 0.5s ease both",
      width: "100%",
      maxWidth: isLandscape ? "560px" : "320px"
    }
  }, /*#__PURE__*/React.createElement(Vinyl, {
    size: 130,
    spinning: false
  }), lastSong && /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: "20px",
      padding: "10px 14px",
      background: "rgba(255,255,255,0.03)",
      border: "1px solid rgba(255,255,255,0.06)",
      borderRadius: "14px",
      textAlign: "left"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "10px",
      letterSpacing: "2px",
      textTransform: "uppercase",
      color: "rgba(255,255,255,0.2)",
      marginBottom: "6px"
    }
  }, "Last played"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "14px",
      fontWeight: "600",
      color: "rgba(255,255,255,0.7)",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap"
    }
  }, lastSong.title), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "12px",
      color: "rgba(255,255,255,0.3)",
      marginTop: "2px"
    }
  }, lastSong.artist)), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: "32px",
      marginBottom: "24px"
    }
  }, turntableAlbum ?
  /*#__PURE__*/
  // Album selected — whole card is tappable to change
  React.createElement("button", {
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
  }, turntableAlbum.artwork_url ? /*#__PURE__*/React.createElement("img", {
    src: turntableAlbum.artwork_url,
    alt: "",
    style: {
      width: 48,
      height: 48,
      borderRadius: 8,
      objectFit: "cover",
      flexShrink: 0
    }
  }) : /*#__PURE__*/React.createElement("div", {
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
  }, /*#__PURE__*/React.createElement("svg", {width:"1em",height:"1em",viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:"1.5",strokeLinecap:"round"}, /*#__PURE__*/React.createElement("circle",{cx:"12",cy:"12",r:"10"}), /*#__PURE__*/React.createElement("circle",{cx:"12",cy:"12",r:"3"}))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0,
      textAlign: "left"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "13px",
      fontWeight: 600,
      color: "#f0e6d3",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap"
    }
  }, turntableAlbum.album_name), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "11px",
      color: "rgba(255,255,255,0.4)",
      marginTop: 2,
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap"
    }
  }, turntableAlbum.artist_name)), turntableTracksLoading ? /*#__PURE__*/React.createElement("div", {
    style: {
      width: 14,
      height: 14,
      borderRadius: "50%",
      border: "2px solid rgba(255,255,255,0.1)",
      borderTopColor: "#d4a846",
      animation: "spin 0.8s linear infinite",
      flexShrink: 0
    }
  }) : /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: "11px",
      color: "rgba(255,255,255,0.3)",
      flexShrink: 0
    }
  }, "change")) :
  /*#__PURE__*/
  // No album selected — prominent call to action
  React.createElement("button", {
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
  }, /*#__PURE__*/React.createElement("div", {
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
  }, /*#__PURE__*/React.createElement("svg", {width:"1em",height:"1em",viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:"1.5",strokeLinecap:"round"}, /*#__PURE__*/React.createElement("circle",{cx:"12",cy:"12",r:"10"}), /*#__PURE__*/React.createElement("circle",{cx:"12",cy:"12",r:"3"}))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "13px",
      fontWeight: 600,
      color: "rgba(212,168,70,0.9)"
    }
  }, "What's on the turntable?"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "11px",
      color: "rgba(255,255,255,0.35)",
      marginTop: 2
    }
  }, "Tap to choose a record from your library")))), /*#__PURE__*/React.createElement("button", {
    id: "liri-listen-cta",
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
  }, turntableTracksLoading ? "Loading…" : turntableAlbum ? "Find my place" : "Listen"), !turntableTracksLoading && turntableAlbum && currentTrackIndex >= 0 && getNextSideLetter() && /*#__PURE__*/React.createElement("button", {
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
  }, (function(){ var _di = getNextDiscInfo(); return _di && (_di.isNewDisc ? "Grab LP " + _di.nextDisc : "Flip to Side " + _di.nextSide); })())), mode === "listening" && /*#__PURE__*/React.createElement("div", {
    style: {
      animation: "fade-up 0.3s ease both",
      overflowY: showTrackList ? "auto" : "visible",
      maxHeight: showTrackList ? "75vh" : "none",
      width: "100%",
      WebkitOverflowScrolling: "touch"
    }
  }, !(turntableAlbum && (!window.Capacitor || showTrackList)) && /*#__PURE__*/React.createElement("div", {
    style: {
      position: "relative",
      width: "120px",
      height: "120px",
      margin: "0 auto 16px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      inset: 0
    }
  }, /*#__PURE__*/React.createElement(ProgressRing, {
    size: 120
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      inset: 0,
      display: "flex",
      alignItems: "center",
      justifyContent: "center"
    }
  }, /*#__PURE__*/React.createElement(WaveAnimation, {
    active: true,
    analyserRef: analyserNodeRef,
    level: audioLevel
  }))), !turntableAlbum && listenAttempt <= MAX_ATTEMPTS && /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: "20px",
      fontSize: "11px",
      letterSpacing: "1.5px",
      textTransform: "uppercase",
      color: audioLevel > 0.05 ? "#d4a846" : "#c9807a",
      transition: "color 0.2s ease"
    }
  }, audioLevel > 0.25 ? "● Loud — perfect" : audioLevel > 0.05 ? "● Good signal" : "● Too quiet — move closer"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "22px",
      fontWeight: "600",
      color: "#f0e6d3",
      marginBottom: "10px",
      marginTop: !turntableAlbum && listenAttempt > MAX_ATTEMPTS ? "20px" : "0"
    }
  }, turntableAlbum ? (window.Capacitor ? (showTrackList ? "Can't find it automatically" : "Finding your place…") : "Pick a track to start") : listenAttempt > MAX_ATTEMPTS ? "Matching by lyrics…" : "Listening…"),

  /* ── Manual track picker with side grouping ── */
  turntableAlbum && (showTrackList || !window.Capacitor) && turntableTracksRef.current.length > 0 && (() => {
    const allTracks = turntableTracksRef.current;
    const groups = getSideGroups(allTracks, vinylSidesRef.current, vinylDbRelease?.vinyl_tracks);
    const isWeb = !window.Capacitor;
    return /*#__PURE__*/React.createElement("div", {
      style: { marginTop: isWeb ? "8px" : "24px", width: "100%", maxWidth: "360px", textAlign: "left" }
    },
      // iOS only: toggle button to reveal/hide the list
      !isWeb && /*#__PURE__*/React.createElement("button", {
        onClick: () => setShowTrackList(v => !v),
        style: { fontSize: "11px", letterSpacing: "1.5px", textTransform: "uppercase", color: "rgba(255,255,255,0.35)", marginBottom: "10px", textAlign: "center", width: "100%", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }
      }, showTrackList ? "▲ Or jump to a track" : "▼ Or jump to a track"),
      (isWeb || showTrackList) && /*#__PURE__*/React.createElement("div", {
        style: { display: "flex", flexDirection: "column", gap: "12px", maxHeight: isWeb ? "60vh" : "45vh", overflowY: "auto", WebkitOverflowScrolling: "touch" }
      }, groups.map(({ side, tracks }) =>
        /*#__PURE__*/React.createElement("div", { key: side },
          /*#__PURE__*/React.createElement("button", {
            onClick: () => toggleSideCollapse(side),
            style: { display: "flex", alignItems: "center", gap: "8px", width: "100%", background: "none", border: "none", cursor: "pointer", padding: "4px 0 8px", fontFamily: "inherit" }
          },
            /*#__PURE__*/React.createElement("span", { style: { fontSize: "10px", letterSpacing: "2px", textTransform: "uppercase", color: "rgba(212,168,70,0.8)", fontWeight: "700" } }, `Side ${side}`),
            /*#__PURE__*/React.createElement("span", { style: { fontSize: "10px", color: "rgba(255,255,255,0.2)", marginLeft: "auto" } }, collapsedSides.has(side) ? "▼" : "▲")
          ),
          !collapsedSides.has(side) && /*#__PURE__*/React.createElement("div", {
            style: { display: "flex", flexDirection: "column", gap: "4px" }
          }, tracks.map(({ track: t, idx: i }) =>
            /*#__PURE__*/React.createElement("button", {
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
              /*#__PURE__*/React.createElement("span", { style: { color: "rgba(255,255,255,0.25)", fontSize: "11px", minWidth: "16px" } }, i + 1),
              t.trackName
            )
          ))
        )
      ))
    );
  })(),

  /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: "12px",
      marginTop: "28px",
      justifyContent: "center"
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      listenSessionRef.current++;
      clearInterval(progressTimerRef.current);
      streamRef.current?.getTracks().forEach(t => t.stop());
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
  }, "Stop"), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      listenSessionRef.current++;
      clearInterval(progressTimerRef.current);
      streamRef.current?.getTracks().forEach(t => t.stop());
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
  }, "\u21BA Try again"))), mode === "detecting" && /*#__PURE__*/React.createElement("div", {
    style: {
      animation: "fade-up 0.3s ease both"
    }
  }, /*#__PURE__*/React.createElement(Vinyl, {
    size: 100,
    spinning: true
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: "28px",
      fontSize: "20px",
      fontWeight: "600",
      color: "#f0e6d3",
      marginBottom: "8px"
    }
  }, "Identifying\u2026"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "14px",
      color: "rgba(255,255,255,0.3)"
    }
  }, "Just a moment"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: "10px",
      justifyContent: "center",
      marginTop: "28px"
    }
  }, /*#__PURE__*/React.createElement("button", {
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
  }, "\u2190 Stop"), /*#__PURE__*/React.createElement("button", {
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
  }, "\u21BA Try again"))), mode === "error" && /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: "320px",
      animation: "fade-up 0.3s ease both"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "48px",
      marginBottom: "20px"
    }
  }, "\uD83C\uDFB5"), error?.split("\n\n").map((block, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    onClick: i === 1 ? () => {
      navigator.clipboard?.writeText(block).catch(() => {});
    } : undefined,
    title: i === 1 ? "Tap to copy log" : undefined,
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
  }, block)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: "10px",
      flexWrap: "wrap",
      justifyContent: "center",
      marginTop: "8px"
    }
  }, /*#__PURE__*/React.createElement("button", {
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
  }, "Try Again"), lastRecordingRef.current && /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      const url = URL.createObjectURL(lastRecordingRef.current);
      const a = document.createElement("a");
      a.href = url;
      a.download = "liri-recording.webm";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
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
  }, "\u2193 recording"))), mode === "side-end" && /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: "300px",
      animation: "fade-up 0.3s ease both",
      textAlign: "center"
    }
  }, /*#__PURE__*/React.createElement(Vinyl, {
    size: 100,
    spinning: false
  }), sideEndReason === "flip" && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: "32px",
      fontSize: "22px",
      fontWeight: "700",
      color: "#f0e6d3",
      marginBottom: "12px"
    }
  }, sideEndNextDiscInfo && sideEndNextDiscInfo.isNewDisc ? "Time for LP " + sideEndNextDiscInfo.nextDisc + "! \uD83D\uDCBF" : "Time to flip! \uD83D\uDCBF"), /*#__PURE__*/React.createElement("div", {
    style: {
      color: "rgba(255,255,255,0.4)",
      marginBottom: "36px",
      lineHeight: "1.8",
      fontSize: "15px"
    }
  }, sideEndNextDiscInfo && sideEndNextDiscInfo.isNewDisc ? "Grab LP " + sideEndNextDiscInfo.nextDisc + " and tap below." : "Flip the record, then tap below."), isNeedleDrop ? /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: "8px",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: "10px",
      animation: "fade-up 0.3s ease both"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: "36px",
      height: "36px",
      border: "3px solid rgba(212,168,70,0.2)",
      borderTop: "3px solid #d4a846",
      borderRadius: "50%",
      animation: "spin 0.9s linear infinite"
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: { fontSize: "13px", color: "rgba(255,255,255,0.35)" }
  }, "Dropping needle…")) : /*#__PURE__*/React.createElement(React.Fragment, null, turntableTracksRef.current.length > 0 && (sideEndNextDiscInfo || getNextSideLetter()) && /*#__PURE__*/React.createElement("button", {
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
  }, sideEndNextDiscInfo && sideEndNextDiscInfo.isNewDisc ? "Start Side " + sideEndNextDiscInfo.nextSide + " \u2192" : "Flip to Side " + (sideEndNextDiscInfo ? sideEndNextDiscInfo.nextSide : getNextSideLetter()) + " \u2192"), IS_IOS && /*#__PURE__*/React.createElement("button", {
    onClick: () => { reset(); setTimeout(() => startListening(false), 300); },
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
  }, "\u21BB Listen with Shazam"), lastSong && /*#__PURE__*/React.createElement("button", {
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
  }, "\u2190 Back"))), sideEndReason === "album-end" && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: "32px",
      fontSize: "22px",
      fontWeight: "700",
      color: "#f0e6d3",
      marginBottom: "12px"
    }
  }, "That's the album! \ud83c\udfb6"), /*#__PURE__*/React.createElement("div", {
    style: {
      color: "rgba(255,255,255,0.4)",
      marginBottom: "36px",
      lineHeight: "1.8",
      fontSize: "15px"
    }
  }, "Put on your next LP to keep going."), /*#__PURE__*/React.createElement("button", {
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
  }, "New LP \u2192"), lastSong && /*#__PURE__*/React.createElement("button", {
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
  }, "\u2190 Back")), sideEndReason === "failed" && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: "32px",
      fontSize: "22px",
      fontWeight: "700",
      color: "#f0e6d3",
      marginBottom: "12px"
    }
  }, (function(){ var _di = getNextDiscInfo(); return _di && _di.isNewDisc ? "Time for LP " + _di.nextDisc + "?" : "Time to flip?"; })()), /*#__PURE__*/React.createElement("div", {
    style: {
      color: "rgba(255,255,255,0.4)",
      marginBottom: "36px",
      lineHeight: "1.8",
      fontSize: "15px"
    }
  }, (function(){ var _di = getNextDiscInfo(); return _di && _di.isNewDisc ? "Grab LP " + _di.nextDisc + " and tap below." : "Flip the record, then tap below."; })()), isNeedleDrop ? /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: "8px",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: "10px",
      animation: "fade-up 0.3s ease both"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: "36px",
      height: "36px",
      border: "3px solid rgba(212,168,70,0.2)",
      borderTop: "3px solid #d4a846",
      borderRadius: "50%",
      animation: "spin 0.9s linear infinite"
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: { fontSize: "13px", color: "rgba(255,255,255,0.35)" }
  }, "Dropping needle…")) : /*#__PURE__*/React.createElement(React.Fragment, null, turntableTracksRef.current.length > 0 && (getNextDiscInfo() || getNextSideLetter()) && /*#__PURE__*/React.createElement("button", {
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
  }, (function(){ var _di = getNextDiscInfo(); return _di && _di.isNewDisc ? "Start Side " + _di.nextSide + " \u2192" : "Flip to Side " + (_di ? _di.nextSide : getNextSideLetter()) + " \u2192"; })()), IS_IOS && /*#__PURE__*/React.createElement("button", {
    onClick: () => { reset(); setTimeout(() => startListening(false), 300); },
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
  }, "\u21BB Listen with Shazam"), lastSong && /*#__PURE__*/React.createElement("button", {
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
  }, "\u2190 Back")))), mode === "limit" && /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: "300px",
      animation: "fade-up 0.3s ease both",
      textAlign: "center"
    }
  }, /*#__PURE__*/React.createElement(Vinyl, {
    size: 100,
    spinning: false
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: "32px",
      fontSize: "22px",
      fontWeight: "700",
      color: "#f0e6d3",
      marginBottom: "12px"
    }
  }, "Your free crate is full"), /*#__PURE__*/React.createElement("div", {
    style: {
      color: "rgba(255,255,255,0.4)",
      marginBottom: "36px",
      lineHeight: "1.8",
      fontSize: "15px"
    }
  }, "You've added 10 free records.", /*#__PURE__*/React.createElement("br", null), "Upgrade to keep building your collection."),
  /* Monthly / Lifetime toggle */
  /*#__PURE__*/React.createElement("div", {
    style: { display: "flex", gap: "6px", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: "50px", padding: "4px", marginBottom: "16px" }
  },
    ["monthly", "lifetime"].map(p =>
      /*#__PURE__*/React.createElement("button", {
        key: p,
        onClick: () => setPremiumPlan(p),
        style: { flex: "1", background: premiumPlan === p ? "linear-gradient(135deg,#d4a846,#c9807a)" : "transparent", color: premiumPlan === p ? "#080810" : "rgba(255,255,255,0.5)", border: "none", borderRadius: "50px", padding: "9px 12px", fontSize: "12px", fontWeight: "700", cursor: "pointer", fontFamily: "inherit" }
      }, p === "monthly" ? "Monthly" : "Lifetime")
    )
  ),
  IS_IOS
    ? /*#__PURE__*/React.createElement(React.Fragment, null,
        /*#__PURE__*/React.createElement("button", {
          onClick: () => upgradeWithApple(premiumPlan),
          disabled: iapWorking,
          style: { background: "linear-gradient(135deg,#d4a846,#c9807a)", color: "#080810", border: "none", borderRadius: "50px", padding: "14px 32px", fontSize: "14px", fontWeight: "700", cursor: "pointer", fontFamily: "inherit", marginBottom: "8px", width: "100%", opacity: iapWorking ? 0.6 : 1 }
        }, iapWorking ? "Processing…" : (premiumPlan === "monthly" ? `Subscribe · ${iapPrice}` : "Get Lifetime · $24.99")),
        /*#__PURE__*/React.createElement("button", {
          onClick: restoreApplePurchases,
          disabled: iapWorking,
          style: { background: "none", border: "none", color: "rgba(255,255,255,0.3)", fontSize: "12px", cursor: "pointer", fontFamily: "inherit", padding: "8px", marginBottom: "4px" }
        }, "Restore Purchases"))
    : /*#__PURE__*/React.createElement("button", {
        onClick: () => upgradeToStripe(premiumPlan),
        disabled: upgradeWorking,
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
          width: "100%",
          opacity: upgradeWorking ? 0.6 : 1
        }
      }, upgradeWorking ? "Opening checkout…" : (premiumPlan === "monthly" ? "Upgrade to Premium · $2/mo" : "Get Lifetime · $20")), /*#__PURE__*/React.createElement("button", {
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
ReactDOM.createRoot(document.getElementById("root")).render(
  /*#__PURE__*/React.createElement(React.Fragment, null,
    /*#__PURE__*/React.createElement(Liri, null),
    window.TabBar ? /*#__PURE__*/React.createElement(window.TabBar, { current: "listen" }) : null
  )
);
