# Liri — Next Steps
> One file. The only planning doc that matters. Last updated: March 2026, v1.32.

---

## What V1 IS (already working — don't break it)

- **Listen → detect**: ACRCloud fingerprint → Whisper transcription → GPT-4o-mini fallback. Three strategies, one pipeline.
- **Lyrics sync**: LRC from LRCLib, timestamped, real-time with drift correction and nudge buttons.
- **Vinyl mode**: Pick a record from your library → Liri knows what comes next → auto-advances through tracks without re-listening.
- **Library (My Records)**: Tap an album → full tracklist with side labels → tap a track → read lyrics.
- **TV Cast**: Broadcasts current lyric line to tv.html via Supabase Realtime (room code or Cast SDK).
- **Lyric cache**: Global/shared — one successful match benefits all users forever.
- **Discogs vinyl data**: Correct side labeling (A1/B1, sequential, numbered) backed by Discogs.

---

## Fix NOW — before anything else (launch blockers)

**1. Sync iOS files with web files**
The iOS app is running old code. Run: `npx cap sync ios` then rebuild in Xcode.
`ios/App/App/public/` should never be edited directly — it's a build output.

**2. XSS risk in vinyl.html**
`innerHTML` in a few template literals is missing `esc()` escaping on user-submitted data (album names, catalog numbers).
Audit every place user-submitted vinyl data hits innerHTML. Already have `esc()` in the file — just use it everywhere.

**3. Silent error handling**
When detection fails, nothing visible happens. Add a simple `showError(msg)` helper that flashes text at the top of the screen. Even one line of red text is better than silence.

---

## Fix NEXT — first week after launch

**4. Side flip UX**
When Side A ends, the user flips the record and has to tap Listen again. That's fine for now — but it should prompt them first: "Side A is almost done. Ready to flip?" Trigger this based on track duration tracking.

**5. Relabel the nudge buttons**
"← 5s" / "5s →" confuses people. Change to "Lyrics behind" / "Lyrics ahead". One-line fix, big UX win.

**6. Re-detect button on sync screen**
If sync has drifted badly, the user should be able to tap "Re-listen" and get re-synced without going back to idle. Currently they have to reset everything.

**7. "No lyrics found" dead end**
When LRCLib has no match, the app shows nothing. Show the song info at minimum (title + artist) and a manual timestamp option so the session isn't wasted.

**8. Reconcile getSideInfo() / deriveSideFromIndex()**
Two files (`index.html` and `library.html`) have their own version of this function and they've drifted. Pick one, delete the other, share via a small `vinyl-utils.js` snippet.

**9. Cache iTunes tracklist per session**
`AlbumDetailSheet` re-fetches the tracklist every time an album is opened. Cache by `collectionId` so re-opening is instant.

---

## Fix SOON — next few weeks

**10. Proxy LRCLib through Vercel**
`library.html` calls lrclib.net directly from the browser. Every other external API goes through a Vercel proxy. If LRCLib ever changes their CORS policy, this breaks silently. Add `/api/lrclib-lookup`.

**11. Shared CSS design tokens**
Colors (`#080810`, `#d4a846`, `#e8a0a8`) and button styles appear hundreds of times across all files. Extract to `shared.css` with `:root` variables. One change = consistent everywhere.

**12. Add-vinyl: dynamic LP count**
The contribution wizard is hardcoded to max 4 LPs (sides A–H). Derive side letters from actual `disc_count` so box sets don't silently break.

**13. Library: "Refresh vinyl data" button**
Albums with stale or incomplete Discogs data can't auto-fix. Add a "Refresh" button in AlbumDetailSheet that force-deletes and re-fetches.

**14. Library: vinyl source badge**
`vinylSource` state ("db" or "estimated") is tracked but never shown. Show a subtle badge ("Via Discogs" or "Estimated") on the tracklist header.

**15. Silence detection for side-flip trigger**
The side auto-advance relies on duration timers. Better signal: detect silence (needle lifting) via `AnalyserNode`. More reliable, feels smarter.

**16. Turntable mode = vinyl mode (unify them)**
Picking a record from the library should arm full vinyl auto-advance automatically. The distinction between "turntable mode" and "vinyl mode" should disappear — picking a record IS entering vinyl mode.

---

## Fix EVENTUALLY — real features, not blocking

**17. Confidence indicator on detection**
Was the detection confident or uncertain? A subtle visual cue helps users know whether to trust the sync.

**18. Library → main app integration**
Tapping a track in AlbumDetailSheet should let you "Start listening from here" — jump to main app with that track pre-loaded.

**19. TV display: full lyrics scroll mode**
In addition to the current 5-line window, offer a full-scroll mode where all lyrics are visible and the current line is highlighted. D-pad toggle.

**20. TV display: responsive lyric window**
Always 5-6 lines regardless of screen size. Should calculate from `window.innerHeight` so a 75" TV shows more context.

**21. Offline-first album mode**
When an album is added to the library, pre-fetch and cache all lyrics in `liri_lyric_cache`. Listening works without network after initial sync.

**22. Lyric corrections / user reporting**
"Lyrics off?" button logs bad sync or wrong lyrics to Supabase. Useful data even before corrections are implemented.

---

## Backlog — good ideas, not now

> These stay here so they don't disappear. Touch them when the core is solid.

- Listening statistics / "Liri Wrapped" UI (schema already written, no UI yet)
- Lyric cards — tap a line, generate a shareable image (Canvas, client-side, no server cost)
- Record label / pressing info in library (`vinyl_releases` already has catalog_number, edition, etc.)
- iOS lock screen Live Activity — current lyric on lock screen (requires Swift + ActivityKit, high effort)
- Annotation mode — tap a lyric line to save a note
- Listening party mode — multiple people synced to the same session
- Artist pages — `/artist/name` for SEO and discoverability
- Liner notes between tracks (credits, musician info, album context via Discogs/MusicBrainz)
- Art mode — current lyric as a moving graphic, Philips Hue integration

---

## Legal gates (before you charge anyone)

| Stage | What you need |
|---|---|
| Right now (prototype/beta) | Fine. AudD free tier + lrclib is OK for testing. |
| Before public beta | Upgrade AudD to a paid commercial tier (audd.io/pricing). |
| Before charging users | Music licensing attorney consultation (~$500). Negotiate MusixMatch commercial API license (~$500+/mo). lrclib is NOT licensed for commercial use — must switch before monetizing. |
| Samsung TV submission | Samsung requires proof of rights clearance during review. |

> Taylor Swift's catalog is controlled by UMPG and they are aggressive about enforcement. Get licensed before you charge a dollar.

---

## Platform status

| Platform | Status |
|---|---|
| Web app (getliri.app) | Live |
| iOS (Capacitor) | Pending App Store review |
| Samsung TV | Phase 2 — not started |
| Android | Phase 3 — not started |

---

## The only thing that matters in V1 and V2

> Put on a record, walk back to your chair, and the right lyric is already there.
> Every decision runs through that test.
