# Liri 🎵
### Real-Time Lyric Sync for Vinyl

> Liri listens to your record player, identifies the song, and displays synchronized lyrics as the music plays — so you can stay in the moment instead of searching.

---

## What's in this folder

```
liri/
├── index.html          ← The working app. Open this in any browser.
├── liri.jsx            ← Same app as React JSX (for Claude/dev previews)
├── README.md           ← This file
└── docs/
    ├── ROADMAP.md      ← Big picture: Samsung TV, marketing, growth
    ├── LEGAL.md        ← Licensing research: lyrics, fingerprinting, display rights
    └── ARCHITECTURE.md ← How the code works and why decisions were made
```

---

## How to run it

1. Open `index.html` in Chrome, Safari, or Firefox
2. Allow microphone access when the browser asks
3. Put on a Taylor Swift record
4. Tap **Listen**, hold your device near the speakers
5. Liri identifies the song and syncs the lyrics automatically

No installation. No terminal. No build step.

---

## How it works (short version)

1. **Record** — captures 8 seconds of audio via device microphone
2. **Detect** — sends audio to [AudD](https://audd.io) which returns the song title + timecode (where in the song the record was playing)
3. **Fetch** — pulls timestamped lyrics from [lrclib.net](https://lrclib.net)
4. **Sync** — runs a timer from the detected timecode, advancing through lyrics in real time
5. **Display** — current lyric line is highlighted; adjacent lines fade in and out

---

## If lyrics are running ahead or behind

Use the **← 2s / ← 5s / 2s → / 5s →** buttons at the bottom of the sync screen to nudge the timing. This compensates for turntable speed variation or a needle that landed a beat off.

---

## API keys

| Service | Free tier | Where to get a key |
|---|---|---|
| AudD | ~10 recognitions/day | [audd.io](https://audd.io) |
| lrclib.net | Unlimited, no key needed | — |

Add your AudD key in the ⚙ settings panel for unlimited recognitions.

---

## Current version

**v0.1 — Taylor Swift Edition**
- All Taylor Swift eras (including TV re-records + vault tracks)
- Mic-based song detection via AudD
- Synced lyrics from lrclib.net
- Drift correction via nudge buttons
- Album art background

---

## What's next

See `docs/ROADMAP.md` for the full plan.
