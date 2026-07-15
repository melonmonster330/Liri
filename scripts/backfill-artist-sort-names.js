#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// scripts/backfill-artist-sort-names.js — Fill catalogue.artist_sort_name
//
// For every album in the shared `catalogue` table without a sort name, look
// the artist up on MusicBrainz and store its human-curated sort name
// ("Bowie, David"; "Rolling Stones, The"). The library and pick-a-record
// picker sort by this, so solo artists file under their surname and bands
// under their name — no guessing client-side.
//
// Match safety: only the top MusicBrainz hit with a search score ≥ 90 is
// accepted; anything less leaves the row NULL and clients fall back to the
// plain artist name.
//
// Usage (add SUPABASE_SERVICE_KEY to scripts/.env once, then):
//   node scripts/backfill-artist-sort-names.js
//
// Flags:
//   --limit=200   cap ARTISTS processed this run (default: all)
//   --dry-run     print what would change, write nothing
//   --force       re-look-up artists whose albums already have a sort name
//
// Required env:
//   SUPABASE_SERVICE_KEY  → Supabase → Settings → API → service_role
//
// Safe to run repeatedly. MusicBrainz asks for ~1 request/second, so this
// dedupes by artist and queries politely (1 lookup / 1.1s).
// ─────────────────────────────────────────────────────────────────────────────

const https = require("https");
const fs    = require("fs");
const path  = require("path");

// ── Load scripts/.env if present ─────────────────────────────────────────────
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("="); if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (k && !(k in process.env)) process.env[k] = v;
  }
  console.log(`  (Loaded secrets from ${envPath})`);
}

// ── Config ───────────────────────────────────────────────────────────────────
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_URL_RAW     = process.env.SUPABASE_URL || "https://xjdjpaxgymgbvcwmvorc.supabase.co";
const SUPABASE_HOST        = SUPABASE_URL_RAW.replace(/^https?:\/\//, "").replace(/\/$/, "");

const args  = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, "").split("=")));
const LIMIT = args.limit ? parseInt(args.limit) : null;
const DRY   = "dry-run" in args;
const FORCE = "force" in args;

if (!SUPABASE_SERVICE_KEY) {
  console.error("❌ Missing SUPABASE_SERVICE_KEY. Set it in scripts/.env or as an env var.");
  process.exit(1);
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function httpsRequest(opts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch {}
        resolve({ status: res.statusCode, data, raw });
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Request timed out")); });
    if (body) req.write(body);
    req.end();
  });
}

function sb(method, p, body) {
  const bodyStr = body ? JSON.stringify(body) : null;
  return httpsRequest({
    hostname: SUPABASE_HOST,
    path: `/rest/v1/${p}`,
    method,
    headers: {
      "apikey":        SUPABASE_SERVICE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type":  "application/json",
      "Prefer":        "return=minimal",
      ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
    },
  }, bodyStr);
}

async function fetchAll(pathBase) {
  const out = []; let from = 0; const step = 1000;
  while (true) {
    const sep = pathBase.includes("?") ? "&" : "?";
    const { data } = await sb("GET", `${pathBase}${sep}offset=${from}&limit=${step}`);
    if (!Array.isArray(data) || data.length === 0) break;
    out.push(...data);
    if (data.length < step) break;
    from += step;
  }
  return out;
}

const foldName = s => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s*&\s*/g, " and ").replace(/\s+/g, " ").trim();

// Look up an artist's MusicBrainz sort name. Null on any miss, a match
// scoring below 90, or a matched name that isn't the one we asked for
// ("Tokyo" must not adopt "Tokyo Blade") — same rule as api/add-to-library.js.
function fetchSortName(artistName) {
  const q = `artist:"${artistName.replace(/"/g, '\\"')}"`;
  const url = `https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(q)}&fmt=json&limit=1`;
  return new Promise((resolve) => {
    https.get(url, { headers: { "User-Agent": "Liri/1.0 +https://getliri.com" } }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try {
          const artist = JSON.parse(Buffer.concat(chunks).toString())?.artists?.[0];
          const nameOk = artist && foldName(artist.name) === foldName(artistName);
          resolve((nameOk && artist.score >= 90 && artist["sort-name"]) ? artist["sort-name"] : null);
        } catch { resolve(null); }
      });
    }).on("error", () => resolve(null));
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n🗂  Liri artist sort-name backfill ${DRY ? "(DRY RUN)" : ""}${FORCE ? " (FORCE)" : ""}\n`);

  console.log("• Loading catalogue…");
  const rows = await fetchAll("catalogue?select=itunes_collection_id,artist_name,artist_sort_name");
  console.log(`  ${rows.length} albums total`);

  // One lookup per distinct artist, not per album.
  const pending = FORCE ? rows : rows.filter(r => !r.artist_sort_name);
  const byArtist = new Map();
  for (const r of pending) {
    const key = (r.artist_name || "").trim();
    if (!key) continue;
    if (!byArtist.has(key)) byArtist.set(key, []);
    byArtist.get(key).push(r);
  }
  let artists = [...byArtist.keys()];
  console.log(`  ${pending.length} albums missing a sort name → ${artists.length} distinct artists`);
  if (LIMIT) artists = artists.slice(0, LIMIT);
  console.log(`  ${artists.length} to process\n`);

  let updated = 0, nomatch = 0, errors = 0;

  for (const artist of artists) {
    const albums = byArtist.get(artist);
    const sortName = await fetchSortName(artist);
    if (!sortName) {
      nomatch++;
      console.log(`  ✗ no confident match: ${artist}`);
    } else if (DRY) {
      updated += albums.length;
      console.log(`  ~ would set "${sortName}" on ${albums.length} album(s): ${artist}`);
    } else {
      const ids = albums.map(a => a.itunes_collection_id).join(",");
      const { status } = await sb("PATCH",
        `catalogue?itunes_collection_id=in.(${ids})`,
        { artist_sort_name: sortName });
      if (status >= 200 && status < 300) {
        updated += albums.length;
        console.log(`  ✓ ${artist} → "${sortName}" (${albums.length} album(s))`);
      } else {
        errors++;
        console.log(`  ! update failed (${status}): ${artist}`);
      }
    }
    await sleep(1100); // MusicBrainz rate limit: ~1 req/s
  }

  console.log(`\n✅ Done. albums-updated=${updated} artists-no-match=${nomatch} errors=${errors}\n`);
})();
