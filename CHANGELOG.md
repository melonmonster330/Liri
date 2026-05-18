# Changelog

## Unreleased (pending app push)
- Smooth auto-scroll for plain-text-only lyrics (Genius-sourced tracks have no timestamps — current line-by-line highlight is faked at 4s/line). Replace with a continuous scroll over track duration. Touches lyrics rendering in app/src/main.js (~5 sites). Requires APP_VERSION bump + `npm run sync`.

## v1.0.1
- Removed all internal references to "Vinyl Mode" — the app has always been built for vinyl, so the distinction was unnecessary and confusing

## v1.0.0
- Initial launch
