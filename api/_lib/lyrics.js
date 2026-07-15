// Liri — shared lyrics fetching with multi-provider fallback chain.
//
// Order:
//   1. LRCLib    — synced (LRC), best for English-language popular music
//   2. Genius    — plain only (scraped), English-strong fallback for tracks
//                  LRCLib doesn't have. Requires GENIUS_ACCESS_TOKEN env var,
//                  no-ops if not set so the chain still works without it.
//
// NetEase was tried as a 2nd synced source but they added RSA+AES encryption
// to their search endpoints in 2024 — not usable without a hosted proxy
// (NeteaseCloudMusicApi package). Removed.
//
// Each provider returns { lrc, plain, source } or null on miss.
// Shared by api/add-to-library.js (Vercel) and scripts/sweep-missing-lyrics.js.

const https = require("https");

// ── Common HTTP helpers ──────────────────────────────────────────────────────

function httpsRequest(opts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, raw, headers: res.headers });
      });
    });
    req.on("error", reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error("Request timed out")); });
    if (body) req.write(body);
    req.end();
  });
}

function get(hostname, path, headers = {}) {
  return httpsRequest({ hostname, path, method: "GET", headers });
}

function getJson(hostname, path, headers = {}) {
  return get(hostname, path, headers).then(r => {
    try { return JSON.parse(r.raw); } catch { return null; }
  }).catch(() => null);
}

// ── LRC parsing (shared by all providers that return LRC) ────────────────────

function parseLrcToWords(lrc) {
  if (!lrc) return [];
  const timeRe = /^\[(\d{2}):(\d{2})\.(\d{2,3})\]/;
  const words = [];
  for (const line of lrc.split("\n")) {
    const m = line.match(timeRe); if (!m) continue;
    const start_ms = (parseInt(m[1]) * 60 + parseInt(m[2])) * 1000
                   + parseInt(m[3].padEnd(3, "0").slice(0, 3));
    const text = line.replace(timeRe, "").trim(); if (!text) continue;
    for (const raw of text.split(/\s+/)) {
      const w = raw.toLowerCase().replace(/[^a-z0-9']/g, "");
      if (w) words.push({ word: w, start_ms });
    }
  }
  return words;
}

function lrcToPlain(lrc) {
  if (!lrc) return "";
  return lrc.split("\n")
    .map(l => l.replace(/^\[\d{2}:\d{2}\.\d{2,3}\]/, "").trim())
    .filter(Boolean).join("\n");
}

// ── 1. LRCLib (synced, free, no auth) ────────────────────────────────────────

async function lrclibGetOnce(params) {
  const data = await getJson("lrclib.net", `/api/get?${params}`,
    { "Lrclib-Client": "Liri/1.0 (https://getliri.com)" });
  return data?.statusCode === 404 ? null : data;
}

async function lrclibSearchAll(trackName, artistName) {
  const params = new URLSearchParams({ track_name: trackName, artist_name: artistName });
  const data = await getJson("lrclib.net", `/api/search?${params}`,
    { "Lrclib-Client": "Liri/1.0 (https://getliri.com)" });
  return Array.isArray(data) ? data : [];
}

// Look up the iTunes Search API for an accurate track duration. Discogs vinyl
// entries often omit per-track durations or are off by a few seconds, which
// caused the duration-strict LRClib fetch to 404 → fall through to a non-
// matched synced version → ~every song drifts. iTunes is reliable, so we use
// it as a secondary source for the LRClib duration constraint.
async function fetchItunesDuration(trackName, artistName, albumName) {
  const term = `${artistName} ${trackName}`.trim();
  if (!term) return null;
  const path = `/search?term=${encodeURIComponent(term)}&entity=song&limit=15&media=music`;
  const data = await getJson("itunes.apple.com", path);
  const results = data?.results || [];
  if (!results.length) return null;
  const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const wantAlbum  = norm(albumName);
  const wantTrack  = norm(trackName);
  const wantArtist = norm(artistName);
  // STRICT artist match required — falling back to results[0] gives a totally
  // different artist's song (e.g. "Change of Heart" by Tom Petty when asked
  // for The 1975's "A Change of Heart"), which then pollutes the duration
  // check and causes the correct synced lyrics to be rejected.
  const byArtist = results.filter(r => norm(r.artistName) === wantArtist);
  if (byArtist.length === 0) return null;
  // Require a TRACK-NAME match too. Falling back to byArtist[0] returns an
  // unrelated song by the same artist (e.g. "She Lays Down" → "I Like America
  // & America Likes Me", 207s), whose duration then makes the correct synced
  // lyrics look like a gross mismatch. No track match → no reference duration.
  const pick =
    byArtist.find(r => norm(r.collectionName) === wantAlbum && norm(r.trackName) === wantTrack)
    || byArtist.find(r => norm(r.trackName) === wantTrack)
    || null;
  return pick?.trackTimeMillis ? pick.trackTimeMillis / 1000 : null;
}

// LRClib /api/get is strict (±2s). Allow a hair more on our side when scanning
// search results, since cross-master differences are usually under ~3s.
const LRC_DURATION_TOLERANCE_S = 3;
// A synced LRC should span most of its track. LRClib is full of entries whose
// metadata says "live version" but whose timestamps were pasted from the
// studio cut — e.g. Pearl Jam "Oceans (Live MTV Unplugged)" (239s) has entries
// ending at 141s (studio paste, lyrics start at 0:00 over the long intro) and
// at 201s (true live sync, first line at 0:40). Below this coverage ratio we
// double-check the search variants for a better-synced copy at the same
// duration instead of trusting /api/get's single answer.
const LRC_COVERAGE_OK = 0.7;
// A synced version more than this far from the reference is a fundamentally
// different recording (live / remix / edit), not a remaster — so it overrides
// even an album-name match. Within this window we trust the album match.
const LRC_GROSS_MISMATCH_S = 30;

// Last bracket-timestamp in an LRC, in seconds. Matches word-level (enhanced)
// timestamps too — max wins either way.
function lrcLastTimestampS(lrc) {
  let last = 0;
  const re = /[\[<](\d{2}):(\d{2})\.(\d{2,3})[\]>]/g;
  let m;
  while ((m = re.exec(lrc || "")) !== null) {
    const s = parseInt(m[1]) * 60 + parseInt(m[2])
            + parseInt(m[3].padEnd(3, "0").slice(0, 3)) / 1000;
    if (s > last) last = s;
  }
  return last;
}

// Fraction of the track the synced timestamps actually span. 0 when the sync
// overruns the track by more than a few seconds (an LRC pasted from a LONGER
// version — lyrics would keep running after the song ends).
function syncCoverage(x) {
  if (!x?.syncedLyrics || !x.duration) return 0;
  const last = lrcLastTimestampS(x.syncedLyrics);
  if (last > x.duration + 5) return 0;
  return last / x.duration;
}

function bestCovered(list) {
  if (!list.length) return null;
  return list.reduce((best, x) => syncCoverage(x) > syncCoverage(best) ? x : best);
}

// /api/get returns ONE entry for a (track, artist, album, ±2s duration)
// signature — and on live albums that single answer is often a studio-timed
// paste. When its coverage looks bad, scan the search variants at the same
// duration and take the best-synced copy instead of the first one we found.
async function lrclibGetVerified(trackName, artistName, albumName, d) {
  const p = new URLSearchParams({
    track_name: trackName, artist_name: artistName, album_name: albumName,
    duration: String(d),
  });
  const hit = await lrclibGetOnce(p);
  if (!hit?.syncedLyrics) return (hit?.plainLyrics ? hit : null);
  if (syncCoverage(hit) >= LRC_COVERAGE_OK) return hit;
  const variants = (await lrclibSearchAll(trackName, artistName)).filter(x =>
    x.syncedLyrics && x.duration && Math.abs(x.duration - d) <= LRC_DURATION_TOLERANCE_S);
  return bestCovered([hit, ...variants]);
}

async function fetchLrclib(trackName, artistName, albumName, durationSec) {
  // ── Build candidate durations ────────────────────────────────────────────
  // Try whatever the caller passed (Discogs-parsed) first, then iTunes as a
  // secondary. iTunes is fetched lazily — only if the first try misses.
  const candidates = [];
  if (durationSec && durationSec > 0) candidates.push(Math.round(durationSec));

  for (const d of candidates) {
    const hit = await lrclibGetVerified(trackName, artistName, albumName, d);
    if (hit) return packLrclib(hit);
  }

  const itunesDur = await fetchItunesDuration(trackName, artistName, albumName);
  if (itunesDur && Math.round(itunesDur) !== candidates[0]) {
    const hit = await lrclibGetVerified(trackName, artistName, albumName, Math.round(itunesDur));
    if (hit) return packLrclib(hit);
  }

  // ── No duration-matched hit. We now have to *choose* among LRClib's many
  // variants. The original folklore drift bug came from picking a synced
  // version whose duration was WILDLY off (live cuts / remixes / sped-up
  // edits — 20s..348s spread). But an external reference duration is itself
  // unreliable: iTunes is missing many tracks per-album (artists like The
  // 1975 reshuffle their catalogue), and Discogs vinyl durations are often a
  // few seconds off the streaming master. Gating synced lyrics on a strict
  // ±3s match to that reference threw away perfectly-good synced versions
  // ("She Lays Down" → downgraded to plain even though LRClib has 6 correct
  // synced versions clustered at 237–241s).
  //
  // New strategy — trust the signals that actually separate right from wrong:
  //   1. ALBUM-NAME MATCH (normalised) is the strongest signal — it filters
  //      out covers / live albums / remixes. We trust an album-matched synced
  //      version even if it disagrees with the external reference duration.
  //   2. Among album-matched synced versions, use the external reference (if
  //      any) just to *disambiguate* (pick the closest); otherwise fall back
  //      to the CLUSTER CONSENSUS (median duration), which rejects lone
  //      outliers without needing an external reference at all.
  //   3. Only a GROSS duration mismatch (> 30s) overrides an album match —
  //      that indicates a fundamentally different recording, not a remaster.
  const refDur = itunesDur || durationSec || 0;
  const okDur     = (d) => !refDur || !d || Math.abs(d - refDur) <= LRC_DURATION_TOLERANCE_S;
  const grossOk   = (d) => !refDur || !d || Math.abs(d - refDur) <= LRC_GROSS_MISMATCH_S;
  const norm      = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const wantAlbumN = norm(albumName);
  const sameAlbum  = (x) => wantAlbumN && norm(x.albumName) === wantAlbumN;
  const median = (nums) => {
    const s = nums.filter(Boolean).sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : 0;
  };
  // Pick the best synced entry: closest to the reference duration if we have
  // one, else closest to the cluster's median (consensus) duration. Among
  // near-ties on duration, take the best sync coverage — duration alone can't
  // tell a true sync from a studio-timed paste on the same release.
  const pickSynced = (list) => {
    const synced = list.filter(x => x.syncedLyrics);
    if (!synced.length) return null;
    const target = refDur || median(synced.map(x => x.duration));
    if (!target) return bestCovered(synced);
    const dist = x => Math.abs((x.duration || 0) - target);
    const closest = Math.min(...synced.map(dist));
    return bestCovered(synced.filter(x => dist(x) <= closest + LRC_DURATION_TOLERANCE_S));
  };

  // Gather the canonical /api/get match (album-constrained) plus all search
  // variants, and choose from the combined pool.
  const p2 = new URLSearchParams({
    track_name: trackName, artist_name: artistName, album_name: albumName,
  });
  const got = await lrclibGetOnce(p2);
  const results = await lrclibSearchAll(trackName, artistName);
  const all = got ? [got, ...results] : results;
  if (all.length === 0) return null;

  // 1. Best same-album synced version — trusted unless it's a gross mismatch.
  const albumPick = pickSynced(all.filter(sameAlbum));
  if (albumPick && grossOk(albumPick.duration)) return packLrclib(albumPick);

  // 2. No trustworthy same-album synced. If we have a reference duration,
  //    accept any synced within strict tolerance (covers albums whose name
  //    LRClib spells differently than we store).
  if (refDur) {
    const byDur = pickSynced(all.filter(x => okDur(x.duration)));
    if (byDur) return packLrclib(byDur);
  }

  // 3. Last resort: plain only. Prefer same-album, then the canonical get.
  const plainPick = all.find(x => sameAlbum(x) && (x.plainLyrics || x.syncedLyrics))
                 || (got && (got.plainLyrics || got.syncedLyrics) ? got : null)
                 || all.find(x => x.plainLyrics || x.syncedLyrics);
  if (plainPick) {
    return { lrc: null, plain: plainPick.plainLyrics || lrcToPlain(plainPick.syncedLyrics), source: "lrclib-plain" };
  }
  return null;
}

function packLrclib(hit) {
  return {
    lrc:        hit.syncedLyrics || null,
    plain:      hit.plainLyrics || lrcToPlain(hit.syncedLyrics),
    source:     "lrclib",
    duration_s: hit.duration || null, // remembered so callers can verify match
  };
}

// ── 2. Genius (plain only, scraped) ──────────────────────────────────────────
// Genius's API only returns the URL of the lyrics page; the lyrics themselves
// are inside data-lyrics-container divs on the HTML page. This scrape pattern
// is the standard one used by lyricsgenius/genius-lyrics-api. No-ops if
// GENIUS_ACCESS_TOKEN isn't set so the chain still works without it.

const GENIUS_UA = "Liri/1.0 (https://getliri.com)";

async function geniusSearch(trackName, artistName) {
  const token = process.env.GENIUS_ACCESS_TOKEN;
  if (!token) return null;
  const q = encodeURIComponent(`${trackName} ${artistName}`);
  const data = await getJson("api.genius.com", `/search?q=${q}`,
    { "Authorization": `Bearer ${token}`, "User-Agent": GENIUS_UA });
  const hits = data?.response?.hits || [];
  if (hits.length === 0) return null;
  // Prefer hits whose primary_artist matches
  const wantArtist = (artistName || "").toLowerCase();
  const byArtist = hits.find(h => (h.result?.primary_artist?.name || "").toLowerCase() === wantArtist);
  const pick = (byArtist || hits[0])?.result;
  return pick?.url || null;
}

async function geniusScrape(pageUrl) {
  try {
    const u = new URL(pageUrl);
    const r = await get(u.hostname, u.pathname + u.search, { "User-Agent": GENIUS_UA });
    if (r.status !== 200 || !r.raw) return null;
    return extractGeniusLyrics(r.raw);
  } catch { return null; }
}

// Parse out every <div data-lyrics-container="true">…</div>, convert <br> to
// newlines, strip remaining tags, decode common HTML entities.
function extractGeniusLyrics(html) {
  const out = [];
  const re = /<div[^>]*data-lyrics-container="true"[^>]*>([\s\S]*?)<\/div>/g;
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  if (out.length === 0) return null;
  const text = out.join("\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g,  "<")
    .replace(/&gt;/g,  ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g,  "'")
    .replace(/&nbsp;/g, " ")
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean)
    .join("\n");
  return text || null;
}

async function fetchGenius(trackName, artistName) {
  const url = await geniusSearch(trackName, artistName);
  if (!url) return null;
  const plain = await geniusScrape(url);
  if (!plain) return null;
  return { lrc: null, plain, source: "genius" };
}

// ── Public: try each provider in order ───────────────────────────────────────

async function fetchLyrics(trackName, artistName, albumName, durationSec) {
  const providers = [fetchLrclib, fetchGenius];
  for (const fn of providers) {
    try {
      const hit = await fn(trackName, artistName, albumName, durationSec);
      if (hit && (hit.lrc || hit.plain)) return hit;
    } catch { /* try next */ }
  }
  return null;
}

module.exports = {
  fetchLyrics,
  parseLrcToWords,
  lrcToPlain,
  // exported individually too, in case a caller wants to know which providers
  // hit/miss for diagnostics
  _providers: { fetchLrclib, fetchGenius },
};
