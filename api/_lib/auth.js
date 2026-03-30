// api/_lib/auth.js — Liri server-side auth helper
//
// Verifies Supabase JWTs and checks the unlimited-access list.
// Supports both HS256 (old Supabase projects) and ES256 (new Supabase projects).
//
// Required Vercel environment variables:
//   SUPABASE_URL             — e.g. https://xjdjpaxgymgbvcwmvorc.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY — full service role key (never expose to client)
//   SUPABASE_JWT_SECRET      — JWT secret from Supabase dashboard (used for HS256 only)
//   UNLIMITED_EMAILS         — comma-separated emails that bypass the free limit
//                              e.g. "hmhelenmenne@gmail.com"
//                              Edit in Vercel dashboard → Project Settings → Environment Variables

const crypto = require("crypto");
const https  = require("https");

// ── Unlimited email list ──────────────────────────────────────────────────────
function getUnlimitedEmails() {
  return new Set(
    (process.env.UNLIMITED_EMAILS || "")
      .split(",")
      .map(e => e.trim().toLowerCase())
      .filter(Boolean)
  );
}

// ── JWKS cache (ES256 public keys from Supabase) ──────────────────────────────
// Fetched once per cold start, then cached for 1 hour.
let _jwksKeys  = null;
let _jwksExpiry = 0;

async function fetchJwks() {
  if (_jwksKeys && Date.now() < _jwksExpiry) return _jwksKeys;

  const supabaseUrl = process.env.SUPABASE_URL || "";
  const hostname    = supabaseUrl.replace(/^https?:\/\//, "");
  if (!hostname) return [];

  return new Promise((resolve) => {
    const req = https.request(
      { hostname, path: "/auth/v1/jwks", method: "GET" },
      (res) => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            _jwksKeys   = Array.isArray(data.keys) ? data.keys : [];
            _jwksExpiry = Date.now() + 60 * 60 * 1000; // cache 1 hour
            resolve(_jwksKeys);
          } catch {
            resolve([]);
          }
        });
      }
    );
    req.on("error", () => resolve([]));
    req.setTimeout(5000, () => { req.destroy(); resolve([]); });
    req.end();
  });
}

// ── JWT verification — supports HS256 and ES256 ───────────────────────────────
async function decodeAndVerifyJWT(token) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;

  let header, payload;
  try {
    header  = JSON.parse(Buffer.from(headerB64,  "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  // Check expiry before doing any crypto
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;

  if (header.alg === "HS256") {
    // Legacy Supabase projects: HMAC-SHA256 with the JWT secret
    const secret = process.env.SUPABASE_JWT_SECRET;
    if (!secret) { console.error("SUPABASE_JWT_SECRET not set"); return null; }
    const expected = crypto
      .createHmac("sha256", secret)
      .update(`${headerB64}.${payloadB64}`)
      .digest("base64url");
    if (expected !== sigB64) return null;

  } else if (header.alg === "ES256") {
    // Modern Supabase projects: ECDSA-SHA256 with public key from JWKS
    const keys = await fetchJwks();
    const candidates = header.kid
      ? keys.filter(k => k.kid === header.kid)
      : keys.filter(k => k.alg === "ES256" || k.kty === "EC");

    if (!candidates.length) {
      console.error("ES256: no matching JWK found for kid:", header.kid);
      return null;
    }

    const message = Buffer.from(`${headerB64}.${payloadB64}`);
    const sig     = Buffer.from(sigB64, "base64url");

    let verified = false;
    for (const jwk of candidates) {
      try {
        // Node 15+ supports createPublicKey from JWK directly.
        // Vercel runs Node 18+, so this is always available.
        const pubKey = crypto.createPublicKey({ key: jwk, format: "jwk" });
        // JWTs use IEEE P1363 signature encoding (raw r||s), not DER.
        // dsaEncoding: "ieee-p1363" tells Node to expect that format.
        if (crypto.verify("SHA256", message, { key: pubKey, dsaEncoding: "ieee-p1363" }, sig)) {
          verified = true;
          break;
        }
      } catch {
        // Key didn't match or wasn't usable — try next candidate
      }
    }

    if (!verified) return null;

  } else {
    console.error("Unknown JWT algorithm:", header.alg);
    return null;
  }

  return payload;
}

// ── Main: extract + verify auth from a request ───────────────────────────────
// Returns { userId, email, isUnlimited } or null if the token is missing/invalid.
// IMPORTANT: This is now async — callers must await it.
async function verifyAuth(req) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) return null;

  const token   = authHeader.slice(7);
  const payload = await decodeAndVerifyJWT(token);
  if (!payload) return null;

  const userId = payload.sub;
  const email  = (payload.email || "").toLowerCase();
  if (!userId) return null;

  const isUnlimited = getUnlimitedEmails().has(email);
  return { userId, email, isUnlimited };
}

// ── Supabase REST helpers (service role — bypasses RLS) ──────────────────────

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

async function getUsageCount(userId) {
  const { data } = await supabaseRequest(
    "GET",
    `user_usage?user_id=eq.${encodeURIComponent(userId)}&select=recognition_count`
  );
  return Array.isArray(data) && data[0] ? (data[0].recognition_count || 0) : 0;
}

async function incrementUsage(userId) {
  const current = await getUsageCount(userId);
  await supabaseRequest("POST", "user_usage", {
    user_id: userId,
    recognition_count: current + 1,
    updated_at: new Date().toISOString(),
  });
}

module.exports = { verifyAuth, getUsageCount, incrementUsage };
