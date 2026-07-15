// Vinyl-aware track matching — no React, no network calls, pure in-memory.
//
// ── Vinyl-aware track matching ──────────────────────────────────────────────
// When the user has told us what album is on the turntable, fetch LRC lyrics
// for ALL tracks in parallel and score the Whisper transcript against each.
// Returns { track, lrcMatch, lyrics, startPos, score } or null.
// Skips GPT entirely — much more accurate for obscure / re-recorded albums.
// ── Unique consecutive-word match against cached lyrics ──
// Tries word runs from 1 upward — shortest unique run wins.
// A single rare word is enough if it appears in only one track.
// Pure in-memory, no network calls.

import { parseLRC } from "./text.js";
import { plainToLines } from "./library.js";

export const matchTranscriptToTracks = (transcript, tracks, wordsData, logRef) => {
  // Normalise a single word: lowercase, strip non-alphanumeric except apostrophe
  const normWord = w => w.toLowerCase().replace(/[^a-z0-9']/g, "");

  // Fuzzy word equality: allow small edit-distance for Whisper transcription noise
  // Short words (≤3 chars) must match exactly — too risky to fuzz "I", "me", "the"
  // Medium words (4-6 chars): allow 1 edit; long words (7+): allow 2 edits
  const editDist = (a, b) => {
    if (Math.abs(a.length - b.length) > 2) return 99;
    const dp = Array.from({length: a.length + 1}, (_, i) => i);
    for (let j = 1; j <= b.length; j++) {
      let prev = dp[0]; dp[0] = j;
      for (let i = 1; i <= a.length; i++) {
        const temp = dp[i];
        dp[i] = a[i-1] === b[j-1] ? prev : 1 + Math.min(prev, dp[i], dp[i-1]);
        prev = temp;
      }
    }
    return dp[a.length];
  };
  const fuzzyEq = (a, b) => {
    if (a === b) return true;
    if (!a || !b) return false;
    if (a.length <= 3 || b.length <= 3) return false; // short words: exact only
    return editDist(a, b) <= (a.length <= 6 ? 1 : 2);
  };
  const heardWords = transcript.toLowerCase().split(/\s+/).map(normWord).filter(w => w.length > 1);
  if (logRef) logRef.push(`match: ${heardWords.length} words from transcript`);
  if (!heardWords.length) return null;

  // baseName strips suffixes like "(live)", "[bonus track]", "(remastered)" etc.
  // Albums that include both a studio take and a live/session version of the same
  // song would otherwise have two tracks with identical word sets. Without this
  // deduplication both tracks would match the same phrase, producing hits.length > 1
  // and breaking the uniqueness requirement. seenNames ensures only the FIRST
  // occurrence (by track order from the DB) is used as the canonical version.
  const baseName = n => (n || "").toLowerCase().replace(/\s*[\(\[].*/, "").trim();
  const seenNames = new Set();

  // Build per-track word arrays from words_json stored in Supabase
  const tracksWithWords = tracks.map(t => {
    const data = wordsData[t.trackId];
    if (!data?.words?.length) return null;
    const base = baseName(t.trackName);
    if (seenNames.has(base)) return null; // skip duplicates
    seenNames.add(base);
    return {
      ...t,
      wordArr: data.words.map(w => w.word), // already normalised at store time
      wordTimings: data.words,               // [{word, start_ms}] for position lookup
      lrc_raw: data.lrc_raw,
      lyrics_plain: data.lyrics_plain,
    };
  }).filter(Boolean);

  if (logRef) logRef.push(`match: ${tracksWithWords.length}/${tracks.length} tracks have lyrics`);
  console.log("[match] tracksWithWords:", tracksWithWords.length, "/", tracks.length, "| heardWords:", heardWords.slice(0, 8).join(" "));
  if (tracksWithWords.length > 0) console.log("[match] sample track words:", tracksWithWords[0]?.trackName, tracksWithWords[0]?.wordArr?.slice(0, 10));
  if (!tracksWithWords.length) return null;

  // MIN_RUN = 4: require at least 4 consecutive matching words before committing.
  // Why 4 and not lower?
  //   1-word match: too many false positives — common words like "love" appear in
  //     almost every track on the album.
  //   2-3 word match: still ambiguous on pop albums with similar lyric vocabulary.
  //   4+ word match: in practice almost always unique within an album AND across
  //     repeated choruses within a single track (uniqueness-within-track is also
  //     required — count > 1 → rejected).
  // Why not higher? Longer runs mean the user has to hold the mic for longer before
  // anything happens, degrading perceived responsiveness. 4 words ≈ 1–2 seconds of
  // speech, which feels instant.
  const MIN_RUN = 3; // 3 consecutive fuzzy-matching words is enough within a single album

  // Scan all possible windows of length MIN_RUN upward through the transcript.
  // Stops at the SHORTEST run that satisfies BOTH:
  //   (a) appears in exactly ONE track in the album (uniqueness across tracks)
  //   (b) appears exactly ONCE inside that track (not a repeated chorus fragment)
  // Requiring exactly-one-track (not "best scoring track") is intentional — if we
  // accepted a best-guess the lyrics display would start at the wrong song entirely
  // with no error shown to the user. Forcing strict uniqueness means we keep
  // listening until we are certain, which is always the right trade-off here.
  for (let len = MIN_RUN; len <= heardWords.length; len++) {
    for (let start = 0; start <= heardWords.length - len; start++) {
      const phrase = heardWords.slice(start, start + len);

      const hits = tracksWithWords.filter(t => {
        let count = 0;
        const arr = t.wordArr;
        for (let i = 0; i <= arr.length - len; i++) {
          let ok = true;
          for (let j = 0; j < len; j++) {
            if (!fuzzyEq(arr[i + j], phrase[j])) { ok = false; break; }
          }
          if (ok) { count++; if (count > 1) return false; } // repeats within track → not unique enough
        }
        return count === 1;
      });

      if (hits.length !== 1) continue; // not unique across tracks

      const match = hits[0];

      // Find the position (in seconds) of the matched phrase in this track.
      // matchWordIdx is the index into match.wordTimings of the first word of the
      // matched phrase. start_ms / 1000 gives the lyric display start position.
      // This is also returned as startPos, which flows into the sync offset formula
      // in startSync / startListeningSpeech.
      let matchWordIdx = -1;
      const arr = match.wordArr;
      for (let i = 0; i <= arr.length - len; i++) {
        let ok = true;
        for (let j = 0; j < len; j++) {
          if (!fuzzyEq(arr[i + j], phrase[j])) { ok = false; break; }
        }
        if (ok) { matchWordIdx = i; break; }
      }
      const startPos = matchWordIdx >= 0 ? (match.wordTimings[matchWordIdx].start_ms / 1000) : 0;

      // Build lyrics array for display — prefer timestamped LRC, fall back to plain
      const lyrics = match.lrc_raw
        ? parseLRC(match.lrc_raw)
        : plainToLines(match.lyrics_plain);

      if (logRef) logRef.push(`match: unique run (${len}w) → "${match.trackName}" at ${startPos.toFixed(1)}s`);

      // phraseWordStart: the index (in heardWords[]) of the first word of the
      // matched phrase. Returned so the caller can calculate how far into the
      // live transcript the match landed — used in _phraseOffset to estimate how
      // many seconds of audio had already played before the matching words were
      // spoken. Without this, sync always assumes the match happened at the very
      // end of the recording window, causing a consistent early-offset bug.
      return { track: match, lyrics, startPos, score: len, phraseWordStart: start, totalWords: heardWords.length };
    }
  }

  if (logRef) logRef.push(`match: no unique run yet — keep listening`);
  return null;
};
