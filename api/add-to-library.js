// Liri — Add Album to Library (Vercel)
//
// Discogs is the single source of truth for album and track data.
// iTunes is not used — Discogs has better vinyl catalog coverage and
// LRCLib matches lyrics by name, not by iTunes ID.
//
// Flow:
//   1. Fetch Discogs release → track list, artwork, metadata
//   2. Save catalogue + album_tracks + vinyl_sides to Supabase
//   3. Fetch lyrics from LRCLib per track (by name matching)
//   4. Link user → album in user_library
//
// Album data is shared across users — if another user already added
// the same release the heavy fetching is skipped entirely.
//
// Required Vercel env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   DISCOGS_KEY, DISCOGS_SECRET

const https = require("https");
const { verifyAuth, getSubscriptionTier } = require("./_lib/auth");

const FREE_ALBUM_LIMIT = 10;

// ── Generic HTTPS GET ─────────────────────────────────────────────────────────

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch { resolve({ status: res.statusCode, data: null }); }
      });
    });
    req.on("error", reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error("Request timed out")); });
  });
}

async function batchedAll(items, fn, batchSize = 3) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = await Promise.all(items.slice(i, i + batchSize).map(fn));
    results.push(...batch);
  }
  return results;
}

// ── Supabase helpers ──────────────────────────────────────────────────────────

function sbRequest(method, path, body) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return Promise.reject(new Error("Supabase env vars not set"));
  const hostname = url.replace(/^https?:\/\//, "");
  const bodyStr  = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname,
      path: `/rest/v1/${path}`,
      method,
      headers: {
        "apikey":        key,
        "Authorization": `Bearer ${key}`,
        "Content-Type":  "application/json",
        "Prefer":        "resolution=merge-duplicates,return=minimal",
        ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
      }
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch { resolve({ status: res.statusCode, data: null }); }
      });
    });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function upsert(table, row, onConflict) {
  const qs = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : "";
  return sbRequest("POST", `${table}${qs}`, row);
}

async function exists(table, col, val) {
  const { data } = await sbRequest("GET", `${table}?${col}=eq.${encodeURIComponent(val)}&select=id&limit=1`);
  return Array.isArray(data) && data.length > 0;
}

// ── LRCLib ────────────────────────────────────────────────────────────────────

async function fetchLrcLib(trackName, artistName, albumName, durationSec) {
  const params = new URLSearchParams({ track_name: trackName, artist_name: artistName, album_name: albumName });
  if (durationSec) params.set("duration", String(Math.round(durationSec)));
  const url = `https://lrclib.net/api/get?${params}`;
  try {
    const { data } = await httpsGet(url, { "Lrclib-Client": "Liri/1.0 (https://getliri.com)" });
    return data?.statusCode === 404 ? null : data;
  } catch { return null; }
}

function parseLrcToWords(lrc) {
  if (!lrc) return [];
  const timeRe = /^\[(\d{2}):(\d{2})\.(\d{2,3})\]/;
  const words   = [];
  for (const line of lrc.split("\n")) {
    const m = line.match(timeRe);
    if (!m) continue;
    const start_ms = (parseInt(m[1]) * 60 + parseInt(m[2])) * 1000
                   + parseInt(m[3].padEnd(3, "0").slice(0, 3));
    const text = line.replace(timeRe, "").trim();
    if (!text) continue;
    for (const raw of text.split(/\s+/)) {
      const word = raw.toLowerCase().replace(/[^a-z0-9']/g, "");
      if (word) words.push({ word, start_ms });
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

// ── Discogs ───────────────────────────────────────────────────────────────────

function discogsHeaders() {
  const key    = process.env.DISCOGS_KEY;
  const secret = process.env.DISCOGS_SECRET;
  return {
    "User-Agent": "Liri/1.0 +https://getliri.com",
    ...(key ? { "Authorization": `Discogs key=${key}, secret=${secret}` } : {}),
  };
}

async function fetchDiscogsRelease(releaseId) {
  const url = `https://api.discogs.com/releases/${releaseId}`;
  try {
    const { data } = await httpsGet(url, discogsHeaders());
    return data;
  } catch { return null; }
}

// Parse Discogs "M:SS" duration → milliseconds
function parseDuration(str) {
  if (!str) return null;
  const parts = str.split(":").map(Number);
  if (parts.length === 2 && !parts.some(isNaN)) return (parts[0] * 60 + parts[1]) * 1000;
  return null;
}

// Discogs release ID is used directly as itunes_collection_id (the field is just a primary key).
// Track IDs are release_id * 10000 + track_index to guarantee uniqueness.
const trackId = (releaseId, idx) => releaseId * 10000 + idx;

// ── Main handler ──────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  const ALLOWED = ["https://getliri.com", "https://www.getliri.com", "capacitor://localhost"];
  const origin  = req.headers.origin || "";
  res.setHeader("Access-Control-Allow-Origin", ALLOWED.includes(origin) ? origin : "https://getliri.com");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")   return res.status(405).json({ error: "Method not allowed" });

  // ── Auth ──────────────────────────────────────────────────────────────────
  const auth = await verifyAuth(req);
  if (!auth || auth._authError) {
    const reason = auth?._authError || "No auth result";
    console.error("[add-to-library] auth failed:", reason);
    return res.status(401).json({ error: "Session expired — please sign out and back in.", debug: reason });
  }

  const { discogs_release_id } = req.body || {};
  if (!discogs_release_id)
    return res.status(400).json({ error: "discogs_release_id required" });

  const releaseId     = parseInt(discogs_release_id, 10);
  const collectionId  = releaseId; // Discogs ID is our collection ID

  // ── Free tier limit ────────────────────────────────────────────────────────
  if (!auth.isUnlimited) {
    const tier = await getSubscriptionTier(auth.userId, false);
    if (tier === "free") {
      const { data: everRows } = await sbRequest(
        "GET",
        `user_library_ever?user_id=eq.${encodeURIComponent(auth.userId)}&itunes_collection_id=eq.${collectionId}&select=id&limit=1`
      );
      const wasEverAdded = Array.isArray(everRows) && everRows.length > 0;
      if (!wasEverAdded) {
        const { data: allEverRows } = await sbRequest(
          "GET", `user_library_ever?user_id=eq.${encodeURIComponent(auth.userId)}&select=id`
        );
        const everCount = Array.isArray(allEverRows) ? allEverRows.length : 0;
        if (everCount >= FREE_ALBUM_LIMIT) {
          return res.status(403).json({ error: "free_limit_reached", limit: FREE_ALBUM_LIMIT, count: everCount });
        }
      }
    }
  }

  try {
    const alreadyExists = await exists("catalogue", "itunes_collection_id", collectionId);

    if (!alreadyExists) {
      console.log(`[add-to-library] Fetching Discogs release ${releaseId}`);

      const release = await fetchDiscogsRelease(releaseId);
      if (!release) return res.status(404).json({ error: "Release not found on Discogs" });

      const artistName = (release.artists?.[0]?.name || "").replace(/\s*\(\d+\)$/, "").trim();
      const albumName  = release.title || "";
      const artworkUrl = release.images?.[0]?.uri || null;

      // Real tracks only — skip side headings (e.g. position "A" with no digit)
      const tracks = (release.tracklist || [])
        .filter(t => t.position && /\d/.test(t.position))
        .map((t, idx) => ({ ...t, _idx: idx }));

      // Derive disc_number from vinyl side letter (A/B = disc 1, C/D = disc 2, ...)
      const sides    = [...new Set(tracks.map(t => t.position.replace(/\d.*$/, "").toUpperCase()))];
      const sideDisc = Object.fromEntries(sides.map((s, i) => [s, Math.floor(i / 2) + 1]));

      // ── Save catalogue ───────────────────────────────────────────────────
      await upsert("catalogue", {
        itunes_collection_id: collectionId,
        album_name:    albumName,
        artist_name:   artistName,
        artwork_url:   artworkUrl,
        release_year:  release.year || null,
        track_count:   tracks.length,
        last_synced_at: new Date().toISOString(),
      }, "itunes_collection_id");

      // ── Save tracks + lyrics ─────────────────────────────────────────────
      await batchedAll(tracks, async (t) => {
        const side       = t.position.replace(/\d.*$/, "").toUpperCase();
        const tid        = trackId(releaseId, t._idx);
        const durationMs = parseDuration(t.duration);

        await upsert("album_tracks", {
          itunes_collection_id: collectionId,
          itunes_track_id:  tid,
          track_name:       t.title,
          artist_name:      artistName,
          track_number:     t._idx + 1,
          disc_number:      sideDisc[side] || 1,
          duration_ms:      durationMs,
        }, "itunes_track_id");

        const lrc = await fetchLrcLib(
          t.title, artistName, albumName,
          durationMs ? durationMs / 1000 : null
        );
        if (lrc?.syncedLyrics || lrc?.plainLyrics) {
          await upsert("track_lyrics", {
            itunes_track_id: tid,
            lrc_raw:      lrc.syncedLyrics || null,
            lyrics_plain: lrc.plainLyrics || lrcToPlain(lrc.syncedLyrics),
            words_json:   lrc.syncedLyrics ? parseLrcToWords(lrc.syncedLyrics) : null,
            source:       "lrclib",
            fetched_at:   new Date().toISOString(),
          }, "itunes_track_id");
        }
      }, 3);

      // ── Save vinyl sides ─────────────────────────────────────────────────
      try {
        await batchedAll(tracks, (t) => {
          const side              = t.position.replace(/\d.*$/, "").toUpperCase();
          const side_track_number = parseInt(t.position.replace(/^[A-Za-z]+/, "")) || (t._idx + 1);
          return upsert("vinyl_sides", {
            itunes_collection_id: collectionId,
            itunes_track_id:    trackId(releaseId, t._idx),
            discogs_release_id: releaseId,
            discogs_master_id:  release.master_id || null,
            side,
            side_track_number,
            position:           t.position.toUpperCase(),
            fetched_at:         new Date().toISOString(),
          }, "itunes_track_id");
        }, 5);
      } catch (e) {
        console.warn("[add-to-library] vinyl_sides failed (non-fatal):", e.message);
      }

    } else {
      console.log(`[add-to-library] Release ${releaseId} already in DB — skipping fetch`);
    }

    // ── Link user → album ────────────────────────────────────────────────────
    await upsert("user_library", {
      user_id:              auth.userId,
      itunes_collection_id: collectionId,
      added_at:             new Date().toISOString(),
    }, "user_id,itunes_collection_id");

    await upsert("user_library_ever", {
      user_id:              auth.userId,
      itunes_collection_id: collectionId,
      first_added_at:       new Date().toISOString(),
    }, "user_id,itunes_collection_id");

    return res.status(200).json({ success: true, cached: alreadyExists });

  } catch (e) {
    console.error("[add-to-library] error:", e.message);
    return res.status(500).json({ error: "Failed to add album. Please try again." });
  }
};
