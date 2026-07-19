// Single source of truth for vinyl-side labelling.
//
// Used by:
//   • Manual track picker (Liri component) — side headers when browsing tracks
//   • AlbumDetailSheet — side headers on the library album page
//   • Side-end / flip detection (via getSideEndsFromSidesMap, defined separately)
//
// Source priority (top-down — pick the first that yields a side for each track):
//   1. vinylSides[i]?.side
//        Positionally-indexed array from public.vinyl_sides (curated DB data
//        loaded at album-select time). This is the canonical source.
//   2. dbTracks[i]?.side, then title-matched dbTracks via normText
//        Discogs/MusicBrainz fallback (public.vinyl_releases.vinyl_tracks).
//        Used when vinyl_sides is empty for this collection_id.
//   3. "A" / midpoint split
//        Last-resort when neither source has anything.
//
// Why partial vinyl_sides data still wins:
//   Previous code required vinylSides.length >= tracks.length, so a 14-row
//   vinyl_sides hit for a 15-track album was discarded entirely and the UI
//   fell back to Discogs title-matching — which often has only 2 sides where
//   the real pressing has 4 (Reputation, etc.). Now: if even one row of
//   vinyl_sides exists, use it for the tracks it covers; per-track fallback
//   only fires for the uncovered indices.

import { normText } from "./text.js";

// Returns true when at least one real source has side data for this album.
// When this returns false, getSideGroups() is using the last-resort A/B split.
export function hasSideData(vinylSides, dbTracks) {
  return !!(vinylSides?.length || dbTracks?.length);
}

// Returns the side letter for a single track index, walking the priority chain.
export function getSideForIndex(idx, track, vinylSides, dbTracks) {
  // 1. vinyl_sides (positional)
  const v = vinylSides?.[idx];
  if (v?.side) return v.side;

  // 2. dbTracks — try title-match, then positional
  if (dbTracks?.length) {
    const titleNorm = normText(track?.trackName);
    if (titleNorm) {
      const titled = dbTracks.find(d => d.title && normText(d.title) === titleNorm);
      if (titled?.side) return titled.side;
    }
    const dbAt = dbTracks[idx];
    if (dbAt?.side) return dbAt.side;
  }

  // 3. No fallback here — caller decides what "unknown" means.
  return null;
}

// Group tracks into sides. Returns [{ side, tracks: [{ track, idx }, …] }, …]
// sorted alphabetically by side.
//
// `tracks` is the iTunes/library track list (turntableTracksRef.current).
// `vinylSides` is vinylSidesRef.current.
// `dbTracks` is vinylDbRelease?.vinyl_tracks (the Discogs fallback).
// `reverse` (optional): reverse the returned group ORDER only — last side first,
//   tracks within each side untouched. Display concern only; used by the
//   "play backwards" mode so the picker matches the reversed playback order.
export function getSideGroups(tracks, vinylSides, dbTracks, reverse = false) {
  if (!tracks?.length) return [];

  // Resolve a side for every index using the canonical priority.
  const sides = tracks.map((t, i) => getSideForIndex(i, t, vinylSides, dbTracks));

  const finish = groups => (reverse ? [...groups].reverse() : groups);

  // If we got real data for at least one track, group accordingly. Tracks
  // without a side fall into "?" so they're still visible.
  const haveAnyReal = sides.some(s => !!s);
  if (haveAnyReal) {
    const map = {};
    tracks.forEach((t, i) => {
      const s = sides[i] || "?";
      if (!map[s]) map[s] = [];
      map[s].push({ track: t, idx: i });
    });
    return finish(Object.entries(map)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([side, group]) => ({ side, tracks: group })));
  }

  // Last resort — no side data at all. Split at midpoint into A and B so the
  // UI doesn't render one monster list. This is intentionally only used when
  // BOTH vinyl_sides and dbTracks are empty.
  const mid = Math.ceil(tracks.length / 2);
  return finish([
    { side: "A", tracks: tracks.slice(0, mid).map((t, i) => ({ track: t, idx: i })) },
    { side: "B", tracks: tracks.slice(mid).map((t, i) => ({ track: t, idx: mid + i })) },
  ].filter(g => g.tracks.length > 0));
}

// Build a reverse-SIDE-ORDER permutation of track indices: last side first,
// each side's tracks kept in forward order (you flip the record to the final
// side and drop the needle at its first track). Returns:
//   { order, sides }
//     order[k]  — original track index that plays in effective position k
//     sides[k]  — side letter for effective position k
// Reuses getSideGroups so every side-data source (vinyl_sides / Discogs /
// A-B fallback) is resolved the same way the picker resolves it.
export function getReverseSideOrder(tracks, vinylSides, dbTracks) {
  const groups = getSideGroups(tracks, vinylSides, dbTracks, /* reverse */ true);
  const order = [];
  const sides = [];
  for (const g of groups) {
    for (const { idx } of g.tracks) {
      order.push(idx);
      sides.push(g.side);
    }
  }
  return { order, sides };
}
