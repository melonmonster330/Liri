# Liri Session Summary — v1.28 through v1.31
### March 2026

This document summarizes the work done across the session that took Liri from v1.27 to v1.31.
Use it as the starting context for the next development session.

---

## Where we ended up

**Current version: v1.31** — deployed to Vercel via git push.
**App URL:** getliri.app/app
**Library URL:** getliri.app/library

The big leap this session: Liri now works reliably for obscure and re-recorded tracks
(including Taylor's Version) that ACRCloud simply doesn't fingerprint. It does this by
letting the user pre-select their album, then matching the Whisper transcript against every
track's LRCLib lyrics — no fingerprint database needed.

---

## What was built

### v1.28 — Race condition fix (fewer phantom ACR calls)

Helen was seeing 218+ ACR calls in a day when she hadn't triggered that many sessions.
Root cause: stale session callbacks were resolving after `await sendAudioToACR` and calling
`clearInterval(progressTimerRef.current)`, killing the **new** session's progress timer
instead of the old one's. Fix:
- `clearInterval(progressTimerRef.current)` added at the very top of `startListening`,
  before the mic await — so the old timer is always cleared before a new session starts
- Stale-session guard split so stale callbacks only stop the mic and return; they no longer
  touch `progressTimerRef` at all

### v1.29 — Real-time seconds counter

The subtext during listening changed from "10s of audio captured" (jumped every 5s in
increments matching the recording window) to a live counter: "12s — hold steady".
A new `listenSecs` state + 1-second useEffect interval drives it. The 5-second recording
windows are unchanged — this is purely a UI/feel improvement.

### v1.30 — Personal vinyl library + vinyl-aware matching (Strategy V)

**The core feature of this session.** ACRCloud will never reliably match Taylor's Version
re-recordings (they're absent from fingerprint databases). LRCLib has them. So instead of
fighting fingerprinting, Liri goes around it.

**New Supabase table: `user_vinyl_library`**
Stores the user's personal record collection. Schema:
```sql
CREATE TABLE IF NOT EXISTS user_vinyl_library (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  itunes_collection_id text NOT NULL,
  album_name text NOT NULL,
  artist_name text NOT NULL,
  artwork_url text,
  added_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, itunes_collection_id)
);
-- RLS: users manage own rows only
```
Helen ran this SQL in the Supabase editor and confirmed it works.

**New page: `app/library.html` → getliri.app/library**
- Auth-required
- iTunes API search to add albums to your library
- "Listen →" button saves the album to `localStorage["liri_turntable"]` and navigates to /app
- Remove albums
- Shows play counts via `get_collection_play_counts` RPC

**New home screen UI (app/index.html)**
- "What's on the turntable?" dashed button when no album selected
- Album card (artwork + name + artist) when one is set; tap to change
- Listen button becomes "Find my place" when an album is selected
- Album picker bottom sheet showing the user's library
- Settings: "My Records" link added

**Strategy V — vinyl-aware matching (in `tryLyricsTranscription`)**
Fires before Strategy A/B/C when `turntableTracksRef.current.length > 0`.
Process:
1. Whisper transcribes the audio (same 20s recording already captured)
2. LRCLib lyrics are fetched in parallel for every track on the album
3. Each track is scored by how many transcript words appear in its full lyrics
4. If the best score ≥ 4, that track wins
5. Position is found via window scan (see v1.31 fix below)
6. Sets `mode = "confirmed"` with the correct track, lyrics, and position

Helen tested this and confirmed: **"it got the song!!"** — Taylor's Version identified
correctly when ACRCloud returned 1001 (no match) every attempt.

**vercel.json**: Added `/library` → `/app/library.html` rewrite.

### v1.31 — Position fix + persistent side/track display

**Position fix in `matchTranscriptToTracks`**

The v1.30 position logic was wrong: it found the single lyric line with the most word
overlap and used `line.time - 0.5` as the start position. That placed the user at the
beginning of the 20-second audio clip, not at their current position (the end of it).

New approach — sliding window scan:
- Slide a 20-second window through the LRC lines
- Score each window by how many transcript words appear in the combined text of lines
  within that window
- The window with the best overlap marks where the 20s clip came from
- `startPos = windowEnd + 2` — +2s accounts for processing latency
- This lands the lyrics display on the right line instead of ~20 seconds behind

**`getSideInfo()` — fully rebuilt**

Old version only worked in vinyl auto-mode (`vinylMode === true`), returned only a track
number without side letter if Liri DB had no data.

New version:
- **Removed `vinylMode` gate** — works for turntable mode users too
- **New `deriveSideFromIndex(idx, tracks)` helper** — derives A/B/C side letters from the
  duration heuristic (same logic as `getSideEndIndices`) when Liri DB has no pressing data
- **Turntable mode path** — uses `turntableTracksRef.current` + new `turntableMatchedIdxRef`
  to show side/track immediately after vinyl-aware match, before the async `albumTracks`
  load finishes
- **New `turntableMatchedIdxRef`** — set in Strategy V as soon as a track is matched

**Side/track display — always visible at top of screen**

Helen's request: "I still want it to say side and track number at the top."

- Non-syncing screens (idle, listening): side/track chip added below the LIRI wordmark in
  the top-left corner — always visible as a positional anchor while the record plays
- Syncing screen: side/track chip promoted from a tiny inline element next to the
  "lyrics match" badge to its own dedicated bold line in the song header — larger, golden

---

## State of the app

### What works reliably
- ACRCloud fingerprinting for mainstream/popular tracks
- Vinyl-aware Whisper matching for obscure/re-recorded tracks when album is pre-selected
- Real-time lyric sync with nudge controls (+/- 1, 2, 5s)
- Resync (re-listens to correct drift)
- TV cast via Supabase Realtime
- Personal vinyl library (add/remove albums, "Listen →" to load into turntable mode)
- Side/track position display (both during listening and syncing)
- Song history, usage tracking, Supabase auth

### Known limitations / next things to fix
- **Turntable mode doesn't auto-advance**: After Strategy V identifies a track, Liri shows
  lyrics for it — but when the track ends, it doesn't automatically move to the next track.
  Full vinyl auto-advance mode needs to be armed when a record is picked. (See ROADMAP.md)
- **Side letter heuristic is rough for non-standard pressings**: Albums with 3 or 5 tracks
  per side, or 45s, or box sets, won't split correctly without Liri DB data
- **Library page is minimal**: No track details, no lyrics preview, no featured artist info.
  (See ROADMAP.md for the full record detail page spec)

---

## File map

```
app/
  index.html          — Main Liri app (v1.31). Everything lives here.
  library.html        — Personal vinyl library (/library route)
api/
  recognize.js        — ACRCloud wrapper (serverless, Vercel)
  transcribe.js       — Whisper wrapper (serverless, Vercel)
supabase/
  vinyl_schema.sql    — All Supabase table definitions incl. user_vinyl_library
docs/
  ROADMAP.md          — Big picture + backlog (updated this session)
  ACTION_PLAN.md      — Timeline and Helen's to-do list
  ARCHITECTURE.md     — Technical overview
  SESSION_SUMMARY_v1.28-v1.31.md  — This file
vercel.json           — Routing rules incl. /library → /app/library.html
```

---

## Key implementation details to know going in

**Strategy V lives in `tryLyricsTranscription` (app/index.html ~line 921)**
Fires when `turntableTracksRef.current.length > 0`. After a match it calls
`fetchAlbumTracks` to load the full album (for eventual vinyl auto-advance support).

**`matchTranscriptToTracks` (app/index.html ~line 848)**
The core vinyl-aware matching function. Fetches LRCLib for all tracks in parallel, scores
by word overlap, then finds position via 20-second window scan.

**`getSideInfo()` (app/index.html ~line ~1444)**
Derives side letter + track-on-side. Checks in order:
1. Liri DB pressed data (most accurate)
2. Duration heuristic on `albumTracks` (vinyl auto-mode)
3. Duration heuristic on `turntableTracksRef` (turntable mode)

**`turntableMatchedIdxRef`** — set in Strategy V. Holds the 0-based index of the
last vinyl-matched track within `turntableTracksRef.current`.

**localStorage key**: `liri_turntable` — JSON of the selected album (from library.html).
Cleared when user taps "×" on the album card on the home screen.

---

## What to work on next

Priority 1 (next session): **Unify turntable mode with vinyl auto-advance**
- Picking a record should arm full auto-advance, not just Strategy V for the first track
- After Strategy V matches track N, auto-advance to track N+1 at the right time
- Side flip detection should work (prompt user when Side A ends)

Priority 2: **Record detail page in library**
- Tappable record → full detail view
- Tracklist with side labels, running times, featured artists
- Tap any track → full lyrics (LRCLib plaintext, not synced)

See ROADMAP.md (Backlog section) for the full specs on both.
