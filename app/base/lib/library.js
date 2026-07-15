// Pure record-library helpers — no React, no DOM, no platform deps.

// Plain (unsynced) lyrics carry no timestamps — time:null marks them so the
// player renders the flat auto-scroll view instead of pretending to be synced.
export const plainToLines = txt => (txt || "").split("\n").filter(l => l.trim()).map(text => ({ time: null, text }));

const fold = s => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

// Record-shop filing key: MusicBrainz's curated sort name when the catalogue
// has one ("Bowie, David"; "Rolling Stones, The"), else the artist name minus
// a leading "The ".
export const artistSortKey = album =>
  fold(album.artist_sort_name || (album.artist_name || "").trim().replace(/^the\s+/i, ""));

const cmp = (a, b) => (a || "").localeCompare(b || "", undefined, { sensitivity: "base" });

// Order a record library: the (up to 2) most-recently-played albums first, in
// recency order, then everything else filed record-shop style by artist sort
// key (ties broken by full artist name, then album name).
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
      cmp(artistSortKey(a), artistSortKey(b)) ||
      cmp(a.artist_name, b.artist_name) ||
      cmp(a.album_name, b.album_name));
  return [...recent, ...rest];
}
