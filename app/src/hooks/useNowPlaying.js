// useNowPlaying — cross-tab/page-reload persistence + playing-tab heartbeat.
//
// The tab bar uses regular <a href> links, which do a full page reload and
// destroy all React state. This hook saves whatever is currently playing to
// session/localStorage before the page unloads, restores it on the way back,
// and stamps a heartbeat so a second open tab doesn't ghost-restore the same
// session (double clocks = duplicate/early flip chimes + notifications).
//
// All of the playback state here (mode, detectedSong, lyrics, refs, etc.) is
// owned by the caller (main.js) — this hook only reads/writes through the
// getters/setters/refs passed in, per the "one owner per ref" refactor rule.
// It owns nothing externally visible itself (nowPlayingSnapshotRef is purely
// internal), so it returns nothing.

import { SYNC_PLAYBACK_RATE } from "../../base/lib/config.js";

const { useRef, useEffect } = React;

export function useNowPlaying({
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
}) {
  // ── Now-playing state persistence across tab navigation ──────────────────
  // A ref captures the latest snapshot each time key state changes, so the
  // pagehide handler always gets fresh values without stale closure issues.
  const nowPlayingSnapshotRef = useRef(null);
  useEffect(() => {
    if (mode === "syncing" || mode === "confirmed") {
      nowPlayingSnapshotRef.current = {
        detectedSong, lyrics, songDuration,
        currentTrackIndex, albumCollectionId, identifiedBy,
        turntableMatchedIdx: turntableMatchedIdxRef.current,
      };
      // Also persist to localStorage continuously so a page refresh never loses state
      try {
        const t = syncStartRef.current != null
          ? initialPosRef.current + (Date.now() - syncStartRef.current) / 1000 * SYNC_PLAYBACK_RATE
          : initialPosRef.current;
        localStorage.setItem("liri_nowplaying", JSON.stringify({
          ...nowPlayingSnapshotRef.current,
          playbackTime: Math.max(0, t),
          savedAt: Date.now(),
        }));
      } catch {}
    } else {
      nowPlayingSnapshotRef.current = null;
      // Clear persisted state when user explicitly leaves playing mode
      if (mode === "idle" || mode === "listening") {
        try { localStorage.removeItem("liri_nowplaying"); } catch {}
      }
    }
  }, [mode, detectedSong, lyrics, songDuration, currentTrackIndex, albumCollectionId, identifiedBy]);

  // Save on navigation away (belt-and-suspenders alongside localStorage)
  useEffect(() => {
    const onHide = () => {
      const snap = nowPlayingSnapshotRef.current;
      if (!snap || !snap.detectedSong) return;
      const t = syncStartRef.current != null
        ? initialPosRef.current + (Date.now() - syncStartRef.current) / 1000 * SYNC_PLAYBACK_RATE
        : initialPosRef.current;
      const payload = JSON.stringify({ ...snap, playbackTime: Math.max(0, t), savedAt: Date.now() });
      try { sessionStorage.setItem("liri_nowplaying", payload); } catch {}
      try { localStorage.setItem("liri_nowplaying", payload); } catch {}
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, []);

  // ── Playing-tab heartbeat ─────────────────────────────────────────────────
  // With per-tab accounts, two Liri tabs can be open at once. A tab that is
  // actively syncing stamps a heartbeat every 5s so OTHER tabs know playback
  // is alive elsewhere and don't ghost-restore the same session from
  // localStorage (double clocks = duplicate/early flip chimes + notifications).
  useEffect(() => {
    if (mode !== "syncing") return;
    const beat = () => {
      try { localStorage.setItem("liri_playing_beat", JSON.stringify({ id: sessionTabId, ts: Date.now() })); } catch {}
    };
    beat();
    const id = setInterval(beat, 5000);
    return () => {
      clearInterval(id);
      // Only clear the beat if it's ours — never stomp another tab's.
      try {
        const b = JSON.parse(localStorage.getItem("liri_playing_beat") || "null");
        if (b?.id === sessionTabId) localStorage.removeItem("liri_playing_beat");
      } catch {}
    };
  }, [mode]);

  // Restore on mount — check sessionStorage first (tab nav), then localStorage (refresh)
  useEffect(() => {
    let saved = null;
    try {
      saved = JSON.parse(sessionStorage.getItem("liri_nowplaying") || "null");
      sessionStorage.removeItem("liri_nowplaying");
    } catch {}
    if (!saved) {
      try {
        // The localStorage fallback is for a refresh/restart of the PLAYING
        // tab. If another tab's heartbeat is fresh, playback is alive over
        // there — restoring here too would run a second ghost clock.
        const b = JSON.parse(localStorage.getItem("liri_playing_beat") || "null");
        const otherTabPlaying = b && b.id !== sessionTabId && Date.now() - b.ts < 15000;
        if (!otherTabPlaying) saved = JSON.parse(localStorage.getItem("liri_nowplaying") || "null");
        // don't remove from localStorage here — leave it so rapid re-refreshes also work
      } catch {}
    }
    if (!saved || !saved.detectedSong || Date.now() - saved.savedAt > 60 * 60 * 1000) return; // 1hr window
    // Compute how far the record has advanced while we were on the other page
    const elapsed = (Date.now() - saved.savedAt) / 1000;
    const restoredPos = Math.max(0, saved.playbackTime + elapsed);
    // Restore content state
    setDetectedSong(saved.detectedSong);
    const lrc = saved.lyrics || [];
    setLyrics(lrc);
    lyricsRef.current = lrc;
    setSongDuration(saved.songDuration ?? null);
    setCurrentTrackIndex(saved.currentTrackIndex ?? 0);
    turntableMatchedIdxRef.current = saved.turntableMatchedIdx ?? 0;
    if (saved.albumCollectionId) { setAlbumCollectionId(saved.albumCollectionId); albumCollectionIdRef.current = saved.albumCollectionId; }
    if (saved.identifiedBy) setIdentifiedBy(saved.identifiedBy);
    // Prime the timing so startSync (triggered by setMode below) lands at the right position
    syncCalcRef.current = { startPos: restoredPos, phraseOffset: 0, recStart: Date.now() };
    // Trigger startSync via the mode effect
    setMode("confirmed");
  }, []);
}
