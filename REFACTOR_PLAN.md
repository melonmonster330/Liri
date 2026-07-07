# Liri Codebase Optimization Plan

Goal: make `main.js` (and the tab HTML pages) fast for humans **and** AI to read,
edit, and reason about — without changing behavior. Today `app/src/main.js` is
**~6,968 lines**: a single `Liri()` React component that owns all state, ~40
inline functions, and a 503-`createElement` render. That's the #1 bottleneck.

## Principles (non-negotiable)

1. **Zero behavior change.** Pure mechanical extraction. If output/ordering
   changes, it's a bug, not a refactor.
2. **On a branch.** Never on `main` (per house rule for large/UI work).
3. **Build + device-test after every phase.** `npm run sync`; esbuild fails
   loudly on syntax errors. Play a record and confirm nothing regressed before
   the next phase.
4. **Small, independently shippable phases** in the order below (safest first).
   Any phase can be the stopping point.
5. **Bump APP_VERSION** (all 8 places) per commit, as usual.

## Why this helps AI specifically

- Small, single-purpose files fit in context — a model can load `match.js`
  without pulling 7k lines of unrelated render code.
- Named modules with one export surface = the model knows *where* logic lives
  from the file tree, before reading a line.
- Isolated units are testable/verifiable in isolation.

## Target structure

```
app/src/
  main.js            # just <Liri/> shell: wires hooks + screens together (~300 lines)
  hooks/             # NEW — stateful React logic, one domain per file
    useAuth.js
    usePayments.js         # Apple IAP + Stripe
    useTurntable.js        # album select, track load, side data
    useTrackAdvance.js     # advance / flip / manual jump / resync
    useListening.js        # Shazam + speech-recognition match flow
    useNowPlaying.js       # cross-tab persistence + heartbeat
    useLyricScroll.js      # auto-scroll, scroll-to-line, tap-to-seek, re-follow
  screens/           # NEW — the render, split by screen
    IdleScreen.js
    SyncingScreen.js       # lyrics view + controls panel
  base/lib/          # EXISTING — grow these (pure, no React)
    match.js               # NEW: vinyl-aware + consecutive-word matching
    analytics.js           # NEW: all listening/flip/button event logging
    sides.js               # EXTEND: fold in side-flip point detection
    payments.js            # NEW: Stripe checkout + IAP plumbing (non-React parts)
  base/components/   # EXISTING — grow these
    ControlsPanel.js       # nudge / skip / speed / follow cluster
    Tracklist.js
    HistorySheet.js
    AlbumPicker.js
    Onboarding.js          # coach marks + onboarding flow
```

## Phases (do in this order — lowest risk first)

### Phase 0 — Prep (no code movement)
- Create branch `refactor/split-main`.
- Add this file's tree as empty stubs? No — create files as each phase lands.

### Phase 1 — Pure helpers (safest; no React, no state)
Extract top-level/near-pure functions to `base/lib`:
- `orderLibrary` (main.js ~42), `plainToLines` (~34) → `base/lib/library.js`
- Matching: "Vinyl-aware track matching" + "Unique consecutive-word match"
  (~1673–1820) → `base/lib/match.js`
- Analytics loggers: song play, flip, button, auto-post (~656–742, ~1821–1840)
  → `base/lib/analytics.js` (pass `sb`/user in as args — keep them pure)
- Constants block (IS_IOS, proxies, offsets ~63–78) → `base/lib/config.js`
**Risk: low.** These have clear inputs/outputs. Build + smoke test.

### Phase 2 — Self-contained feature logic → hooks
Move a domain's state + effects into a `use*` hook, return what render needs:
- `usePayments` — Apple IAP + Stripe upgrade (~788–1032)
- `useNowPlaying` — persistence + heartbeat (~2170–2336)
- `useLyricScroll` — scroll effects (~1415–1520, ~2337–2408)
Do **one hook per commit**; verify playback after each.

### Phase 3 — Core playback hooks (highest value, most care)
- `useTurntable` — album/track/side load (~205–262, ~1078–1274, ~2409–2608)
- `useListening` — Shazam + speech match (~1863–2169)
- `useTrackAdvance` — advance/flip/jump/resync (~2609–3012)
These share refs — extract carefully, keep the refs' single source of truth.
**Watch:** the turntable "no external API during playback" rule and
"track data from library refs, not iTunes" rule must survive intact.

### Phase 4 — Split the render (503 createElement calls)
The render is the biggest readability win. Cut by screen:
- `Onboarding.js` (coach marks ~4171+)
- `ControlsPanel.js` (nudge/skip/speed/follow ~5730–5920)
- `AlbumPicker.js`, `HistorySheet.js`, `Tracklist.js` (the sheets)
- `IdleScreen.js`, `SyncingScreen.js` (top-level screens)
Pass props down explicitly. After this, `main.js` is a thin shell.

### Phase 5 — Tab HTML pages
The 7 tab pages (feed/explore/library/profile/stats/settings/vinyl.html) each
inline an `APP_VERSION` + shared boot code. Extract the shared header/boot into
one `app/base/lib/boot.js` so the version lives in **one** place (kills the
"bump 8 files" chore).

## Guardrails / gotchas discovered
- Build path: `npm run build` = esbuild bundles `main.js` → `vendor/app.js`
  (IIFE, safari15). ES `import` is fine — esbuild inlines it. No runtime module
  loading to worry about.
- `npm run sync` = build + `cap sync` + patch iOS config. Always before commit.
- Refs are the app's shared memory (turntable tracks, side data). When splitting,
  a ref must have exactly one owner; pass it down, don't duplicate.
- Version string is duplicated in 8 files — Phase 5 fixes the root cause.

## Suggested first move
Phase 1 only (pure helpers → `base/lib`). It's ~4 small files, near-zero risk,
and immediately shrinks `main.js` by ~400 lines while proving the workflow.
