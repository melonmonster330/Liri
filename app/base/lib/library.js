// Pure record-library helpers — no React, no DOM, no platform deps.

// Plain (unsynced) lyrics carry no timestamps — time:null marks them so the
// player renders the flat auto-scroll view instead of pretending to be synced.
export const plainToLines = txt => (txt || "").split("\n").filter(l => l.trim()).map(text => ({ time: null, text }));

// Order a record library: the (up to 2) most-recently-played albums first, in
// recency order, then everything else alphabetically by album name.
export function orderLibrary(lib, recentIds) {
  const seen = new Set();
  const recent = [];
  for (const id of (recentIds || [])) {
    const a = (lib || []).find(x => String(x.itunes_collection_id) === String(id));
    if (a && !seen.has(String(id))) { recent.push(a); seen.add(String(id)); }
  }
  const rest = (lib || [])
    .filter(x => !seen.has(String(x.itunes_collection_id)))
    .sort((a, b) => (a.album_name || "").localeCompare(b.album_name || "", undefined, { sensitivity: "base" }));
  return [...recent, ...rest];
}
