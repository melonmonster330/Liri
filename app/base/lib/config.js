// App-wide constants — no React, evaluated once at module load.

export const IS_IOS = window.Capacitor?.getPlatform?.() === "ios";
export const ITUNES_PROXY   = IS_IOS ? "https://www.getliri.com/api/itunes-lookup"   : "/api/itunes-lookup";

// Corrects for the acoustic-recognition round-trip so displayed lyric sync
// matches actual audio playback position.
export const PLAYBACK_OFFSET_CORRECTION = 4.0;
// Extra offset added when auto-advancing to next track (no re-listen),
// accounting for lyrics-fetch + state-update delay. Tune if still drifting.
export const AUTO_ADVANCE_OFFSET = 2.0;

// Vinyl playback consistently gains on the digital lyric timestamps across
// tested albums/turntables. Advance the synced lyric clock by a flat 2.8% to
// prevent cumulative lag. Unsynced lyric auto-scroll has its own user control.
// Same rate on iOS and web: web-only speed-ups (1.057, 1.045) both ran fast
// against a real record. Measured, not derived.
// Web testing 1.025: 1.021 was ~0.5s behind at 1:50, 1.028 ran fast. iOS stays at 1.028.
export const SYNC_PLAYBACK_RATE = IS_IOS ? 1.028 : 1.025;
