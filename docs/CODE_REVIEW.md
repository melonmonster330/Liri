# Liri — Code Review Notes

> Written: March 2026. State of codebase: v1.32.
> Intent: honest audit of every file, production-readiness gaps, and cleanup priorities.
> These are notes for a future cleanup session — nothing here is blocking, just things to address before the code is "proud of."

---

## Architecture at a Glance

```
index.html (landing)
  └── /app
        ├── index.html      — main app (180K, React + Babel CDN)
        ├── add-vinyl.html  — vinyl contribution wizard (37K, React + Babel CDN)
        ├── library.html    — personal collection + tracklist (43K, React + Babel CDN)
        └── vinyl.html      — public vinyl database browser (25K, vanilla JS)
  └── /api (Vercel serverless)
        ├── recognize.js    — ACRCloud proxy + HMAC signing
        ├── transcribe.js   — OpenAI Whisper proxy
        ├── identify-lyrics.js — GPT-4o-mini song ID from lyrics snippet
        ├── discogs-lookup.js  — Discogs search + release detail proxy
        ├── itunes-lookup.js   — iTunes search + lookup proxy
        ├── ping-acr.js     — ACRCloud credential diagnostic
        └── ping-whisper.js — OpenAI credential diagnostic
  └── /supabase
        ├── vinyl_schema.sql
        └── analytics_schema.sql
  └── tv.html               — Cast receiver + browser room-code display
```

### What's working really well
- No-build-step architecture: every page is a single file with CDN React + Babel. Incredible for solo dev speed, zero tooling overhead.
- All secrets server-side. `recognize.js`, `transcribe.js`, `identify-lyrics.js` keep keys in Vercel env vars. None in client JS.
- The API proxy layer (discogs-lookup, itunes-lookup) is clean: Vercel handles CORS, caches responses, and keeps User-Agent consistent.
- The Supabase RLS setup is correct. Every table has policies. Lyric cache is global/shared (smart: one successful match benefits everyone).
- The multi-strategy recognition pipeline (ACRCloud → Whisper → GPT → LRCLib) is thoughtful and handles real-world failure modes.

---

## File-by-File Notes

---

### `app/index.html` — Main App (180K)

The heart of Liri. Contains the entire recognition pipeline, lyrics sync, vinyl mode, cast integration, and all UI. This is the file that needs the most love eventually.

**Structural issues**
- **180K single file.** This is the biggest technical debt item in the project. No fault of the approach (no-build is smart), but at this size it's genuinely hard to navigate. A future version should split into logical sections with clear `// ── SECTION ──` dividers at minimum, or consider a minimal build step (Vite) that concatenates files but produces the same single HTML output.
- **Babel at runtime.** The app downloads ~300KB of Babel standalone and transpiles JSX in the browser on every page load. On a fast connection this is ~0.5s. On a slow one (older iOS, poor cell signal), it's 1-2s of spinner. The loading placeholder in `<div id="root">` mitigates this nicely, but it's still cost to be aware of.
- **Three CDN requests before the app starts.** React, ReactDOM, Babel — all sequential. One network hiccup and the app doesn't load. Consider hosting these locally or using an import map.

**Code quality**
- The `Supabase.createClient()` key is hardcoded (it's a publishable anon key — not a secret — but it's the same literal string in every file, see cross-cutting section).
- Inline style objects are huge and repetitive. The same button gradient (`background: "linear-gradient(135deg, #d4a846, #e8a0a8)"`) appears 6+ times in the file. A shared `const btnStyle = {...}` at the top of the file would clean this up significantly.
- Color literals (`#080810`, `#d4a846`, `#e8a0a8`, `#f0e6d3`) appear hundreds of times. These should be CSS custom properties (`--color-bg`, `--color-gold`, etc.) set on `:root` and referenced everywhere.
- The `getSideInfo()` function in this file uses a slightly different algorithm than `deriveSideFromIndex()` in library.html. They should be the same function. If one gets updated, the other drifts.
- `autoPopulateVinylSides()` exists in both `app/index.html` and `app/library.html` with different implementations. The library.html version (Discogs) is newer and better. The index.html version should be updated to match.

**Logic issues**
- Strategy V (vinyl-aware matching) re-fetches the iTunes tracklist on every `loadVinylTracks()` call. If the album is already loaded, this is a wasted request. Should cache in module-level state.
- The `user_vinyl_library` query in the turntable selector runs on every app mount. Fine for now, but would benefit from a simple in-memory cache so re-opening the sheet is instant.
- `flipReminder` state is stored in React state but also in a `useRef` for the interval. The interaction between these is subtle and has caused bugs before. A comment explaining the invariant would help.

---

### `app/library.html` — Personal Collection (43K after recent work)

Recently rewritten with the Discogs integration. Relatively clean compared to index.html.

**Issues**
- `autoPopulateVinylSides()` fetches up to 5 Discogs candidates sequentially (not in parallel). For albums with a clear title match, this means 2-5 extra API calls on first load. Could parallelise the detail fetches with `Promise.all()`.
- `fetchLyricsForTrack()` calls LRCLib directly (not proxied). This works from the browser but adds a CORS dependency on LRCLib's headers. If LRCLib ever changes their CORS policy, this breaks silently. Should proxy through a `/api/lrclib-lookup` endpoint like the others.
- The `AlbumDetailSheet` re-fetches the iTunes tracklist every time the sheet opens for the same album. Should cache per-session at minimum (Map keyed by collectionId).
- No loading indicator while `autoPopulateVinylSides` is running. User sees "Loading..." then it resolves. Fine for now, but a "Fetching vinyl data from Discogs..." message would set expectations.
- `vinylSource` state (`"db"` or `"estimated"`) is tracked but I don't see it displayed anywhere in the UI. Either use it or remove it.

---

### `app/add-vinyl.html` — Vinyl Contribution Wizard (37K)

**Issues**
- **Hardcoded max of 4 LPs.** The side-letter mapping (lines ~64-69) supports A–H (4 discs × 2 sides). A box set submission (5+ LPs) will silently produce incorrect side data. Should be derived dynamically from `disc_count`.
- **Inconsistent artwork URL resolution.** Three different sizes are requested in different places: 600×600 for the hero, 300×300 for search results, 200×200 somewhere else. Centralise to a `resolveArtwork(url, size)` helper.
- **No input validation on `release_year`.** The field accepts any number. Should validate it's a reasonable 4-digit year (1948–present; vinyl was invented in 1948).
- **`disc_count` input allows 0 or negatives.** Should be clamped to `min=1`.
- **Search debounce timer is not cleaned up on unmount.** The `searchTimer` ref is created and cleared on new keystrokes, but there's no cleanup function returned from the useEffect. Not harmful in this app but bad React hygiene.
- **Step 1→2 transition starts before tracks load.** The UI jumps to Step 2 (track listing) while `loadingTracks` is true, showing a spinner. Works fine but is slightly jarring — could stay on Step 1 until the tracks are ready.
- The `esc()` HTML-escaping utility exists in `vinyl.html` but not here. Any user-controlled text rendered via template strings should be escaped. Current data comes from iTunes API (trusted), but good hygiene.

---

### `app/vinyl.html` — Public Vinyl Database Browser (25K)

This is the only page that uses vanilla JS with no React. It works well but has more code quality debt than the React pages.

**Issues**
- **Global variable soup.** All state (`allReleases`, `filtered`, `currentPage`, `tracksCache`, `openCard`) is module-level global. If this ever needs to be tested or extended, it's a headache. Even just wrapping everything in an IIFE `(function(){ ... })()` would be an improvement.
- **`innerHTML` with inconsistent escaping.** The `esc()` function exists and is used correctly in most places, but a few template literals bypass it. Any place that injects user-submitted data (album names, artist names, catalog numbers) into innerHTML must use `esc()`. Worth a full audit — one missed escape is an XSS.
- **Race condition on card expansion.** Clicking a card while its tracks are loading fires a second `openCard()` call. The first fetch's result could then overwrite the second. Needs a per-card "loading" guard (simple boolean in `tracksCache`).
- **Search is in-memory, fetch limit is 2000.** The `.limit(2000)` comment says "more than enough for now." It is — but if the database ever grows to 2001+ releases, the search will silently return incomplete results. Should log a warning if `releases.length === limit`.
- **No loading skeleton or placeholder.** The grid appears empty, then cards pop in. A subtle skeleton (grey placeholder cards) would feel much more polished.
- **Event listeners re-attached on every render.** `querySelectorAll(".card-header").forEach(el => el.addEventListener(...))` runs after every `renderPage()`. Since the DOM is rebuilt via innerHTML, old listeners are GC'd, but it's wasteful. Event delegation (`document.addEventListener("click", e => { if (e.target.matches(".card-header")) ...})`) is cleaner.

---

### `tv.html` — Cast Receiver / Browser Room Code (14K)

**Issues**
- **Mixed field name fallbacks.** `showSession()` checks `data.detectedAt || data.detected_at`, `data.initialPos || data.initial_position`, `data.lyrics_json || data.lyrics`. This suggests the Cast message format and the Supabase format diverged at some point and were never reconciled. Should pick one canonical format and update both sides.
- **Heavy CSS filter.** `filter: blur(120px) brightness(0.12) saturate(2.5)` on the backdrop image. 120px blur is GPU-intensive and can cause dropped frames on cheap Smart TVs or older Chromecasts. Consider reducing to 60-80px and measuring.
- **Room code visible in screenshots.** If a user screenshots the TV screen, their room code is in plain view. Room codes are temporary and low-risk, but it's worth styling them subtly or showing them only briefly.
- **`realtimeChannel` not cleaned up on error.** If `connectToRoom()` throws after subscribing, the channel leaks. Wrap the channel lifecycle in a try/finally.
- **No timeout on initial Supabase lookup.** If the DB is slow, the page sits on "Waiting for music…" indefinitely. A 10-second timeout with "Having trouble connecting, try refreshing" would be better UX.
- **Lyric window is always 5-6 lines, not responsive to screen height.** On a 75" TV it could show 8-10 lines; on a small monitor, 5 might overflow. Calculate based on `window.innerHeight`.
- **DOM rebuilt every 80ms.** The render loop clears `container.innerHTML` and creates 6 new elements every tick. This works fine at 80ms but is inefficient. CSS transforms on pre-created elements would be silky smooth and use far less CPU.

---

### `api/recognize.js` — ACRCloud Proxy

Very clean. One minor issue:
- **`console.log("ACRCloud response:", ...)` logs full response in production.** ACRCloud returns track metadata including ISRCs, label data, etc. Fine for debugging but verbose in Vercel logs. Should be `console.log("ACRCloud:", result.status?.msg, result.metadata?.music?.[0]?.title)` — just the essentials.

---

### `api/transcribe.js` — Whisper Proxy

Good code. Two notes:
- **`language: "en"` hardcoded.** Whisper can auto-detect language. If Liri ever supports non-English artists, this will silently transcribe them in English phonetics. Consider passing `language` as a query param with `"en"` as default so it can be overridden.
- **`whisperPrompt: "Song lyrics:"` is minimal.** A richer prompt like `"Transcribe the sung lyrics from this vinyl record recording."` would improve Whisper's output quality, especially for backing vocals and bridge sections. Worth A/B testing.

---

### `api/identify-lyrics.js` — GPT Song ID

Good code. One note:
- **`max_tokens: 60` could truncate long song names.** A song like "Would've, Could've, Should've (feat. Chris Stapleton)" is 55 characters. With artist appended it's borderline. Bump to 80 to be safe.

---

### `api/discogs-lookup.js` — Discogs Proxy

Clean. One note:
- **No auth check.** Anyone who knows the URL can use this endpoint to proxy free Discogs requests, burning through Discogs rate limits. Discogs allows 60 unauthenticated requests/minute — fine for one app, risky if someone discovers the endpoint. Consider adding a Vercel-level rate limit or a shared secret header check.

---

### `api/itunes-lookup.js` — iTunes Proxy

Same note as discogs-lookup — no auth check, but iTunes has no rate limit per-se so lower risk.

---

### `api/ping-acr.js`, `api/ping-whisper.js` — Diagnostics

These are debug/diagnostic endpoints. They're fine, but:
- They're publicly accessible. Anyone can call `/api/ping-acr` to check if your ACR credentials are valid (the response is informative enough to confirm or deny). Not a real security risk but worth being aware of.

---

### `supabase/vinyl_schema.sql`

Well-structured. Notes:
- **`user_vinyl_collections` table is defined but not used.** It's a future feature (tagging records you own with personal notes). Either implement it or mark it clearly as `-- FUTURE: not yet wired up in UI`.
- **`vinyl_releases.artwork_url` column exists but is never populated by `autoPopulateVinylSides()`**, which uses iTunes for artwork. The column is redundant with what's stored in `user_vinyl_library`. Might make sense to remove it or document what should populate it.
- **No `UPDATE` policy for `vinyl_tracks`.** The schema has UPDATE for `vinyl_releases` (submitter only) but no UPDATE for `vinyl_tracks`. If you ever want to allow track corrections without deleting + re-inserting, this needs to be added.
- **`liri_lyric_cache` has no UPSERT policy** — there's an INSERT policy and an UPDATE policy but no ON CONFLICT handling. The app uses `upsert()` which generates both INSERT and UPDATE, so it works, but the intent should be explicit (a MERGE policy, or both INSERT+UPDATE as currently).
- **`get_collection_play_counts()` references `listening_events`** which is in `analytics_schema.sql`. If the analytics schema isn't applied, this function fails silently at runtime. The schema files should note their dependency on each other.

---

### `supabase/analytics_schema.sql`

Good, comprehensive analytics design. Notes:
- **`listening_events` still references `audd` in a comment** somewhere. Now using ACRCloud — minor docs drift.
- **`get_user_wrapped()` returns a big JSON blob** — this is the "Spotify Wrapped"-style year-in-review feature. It's designed but not yet wired to any UI. It's ready to go when needed.
- **`flip_events` table exists but I'm not sure it's being written to.** Check if `INSERT INTO flip_events` is called anywhere in `app/index.html`. If not, the table is dead weight.

---

### `scripts/seed-vinyl-discogs.js`

The bulk Discogs→Supabase seeder. Reasonable quality.
- **`.env` file is inside `scripts/`**, not the repo root. It's in `.gitignore` but easy to accidentally commit if you're not careful. Consider moving to repo root or using dotenv from the parent directory.
- **Genre list is hardcoded.** Fine for now.
- **No dry-run mode.** Running this accidentally against production would insert a lot of rows. A `--dry-run` flag that logs what would be inserted without writing to Supabase would be valuable.
- **Progress is only logged every N releases**, but if the process crashes mid-way, you can resume with `--start-page`. The resume logic is good.

---

### `ios/App/App/public/` — iOS Build Copies

**This is a significant issue.** The iOS public directory contains old copies of the HTML files:
- `ios/App/App/public/library.html` — 20K (very old version, before AlbumDetailSheet existed)
- `ios/App/App/public/index.html` — 164K (vs 180K on web — behind by several versions)

These are the files the iOS app actually runs. The web files and iOS files are out of sync. The workflow should be: make changes to `app/`, run `npx cap sync ios`, Xcode rebuild. The `public/` directory should be treated as a build output, not a source file. Consider adding `ios/App/App/public/` to `.gitignore` (the whole `ios/` directory is already gitignored but overridden by explicit tracking).

---

### `.gitignore`

**`ios/` is in `.gitignore` but the directory is tracked in git.** This means the gitignore rule has no effect — git is already tracking those files. To actually ignore ios/, you'd need to `git rm -r --cached ios/` to untrack. The Pods directory (~90KB of Xcode project config) is currently committed unnecessarily.

Worth deciding: should `ios/` be in the repo or not?
- **Yes** (current): simpler for anyone who clones to open in Xcode. Downside: Pods/ is committed and changes with every `pod install`.
- **No**: cleaner repo, but you need to run `npx cap sync ios && pod install` after cloning.

For a solo project the current approach is fine, but Pods/ should probably be gitignored (`ios/App/Pods/` specifically).

---

## Cross-Cutting Concerns

### 1. Supabase key duplication
The Supabase URL + anon key are hardcoded in every HTML file. It's a `sb_publishable_*` key (designed to be public), so this isn't a security hole — but it means updating the key requires touching 5+ files. Could centralise with a JS config snippet that all pages import, or just a `<!-- #include config -->` comment convention to make auditing easy.

### 2. No shared CSS or design tokens
Colors, spacing, border-radius values, button styles, and animations are all duplicated across files. A `shared.css` with `:root { --color-bg: #080810; --color-gold: #d4a846; ... }` and common component styles would cut hundreds of lines of duplicate code and make the design consistent.

### 3. `getSideInfo()` / `deriveSideFromIndex()` drift
Both `app/index.html` and `app/library.html` have their own version of the "which side is this track on?" logic. They've already diverged. There should be one source of truth, ideally a shared `vinyl-utils.js` file.

### 4. Monolithic HTML files
The no-build approach is great for solo dev speed, but 180K of JSX in one file is genuinely painful for navigation. At minimum: consistent section comments (`// ── COMPONENT: AlbumDetailSheet ──────────────`), file-level table of contents at the top, and functions alphabetised within sections. A future low-risk step: split into multiple `.js` files that get inlined by a simple build script (just `cat` commands), keeping the no-dependency spirit.

### 5. No error UI system
Errors are either swallowed silently (`catch {}`) or `console.error`'d. There's no toast/snackbar/alert component to tell the user something went wrong. Even a simple one-liner `showError(msg)` that flashes text in the corner would dramatically improve debuggability and user experience.

### 6. LRCLib called directly from browser
`fetchLyricsForTrack()` in `library.html` calls `lrclib.net` directly. Every other external API goes through a Vercel proxy. LRCLib is currently CORS-permissive, but if they ever restrict it, this breaks. Should be proxied like the others.

### 7. iTunes artwork URL replacement is brittle
`.replace('100x100bb', '600x600bb')` is used everywhere. If Apple ever changes their CDN URL format, all artwork breaks simultaneously. Should be wrapped in a single helper function `resizeArtwork(url, px)` so it's one fix if it ever breaks.

---

## Cleanup Priority List

**High — do before App Store launch**
1. Sync `ios/App/App/public/` files with `app/` (run `cap sync`)
2. Fix `vinyl.html` innerHTML escaping audit (XSS risk on user-submitted vinyl names)
3. Add error UI (even a dead-simple toast function) — currently silent failures confuse users

**Medium — good polish pass**
4. Extract shared CSS design tokens (colors, buttons, inputs) to a `shared.css`
5. Add `max_disc_count` validation in `add-vinyl.html` (prevent disc_count > 8)
6. Reconcile `getSideInfo()` / `deriveSideFromIndex()` — one shared implementation
7. Cache iTunes tracklist in `loadVinylTracks()` (index.html) — avoid redundant fetches
8. Fix `vinylSource` display in `library.html` — either show it or remove the state
9. Add `UPDATE` RLS policy for `vinyl_tracks` in schema
10. Proxy LRCLib calls through a Vercel endpoint

**Low — production polish**
11. Reduce ACRCloud console.log verbosity in production
12. Add `--dry-run` flag to seed script
13. Mark `user_vinyl_collections` as FUTURE in schema (it's unused)
14. Add `Pods/` to gitignore (reduce repo churn)
15. Increase `max_tokens` to 80 in `identify-lyrics.js`
16. Remove `language: "en"` hardcoding in `transcribe.js` (make it a param)
17. Add per-card loading guard in `vinyl.html` (prevent concurrent fetch race)
18. Add connection timeout in `tv.html` room-code mode

---

## What's Actually Impressive

Worth calling out what's genuinely good:
- **Zero npm dependencies in production.** The API functions use only Node built-ins (`https`, `crypto`). No `node_modules` bloat, no supply chain risk.
- **The multi-strategy recognition pipeline.** ACRCloud → Whisper → GPT → LRCLib is thoughtful. Each stage covers the other's failure mode.
- **The Supabase RLS setup.** Public reads, authenticated writes, cascade deletes — it's correct.
- **The lyric cache is global/shared.** One user matching a track benefits all future users. Smart design.
- **The Discogs integration.** Using Discogs as the ground truth for vinyl positions (A1, B2, etc.) rather than trying to infer from iTunes or MusicBrainz was the right call. Discogs is exactly the right data source for this.
- **No build step.** This means you can make changes and see them live in minutes, not after a compile cycle. Don't lose this.
