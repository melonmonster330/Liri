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

// ── Supabase helpers ──────────────────────────────────────────────────────────

function sbGet(path, extraHeaders = {}) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const hostname = url.replace(/^https?:\/\//, "");
  return new Promise((resolve) => {
    const req = https.request({ hostname, path: `/rest/v1/${path}`, method: "GET",
      headers: { "apikey": key, "Authorization": `Bearer ${key}`, "Content-Type": "application/json", ...extraHeaders }
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()), headers: res.headers }); }
        catch { resolve({ status: res.statusCode, body: null, headers: res.headers }); }
      });
    });
    req.on("error", () => resolve({ status: 0, body: null, headers: {} }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ status: 0, body: null, headers: {} }); });
    req.end();
  });
}

function sbAdminGet(path) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const hostname = url.replace(/^https?:\/\//, "");
  return new Promise((resolve) => {
    const req = https.request({ hostname, path: `/auth/v1/${path}`, method: "GET",
      headers: { "apikey": key, "Authorization": `Bearer ${key}` }
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function getAdminStats() {
  const now = new Date();
  const d7  = new Date(now - 7  * 86400000).toISOString();
  const d30 = new Date(now - 30 * 86400000).toISOString();
  const d1  = new Date(now - 1  * 86400000).toISOString();

  const [usersResp, libraryResp, eventsResp, subsResp, releasesResp, flipsResp] = await Promise.all([
    sbAdminGet("admin/users?page=1&per_page=1000"),
    sbGet("user_vinyl_library?select=user_id,added_at&order=added_at.desc&limit=5000"),
    sbGet("listening_events?select=platform,source,album_name,artist_name,logged_at&order=logged_at.desc&limit=2000"),
    sbGet("subscriptions?select=tier,status"),
    sbGet("vinyl_releases?select=id&limit=1", { "Prefer": "count=exact" }),
    sbGet("flip_events?select=id&limit=1", { "Prefer": "count=exact" }),
  ]);

  // Users
  const allUsers = usersResp?.users || [];
  const totalUsers = allUsers.length;
  const newUsers7d  = allUsers.filter(u => u.created_at > d7).length;
  const newUsers30d = allUsers.filter(u => u.created_at > d30).length;
  const recentSignups = allUsers
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 8)
    .map(u => ({ email: u.email, created_at: u.created_at }));

  // Library
  const libraryRows = Array.isArray(libraryResp.body) ? libraryResp.body : [];
  const totalAlbums = libraryRows.length;
  const uniqueLibUsers = new Set(libraryRows.map(r => r.user_id)).size;
  const avgAlbums = uniqueLibUsers > 0 ? (totalAlbums / uniqueLibUsers).toFixed(1) : 0;

  // Listening events
  const events = Array.isArray(eventsResp.body) ? eventsResp.body : [];
  const totalPlays  = events.length;
  const plays7d     = events.filter(e => e.logged_at > d7).length;
  const plays1d     = events.filter(e => e.logged_at > d1).length;
  const webPlays    = events.filter(e => e.platform === "web").length;
  const iosPlays    = events.filter(e => e.platform === "ios").length;
  const recogPlays  = events.filter(e => e.source === "recognition").length;
  const autoPlays   = events.filter(e => e.source === "auto_advance").length;

  // Top albums (last 30d)
  const recentEvents = events.filter(e => e.logged_at > d30);
  const albumCounts = {};
  for (const e of recentEvents) {
    if (!e.album_name) continue;
    const key = `${e.album_name}|||${e.artist_name || ""}`;
    albumCounts[key] = (albumCounts[key] || 0) + 1;
  }
  const topAlbums = Object.entries(albumCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([key, count]) => { const [album, artist] = key.split("|||"); return { album, artist, count }; });

  // Subscriptions
  const subs = Array.isArray(subsResp.body) ? subsResp.body : [];
  const premiumUsers = subs.filter(s => s.tier === "premium" && ["active","trialing"].includes(s.status)).length;

  // Catalogue & flips
  const catalogueTotal = parseInt(releasesResp.headers?.["content-range"]?.split("/")[1] || "0", 10);
  const totalFlips     = parseInt(flipsResp.headers?.["content-range"]?.split("/")[1] || "0", 10);

  return {
    users:    { total: totalUsers, new7d: newUsers7d, new30d: newUsers30d, premium: premiumUsers, recentSignups },
    library:  { totalAlbums, uniqueUsers: uniqueLibUsers, avgAlbums },
    plays:    { total: totalPlays, last7d: plays7d, last24h: plays1d, web: webPlays, ios: iosPlays, recognition: recogPlays, autoAdvance: autoPlays },
    topAlbums,
    catalogue: { releases: catalogueTotal, flips: totalFlips },
    generatedAt: now.toISOString(),
  };
}

// ── Main handler ──────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  // ── GET: admin dashboard stats ─────────────────────────────────────────────
  if (req.method === "GET") {
    const adminPw  = process.env.ADMIN_PASSWORD;
    const provided = req.headers["x-admin-password"];
    if (!adminPw || provided !== adminPw) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      const stats = await getAdminStats();
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json(stats);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST: cron sync (existing behaviour) ──────────────────────────────────
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
