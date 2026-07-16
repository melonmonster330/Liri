# Liri — rules for Claude

## Build & sync

- Source of truth is `app/src/main.js` + `app/base/**`. Never hand-edit `app/vendor/app.js` — it's the esbuild bundle (`npm run build`).
- Don't run `npm run sync` unless Helen asks for it.
- **NEVER run raw `npx cap sync`.** Capacitor regenerates `ios/App/App/capacitor.config.json` and silently drops the local SPM plugins (`ShazamPlugin`, `NativeAudioPlugin`) from `packageClassList`, breaking native recognition/audio. Always use `npm run sync`, which runs `scripts/patch-ios-config.js` afterward to restore them.

## Deploys

- After `git push` to `main`, Vercel's GitHub webhook doesn't always fire — the push lands on GitHub fine but no new deployment starts, silently. Don't assume a push means the site updated.
- To check: `npx vercel ls liri --scope melonmonster330s-projects` and compare the latest deployment's age/commit against what you just pushed.
- If it didn't auto-deploy, ship it manually from the repo root: `npx vercel --prod --yes --scope melonmonster330s-projects` (builds and aliases straight from local files — uses the existing Vercel CLI auth already on this machine).
