# Dev Notes — handoff

> Context note for picking up Liri development on another machine (e.g. moving from
> Windows to Mac). The code lives in git; this file carries the *context* that a
> chat session doesn't. Safe to update or delete anytime.

---

## Current status

- `main` is up to date; working tree clean (only routine `package-lock.json` churn).
- Recent work shipped: **onboarding** (welcome carousel, Feed card + coach marks,
  "How Liri works" replay in settings, onboarding shown *after* login/signup) and
  **social feed** (publish Liri app-update posts, surface real errors on post failure).
- App version: v0.6.

---

## How to run it locally

No iOS simulator needed for most work — the GUI is a web app (React in a Capacitor
webview). Run it in a browser:

```bash
npm install          # first time on a new machine
npm run dev          # watch mode: rebuilds app/vendor/app.js on every save — LEAVE RUNNING
```

Serve the folder (any static server works), then open the app at `/app/`:

```bash
npx serve . -p 3000  # then visit http://localhost:3000/app/
```

To view it like the phone: open Chrome/Safari DevTools and toggle the device
toolbar (Chrome: Ctrl/Cmd+Shift+M), pick an iPhone.

### iOS (Mac only)

ShazamKit recognition, NativeAudio, and IAP are **native** and only run in the iOS
build. Test those in Xcode:

```bash
npm run sync         # build + npx cap sync + patch ios config
npm run ios          # open in Xcode
```

To live-tweak the iOS GUI's CSS: run the app in the Simulator, then Safari →
Develop → Simulator → (the app) → Web Inspector.

---

## The two-file rule (for making edits)

| File | Role | Edit it? |
|---|---|---|
| `app/src/main.js` | **Source** — what you edit | ✅ always |
| `app/vendor/app.js` | Generated bundle | ❌ never (overwritten by the build) |

Edit loop: edit `main.js` → save (watcher rebuilds in ~70ms) → refresh browser.

Safe beginner edits are text-in-quotes and hex colors:
- Welcome button label: `app/src/main.js` ~line 2801 (`"Get Started — it's free"`)
- Brand gold color `#d4a846` (used throughout; Ctrl+H to replace all)

Golden rules: only change what's inside `"..."` or a hex code; leave quotes/commas/
parens/`React.createElement` alone. Undo = Ctrl+Z. Full reset of a file =
`git checkout app/src/main.js`.

---

## Architecture decision: web vs iOS (settled, for now)

Web and iOS are **genuinely different products** (e.g. iOS uses ShazamKit
fingerprinting; web has no fingerprinting and falls back to a manual track picker —
see `app/src/main.js` ~line 1720). That difference is real and intended.

**Decision: stay on Capacitor (one React codebase), do NOT rewrite iOS in native
SwiftUI.** Reasons:
- ~90% of the GUI is genuinely shared (auth, feed, onboarding, library, lyric sync).
- Web is part of the product (getliri.com, landing/waitlist, TV cast) — going native
  would mean maintaining two full frontends forever.
- The divergence is small and contained: recognition, audio, IAP, and some `IS_IOS`
  GUI copy. Native bridges live in `app/ios/` (`shazam.js`, `audio.js`, `iap.js`).
- Platform branching today: `IS_IOS = !!window.Capacitor` (~line 24), ~36 branches.

**If we ever want them *more* different:** the cheap, sustainable path is to split
the shells (separate web root + iOS root component trees) while sharing the core
engine (Supabase/auth, lyric-sync, LRC parsing, feed data) — NOT a native rewrite.

**Possible future ergonomics win:** extract colors/spacing/fonts into a central theme
(tokens / CSS variables) so design tweaks happen in one place. Not started.

---

## Testing buckets (where to test what)

| Bucket | Examples | Test where |
|---|---|---|
| Shared | auth, social feed, onboarding, library, lyric sync | Windows/Mac browser |
| iOS-only | Shazam recognition, NativeAudio, IAP, `IS_IOS` copy | Mac + Simulator/device |
| Web-only | ACRCloud `/api/recognize` | Browser, but needs `vercel dev` |
