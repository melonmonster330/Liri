#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// scripts/sweep-missing-lyrics.js — Liri Lyrics Backfill Sweeper
//
// Two-phase sweep:
//   1. DISCOVERY  — scan album_tracks for any row that has no matching
//                   track_lyrics row. For each missing one, try LRCLib.
//                   On hit, write track_lyrics. On miss, ensure an open
//                   bug_reports row exists (meta.category='missing_lyrics').
//   2. RESOLVE    — mark any open missing_lyrics bug as 'fixed' if its
//                   itunes_track_id now has a track_lyrics row (this picks
//                   up tracks that were filled in by discovery OR by the
//                   turntable's live gap-fill since the bug was filed).
//
// Usage (simplest — add your key to scripts/.env once, then just run):
//   node scripts/sweep-missing-lyrics.js
//
// Or pass keys inline (overrides .env):
//   SUPABASE_SERVICE_KEY=yyy node scripts/sweep-missing-lyrics.js
//
// Flags:
//   --limit=500     cap how many tracks to process this run (default: all)
//   --dry-run       don't write anything, just print what would happen
//
// Required env:
//   SUPABASE_SERVICE_KEY  → Supabase dashboard → Settings → API → service_role
//                           (bypasses RLS so we can write to track_lyrics + bug_reports)
//
// Safe to run repeatedly. LRCLib is rate-limited politely (3-at-a-time + 300ms).
// ─────────────────────────────────────────────────────────────────────────────

const https = require("https");
const fs    = require("fs");
const path  = require("path");
const { fetchLyrics, parseLrcToWords } = require("../api/_lib/lyrics");

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

const args   = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, "").split("=")));
const LIMIT  = args.limit ? parseInt(args.limit) : null;
const DRY    = "dry-run" in args;

if (!SUPABASE_SERVICE_KEY) {
  console.error("❌ Missing SUPABASE_SERVICE_KEY. Set it in scripts/.env or as an env var.");
  process.exit(1);
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────
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

function sb(method, path, body) {
  const bodyStr = body ? JSON.stringify(body) : null;
  return httpsRequest({
    hostname: SUPABASE_HOST,
    path: `/rest/v1/${path}`,
    method,
    headers: {
      "apikey":        SUPABASE_SERVICE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type":  "application/json",
      "Prefer":        "resolution=merge-duplicates,return=representation",
      ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
    },
  }, bodyStr);
}

// Lyrics fetching (LRCLib → NetEase → Genius) lives in api/_lib/lyrics.js
// so api/add-to-library.js and this script share the same provider chain.

// ── Page helper (Supabase caps at 1000 per request) ──────────────────────────
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

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n🔎 Liri lyrics sweep ${DRY ? "(DRY RUN)" : ""}\n`);

  // Pull all album_tracks (id, name, artist, album link, duration)
  console.log("• Loading album_tracks…");
  const tracks = await fetchAll(
    "album_tracks?select=itunes_track_id,track_name,artist_name,duration_ms,itunes_collection_id"
  );
  console.log(`  ${tracks.length} tracks total`);

  // Pull existing track_lyrics ids
  console.log("• Loading existing track_lyrics…");
  const lyricsRows = await fetchAll("track_lyrics?select=itunes_track_id");
  const haveLyrics = new Set(lyricsRows.map(r => r.itunes_track_id));
  console.log(`  ${haveLyrics.size} tracks have lyrics`);

  // Pull catalogue (for album_name lookup by collection id)
  console.log("• Loading catalogue (for album names)…");
  const catRows = await fetchAll("catalogue?select=itunes_collection_id,album_name");
  const albumNameById = new Map(catRows.map(r => [r.itunes_collection_id, r.album_name]));

  // Tracks missing lyrics
  let missing = tracks.filter(t => !haveLyrics.has(t.itunes_track_id));
  console.log(`\n  → ${missing.length} tracks missing lyrics`);
  if (LIMIT && missing.length > LIMIT) {
    missing = missing.slice(0, LIMIT);
    console.log(`  (capped to ${LIMIT} this run)`);
  }
  if (missing.length === 0) {
    console.log("\n✅ Nothing to do.\n");
    return;
  }

  // Pull existing open missing_lyrics bug_reports keyed by itunes_track_id
  console.log("• Loading open missing_lyrics bug_reports…");
  const openBugs = await fetchAll(
    `bug_reports?status=eq.open&meta->>category=eq.missing_lyrics&select=id,meta`
  );
  const openBugByTid = new Map();
  for (const b of openBugs) {
    const tid = b.meta?.itunes_track_id;
    if (tid != null) openBugByTid.set(tid, b.id);
  }
  console.log(`  ${openBugs.length} open lyric bugs`);

  // ── Phase 1: discovery + retry ────────────────────────────────────────────
  console.log(`\n🎯 Sweeping ${missing.length} tracks (LRCLib → Genius)…\n`);
  let filled = 0, stillMissing = 0, newBugs = 0, alreadyBugged = 0;
  const bySource = {};
  const BATCH = 3;

  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH);
    await Promise.all(batch.map(async (t) => {
      const albumName = albumNameById.get(t.itunes_collection_id) || "";
      const durSec    = t.duration_ms ? t.duration_ms / 1000 : null;
      const found     = await fetchLyrics(t.track_name, t.artist_name, albumName, durSec);

      if (found) {
        filled++;
        bySource[found.source] = (bySource[found.source] || 0) + 1;
        if (DRY) {
          console.log(`  ✓ would fill [${found.source}]: "${t.track_name}" — ${t.artist_name}`);
        } else {
          await sb("POST", "track_lyrics?on_conflict=itunes_track_id", {
            itunes_track_id: t.itunes_track_id,
            lrc_raw:      found.lrc,
            lyrics_plain: found.plain,
            words_json:   found.lrc ? parseLrcToWords(found.lrc) : null,
            source:       found.source,
            fetched_at:   new Date().toISOString(),
          });
          // Close any existing open bug for this track
          const bugId = openBugByTid.get(t.itunes_track_id);
          if (bugId) {
            await sb("PATCH", `bug_reports?id=eq.${bugId}`, {
              status:   "fixed",
              fixed_at: new Date().toISOString(),
            });
          }
          console.log(`  ✓ filled [${found.source}]: "${t.track_name}" — ${t.artist_name}`);
        }
      } else {
        stillMissing++;
        if (openBugByTid.has(t.itunes_track_id)) {
          alreadyBugged++;
        } else {
          newBugs++;
          if (DRY) {
            console.log(`  ✗ would file bug: "${t.track_name}" — ${t.artist_name}`);
          } else {
            await sb("POST", "bug_reports", {
              user_id:     null,
              user_email:  null,
              app_version: null,
              platform:    "auto",
              description: `Missing lyrics: "${t.track_name}" by ${t.artist_name} on ${albumName}`,
              meta: {
                category:             "missing_lyrics",
                source:               "backfill-sweep",
                requires_app_push:    false,
                itunes_track_id:      t.itunes_track_id,
                itunes_collection_id: t.itunes_collection_id,
                track_name:           t.track_name,
                artist_name:          t.artist_name,
                album_name:           albumName,
                duration_ms:          t.duration_ms,
              },
            });
            console.log(`  ✗ filed bug: "${t.track_name}" — ${t.artist_name}`);
          }
        }
      }
    }));
    await sleep(300); // be nice to LRCLib
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n📊 Sweep complete${DRY ? " (DRY RUN — no writes)" : ""}`);
  console.log(`   filled:         ${filled}`);
  for (const [src, n] of Object.entries(bySource)) {
    console.log(`     • via ${src.padEnd(8)}: ${n}`);
  }
  console.log(`   still missing:  ${stillMissing}`);
  console.log(`     • new bugs filed:     ${newBugs}`);
  console.log(`     • already had a bug:  ${alreadyBugged}`);
  console.log("");
})().catch(e => {
  console.error("\n❌ Sweep failed:", e);
  process.exit(1);
});
