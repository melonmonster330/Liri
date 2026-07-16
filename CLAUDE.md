# Liri — rules for Claude

## Build & sync

- Source of truth is `app/src/main.js` + `app/base/**`. Never hand-edit `app/vendor/app.js` — it's the esbuild bundle (`npm run build`).
- Don't run `npm run sync` unless Helen asks for it.
- **NEVER run raw `npx cap sync`.** Capacitor regenerates `ios/App/App/capacitor.config.json` and silently drops the local SPM plugins (`ShazamPlugin`, `NativeAudioPlugin`) from `packageClassList`, breaking native recognition/audio. Always use `npm run sync`, which runs `scripts/patch-ios-config.js` afterward to restore them.
