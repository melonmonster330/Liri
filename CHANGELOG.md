# Changelog

## Unreleased (pending app push)
- User-contributed metadata (v1.5.6): users can now add missing lyrics and vinyl side info themselves. Sync tab warns "No side info for this record" with an Add sides sheet before syncing; the no-lyrics playback screen gets an Add lyrics sheet (paste plain text or LRC) with links to lyric-site homepages (LRCLIB, Genius, Musixmatch, AZLyrics, Lyrics.com). Library shows per-album "missing side info / N lyrics" badges plus a "Needs info" filter for batch fixing, an Add sides banner on the album page, and add-lyrics in the track lyrics sheet. Writes go straight to track_lyrics / vinyl_sides (RLS already allows auth writes), source: "user".
- Smooth auto-scroll for plain-text-only lyrics (Genius-sourced tracks have no timestamps — current line-by-line highlight is faked at 4s/line). Replace with a continuous scroll over track duration. Touches lyrics rendering in app/src/main.js (~5 sites). Requires APP_VERSION bump + `npm run sync`.

## v1.0.1
- Removed all internal references to "Vinyl Mode" — the app has always been built for vinyl, so the distinction was unnecessary and confusing

## v1.0.0
- Initial launch
