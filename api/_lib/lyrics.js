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

async function lrclibSearch(trackName, artistName, albumName) {
  const params = new URLSearchParams({ track_name: trackName, artist_name: artistName });
  const data = await getJson("lrclib.net", `/api/search?${params}`,
    { "Lrclib-Client": "Liri/1.0 (https://getliri.com)" });
  if (!Array.isArray(data) || data.length === 0) return null;
  const wantAlbum = (albumName || "").toLowerCase();
  const byAlbum = data.find(x => (x.albumName || "").toLowerCase() === wantAlbum);
  const synced  = data.find(x => x.syncedLyrics);
  return byAlbum || synced || data[0];
}

async function fetchLrclib(trackName, artistName, albumName, durationSec) {
  if (durationSec) {
    const p = new URLSearchParams({
      track_name: trackName, artist_name: artistName, album_name: albumName,
      duration: String(Math.round(durationSec)),
    });
    const hit = await lrclibGetOnce(p);
    if (hit?.syncedLyrics || hit?.plainLyrics) return packLrclib(hit);
  }
  const p2 = new URLSearchParams({
    track_name: trackName, artist_name: artistName, album_name: albumName,
  });
  const hit = await lrclibGetOnce(p2);
  if (hit?.syncedLyrics || hit?.plainLyrics) return packLrclib(hit);
  const hit2 = await lrclibSearch(trackName, artistName, albumName);
  if (hit2?.syncedLyrics || hit2?.plainLyrics) return packLrclib(hit2);
  return null;
}

function packLrclib(hit) {
  return {
    lrc:    hit.syncedLyrics || null,
    plain:  hit.plainLyrics || lrcToPlain(hit.syncedLyrics),
    source: "lrclib",
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
