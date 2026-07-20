import { parseLRC, formatTime, timeAgo, normText } from "../base/lib/text.js";
import { plainToLines, orderLibrary } from "../base/lib/library.js";
import { matchTranscriptToTracks } from "../base/lib/match.js";
import {
  logListeningEvent as libLogListeningEvent,
  maybeAutoPostPlay as libMaybeAutoPostPlay,
  logFlipEvent as libLogFlipEvent,
  logButtonEvent as libLogButtonEvent,
} from "../base/lib/analytics.js";
import { IS_IOS, TRANSCRIBE_PROXY, ITUNES_PROXY, PLAYBACK_OFFSET_CORRECTION, AUTO_ADVANCE_OFFSET, SYNC_PLAYBACK_RATE } from "../base/lib/config.js";
import { usePayments } from "./hooks/usePayments.js";
import { useNowPlaying } from "./hooks/useNowPlaying.js";
import { useLyricScroll } from "./hooks/useLyricScroll.js";
import { useCast } from "./hooks/useCast.js";
import { startWhisperChunks } from "../base/lib/whisper.js";
import { getSideGroups, hasSideData } from "../base/lib/sides.js";
import { LYRIC_SITES, saveUserLyrics, buildSideRows, saveUserSides } from "../base/lib/usermeta.js";
import { showFlipPushNotification, showAlbumEndPushNotification, getLocalNotif } from "../base/lib/notifications.js";
import { Vinyl }          from "../base/components/Vinyl.js";
import { WaveAnimation }  from "../base/components/WaveAnimation.js";
import { ProgressRing }   from "../base/components/ProgressRing.js";
import { LyricsEditorSheet } from "../base/components/LyricsEditorSheet.js";
import { SideInfoSheet }     from "../base/components/SideInfoSheet.js";
import { Shazam }         from "../ios/shazam.js";
import { getNativeAudio } from "../ios/audio.js";
import { getKeepAwake }   from "../ios/keep-awake.js";

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
// Per-tab auth storage: sessionStorage wins (each browser tab keeps its own
// account), localStorage is the fallback + write-through so new tabs and app
// relaunches (iOS clears sessionStorage) still restore the last login.
const liriAuthStorage = {
  getItem: k => { try { return sessionStorage.getItem(k) ?? localStorage.getItem(k); } catch { return null; } },
  setItem: (k, v) => { try { sessionStorage.setItem(k, v); } catch {} try { localStorage.setItem(k, v); } catch {} },
  removeItem: k => { try { sessionStorage.removeItem(k); } catch {} try { localStorage.removeItem(k); } catch {} },
};
const sb = supabase.createClient("https://xjdjpaxgymgbvcwmvorc.supabase.co", "sb_publishable_C-NBnfg0ltAoUi46XQTUjA_ozjZW_Nd", { auth: { storage: liriAuthStorage } });
const APP_VERSION = "1.5.14";
// Lyrics lead the audio clock by this many seconds — the highlighted line
// switches slightly BEFORE its nominal timestamp. Displayed time / progress bar
// are unaffected (we only add this to the line-matching comparison). Helps the
// perceived sync since reading slightly ahead feels more in-time than behind.
// Back to 1s (was bumped to 2s in v1.5.2 when lyrics "felt late" — that
// lateness was actually the clock-drift bug, fixed on this branch; with an
// honest clock the 2s lead made every line feel rushed).
const LYRIC_LEAD_SECONDS = 1;
// Give the listener an early visual cue during an instrumental intro without
// advancing the timing of every later line. The first lyric starts lighting up
// two seconds early, then remains fully highlighted until the next line.
const FIRST_LYRIC_PRELIGHT_SECONDS = 2;
const FIRST_LYRIC_FADE_SECONDS = 0.35;
// Switch the UI to the next track as soon as the current duration ends, then
// park its lyric clock at 0:00 for the physical inter-track groove.
const TRACK_GAP_MS = 1000;
const SIDE_END_HANDOFF_MS = 650;
// How long the lyric clock parks at 0 after a manual flip / side pick while
// the user physically flips the record and drops the needle.
const FLIP_NEEDLE_DROP_MS = 10000;
// Seconds moved per nudge press (buttons + arrow keys) and per fine-step
// press (the hover buttons under the main ones). Labels show the real values.
const NUDGE_STEP_SECS = 1.0;
const NUDGE_FINE_SECS = 0.5;
// Stable per-tab id (survives refresh via sessionStorage) — used by the
// playing-tab heartbeat so multiple Liri tabs don't double-run one session.
const sessionTabId = (() => {
  try {
    let id = sessionStorage.getItem("liri_tab_id");
    if (!id) { id = Math.random().toString(36).slice(2); sessionStorage.setItem("liri_tab_id", id); }
    return id;
  } catch { return String(Math.random()); }
})();
// Shazam + NativeAudio plugin bridges are imported from app/ios/.

//   3. Landing page feature cards (🎵 → sound/wave art, 💿 → vinyl art)
//      Note: ✦ (sparkle character) is intentional Liri type — keep it
//   4. Settings panel — consider a custom Liri icon or wordmark instead of generic text
// All original artwork should match the dark palette: deep navy #080810, gold #d4a846, rose #c9807a
// ─────────────────────────────────────────────────────────────────────────────────────────────

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
      .safe-bottom { padding-bottom: max(72px, calc(env(safe-area-inset-bottom) + 64px)) !important; }
    `;
document.head.appendChild(styleEl);

function CastGlyph({ connected = false }) {
  return /*#__PURE__*/React.createElement("svg", {
    width: "20", height: "20", viewBox: "0 0 24 24", fill: "none",
    stroke: connected ? "#d4a846" : "currentColor", strokeWidth: "1.7",
    strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true"
  }, /*#__PURE__*/React.createElement("path", { d: "M4 18.5a1.5 1.5 0 0 1 1.5 1.5" }),
  /*#__PURE__*/React.createElement("path", { d: "M4 14a6 6 0 0 1 6 6" }),
  /*#__PURE__*/React.createElement("path", { d: "M4 9.5A10.5 10.5 0 0 1 14.5 20" }),
  /*#__PURE__*/React.createElement("path", { d: "M8 4h10a2 2 0 0 1 2 2v12" }));
}

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
  const [winW, setWinW] = useState(window.innerWidth);
  useEffect(() => {
    const onResize = () => {
      setIsLandscape(window.innerWidth > window.innerHeight && window.innerWidth >= 600);
      setWinW(window.innerWidth);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // Sync controls (nudge / pause / track nav) live behind the edge-mounted
  // vinyl button: hidden by default, opened
  // only by an explicit tap — never by touching or scrolling the lyrics.
  // Tapping the lyrics background closes them.
  const [controlsVisible, setControlsVisible] = useState(false);
  // When the side menu is open, the tap that dismisses it must NOT also seek a
  // lyric. The background's pointerdown runs before the synthesized click and
  // closes the menu, so by the time the lyric's click fires controlsVisible is
  // already false. Record that the gesture was a dismissal so click can bail.
  const menuWasOpenRef = useRef(false);
  // ── Landscape player geometry — every dynamic size lives here, in one place ──
  // Keep all related sizing together so a tweak to one dimension sits next to the
  // others it interacts with. No fixed breakpoints — everything scales off winW.
  //
  // Left rail: the control rail (nudge / pause / track) — width `railW`, must
  //   never cover the lyrics. Now-playing info lives only in the fixed top bar,
  //   so the rail is controls-only (no duplicated title/artwork).
  // Lyrics: when the menu is up they center in the space to the RIGHT of the rail
  //   (equal to true centering on wide/fullscreen windows, so that look is
  //   untouched). When the menu fades away the rail is gone, so they reclaim the
  //   FULL width, re-center, and grow a touch. All of it transitions with the
  //   0.35s menu fade.
  const railW = Math.min(270, Math.max(190, Math.round(winW * 0.26)));
  const menuOpen = isLandscape && controlsVisible;
  const lyricAreaW = menuOpen
    ? Math.min(760, Math.max(260, winW - railW - 48))
    : Math.min(820, winW - 48);
  const lyricAreaLeft = menuOpen
    ? Math.max(railW + 24, Math.round((winW - lyricAreaW) / 2))
    : Math.round((winW - lyricAreaW) / 2);
  // During the instrumental intro every line has the same dim opacity. As the
  // first lyric starts, the scroll hook blends in position-based emphasis;
  // mid-song matches and manual selections focus immediately.
  const firstLyricTime = Number.isFinite(lyrics[0]?.time) ? lyrics[0].time : null;
  const lyricFocusStrength = currentIndex < 0
    ? 0
    : firstLyricTime != null && currentIndex === 0
      ? Math.max(0, Math.min(1,
        (playbackTime - (firstLyricTime - FIRST_LYRIC_PRELIGHT_SECONDS))
          / FIRST_LYRIC_FADE_SECONDS))
      : 1;
  const layoutLyricFontScale = menuOpen
    ? 1.1 * Math.max(0.72, Math.min(1, lyricAreaW / 640))
    : 1.25; // menu away → a touch larger
  const lyricPanelWidth = isLandscape ? lyricAreaW : winW;
  // User font nudges still apply, but a narrow lyric panel gets a lower safe
  // ceiling. Keep a genuinely useful range on phone-sized windows, then let
  // wider lyric panels grow continuously up to a larger desktop maximum.
  const responsiveLyricFontScaleCap = Math.min(2,
    Math.max(1.6, 1.6 + (lyricPanelWidth - 320) / 500 * 0.4)
  );
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

  // ── Auth token ref — kept current for API Authorization headers ──
  const sessionTokenRef = useRef(null);

  // ── Payments: subscription tier + Apple IAP + Stripe — hooks/usePayments.js ──
  const {
    userTier, setUserTier,
    albumCount, setAlbumCount,
    upgradeWorking,
    iapPrice, premiumPlan, setPremiumPlan, iapWorking,
    syncAppleSubscription, upgradeWithApple, restoreApplePurchases, upgradeToStripe,
  } = usePayments({ sb, sessionTokenRef });

  // ── History ──
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // ── Vinyl auto mode (always on) ──
  const vinylMode = true;
  const autoAdvanceFiredRef = useRef(false);
  // Own the delayed flip/album-end card so a resync or track change can cancel
  // it. Untracked timeouts previously surfaced "Time to flip" in a later song.
  const sideEndTimerRef = useRef(null);

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
  const [recentPlayedIds, setRecentPlayedIds] = useState([]); // 2 most-recently-played collection ids, newest first
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
  const [showCast, setShowCast] = useState(false);
  const cast = useCast({ mode, song: detectedSong, lyrics, playbackTime, isPaused });
  const [kbToast, setKbToast] = useState(null);
  const kbToastTimerRef = useRef(null);
  const [shouldAdvanceTrack, setShouldAdvanceTrack] = useState(false);
  const [sideEndReason, setSideEndReason] = useState("failed"); // "failed" | "flip" | "album-end"
  const [sideEndNextDiscInfo, setSideEndNextDiscInfo] = useState(null); // {isNewDisc, nextDisc, nextSide}
  const [showSideEndPicker, setShowSideEndPicker] = useState(false); // "Or select another side" list on the side-end screen
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

  // ── User-contributed metadata (lyrics + side info) ──
  // sideDataMissing mirrors "no vinyl_sides AND no Discogs fallback" into
  // state so the idle screen can warn before sync (refs don't re-render).
  const [sideDataMissing, setSideDataMissing] = useState(false);
  const [showSideInfoSheet, setShowSideInfoSheet] = useState(false);
  const [showLyricsEditor, setShowLyricsEditor] = useState(false);
  const [userMetaSaving, setUserMetaSaving] = useState(false);
  const [userMetaError, setUserMetaError] = useState(null);

  // ── Unsynced-lyrics auto-scroll speed (multiplier on the base scroll rate) ──
  const [scrollSpeed, setScrollSpeed] = useState(() => {
    const v = parseFloat(localStorage.getItem("liri_scroll_speed"));
    return isNaN(v) ? 1.0 : Math.min(4, Math.max(0.25, v));
  });
  const scrollSpeedRef = useRef(scrollSpeed); // mirror for use inside the rAF loop

  // ── Lyric font size (shared by web + iOS, persisted on this device) ──
  const [lyricFontScale, setLyricFontScale] = useState(() => {
    const v = parseFloat(localStorage.getItem("liri_lyric_font_scale"));
    return isNaN(v) ? 1 : Math.min(2, Math.max(0.8, v));
  });
  const responsiveLyricFontScale = Math.min(lyricFontScale, responsiveLyricFontScaleCap);
  const effectiveLyricFontScale = responsiveLyricFontScale * layoutLyricFontScale;

  // ── Flip notifications ──
  const [flipSound, setFlipSound] = useState(() => localStorage.getItem("liri_flip_sound") !== "false");
  const [flipNotify, setFlipNotify] = useState(() => localStorage.getItem("liri_flip_notify") === "true");
  const [notifyDenied, setNotifyDenied] = useState(false);
  const [keepAwakeError, setKeepAwakeError] = useState(false);

  // ── Nudge expand ──
  const [nudgeMenu, setNudgeMenu] = useState(null); // null | "left" | "right"
  const nudgeMenuTimerRef = useRef(null);

  // ── Onboarding ──
  const [showOnboarding, setShowOnboarding] = useState(false); // shown after login/signup (see effect below)
  const [onboardingStep, setOnboardingStep] = useState(0);
  const ONBOARDING_STEPS = 6;
  const [coachStep, setCoachStep] = useState(0); // 0 none · 1 highlight Listen · 2 highlight Feed
  const dismissOnboarding = () => {
    localStorage.setItem("liri_onboarding_done", "true");
    setShowOnboarding(false);
  };
  // Show onboarding AFTER login/signup — once per device, the first time a
  // signed-in user lands without the done flag. Hidden again on sign-out.
  useEffect(() => {
    if (user && !localStorage.getItem("liri_onboarding_done")) {
      setCoachStep(0);
      setOnboardingStep(0);
      setShowOnboarding(true);
    } else if (!user) {
      setShowOnboarding(false);
    }
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
  // Song-ending clock, deliberately separate from lyric highlighting so
  // nudges and the visual lead cannot trigger track/side transitions. It uses
  // the same measured playback-rate correction as the record itself.
  const endClockPosRef = useRef(0);
  const endClockStartRef = useRef(null);
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
  const refollowTimerRef = useRef(null); // auto snap-back to the current line after the user stops scrolling
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

  // Keep scrollSpeedRef fresh for the rAF loop + persist across sessions
  useEffect(() => {
    scrollSpeedRef.current = scrollSpeed;
    try { localStorage.setItem("liri_scroll_speed", String(scrollSpeed)); } catch {}
  }, [scrollSpeed]);

  useEffect(() => {
    try { localStorage.setItem("liri_lyric_font_scale", String(lyricFontScale)); } catch {}
  }, [lyricFontScale]);

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
    // Native playback uses an iOS audio session and remains reliable when the
    // WKWebView WebAudio context is suspended or the hardware switch is muted.
    if (IS_IOS) {
      const nativeAudio = getNativeAudio();
      if (nativeAudio?.chime) {
        nativeAudio.chime().catch(() => {});
        return;
      }
    }
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
  // later. Delays are measured from song end. First fire also surfaces the
  // push notification.
  const scheduleFlipChimes = (song, discInfo) => {
    flipChimeTimersRef.current.forEach(clearTimeout);
    flipChimeTimersRef.current = [10000, 20000, 30000, 60000].map((delay, i) =>
      setTimeout(() => {
        playFlipChime();
        if (i === 0) showFlipPushNotification(song, discInfo);
      }, delay)
    );
  };
  const cancelFlipChimes = () => {
    flipChimeTimersRef.current.forEach(clearTimeout);
    flipChimeTimersRef.current = [];
  };

  // Mute toggle on the flip screen. Drives the same liri_flip_sound flag as the
  // Settings switch. Keep reminder timers alive when muted: playFlipChime
  // re-checks the flag, while the independent push notification still fires.
  const toggleFlipDings = () => {
    const v = !flipSound;
    setFlipSound(v);
    try { localStorage.setItem("liri_flip_sound", String(v)); } catch {}
  };

  // Notification helpers are imported from base/lib/notifications.js.
  const enableFlipNotify = async () => {
    if (IS_IOS) {
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
    }
  };

  // Keep the toggle honest if notification permission was revoked in iOS
  // Settings since the last launch.
  useEffect(() => {
    if (!IS_IOS || !flipNotify) return;
    getLocalNotif()?.checkPermissions?.().then(({ display }) => {
      if (display !== "granted") {
        setFlipNotify(false);
        localStorage.setItem("liri_flip_notify", "false");
        setNotifyDenied(display === "denied");
      }
    }).catch(() => {});
  }, []);

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

  // ── Analytics + social auto-post — extracted to base/lib/analytics.js ──
  // (pure functions; sb/sessionId/refs are passed in explicitly). Thin
  // wrappers below preserve the original call signatures used throughout
  // this component.
  const logListeningEvent = params => libLogListeningEvent(sb, sessionId, params);
  const maybeAutoPostPlay = params => libMaybeAutoPostPlay(sb, autoPostVisRef, autoPostedAlbumsRef, params);
  const logFlipEvent = params => libLogFlipEvent(sb, sessionId, params);

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
  // ── Apple IAP + Stripe upgrade — extracted to hooks/usePayments.js ──

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
              name: authName.trim(),
              // Acquisition source — surfaced in the admin dashboard.
              signup_platform: IS_IOS ? "ios" : "web"
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
    setSideDataMissing(false); // recomputed once this album's side data loads
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

        // Hot-swap fresher lyrics for the track currently on screen (if any).
        // Runs after the DB fetch and again after the lrclib gap-fill, so lyrics
        // submitted via the admin (or found online) show up on a simple page
        // refresh mid-listen — the sync clock is untouched and the highlight
        // recomputes from the running time on the next tick.
        const refreshCurrentLyrics = () => {
          const idx = turntableMatchedIdxRef.current;
          const track = turntableTracksRef.current[idx];
          if (idx < 0 || !track?.trackId) return;
          const entry = turntableLyricsCacheRef.current[String(track.trackId)];
          if (!entry) return;
          const fresh = entry.lrc_raw ? parseLRC(entry.lrc_raw) : plainToLines(entry.lyrics_plain);
          if (!fresh.length) return;
          const cur = lyricsRef.current || [];
          // Never downgrade a synced view to plain, and skip no-op swaps.
          if (cur.length > 0 && cur[0].time != null && fresh[0].time == null) return;
          const sig = a => a.length + "|" + (a[0]?.time ?? "n") + "|" + (a[0]?.text || "") + "|" + (a[a.length - 1]?.text || "");
          if (sig(fresh) === sig(cur)) return;
          setLyrics(fresh);
          lyricsRef.current = fresh;
        };
        refreshCurrentLyrics();

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
        // Surface the "no side info" warning on the idle screen (user can add
        // it manually). May flip back to false below if the background Discogs
        // auto-populate finds a pressing.
        setSideDataMissing(!vinylSidesRef.current.length && !(dbRelease?.vinyl_tracks?.length > 0));

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
                  // Persist the find to track_lyrics (fire-and-forget) so the DB
                  // catches up with what the app displays — otherwise the admin
                  // "Missing Lyrics" list shows tracks as missing forever even
                  // though every listen gap-fills them live from lrclib.
                  const apiBase = window.Capacitor ? "https://www.getliri.com" : "";
                  fetch(`${apiBase}/api/refresh-lyrics?action=track&id=${t.itunes_track_id}`, { method: "POST" }).catch(() => {});
                }
              } catch {}
            }));
            refreshCurrentLyrics();
          }
          // If we still have no side data, try the Discogs auto-populate (slow —
          // sequential Discogs calls). Backgrounded so it never blocks listening.
          if (!vinylDbReleaseRef.current?.vinyl_tracks?.length && !vinylSidesRef.current.length) {
            try {
              await autoPopulateVinylSides(collectionId, albumName, artistName);
              const retry = await fetchVinylRelease(collectionId);
              if (retry?.vinyl_tracks?.length > 0) { setVinylDbRelease(retry); vinylDbReleaseRef.current = retry; setSideDataMissing(false); }
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
      setSideDataMissing(false);
    }
  }, [turntableAlbum]);

  // ── User-contributed metadata: save handlers ──
  // The track currently on screen while syncing — used by the "Add lyrics"
  // flow on the no-lyrics playback screen. Only turntable (library) tracks
  // have an itunes_track_id to key track_lyrics on.
  const lyricsEditorTrack = currentTrackIndex >= 0 ? turntableTracksRef.current[currentTrackIndex] : null;

  const handleSaveUserLyrics = async text => {
    const track = currentTrackIndex >= 0 ? turntableTracksRef.current[currentTrackIndex] : null;
    if (!track?.trackId) return;
    setUserMetaSaving(true);
    setUserMetaError(null);
    try {
      const entry = await saveUserLyrics(sb, track.trackId, text);
      // Update the in-memory cache and swap the lyrics on screen immediately.
      turntableLyricsCacheRef.current[String(track.trackId)] = entry;
      const fresh = entry.lrc_raw ? parseLRC(entry.lrc_raw) : plainToLines(entry.lyrics_plain);
      if (fresh.length) {
        setLyrics(fresh);
        lyricsRef.current = fresh;
      }
      setShowLyricsEditor(false);
      logButtonEvent("user_lyrics_saved");
    } catch (err) {
      console.error("[usermeta] lyrics save failed:", err);
      setUserMetaError(err?.message || "Couldn't save — try again");
    }
    setUserMetaSaving(false);
  };

  const handleSaveUserSides = async letters => {
    const alb = turntableAlbumRef.current;
    const tracks = turntableTracksRef.current;
    if (!alb?.itunes_collection_id || !tracks.length) return;
    setUserMetaSaving(true);
    setUserMetaError(null);
    try {
      const rows = buildSideRows(alb.itunes_collection_id, tracks, letters);
      const sides = await saveUserSides(sb, rows);
      // Adopt immediately — flip detection and the track picker read this ref.
      vinylSidesRef.current = sides;
      setSideDataMissing(false);
      setShowSideInfoSheet(false);
      logButtonEvent("user_sides_saved");
    } catch (err) {
      console.error("[usermeta] sides save failed:", err);
      setUserMetaError(err?.message || "Couldn't save — try again");
    }
    setUserMetaSaving(false);
  };

  // ── User's personal vinyl library (for the album picker) ──
  const fetchUserLibrary = async (uid, autoSelect = false) => {
    setLibLoading(true);
    try {
      const {
        data
      } = await sb.from("user_library").select("*, catalogue(album_name, artist_name, artist_sort_name, artwork_url, itunes_collection_id)").eq("user_id", uid).order("added_at", {
        ascending: false
      });
      const library = (data || []).map(row => ({
        ...row,
        album_name: row.catalogue?.album_name || row.album_name || "",
        artist_name: row.catalogue?.artist_name || row.artist_name || "",
        artist_sort_name: row.catalogue?.artist_sort_name || null,
        artwork_url: row.catalogue?.artwork_url || row.artwork_url || null,
      }));
      setUserLibrary(library);

      // The 2 most-recently-played albums float to the top of the picker /
      // library; the rest sort alphabetically. Pull recent plays newest-first.
      try {
        const { data: recent } = await sb.from("listening_events")
          .select("itunes_collection_id")
          .eq("user_id", uid)
          .not("itunes_collection_id", "is", null)
          .order("listened_at", { ascending: false })
          .limit(60);
        const ids = [];
        for (const r of recent || []) {
          const id = String(r.itunes_collection_id);
          if (!ids.includes(id)) ids.push(id);
          if (ids.length >= 2) break;
        }
        setRecentPlayedIds(ids);
      } catch {}

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

      // Auto-select most-played album when no album is set (first load only).
      // "Most-played" = most album loads, not most songs — so ignore auto_advance
      // rows (the per-track continuations of a side; null source still counts).
      if (autoSelect && !localStorage.getItem("liri_turntable") && library.length > 0) {
        const {
          data: plays
        } = await sb.from("listening_events").select("itunes_collection_id,source").eq("user_id", uid).not("itunes_collection_id", "is", null);
        if (plays?.length > 0) {
          const counts = {};
          for (const row of plays) {
            if (row.source === "auto_advance") continue;
            counts[row.itunes_collection_id] = (counts[row.itunes_collection_id] || 0) + 1;
          }
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
        // Include the final album track too; advanceToNextTrack decides whether
        // this is a side flip or the album-end screen.
        if (tTracks.length > 0 && tIdx >= 0 && tIdx < tTracks.length) {
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

  // ── Lyric scroll behavior — hooks/useLyricScroll.js ──
  const { lyricsUnsynced, lyricsScrollRef, seekToLine, refollow, noteUserScroll } = useLyricScroll({
    mode,
    lyrics, lyricsRef,
    songDuration,
    isPaused,
    isLandscape, controlsVisible,
    focusStrength: lyricFocusStrength,
    currentIndex, setCurrentIndex,
    playbackTime, setPlaybackTime,
    setUserScrolling, userScrollingRef,
    refollowTimerRef,
    currentLineRef, creditsRef,
    scrollSpeedRef,
    initialPosRef, syncStartRef,
    onSeek: targetTime => {
      // Seeking to a lyric means the user is continuing this song. Undo any
      // end-of-side decision that was waiting through the brief handoff.
      clearTimeout(sideEndTimerRef.current);
      sideEndTimerRef.current = null;
      cancelFlipChimes();
      autoAdvanceFiredRef.current = false;
      setShouldAdvanceTrack(false);
      endClockPosRef.current = targetTime;
      endClockStartRef.current = Date.now();
    },
  });

  // ── Vinyl auto-advance: trigger when song nears its end ──
  useEffect(() => {
    if (mode !== "syncing") return;
    // A turntable album is selected but its track list is still loading (e.g.
    // right after a tab-nav restore re-mounts the page). Advancing now would
    // find an empty track list and fall through to the flip screen mid-side —
    // hold off until the tracks are in; this effect re-runs every clock tick.
    if (turntableAlbumRef.current && turntableTracksLoading && turntableTracksRef.current.length === 0) return;
    const lastLyricTime = lyrics.length > 0 ? lyrics[lyrics.length - 1].time : null;
    // Read duration from turntable track ref directly — more reliable than state
    // when songDuration hasn't updated yet for the new track.
    const tTracks = turntableTracksRef.current;
    // The cached index can lag after recognition, a header skip, or a restored
    // session. Resolve the duration from the song actually displayed so the
    // ending clock can never inherit a longer neighboring track's runtime.
    const displayedTitle = normText(detectedSong?.title);
    const displayedTrackIdx = displayedTitle
      ? tTracks.findIndex(t => normText(t.trackName || t.title) === displayedTitle)
      : -1;
    const tIdx = displayedTrackIdx >= 0
      ? displayedTrackIdx
      : turntableMatchedIdxRef.current;
    const trackDuration = tIdx >= 0 ? (tTracks[tIdx]?.trackTimeMillis ?? 0) / 1000 || null : null;

    // Ordinary song-to-song transitions must use the album duration (or native
    // silence detection). Applying the lyric-outro fallback to every track made
    // Liri enter the next song before the physical groove gap.
    const dbRelease = vinylDbReleaseRef.current;
    const sideEnds = tTracks.length > 0
      ? (getSideEndsFromSidesMap(tTracks, vinylSidesRef.current)
        ?? (dbRelease?.vinyl_tracks?.length > 0
          ? getDbSideEndIndices(tTracks, dbRelease.vinyl_tracks)
          : getSideEndIndices(tTracks, albumTpsRef.current > 0 ? albumTpsRef.current : 0)))
      : [];
    const isKnownSideEnd = tIdx >= 0 && sideEnds.includes(tIdx);
    let effectiveDuration = trackDuration ?? songDuration ?? null;

    if (isKnownSideEnd) {
      // At an actual side end, tolerate digital editions with extra tail
      // silence so a metadata mismatch cannot suppress the flip prompt.
      const durationCandidates = [trackDuration, songDuration].filter(d => Number.isFinite(d) && d > 0);
      effectiveDuration = durationCandidates.length ? Math.min(...durationCandidates) : null;
    }
    if (isKnownSideEnd && lastLyricTime != null) {
      // Never let this fallback fire before 85% of the known duration. That
      // preserves long instrumental outros and prevents another mid-song flip.
      const lyricOutroLimit = Math.max(lastLyricTime + 20, (effectiveDuration || 0) * 0.85);
      effectiveDuration = effectiveDuration == null
        ? lyricOutroLimit
        : Math.min(effectiveDuration, lyricOutroLimit);
    }
    if (!effectiveDuration) return;

    // Keep transitions isolated from lyric nudges/lead, but advance this clock
    // at the measured record rate. Leaving it at 1× made a five-minute song's
    // transition arrive roughly ten seconds after the record had already ended.
    const endClockElapsed = !isPaused && endClockStartRef.current != null
      ? (Date.now() - endClockStartRef.current) / 1000 * SYNC_PLAYBACK_RATE
      : 0;
    const endPlaybackTime = Math.max(0, endClockPosRef.current + endClockElapsed);
    if (endPlaybackTime >= effectiveDuration && !autoAdvanceFiredRef.current) {
      autoAdvanceFiredRef.current = true;
      setShouldAdvanceTrack(true);
    }
  }, [playbackTime, songDuration, lyrics, mode, isPaused, detectedSong?.title]);


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
      const discInfo = getNextDiscInfo();
      scheduleFlipChimes(detectedSong, discInfo);
      if (detectedSong) setLastSong(detectedSong);
      setMode("side-end");
    }
  }, [shouldAdvanceTrack]);

  // ── Cleanup on unmount ──
  useEffect(() => () => {
    clearInterval(syncIntervalRef.current);
    clearInterval(progressTimerRef.current);
    clearTimeout(refollowTimerRef.current);
    clearTimeout(sideEndTimerRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
  }, []);

  // ── Cancel flip chimes whenever we leave the side-end screen ──
  useEffect(() => {
    if (mode !== "side-end") cancelFlipChimes();
  }, [mode]);

  // ── Process a confirmed match — update all app state ──
  const handleMatch = async (data, isAutoAdvance) => {
    clearTimeout(sideEndTimerRef.current);
    sideEndTimerRef.current = null;
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
  // Extracted to base/lib/match.js (pure, no React) — see that file for the
  // full matching algorithm and its comments.

  // ── Analytics: log a button tap (resync / wrong_song) — base/lib/analytics.js ──
  const logButtonEvent = buttonName => libLogButtonEvent(
    sb,
    { sessionId, user, detectedSong, albumCollectionIdRef, lastRawMatchRef },
    buttonName
  );

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
      return plainToLines(entry.lyrics_plain);
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
          const parsed = plainToLines(data.lyrics_plain);
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
    // Formula: initialPos = startPos - phraseOffset + elapsed × sync playback rate
    //   startPos      — position in the track (seconds) where the matched phrase lives
    //   phraseOffset  — estimate of how far into the recording window the phrase started
    //                   (so we subtract it to roll back to the beginning of the window)
    //   elapsed       — total wall time since the mic opened, measured right now
    //
    // Net result: we land at the position in the track that corresponds to "right now",
    // not "when the match callback ran".
    if (syncCalcRef.current) {
      // New detection data — compute exact position from the deferred timing budget.
      const {
        startPos,
        phraseOffset,
        recStart
      } = syncCalcRef.current;
      syncCalcRef.current = null;
      const elapsed = (Date.now() - recStart) / 1000;
      initialPosRef.current = Math.max(0, startPos - phraseOffset + elapsed * SYNC_PLAYBACK_RATE);
      endClockPosRef.current = Math.max(0, startPos - phraseOffset + elapsed * SYNC_PLAYBACK_RATE);
    } else if (syncStartRef.current !== null) {
      // Sync is already running and no new timing data is available.
      // This happens when detectedSong is updated for a non-song reason (e.g. artwork
      // loading from iTunes a few seconds after detection), which re-triggers this
      // useEffect. Carry the current running position forward so we don't silently
      // reset the anchor back to the original startPos and cause the lyrics to lag.
      // NO Math.max(0) here: a negative position is the flip/track-gap park still
      // counting down. Clamping it to 0 was silently cancelling the needle-drop
      // window whenever detectedSong updated (e.g. artwork arriving) mid-park.
      initialPosRef.current = initialPosRef.current + (Date.now() - syncStartRef.current) / 1000 * SYNC_PLAYBACK_RATE;
      if (endClockStartRef.current != null) {
        endClockPosRef.current += (Date.now() - endClockStartRef.current) / 1000 * SYNC_PLAYBACK_RATE;
      }
    } else {
      endClockPosRef.current = initialPosRef.current;
    }
    // Manual flip: park playbackTime at 0 while the user drops the needle.
    // We start the clock in the "past" so (Date.now() - syncStart)/1000 is
    // negative for the delay window; the interval below clamps display to 0.
    if (flipStartDelayMsRef.current > 0) {
      initialPosRef.current = -flipStartDelayMsRef.current / 1000;
      endClockPosRef.current = initialPosRef.current;
      flipStartDelayMsRef.current = 0;
    }
    syncStartRef.current = Date.now();
    endClockStartRef.current = syncStartRef.current;
    // Jump to correct starting index immediately so the scroll effect lands on the right
    // line without smooth-scrolling from 0 (which caused a ~3s visual lag on load).
    // Use -1 as sentinel when we're still in the intro (before the first lyric timestamp).
    const lrc0 = lyricsRef.current;
    const t0 = initialPosRef.current;
    let initIdx = -1;
    const t0Lead = t0 + LYRIC_LEAD_SECONDS;
    if (lrc0.length > 0 && lrc0[0].time != null
      && t0 >= lrc0[0].time - FIRST_LYRIC_PRELIGHT_SECONDS) {
      initIdx = 0;
      for (let i = 0; i < lrc0.length; i++) {
        if (lrc0[i].time <= t0Lead) initIdx = i;else break;
      }
    }
    setMode("syncing");
    setCurrentIndex(initIdx);
    // A new sync is always live playback — clear any stale pause state so the
    // pause toggle stays consistent after skipping a track while paused.
    setIsPaused(false);
    clearInterval(syncIntervalRef.current);
    syncIntervalRef.current = setInterval(() => {
      const t = initialPosRef.current + (Date.now() - syncStartRef.current) / 1000 * SYNC_PLAYBACK_RATE;
      // Clamp displayed time to 0 during the manual-flip pause window.
      setPlaybackTime(t < 0 ? 0 : t);
      const lrc = lyricsRef.current;
      // Unsynced (plain-text) lyrics have time:null — no line highlighting;
      // the flat auto-scroll view handles motion instead.
      if (!lrc.length || lrc[0].time == null) return;
      // Stay neutral until the two-second first-line cue begins. Later lines
      // continue to use the normal lyric lead above.
      const tLead = t + LYRIC_LEAD_SECONDS;
      if (t < lrc[0].time - FIRST_LYRIC_PRELIGHT_SECONDS) {
        setCurrentIndex(-1);
        return;
      }
      let idx = 0;
      for (let i = 0; i < lrc.length; i++) {
        if (lrc[i].time <= tLead) idx = i;else break;
      }
      setCurrentIndex(idx);
    }, 80);
  }, []);

  // ── Now-playing: cross-tab persistence + heartbeat — hooks/useNowPlaying.js ──
  useNowPlaying({
    sessionTabId,
    mode, setMode,
    detectedSong, setDetectedSong,
    identifiedBy, setIdentifiedBy,
    songDuration, setSongDuration,
    lyrics, setLyrics, lyricsRef,
    currentTrackIndex, setCurrentTrackIndex,
    albumCollectionId, setAlbumCollectionId, albumCollectionIdRef,
    turntableMatchedIdxRef,
    syncStartRef, initialPosRef, syncCalcRef,
  });

  const togglePause = () => {
    if (isPaused) {
      // Resume: restart the clock from the paused anchor. initialPosRef was
      // captured at pause time and nudges made while paused shifted it, so it
      // (NOT playbackTime, which may lag a keyboard nudge) is authoritative.
      syncStartRef.current = Date.now();
      endClockStartRef.current = syncStartRef.current;
      clearInterval(syncIntervalRef.current); // never leak a second interval
      syncIntervalRef.current = setInterval(() => {
        const t = initialPosRef.current + (Date.now() - syncStartRef.current) / 1000 * SYNC_PLAYBACK_RATE;
        setPlaybackTime(t);
        const lrc = lyricsRef.current;
        if (!lrc.length || lrc[0].time == null) return;
        const tLead = t + LYRIC_LEAD_SECONDS;
        if (t < lrc[0].time - FIRST_LYRIC_PRELIGHT_SECONDS) {
          setCurrentIndex(-1);
          return;
        }
        let idx = 0;
        for (let i = 0; i < lrc.length; i++) {
          if (lrc[i].time <= tLead) idx = i;else break;
        }
        setCurrentIndex(idx);
      }, 80);
      setIsPaused(false);
    } else {
      // Pause: freeze lyrics at the current position. Capture it into
      // initialPosRef so it becomes the single source of truth while paused —
      // nudges shift it, and resume restarts the clock from it.
      initialPosRef.current = Math.max(0, playbackTime);
      if (endClockStartRef.current != null) {
        endClockPosRef.current += (Date.now() - endClockStartRef.current) / 1000 * SYNC_PLAYBACK_RATE;
      }
      clearInterval(syncIntervalRef.current);
      setIsPaused(true);
    }
  };
  const nudge = s => {
    userNudgeRef.current += s;
    // Apply the nudge to the playback POSITION, not the raw anchor. The anchor
    // (initialPosRef) is ~0 at the start of auto-advanced tracks, so clamping
    // Math.max(0, anchor + s) silently ate backward nudges until enough clock
    // time had been folded into the anchor. Clamp the resulting position
    // instead: it can't go below 0 — except while parked (negative position =
    // needle-drop countdown), where a nudge shifts the countdown itself.
    const running = !isPaused && syncStartRef.current != null;
    const elapsedScaled = running ? (Date.now() - syncStartRef.current) / 1000 * SYNC_PLAYBACK_RATE : 0;
    const curPos = initialPosRef.current + elapsedScaled;
    const newPos = curPos < 0 ? curPos + s : Math.max(0, curPos + s);
    initialPosRef.current = newPos - elapsedScaled;
    // Shift the displayed time immediately (the 80ms tick would also do this
    // while playing, but the interval is stopped while paused).
    setPlaybackTime(Math.max(0, newPos));
    const base = newPos;
    // Re-pick the highlighted line right away — playing OR paused — so the
    // nudge visibly jumps to a new line instead of looking like "nothing moved."
    const lrc = lyricsRef.current;
    if (lrc.length > 0 && lrc[0].time != null) {
      const playbackPosition = Math.max(0, base);
      const t = playbackPosition + LYRIC_LEAD_SECONDS;
      let idx = -1;
      if (playbackPosition >= lrc[0].time - FIRST_LYRIC_PRELIGHT_SECONDS) {
        idx = 0;
        for (let i = 0; i < lrc.length; i++) {
          if (lrc[i].time <= t) idx = i;else break;
        }
      }
      setCurrentIndex(idx);
    }
  };

  // ── Unsynced auto-scroll speed control (replaces the old sync-rate setting) ──
  const adjustScrollSpeed = delta => {
    setScrollSpeed(s => Math.round(Math.min(4, Math.max(0.25, s + delta)) * 100) / 100);
  };
  const adjustLyricFontSize = delta => {
    setLyricFontScale(s => {
      const visibleScale = Math.min(s, responsiveLyricFontScaleCap);
      return Math.round(Math.min(responsiveLyricFontScaleCap, Math.max(0.8, visibleScale + delta)) * 10) / 10;
    });
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
      const unsyncedNow = lyricsRef.current.length > 0 && lyricsRef.current[0].time == null;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (unsyncedNow) { adjustScrollSpeed(-0.25); showKbToast("← slower"); }
        else { nudge(-NUDGE_STEP_SECS); showKbToast("← −" + NUDGE_STEP_SECS + "s"); }
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (unsyncedNow) { adjustScrollSpeed(0.25); showKbToast("→ faster"); }
        else { nudge(NUDGE_STEP_SECS); showKbToast("→ +" + NUDGE_STEP_SECS + "s"); }
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
      if (ends[ends.length - 1] !== tracks.length - 1) ends.push(tracks.length - 1);
      return ends;
    }
    // Short releases (singles, EPs ≤4 tracks) are single-sided — just mark album-end
    if (tracks.length <= 4) return [tracks.length - 1];

    const SIDE_MS = 20 * 60 * 1000;

    // ── Use iTunes discNumber to locate LP-to-LP boundaries first ──
    // Each disc change = a physical record swap (not just a flip). Within each disc
    // we then apply the 20-min heuristic to find the A/B midpoint.
    const discNumbers = tracks.map(t => t.discNumber || 1);
    const hasMultipleDiscs = new Set(discNumbers).size > 1;

    if (hasMultipleDiscs) {
      const ends = [];
      // Walk tracks; whenever disc changes, the previous track ends a side
      for (let i = 0; i < tracks.length - 1; i++) {
        if (discNumbers[i] !== discNumbers[i + 1]) {
          ends.push(i); // LP boundary
        } else {
          // Within the same disc, check for a side A/B flip at ~20 min
          // Find the range of tracks on this disc
          const discStart = ends.length > 0 ? ends[ends.length - 1] + 1 : 0;
          const discEnd = (() => { for (let j = i + 1; j < tracks.length; j++) { if (discNumbers[j] !== discNumbers[i]) return j - 1; } return tracks.length - 1; })();
          const discMs = tracks.slice(discStart, discEnd + 1).reduce((s, t) => s + (t.trackTimeMillis || 0), 0);
          // Only add an intra-disc flip if the disc is long enough to have two sides
          if (discMs > SIDE_MS * 1.1) {
            let cumDisc = 0;
            for (let j = discStart; j < discEnd; j++) {
              cumDisc += tracks[j].trackTimeMillis || 0;
              if (cumDisc >= discMs / 2 && !ends.includes(j)) {
                ends.push(j);
                break;
              }
            }
          }
        }
      }
      ends.push(tracks.length - 1);
      return [...new Set(ends)].sort((a, b) => a - b);
    }

    // ── Single-disc album: estimate sides from total runtime ──
    const totalMs = tracks.reduce((s, t) => s + (t.trackTimeMillis || 0), 0);
    const numSides = totalMs > 0 ? Math.max(2, Math.round(totalMs / SIDE_MS)) : 2;
    if (!totalMs) {
      const perSide = Math.ceil(tracks.length / numSides);
      const ends = [];
      for (let i = perSide - 1; i < tracks.length - 1; i += perSide) ends.push(i);
      ends.push(tracks.length - 1);
      return ends;
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

  // ── Advance to the next track using the known tracklist (no re-listening) ──
  const advanceToNextTrack = async (tracks, idx) => {
    clearTimeout(sideEndTimerRef.current);
    sideEndTimerRef.current = null;

    // The cached turntable index can lag behind recognition/resync. Reconcile
    // it with the song actually on screen before deciding this is a side end.
    const displayedTitle = normText(detectedSong?.title);
    const displayedIdx = displayedTitle
      ? tracks.findIndex(t => normText(t.trackName || t.title) === displayedTitle)
      : -1;
    const resolvedIdx = displayedIdx >= 0 ? displayedIdx : idx;
    if (resolvedIdx !== idx && tracks === turntableTracksRef.current) {
      turntableMatchedIdxRef.current = resolvedIdx;
      setCurrentTrackIndex(resolvedIdx);
    }
    const nextIdx = resolvedIdx + 1;

    // Priority: vinyl_sides (same source as library.html) → vinyl_tracks (Discogs title match) → heuristic
    const dbRelease = vinylDbReleaseRef.current;
    const effectiveTps = albumTpsRef.current > 0 ? albumTpsRef.current : 0;
    const sideEnds = getSideEndsFromSidesMap(tracks, vinylSidesRef.current)
      ?? (dbRelease?.vinyl_tracks?.length > 0 ? getDbSideEndIndices(tracks, dbRelease.vinyl_tracks) : getSideEndIndices(tracks, effectiveTps));
    const isLastTrack = resolvedIdx === tracks.length - 1;
    const isSideEnd = sideEnds.includes(resolvedIdx);
    const showSideEndIfStillCurrent = () => {
      const scheduledIdx = resolvedIdx;
      sideEndTimerRef.current = setTimeout(() => {
        sideEndTimerRef.current = null;
        // A track pick/resync may have happened during the brief handoff.
        if (turntableTracksRef.current.length > 0
            && turntableMatchedIdxRef.current !== scheduledIdx) return;
        clearInterval(syncIntervalRef.current);
        setMode("side-end");
      }, SIDE_END_HANDOFF_MS);
    };
    if (isLastTrack) {
      showAlbumEndPushNotification(detectedSong);
      setSideEndReason("album-end");
      if (detectedSong) setLastSong(detectedSong);
      // Give the final lyric only a brief visual handoff before the end card.
      showSideEndIfStillCurrent();
      return;
    }
    if (isSideEnd) {
      const discInfo = getNextDiscInfo();
      setSideEndNextDiscInfo(discInfo);
      setSideEndReason("flip");
      // The first reminder chime fires 10s after the song ends.
      scheduleFlipChimes(detectedSong, discInfo);

      // ── Log the flip event to analytics ──
      const sideIdx = sideEnds.indexOf(resolvedIdx); // 0 = first flip (A→B), 1 = B→C, etc.
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
      // Give the final lyric only a brief visual handoff before the flip card.
      showSideEndIfStillCurrent();
      return;
    }
    // This is a real same-side track advance. Stop the outgoing clock only now,
    // after giving side-ending songs a cancellable seek-back window.
    clearInterval(syncIntervalRef.current);
    setPlaybackTime(0);
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
    // Load lyrics — prefer turntableLyricsCacheRef (always populated at album
    // select) over wordsDataRef (only populated during a Shazam listen session,
    // so empty on web and on any track that wasn't seen by startListeningSpeech).
    const nextTrackData = turntableLyricsCacheRef.current?.[String(next.trackId)]
      || wordsDataRef.current?.[next.trackId];
    if (nextTrackData?.lrc_raw) {
      const parsed = parseLRC(nextTrackData.lrc_raw);
      setLyrics(parsed);
      lyricsRef.current = parsed;
    } else if (nextTrackData?.lyrics_plain) {
      const parsed = plainToLines(nextTrackData.lyrics_plain);
      setLyrics(parsed);
      lyricsRef.current = parsed;
    } else {
      setLyrics([]);
      lyricsRef.current = [];
    }

    // Auto-advance always starts the new track from second 0 — we know exactly
    // where the needle is. Reset nudge so stale adjustments from the previous
    // track don't bleed into the new one.
    userNudgeRef.current = 0;
    initialPosRef.current = 0;
    syncCalcRef.current = { startPos: 0, phraseOffset: 0, recStart: Date.now() };
    // Park briefly at 0: the vinyl groove gap between tracks isn't part of the
    // digital duration, so without this the next lyrics start ahead of the needle.
    flipStartDelayMsRef.current = TRACK_GAP_MS;
    saveToHistory(user, nextSong);
    fetchHistory(user);

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
  const jumpToTrackIdx = (idx, startPos = 0) => {
    clearTimeout(sideEndTimerRef.current);
    sideEndTimerRef.current = null;
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
      const parsed = plainToLines(lrcEntry.lyrics_plain);
      setLyrics(parsed); lyricsRef.current = parsed;
    } else {
      setLyrics([]); lyricsRef.current = [];
    }
    userNudgeRef.current = 0;
    initialPosRef.current = startPos;
    syncCalcRef.current = { startPos, phraseOffset: 0, recStart: Date.now() };
    autoAdvanceFiredRef.current = false;
    autoRetryCountRef.current = 0;
    setShowSideEndPicker(false);
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
        // Hop straight into the lyrics page; song progression is parked while
        // the user actually drops the needle on the new side.
        cancelFlipChimes();
        flipStartDelayMsRef.current = FLIP_NEEDLE_DROP_MS;
        jumpToTrackIdx(nextFirst);
        return;
      }
    }
    // Past all known side ends
    setSideEndReason("album-end");
    setMode("side-end");
  };

  // ── Manual side pick: start any side from the side-end screen ──
  // Same contract as manualFlipToNextSide: the user is physically moving the
  // needle, so hold playback at 0 while they drop it on the new side.
  const startSideAtIdx = (idx) => {
    try {
      if (!chimeCtxRef.current) {
        chimeCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      } else if (chimeCtxRef.current.state === "suspended") {
        chimeCtxRef.current.resume();
      }
    } catch {}
    cancelFlipChimes();
    flipStartDelayMsRef.current = FLIP_NEEDLE_DROP_MS;
    jumpToTrackIdx(idx);
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
        const nextSideIndex = s + 1;
        const nextSide = "ABCDEFGH"[nextSideIndex] || null;
        // Vinyl side letters are authoritative for physical-disc boundaries:
        // A/B = LP 1, C/D = LP 2, E/F = LP 3. Digital releases commonly mark
        // every track discNumber=1, which incorrectly labelled B→C as a flip.
        const currentDisc = Math.floor(s / 2) + 1;
        const nextDisc = Math.floor(nextSideIndex / 2) + 1;
        return {
          isNewDisc: nextDisc !== currentDisc,
          nextDisc,
          nextSide,
        };
      }
    }
    return null;
  };

  // ── Resync: use Shazam to snap back to the actual record (iOS only) ──
  // Matches against the WHOLE album, not just the track we think is playing —
  // so if the needle is actually on a different song, resync jumps to that song
  // (and its lyrics) at the detected position instead of giving up.
  const resync = async () => {
    if (isResyncing || !IS_IOS) return;
    setIsResyncing(true);
    try {
      const result = await Shazam.findMatch({ timeout: 10000 });
      if (!result.matched) { setIsResyncing(false); return; }
      const { title, offset, matchTime } = result;
      const elapsed = (Date.now() - matchTime) / 1000;
      const adjustedOffset = Math.max(0, offset + elapsed);
      const norm = normText;
      const tracks = turntableTracksRef.current;
      // Find which album track the match belongs to.
      let matchedIdx = -1;
      for (let i = 0; i < tracks.length; i++) {
        const tn = tracks[i].trackName || "";
        if (tn && (norm(title).includes(norm(tn)) || norm(tn).includes(norm(title)))) { matchedIdx = i; break; }
      }
      if (matchedIdx === -1) { setIsResyncing(false); return; } // match isn't on this album — leave as-is
      const curIdx = turntableMatchedIdxRef.current >= 0 ? turntableMatchedIdxRef.current : currentTrackIndexRef.current;
      if (matchedIdx === curIdx) {
        // Same song — just snap the position.
        initialPosRef.current = adjustedOffset;
        syncStartRef.current = Date.now();
        endClockPosRef.current = adjustedOffset;
        endClockStartRef.current = syncStartRef.current;
        syncCalcRef.current = null;
      } else {
        // Different song — switch to it at the detected position.
        jumpToTrackIdx(matchedIdx, adjustedOffset);
      }
    } catch (err) {
      console.error("[resync] error:", err);
    }
    setIsResyncing(false);
  };

    const reset = () => {
    cancelFlipChimes();
    clearTimeout(sideEndTimerRef.current);
    sideEndTimerRef.current = null;
    setShowSideEndPicker(false);
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
    endClockPosRef.current = 0;
    endClockStartRef.current = null;
    setAlbumTracks([]);
    setCurrentTrackIndex(-1);
    setShouldAdvanceTrack(false);
    setIsResyncing(false);
    setIsPaused(false);
    setSideEndReason("failed");
    setAlbumCollectionId(null);
    // Keep vinylDbRelease + vinylSidesRef + albumTpsRef intact — they describe
    // the currently-selected album (turntableAlbum), not the sync session.
    // Wiping them here made the post-album-end track picker fall back to the
    // A/B midpoint split for 2×LP albums (Reputation → sides C/D disappeared).
    // They're re-populated correctly when turntableAlbum actually changes.
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
      // Prefer turntableLyricsCacheRef (populated at album select) over
      // wordsDataRef (only populated during a Shazam session, empty on web).
      const trackData = turntableLyricsCacheRef.current?.[String(track.trackId)]
        || wordsDataRef.current?.[track.trackId];
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

  // Track controls shared by the compact listening headers. Keep these wired
  // to the same jump/advance paths as the expanded sync controls so side-end
  // handling, cached lyrics, history, and playback reset all stay consistent.
  const getListeningHeaderNav = () => {
    const hasTurntableTracks = !!turntableAlbum
      && turntableTracksRef.current.length > 0
      && turntableMatchedIdxRef.current >= 0;
    const tracks = hasTurntableTracks ? turntableTracksRef.current : albumTracks;
    const index = hasTurntableTracks
      ? turntableMatchedIdxRef.current
      : currentTrackIndexRef.current;
    return {
      hasTurntableTracks,
      tracks,
      index,
      canPrevious: index > 0,
      canNext: index >= 0 && index < tracks.length - 1,
    };
  };

  const skipListeningHeaderTrack = direction => {
    const nav = getListeningHeaderNav();
    if (direction < 0 && nav.canPrevious) {
      if (nav.hasTurntableTracks) jumpToTrackIdx(nav.index - 1);
      else jumpToTrack(nav.index - 1);
    } else if (direction > 0 && nav.canNext) {
      advanceToNextTrack(nav.tracks, nav.index);
    }
  };

  const renderListeningTitleNav = ({ fontSize, artistFontSize, wrapTitle = false }) => {
    const nav = getListeningHeaderNav();
    const arrow = (direction, enabled, label) => /*#__PURE__*/React.createElement("button", {
      onClick: e => { e.stopPropagation(); skipListeningHeaderTrack(direction); },
      onPointerDown: e => e.stopPropagation(),
      disabled: !enabled || isResyncing,
      title: label,
      "aria-label": label,
      style: {
        width: "20px",
        height: "34px",
        padding: 0,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "none",
        border: "none",
        color: enabled && !isResyncing ? "rgba(240,230,211,0.68)" : "rgba(255,255,255,0.12)",
        lineHeight: 1,
        cursor: enabled && !isResyncing ? "pointer" : "default",
      }
    }, /*#__PURE__*/React.createElement("svg", {
      width: "10",
      height: "14",
      viewBox: "0 0 10 14",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "1.7",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true"
    }, /*#__PURE__*/React.createElement("path", {
      d: direction < 0 ? "M7 2.5 2.5 7 7 11.5" : "M3 2.5 7.5 7 3 11.5"
    })));
    return /*#__PURE__*/React.createElement("div", {
      style: { display: "inline-flex", alignItems: "center", gap: "5px", maxWidth: "100%", minWidth: 0 }
    }, arrow(-1, nav.canPrevious, "Previous song"), /*#__PURE__*/React.createElement("div", {
      style: {
        minWidth: 0,
        maxWidth: "100%",
        overflow: "hidden"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize,
        fontWeight: "600",
        color: "#f0e6d3",
        overflow: "hidden",
        ...(wrapTitle
          ? { display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2, lineHeight: 1.2 }
          : { textOverflow: "ellipsis", whiteSpace: "nowrap" })
      }
    }, detectedSong?.title), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: artistFontSize,
        color: "rgba(255,255,255,0.38)",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap"
      }
    }, detectedSong?.artist)), arrow(1, nav.canNext, "Next song"));
  };

  // ── Screen wake lock ──
  useEffect(() => {
    const acquire = async () => {
      if (!keepScreenAwake) return;
      setKeepAwakeError(false);
      try {
        if (IS_IOS) {
          const plugin = getKeepAwake();
          if (!plugin?.setEnabled) throw new Error("Native keep-awake unavailable");
          await plugin.setEnabled({ enabled: true });
        } else {
          if (!("wakeLock" in navigator)) throw new Error("Wake Lock unavailable");
          wakeLockRef.current = await navigator.wakeLock.request("screen");
        }
      } catch {
        setKeepAwakeError(true);
      }
    };
    const release = () => {
      wakeLockRef.current?.release?.();
      wakeLockRef.current = null;
      if (IS_IOS) getKeepAwake()?.setEnabled?.({ enabled: false }).catch(() => {});
    };
    const onVisibility = () => { if (document.visibilityState === "visible" && keepScreenAwake) acquire(); };
    if (keepScreenAwake) { acquire(); document.addEventListener("visibilitychange", onVisibility); }
    else release();
    return () => { release(); document.removeEventListener("visibilitychange", onVisibility); };
  }, [keepScreenAwake]);

  // ── Controls start closed each listening session ──
  // The vinyl button is the only way to open them; reset here so a menu left open
  // last session doesn't greet the next one.
  // Must live here — BEFORE any conditional early returns — to satisfy React hooks rules.
  useEffect(() => {
    if (mode === "syncing") setControlsVisible(false);
  }, [mode]);

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
        // Center the whole landing vertically so it doesn't cram against the top
        // (vinyl clipped by the notch) with a huge empty gap below. The padding
        // floors keep it clear of the notch / home indicator even when centered.
        justifyContent: "center",
        minHeight: "100vh",
        padding: IS_IOS
          ? "max(28px,env(safe-area-inset-top)) 32px max(28px,env(safe-area-inset-bottom))"
          : "max(40px,calc(env(safe-area-inset-top)+28px)) 32px max(40px,calc(env(safe-area-inset-bottom)+28px))",
        textAlign: "center",
        gap: IS_IOS ? "0px" : "14px"
      }
    }, /*#__PURE__*/React.createElement(Vinyl, {
      size: IS_IOS ? 92 : 104,
      spinning: false
    }), /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: IS_IOS ? "18px" : "20px",
        fontSize: "11px",
        letterSpacing: "5px",
        color: "rgba(212,168,70,0.6)",
        textTransform: "uppercase",
        marginBottom: "10px"
      }
    }, "Welcome to"), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: IS_IOS ? "42px" : "46px",
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
        marginBottom: IS_IOS ? "24px" : "28px"
      }
    }, "Lyrics for Vinyl"), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: "12px",
        marginBottom: IS_IOS ? "24px" : "30px",
        flexWrap: "wrap",
        justifyContent: "center"
      }
    }, features.map(f => /*#__PURE__*/React.createElement("div", {
      key: f.label,
      style: {
        background: "rgba(255,255,255,0.03)",
        border: "1px solid rgba(255,255,255,0.07)",
        borderRadius: "16px",
        padding: IS_IOS ? "12px 14px" : "16px 18px",
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
    }, "Sign in to continue syncing"), /*#__PURE__*/React.createElement("div", {
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
  }), showCast && /*#__PURE__*/React.createElement("div", {
    onClick: () => setShowCast(false),
    style: { position: "fixed", inset: 0, zIndex: 450, display: "flex", alignItems: "center", justifyContent: "center", padding: "24px", background: "rgba(0,0,0,0.68)", backdropFilter: "blur(10px)" }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: e => e.stopPropagation(),
    style: { width: "100%", maxWidth: "420px", padding: "30px", borderRadius: "24px", background: "#0f0f1c", border: "1px solid rgba(255,255,255,0.08)", boxShadow: "0 24px 80px rgba(0,0,0,0.65)", textAlign: "center" }
  }, /*#__PURE__*/React.createElement("div", {
    style: { display: "flex", justifyContent: "center", marginBottom: "18px", color: cast.connected ? "#d4a846" : "rgba(240,230,211,0.55)" }
  }, /*#__PURE__*/React.createElement(CastGlyph, { connected: cast.connected })), /*#__PURE__*/React.createElement("div", {
    style: { fontSize: "11px", letterSpacing: "3px", textTransform: "uppercase", color: "#d4a846", marginBottom: "8px" }
  }, "Cast lyrics"), /*#__PURE__*/React.createElement("div", {
    style: { fontSize: "22px", fontWeight: "700", color: "#f0e6d3", marginBottom: "10px" }
  }, cast.connected ? `Playing on ${cast.deviceName || "your TV"}` : "Put Liri on the big screen"), /*#__PURE__*/React.createElement("div", {
    style: { fontSize: "14px", lineHeight: "1.65", color: "rgba(255,255,255,0.38)", marginBottom: "24px" }
  }, cast.connected ? "The TV follows the same lyric clock. Pauses, nudges, and track changes update automatically." : "Choose a Chromecast or Google TV on this Wi-Fi network. Your record keeps playing normally; only the lyric experience goes to the TV."), cast.error && /*#__PURE__*/React.createElement("div", {
    style: { padding: "10px 12px", marginBottom: "16px", borderRadius: "10px", background: "rgba(201,128,122,0.1)", color: "#c9807a", fontSize: "12px" }
  }, cast.error), cast.connected ? /*#__PURE__*/React.createElement("button", {
    onClick: cast.stopSession,
    style: { width: "100%", border: "1px solid rgba(201,128,122,0.3)", borderRadius: "14px", padding: "14px", background: "rgba(201,128,122,0.08)", color: "#c9807a", fontSize: "14px", fontWeight: "700", fontFamily: "inherit" }
  }, "Stop casting") : /*#__PURE__*/React.createElement("button", {
    onClick: cast.requestSession,
    disabled: !cast.ready,
    style: { width: "100%", border: "none", borderRadius: "14px", padding: "15px", background: cast.ready ? "linear-gradient(135deg,#d4a846,#c9807a)" : "rgba(255,255,255,0.07)", color: cast.ready ? "#080810" : "rgba(255,255,255,0.25)", fontSize: "14px", fontWeight: "800", fontFamily: "inherit", cursor: cast.ready ? "pointer" : "default" }
  }, cast.ready ? "Choose a TV" : "Looking for Cast devices…"), /*#__PURE__*/React.createElement("button", {
    onClick: () => setShowCast(false),
    style: { marginTop: "12px", border: "none", background: "none", color: "rgba(255,255,255,0.3)", padding: "8px 16px", fontSize: "13px", fontFamily: "inherit" }
  }, "Close"))), showOnboarding && /*#__PURE__*/React.createElement("div", {
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
  }, IS_IOS ? /*#__PURE__*/React.createElement(React.Fragment, null, "When your record is playing, tap ", /*#__PURE__*/React.createElement("strong", { style: { color: "#d4a846" } }, "Sync Lyrics"), ". Liri uses Shazam to find your place in the song and syncs the lyrics in real time.") : "Add your albums to your library, then tap any track to start. Liri syncs the lyrics in real time — line by line."), /*#__PURE__*/React.createElement("div", {
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
  }, "Your sync history"), /*#__PURE__*/React.createElement("p", {
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
  }, "Liri automatically detects the next song as each track ends. No tapping, no fiddling \u2014 just the music."), /*#__PURE__*/React.createElement("div", {
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
  }, "\u2726 Detects the next song — flip the record when you're ready"), /*#__PURE__*/React.createElement("div", {
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
    // The tab bar rewrites hrefs to drop /app on iOS (pageHref), so match the
    // platform-correct path or the Feed-tab spotlight won't find its target.
    const feedSel = window.Capacitor ? 'a[href="/feed.html"]' : 'a[href="/app/feed.html"]';
    const sel = coachStep === 1 ? "#liri-listen-cta" : feedSel;
    const el = typeof document !== "undefined" ? document.querySelector(sel) : null;
    const r = el ? el.getBoundingClientRect() : null;
    const isLast = coachStep === 2;
    const advance = () => { if (isLast) { setCoachStep(0); window.location.href = window.Capacitor ? "/library.html" : "/library"; } else { setCoachStep(2); } };
    const copy = coachStep === 1
      ? { title: "Tap Sync Lyrics", body: "Put a record on, then hit Sync Lyrics — Liri finds your place and scrolls the lyrics in time.", cta: "Next →" }
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
      cursor: "pointer",
      // Flex column pinning the sheet to the bottom. This (not an absolutely
      // positioned panel) is what gives the flex:1 scroll child a real bounded
      // height on iOS — otherwise the album list won't scroll.
      display: "flex",
      flexDirection: "column",
      justifyContent: "flex-end"
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: e => e.stopPropagation(),
    style: {
      width: "100%",
      background: "#0f0f1c",
      borderRadius: "24px 24px 0 0",
      maxHeight: "80vh",
      overflow: "hidden",
      display: "flex",
      flexDirection: "column",
      minHeight: 0,
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
      // Active lyrics use a composited scale for flicker-free emphasis. Clip
      // its harmless horizontal overhang so WebKit never adds a scrollbar or
      // changes the lyric viewport width mid-transition.
      overflowX: "hidden",
      padding: "0 24px",
      flex: 1,
      minHeight: 0,
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
  }, "Head to My Records to add your first album.")) : (() => {
    const visible = orderLibrary(userLibrary, recentPlayedIds);
    const recentSet = new Set((recentPlayedIds || []).map(String));
    const recent = visible.filter(a => recentSet.has(String(a.itunes_collection_id)));
    const rest = visible.filter(a => !recentSet.has(String(a.itunes_collection_id)));
    const showHeaders = recent.length > 0 && rest.length > 0;
    const header = (label, gold) => /*#__PURE__*/React.createElement("div", { key: "hdr-" + label, style: { fontSize: 11, fontWeight: 700, letterSpacing: 0.7, textTransform: "uppercase", color: gold ? "rgba(212,168,70,0.8)" : "rgba(255,255,255,0.3)", padding: "14px 2px 6px", display: "flex", alignItems: "center", gap: 6 } }, gold ? /*#__PURE__*/React.createElement("svg", { width: "11", height: "11", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2.5", strokeLinecap: "round", strokeLinejoin: "round" }, /*#__PURE__*/React.createElement("circle", { cx: "12", cy: "12", r: "9" }), /*#__PURE__*/React.createElement("path", { d: "M12 7v5l3 2" })) : null, label);
    const row = (album, isRecent) => {
      const isSelected = turntableAlbum?.itunes_collection_id === album.itunes_collection_id;
      return /*#__PURE__*/React.createElement("button", {
        key: album.id,
        onClick: () => {
          setTurntableAlbum({ itunes_collection_id: album.itunes_collection_id, album_name: album.album_name, artist_name: album.artist_name, artwork_url: album.artwork_url });
          setShowAlbumPicker(false);
        },
        style: { width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "12px 0", background: isRecent ? "rgba(212,168,70,0.06)" : "none", borderRadius: isRecent ? 12 : 0, border: "none", borderBottom: isRecent ? "1px solid transparent" : "1px solid rgba(255,255,255,0.04)", cursor: "pointer", fontFamily: "inherit", textAlign: "left" }
      }, album.artwork_url ? /*#__PURE__*/React.createElement("img", { src: album.artwork_url, alt: "", style: { width: 44, height: 44, borderRadius: 7, objectFit: "cover", flexShrink: 0, opacity: isSelected ? 1 : 0.85 } }) : /*#__PURE__*/React.createElement("div", { style: { width: 44, height: 44, borderRadius: 7, background: "rgba(255,255,255,0.04)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 } }, /*#__PURE__*/React.createElement("svg", { width: "1em", height: "1em", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round" }, /*#__PURE__*/React.createElement("circle", { cx: "12", cy: "12", r: "10" }), /*#__PURE__*/React.createElement("circle", { cx: "12", cy: "12", r: "3" }))), /*#__PURE__*/React.createElement("div", { style: { flex: 1, minWidth: 0 } }, /*#__PURE__*/React.createElement("div", { style: { fontSize: 14, fontWeight: isSelected ? 700 : 500, color: isSelected ? "#d4a846" : "#f0e6d3", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, album.album_name), /*#__PURE__*/React.createElement("div", { style: { fontSize: 12, color: "rgba(255,255,255,0.4)", marginTop: 2 } }, album.artist_name)), isSelected && /*#__PURE__*/React.createElement("span", { style: { fontSize: 14, color: "#d4a846", flexShrink: 0 } }, "✓"));
    };
    const out = [];
    if (showHeaders) out.push(header("Recently played", true));
    recent.forEach(a => out.push(row(a, true)));
    if (showHeaders) out.push(header("By artist", false));
    rest.forEach(a => out.push(row(a, false)));
    return out;
  })(), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      padding: "20px 0 4px"
    }
  }, /*#__PURE__*/React.createElement("a", {
    href: window.Capacitor ? "/library.html?openSearch=1" : "/library?openSearch=1",
    style: {
      fontSize: 12,
      color: "rgba(255,255,255,0.3)",
      textDecoration: "none"
    }
  }, "+ Add Record"))))), showSideInfoSheet && /*#__PURE__*/React.createElement(SideInfoSheet, {
    tracks: turntableTracksRef.current,
    initialBreaks: null,
    saving: userMetaSaving,
    error: userMetaError,
    onSave: handleSaveUserSides,
    onClose: () => setShowSideInfoSheet(false)
  }), showLyricsEditor && lyricsEditorTrack?.trackId && /*#__PURE__*/React.createElement(LyricsEditorSheet, {
    track: lyricsEditorTrack,
    sites: LYRIC_SITES,
    saving: userMetaSaving,
    error: userMetaError,
    onSave: handleSaveUserLyrics,
    onClose: () => setShowLyricsEditor(false)
  }), showTrackList && !window.Capacitor && /*#__PURE__*/React.createElement("div", {
    onClick: () => setShowTrackList(false),
    style: { position: "fixed", inset: 0, zIndex: 201, background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)", cursor: "pointer", display: "flex", alignItems: "flex-end", justifyContent: "center" }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: e => e.stopPropagation(),
    style: { width: "100%", maxWidth: "520px", background: "#0f0f1c", borderRadius: "24px 24px 0 0", maxHeight: "80vh", overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: "0 -8px 48px rgba(0,0,0,0.6)", animation: "slide-up 0.3s ease" }
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
    style: { flex: 1, minHeight: 0, overflowY: "auto", WebkitOverflowScrolling: "touch", padding: "0 24px 40px", display: "flex", flexDirection: "column", gap: "20px" }
  }, (() => {
    const _wt = turntableTracksRef.current;
    if (!_wt.length) return null;
    const _groups = getSideGroups(_wt, vinylSidesRef.current, vinylDbRelease?.vinyl_tracks);
    const _noSideData = !hasSideData(vinylSidesRef.current, vinylDbRelease?.vinyl_tracks);
    return [
      _noSideData && /*#__PURE__*/React.createElement("div", { key: "no-side-notice", style: { fontSize: 11, color: "rgba(255,180,0,0.75)", padding: "7px 12px", background: "rgba(255,180,0,0.07)", borderRadius: 8, border: "1px solid rgba(255,180,0,0.2)", marginBottom: 4 } }, "⚠︎ Side data pending — track grouping is estimated"),
      ..._groups.map(({ side, tracks }) => /*#__PURE__*/React.createElement("div", { key: side },
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
    ))].filter(Boolean);
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
    onClick: toggleFlipDings,
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
  }))), IS_IOS && /*#__PURE__*/React.createElement("div", {
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
  }, "Notifications were blocked. Enable them in iOS Settings.")), /*#__PURE__*/React.createElement("div", {
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
}, "Prevent display from sleeping"), keepAwakeError && /*#__PURE__*/React.createElement("div", {
  style: {fontSize: "11px", color: "#e8a0a8", marginTop: "3px"}
}, IS_IOS ? "Could not change the iOS display setting" : "Not supported by this browser"))), /*#__PURE__*/React.createElement("div", {
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
       ["Play history & stats", "See everything you've synced"],
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
  }, "This permanently deletes your account, library, and sync history. This cannot be undone."), deleteError && /*#__PURE__*/React.createElement("div", {
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
      backdropFilter: "blur(4px)",
      // Flex-end pin (not an absolute panel) so the flex:1 list scrolls on iOS.
      display: "flex",
      flexDirection: "column",
      justifyContent: "flex-end"
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: e => e.stopPropagation(),
    style: {
      width: "100%",
      background: "#0f0f1c",
      borderRadius: "24px 24px 0 0",
      maxHeight: "80vh",
      overflow: "hidden",
      display: "flex",
      flexDirection: "column",
      minHeight: 0,
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
      minHeight: 0,
      WebkitOverflowScrolling: "touch",
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
  }, "No songs yet.", /*#__PURE__*/React.createElement("br", null), "Start syncing to build your history.") : history.map((item, i) => /*#__PURE__*/React.createElement("div", {
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
    // Tap the background (outside the controls panel, which stops propagation)
    // to close the sync controls. Touching or scrolling the lyrics never opens
    // them — only the edge-mounted vinyl button does.
    onPointerDown: () => {
      if (controlsVisible) { menuWasOpenRef.current = true; setControlsVisible(false); }
      else menuWasOpenRef.current = false;
    },
    // If the dismissing gesture landed on empty space, no lyric handler consumes
    // the flag. Clear it at the end of that same click so the next tap works.
    onClick: () => { menuWasOpenRef.current = false; }
  }, !controlsVisible && /*#__PURE__*/React.createElement("button", {
    onClick: () => setControlsVisible(true),
    // Don't let the pointer gesture bubble to the background handler.
    onPointerDown: e => e.stopPropagation(),
    title: "Sync controls",
    "aria-label": "Open sync controls",
    style: {
      position: "fixed",
      // Stay physically attached to the viewport edge at every window size.
      // On iOS portrait, keep the record control below the song header instead
      // of crowding the top safe area. Web + landscape retain their placement.
      top: isLandscape ? "68px" : IS_IOS ? "28vh" : "calc(env(safe-area-inset-top) + 70px)",
      left: "5px",
      zIndex: 25,
      background: "none",
      border: "none",
      borderRadius: 0,
      width: "38px",
      height: "38px",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      color: "rgba(240,230,211,0.62)",
      cursor: "pointer",
      padding: 0
    }
  }, /*#__PURE__*/React.createElement("svg", {
    width: "25",
    height: "25",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "0.9",
    strokeLinecap: "round",
    "aria-hidden": "true"
  }, /*#__PURE__*/React.createElement("circle", { cx: "12", cy: "12", r: "9" }),
  /*#__PURE__*/React.createElement("circle", { cx: "12", cy: "12", r: "2.5" }),
  /*#__PURE__*/React.createElement("circle", { cx: "12", cy: "12", r: "0.7", fill: "currentColor", stroke: "none" }))), kbToast && /*#__PURE__*/React.createElement("div", {
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
  }, artwork && /*#__PURE__*/React.createElement("img", {
    src: artwork, alt: "",
    style: { width: "32px", height: "32px", borderRadius: "6px", flexShrink: 0, boxShadow: "0 2px 8px rgba(0,0,0,0.5)" }
  }),
  /*#__PURE__*/React.createElement("div", { style: { flex: 1, minWidth: 0 } },
    renderListeningTitleNav({ fontSize: "13px", artistFontSize: "11px" })
  ),
  (() => { const si = getSideInfo(); return si ? /*#__PURE__*/React.createElement("div", { style: { fontSize: "10px", fontWeight: "700", letterSpacing: "2px", color: "rgba(212,168,70,0.85)", textTransform: "uppercase", flexShrink: 0 } }, si.side ? `Side ${si.side} \xB7 ${si.track}` : `Track ${si.track}`) : null; })(),
  cast.supported && /*#__PURE__*/React.createElement("button", {
    onClick: () => setShowCast(true),
    title: cast.connected ? `Casting to ${cast.deviceName || "TV"}` : "Cast lyrics to TV",
    "aria-label": "Cast lyrics to TV",
    style: { position: "relative", width: "30px", height: "30px", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, padding: 0, border: "none", background: "none", color: cast.connected ? "#d4a846" : "rgba(255,255,255,0.45)" }
  }, /*#__PURE__*/React.createElement(CastGlyph, { connected: cast.connected }), cast.connected && /*#__PURE__*/React.createElement("span", {
    style: { position: "absolute", top: "2px", right: "1px", width: "5px", height: "5px", borderRadius: "50%", background: "#d4a846", boxShadow: "0 0 7px rgba(212,168,70,0.9)" }
  })),
  /*#__PURE__*/React.createElement("button", {
    onClick: () => setShowSettings(!showSettings),
    style: { background: "linear-gradient(135deg,#d4a846,#c9807a)", border: "none", borderRadius: "50%", width: "28px", height: "28px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "11px", fontWeight: "700", color: "#080810", cursor: "pointer", flexShrink: 0, padding: 0 }
  }, user?.email?.[0]?.toUpperCase() || "?")), !isLandscape && /*#__PURE__*/React.createElement("div", {
    className: "safe-top",
    // Portrait-only header (in landscape the fixed top bar carries this info).
    // Stays visible on iOS while idle — it's the "your spot is still saved"
    // proof (song/artist/time). Only the bottom controls collapse on idle.
    style: {
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
  }, artwork && /*#__PURE__*/React.createElement("img", {
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
      minWidth: 0,
      flex: 1
    }
  }, renderListeningTitleNav({
    fontSize: "14px",
    artistFontSize: "12px",
    wrapTitle: IS_IOS
  }), (() => {
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
  }, cast.supported && /*#__PURE__*/React.createElement("button", {
    onClick: () => setShowCast(true),
    title: cast.connected ? `Casting to ${cast.deviceName || "TV"}` : "Cast lyrics to TV",
    "aria-label": "Cast lyrics to TV",
    style: { position: "relative", width: "30px", height: "30px", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, padding: 0, border: "none", background: "none", color: cast.connected ? "#d4a846" : "rgba(255,255,255,0.45)" }
  }, /*#__PURE__*/React.createElement(CastGlyph, { connected: cast.connected }), cast.connected && /*#__PURE__*/React.createElement("span", {
    style: { position: "absolute", top: "2px", right: "1px", width: "5px", height: "5px", borderRadius: "50%", background: "#d4a846", boxShadow: "0 0 7px rgba(212,168,70,0.9)" }
  })), /*#__PURE__*/React.createElement("button", {
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
      position: "fixed",
      top: "52px",
      // Follow the lyric column when the side controls claim the left rail.
      // This keeps both the bar and timestamp centered above the lyrics rather
      // than centered across the full window behind the open menu.
      left: menuOpen ? lyricAreaLeft + "px" : 0,
      right: menuOpen ? "auto" : 0,
      width: menuOpen ? lyricAreaW + "px" : "auto",
      height: "24px",
      zIndex: 19,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      gap: "8px",
      padding: menuOpen ? "0 12px" : 0,
      boxSizing: "border-box",
      transition: "left 0.35s ease, width 0.35s ease, padding 0.35s ease"
    } : {
      height: "22px",
      flexShrink: 0,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      gap: "8px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: isLandscape
        ? (menuOpen ? "calc(100% - 92px)" : "min(62vw, 520px)")
        : "68vw",
      maxWidth: menuOpen ? "460px" : "520px",
      minWidth: menuOpen ? "80px" : 0,
      height: isLandscape ? "5px" : "3px",
      background: "rgba(255,255,255,0.1)",
      cursor: songDuration ? "pointer" : "default",
      borderRadius: "3px",
      overflow: "hidden",
      flexShrink: 0
    },
    onClick: e => {
      if (!songDuration) return;
      const r = e.currentTarget.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      const targetTime = ratio * songDuration;
      initialPosRef.current = targetTime;
      syncStartRef.current = Date.now();
      endClockPosRef.current = targetTime;
      endClockStartRef.current = syncStartRef.current;
      setPlaybackTime(targetTime);
    }
  }, (() => {
    // The progress bar reflects the corrected lyric position. Auto-advance
    // uses its separate, nudge-isolated ending clock at the same measured rate.
    const effDur = songDuration ?? (lyrics.length > 0 ? lyrics[lyrics.length - 1].time + 3 : null);
    return effDur ? /*#__PURE__*/React.createElement("div", {
      style: {
        height: "100%",
        background: "linear-gradient(to right, #d4a846, #c9807a)",
        width: `${Math.max(0, Math.min(playbackTime / effDur * 100, 100))}%`,
        transition: "width 80ms linear",
        borderRadius: "3px"
      }
    }) : null;
  })()), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "11px",
      color: "rgba(255,255,255,0.3)",
      fontVariantNumeric: "tabular-nums",
      whiteSpace: "nowrap",
      flexShrink: 0
    }
  }, formatTime(songDuration ? Math.min(playbackTime, songDuration) : playbackTime)
    + (songDuration ? " / " + formatTime(songDuration) : ""))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflow: "hidden",
      position: "relative",
      paddingTop: isLandscape ? "76px" : 0
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
    ref: lyricsScrollRef,
    style: {
      overflowY: "auto",
      height: "100%",
      padding: isLandscape ? (lyricAreaW < 500 ? "4vh 20px 0" : "4vh 40px 0") : "8vh 28px 0",
      width: isLandscape ? lyricAreaW + "px" : undefined,
      maxWidth: isLandscape ? (menuOpen ? "760px" : "820px") : "none",
      marginLeft: isLandscape ? lyricAreaLeft + "px" : undefined,
      // iOS: this lyric list lives inside a position:fixed overlay, so momentum
      // touch scrolling needs these or the user can't drag to pick a line.
      WebkitOverflowScrolling: "touch",
      touchAction: "pan-y",
      overscrollBehavior: "contain",
      // Slide + resize in step with the 0.35s menu fade
      transition: isLandscape ? "margin-left 0.35s, width 0.35s" : "none"
    },
    onPointerDown: noteUserScroll,
    onTouchStart: noteUserScroll,
    onWheel: noteUserScroll,
    onScroll: () => { if (userScrollingRef.current) noteUserScroll(); }
  }, lyrics.length > 0 ? (lyricsUnsynced ? /*#__PURE__*/React.createElement(React.Fragment, null,
    /*#__PURE__*/React.createElement("div", {
      style: { textAlign: "center", fontSize: "10px", letterSpacing: "2px", textTransform: "uppercase", color: "rgba(212,168,70,0.45)", marginBottom: "22px" }
    }, "unsynced lyrics \u00b7 auto-scroll"),
    lyrics.map((line, i) => /*#__PURE__*/React.createElement("div", {
      key: i,
      style: {
        textAlign: "center",
        padding: "7px 0",
        fontSize: Math.round(20 * (isLandscape ? effectiveLyricFontScale : responsiveLyricFontScale)) + "px",
        fontWeight: "500",
        color: "rgba(255,255,255,0.78)",
        lineHeight: "1.45"
      }
    }, line.text)),
    /*#__PURE__*/React.createElement("div", {
      style: { textAlign: "center", marginTop: "48px", color: "rgba(255,255,255,0.25)", fontSize: "12px", lineHeight: "2.1" }
    }, [detectedSong?.title, detectedSong?.artist, detectedSong?.album, "Lyrics via LRCLib"].filter(Boolean).map((t, i) =>
      /*#__PURE__*/React.createElement("div", { key: i }, t)
    )),
    /*#__PURE__*/React.createElement("div", { style: { paddingBottom: "30vh" } })
  ) : /*#__PURE__*/React.createElement(React.Fragment, null,
  // Give the first lyric enough room above it to occupy the exact center of
  // every lyric viewport. A scroll container cannot otherwise scroll its
  // first child upward from the top edge, even when the centering math is
  // correct. Percentage height follows the actual lyric panel on iPhone,
  // iPad split view, and landscape instead of assuming a screen height.
  /*#__PURE__*/React.createElement("div", {
    "aria-hidden": true,
    style: {
      // During the instrumental intro, keep the upcoming lyrics at the top.
      // As the first lyric activates, grow the runway while the scroll hook
      // rolls that line into its normal above-center resting position.
      height: currentIndex < 0 ? "0%" : "50%",
      minHeight: currentIndex < 0 ? "0%" : "50%",
      flexShrink: 0,
      pointerEvents: "none",
      transition: "height 650ms ease-in-out, min-height 650ms ease-in-out"
    }
  }), (() => {
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
    // Credits may be timestamped beyond a short outro, but they must never
    // extend the perceived song runtime. Stop their progression at the real
    // track duration while still allowing available outro time to reveal them.
    const creditPlaybackTime = songDuration
      ? Math.min(playbackTime, songDuration)
      : playbackTime;
    const pastLastLyric = currentIndex >= lyrics.length - 1 && lyrics.length > 0;
    const effectiveIndex = pastLastLyric
      ? lyrics.length - 1 + creditLines.reduce((best, cl, ci) => creditPlaybackTime >= cl.time ? ci + 1 : best, 0)
      : currentIndex;
    // Render every line so the whole song is scrollable. The scroll hook sets
    // a custom opacity from physical position; React never swaps text layers.
    // iOS portrait runs a touch smaller so more lines fit on the phone screen.
    const iosPortrait = IS_IOS && !isLandscape;
    const previewFont = iosPortrait ? 16 : 18;
    // Let every lyric row borrow most of the panel's side padding. Applying
    // this consistently preserves wrapping as highlighting moves.
    const activeGutterExpansion = isLandscape
      ? (lyricAreaW < 500 ? 14 : 30)
      : 20;
    const renderedPreviewFontPx = previewFont
      * (isLandscape ? effectiveLyricFontScale : responsiveLyricFontScale);
    return allLines.map((line, i) => {
      const dist = i - effectiveIndex;
      const cur = dist === 0;
      const isCredit = !!line.isCredit;
      const handleLineClick = () => {
        // A tap while the side menu is open just dismisses it; never seeks.
        if (menuWasOpenRef.current || controlsVisible) {
          menuWasOpenRef.current = false;
          if (controlsVisible) setControlsVisible(false);
          return;
        }
        if (cur) return refollow();
        if (!isCredit) seekToLine(i);
      };
      return /*#__PURE__*/React.createElement("div", {
        key: i,
        "data-lyric-line": "true",
        "data-credit-line": isCredit ? "true" : undefined,
        ref: cur ? currentLineRef : i === lyrics.length ? creditsRef : null,
        style: {
          textAlign: "center",
          // One stable text layer per lyric: no resizing, duplicate crossfade,
          // or transform ownership changes. Extra fixed padding gives the
          // centered line breathing room without moving neighboring rows.
          padding: "11px 0",
          fontSize: isCredit
            ? "13px"
            : Math.round(renderedPreviewFontPx) + "px",
          fontWeight: isCredit ? "400" : "600",
          color: "#ffffff",
          opacity: "var(--lyric-opacity, 0.14)",
          lineHeight: "1.4",
          textShadow: "none",
          cursor: "default",
          letterSpacing: isCredit ? "0.2px" : "normal",
          maxWidth: isCredit ? "260px" : "none",
          // Keep the wider lyric box requested for the focused area, but use it
          // for every row so highlighting never changes wrapping geometry.
          margin: isCredit ? "0 auto" : `0 -${activeGutterExpansion}px`,
          width: isCredit ? "auto" : `calc(100% + ${activeGutterExpansion * 2}px)`,
        }
      }, /*#__PURE__*/React.createElement("span", {
        onClick: handleLineClick,
        style: {
          display: "inline-block",
          maxWidth: "100%",
          overflowWrap: "break-word",
          cursor: isCredit ? "default" : "pointer",
        }
      }, line.text));
    });
  })(), /*#__PURE__*/React.createElement("div", {
    "aria-hidden": true,
    // Matching space below the credits lets the final highlighted row reach
    // the same center point instead of stopping near the bottom of the list.
    style: { height: "50%", minHeight: "50%", flexShrink: 0, pointerEvents: "none" }
  }))) : /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      color: "rgba(255,255,255,0.2)",
      fontSize: "16px",
      paddingTop: "30vh"
    }
  }, /*#__PURE__*/React.createElement("div", null, "No lyrics found for this track"), lyricsEditorTrack?.trackId && /*#__PURE__*/React.createElement("button", {
    onClick: () => { setUserMetaError(null); setShowLyricsEditor(true); },
    style: {
      marginTop: "18px",
      background: "rgba(212,168,70,0.1)",
      border: "1px solid rgba(212,168,70,0.35)",
      color: "rgba(212,168,70,0.9)",
      borderRadius: "50px",
      padding: "12px 28px",
      fontSize: "13px",
      fontWeight: 700,
      cursor: "pointer",
      fontFamily: "inherit"
    }
  }, "Add lyrics"), lyricsEditorTrack?.trackId && /*#__PURE__*/React.createElement("div", {
    style: { fontSize: "11px", color: "rgba(255,255,255,0.25)", marginTop: 10, lineHeight: 1.5 }
  }, "Find them on Genius, AZLyrics, Musixmatch or LRCLIB and paste them in"))), /*#__PURE__*/React.createElement("div", {
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
    // Taps inside the controls panel must NOT bubble to the background
    // dismiss handler, or pressing a button would hide the menu.
    onPointerDown: e => e.stopPropagation(),
    style: isLandscape ? {
      // Landscape: the ONLY left panel now — a full-height controls sidebar from
      // just below the top bar (52px) to the bottom. Controls are vertically
      // centered in that space. paddingBottom clears the tab bar (~55px +
      // safe-area) plus the tracklist peek pill + version footer.
      padding: railW < 240 ? "10px 12px calc(env(safe-area-inset-bottom) + 78px)" : "12px 20px calc(env(safe-area-inset-bottom) + 78px)",
      position: "fixed",
      left: 0,
      top: "52px",
      bottom: 0,
      width: railW + "px",
      display: "flex",
      flexDirection: "column",
      justifyContent: "safe center", // falls back to top-aligned if controls overflow a short screen
      overflowY: "auto",
      background: "rgba(8,8,16,0.97)",
      borderRight: "1px solid rgba(255,255,255,0.06)",
      zIndex: 15,
      opacity: controlsVisible ? 1 : 0,
      transition: "opacity 0.35s",
      pointerEvents: controlsVisible ? "auto" : "none"
    } : {
      paddingTop: IS_IOS ? "8px" : "12px",
      paddingLeft: "20px",
      paddingRight: "20px",
      // Reserve room for the fixed tab bar (~55px content + safe-area) PLUS
      // the tracklist peek pill (~44px including margin) and the version
      // footer (~20px) so nothing gets clipped by the tab bar.
      // iOS sits a touch lower (smaller reserve) so the lyrics get more room;
      // the tab bar fades out with the controls there, so it can't clip.
      paddingBottom: IS_IOS ? "calc(env(safe-area-inset-bottom) + 98px)" : "calc(env(safe-area-inset-bottom) + 120px)",
      flexShrink: 0,
      overflow: "hidden",
      // Closed: collapse the controls (nudge / skip / etc.) to zero height so
      // the lyrics reclaim the space. The header and tab bar stay put — only
      // this control block folds away. box-sizing:border-box means maxHeight:0
      // swallows the padding too. Only the edge-mounted vinyl button re-expands it.
      maxHeight: !controlsVisible ? "0px" : "460px",
      opacity: !controlsVisible ? 0 : 1,
      transition: "max-height 0.35s ease, opacity 0.35s ease",
      pointerEvents: !controlsVisible ? "none" : "auto"
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
  }, isResyncing ? "↻ listening for resync…" : lyricsUnsynced ? "unsynced · adjust scroll speed" : "← early · behind →"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "center",
      alignItems: "center",
      flexWrap: "wrap",
      gap: "6px",
      marginBottom: "10px"
    }
  }, lyricsUnsynced ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("button", {
    onClick: () => adjustScrollSpeed(-0.25),
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
  }, "− slower"), /*#__PURE__*/React.createElement("span", {
    style: { color: "rgba(255,255,255,0.5)", fontSize: "13px", fontWeight: "600", minWidth: "48px", textAlign: "center" }
  }, scrollSpeed + "×"), /*#__PURE__*/React.createElement("button", {
    onClick: () => adjustScrollSpeed(0.25),
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
  }, "+ faster")) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      position: "relative"
    },
    onPointerEnter: () => setHoverNudge("left"),
    onPointerLeave: () => setHoverNudge(null)
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => handleNudge(-NUDGE_STEP_SECS),
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
  }, "\u2212" + NUDGE_STEP_SECS + "s"), hoverNudge === "left" && /*#__PURE__*/React.createElement("button", {
    onClick: () => handleNudge(-NUDGE_FINE_SECS),
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
  }, "\u2212" + NUDGE_FINE_SECS + "s")), /*#__PURE__*/React.createElement("div", {
    style: {
      position: "relative"
    },
    onPointerEnter: () => setHoverNudge("right"),
    onPointerLeave: () => setHoverNudge(null)
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => handleNudge(NUDGE_STEP_SECS),
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
  }, "+" + NUDGE_STEP_SECS + "s"), hoverNudge === "right" && /*#__PURE__*/React.createElement("button", {
    onClick: () => handleNudge(NUDGE_FINE_SECS),
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
  }, "+" + NUDGE_FINE_SECS + "s")))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "center",
      flexWrap: "wrap",
      gap: "6px",
      marginBottom: "8px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: "100%",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      gap: "8px",
      marginBottom: "2px"
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => adjustLyricFontSize(-0.1),
    disabled: responsiveLyricFontScale <= 0.8,
    "aria-label": "Decrease lyric font size",
    style: {
      width: "38px",
      height: "32px",
      background: "rgba(255,255,255,0.07)",
      border: "1px solid rgba(255,255,255,0.15)",
      borderRadius: "16px",
      color: "rgba(255,255,255,0.7)",
      fontSize: "13px",
      fontWeight: "700",
      fontFamily: "inherit",
      cursor: responsiveLyricFontScale <= 0.8 ? "default" : "pointer",
      opacity: responsiveLyricFontScale <= 0.8 ? 0.35 : 1
    }
  }, "A−"), /*#__PURE__*/React.createElement("span", {
    style: { minWidth: "48px", textAlign: "center", color: "rgba(255,255,255,0.45)", fontSize: "11px", fontWeight: "600" }
  }, Math.round((lyricsUnsynced ? 20 : (IS_IOS && !isLandscape ? 16 : 18))
    * (isLandscape ? effectiveLyricFontScale : responsiveLyricFontScale)) + " px"), /*#__PURE__*/React.createElement("button", {
    onClick: () => adjustLyricFontSize(0.1),
    disabled: responsiveLyricFontScale >= responsiveLyricFontScaleCap - 0.001,
    "aria-label": "Increase lyric font size",
    style: {
      width: "38px",
      height: "32px",
      background: "rgba(255,255,255,0.07)",
      border: "1px solid rgba(255,255,255,0.15)",
      borderRadius: "16px",
      color: "rgba(255,255,255,0.7)",
      fontSize: "16px",
      fontWeight: "700",
      fontFamily: "inherit",
      cursor: responsiveLyricFontScale >= responsiveLyricFontScaleCap - 0.001 ? "default" : "pointer",
      opacity: responsiveLyricFontScale >= responsiveLyricFontScaleCap - 0.001 ? 0.35 : 1
    }
  }, "A+")), userScrolling && /*#__PURE__*/React.createElement("button", {
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
  }, "\u21BB Resync")), (() => {
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
    const goPrev = () => hasTT ? jumpToTrackIdx(Math.max(0, tIdx - 1)) : jumpToTrack(Math.max(0, currentTrackIndex - 1));
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
          display: "block", margin: "8px auto 4px", background: "rgba(212,168,70,0.1)",
          border: "1px solid rgba(212,168,70,0.28)", color: "rgba(212,168,70,0.9)",
          borderRadius: "50px", padding: "5px 12px", fontSize: "10px", fontWeight: "700",
          letterSpacing: "0.4px", cursor: "pointer", fontFamily: "inherit"
        }
      }, `\u2630  Track ${tIdx + 1} of ${tTracks.length}`),
      showNowPlayingList && /*#__PURE__*/React.createElement("div", {
        onClick: () => setShowNowPlayingList(false),
        style: { position: "fixed", inset: 0, zIndex: 600, background: "rgba(8,8,16,0.75)", backdropFilter: "blur(6px)", display: "flex", flexDirection: "column", justifyContent: "flex-end" }
      }, /*#__PURE__*/React.createElement("div", {
        onClick: e => e.stopPropagation(),
        style: { background: "#0e0e1a", borderRadius: "20px 20px 0 0", border: "1px solid rgba(255,255,255,0.09)", maxHeight: "80vh", overflow: "hidden", display: "flex", flexDirection: "column", paddingBottom: "max(24px, calc(env(safe-area-inset-bottom) + 12px))" }
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
          style: { flex: 1, minHeight: 0, overflowY: "auto", WebkitOverflowScrolling: "touch", padding: "8px 0" }
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
  }, "Tap to choose a record from your library")))), !turntableTracksLoading && turntableAlbum && sideDataMissing && /*#__PURE__*/React.createElement("div", {
    // No side info for this record — warn before sync so the user can add it
    // (flip detection would otherwise guess a midpoint A/B split).
    style: {
      width: "100%",
      background: "rgba(212,168,70,0.06)",
      border: "1px solid rgba(212,168,70,0.25)",
      borderRadius: "14px",
      padding: "10px 14px",
      marginBottom: "12px",
      display: "flex",
      alignItems: "center",
      gap: "10px",
      textAlign: "left"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: { flex: 1, minWidth: 0 }
  }, /*#__PURE__*/React.createElement("div", {
    style: { fontSize: "12px", fontWeight: 600, color: "rgba(212,168,70,0.9)" }
  }, "No side info for this record"), /*#__PURE__*/React.createElement("div", {
    style: { fontSize: "11px", color: "rgba(255,255,255,0.4)", marginTop: 2, lineHeight: 1.4 }
  }, "Liri is guessing where the sides split, so flip detection may be off.")), /*#__PURE__*/React.createElement("button", {
    onClick: () => { setUserMetaError(null); setShowSideInfoSheet(true); },
    style: {
      background: "rgba(212,168,70,0.15)",
      border: "1px solid rgba(212,168,70,0.4)",
      color: "rgba(212,168,70,0.95)",
      borderRadius: "50px",
      padding: "8px 14px",
      fontSize: "12px",
      fontWeight: 700,
      cursor: "pointer",
      fontFamily: "inherit",
      flexShrink: 0,
      whiteSpace: "nowrap"
    }
  }, "Add sides")), /*#__PURE__*/React.createElement("button", {
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
  }, turntableTracksLoading ? "Loading…" : turntableAlbum ? "Find my place" : "Sync Lyrics"), !turntableTracksLoading && turntableAlbum && currentTrackIndex >= 0 && getNextSideLetter() && /*#__PURE__*/React.createElement("button", {
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
  turntableAlbum && turntableTracksRef.current.length > 0 && (() => {
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
      // Warning when no curated/Discogs side data exists — track grouping is estimated
      !hasSideData(vinylSidesRef.current, vinylDbRelease?.vinyl_tracks) && (isWeb || showTrackList) &&
        /*#__PURE__*/React.createElement("div", { style: { fontSize: 11, color: "rgba(255,180,0,0.75)", marginBottom: 10, padding: "6px 11px", background: "rgba(255,180,0,0.07)", borderRadius: 8, border: "1px solid rgba(255,180,0,0.2)" } }, "⚠︎ Side data pending — track order is estimated"),
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
  }), (sideEndReason === "flip" || sideEndReason === "failed") && /*#__PURE__*/React.createElement("button", {
    onClick: toggleFlipDings,
    "aria-label": flipSound ? "Mute flip dings" : "Unmute flip dings",
    style: {
      marginTop: "16px",
      background: flipSound ? "rgba(255,255,255,0.06)" : "rgba(212,168,70,0.12)",
      border: flipSound ? "1px solid rgba(255,255,255,0.12)" : "1px solid rgba(212,168,70,0.4)",
      color: flipSound ? "rgba(240,230,211,0.7)" : "#d4a846",
      borderRadius: "50px",
      padding: "8px 18px",
      fontSize: "13px",
      fontWeight: "700",
      cursor: "pointer",
      fontFamily: "inherit",
      display: "inline-flex",
      alignItems: "center",
      gap: "7px"
    }
  }, flipSound
    ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("svg", { width: "15", height: "15", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round" }, /*#__PURE__*/React.createElement("path", { d: "M11 5 6 9H2v6h4l5 4V5z" }), /*#__PURE__*/React.createElement("path", { d: "M15.54 8.46a5 5 0 0 1 0 7.07" }), /*#__PURE__*/React.createElement("path", { d: "M19.07 4.93a10 10 0 0 1 0 14.14" })), "Mute dings")
    : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("svg", { width: "15", height: "15", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round" }, /*#__PURE__*/React.createElement("path", { d: "M11 5 6 9H2v6h4l5 4V5z" }), /*#__PURE__*/React.createElement("line", { x1: "23", y1: "9", x2: "17", y2: "15" }), /*#__PURE__*/React.createElement("line", { x1: "17", y1: "9", x2: "23", y2: "15" })), "Dings muted")), sideEndReason === "flip" && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
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
  }, "\u21BB Sync with Shazam"), lastSong && /*#__PURE__*/React.createElement("button", {
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
  }, "\u21BB Sync with Shazam"), lastSong && /*#__PURE__*/React.createElement("button", {
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
  }, "\u2190 Back"))),
  /* \u2500\u2500 "Or select another side" \u2014 quiet picker under the main flip CTA \u2500\u2500 */
  (sideEndReason === "flip" || sideEndReason === "failed") && !isNeedleDrop && turntableTracksRef.current.length > 0 && (() => {
    const groups = getSideGroups(turntableTracksRef.current, vinylSidesRef.current, vinylDbRelease?.vinyl_tracks);
    if (!groups.length) return null;
    return /*#__PURE__*/React.createElement("div", {
      style: { marginTop: "20px", width: "100%" }
    }, /*#__PURE__*/React.createElement("button", {
      onClick: () => setShowSideEndPicker(v => !v),
      style: {
        background: "none",
        border: "none",
        color: "rgba(255,255,255,0.3)",
        fontSize: "12px",
        cursor: "pointer",
        fontFamily: "inherit",
        width: "100%",
        padding: "6px 0"
      }
    }, (showSideEndPicker ? "\u25b4" : "\u25be") + " Or select another side"),
    showSideEndPicker && /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: "8px",
        background: "rgba(0,0,0,0.35)",
        border: "1px solid rgba(255,255,255,0.07)",
        borderRadius: "12px",
        padding: "8px",
        maxHeight: "32vh",
        overflowY: "auto",
        WebkitOverflowScrolling: "touch",
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        textAlign: "left"
      }
    }, groups.map(({ side, tracks: sideTracks }) => /*#__PURE__*/React.createElement("button", {
      key: side,
      onClick: () => startSideAtIdx(sideTracks[0].idx),
      style: {
        background: "rgba(255,255,255,0.03)",
        border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: "10px",
        padding: "10px 12px",
        cursor: "pointer",
        fontFamily: "inherit",
        textAlign: "left",
        width: "100%"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: "10px",
        letterSpacing: "2px",
        textTransform: "uppercase",
        color: "rgba(212,168,70,0.75)",
        fontWeight: "700",
        marginBottom: "5px"
      }
    }, "Side " + side + " \u2192"), /*#__PURE__*/React.createElement("div", {
      style: { fontSize: "11px", color: "rgba(255,255,255,0.4)", lineHeight: "1.6" }
    }, sideTracks.map(({ track: t, idx: i }) => /*#__PURE__*/React.createElement("div", {
      key: i,
      style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }
    }, (i + 1) + ". " + (t.trackName || ""))))))));
  })()), mode === "limit" && /*#__PURE__*/React.createElement("div", {
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
    window.TabBar ? /*#__PURE__*/React.createElement(window.TabBar, { current: "sync" }) : null
  )
);
