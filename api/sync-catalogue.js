// Liri — Monthly Catalogue Sync (Vercel Cron)
//
// Searches iTunes for a broad set of vinyl-friendly genres and upserts
// results into the `catalogue` table. Designed to run monthly via Vercel cron.
//
// Only stores lightweight data (name, artist, artwork, genre, year) —
// full track/lyrics/side data is fetched separately when a user adds an album.
//
// Triggered by Vercel cron — see vercel.json:
//   { "path": "/api/sync-catalogue", "schedule": "0 3 1 * *" }  ← 3am on the 1st of each month
//
// Can also be triggered manually by hitting the endpoint with the secret header:
//   curl -H "x-cron-secret: YOUR_SECRET" https://getliri.com/api/sync-catalogue
//
// Required Vercel env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (already set)
//   CRON_SECRET                              (add in Vercel dashboard — any random string)

const https = require("https");

// ── Helpers ───────────────────────────────────────────────────────────────────

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch { resolve(null); }
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("iTunes timeout")); });
  });
}

function sbUpsertBatch(rows) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return Promise.reject(new Error("Supabase env vars not set"));

  const hostname = url.replace(/^https?:\/\//, "");
  const bodyStr  = JSON.stringify(rows);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname,
      path: "/rest/v1/catalogue?on_conflict=itunes_collection_id",
      method: "POST",
      headers: {
        "apikey":          key,
        "Authorization":   `Bearer ${key}`,
        "Content-Type":    "application/json",
        "Prefer":          "resolution=merge-duplicates,return=minimal",
        "Content-Length":  Buffer.byteLength(bodyStr),
      }
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode }));
    });
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

// ── iTunes search ─────────────────────────────────────────────────────────────
// We search a set of terms that surface popular vinyl albums.
// iTunes doesn't have a "vinyl" filter so we search by genre + popularity.

const SEARCH_TERMS = [
  "rock", "classic rock", "indie rock", "alternative",
  "pop", "soul", "r&b", "funk", "blues",
  "jazz", "folk", "country", "reggae",
  "hip hop", "electronic", "punk", "metal",
];

async function searchItunesAlbums(term) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=album&limit=50&media=music`;
  try {
    const data = await httpsGet(url);
    return (data?.results || []).filter(r => r.wrapperType === "collection");
  } catch {
    return [];
  }
}

function albumToRow(album) {
  return {
    itunes_collection_id: album.collectionId,
    album_name:    album.collectionName,
    artist_name:   album.artistName,
    artwork_url:   (album.artworkUrl100 || "").replace("100x100bb", "600x600bb"),
    genre:         album.primaryGenreName || null,
    release_year:  album.releaseDate ? new Date(album.releaseDate).getFullYear() : null,
    track_count:   album.trackCount || null,
    last_synced_at: new Date().toISOString(),
  };
}

// ── Main handler ──────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  // Allow Vercel's cron runner OR manual trigger with a secret header
  const cronSecret = process.env.CRON_SECRET;
  const provided   = req.headers["x-cron-secret"] || req.headers["authorization"]?.replace("Bearer ", "");

  if (cronSecret && provided !== cronSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  console.log("[sync-catalogue] Starting monthly sync...");
  const stats = { terms: 0, found: 0, upserted: 0, errors: [] };

  for (const term of SEARCH_TERMS) {
    try {
      const albums = await searchItunesAlbums(term);
      stats.terms++;
      stats.found += albums.length;

      if (albums.length === 0) continue;

      const rows = albums.map(albumToRow);
      await sbUpsertBatch(rows);
      stats.upserted += rows.length;

      // Small delay between searches to be kind to iTunes
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      console.error(`[sync-catalogue] Error for term "${term}":`, e.message);
      stats.errors.push({ term, error: e.message });
    }
  }

  console.log("[sync-catalogue] Done:", stats);
  return res.status(200).json({ success: true, stats });
};
