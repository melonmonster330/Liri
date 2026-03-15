#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// scripts/seed-vinyl-discogs.js — Liri Vinyl Database Bulk Seeder
//
// Pulls popular vinyl releases from Discogs (which has real A/B/C/D side data),
// matches each one to iTunes to get the collectionId Liri uses for flip detection,
// and bulk-inserts into Supabase.
//
// Usage (simplest — add your keys to scripts/.env once, then just run):
//   node scripts/seed-vinyl-discogs.js
//
// Or pass keys inline (overrides .env):
//   DISCOGS_TOKEN=xxx SUPABASE_SERVICE_KEY=yyy node scripts/seed-vinyl-discogs.js
//
// Optional flags:
//   --target=5000       how many records to insert (default: 10000)
//   --genre=Rock        seed one genre only
//   --start-page=5      resume from a specific Discogs page
//
// Where to get the keys:
//   DISCOGS_TOKEN        → discogs.com → Settings → Developers → Generate Token
//   SUPABASE_SERVICE_KEY → Supabase dashboard → Settings → API → service_role key
//                          (this bypasses RLS so we can bulk-insert as admin)
//
// Safe to run multiple times — skips releases already in the DB.
// Runs connectivity checks at startup and exits with a clear error message if
// either API key is wrong or the Supabase table isn't found.
// ─────────────────────────────────────────────────────────────────────────────

const https = require("https");
const fs    = require("fs");
const path  = require("path");

// ── Load .env file (if present) ───────────────────────────────────────────────
// Create scripts/.env with:
//   DISCOGS_TOKEN=your_token_here
//   SUPABASE_SERVICE_KEY=your_key_here
// This file is gitignored — safe to store secrets there permanently.

const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, ""); // strip optional quotes
    if (key && !(key in process.env)) process.env[key] = val;
  }
  console.log(`  (Loaded secrets from ${envPath})`);
}

// ── Config ────────────────────────────────────────────────────────────────────

const DISCOGS_TOKEN       = process.env.DISCOGS_TOKEN;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SUPABASE_URL        = "xjdjpaxgymgbvcwmvorc.supabase.co";

const args    = Object.fromEntries(process.argv.slice(2).map(a => a.replace("--","").split("=")));
const TARGET  = parseInt(args.target      || "10000");
const ONLY_GENRE  = args.genre   || null;
const START_PAGE  = parseInt(args["start-page"] || "1");

// Discogs search covers these genres in order — broadest most-collected first
const GENRES = [
  "Rock", "Pop", "Electronic", "Hip Hop", "Jazz",
  "Classical", "R&B", "Soul", "Funk", "Reggae",
  "Country", "Folk", "Blues", "Metal", "Latin",
];

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

function get(hostname, path, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(
      { hostname, path, headers: { "User-Agent": "LiriVinylDB/1.0 +https://getliri.com", ...headers } },
      (res) => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
          catch (e) { reject(new Error(`Non-JSON (HTTP ${res.statusCode}) from ${hostname}${path}: ${raw.slice(0, 120)}`)); }
        });
      }
    ).on("error", reject);
  });
}

function del(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method: "DELETE", headers },
      (res) => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function post(hostname, path, headers, bodyObj) {
  const body = JSON.stringify(bodyObj);
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...headers } },
      (res) => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString().trim();
          if (!raw) { resolve({ status: res.statusCode, body: null }); return; }
          try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
          catch (e) { reject(new Error(`Non-JSON (HTTP ${res.statusCode}) from ${hostname}${path}: ${raw.slice(0, 200)}`)); }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Discogs ───────────────────────────────────────────────────────────────────

async function discogsSearch(genre, page) {
  // type=release ensures we only get individual pressings (not masters/artists/labels)
  // which all live at /releases/{id} — other types cause Non-JSON errors
  const qs = `type=release&format=Vinyl&genre=${encodeURIComponent(genre)}&sort=have&sort_order=desc&per_page=100&page=${page}&token=${DISCOGS_TOKEN}`;
  const r = await get("api.discogs.com", `/database/search?${qs}`);
  if (r.status === 429) { console.log("  Discogs rate limit — waiting 60s"); await sleep(60000); return discogsSearch(genre, page); }
  return r.body;
}

async function discogsRelease(id) {
  const r = await get("api.discogs.com", `/releases/${id}?token=${DISCOGS_TOKEN}`);
  if (r.status === 429) { console.log("  Discogs rate limit — waiting 60s"); await sleep(60000); return discogsRelease(id); }
  if (r.status !== 200) return null;
  return r.body;
}

// Discogs appends " (2)" etc. to disambiguate artists — strip that
function cleanArtist(name) {
  return (name || "").replace(/\s*\(\d+\)\s*$/, "").trim();
}

// Parse Discogs tracklist positions: "A1", "B2", "C3" → side + number
// Also handles "A", "B" (no number), "1", "2" (no side), etc.
function parseTracklist(tracklist) {
  const tracks = [];
  for (const t of (tracklist || [])) {
    if (!t.position || t.type_ === "heading") continue;
    const pos = t.position.trim();

    // Standard vinyl position: letter + number (A1, B2, C3, ...)
    const m = pos.match(/^([A-Ha-h])(\d+)$/);
    if (m) {
      tracks.push({
        side:     m[1].toUpperCase(),
        posNum:   parseInt(m[2]),
        title:    t.title,
        duration: t.duration || null,
      });
      continue;
    }

    // Side-only position (A, B, C...) — treat as single track on that side
    const sideOnly = pos.match(/^([A-Ha-h])$/);
    if (sideOnly) {
      tracks.push({ side: sideOnly[1].toUpperCase(), posNum: 1, title: t.title, duration: t.duration || null });
    }
  }
  return tracks;
}

// "3:45" → milliseconds (null if unparseable)
function durationMs(str) {
  if (!str) return null;
  const p = str.split(":").map(Number);
  if (p.length === 2 && !p.some(isNaN)) return (p[0] * 60 + p[1]) * 1000;
  return null;
}

// Side letter → disc number  A/B=1, C/D=2, E/F=3, G/H=4
function sideToDisc(side) {
  return Math.ceil(("ABCDEFGH".indexOf(side.toUpperCase()) + 1) / 2);
}

// ── iTunes ────────────────────────────────────────────────────────────────────

async function itunesSearch(artist, album) {
  const term = encodeURIComponent(`${artist} ${album}`);
  const r = await get("itunes.apple.com", `/search?term=${term}&entity=album&limit=5&media=music`);
  if (r.status !== 200 || !r.body.results?.length) return null;

  const norm = s => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const albumN  = norm(album);
  const artistN = norm(artist);

  // Score each result — prefer exact title + artist match
  const scored = r.body.results.map(res => {
    const titleScore  = norm(res.collectionName).includes(albumN.slice(0, 12)) ? 2 : 0;
    const artistScore = norm(res.artistName).includes(artistN.slice(0, 8))    ? 1 : 0;
    return { res, score: titleScore + artistScore };
  }).sort((a, b) => b.score - a.score);

  return scored[0].score > 0 ? scored[0].res : null;
}

// ── Supabase REST ─────────────────────────────────────────────────────────────

const SB_HEADERS = {
  "apikey":        SUPABASE_SERVICE_KEY,
  "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
};

async function sbGet(table, qs) {
  const r = await get(SUPABASE_URL, `/rest/v1/${table}?${qs}`, SB_HEADERS);
  return r.body;
}

async function sbInsert(table, row) {
  const r = await post(SUPABASE_URL, `/rest/v1/${table}`, {
    ...SB_HEADERS,
    "Prefer": "return=representation",
  }, row);
  if (r.status >= 300) throw new Error(`Supabase ${table} insert failed (${r.status}): ${JSON.stringify(r.body)}`);
  return Array.isArray(r.body) ? r.body[0] : r.body;
}

async function sbInsertMany(table, rows) {
  const r = await post(SUPABASE_URL, `/rest/v1/${table}`, {
    ...SB_HEADERS,
    "Prefer": "return=minimal",
  }, rows);
  if (r.status >= 300) throw new Error(`Supabase ${table} bulk insert failed (${r.status}): ${JSON.stringify(r.body)}`);
}

async function releaseExists(itunesCollectionId) {
  const rows = await sbGet("vinyl_releases", `itunes_collection_id=eq.${itunesCollectionId}&select=id&limit=1`);
  return Array.isArray(rows) && rows.length > 0;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!DISCOGS_TOKEN || !SUPABASE_SERVICE_KEY) {
    console.error([
      "",
      "  Missing environment variables. Run like this:",
      "",
      "  DISCOGS_TOKEN=xxx SUPABASE_SERVICE_KEY=yyy node scripts/seed-vinyl-discogs.js",
      "",
      "  DISCOGS_TOKEN        → discogs.com → Settings → Developers → Generate Token",
      "  SUPABASE_SERVICE_KEY → Supabase dashboard → Settings → API → service_role key",
      "",
    ].join("\n"));
    process.exit(1);
  }

  console.log(`\n🎵 Liri Vinyl Database Seeder`);
  console.log(`   Target: ${TARGET.toLocaleString()} records`);
  if (ONLY_GENRE) console.log(`   Genre filter: ${ONLY_GENRE}`);
  console.log("");

  // ── Startup connectivity checks ──────────────────────────────────────────
  console.log("── Connectivity checks ─────────────────────────────────────");

  // 1. Discogs
  process.stdout.write("  Discogs API... ");
  try {
    const dr = await get("api.discogs.com", `/database/search?type=release&format=Vinyl&genre=Rock&per_page=1&page=1&token=${DISCOGS_TOKEN}`);
    if (dr.status === 200 && dr.body.results) {
      console.log(`✓  (found ${dr.body.pagination?.items?.toLocaleString() ?? "?"} Rock vinyl releases)`);
    } else if (dr.status === 401) {
      console.error(`✗  Auth failed — check your DISCOGS_TOKEN`);
      process.exit(1);
    } else {
      console.error(`✗  Unexpected status ${dr.status}`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`✗  ${e.message}`);
    process.exit(1);
  }

  // 2. Supabase — read one row from vinyl_releases
  process.stdout.write("  Supabase (read)... ");
  try {
    const sr = await get(SUPABASE_URL, `/rest/v1/vinyl_releases?select=id&limit=1`, SB_HEADERS);
    if (sr.status === 200) {
      console.log(`✓`);
    } else if (sr.status === 401 || sr.status === 403) {
      console.error(`✗  Auth failed (HTTP ${sr.status}) — check your SUPABASE_SERVICE_KEY`);
      console.error(`   Response: ${JSON.stringify(sr.body).slice(0, 300)}`);
      process.exit(1);
    } else if (sr.status === 404) {
      console.error(`✗  Table not found (HTTP 404) — have you run supabase/vinyl_schema.sql?`);
      console.error(`   Response: ${JSON.stringify(sr.body).slice(0, 300)}`);
      process.exit(1);
    } else {
      console.error(`✗  Unexpected status ${sr.status}: ${JSON.stringify(sr.body).slice(0, 300)}`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`✗  ${e.message}`);
    process.exit(1);
  }

  // 3. Supabase — test write (insert + delete a dummy row) to confirm service key
  process.stdout.write("  Supabase (write)... ");
  try {
    const testRow = {
      itunes_collection_id: null,
      album_name:  "__connectivity_test__",
      artist_name: "__test__",
      disc_count:  1,
      confirmed_count: 0,
      is_verified: false,
    };
    const wr = await post(SUPABASE_URL, `/rest/v1/vinyl_releases`, {
      ...SB_HEADERS,
      "Prefer": "return=representation",
    }, testRow);
    if (wr.status >= 300) {
      console.error(`✗  Insert failed (HTTP ${wr.status}): ${JSON.stringify(wr.body).slice(0, 300)}`);
      process.exit(1);
    }
    // Clean up test row
    const testId = wr.body?.id || (Array.isArray(wr.body) && wr.body[0]?.id);
    if (testId) {
      await del(SUPABASE_URL, `/rest/v1/vinyl_releases?id=eq.${testId}`, SB_HEADERS).catch(() => {});
    }
    console.log(`✓`);
  } catch (e) {
    console.error(`✗  ${e.message}`);
    process.exit(1);
  }

  console.log("");

  let inserted = 0;
  let skipped  = 0;
  let failed   = 0;

  const genres = ONLY_GENRE ? [ONLY_GENRE] : GENRES;

  for (const genre of genres) {
    if (inserted >= TARGET) break;
    console.log(`\n── ${genre} ──────────────────────────────────────────`);

    for (let page = (genre === genres[0] ? START_PAGE : 1); page <= 50; page++) {
      if (inserted >= TARGET) break;

      let search;
      try {
        search = await discogsSearch(genre, page);
        await sleep(1100); // stay under Discogs 60/min rate limit
      } catch (e) {
        console.error(`  Search error (page ${page}):`, e.message);
        await sleep(5000);
        continue;
      }

      if (!search.results?.length) { console.log(`  No more results at page ${page}`); break; }
      console.log(`  Page ${page} — ${search.results.length} candidates`);

      for (const result of search.results) {
        if (inserted >= TARGET) break;

        // Skip anything that isn't a plain release (masters, artists, labels
        // live at different endpoints and will 404 at /releases/{id})
        if (result.type && result.type !== "release") { skipped++; continue; }

        try {
          // ── 1. Get full release from Discogs ──
          const release = await discogsRelease(result.id);
          await sleep(1100);
          if (!release) { skipped++; continue; }

          const artist = cleanArtist(release.artists?.[0]?.name || result.artist || "");
          const album  = release.title || result.title || "";
          if (!artist || !album) { skipped++; continue; }

          // ── 2. Parse tracklist — skip if no real side data ──
          const tracks = parseTracklist(release.tracklist);
          if (tracks.length === 0) {
            skipped++;
            continue; // no usable side data, not worth storing
          }

          // Must have at least 2 sides to be interesting for flip detection
          const sides = [...new Set(tracks.map(t => t.side))];
          if (sides.length < 2) { skipped++; continue; }

          // ── 3. Match to iTunes ──
          let iTunesMatch = null;
          try {
            iTunesMatch = await itunesSearch(artist, album);
            await sleep(400);
          } catch (e) { /* iTunes match is nice-to-have, not required */ }

          const collectionId = iTunesMatch?.collectionId ? String(iTunesMatch.collectionId) : null;

          // ── 4. Skip if we already have this one ──
          if (collectionId && await releaseExists(collectionId)) {
            skipped++;
            continue;
          }

          // ── 5. Insert release ──
          const discCount = Math.max(...sides.map(sideToDisc));
          const releaseRow = await sbInsert("vinyl_releases", {
            itunes_collection_id: collectionId,
            album_name:           album,
            artist_name:          artist,
            release_year:         release.year || null,
            record_label:         release.labels?.[0]?.name || null,
            catalog_number:       release.labels?.[0]?.catno !== "none" ? release.labels?.[0]?.catno : null,
            country:              release.country || null,
            disc_count:           discCount,
            artwork_url:          iTunesMatch?.artworkUrl100?.replace("100x100bb", "600x600bb") || null,
            confirmed_count:      0,
            is_verified:          false,
          });

          // ── 6. Insert tracks ──
          const trackRows = tracks.map(t => ({
            release_id:          releaseRow.id,
            disc_number:         sideToDisc(t.side),
            side:                t.side,
            position:            `${t.side}${t.posNum}`,
            track_number_on_side: t.posNum,
            title:               t.title,
            duration_ms:         durationMs(t.duration),
          }));
          await sbInsertMany("vinyl_tracks", trackRows);

          inserted++;
          const iTunesTag = collectionId ? "✓ iTunes" : "no iTunes";
          console.log(`  [${inserted}] ${artist} — ${album}  (${sides.join("/")} · ${tracks.length} tracks · ${iTunesTag})`);

        } catch (err) {
          console.error(`  ✗ Error [${result.id}]:`, err.message);
          failed++;
          await sleep(3000);
        }
      }

      // Brief pause between pages
      await sleep(500);
    }
  }

  console.log(`\n${"─".repeat(52)}`);
  console.log(`✓ Done!  Inserted: ${inserted}  Skipped: ${skipped}  Failed: ${failed}`);
  console.log(`${"─".repeat(52)}\n`);
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
