# Liri — Big Picture Roadmap

> This is a living document. It covers where the project is going, not just what the next feature is.

---

## Where we are now (v0.1)

A working web app that:
- Listens to vinyl via microphone
- Identifies the song via AudD audio fingerprinting
- Fetches synced lyrics from lrclib.net
- Displays them in real time with drift correction

**Platform**: Browser (open index.html)
**Scope**: Taylor Swift only

This is the proof of concept. It works. Now we figure out where to take it.

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

## The thing to keep in mind

The project doc said it best: the hardest part of Liri is not "making an app." It's the sync problem. Every new feature is only worth building after the sync experience feels genuinely good. Don't let cool features distract from the core.

The magic moment is: put on a record, walk back to your chair, and the right lyric is already there. That's the only thing that matters in v1 and v2.
