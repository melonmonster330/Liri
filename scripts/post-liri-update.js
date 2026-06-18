#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// scripts/post-liri-update.js — Post an app-update announcement to the feed
//
// Publishes a plain-text "update" post as the official Liri account
// (username='liri', is_official=true) so it shows in every user's feed.
//
// Usage (add SUPABASE_SERVICE_KEY to scripts/.env once):
//   node scripts/post-liri-update.js "v1.13 is here — faster record loading, lyric posts you can scroll, and a fresh Feed. Pull a record and share what you're spinning."
//
// Or pipe a longer message:
//   node scripts/post-liri-update.js --file=changelog.txt
//
// Flags:
//   --file=path   read the post text from a file instead of an argument
//   --dry-run     print what would be posted, write nothing
//
// Requires the post_kind 'update' enum value — run
//   supabase/migrations/20260619_post_update_kind.sql  first.
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
}

const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_URL_RAW     = process.env.SUPABASE_URL || "https://xjdjpaxgymgbvcwmvorc.supabase.co";
const SUPABASE_HOST        = SUPABASE_URL_RAW.replace(/^https?:\/\//, "").replace(/\/$/, "");

if (!SUPABASE_SERVICE_KEY) {
  console.error("❌ Missing SUPABASE_SERVICE_KEY. Set it in scripts/.env or as an env var.");
  process.exit(1);
}

// ── Parse args ───────────────────────────────────────────────────────────────
const rawArgs = process.argv.slice(2);
const flags   = Object.fromEntries(rawArgs.filter(a => a.startsWith("--")).map(a => a.replace(/^--/, "").split("=")));
const DRY     = "dry-run" in flags;
let text = flags.file ? fs.readFileSync(flags.file, "utf8").trim()
                      : rawArgs.filter(a => !a.startsWith("--")).join(" ").trim();

if (!text) {
  console.error('❌ No text. Usage: node scripts/post-liri-update.js "Your update message"');
  process.exit(1);
}

// ── HTTP helper ──────────────────────────────────────────────────────────────
function sb(method, p, body) {
  const bodyStr = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: SUPABASE_HOST,
      path: `/rest/v1/${p}`,
      method,
      headers: {
        "apikey":        SUPABASE_SERVICE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Content-Type":  "application/json",
        "Prefer":        "return=representation",
        ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => { let d = null; try { d = JSON.parse(Buffer.concat(chunks).toString()); } catch {} resolve({ status: res.statusCode, data: d }); });
    });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  // Find the official Liri account.
  const { data: profs } = await sb("GET", "profiles?username=eq.liri&select=id,username,display_name&limit=1");
  let liri = Array.isArray(profs) && profs[0];
  if (!liri) {
    const { data: off } = await sb("GET", "profiles?is_official=eq.true&select=id,username&limit=1");
    liri = Array.isArray(off) && off[0];
  }
  if (!liri) {
    console.error("❌ Couldn't find the Liri account (username='liri' or is_official=true). Run supabase/seed_liri_account.sql first.");
    process.exit(1);
  }

  console.log(`\n📣 Posting as @${liri.username} (${liri.id})\n---\n${text}\n---\n`);
  if (DRY) { console.log("(dry run — nothing posted)\n"); return; }

  const { status, data } = await sb("POST", "posts", {
    author_id:  liri.id,
    kind:       "update",
    source:     "auto",
    visibility: "public",
    caption:    text,
  });

  if (status >= 200 && status < 300) {
    console.log("✅ Posted to the feed.\n");
  } else {
    console.error(`❌ Failed (${status}):`, JSON.stringify(data));
    process.exit(1);
  }
})();
