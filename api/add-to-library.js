// Liri — Add Album to Library (Vercel)
//
// Called when a user adds an album. Fetches all data in one shot:
//   iTunes  → track list, metadata
//   LRCLib  → timestamped lyrics per track (stored as words_json for matching)
//   Discogs → vinyl side layout (A1, B2, etc.)
//
// Album data (tracks, lyrics, sides) is shared across users — if another
// user already added the same album the heavy fetching is skipped entirely.
// Only the user_library row is always created.
//
// Required Vercel env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (already set)
//   DISCOGS_KEY, DISCOGS_SECRET              (add in Vercel dashboard)

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

// Run promises in small batches to avoid hammering external APIs
async function batchedAll(items, fn, batchSize = 3) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = await Promise.all(items.slice(i, i + batchSize).map(fn));
    results.push(...batch);
  }
  return results;
}

// ── Supabase helpers (service role, bypasses RLS) ─────────────────────────────

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

// ── iTunes ────────────────────────────────────────────────────────────────────

async function fetchItunesTracks(collectionId) {
  const url = `https://itunes.apple.com/lookup?id=${collectionId}&entity=song&limit=200`;
  const { data } = await httpsGet(url);
  if (!data?.results?.length) return { album: null, tracks: [] };

  const album  = data.results.find(r => r.wrapperType === "collection") || data.results[0];
  const tracks = data.results
    .filter(r => r.wrapperType === "track" && r.kind === "song")
    .sort((a, b) => (a.discNumber - b.discNumber) || (a.trackNumber - b.trackNumber));

  return { album, tracks };
}

// ── LRCLib ────────────────────────────────────────────────────────────────────

async function fetchLrcLib(trackName, artistName, albumName, durationSec) {
  const params = new URLSearchParams({ track_name: trackName, artist_name: artistName, album_name: albumName });
  if (durationSec) params.set("duration", String(Math.round(durationSec)));
  const url = `https://lrclib.net/api/get?${params}`;
  try {
    const { data } = await httpsGet(url, { "Lrclib-Client": "Liri/1.0 (https://getliri.com)" });
    return data?.statusCode === 404 ? null : data;
  } catch {
    return null;
  }
}

// Parse LRC into words array: [{word, start_ms}, ...]
// All words in a line share the line's timestamp — good enough for exact matching.
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
    .filter(Boolean)
    .join("\n");
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

async function searchDiscogs(artist, album) {
  const q = encodeURIComponent(`${artist} ${album}`);
  const url = `https://api.discogs.com/database/search?q=${q}&type=release&format=Vinyl&per_page=5`;
  try {
    const { data } = await httpsGet(url, discogsHeaders());
    return data?.results || [];
  } catch {
    return [];
  }
}

async function fetchDiscogsRelease(releaseId) {
  const url = `https://api.discogs.com/releases/${releaseId}`;
  try {
    const { data } = await httpsGet(url, discogsHeaders());
    return data;
  } catch {
    return null;
  }
}

// Map Discogs tracklist → iTunes tracks by index.
// Discogs positions look like "A1", "A2", "B1", "B2" — we strip the number for the side.
function mapSides(discogsTracklist, itunesTracks) {
  // Filter out side headings (those have no digit in position, e.g. just "A")
  const realTracks = discogsTracklist.filter(t => t.position && /\d/.test(t.position));

  return itunesTracks.map((track, i) => {
    const dt = realTracks[i];
    if (!dt) return null;
    const side             = dt.position.replace(/\d.*$/, "").toUpperCase(); // "A", "B", "C"...
    const side_track_number = parseInt(dt.position.replace(/^[A-Za-z]+/, "")) || (i + 1);
    return {
      itunes_track_id:    track.trackId,
      position:           dt.position.toUpperCase(),
      side,
      side_track_number,
    };
  }).filter(Boolean);
}

// ── Main handler ──────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  const ALLOWED = ["https://getliri.com", "https://www.getliri.com", "capacitor://localhost"];
  const origin  = req.headers.origin || "";
  res.setHeader("Access-Control-Allow-Origin", ALLOWED.includes(origin) ? origin : "https://getliri.com");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")   return res.status(405).json({ error: "Method not allowed" });

  // ── Auth ────────────────────────────────────────────────────────────────────
  const auth = await verifyAuth(req);
  if (!auth || auth._authError) {
    const reason = auth?._authError || "No auth result";
    console.error("[add-to-library] auth failed:", reason);
    return res.status(401).json({ error: "Session expired — please sign out and back in.", debug: reason });
  }

  const { itunes_collection_id } = req.body || {};
  if (!itunes_collection_id) return res.status(400).json({ error: "itunes_collection_id required" });
  const collectionId = parseInt(itunes_collection_id, 10);

  // ── Free tier limit: 10 albums max (counts ever-added, not current library) ──
  if (!auth.isUnlimited) {
    const tier = await getSubscriptionTier(auth.userId, false);
    if (tier === "free") {
      // Check if this album was ever added by this user — if so, re-add is free
      const { data: everRows } = await sbRequest(
        "GET",
        `user_library_ever?user_id=eq.${encodeURIComponent(auth.userId)}&itunes_collection_id=eq.${collectionId}&select=id&limit=1`
      );
      const wasEverAdded = Array.isArray(everRows) && everRows.length > 0;
      if (!wasEverAdded) {
        // New album — check against the ever-added count
        const { data: allEverRows } = await sbRequest(
          "GET",
          `user_library_ever?user_id=eq.${encodeURIComponent(auth.userId)}&select=id`
        );
        const everCount = Array.isArray(allEverRows) ? allEverRows.length : 0;
        if (everCount >= FREE_ALBUM_LIMIT) {
          return res.status(403).json({
            error: "free_limit_reached",
            limit: FREE_ALBUM_LIMIT,
            count: everCount,
          });
        }
      }
    }
  }

  try {
    // ── Step 1: Skip heavy fetching if another user already added this album ──
    const alreadyExists = await exists("catalogue", "itunes_collection_id", collectionId);

    if (!alreadyExists) {
      console.log(`[add-to-library] Fetching data for new album ${collectionId}`);

      // ── Step 2: iTunes ──────────────────────────────────────────────────────
      const { album, tracks } = await fetchItunesTracks(collectionId);
      if (!album || !tracks.length) {
        return res.status(404).json({ error: "Album not found on iTunes" });
      }

      const artistName = album.artistName || tracks[0]?.artistName || "";
      const albumName  = album.collectionName || "";

      // ── Step 3: Save to catalogue ───────────────────────────────────────────
      await upsert("catalogue", {
        itunes_collection_id: collectionId,
        album_name:    albumName,
        artist_name:   artistName,
        artwork_url:   (album.artworkUrl100 || "").replace("100x100bb", "600x600bb"),
        genre:         album.primaryGenreName || null,
        release_year:  album.releaseDate ? new Date(album.releaseDate).getFullYear() : null,
        track_count:   tracks.length,
        last_synced_at: new Date().toISOString(),
      }, "itunes_collection_id");

      // ── Step 4: Save tracks + lyrics (batched to be kind to LRCLib) ─────────
      await batchedAll(tracks, async (track) => {
        // Track row
        await upsert("album_tracks", {
          itunes_collection_id: collectionId,
          itunes_track_id: track.trackId,
          track_name:      track.trackName,
          artist_name:     track.artistName,
          track_number:    track.trackNumber,
          disc_number:     track.discNumber  || 1,
          duration_ms:     track.trackTimeMillis || null,
          // bpm: null — will be enriched separately in the future
        }, "itunes_track_id");

        // Lyrics
        const lrc = await fetchLrcLib(
          track.trackName,
          track.artistName,
          albumName,
          track.trackTimeMillis ? track.trackTimeMillis / 1000 : null
        );

        if (lrc && (lrc.syncedLyrics || lrc.plainLyrics)) {
          await upsert("track_lyrics", {
            itunes_track_id: track.trackId,
            lrc_raw:      lrc.syncedLyrics || null,
            lyrics_plain: lrc.plainLyrics  || lrcToPlain(lrc.syncedLyrics),
            words_json:   lrc.syncedLyrics ? parseLrcToWords(lrc.syncedLyrics) : null,
            source:       "lrclib",
            fetched_at:   new Date().toISOString(),
          }, "itunes_track_id");
        }
      }, 3); // 3 tracks at a time

      // ── Step 5: Discogs side data (non-fatal if it fails) ───────────────────
      try {
        const results = await searchDiscogs(artistName, albumName);
        const best    = results[0];

        if (best?.id) {
          const release = await fetchDiscogsRelease(best.id);
          if (release?.tracklist?.length) {
            const mapped = mapSides(release.tracklist, tracks);
            await batchedAll(mapped, (m) =>
              upsert("vinyl_sides", {
                itunes_collection_id: collectionId,
                itunes_track_id:    m.itunes_track_id,
                discogs_release_id: best.id,
                discogs_master_id:  best.master_id || null,
                side:               m.side,
                side_track_number:  m.side_track_number,
                position:           m.position,
                fetched_at:         new Date().toISOString(),
              }, "itunes_track_id")
            , 5);
          }
        }
      } catch (e) {
        console.warn("[add-to-library] Discogs fetch failed (non-fatal):", e.message);
      }
    } else {
      console.log(`[add-to-library] Album ${collectionId} already in DB — skipping fetch`);
    }

    // ── Step 6: Always link this user to the album ───────────────────────────
    await upsert("user_library", {
      user_id:              auth.userId,
      itunes_collection_id: collectionId,
      added_at:             new Date().toISOString(),
    }, "user_id,itunes_collection_id");

    // ── Step 7: Record in ever-added history (never deleted) ─────────────────
    await upsert("user_library_ever", {
      user_id:              auth.userId,
      itunes_collection_id: collectionId,
      first_added_at:       new Date().toISOString(),
    }, "user_id,itunes_collection_id");

    return res.status(200).json({
      success: true,
      cached: alreadyExists,
    });

  } catch (e) {
    console.error("[add-to-library] error:", e.message);
    return res.status(500).json({ error: "Failed to add album. Please try again." });
  }
};
