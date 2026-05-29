// Liri — Re-fetch track_lyrics with the improved logic
//
// Many albums were added under an older fetchLyrics that fell through to a
// non-duration-matched LRClib version when Discogs lacked per-track durations,
// producing lyrics whose timestamps don't match the pressing and drift every
// song. The new fetchLyrics (api/_lib/lyrics.js) uses iTunes as a secondary
// duration source and refuses to store wrong-tempo synced lyrics. This endpoint
// re-runs that fetcher against existing rows so already-added albums get fixed
// without users having to remove/re-add anything.
//
// Auth: x-cron-secret header (same as sync-catalogue).
//
// Modes:
//   POST /api/refresh-lyrics?collection_id=12345
//     → refresh every track on that album
//   POST /api/refresh-lyrics?sweep=1&limit=50&offset=0
//     → process the next `limit` tracks across all albums; repeat with
//       offset = previous nextOffset until done=true
//
// Never downgrades: a track with synced lyrics is only replaced if the new
// pass also returns synced (since the new fetcher only returns synced when
// duration-matched, that means the replacement is verified-correct).

const crypto = require("crypto");
const https  = require("https");
const { fetchLyrics, parseLrcToWords } = require("./_lib/lyrics");

function safeCompare(a, b) {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Supabase REST helpers (service role) ─────────────────────────────────────

function sbRequest(method, path, body) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return Promise.resolve({ status: 0, data: null });

  const hostname = url.replace(/^https?:\/\//, "");
  const bodyStr  = body ? JSON.stringify(body) : "";

  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  if (method === "POST" || method === "PATCH") {
    headers.Prefer = "resolution=merge-duplicates,return=minimal";
  }
  if (body) headers["Content-Length"] = Buffer.byteLength(bodyStr);

  return new Promise((resolve) => {
    const req = https.request({ hostname, path: `/rest/v1/${path}`, method, headers }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        let data = null; try { data = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, data });
      });
    });
    req.on("error", () => resolve({ status: 0, data: null }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ status: 0, data: null }); });
    if (body) req.write(bodyStr);
    req.end();
  });
}

// ── Replace policy: never downgrade ──────────────────────────────────────────
// New chain only returns synced lyrics when duration-matched; if it returns
// only plain text, we keep whatever's already stored (which might be old wrong-
// tempo synced, but plain text wouldn't be an upgrade either way).
function shouldReplace(stored, fresh) {
  if (!fresh) return false;
  if (fresh.lrc) return fresh.lrc !== (stored.lrc_raw || null);
  if (stored.lrc_raw) return false; // never replace synced with plain
  return (fresh.plain || "") !== (stored.lyrics_plain || "");
}

async function refreshOne(track, album_name, stored) {
  const fresh = await fetchLyrics(
    track.track_name, track.artist_name, album_name,
    track.duration_ms ? track.duration_ms / 1000 : null
  ).catch(() => null);

  if (!fresh) return { itunes_track_id: track.itunes_track_id, status: "no_lyrics_found" };
  if (!shouldReplace(stored, fresh)) {
    return { itunes_track_id: track.itunes_track_id, status: "kept_existing" };
  }

  const row = {
    itunes_track_id: track.itunes_track_id,
    lrc_raw:      fresh.lrc || null,
    lyrics_plain: fresh.plain || null,
    words_json:   fresh.lrc ? parseLrcToWords(fresh.lrc) : null,
    source:       fresh.source,
    fetched_at:   new Date().toISOString(),
  };
  const { status } = await sbRequest("POST", "track_lyrics?on_conflict=itunes_track_id", [row]);
  return {
    itunes_track_id: track.itunes_track_id,
    status: status < 300
      ? (fresh.lrc ? "updated_synced" : "updated_plain")
      : `error_${status}`,
  };
}

// ── Main handler ─────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const cronSecret = process.env.CRON_SECRET;
  const provided   = req.headers["x-cron-secret"]
                  || req.headers["authorization"]?.replace("Bearer ", "");
  if (!cronSecret || !provided || !safeCompare(cronSecret, provided)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const url          = new URL(req.url || "/", "http://x");
  const collectionId = url.searchParams.get("collection_id");
  const sweep        = url.searchParams.get("sweep") === "1";
  const limit        = Math.min(parseInt(url.searchParams.get("limit")  || "50", 10), 200);
  const offset       = parseInt(url.searchParams.get("offset") || "0", 10);

  if (!collectionId && !sweep) {
    return res.status(400).json({ error: "pass ?collection_id=X or ?sweep=1" });
  }

  // ── Load the tracks to process ───────────────────────────────────────────
  const trackPath = collectionId
    ? `album_tracks?itunes_collection_id=eq.${encodeURIComponent(collectionId)}&select=itunes_track_id,track_name,artist_name,itunes_collection_id,duration_ms`
    : `album_tracks?select=itunes_track_id,track_name,artist_name,itunes_collection_id,duration_ms&order=itunes_track_id.asc&limit=${limit}&offset=${offset}`;

  const { data: tracks } = await sbRequest("GET", trackPath);
  if (!Array.isArray(tracks) || tracks.length === 0) {
    return res.status(200).json({ processed: 0, results: [], done: true });
  }

  // ── Resolve album names for the cids in this batch ───────────────────────
  const cids = [...new Set(tracks.map(t => t.itunes_collection_id).filter(x => x != null))];
  const albumNameByCid = new Map();
  if (cids.length > 0) {
    const { data: cats } = await sbRequest(
      "GET",
      `catalogue?itunes_collection_id=in.(${cids.join(",")})&select=itunes_collection_id,album_name`
    );
    for (const c of (cats || [])) albumNameByCid.set(c.itunes_collection_id, c.album_name);
  }

  // ── Load currently-stored lyrics in one batch ────────────────────────────
  const tids = tracks.map(t => t.itunes_track_id).filter(x => x != null);
  const { data: lyricRows } = await sbRequest(
    "GET",
    `track_lyrics?itunes_track_id=in.(${tids.join(",")})&select=itunes_track_id,lrc_raw,lyrics_plain,source`
  );
  const storedByTid = new Map((lyricRows || []).map(r => [r.itunes_track_id, r]));

  // ── Process sequentially with a small delay (be kind to iTunes/LRClib) ──
  const results = [];
  for (const t of tracks) {
    const stored     = storedByTid.get(t.itunes_track_id) || {};
    const album_name = albumNameByCid.get(t.itunes_collection_id) || "";
    const r = await refreshOne(t, album_name, stored);
    results.push(r);
    await sleep(250);
  }

  const counts = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});

  res.status(200).json({
    processed: results.length,
    counts,
    nextOffset: sweep ? offset + tracks.length : null,
    done:       sweep ? tracks.length < limit : true,
    results,
  });
};
