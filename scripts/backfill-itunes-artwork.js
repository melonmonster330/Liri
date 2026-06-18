#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// scripts/backfill-itunes-artwork.js — Replace catalogue artwork with iTunes art
//
// For every album already in the shared `catalogue` table, search iTunes for a
// confident match and update artwork_url to Apple's clean 600x600 artwork.
// This upgrades albums that were added via the old Discogs flow (low-quality
// user scans) without anyone having to re-add them — the turntable, library,
// and profile all read artwork from catalogue via a join.
//
// Match safety: only updates when BOTH the album name and artist name match
// (normalized), so we never swap in art for the wrong record.
//
// Usage (add SUPABASE_SERVICE_KEY to scripts/.env once, then):
//   node scripts/backfill-itunes-artwork.js
//
// Flags:
//   --limit=200   cap albums processed this run (default: all)
//   --dry-run     print what would change, write nothing
//   --force       overwrite even rows that already look like iTunes art
//
// Required env:
//   SUPABASE_SERVICE_KEY  → Supabase → Settings → API → service_role
//
// Safe to run repeatedly. iTunes is queried politely (3-at-a-time + 300ms).
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
const norm  = s => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

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

function itunesGet(url) {
  return new Promise((resolve) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { resolve(null); } });
    }).on("error", () => resolve(null));
  });
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

// Find a confident iTunes artwork match for an album. Returns a 600x600 URL or null.
async function findItunesArt(albumName, artistName) {
  const term = `${artistName} ${albumName}`.trim();
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=album&limit=5`;
  const data = await itunesGet(url);
  const results = data?.results || [];
  const nAlbum = norm(albumName), nArtist = norm(artistName);
  const match = results.find(r => {
    const a = norm(r.collectionName), ar = norm(r.artistName);
    const albumOk  = a === nAlbum || a.includes(nAlbum) || nAlbum.includes(a);
    const artistOk = ar === nArtist || ar.includes(nArtist) || nArtist.includes(ar);
    return albumOk && artistOk && r.artworkUrl100;
  });
  if (!match) return null;
  return match.artworkUrl100.replace("100x100bb", "600x600bb");
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n🎨 Liri artwork backfill ${DRY ? "(DRY RUN)" : ""}${FORCE ? " (FORCE)" : ""}\n`);

  console.log("• Loading catalogue…");
  let rows = await fetchAll("catalogue?select=itunes_collection_id,album_name,artist_name,artwork_url");
  console.log(`  ${rows.length} albums total`);

  // Skip rows that already point at Apple's CDN unless --force.
  if (!FORCE) {
    const before = rows.length;
    rows = rows.filter(r => !(r.artwork_url || "").includes("mzstatic.com"));
    console.log(`  ${before - rows.length} already on iTunes art — skipping (use --force to recheck)`);
  }
  if (LIMIT) rows = rows.slice(0, LIMIT);
  console.log(`  ${rows.length} to process\n`);

  let updated = 0, nomatch = 0, unchanged = 0, errors = 0;

  for (let i = 0; i < rows.length; i += 3) {
    const batch = rows.slice(i, i + 3);
    await Promise.all(batch.map(async (r) => {
      try {
        const art = await findItunesArt(r.album_name, r.artist_name);
        if (!art) { nomatch++; console.log(`  ✗ no match: ${r.album_name} — ${r.artist_name}`); return; }
        if (art === r.artwork_url) { unchanged++; return; }
        if (DRY) { updated++; console.log(`  ~ would update: ${r.album_name} — ${r.artist_name}`); return; }
        const { status } = await sb("PATCH",
          `catalogue?itunes_collection_id=eq.${encodeURIComponent(r.itunes_collection_id)}`,
          { artwork_url: art });
        if (status >= 200 && status < 300) { updated++; console.log(`  ✓ ${r.album_name} — ${r.artist_name}`); }
        else { errors++; console.log(`  ! update failed (${status}): ${r.album_name}`); }
      } catch (e) { errors++; console.log(`  ! error: ${r.album_name} — ${e.message}`); }
    }));
    await sleep(300);
  }

  console.log(`\n✅ Done. updated=${updated} unchanged=${unchanged} no-match=${nomatch} errors=${errors}\n`);
})();
