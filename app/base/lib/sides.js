// Single source of truth for vinyl-side labelling.
//
// Used by:
//   • Manual track picker (Liri component) — side headers when browsing tracks
//   • AlbumDetailSheet — side headers on the library album page
//   • Side-end / flip detection (getSideEndIndicesFromSides, below)
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
export function getSideGroups(tracks, vinylSides, dbTracks) {
  if (!tracks?.length) return [];

  // Resolve a side for every index using the canonical priority.
  const sides = tracks.map((t, i) => getSideForIndex(i, t, vinylSides, dbTracks));

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
    return Object.entries(map)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([side, group]) => ({ side, tracks: group }));
  }

  // Last resort — no side data at all. Split at midpoint into A and B so the
  // UI doesn't render one monster list. This is intentionally only used when
  // BOTH vinyl_sides and dbTracks are empty.
  const mid = Math.ceil(tracks.length / 2);
  return [
    { side: "A", tracks: tracks.slice(0, mid).map((t, i) => ({ track: t, idx: i })) },
    { side: "B", tracks: tracks.slice(mid).map((t, i) => ({ track: t, idx: mid + i })) },
  ].filter(g => g.tracks.length > 0);
}

// Resolve a side letter for EVERY track index, filling the gaps that
// getSideForIndex leaves as null by carrying the nearest known letter forward
// (and backfilling a leading gap from the first known letter).
//
// Gap-filling matters for side-end detection specifically: an unmatched bonus
// track at the tail must not invent a side of its own, and a track the pressing
// spells differently must not split one side into two.
export function resolveSideLetters(tracks, vinylSides, dbTracks) {
  const raw = (tracks || []).map((t, i) => {
    const s = getSideForIndex(i, t, vinylSides, dbTracks);
    return s ? s.toUpperCase() : null;
  });
  let last = null;
  const filled = raw.map(s => (last = s || last));
  // A leading gap has nothing behind it — take the first letter we did resolve.
  const first = filled.find(Boolean) || null;
  return filled.map(s => s || first);
}

// Side-end detection: the track indices that are the LAST track of each side,
// always including the final track (album end). Returns null when no real side
// data exists, so callers can fall back to their own runtime heuristic.
//
// This is the same resolution chain getSideGroups() uses for the track picker
// and the library album page — deliberately so. When flip detection ran on its
// own stricter chain it could disagree with the sides the app was showing:
// side ends whose title didn't match the pressing were silently dropped, so
// Liri played straight through the end of a side instead of prompting a flip.
// A side ends at the LAST index carrying its letter — not at the first letter
// change. Some pressings run their tracks in a different order than the digital
// release we walk (a track sitting at A5 on the record can be track 5 in iTunes
// and track 7 on the sleeve), so letters are not always contiguous. Taking the
// last occurrence means Liri never prompts a flip while tracks belonging to the
// current side are still ahead of it; on the normal contiguous album this is
// exactly the letter-change boundary.
export function getSideEndIndicesFromSides(tracks, vinylSides, dbTracks) {
  if (!tracks?.length) return null;
  if (!hasSideData(vinylSides, dbTracks)) return null;
  const sides = resolveSideLetters(tracks, vinylSides, dbTracks);
  if (!sides.some(Boolean)) return null;
  const lastIndexOfSide = new Map();
  sides.forEach((side, i) => { if (side) lastIndexOfSide.set(side, i); });
  const ends = [...new Set(lastIndexOfSide.values())].sort((a, b) => a - b);
  // The final track always ends a side, whatever the data says.
  if (ends[ends.length - 1] !== tracks.length - 1) ends.push(tracks.length - 1);
  return ends;
}
