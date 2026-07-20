// Liri — Weekly Catalogue Sync (Vercel Cron)
//
// Two passes, both upserting lightweight rows into the `catalogue` table:
//   1. Genre sweep — searches iTunes for a broad set of vinyl-friendly genres.
//   2. New releases — pulls Apple's "Top Albums" RSS feed so freshly released
//      music (most new music drops on Fridays) surfaces in the browse grid
//      without waiting weeks for it to climb a genre search.
//
// Only stores lightweight data (name, artist, artwork, genre, year) —
// full track/lyrics/side data is fetched separately when a user adds an album.
//
// Triggered by Vercel cron — see vercel.json:
//   { "path": "/api/sync-catalogue", "schedule": "0 3 * * 5" }  ← 3am every Friday
//
// Can also be triggered manually by hitting the endpoint with the secret header:
//   curl -H "x-cron-secret: YOUR_SECRET" https://getliri.com/api/sync-catalogue
//
// Required Vercel env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (already set)
//   CRON_SECRET                              (add in Vercel dashboard — any random string)

const https  = require("https");
const crypto = require("crypto");
const { parseLrcToWords, lrcToPlain } = require("./_lib/lyrics");

function safeCompare(a, b) {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Mask PII: "helen@gmail.com" → "hel***@gmail.com"
function maskEmail(email) {
  if (!email) return null;
  const s = String(email);
  const at = s.indexOf("@");
  if (at < 0) return s.length > 3 ? s.slice(0, 3) + "***" : "***";
  const local = s.slice(0, at), domain = s.slice(at);
  return (local.length >= 3 ? local.slice(0, 3) : local) + "***" + domain;
}

// Rank maintenance work by a blend of current listener demand and durable
// popularity. A recent play gets a strong three-week-decay boost; lifetime
// plays use a log curve so one huge album cannot permanently bury everything
// else. Auto-advance rows are continuations, not new album plays.
function buildAlbumActivity(rows) {
  const byCollection = new Map();
  for (const row of rows || []) {
    if (row.itunes_collection_id == null || row.source === "auto_advance") continue;
    const key = String(row.itunes_collection_id);
    const current = byCollection.get(key) || { play_count: 0, last_played_at: null };
    current.play_count += 1;
    if (row.listened_at && (!current.last_played_at
        || new Date(row.listened_at) > new Date(current.last_played_at))) {
      current.last_played_at = row.listened_at;
    }
    byCollection.set(key, current);
  }
  for (const activity of byCollection.values()) {
    const ageDays = activity.last_played_at
      ? Math.max(0, (Date.now() - new Date(activity.last_played_at).getTime()) / 86400000)
      : Infinity;
    activity.activity_score = 24 * Math.exp(-ageDays / 21)
      + 6 * Math.log2(activity.play_count + 1);
  }
  return byCollection;
}

function activityFor(activityMap, collectionId) {
  return activityMap.get(String(collectionId))
    || { play_count: 0, last_played_at: null, activity_score: 0 };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function httpsGet(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      // Follow redirects — Apple's RSS feed host 301s to a CDN.
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(httpsGet(next, redirects - 1));
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch { resolve(null); }
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("request timeout")); });
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

// Generic service-role DELETE (used by add-vinyl-sides to wipe old rows).
function sbDelete(path) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const hostname = url.replace(/^https?:\/\//, "");
  return new Promise((resolve) => {
    const req = https.request({
      hostname, path: `/rest/v1/${path}`, method: "DELETE",
      headers: { "apikey": key, "Authorization": `Bearer ${key}`, "Content-Type": "application/json" }
    }, (res) => { res.on("data", () => {}); res.on("end", () => resolve({ status: res.statusCode })); });
    req.on("error", () => resolve({ status: 0 }));
    req.end();
  });
}

// Generic service-role upsert — path must include ?on_conflict=<col>.
function sbUpsert(pathWithConflict, rows) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const hostname = url.replace(/^https?:\/\//, "");
  const bodyStr  = JSON.stringify(rows);
  return new Promise((resolve) => {
    const req = https.request({ hostname, path: `/rest/v1/${pathWithConflict}`, method: "POST",
      headers: { "apikey": key, "Authorization": `Bearer ${key}`, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=minimal", "Content-Length": Buffer.byteLength(bodyStr) }
    }, (res) => { res.on("data", () => {}); res.on("end", () => resolve({ status: res.statusCode })); });
    req.on("error", () => resolve({ status: 0 }));
    req.write(bodyStr); req.end();
  });
}

// Generic service-role insert (used by the admin "post Liri update" action).
function sbInsert(table, row) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const hostname = url.replace(/^https?:\/\//, "");
  const bodyStr  = JSON.stringify(row);
  return new Promise((resolve) => {
    const req = https.request({ hostname, path: `/rest/v1/${table}`, method: "POST",
      headers: { "apikey": key, "Authorization": `Bearer ${key}`, "Content-Type": "application/json", "Prefer": "return=minimal", "Content-Length": Buffer.byteLength(bodyStr) }
    }, (res) => { res.on("data", () => {}); res.on("end", () => resolve({ status: res.statusCode })); });
    req.on("error", () => resolve({ status: 0 }));
    req.write(bodyStr); req.end();
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

// ── New releases (Apple RSS) ───────────────────────────────────────────────────
// Apple's "Top Albums" feed is refreshed constantly and surfaces brand-new
// releases right away. The feed `id` IS the iTunes collection id, so rows line
// up with the genre-sweep rows. Note: feed host 301s — httpsGet follows it.
async function fetchNewReleases(limit = 100) {
  const url = `https://rss.applemarketingtools.com/api/v2/us/music/most-played/${limit}/albums.json`;
  try {
    const data = await httpsGet(url);
    return data?.feed?.results || [];
  } catch {
    return [];
  }
}

function rssAlbumToRow(a) {
  // Prefer a real genre over the catch-all "Music" entry.
  const genre = (a.genres || []).find(g => g.name && g.name !== "Music")?.name
             || a.genres?.[0]?.name || null;
  return {
    itunes_collection_id: parseInt(a.id, 10),
    album_name:    a.name,
    artist_name:   a.artistName,
    artwork_url:   (a.artworkUrl100 || "").replace("100x100bb", "600x600bb"),
    genre,
    release_year:  a.releaseDate ? new Date(a.releaseDate).getFullYear() : null,
    track_count:   null,
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

async function getAdminStats(days = 3) {
  const now   = new Date();
  const dWin  = days > 0 ? new Date(now - days * 86400000).toISOString() : null;
  const d7    = new Date(now - 7  * 86400000).toISOString();
  const d30   = new Date(now - 30 * 86400000).toISOString();

  // Paginate auth admin API — 1000 per page, loop until exhausted
  const allUsers = [];
  for (let page = 1; ; page++) {
    const resp = await sbAdminGet(`admin/users?page=${page}&per_page=1000`);
    const batch = resp?.users || [];
    allUsers.push(...batch);
    if (batch.length < 1000) break;
  }

  // Parallel: exact-count queries for totals + data queries for breakdowns
  // A "listen" = an album load (any event whose source isn't auto_advance).
  // auto_advance rows are the per-track continuations of a side, so they're
  // excluded from listens and only counted in the separate all-rows songs total.
  const [
    totalPlaysResp,
    playsWinResp,
    plays7dResp,
    totalSongsResp,
    totalLibResp,
    eventsResp,
    libResp,
    subsResp,
    releasesResp,
    flipsResp,
    bugsResp,
    bugsBacklogResp,
  ] = await Promise.all([
    // Null-safe "not auto_advance" — legacy rows with a null source still count
    // as listens (matches stats.html's JS `source !== "auto_advance"`).
    sbGet("listening_events?select=id&or=(source.is.null,source.neq.auto_advance)&limit=1",                                  { "Prefer": "count=exact" }),
    sbGet(`listening_events?select=id&or=(source.is.null,source.neq.auto_advance)${dWin ? `&listened_at=gte.${dWin}` : ""}&limit=1`, { "Prefer": "count=exact" }),
    sbGet(`listening_events?select=id&or=(source.is.null,source.neq.auto_advance)&listened_at=gte.${d7}&limit=1`,                  { "Prefer": "count=exact" }),
    sbGet("listening_events?select=id&limit=1",                                  { "Prefer": "count=exact" }),
    sbGet("user_vinyl_library?select=id&limit=1",                                { "Prefer": "count=exact" }),
    sbGet("listening_events?select=user_id,platform,source,album_name,artist_name,listened_at&order=listened_at.desc&limit=5000"),
    sbGet("user_vinyl_library?select=user_id&limit=20000"),
    sbGet("subscriptions?select=tier,status"),
    sbGet("vinyl_releases?select=id&limit=1",                                    { "Prefer": "count=exact" }),
    sbGet("flip_events?select=id&limit=1",                                       { "Prefer": "count=exact" }),
    // Default to open bugs only — backlog/fixed/wontfix are hidden from the
    // main view but still queryable via ?action=bugs&status=backlog
    sbGet("bug_reports?status=eq.open&select=id,created_at,user_email,app_version,platform,description,meta,status,retry_count&order=created_at.desc&limit=50"),
    sbGet("bug_reports?status=eq.backlog&select=id&limit=1", { "Prefer": "count=exact" }),
  ]);
  const backlogTotal = parseInt(bugsBacklogResp?.headers?.["content-range"]?.split("/")[1] || "0", 10);

  // Users
  const totalUsers  = allUsers.length;
  const newUsers7d  = allUsers.filter(u => u.created_at > d7).length;
  const newUsers30d = allUsers.filter(u => u.created_at > d30).length;
  const recentSignups = allUsers
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 8)
    .map(u => ({ email: maskEmail(u.email), created_at: u.created_at }));

  // Library — exact total from count header, unique users from fetched rows
  const totalAlbums   = parseInt(totalLibResp.headers?.["content-range"]?.split("/")[1] || "0", 10);
  const libRows       = Array.isArray(libResp.body) ? libResp.body : [];
  const uniqueLibUsers = new Set(libRows.map(r => r.user_id)).size;
  const avgAlbums     = uniqueLibUsers > 0 ? (totalAlbums / uniqueLibUsers).toFixed(1) : 0;

  // Listens (album loads) + songs (all rows) — exact counts from count headers
  const totalPlays  = parseInt(totalPlaysResp.headers?.["content-range"]?.split("/")[1] || "0", 10);
  const playsWindow = parseInt(playsWinResp.headers?.["content-range"]?.split("/")[1] || "0", 10);
  const plays7d     = parseInt(plays7dResp.headers?.["content-range"]?.split("/")[1] || "0", 10);
  const totalSongs  = parseInt(totalSongsResp.headers?.["content-range"]?.split("/")[1] || "0", 10);

  // Platform / source split from recent-events sample (filtered to selected window).
  // A "play" = an album load, so plays exclude auto_advance rows (the per-track
  // continuations of a side). isPlay is null-safe: legacy rows with a null source
  // still count. recognition/auto splits stay per-source by definition.
  const isPlay     = e => e.source == null || e.source !== "auto_advance";
  const allEvents  = Array.isArray(eventsResp.body) ? eventsResp.body : [];
  const events     = dWin ? allEvents.filter(e => e.listened_at >= dWin) : allEvents;
  const webPlays   = events.filter(e => e.platform === "web" && isPlay(e)).length;
  const iosPlays   = events.filter(e => e.platform === "ios" && isPlay(e)).length;
  const recogPlays = events.filter(e => e.source === "recognition").length;
  const autoPlays  = events.filter(e => e.source === "auto_advance").length;

  // Top albums — album loads only, filtered to selected window
  const recentEvents = dWin ? allEvents.filter(e => e.listened_at >= dWin) : allEvents;
  const albumCounts  = {};
  for (const e of recentEvents) {
    if (!e.album_name || !isPlay(e)) continue;
    const key = `${e.album_name}|||${e.artist_name || ""}`;
    albumCounts[key] = (albumCounts[key] || 0) + 1;
  }
  const topAlbums = Object.entries(albumCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([key, count]) => { const [album, artist] = key.split("|||"); return { album, artist, count }; });

  // Top users by play count (album loads, from sample)
  const emailById      = Object.fromEntries(allUsers.map(u => [u.id, u.email]));
  const userPlayCounts = {};
  for (const e of events) {
    if (!e.user_id || !isPlay(e)) continue;
    userPlayCounts[e.user_id] = (userPlayCounts[e.user_id] || 0) + 1;
  }
  const topUsers = Object.entries(userPlayCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([uid, count]) => ({ email: maskEmail(emailById[uid]) || uid.slice(0, 8) + "…", count }));

  // Subscriptions
  const subs        = Array.isArray(subsResp.body) ? subsResp.body : [];
  const premiumUsers = subs.filter(s => s.tier === "premium" && ["active","trialing"].includes(s.status)).length;

  // Catalogue & flips
  const catalogueTotal = parseInt(releasesResp.headers?.["content-range"]?.split("/")[1] || "0", 10);
  const totalFlips     = parseInt(flipsResp.headers?.["content-range"]?.split("/")[1] || "0", 10);

  const bugReports = (Array.isArray(bugsResp.body) ? bugsResp.body : [])
    .map(b => ({ ...b, user_email: maskEmail(b.user_email) }));

  return {
    users:    { total: totalUsers, new7d: newUsers7d, new30d: newUsers30d, premium: premiumUsers, recentSignups },
    library:  { totalAlbums, uniqueUsers: uniqueLibUsers, avgAlbums },
    plays:    { total: totalPlays, window: playsWindow, last7d: plays7d, songsTotal: totalSongs, web: webPlays, ios: iosPlays, recognition: recogPlays, autoAdvance: autoPlays },
    days,
    topAlbums,
    topUsers,
    bugReports,
    backlogTotal,
    catalogue: { releases: catalogueTotal, flips: totalFlips },
    generatedAt: now.toISOString(),
  };
}

// Paginate any sb GET path (Supabase caps at 1000/req).
async function sbGetAll(pathBase) {
  const out = []; let from = 0; const step = 1000;
  while (true) {
    const sep = pathBase.includes("?") ? "&" : "?";
    const { body } = await sbGet(`${pathBase}${sep}offset=${from}&limit=${step}`);
    if (!Array.isArray(body) || body.length === 0) break;
    out.push(...body);
    if (body.length < step) break;
    from += step;
  }
  return out;
}

// Best-effort identification of the auth provider for a Supabase user row.
function authProvider(u) {
  if (!u) return null;
  const ids = Array.isArray(u.identities) ? u.identities : [];
  if (ids.length > 0) {
    const names = ids.map(i => i.provider).filter(Boolean);
    if (names.length > 0) return names.join("+");
  }
  return u.app_metadata?.provider || u.app_metadata?.providers?.[0] || "email";
}

// ── Users list (for the drill-in from Recent Signups) ────────────────────────
async function getUsersList() {
  // Pull all auth users + their libraries + their listening counts in parallel.
  const allUsers = [];
  for (let page = 1; ; page++) {
    const resp = await sbAdminGet(`admin/users?page=${page}&per_page=1000`);
    const batch = resp?.users || [];
    allUsers.push(...batch);
    if (batch.length < 1000) break;
  }
  const [libRows, eventRows] = await Promise.all([
    sbGetAll("user_library?select=user_id"),
    sbGetAll("listening_events?select=user_id,platform,source"),
  ]);
  const albumByUid = {};
  for (const r of libRows) albumByUid[r.user_id] = (albumByUid[r.user_id] || 0) + 1;
  // A "play" = an album load, so exclude auto_advance (per-track continuations).
  // Null-safe: legacy rows with a null source still count.
  const playByUid = {};
  const platByUid = {}; // uid → Set of platforms seen (fallback when no signup metadata)
  for (const r of eventRows) {
    if (!r.user_id) continue;
    if (r.source == null || r.source !== "auto_advance") {
      playByUid[r.user_id] = (playByUid[r.user_id] || 0) + 1;
    }
    (platByUid[r.user_id] = platByUid[r.user_id] || new Set()).add(r.platform || null);
  }
  const inferPlatform = (uid) => {
    const seen = platByUid[uid];
    if (!seen) return null;
    const ios = seen.has("ios"), web = seen.has("web");
    return ios && web ? "both" : ios ? "ios" : web ? "web" : null;
  };

  // Sort by created_at desc — same ordering as Recent Signups so the preview
  // and the drill-in list line up.
  return {
    users: allUsers
      .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))
      .map(u => ({
        id:         u.id,
        email:      maskEmail(u.email),
        created_at: u.created_at,
        provider:   authProvider(u),
        albums:     albumByUid[u.id] || 0,
        plays:      playByUid[u.id] || 0,
        // Where they signed up: explicit metadata (new accounts) or inferred
        // from the platforms their plays came from (older accounts).
        signup_platform:   u.user_metadata?.signup_platform || null,
        platform_inferred: inferPlatform(u.id),
      })),
  };
}

// ── Single-user detail ───────────────────────────────────────────────────────
async function getUserDetail(userId) {
  // Auth profile via admin API
  const profile = await sbAdminGet(`admin/users/${userId}`);
  if (!profile?.id) return { error: "user not found" };

  const [libRows, eventRows, bugRows] = await Promise.all([
    sbGetAll(`user_library?user_id=eq.${userId}&select=itunes_collection_id,added_at`),
    sbGetAll(`listening_events?user_id=eq.${userId}&select=session_id,platform,source,listened_at,itunes_collection_id,track_title,album_name,artist_name&order=listened_at.asc`),
    sbGetAll(`bug_reports?user_id=eq.${userId}&select=id,created_at,description,platform,app_version,meta,status,retry_count&order=created_at.desc`),
  ]);

  // Hydrate albums with catalogue data + per-user play count
  const collectionIds = libRows.map(r => r.itunes_collection_id).filter(x => x != null);
  const catRows = collectionIds.length
    ? await sbGetAll(`catalogue?itunes_collection_id=in.(${collectionIds.join(",")})&select=itunes_collection_id,album_name,artist_name,artwork_url,release_year`)
    : [];
  const catById  = new Map(catRows.map(c => [c.itunes_collection_id, c]));
  // A "play" = an album load, so exclude auto_advance (per-track continuations).
  // Null-safe: legacy rows with a null source still count.
  const isPlay = e => e.source == null || e.source !== "auto_advance";
  const playsPerAlbum = {};
  for (const e of eventRows) {
    if (e.itunes_collection_id != null && isPlay(e)) {
      playsPerAlbum[e.itunes_collection_id] = (playsPerAlbum[e.itunes_collection_id] || 0) + 1;
    }
  }
  const albums = libRows
    .sort((a, b) => (b.added_at || "").localeCompare(a.added_at || ""))
    .map(r => {
      const c = catById.get(r.itunes_collection_id) || {};
      return {
        itunes_collection_id: r.itunes_collection_id,
        added_at:    r.added_at,
        album_name:  c.album_name || "(unknown)",
        artist_name: c.artist_name || "",
        artwork_url: c.artwork_url || null,
        release_year: c.release_year || null,
        plays:       playsPerAlbum[r.itunes_collection_id] || 0,
      };
    });

  // Plays breakdowns.
  // byPlatform counts album loads (plays); bySource is the per-event source
  // breakdown so it necessarily counts every row, auto_advance included.
  const byPlatform = { ios: 0, web: 0, other: 0 };
  const bySource   = { recognition: 0, shazam: 0, auto_advance: 0, turntable_jump: 0, other: 0 };
  // Engagement: active = user chose this track (recognized / shazamed / jumped),
  // passive = turntable just rolled to it (auto_advance).
  const ACTIVE_SOURCES = new Set(["recognition", "shazam", "turntable_jump"]);
  let active = 0, passive = 0, playTotal = 0;
  for (const e of eventRows) {
    if (isPlay(e)) {
      playTotal++;
      const p = e.platform || "other";
      byPlatform[p === "ios" || p === "web" ? p : "other"]++;
    }
    const s = e.source || "other";
    bySource[s in bySource ? s : "other"]++;
    if (s === "auto_advance") passive++;
    else if (ACTIVE_SOURCES.has(s)) active++;
  }

  // Session-start mix: for each session_id, look at the FIRST event (events
  // are already sorted ascending by listened_at). If that event was a
  // recognize/shazam, the user auto-identified; otherwise they likely picked
  // from the album list (auto_advance/turntable_jump suggests turntable was
  // already set up before any recognition happened).
  const seenSession = new Set();
  let autoStarts = 0, manualStarts = 0;
  for (const e of eventRows) {
    const sid = e.session_id || `__no_session_${e.listened_at}`;
    if (seenSession.has(sid)) continue;
    seenSession.add(sid);
    if (e.source === "recognition" || e.source === "shazam") autoStarts++;
    else manualStarts++;
  }

  return {
    profile: {
      id:           profile.id,
      email:        profile.email || null,         // unmasked — viewer is already in user-detail
      created_at:   profile.created_at,
      last_sign_in_at: profile.last_sign_in_at || null,
      provider:     authProvider(profile),
      confirmed:    !!profile.email_confirmed_at,
    },
    albums,
    plays: {
      total:       playTotal,
      byPlatform,
      bySource,
      engagement: { active, passive },
      sessions: {
        total:           seenSession.size,
        auto_recognized: autoStarts,
        manual_select:   manualStarts,
      },
    },
    bugs: bugRows.map(b => ({ ...b })),  // user's own bugs — no email masking needed (we're in their detail)
  };
}

// ── Albums drill-in: list of albums users have actually added ────────────────
async function getAlbumsList() {
  const [catRows, libRows, eventRows] = await Promise.all([
    sbGetAll("catalogue?select=itunes_collection_id,album_name,artist_name,artwork_url,release_year,track_count"),
    sbGetAll("user_library?select=itunes_collection_id"),
    sbGetAll("listening_events?select=itunes_collection_id,source&itunes_collection_id=not.is.null"),
  ]);

  // count library adds per album
  const libCount = {};
  for (const r of libRows) libCount[r.itunes_collection_id] = (libCount[r.itunes_collection_id] || 0) + 1;

  // count plays per album (lifetime). A "play" = an album load, so exclude
  // auto_advance (per-track continuations). Null-safe on legacy null sources.
  const playCount = {};
  for (const r of eventRows) {
    if (r.source == null || r.source !== "auto_advance") {
      playCount[r.itunes_collection_id] = (playCount[r.itunes_collection_id] || 0) + 1;
    }
  }

  return {
    albums: catRows.map(c => ({
      itunes_collection_id: c.itunes_collection_id,
      album_name:    c.album_name,
      artist_name:   c.artist_name,
      artwork_url:   c.artwork_url,
      release_year:  c.release_year,
      track_count:   c.track_count,
      added_by:      libCount[c.itunes_collection_id] || 0,
      plays:         playCount[c.itunes_collection_id] || 0,
    })).sort((a, b) => b.plays - a.plays || b.added_by - a.added_by),
  };
}

// ── Album drill-in: tracks + per-track play counts + missing-lyrics flag ─────
async function getAlbumDetail(collectionId) {
  // First fetch album metadata, tracks, events, and side info in parallel.
  const [catRow, trackRows, eventRows, sideRows] = await Promise.all([
    sbGet(`catalogue?itunes_collection_id=eq.${collectionId}&select=album_name,artist_name,artwork_url,release_year,track_count&limit=1`),
    sbGetAll(`album_tracks?itunes_collection_id=eq.${collectionId}&select=itunes_track_id,track_name,track_number,disc_number,duration_ms`),
    sbGetAll(`listening_events?itunes_collection_id=eq.${collectionId}&select=itunes_track_id,track_title`),
    sbGetAll(`vinyl_sides?itunes_collection_id=eq.${collectionId}&select=itunes_track_id,side,position,side_track_number`),
  ]);

  // Then look up lyrics for the track IDs we actually have.
  // A row counts as "has lyrics" only if lrc_raw or lyrics_plain is actually
  // populated — bare rows (e.g. seeded with just source/fetched_at) don't count.
  const tids = trackRows.map(t => t.itunes_track_id).filter(x => x != null);
  const lyricRows = tids.length
    ? await sbGetAll(`track_lyrics?itunes_track_id=in.(${tids.join(",")})&select=itunes_track_id,source,lrc_raw,lyrics_plain`)
    : [];

  const lyricByTid = new Map(lyricRows.map(r => [r.itunes_track_id, r.source]));
  const haveLyrics = new Set(
    lyricRows
      .filter(r => (r.lrc_raw && r.lrc_raw.trim()) || (r.lyrics_plain && r.lyrics_plain.trim()))
      .map(r => r.itunes_track_id)
  );
  const instrumental = new Set(
    lyricRows.filter(r => r.source === "instrumental").map(r => r.itunes_track_id)
  );
  const sideByTid  = new Map(sideRows.map(r => [r.itunes_track_id, r]));
  const playByTid  = {};
  const playByTitle = {};
  for (const e of eventRows) {
    if (e.itunes_track_id != null) {
      playByTid[e.itunes_track_id] = (playByTid[e.itunes_track_id] || 0) + 1;
    } else if (e.track_title) {
      const k = e.track_title.toLowerCase();
      playByTitle[k] = (playByTitle[k] || 0) + 1;
    }
  }

  const album = (catRow.body && catRow.body[0]) || null;
  const tracks = trackRows
    .sort((a, b) => (a.disc_number || 1) - (b.disc_number || 1) || (a.track_number || 0) - (b.track_number || 0))
    .map(t => {
      const sideRow = sideByTid.get(t.itunes_track_id);
      return {
        itunes_track_id: t.itunes_track_id,
        track_name:      t.track_name,
        track_number:    t.track_number,
        disc_number:     t.disc_number,
        duration_ms:     t.duration_ms,
        has_lyrics:      haveLyrics.has(t.itunes_track_id) || instrumental.has(t.itunes_track_id),
        is_instrumental: instrumental.has(t.itunes_track_id),
        lyrics_source:   lyricByTid.get(t.itunes_track_id) || null,
        side:            sideRow?.side || null,       // 'A' / 'B' / etc.
        position:        sideRow?.position || null,   // 'A1' / 'B2'
        plays:           playByTid[t.itunes_track_id] || playByTitle[(t.track_name || "").toLowerCase()] || 0,
      };
    });

  const sideCoverage = {
    total: tracks.length,
    with_side: tracks.filter(t => t.position).length,
    missing:   tracks.filter(t => !t.position).length,
  };

  // Thread the explicit collection id onto the album object so the admin UI
  // (side-data form, track-order editor) always acts on this exact version
  // rather than a value the catalogue select never returned.
  return { album: { ...(album || {}), itunes_collection_id: collectionId }, tracks, sideCoverage };
}

// ── Main handler ──────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  // ── GET: admin dashboard stats + drill-in queries ──────────────────────────
  if (req.method === "GET") {
    const adminPw  = process.env.ADMIN_PASSWORD;
    const provided = req.headers["x-admin-password"];
    if (!adminPw || !provided || !safeCompare(adminPw, provided)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      // Tiny query router so all admin reads share the same auth gate.
      const url    = new URL(req.url || "/", "http://x");
      const action = url.searchParams.get("action");

      res.setHeader("Cache-Control", "no-store");

      if (action === "albums") {
        return res.status(200).json(await getAlbumsList());
      }
      if (action === "album") {
        const id = parseInt(url.searchParams.get("id") || "0", 10);
        if (!id) return res.status(400).json({ error: "id required" });
        return res.status(200).json(await getAlbumDetail(id));
      }
      if (action === "users") {
        return res.status(200).json(await getUsersList());
      }
      if (action === "user") {
        const id = url.searchParams.get("id");
        if (!id) return res.status(400).json({ error: "id required" });
        return res.status(200).json(await getUserDetail(id));
      }
      if (action === "album-tracks") {
        const id = parseInt(url.searchParams.get("id") || "0", 10);
        if (!id) return res.status(400).json({ error: "id required" });
        const tracks = await sbGetAll(
          `album_tracks?itunes_collection_id=eq.${id}&select=itunes_track_id,track_name,track_number,disc_number&order=disc_number.asc,track_number.asc`
        );
        return res.status(200).json({ tracks });
      }

      if (action === "missing-lyrics") {
        // All album_tracks that have no lrc_raw in track_lyrics.
        // Two small queries instead of an embed — the embed pulls the full
        // lrc_raw text for every track (~1MB) and reliably times out the
        // 10s sbGet limit on Vercel cold starts.
        // NOTE: album_tracks has no album_name column — album name comes from
        // the catalogue join below, not the tracks table.
        const [tracksResp, withLrcResp, withPlainResp, instrumentalResp, eventResp] = await Promise.all([
          sbGetAll(`album_tracks?select=itunes_track_id,track_name,artist_name,itunes_collection_id,duration_ms,disc_number,track_number&order=itunes_collection_id.asc,disc_number.asc,track_number.asc`),
          sbGetAll(`track_lyrics?select=itunes_track_id&lrc_raw=not.is.null`),
          sbGetAll(`track_lyrics?select=itunes_track_id&lyrics_plain=not.is.null`),
          sbGetAll(`track_lyrics?select=itunes_track_id&source=eq.instrumental`),
          sbGetAll(`listening_events?select=itunes_collection_id,source,listened_at&itunes_collection_id=not.is.null`),
        ]);
        const rows = Array.isArray(tracksResp) ? tracksResp : [];
        const haveLrc = new Set((Array.isArray(withLrcResp) ? withLrcResp : []).map(r => r.itunes_track_id));
        const havePlain = new Set((Array.isArray(withPlainResp) ? withPlainResp : []).map(r => r.itunes_track_id));
        const instrumental = new Set((Array.isArray(instrumentalResp) ? instrumentalResp : []).map(r => r.itunes_track_id));
        const missing = rows.filter(t => !haveLrc.has(t.itunes_track_id) && !instrumental.has(t.itunes_track_id));
        // Fetch artwork + album name from catalogue
        const cids = [...new Set(missing.map(t => t.itunes_collection_id))];
        const { body: cat } = cids.length
          ? await sbGet(`catalogue?itunes_collection_id=in.(${cids.join(",")})&select=itunes_collection_id,album_name,artist_name,artwork_url`)
          : { body: [] };
        const catMap = {};
        (Array.isArray(cat) ? cat : []).forEach(c => { catMap[c.itunes_collection_id] = c; });
        const activityMap = buildAlbumActivity(eventResp);
        const enriched = missing.map(t => {
          const activity = activityFor(activityMap, t.itunes_collection_id);
          return {
            ...t,
            artwork_url:  catMap[t.itunes_collection_id]?.artwork_url || null,
            album_name:   catMap[t.itunes_collection_id]?.album_name  || "",
            artist_name:  catMap[t.itunes_collection_id]?.artist_name || t.artist_name || "",
            ...activity,
            // Plain lyrics exist but no synced timestamps — the app falls back to
            // the unsynced auto-scroll view for these until an LRC is submitted.
            has_plain:    havePlain.has(t.itunes_track_id),
          };
        }).sort((a, b) =>
          b.activity_score - a.activity_score
          || String(a.itunes_collection_id).localeCompare(String(b.itunes_collection_id))
          || (a.disc_number || 1) - (b.disc_number || 1)
          || (a.track_number || 0) - (b.track_number || 0));
        return res.status(200).json({ tracks: enriched, total: enriched.length });
      }

      if (action === "missing-side-info") {
        // Albums with one or more tracks that have no vinyl_sides row.
        const [tracksResp, sidesResp, catResp, eventResp] = await Promise.all([
          sbGetAll(`album_tracks?select=itunes_track_id,itunes_collection_id`),
          sbGetAll(`vinyl_sides?select=itunes_track_id`),
          sbGetAll(`catalogue?select=itunes_collection_id,album_name,artist_name,artwork_url`),
          sbGetAll(`listening_events?select=itunes_collection_id,source,listened_at&itunes_collection_id=not.is.null`),
        ]);
        const tracks = Array.isArray(tracksResp) ? tracksResp : [];
        const haveSide = new Set((Array.isArray(sidesResp) ? sidesResp : []).map(r => r.itunes_track_id));
        const catMap = {};
        (Array.isArray(catResp) ? catResp : []).forEach(c => { catMap[c.itunes_collection_id] = c; });
        const activityMap = buildAlbumActivity(eventResp);
        const albumStats = {};
        for (const t of tracks) {
          const cid = t.itunes_collection_id;
          if (!albumStats[cid]) albumStats[cid] = { total: 0, missing: 0 };
          albumStats[cid].total += 1;
          if (!haveSide.has(t.itunes_track_id)) albumStats[cid].missing += 1;
        }
        const albums = Object.entries(albumStats)
          .filter(([, s]) => s.missing > 0)
          .map(([cid, s]) => ({
            itunes_collection_id: Number(cid),
            album_name:  catMap[cid]?.album_name  || "",
            artist_name: catMap[cid]?.artist_name || "",
            artwork_url: catMap[cid]?.artwork_url || null,
            total: s.total,
            missing: s.missing,
            ...activityFor(activityMap, cid),
          }))
          .sort((a, b) => b.activity_score - a.activity_score || b.missing - a.missing);
        return res.status(200).json({ albums, total: albums.length });
      }

      if (action === "bugs") {
        const status = (url.searchParams.get("status") || "open").toLowerCase();
        if (!["open", "backlog", "fixed", "wontfix"].includes(status)) {
          return res.status(400).json({ error: "invalid status" });
        }
        const { body } = await sbGet(
          `bug_reports?status=eq.${status}&select=id,created_at,user_email,app_version,platform,description,meta,status,retry_count,last_retried_at&order=created_at.desc&limit=200`
        );
        const rows = (Array.isArray(body) ? body : [])
          .map(b => ({ ...b, user_email: maskEmail(b.user_email) }));
        return res.status(200).json({ bugs: rows });
      }

      const daysParam = parseInt(url.searchParams.get("days") || "3", 10);
      const stats = await getAdminStats(isNaN(daysParam) || daysParam <= 0 ? 0 : daysParam);
      return res.status(200).json(stats);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST (admin): catalogue and Liri-owned content management ─────────────
  if (req.headers["x-admin-password"]) {
    const adminPw = process.env.ADMIN_PASSWORD;
    if (!adminPw || !safeCompare(adminPw, req.headers["x-admin-password"])) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    if (body?.action === "submit-lyrics") {
      const { trackName, artistName, albumName, duration, syncedLyrics, plainLyrics, itunesTrackId } = body;
      if (!trackName || !artistName || !albumName || !duration) {
        return res.status(400).json({ error: "trackName, artistName, albumName, duration required" });
      }
      if (!itunesTrackId) {
        return res.status(400).json({ error: "itunesTrackId required for Liri storage" });
      }
      if (!syncedLyrics && !plainLyrics) {
        return res.status(400).json({ error: "Provide syncedLyrics or plainLyrics (or both)" });
      }

      // Save only to Liri's own cache. Admin-entered lyrics are never published
      // to LRCLIB or any other external lyrics service.
      const { status } = await sbUpsert("track_lyrics?on_conflict=itunes_track_id", [{
        itunes_track_id: itunesTrackId,
        lrc_raw:      syncedLyrics || null,
        lyrics_plain: plainLyrics || (syncedLyrics ? lrcToPlain(syncedLyrics) : null),
        words_json:   syncedLyrics ? parseLrcToWords(syncedLyrics) : null,
        source:       "admin",
        fetched_at:   new Date().toISOString(),
      }]);
      if (status < 200 || status >= 300) {
        return res.status(500).json({ error: `track_lyrics upsert failed (${status})` });
      }
      return res.status(200).json({ ok: true, message: "Saved to Liri ✓" });
    }

    if (body?.action === "delete-lyrics") {
      const trackId = Number(body.itunesTrackId);
      if (!Number.isFinite(trackId) || trackId <= 0) {
        return res.status(400).json({ error: "valid itunesTrackId required" });
      }
      const { status } = await sbDelete(`track_lyrics?itunes_track_id=eq.${trackId}`);
      return (status >= 200 && status < 300)
        ? res.status(200).json({ ok: true, message: "Lyrics removed from Liri" })
        : res.status(500).json({ error: `track_lyrics delete failed (${status})` });
    }

    if (body?.action === "add-vinyl-sides") {
      const { collectionId, sides } = body;
      if (!collectionId || !Array.isArray(sides) || sides.length === 0) {
        return res.status(400).json({ error: "collectionId and sides[] required" });
      }
      for (const s of sides) {
        if (!s.letter || !s.count || s.count < 1) {
          return res.status(400).json({ error: "each side needs letter (string) and count (number)" });
        }
      }
      const trackRows = await sbGetAll(
        `album_tracks?itunes_collection_id=eq.${collectionId}&select=itunes_track_id,track_name,track_number,disc_number&order=disc_number.asc,track_number.asc`
      );
      if (!trackRows.length) {
        return res.status(404).json({ error: "no tracks found for this collection" });
      }
      const rows = [];
      let trackIdx = 0;
      for (const { letter, count } of sides) {
        const sideLetter = letter.toUpperCase();
        for (let ti = 0; ti < count && trackIdx < trackRows.length; ti++, trackIdx++) {
          const t = trackRows[trackIdx];
          rows.push({
            itunes_collection_id: collectionId,
            itunes_track_id:      t.itunes_track_id,
            side:                 sideLetter,
            position:             `${sideLetter}${ti + 1}`,
            side_track_number:    ti + 1,
          });
        }
      }
      await sbDelete(`vinyl_sides?itunes_collection_id=eq.${collectionId}`);
      const { status } = await sbInsert("vinyl_sides", rows);
      return (status >= 200 && status < 300)
        ? res.status(200).json({ ok: true, inserted: rows.length })
        : res.status(500).json({ error: `vinyl_sides insert failed (${status})` });
    }

    if (body?.action === "reorder-tracks") {
      // Fix an album whose vinyl track order differs from the iTunes order.
      // Rewrites album_tracks.track_number (1..N, disc 1) to the supplied order.
      // The player builds turntableTracksRef ordered by disc_number,track_number,
      // so this immediately corrects turntable playback + auto-advance.
      const { collectionId, trackIds } = body;
      if (!collectionId || !Array.isArray(trackIds) || trackIds.length === 0) {
        return res.status(400).json({ error: "collectionId and trackIds[] required" });
      }
      const rows = trackIds.map((tid, i) => ({
        itunes_track_id:      Number(tid),
        itunes_collection_id: String(collectionId),
        track_number:         i + 1,
        disc_number:          1,
      }));
      const { status } = await sbUpsert("album_tracks?on_conflict=itunes_track_id", rows);
      if (status < 200 || status >= 300) {
        return res.status(500).json({ error: `album_tracks update failed (${status})` });
      }
      // Side assignments were derived from the OLD order — clear them so the
      // admin re-enters side counts against the corrected sequence.
      await sbDelete(`vinyl_sides?itunes_collection_id=eq.${collectionId}`);
      return res.status(200).json({ ok: true, updated: rows.length });
    }

    if (body?.action === "post-update") {
      const text = (body.text || "").trim();
      if (!text) return res.status(400).json({ error: "text required" });
      // Resolve the official Liri account (username='liri', else is_official).
      let { body: profs } = await sbGet("profiles?username=eq.liri&select=id&limit=1");
      let liriId = Array.isArray(profs) && profs[0] && profs[0].id;
      if (!liriId) {
        const { body: off } = await sbGet("profiles?is_official=eq.true&select=id&limit=1");
        liriId = Array.isArray(off) && off[0] && off[0].id;
      }
      if (!liriId) return res.status(404).json({ error: "Liri account not found" });
      const { status } = await sbInsert("posts", { author_id: liriId, kind: "update", source: "auto", visibility: "public", caption: text });
      return (status >= 200 && status < 300)
        ? res.status(200).json({ success: true })
        : res.status(500).json({ error: "insert failed (" + status + ")" });
    }
    return res.status(400).json({ error: "unknown action" });
  }

  // ── POST: cron sync (existing behaviour) ──────────────────────────────────
  // Allow Vercel's cron runner OR manual trigger with a secret header
  const cronSecret = process.env.CRON_SECRET;
  const provided   = req.headers["x-cron-secret"] || req.headers["authorization"]?.replace("Bearer ", "");

  if (!cronSecret || !provided || !safeCompare(cronSecret, provided)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  console.log("[sync-catalogue] Starting weekly sync...");
  const stats = { terms: 0, found: 0, upserted: 0, newReleases: 0, errors: [] };

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

  // ── New releases pass ───────────────────────────────────────────────────────
  try {
    const fresh = await fetchNewReleases(100);
    const rows = fresh
      .map(rssAlbumToRow)
      .filter(r => Number.isFinite(r.itunes_collection_id) && r.album_name);
    if (rows.length > 0) {
      await sbUpsertBatch(rows);
      stats.newReleases = rows.length;
    }
  } catch (e) {
    console.error("[sync-catalogue] new-releases pass failed:", e.message);
    stats.errors.push({ stage: "new-releases", error: e.message });
  }

  console.log("[sync-catalogue] Done:", stats);
  return res.status(200).json({ success: true, stats });
};
