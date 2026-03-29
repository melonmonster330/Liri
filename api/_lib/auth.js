// api/_lib/auth.js — Liri server-side auth helper
//
// Verifies Supabase JWTs and checks the unlimited-access list.
//
// Required Vercel environment variables:
//   SUPABASE_URL             — e.g. https://xjdjpaxgymgbvcwmvorc.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY — full service role key (never expose to client)
//   SUPABASE_JWT_SECRET      — found in Supabase dashboard → Project Settings → API → JWT Secret
//   UNLIMITED_EMAILS         — comma-separated list of emails that bypass the free limit
//                              e.g. "test@test.com,hmhelenmenne@gmail.com"
//                              Edit in Vercel dashboard → Project Settings → Environment Variables

const crypto = require("crypto");
const https  = require("https");

// ── Unlimited email list ──────────────────────────────────────────────────────
// Read from the UNLIMITED_EMAILS env var (set in Vercel, never in git).
// Returns a lowercase Set for O(1) lookup.
function getUnlimitedEmails() {
  return new Set(
    (process.env.UNLIMITED_EMAILS || "")
      .split(",")
      .map(e => e.trim().toLowerCase())
      .filter(Boolean)
  );
}

// ── JWT verification ──────────────────────────────────────────────────────────
// Supabase JWTs are signed with HMAC-SHA256 using the project JWT secret.
// We verify locally so there's no extra round-trip to Supabase on every request.
function decodeAndVerifyJWT(token) {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) {
    console.error("SUPABASE_JWT_SECRET env var is not set");
    return null;
  }

  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, sigB64] = parts;

  // Verify signature
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest("base64url");

  if (expected !== sigB64) return null;

  // Decode payload
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));

    // Check expiry
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;

    return payload;
  } catch {
    return null;
  }
}

// ── Main: extract + verify auth from a request ───────────────────────────────
// Returns { userId, email, isUnlimited } or null if the token is missing/invalid.
function verifyAuth(req) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) return null;

  const token = authHeader.slice(7);
  const payload = decodeAndVerifyJWT(token);
  if (!payload) return null;

  const userId = payload.sub;        // Supabase user UUID
  const email  = (payload.email || "").toLowerCase();

  if (!userId) return null;

  const isUnlimited = getUnlimitedEmails().has(email);
  return { userId, email, isUnlimited };
}

// ── Supabase REST helpers (service role) ─────────────────────────────────────
// These bypass RLS — only call them from server-side code.

function supabaseRequest(method, path, body) {
  const url  = process.env.SUPABASE_URL;
  const key  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return Promise.reject(new Error("Supabase env vars not set"));

  const hostname = url.replace(/^https?:\/\//, "");
  const bodyStr  = body ? JSON.stringify(body) : null;

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname,
        path: `/rest/v1/${path}`,
        method,
        headers: {
          "apikey":        key,
          "Authorization": `Bearer ${key}`,
          "Content-Type":  "application/json",
          "Prefer":        "return=representation,resolution=merge-duplicates",
          ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          try { resolve({ status: res.statusCode, data: JSON.parse(text) }); }
          catch { resolve({ status: res.statusCode, data: text }); }
        });
      }
    );
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// Get the current recognition count for a user. Returns 0 if no row exists.
async function getUsageCount(userId) {
  const { data } = await supabaseRequest(
    "GET",
    `user_usage?user_id=eq.${encodeURIComponent(userId)}&select=recognition_count`
  );
  return Array.isArray(data) && data[0] ? (data[0].recognition_count || 0) : 0;
}

// Increment the recognition count by 1. Creates the row if it doesn't exist.
async function incrementUsage(userId) {
  const current = await getUsageCount(userId);
  await supabaseRequest("POST", "user_usage", {
    user_id: userId,
    recognition_count: current + 1,
    updated_at: new Date().toISOString(),
  });
}

module.exports = { verifyAuth, getUsageCount, incrementUsage };
