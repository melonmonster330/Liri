// App-wide constants — no React, evaluated once at module load.

export const IS_IOS = !!window.Capacitor; // set once at load time — used for App Store compliance checks
export const TRANSCRIBE_PROXY = window.Capacitor ? "https://www.getliri.com/api/transcribe"    : "/api/transcribe";
export const ITUNES_PROXY   = window.Capacitor ? "https://www.getliri.com/api/itunes-lookup"   : "/api/itunes-lookup";

// Corrects for the acoustic-recognition round-trip so displayed lyric sync
// matches actual audio playback position.
export const PLAYBACK_OFFSET_CORRECTION = 4.0;
// Extra offset added when auto-advancing to next track (no re-listen),
// accounting for lyrics-fetch + state-update delay. Tune if still drifting.
export const AUTO_ADVANCE_OFFSET = 2.0;

// Vinyl playback consistently gains on the digital lyric timestamps across
// tested albums/turntables. Advance the synced lyric clock by a flat 2.5% to
// prevent cumulative lag. Unsynced lyric auto-scroll has its own user control.
export const SYNC_PLAYBACK_RATE = 1.025;
