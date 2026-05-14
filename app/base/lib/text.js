// Pure text/time helpers — no React, no DOM, no platform deps.
// Safe to use anywhere (web, iOS, eventually tests).

// Parse an LRC-format lyric file ("[mm:ss.xxx]text") into a sorted
// array of { time, text } entries. Lines without a timestamp are skipped.
export function parseLRC(lrc) {
  const re = /\[(\d{2}):(\d{2})[.:](\d{2,3})\](.*)/;
  return lrc.split("\n").reduce((acc, line) => {
    const m = line.match(re);
    if (!m) return acc;
    const t = parseInt(m[1]) * 60 + parseInt(m[2]) + parseInt(m[3].padEnd(3, "0").slice(0, 3)) / 1000;
    const text = m[4].trim();
    if (text) acc.push({ time: t, text });
    return acc;
  }, []).sort((a, b) => a.time - b.time);
}

// Format seconds as "m:ss" (e.g. 125 → "2:05").
export function formatTime(s) {
  return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
}

// Normalise text for loose comparison: lowercase + strip all non-alphanumeric.
// Used so Shazam matches survive curly vs straight quotes, "(Remastered)"
// suffixes, dashes, etc. when comparing track titles against library tracks.
//   normText("Don't Blame Me") === normText("Don’t Blame Me")  // true
export function normText(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Format an ISO timestamp as a short relative string ("just now", "5m ago").
export function timeAgo(iso) {
  const diff = (Date.now() - new Date(iso)) / 1000;
  if (diff < 60)    return "just now";
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
