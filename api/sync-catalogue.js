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

// ── lrclib PoW solver ─────────────────────────────────────────────────────────
// find nonce where SHA256(`${prefix}:${nonce}`) < target (BigInt compare)
function solveChallenge(prefix, target) {
  const targetBig = BigInt("0x" + target);
  let nonce = 0;
  while (true) {
    const hash = crypto.createHash("sha256").update(`${prefix}:${nonce}`).digest("hex");
    if (BigInt("0x" + hash) < targetBig) return nonce;
    if (++nonce > 10000000) throw new Error("PoW took too long");
  }
}

function httpsPost(hostname, path, headers, body) {
  const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: "POST", headers: { ...headers, "Content-Length": Buffer.byteLength(bodyStr) } }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, raw: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("timeout")); });
    req.write(bodyStr);
    req.end();
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

async function getAdminStats() {
  const now = new Date();
  const d7  = new Date(now - 7  * 86400000).toISOString();
  const d30 = new Date(now - 30 * 86400000).toISOString();
  const d1  = new Date(now - 1  * 86400000).toISOString();

  // Paginate auth admin API — 1000 per page, loop until exhausted
  const allUsers = [];
  for (let page = 1; ; page++) {
    const resp = await sbAdminGet(`admin/users?page=${page}&per_page=1000`);
    const batch = resp?.users || [];
    allUsers.push(...batch);
    if (batch.length < 1000) break;
  }

  // Parallel: exact-count queries for totals + data queries for breakdowns
  const [
    totalPlaysResp,
    plays7dResp,
    plays1dResp,
    totalLibResp,
    eventsResp,
    libResp,
    subsResp,
    releasesResp,
    flipsResp,
    bugsResp,
    bugsBacklogResp,
  ] = await Promise.all([
    sbGet("listening_events?select=id&limit=1",                                  { "Prefer": "count=exact" }),
    sbGet(`listening_events?select=id&listened_at=gte.${d7}&limit=1`,            { "Prefer": "count=exact" }),
    sbGet(`listening_events?select=id&listened_at=gte.${d1}&limit=1`,            { "Prefer": "count=exact" }),
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

  // Plays — exact counts from count=exact headers
  const totalPlays = parseInt(totalPlaysResp.headers?.["content-range"]?.split("/")[1] || "0", 10);
  const plays7d    = parseInt(plays7dResp.headers?.["content-range"]?.split("/")[1] || "0", 10);
  const plays1d    = parseInt(plays1dResp.headers?.["content-range"]?.split("/")[1] || "0", 10);

  // Platform / source split from recent-events sample (last 5000)
  const events     = Array.isArray(eventsResp.body) ? eventsResp.body : [];
  const webPlays   = events.filter(e => e.platform === "web").length;
  const iosPlays   = events.filter(e => e.platform === "ios").length;
  const recogPlays = events.filter(e => e.source === "recognition").length;
  const autoPlays  = events.filter(e => e.source === "auto_advance").length;

  // Top albums (last 30d from sample)
  const recentEvents = events.filter(e => e.listened_at > d30);
  const albumCounts  = {};
  for (const e of recentEvents) {
    if (!e.album_name) continue;
    const key = `${e.album_name}|||${e.artist_name || ""}`;
    albumCounts[key] = (albumCounts[key] || 0) + 1;
  }
  const topAlbums = Object.entries(albumCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([key, count]) => { const [album, artist] = key.split("|||"); return { album, artist, count }; });

  // Top users by play count (from sample)
  const emailById      = Object.fromEntries(allUsers.map(u => [u.id, u.email]));
  const userPlayCounts = {};
  for (const e of events) {
    if (!e.user_id) continue;
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
    plays:    { total: totalPlays, last7d: plays7d, last24h: plays1d, web: webPlays, ios: iosPlays, recognition: recogPlays, autoAdvance: autoPlays },
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
    sbGetAll("listening_events?select=user_id"),
  ]);
  const albumByUid = {};
  for (const r of libRows) albumByUid[r.user_id] = (albumByUid[r.user_id] || 0) + 1;
  const playByUid = {};
  for (const r of eventRows) if (r.user_id) playByUid[r.user_id] = (playByUid[r.user_id] || 0) + 1;

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
  const playsPerAlbum = {};
  for (const e of eventRows) {
    if (e.itunes_collection_id != null) {
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

  // Plays breakdowns
  const byPlatform = { ios: 0, web: 0, other: 0 };
  const bySource   = { recognition: 0, shazam: 0, auto_advance: 0, turntable_jump: 0, other: 0 };
  // Engagement: active = user chose this track (recognized / shazamed / jumped),
  // passive = turntable just rolled to it (auto_advance).
  const ACTIVE_SOURCES = new Set(["recognition", "shazam", "turntable_jump"]);
  let active = 0, passive = 0;
  for (const e of eventRows) {
    const p = e.platform || "other";
    byPlatform[p === "ios" || p === "web" ? p : "other"]++;
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
      total:       eventRows.length,
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
    sbGetAll("listening_events?select=itunes_collection_id&itunes_collection_id=not.is.null"),
  ]);

  // count library adds per album
  const libCount = {};
  for (const r of libRows) libCount[r.itunes_collection_id] = (libCount[r.itunes_collection_id] || 0) + 1;

  // count plays per album (lifetime)
  const playCount = {};
  for (const r of eventRows) playCount[r.itunes_collection_id] = (playCount[r.itunes_collection_id] || 0) + 1;

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
  const tids = trackRows.map(t => t.itunes_track_id).filter(x => x != null);
  const lyricRows = tids.length
    ? await sbGetAll(`track_lyrics?itunes_track_id=in.(${tids.join(",")})&select=itunes_track_id,source`)
    : [];

  const lyricByTid = new Map(lyricRows.map(r => [r.itunes_track_id, r.source]));
  const haveLyrics = new Set(lyricRows.map(r => r.itunes_track_id));
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
        has_lyrics:      haveLyrics.has(t.itunes_track_id),
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

  return { album, tracks, sideCoverage };
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
      if (action === "missing-lyrics") {
        // All album_tracks that have no lrc_raw in track_lyrics
        const { body: rows } = await sbGet(
          `album_tracks?select=itunes_track_id,track_name,artist_name,album_name,itunes_collection_id,duration_ms,disc_number,track_number,track_lyrics!left(lrc_raw)&order=itunes_collection_id.asc,disc_number.asc,track_number.asc`
        );
        const missing = (Array.isArray(rows) ? rows : []).filter(t => !t.track_lyrics?.lrc_raw);
        // Fetch artwork from catalogue
        const cids = [...new Set(missing.map(t => t.itunes_collection_id))];
        const { body: cat } = cids.length
          ? await sbGet(`catalogue?itunes_collection_id=in.(${cids.join(",")})&select=itunes_collection_id,album_name,artist_name,artwork_url`)
          : { body: [] };
        const catMap = {};
        (Array.isArray(cat) ? cat : []).forEach(c => { catMap[c.itunes_collection_id] = c; });
        const enriched = missing.map(t => ({
          ...t,
          track_lyrics: undefined,
          artwork_url:  catMap[t.itunes_collection_id]?.artwork_url || null,
          album_name:   catMap[t.itunes_collection_id]?.album_name  || t.album_name || "",
          artist_name:  catMap[t.itunes_collection_id]?.artist_name || t.artist_name || "",
        }));
        return res.status(200).json({ tracks: enriched, total: enriched.length });
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

      const stats = await getAdminStats();
      return res.status(200).json(stats);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST (admin): publish a Liri update announcement to the feed ──────────
  if (req.headers["x-admin-password"]) {
    const adminPw = process.env.ADMIN_PASSWORD;
    if (!adminPw || !safeCompare(adminPw, req.headers["x-admin-password"])) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    if (body?.action === "submit-lyrics") {
      const { trackName, artistName, albumName, duration, syncedLyrics, plainLyrics } = body;
      if (!trackName || !artistName || !albumName || !duration) {
        return res.status(400).json({ error: "trackName, artistName, albumName, duration required" });
      }
      if (!syncedLyrics && !plainLyrics) {
        return res.status(400).json({ error: "Provide syncedLyrics or plainLyrics (or both)" });
      }
      try {
        const challengeRes = await httpsPost("lrclib.net", "/api/request-challenge",
          { "Content-Type": "application/json", "Lrclib-Client": "Liri/1.0 (https://getliri.com)" }, "{}");
        const challenge = JSON.parse(challengeRes.raw);
        if (!challenge.prefix || !challenge.target) {
          return res.status(502).json({ error: "Failed to get PoW challenge from lrclib" });
        }
        const nonce = solveChallenge(challenge.prefix, challenge.target);
        const publishRes = await httpsPost("lrclib.net", "/api/publish",
          { "Content-Type": "application/json", "X-Publish-Token": `${challenge.prefix}:${nonce}`, "Lrclib-Client": "Liri/1.0 (https://getliri.com)" },
          { trackName, artistName, albumName, duration: Number(duration), ...(syncedLyrics ? { syncedLyrics } : {}), ...(plainLyrics ? { plainLyrics } : {}) }
        );
        if (publishRes.status === 201 || publishRes.status === 200) {
          return res.status(200).json({ ok: true, message: "Lyrics published to lrclib!" });
        }
        let errBody = {};
        try { errBody = JSON.parse(publishRes.raw); } catch {}
        return res.status(publishRes.status).json({ error: errBody.message || errBody.error || `lrclib returned ${publishRes.status}` });
      } catch (e) {
        return res.status(500).json({ error: e.message || "Internal error" });
      }
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
