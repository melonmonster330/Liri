// User-contributed metadata — lyrics + vinyl side info.
//
// RLS on track_lyrics and vinyl_sides already grants any authenticated user
// insert/update (see supabase/migrations/20260513_rls_for_newer_tables.sql),
// so these write straight from the client with the normal supabase client.
// No API endpoint involved.
//
// Used by:
//   • Sync tab (main.js) — "Add side info" warning pre-sync, "Add lyrics"
//     on the no-lyrics playback screen
//   • library.html duplicates the tiny save helpers inline (tab pages are
//     self-contained babel scripts and can't import ESM) — if you change
//     the write shape here, mirror it there.

// Homepage links only — never deep links to a specific song's lyrics page.
// The user searches the site themselves and pastes what they find.
export const LYRIC_SITES = [
  { name: "LRCLIB",     url: "https://lrclib.net" },
  { name: "Genius",     url: "https://genius.com" },
  { name: "Musixmatch", url: "https://www.musixmatch.com" },
  { name: "AZLyrics",   url: "https://www.azlyrics.com" },
  { name: "Lyrics.com", url: "https://www.lyrics.com" },
];

// True when the pasted text is LRC (synced) rather than plain lyrics:
// at least two lines starting with a [mm:ss] timestamp.
export function looksLikeLRC(text) {
  const stamped = (text || "").split("\n").filter(l => /^\s*\[\d{1,2}:\d{2}/.test(l));
  return stamped.length >= 2;
}

// Strip LRC timestamps to get a plain-text rendition (stored alongside the
// raw LRC so the plain-lyrics fallback chain keeps working).
export function lrcToPlain(text) {
  return (text || "")
    .split("\n")
    .map(l => l.replace(/\[[^\]]*\]/g, "").trim())
    .filter(Boolean)
    .join("\n");
}

// Upsert user-pasted lyrics for one track. Returns the cache-shaped entry
// ({ lrc_raw, words_json, lyrics_plain }) or throws on DB error.
// words_json stays null — the app derives words from lrc_raw / lyrics_plain
// at listen time (see the fallback chain in startListeningSpeech).
export async function saveUserLyrics(sb, trackId, text) {
  const trimmed = (text || "").trim();
  if (!trackId || !trimmed) throw new Error("Nothing to save");
  const isLrc = looksLikeLRC(trimmed);
  const row = {
    itunes_track_id: trackId,
    lrc_raw:      isLrc ? trimmed : null,
    lyrics_plain: isLrc ? lrcToPlain(trimmed) : trimmed,
    words_json:   null,
    source:       "user",
    fetched_at:   new Date().toISOString(),
  };
  const { error } = await sb.from("track_lyrics").upsert(row, { onConflict: "itunes_track_id" });
  if (error) throw error;
  return { lrc_raw: row.lrc_raw, words_json: null, lyrics_plain: row.lyrics_plain, source: row.source };
}

// Explicitly record that a track has no sung/spoken lyrics. A real cache row
// prevents background gap-fill from repeatedly treating it as missing.
export async function saveUserInstrumental(sb, trackId) {
  if (!trackId) throw new Error("Track ID is required");
  const row = {
    itunes_track_id: trackId,
    lrc_raw: null,
    lyrics_plain: null,
    words_json: [],
    source: "instrumental",
    fetched_at: new Date().toISOString(),
  };
  const { error } = await sb.from("track_lyrics").upsert(row, { onConflict: "itunes_track_id" });
  if (error) throw error;
  return { lrc_raw: null, words_json: [], lyrics_plain: null, source: row.source };
}

// Turn "which tracks start a new side" into per-track side letters.
// breaks = Set of track indexes that begin a new side (index 0 is always
// side A whether or not it's in the set). Monotonic by construction, so the
// positional vinyl_sides matching (sorted A1…B1…) can never scramble.
export function breaksToLetters(trackCount, breaks) {
  const letters = [];
  let sideIdx = 0;
  for (let i = 0; i < trackCount; i++) {
    if (i > 0 && breaks.has(i)) sideIdx++;
    letters.push(String.fromCharCode(65 + sideIdx)); // A, B, C…
  }
  return letters;
}

// Build the vinyl_sides rows for a whole album from per-track side letters.
// tracks: [{ trackId }] in album order. Skips tracks without an ID.
export function buildSideRows(collectionId, tracks, letters) {
  const perSideCount = {};
  const now = new Date().toISOString();
  return tracks.map((t, i) => {
    const side = letters[i];
    perSideCount[side] = (perSideCount[side] || 0) + 1;
    if (!t.trackId) return null;
    return {
      itunes_collection_id: collectionId,
      itunes_track_id: t.trackId,
      side,
      side_track_number: perSideCount[side],
      position: side + perSideCount[side],
      fetched_at: now,
    };
  }).filter(Boolean);
}

// Upsert side rows for an album. Returns the rows in vinylSidesRef shape
// ({ side, side_track_number, position }, track order == A1…B1… order).
export async function saveUserSides(sb, rows) {
  if (!rows.length) throw new Error("Nothing to save");
  const { error } = await sb.from("vinyl_sides").upsert(rows, { onConflict: "itunes_track_id" });
  if (error) throw error;
  return rows.map(r => ({ side: r.side, side_track_number: r.side_track_number, position: r.position }));
}
