# Liri — Architecture & Code Decisions

> For anyone (including future me with a fresh Claude conversation) picking this up and wanting to understand how it works before changing anything.

---

## The core problem

A normal lyrics app knows exactly what song is playing and exactly what second it's at. It gets this from a streaming service's playback API.

Liri has neither of those things. It works with a turntable. That means:
- No digital timestamp from the source
- No guarantee the needle landed at the start of the song
- Possible speed variation (belt-drive turntables drift)
- Possible skips, pauses, side flips

So Liri has to figure out: *what song*, *where in the song*, and *keep tracking* — all from audio alone.

---

## The solution (current v0.1 approach)

**Identify once, time from there.**

1. Capture ~8 seconds of audio
2. Send to AudD → get back: song identity + timecode (where in the song the sample was from)
3. Note the exact clock time when the response came back
4. When the user starts sync, calculate: `startPosition = detectedTimecode + timeSinceDetection`
5. Run a simple timer from there, advancing through pre-timed lyrics

This works well when:
- The record plays at consistent speed
- The detection is accurate
- The user doesn't pause or skip

The nudge buttons handle the "it drifted a bit" case. The "Try Again" button handles the rest.

---

## File structure (current)

```
index.html      ← Single-file app, everything included
liri.jsx        ← Same logic as React JSX for Claude/dev previews
```

Everything lives in one file right now. That's intentional for v0.1 — easier to share, open, and understand. When the project grows, it'll split into:

```
src/
├── App.jsx
├── components/
│   ├── WaveAnimation.jsx
│   ├── VinylSpinner.jsx
│   └── LyricDisplay.jsx
├── hooks/
│   ├── useAudioCapture.js
│   ├── useSongDetection.js
│   └── useLyricSync.js
└── utils/
    ├── parseLRC.js
    └── formatTime.js
```

---

## The LRC format

LRC is the text format used for timestamped lyrics. It looks like this:

```
[00:14.23]It's me, hi, I'm the problem, it's me
[00:18.47]At tea time, everybody agrees
[00:22.11]I'll stare directly at the sun but never in the mirror
```

Each line has: `[MM:SS.ms]lyric text`

The `parseLRC()` function in the code converts this into an array of objects:
```javascript
[
  { time: 14.23, text: "It's me, hi, I'm the problem, it's me" },
  { time: 18.47, text: "At tea time, everybody agrees" },
  ...
]
```

Timestamps in seconds (fractional) make it easy to compare against the running timer.

---

## The sync engine

This is the most important part of the code. Here's the logic:

```javascript
// When the user taps "Start Lyrics":
const delay = (Date.now() - detectedAt) / 1000; // seconds since detection
const startPosition = detectedTimecode + delay;   // current song position
const syncStartedAt = Date.now();                  // wall clock reference

// Every 80ms:
const elapsed = (Date.now() - syncStartedAt) / 1000;
const currentPosition = startPosition + elapsed;

// Find which lyric line matches currentPosition:
// Walk through lyrics array, return the last line whose timestamp <= currentPosition
```

The `detectedAt` + `delay` trick is subtle but important. AudD tells us "at 2:34 in the song." But by the time the user sees the confirmation screen and taps "Start Lyrics," another 5–10 seconds have passed. Without the delay correction, lyrics would start 5–10 seconds behind.

---

## The nudge system

If the turntable runs fast, lyrics will fall behind the record. The nudge adjusts `startPosition`:

```javascript
// "lyrics behind" → move startPosition forward
nudge(+5)  // adds 5 to startPosition → lyrics jump forward 5 seconds

// "lyrics ahead" → move startPosition backward
nudge(-5)  // subtracts 5 from startPosition → lyrics jump back 5 seconds
```

The UI labels "← 5s" and "5s →" are confusing about which direction moves where. This is a known UX debt for v1.1.

---

## External APIs

### AudD (song detection)
- **Endpoint**: `POST https://api.audd.io/`
- **Input**: audio file as FormData (`file`), `return` parameter requesting `timecode,spotify,apple_music`
- **Output**: `{ status, result: { title, artist, album, timecode, spotify, apple_music } }`
- **The timecode field**: e.g. `"2:34"` — this is how Liri knows where to start
- **Rate limits**: ~10/day free, paid tiers for more
- **CORS**: Yes, browser calls work directly

### lrclib.net (synced lyrics)
- **Search endpoint**: `GET https://lrclib.net/api/search?artist_name=X&track_name=Y`
- **Output**: array of results, each with `syncedLyrics` (LRC format string) or `plainLyrics`
- **CORS**: Yes, browser calls work directly
- **Rate limits**: None documented; community-maintained, be reasonable
- **Coverage**: Very good for popular music. All Taylor Swift including TV re-records and vault tracks.

---

## State machine

The app has 6 states:

```
idle
 └─[tap Listen]──────────────→ listening
                                 └─[8s complete]────→ detecting
                                                        ├─[success]───→ confirmed
                                                        │                └─[tap Start]──→ syncing
                                                        │                └─[tap Stop]───→ idle
                                                        └─[failure]───→ error
                                                                          └─[tap Try Again]→ idle
```

State is stored in React `useState`. Transitions happen in the async functions (`startListening`, `detectSong`, `startSync`, `reset`).

---

## Known limitations (v0.1)

**Detection accuracy**: AudD is very good but not perfect. Quiet passages, noisy rooms, and unusual pressings can fool it. The "Try Again" path handles this.

**Drift over time**: The timer is purely clock-based. Over a 4-minute song, even a 1% turntable speed variation = 2.4 seconds of drift. The nudge buttons cover this, but future versions should do periodic re-detection to correct automatically.

**Side flips**: When the user flips to Side B, they need to tap Listen again. There's no automatic side change detection in v0.1.

**No persistence**: Closing the browser tab loses all state. If you want to pick up where you left off, you have to detect again.

**Single device only**: No sync between devices. Phone and TV can't be linked yet.

---

## The roadmap for technical improvements

**v0.2 target**
- Periodic re-detection every 30 seconds to auto-correct drift
- Album/track progression awareness (prompt for next track after silence)

**v0.3 target**
- WebSocket server for phone → TV companion sync
- Local caching of common Taylor Swift lyric files (offline support)

**v1.0 target**
- React Native mobile app (reuse this logic layer)
- MusixMatch API integration (properly licensed lyrics)
- User account + usage tracking for freemium model

---

## Tech stack decisions and why

**Why single HTML file?**
No build step. Liri is open-able without npm, Node, Vite, or any toolchain. Important for a project that might sit in a folder for months between sessions.

**Why React (CDN) vs vanilla JS?**
State management in vanilla JS for this many UI states gets messy fast. React via CDN gives the component model without the build step.

**Why AudD over Shazam?**
Shazam has no official public API. AudD is explicitly built for developers, has good docs, and returns the timecode field which is critical for Liri's use case.

**Why lrclib.net over MusixMatch?**
lrclib is free with no authentication, CORS-enabled, and has LRC timestamped lyrics (MusixMatch free tier returns plain lyrics without word-level sync). For a prototype, it's perfect. Commercial version will need MusixMatch or LyricFind.

**Why Georgia/serif font?**
The aesthetic is warm, literary, vinyl-compatible. Sans-serif fonts feel too digital. Lyrics read better with a serif face at large sizes.
