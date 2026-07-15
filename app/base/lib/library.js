// Pure record-library helpers — no React, no DOM, no platform deps.

// Plain (unsynced) lyrics carry no timestamps — time:null marks them so the
// player renders the flat auto-scroll view instead of pretending to be synced.
export const plainToLines = txt => (txt || "").split("\n").filter(l => l.trim()).map(text => ({ time: null, text }));

// Record-shop filing key: the artist's last name — last word of the artist
// name after dropping a leading "The " ("David Bowie" → "Bowie",
// "The Rolling Stones" → "Stones").
export const artistLastName = name =>
  (name || "").trim().replace(/^the\s+/i, "").split(/\s+/).pop() || "";

const cmp = (a, b) => (a || "").localeCompare(b || "", undefined, { sensitivity: "base" });

// Order a record library: the (up to 2) most-recently-played albums first, in
// recency order, then everything else by artist last name (ties broken by
// full artist name, then album name).
export function orderLibrary(lib, recentIds) {
  const seen = new Set();
  const recent = [];
  for (const id of (recentIds || [])) {
    const a = (lib || []).find(x => String(x.itunes_collection_id) === String(id));
    if (a && !seen.has(String(id))) { recent.push(a); seen.add(String(id)); }
  }
  const rest = (lib || [])
    .filter(x => !seen.has(String(x.itunes_collection_id)))
    .sort((a, b) =>
      cmp(artistLastName(a.artist_name), artistLastName(b.artist_name)) ||
      cmp(a.artist_name, b.artist_name) ||
      cmp(a.album_name, b.album_name));
  return [...recent, ...rest];
}
