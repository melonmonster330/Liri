// useLyricScroll — lyric view scroll behavior: auto-scroll to the current
// synced line, the unsynced flat-page auto-glide, tap-to-seek, and the
// re-follow (snap back + resume auto-scroll) flow after manual scrolling.
//
// All state/refs here are owned by the caller (main.js) and passed in — this
// hook returns lyricsUnsynced, lyricsScrollRef, seekToLine, refollow, and
// noteUserScroll because the (still-monolithic, pre-Phase-4) render in
// main.js references them directly by these names.

const { useRef, useEffect } = React;

export function useLyricScroll({
  mode,
  lyrics, lyricsRef,
  songDuration,
  isPaused,
  isLandscape, controlsVisible,
  currentIndex, setCurrentIndex,
  playbackTime, setPlaybackTime,
  setUserScrolling, userScrollingRef,
  refollowTimerRef,
  currentLineRef, creditsRef,
  scrollSpeedRef,
  initialPosRef, syncStartRef,
}) {
  // ── Unsynced lyrics: plain text with time:null — flat auto-scroll view ──
  const lyricsUnsynced = lyrics.length > 0 && lyrics[0].time == null;
  const lyricsScrollRef = useRef(null); // the lyrics overflow container

  // ── Scroll to current lyric (skip if user is manually browsing) ──
  useEffect(() => {
    if (userScrollingRef.current || lyricsUnsynced) return;
    if (currentLineRef.current && mode === "syncing") currentLineRef.current.scrollIntoView({
      behavior: "smooth",
      block: "center"
    });
  }, [currentIndex, mode, lyricsUnsynced]);

  // ── Keep the current line centered while the menu fades in/out (landscape) ──
  // Hiding/showing the menu animates the lyrics column's width and font size
  // over 0.35s, which reflows the lines vertically. Without this the current
  // line drifts off-screen mid-transition and only snaps back on the next line
  // change. Pin it to center every frame (instant scroll — no animation to
  // fight) for the duration of the transition so it stays put throughout.
  useEffect(() => {
    if (!isLandscape || mode !== "syncing" || lyricsUnsynced) return;
    let raf, start;
    const pin = ts => {
      if (start == null) start = ts;
      if (!userScrollingRef.current) currentLineRef.current?.scrollIntoView({ block: "center" });
      if (ts - start < 450) raf = requestAnimationFrame(pin);
    };
    raf = requestAnimationFrame(pin);
    return () => cancelAnimationFrame(raf);
  }, [controlsVisible, isLandscape, mode, lyricsUnsynced]);

  // ── Unsynced auto-scroll: glide the flat lyric page at a steady rate ──
  // Base rate spreads the full scroll height over the track duration (guessing
  // ~4.5s a line when duration is unknown); scrollSpeed multiplies it. While
  // the user is manually scrolling we follow their position, so resuming
  // continues from wherever they left the page.
  useEffect(() => {
    if (mode !== "syncing" || !lyricsUnsynced || isPaused) return;
    const el = lyricsScrollRef.current;
    if (!el) return;
    const durGuess = songDuration || lyricsRef.current.length * 4.5 || 180;
    let pos = el.scrollTop;
    let last = performance.now();
    let raf;
    const tick = now => {
      const dt = Math.min(0.2, (now - last) / 1000); // clamp jumps after a backgrounded tab wakes up
      last = now;
      if (userScrollingRef.current) {
        pos = el.scrollTop;
      } else {
        const total = Math.max(0, el.scrollHeight - el.clientHeight);
        const base = total / Math.max(45, durGuess); // px per second at 1×
        pos = Math.min(total, pos + base * scrollSpeedRef.current * dt);
        el.scrollTop = pos;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [mode, lyricsUnsynced, isPaused, songDuration]);

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
    clearTimeout(refollowTimerRef.current);
    // Unsynced view: auto-scroll simply resumes from wherever the user left
    // the page — there is no "current line" to snap to.
    if (lyricsRef.current[0]?.time == null) return;
    currentLineRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "center"
    });
  };

  // Mark the user as manually scrolling and (re)arm a 10s idle timer — once they
  // stop scrolling for 10s we snap back to the current line and resume following.
  const noteUserScroll = () => {
    userScrollingRef.current = true;
    setUserScrolling(true);
    clearTimeout(refollowTimerRef.current);
    refollowTimerRef.current = setTimeout(() => refollow(), 10000);
  };

  // ── Scroll to credits once song passes the last lyric (outro roll) ──
  useEffect(() => {
    if (mode !== "syncing" || !lyrics.length || lyricsUnsynced) return;
    const lastTime = lyrics[lyrics.length - 1].time;
    if (playbackTime >= lastTime + 6 && creditsRef.current) creditsRef.current.scrollIntoView({
      behavior: "smooth",
      block: "center"
    });
  }, [Math.floor(playbackTime), mode, lyrics.length]);

  return { lyricsUnsynced, lyricsScrollRef, seekToLine, refollow, noteUserScroll };
}
