// useLyricScroll — lyric view scroll behavior: auto-scroll to the current
// synced line, the unsynced flat-page auto-glide, tap-to-seek, and the
// re-follow (snap back + resume auto-scroll) flow after manual scrolling.
//
// All state/refs here are owned by the caller (main.js) and passed in — this
// hook returns lyricsUnsynced, lyricsScrollRef, seekToLine, refollow, and
// noteUserScroll because the (still-monolithic, pre-Phase-4) render in
// main.js references them directly by these names.

const { useRef, useEffect, useLayoutEffect } = React;

// Keep the active lyric a little above mathematical center so the upcoming
// lines have more visual room. 48 CSS px is approximately half an inch.
const ACTIVE_LINE_CENTER_OFFSET_PX = 48;

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
  onSeek,
}) {
  // ── Unsynced lyrics: plain text with time:null — flat auto-scroll view ──
  const lyricsUnsynced = lyrics.length > 0 && lyrics[0].time == null;
  const lyricsScrollRef = useRef(null); // the lyrics overflow container
  const rollRafRef = useRef(null);
  const centeredLineRef = useRef(null);
  const lastActiveIndexRef = useRef(currentIndex);

  // Center against the lyric scroller itself, not the page viewport. This is
  // reliable inside iOS's fixed overlay and across every screen size.
  const centerActiveLine = () => {
    const container = lyricsScrollRef.current;
    const line = currentLineRef.current;
    if (!container || !line || mode !== "syncing" || lyricsUnsynced) return;
    const containerRect = container.getBoundingClientRect();
    const lineRect = line.getBoundingClientRect();
    const lineCenterInScroller = lineRect.top - containerRect.top
      + container.scrollTop + lineRect.height / 2;
    const target = Math.max(0, lineCenterInScroller - container.clientHeight / 2
      + ACTIVE_LINE_CENTER_OFFSET_PX);
    container.scrollTop = target;
  };

  // Roll the newly highlighted line into place instead of snapping the list.
  // Recalculate the destination on every frame because the active/inactive
  // font-size transition changes both rows' heights during the same motion.
  const rollActiveLineToCenter = () => {
    const container = lyricsScrollRef.current;
    if (!container || !currentLineRef.current) return;
    cancelAnimationFrame(rollRafRef.current);
    const from = container.scrollTop;
    const startedAt = performance.now();
    const duration = 650;
    const frame = now => {
      const line = currentLineRef.current;
      if (!line || !lyricsScrollRef.current) return;
      const containerRect = container.getBoundingClientRect();
      const lineRect = line.getBoundingClientRect();
      const lineCenter = lineRect.top - containerRect.top
        + container.scrollTop + lineRect.height / 2;
      const target = Math.max(0, lineCenter - container.clientHeight / 2
        + ACTIVE_LINE_CENTER_OFFSET_PX);
      const progress = Math.min(1, (now - startedAt) / duration);
      // Smoothstep eases both ends of the movement. The previous ease-out
      // curve moved too much in its first few frames and looked like a jump.
      const eased = progress * progress * (3 - 2 * progress);
      container.scrollTop = from + (target - from) * eased;
      if (progress < 1) rollRafRef.current = requestAnimationFrame(frame);
      else centerActiveLine();
    };
    rollRafRef.current = requestAnimationFrame(frame);
  };

  // useLayoutEffect handles initial Shazam/manual matches and every lyric,
  // nudge, or selected-line change before the frame is painted. The playback
  // second dependency also follows the highlighted credit lines appended by
  // main.js, whose effective index changes after the final lyric.
  useLayoutEffect(() => {
    const line = currentLineRef.current;
    const previousLine = centeredLineRef.current;
    const isEnteringFromIntro = lastActiveIndexRef.current < 0 && currentIndex >= 0;
    const isNewVisibleLine = line && previousLine && previousLine.isConnected
      && line !== previousLine;
    centeredLineRef.current = line;
    lastActiveIndexRef.current = currentIndex;
    if (isEnteringFromIntro || isNewVisibleLine) rollActiveLineToCenter();
    else centerActiveLine();
    return () => cancelAnimationFrame(rollRafRef.current);
  }, [currentIndex, mode, lyricsUnsynced, lyrics.length, Math.floor(playbackTime)]);

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
      centerActiveLine();
      if (ts - start < 450) raf = requestAnimationFrame(pin);
    };
    raf = requestAnimationFrame(pin);
    return () => cancelAnimationFrame(raf);
  }, [controlsVisible, isLandscape, mode, lyricsUnsynced]);

  // Re-center when the viewport or lyric box changes without a line change:
  // rotation, split view, browser chrome, font reflow, or device resizing.
  useEffect(() => {
    if (mode !== "syncing" || lyricsUnsynced) return;
    const recenter = () => requestAnimationFrame(centerActiveLine);
    window.addEventListener("resize", recenter);
    window.visualViewport?.addEventListener("resize", recenter);
    const observer = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(recenter)
      : null;
    if (lyricsScrollRef.current) observer?.observe(lyricsScrollRef.current);
    return () => {
      window.removeEventListener("resize", recenter);
      window.visualViewport?.removeEventListener("resize", recenter);
      observer?.disconnect();
    };
  }, [mode, lyricsUnsynced, currentIndex, isLandscape, controlsVisible]);

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
    onSeek?.(targetTime);
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
    rollActiveLineToCenter();
  };

  // Mark the user as manually scrolling and (re)arm a 10s idle timer — once they
  // stop scrolling for 10s we snap back to the current line and resume following.
  const noteUserScroll = () => {
    userScrollingRef.current = true;
    setUserScrolling(true);
    clearTimeout(refollowTimerRef.current);
    refollowTimerRef.current = setTimeout(() => refollow(), 10000);
  };

  return { lyricsUnsynced, lyricsScrollRef, seekToLine, refollow, noteUserScroll };
}
