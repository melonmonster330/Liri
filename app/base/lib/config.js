// App-wide constants — no React, evaluated once at module load.

export const IS_IOS = window.Capacitor?.getPlatform?.() === "ios";
export const ITUNES_PROXY   = IS_IOS ? "https://www.getliri.com/api/itunes-lookup"   : "/api/itunes-lookup";

// Corrects for the acoustic-recognition round-trip so displayed lyric sync
// matches actual audio playback position.
export const PLAYBACK_OFFSET_CORRECTION = 4.0;
// Extra offset added when auto-advancing to next track (no re-listen),
// accounting for lyrics-fetch + state-update delay. Tune if still drifting.
export const AUTO_ADVANCE_OFFSET = 2.0;
