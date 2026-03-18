# Liri — Big Picture Roadmap

> This is a living document. It covers where the project is going, not just what the next feature is.

---

## Where we are now (v1.32 — March 2026)

A working iOS app (via Capacitor) + web app at getliri.app that:
- Listens to vinyl via microphone (iOS native audio, Web Audio API fallback)
- Multi-strategy identification: ACRCloud fingerprint → Whisper transcription → GPT-4o-mini song ID
- Fetches timestamped LRC lyrics from LRCLib, syncs in real time with drift correction
- Vinyl mode: picks the right track from a user's library without re-listening, auto-advances through tracks
- Personal library ("My Records"): tap an album to see full tracklist with side labels, tap a track to read lyrics
- TV Cast: broadcasts current lyric to tv.html via Supabase Realtime (Cast SDK or room code)
- Vinyl side data: Discogs-backed with full format support (A1/B1, sequential, numbered sides)
- Lyric cache: shared global cache — one match benefits all users

**Platform**: iOS App Store (pending review), web
**Scope**: All artists (any song LRCLib has)

---

## Phase 1 — Polish the web app (current)

These are the things to do before expanding platforms. Get this right first.

**Code & quality**
- Add usage tracking (localStorage) for future freemium enforcement
- Better error recovery — if sync drifts badly, offer a "re-detect" button
- Handle the flip: when side A ends and user flips to side B, Liri should reset gracefully
- Improve the "no lyrics found" experience — show at least the song info and a manual timestamp

**Experience**
- Relabel nudge buttons to "lyrics ahead" / "lyrics behind" (more intuitive than ← 5s)
- Add a subtle "confidence" indicator — was the detection confident or uncertain?
- Album mode: once a song ends, automatically prompt "listening for next track?"

**Expand catalog**
- Liri works on any song lrclib.net has — but the branding is Taylor Swift only for now
- Consider: "All Artists Edition" toggle once the core experience is solid

---

## Phase 2 — Samsung Smart TV App

This is the big one. A vinyl setup next to a TV showing lyrics on a 55-inch screen is the dream product experience.

### The honest challenge
Most Samsung TVs don't have microphones. So Liri can't listen from the TV itself.

### The smarter solution: Companion Model

Instead of making the TV "listen," split the job:

```
PHONE/TABLET                    SAMSUNG TV
────────────────                ────────────────────────
[Liri Mobile]       ──LAN──→   [Liri TV Display]
• Records mic                   • Full-screen lyrics
• Detects song                  • Album art backdrop
• Fetches lyrics                • Beautiful ambient mode
• Sends to TV                   • Remote control navigation
• Acts as remote
```

The phone is the brain. The TV is the screen. They talk over your home Wi-Fi.

This is actually MORE compelling than a standalone TV app because the phone UX is already built.

### How to build this (Samsung Tizen)

**What Samsung TV apps are made of:**
Samsung Smart TVs run Tizen OS. Apps are built as packaged web apps — HTML, CSS, and JavaScript — which means the Liri codebase is already most of the way there.

**Steps to get a Samsung TV app:**
1. Create a Samsung Developer account at developer.samsung.com (free)
2. Download Tizen Studio IDE (free)
3. Package Liri's HTML/JS as a Tizen Web App with a `config.xml` manifest
4. Add D-pad/remote control navigation (TV has no touchscreen)
5. Build the TV display view (full-screen, big text, remote-navigable)
6. Build the local WebSocket sync layer (phone → TV communication)
7. Test on a physical TV in Developer Mode (no fee to sideload)
8. Submit to Samsung Smart Hub marketplace (~$99/year developer fee)

**The TV display view needs:**
- Text large enough to read from a couch (minimum ~36px, ideally ~48–60px)
- D-pad navigation for settings/controls
- A "pairing" screen where phone and TV connect (simple QR code or same-network auto-discovery)
- Ambient/standby mode between songs (album art, soft visuals)

**Timeline estimate:** 4–8 weeks of focused development for a working prototype.

### TV-specific design considerations
- No touch. Everything via remote (D-pad + select button)
- Viewing distance is 8–12 feet, not 12 inches. Typography and contrast matter more
- The TV can show MORE lyric context (previous + next 3–4 lines vs. 2 on mobile)
- "Art mode" — when no song is playing, show album art or a vinyl-aesthetic idle screen

---

## Phase 3 — Mobile App (iOS + Android)

The web app already works great in a mobile browser. A native app adds:
- Home screen icon (no browser chrome)
- Background audio processing (mic works even with screen off)
- Push notifications for "Liri is ready" prompts
- Better offline fallback

**Recommended approach:** React Native
- Most of the React logic from Liri can be reused
- Native modules for audio capture replace Web Audio API
- Single codebase for iOS + Android

**App store considerations:**
- Apple App Store: ~$99/year developer fee
- Google Play: ~$25 one-time fee
- Both have review processes (1–7 days typical)
- Samsung Galaxy Store: separate submission, but good reach for TV companion

---

## Phase 4 — Monetization

### Option A: Freemium (recommended)

**Free tier:**
- First 10 song recognitions per month
- All features available
- No ads

**Premium ($2.99/month or $14.99/year):**
- Unlimited recognitions
- Offline lyric caching for favorite albums
- TV companion feature
- Future: annotation mode, export, themes

**Why this model works for Liri:**
- 10 songs/month is a full listening session — generous enough that casual users are happy
- Power users (the core audience) will hit the limit and convert
- No ads keeps the aesthetic clean and the experience uninterrupted
- Low price point makes the upgrade feel easy

**Implementation:**
- Track usage in localStorage (web) or device storage (native)
- Use Stripe for payment processing (stripe.com — straightforward integration)
- Email/account system needed eventually (use Auth0 or Supabase to avoid building this from scratch)

### Option B: Free with Ads

Not recommended for Liri. Here's why:
- The core audience values the aesthetic deeply — ads feel invasive
- Mobile/TV ad networks are usually ugly and hard to control
- The revenue per user is much lower than a subscription
- It's harder to remove once in place

### Option C: One-Time Purchase ($9.99)

Simpler than subscription. Works well for a "pay once, own it" positioning that fits the vinyl audience. Harder to sustain long-term though if API costs grow.

### Revenue cost structure to plan around

| Cost | Monthly (100 active users) | Notes |
|---|---|---|
| AudD API | ~$10–50 | Depends on tier; renegotiate with volume |
| lrclib.net | $0 | Free/community |
| Hosting (if backend added) | ~$5–20 | Vercel/Railway free tiers work early on |
| Stripe fees | ~3% of revenue | Standard |
| Samsung dev account | ~$8/mo amortized | $99/year |

At 100 paying users at $2.99/mo = ~$299/mo revenue. Not life-changing but real, and scales cleanly.

---

## Phase 5 — Expand Beyond Taylor Swift

Once the experience is solid and the legal situation is sorted, expand the catalog:
- Announce "All Artists Edition" as a separate marketing beat
- Prioritize: Fleetwood Mac, The Beatles, Radiohead, Beyoncé, Harry Styles, Phoebe Bridgers, The 1975
- Partner with vinyl stores and turntable brands for distribution

---

## Phase 6 — Features That Come Later

These are the good ideas from the original project doc that shouldn't distract from the core right now.

**Album mode**: Detects track progression automatically as the record plays through. Side A, then B. Prompts user when it hears silence (side end).

**Annotation mode**: Tap any lyric line to save a note. "This line always gets me." Build a personal lyric journal.

**Art mode**: Visualize the current lyric as a moving graphic — like a live lyric card. Could also connect to Philips Hue or other smart lighting.

**Liner notes mode**: Between tracks, show credits, musician info, album context. Pair with Discogs or MusicBrainz data.

**Collectibles / sharing**: Export a beautiful "lyric card" from the current moment in a song. Shareable image with the lyric, album art, and Liri branding. Built-in virality.

**Listening party mode**: Multiple people synced to the same session. See what your friend is reacting to in real time.

---

## Backlog — Ideas from active development (v1.30–v1.31 era)

These came up during the turntable / vinyl-aware matching phase. Not yet prioritized but clearly the right direction.

### Turntable mode → vinyl auto-advance (next logical step after v1.31)

Right now, picking a record on the "What's on the turntable?" screen enables vinyl-aware matching (Strategy V) but doesn't automatically enable full vinyl auto-advance mode. The two modes should be unified:

- When a user picks an album from their library and taps "Find my place," Liri should also arm vinyl auto-advance, so after the first track is identified, it knows what comes next and can transition to track 2, 3, etc. without re-listening
- The distinction between "turntable mode" and "vinyl mode" should disappear — picking a record IS entering vinyl mode
- Auto-advance should flip sides correctly (prompt when Side A ends, continue on Side B)
- This is the natural evolution: you put a record on, tell Liri what it is, and Liri follows along for the whole side without you touching it again

### Record detail page (in My Records / library)

Each record in the library should be tappable and open a full detail view showing:

- Full tracklist with side labels (Side A: track 1, 2, 3... Side B: track 1, 2, 3...)
- Each track's running time (from iTunes data, already loaded)
- Any featured artist info (e.g. "feat. Bon Iver") where available
- A tap-through on each track to view its full lyrics (fetched from LRCLib, displayed as plain text — useful for reading before listening, not just during)
- Maybe: total album running time, release year, label

This makes the library feel like a real vinyl companion app, not just a "pick your album before listening" widget.

---

---

## Backlog — Ideas from active development (v1.32+ era)

These are things that came up during the v1.32 cycle. All of them are clearly the right direction.

### Code cleanup (see docs/CODE_REVIEW.md for full notes)

The codebase is functional but not yet "proud of it" quality. Before expanding features significantly, a cleanup pass covering:
- Extract shared CSS design tokens (`shared.css` with colors, buttons, inputs)
- Reconcile `getSideInfo()` / `deriveSideFromIndex()` — two versions have drifted
- Add an error UI component (toast/snackbar) — currently all errors are silent
- Proxy LRCLib through Vercel (currently called directly from browser)
- Fix `vinyl.html` innerHTML escaping audit (XSS risk)
- Sync `ios/App/App/public/` properly — always out of date with `app/`

### Library — per-album "Refresh vinyl data" button

Currently stale vinyl data (wrong sides) is auto-detected only if there are duplicate positions. Any album where data exists but is incomplete (missing a side, wrong order) won't auto-fix. A "Refresh" button in `AlbumDetailSheet` that force-deletes and re-fetches from Discogs would let users fix edge cases themselves without waiting for a code change.

### Library — cache tracklist per session

`AlbumDetailSheet` re-fetches the iTunes tracklist every time an album is opened. The tracklist never changes during a session. Cache per `collectionId` so re-opening an album is instant.

### Library — show vinyl source badge

The `vinylSource` state (`"db"` | `"estimated"`) is tracked but never shown. A subtle badge ("Via Discogs" or "Estimated") on the tracklist header would be informative and help identify albums that need better data.

### Library → Main App integration

When a track is tapped in `AlbumDetailSheet`, it should be possible to jump to the main app with that track already loaded — "Start listening from here." This bridges the library and the listening experience.

### Add-Vinyl — dynamic LP count, no hardcoded max

The contribution wizard is hardcoded to support 4 LPs maximum (8 sides A-H). Should dynamically derive side letters from actual `disc_count` to support any number. A 6-LP box set submission currently silently breaks.

### Add-Vinyl — auto-fill from Discogs

When a user selects an album in the add-vinyl wizard, auto-populate the tracklist from Discogs (same logic as library) rather than requiring manual side-by-side assignment. The user would just review and confirm, not enter from scratch.

### Main app — side flip detection via silence

The turntable auto-advance currently relies on duration. A better trigger: the app detects a period of silence (the natural pause between Side A ending and the needle lifting). This is a true signal that the record is done. Web Audio API `AnalyserNode` can detect this reliably. Flip prompt fires on silence detection rather than a timer.

### Main app — vinyl mode as default when library is set

Right now, "turntable mode" (Strategy V) and "vinyl mode" (auto-advance) are somewhat distinct. Picking a record from your library should automatically arm both. You put a record on, select it in Liri, and it just follows — no extra steps.

### TV display — full lyrics scroll mode

In addition to the current "5 lines around the current lyric" view, offer a full-scroll mode where all lyrics are visible and the current line is highlighted. Some people prefer to read ahead. Toggle with D-pad.

### TV display — responsive lyric window size

The lyric window is always 5-6 lines regardless of screen size. Should calculate based on `window.innerHeight` so a 75" TV shows more context and a small monitor shows the right amount.

### Lyric cache — offline-first album mode

When a user adds an album to their library, pre-fetch and cache all lyrics for that album in `liri_lyric_cache`. Then listening works even without a network connection (after the initial sync). Especially useful for the iOS app on poor network.

### "What's playing" widget (iOS lock screen)

Use iOS Live Activities to show the current lyric line on the lock screen, the way music apps show "Now Playing." This is a high-effort feature (requires Swift + ActivityKit) but would be incredibly compelling — lyrics on your lock screen as the record plays.

### Lyric corrections / user reporting

LRCLib isn't always right. Add a "lyrics off?" button that lets users flag bad sync or wrong lyrics. Log these to Supabase. Even without implementing corrections, the data is useful for knowing which tracks have bad data.

### Artist pages (stretch goal)

A simple `/artist/taylor-swift` page showing all Taylor Swift albums in the Liri database, each album's full track listing with side labels, and a link to "Listen with Liri." Good for SEO and gives the app a discoverable public presence beyond the landing page.

### Listening statistics / Wrapped

`get_user_wrapped()` is already written in the analytics schema. Build a UI for it — total songs listened to this year, most-played album, side flips, total time. Annual "Liri Wrapped" moment, shareable image card.

### Sharing / Lyric Cards

Tap any lyric line to generate a shareable image: the lyric text over the album art with Liri branding. Share to Instagram Stories, iMessage, etc. Natural virality. The lyric card should be generated client-side using Canvas so there's no server cost.

### Record label / pressing info in the library

`vinyl_releases` already has `record_label`, `catalog_number`, `edition`, `version_note`. Display these in `AlbumDetailSheet` — e.g. "Capitol Records · PCS 7088 · UK Original Pressing." Makes the app feel like a proper vinyl companion.

---

## The thing to keep in mind

The project doc said it best: the hardest part of Liri is not "making an app." It's the sync problem. Every new feature is only worth building after the sync experience feels genuinely good. Don't let cool features distract from the core.

The magic moment is: put on a record, walk back to your chair, and the right lyric is already there. That's the only thing that matters in v1 and v2.
