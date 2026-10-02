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
// Web still fell ~5s behind iOS over a 3-min song at 1.028 in side-by-side
// tests, so the browser gets the 2.8% applied twice. Measured, not derived.
export const SYNC_PLAYBACK_RATE = IS_IOS ? 1.028 : 1.057;
