# Liri 💿
### Real-Time Lyric Sync for Vinyl

> Liri listens to your record player, identifies the song, and displays synchronized lyrics — line by line, in real time. Built for vinyl lovers, not streaming.

---

## Repo structure

```
liri/
│
├── index.html                 ← Public landing page (waitlist, features)
├── tv.html                    ← TV cast view — displays lyrics on a big screen
│                                 via Supabase real-time (open on any browser)
│
├── app/
│   ├── index.html             ← The main Liri app (React + Babel, no build step)
│   └── add-vinyl.html         ← Community vinyl contribution form
│                                 (add side/track data for a record)
│
├── api/
│   └── recognize.js           ← Vercel serverless function: ACRCloud proxy
│                                 (keeps API credentials server-side)
│
├── supabase/
│   ├── vinyl_schema.sql       ← Run once: creates vinyl_releases, vinyl_tracks,
│   │                             user_vinyl_collections tables
│   └── analytics_schema.sql   ← Run once: creates listening_events, flip_events
│                                 tables + analytics views + get_user_wrapped()
│
├── docs/
│   ├── ARCHITECTURE.md        ← How the code works and why
│   ├── ROADMAP.md             ← Big picture: TV app, growth, monetization
│   ├── LEGAL.md               ← Licensing notes: lyrics, fingerprinting
│   └── ACTION_PLAN.md         ← Near-term priorities
│
├── resources/
│   └── icon.png               ← App icon (used by Capacitor for iOS build)
│
├── capacitor.config.json      ← Capacitor config for iOS packaging
│   (appId: com.getliri.app, webDir: app/)
│
├── vercel.json                ← Deployment config and URL rewrites
├── package.json               ← Capacitor dependencies + npm scripts
└── .gitignore
```

---

## How to run the app

No build step. No terminal required.

1. Visit `getliri.com/app` (or open `app/index.html` locally via a dev server)
2. Allow microphone access when prompted
3. Put on a record and start playing
4. Tap **Listen**, hold your phone near the speakers
5. Liri identifies the song and syncs lyrics automatically

---

## How it works

| Step | What happens |
|---|---|
| **Listen** | Captures ~8 seconds of audio via device microphone |
| **Detect** | Sends audio to ACRCloud — returns song title, artist, and exact playback offset |
| **Fetch lyrics** | Pulls timestamped LRC lyrics from [lrclib.net](https://lrclib.net) |
| **Sync** | Runs a timer from the detected timecode, advancing through lyrics in real time |
| **Display** | Current lyric highlighted; adjacent lines fade in/out |

Liri also fetches the full album tracklist after the first song is identified, automatically loading the next track's lyrics as each song ends — no re-listening required. Side boundaries are detected using the community vinyl database for precision, or a duration heuristic as fallback.

---

## Services used

| Service | Purpose | Key lives in |
|---|---|---|
| [ACRCloud](https://acrcloud.com) | Audio fingerprinting / song identification | Vercel env vars (`ACR_HOST`, `ACR_ACCESS_KEY`, `ACR_ACCESS_SECRET`) |
| [lrclib.net](https://lrclib.net) | Synced + plain lyrics | No key needed |
| [iTunes Search API](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/) | Album artwork + tracklist | No key needed |
| [Supabase](https://supabase.com) | Auth, usage tracking, song history, cast sessions, vinyl database | Publishable key in app (safe to expose) |

---

## Vercel environment variables

Set these in your Vercel project dashboard under **Settings → Environment Variables**:

```
ACR_HOST          your-cluster.acrcloud.com
ACR_ACCESS_KEY    your_access_key
ACR_ACCESS_SECRET your_access_secret
```

---

## The Liri Vinyl Database

The community-powered side/track database lives in Supabase. To set it up:

1. Open your Supabase project → SQL Editor
2. Paste `supabase/vinyl_schema.sql` and run it — creates `vinyl_releases`, `vinyl_tracks`, `user_vinyl_collections`
3. Paste `supabase/analytics_schema.sql` and run it — creates `listening_events`, `flip_events`, analytics views, and the `get_user_wrapped()` function

Users can contribute records at `/add-vinyl`. Submissions are public and improve flip
detection for everyone who plays that album.

### Analytics (internal dashboard)

Query these views directly in the Supabase SQL Editor:

| View | What it shows |
|---|---|
| `v_dau_30d` | Daily active users, last 30 days |
| `v_top_tracks_30d` | Top 20 tracks by play count |
| `v_top_artists_30d` | Top 20 artists |
| `v_top_albums_30d` | Top 20 albums |
| `v_flip_methods` | Flip detection method breakdown |
| `v_geo_30d` | Listen counts by country |

User Wrapped stats: `SELECT get_user_wrapped('<user_id>', 2025);`

---

## iOS (Capacitor)

The app is packaged for iOS using Capacitor. The `ios/` folder is gitignored — generate it with:

```bash
npm install
npx cap add ios     # first time only
npx cap sync        # after changes to app/
npx cap open ios    # open in Xcode
```

The app ID is `com.getliri.app`. The web root is the `app/` folder.

---

## TV cast

Desktop Chrome can launch Liri's custom Google Cast receiver and send the
current song, artwork, lyrics, playback position, pauses, nudges, and track
changes directly to a Chromecast or Google TV. See `docs/CASTING.md` for setup
and physical-device testing. Samsung TVs can open `/tv` in their built-in
browser and pair to web Liri with the four-digit code shown on screen.

---

## Current version: v0.6

See `docs/ROADMAP.md` for what's next.

---

## Backlog

- **Persistent sync across navigation** — lyrics should keep following the song even if the user taps away to add-vinyl or another page and then comes back. Likely implemented with a service worker or shared React context that survives navigation.
- **Fix onboarding flag** — `showOnboarding` is `useState(true)` (forced for testing). Before launch, switch to `useState(() => !localStorage.getItem("liri_onboarding_done"))`.
- **Lyrics provider** — consider switching from LRCLib to Musixmatch before monetization for better coverage and licensing.
