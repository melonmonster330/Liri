// api/test-auth.js — Liri Auth Diagnostics
//
// Troubleshooting endpoint. Hit this from the browser or test page to see
// exactly what's happening with auth at every layer.
//
// GET  /api/test-auth          → env var check + Supabase connectivity
// GET  /api/test-auth?full=1   → same, plus attempts /auth/v1/user if Bearer token provided
//
// REMOVE OR GATE BEHIND AN IP CHECK before going to production.

const https = require("https");

function httpsGet(hostname, path, headers = {}) {
  return new Promise((resolve) => {
    const req = https.request({ hostname, path, method: "GET", headers }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        let body = Buffer.concat(chunks).toString();
        try { body = JSON.parse(body); } catch {}
        resolve({ status: res.statusCode, body });
      });
    });
    req.on("error", (e) => resolve({ status: null, error: e.message }));
    req.setTimeout(6000, () => { req.destroy(); resolve({ status: null, error: "timeout" }); });
    req.end();
  });
}

function maskKey(key) {
  if (!key) return "(not set)";
  if (key.length < 12) return "(too short — likely wrong value)";
  return key.slice(0, 12) + "..." + key.slice(-6);
}

function detectKeyFormat(key) {
  if (!key) return "missing";
  if (key.startsWith("sb_publishable_")) return "new-publishable (anon key)";
  if (key.startsWith("sb_secret_"))      return "new-secret (service role)";
  if (key.startsWith("eyJ"))             return "legacy-jwt";
  return "unknown";
}

module.exports = async (req, res) => {
  // Only allow from trusted origins
  const ALLOWED = ["https://getliri.com", "capacitor://localhost"];
  const origin  = req.headers.origin || "";
  res.setHeader("Access-Control-Allow-Origin", ALLOWED.includes(origin) ? origin : "https://getliri.com");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const supabaseUrl     = process.env.SUPABASE_URL || "";
  const serviceKey      = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const jwtSecret       = process.env.SUPABASE_JWT_SECRET || "";
  const hostname        = supabaseUrl.replace(/^https?:\/\//, "");

  const report = {
    timestamp: new Date().toISOString(),
    env: {
      SUPABASE_URL:              supabaseUrl ? supabaseUrl : "(not set)",
      SUPABASE_SERVICE_ROLE_KEY: maskKey(serviceKey),
      SUPABASE_SERVICE_ROLE_KEY_format: detectKeyFormat(serviceKey),
      SUPABASE_JWT_SECRET:       jwtSecret ? "(set)" : "(not set)",
    },
    connectivity: {},
    token_test:   null,
  };

  // ── 1. Supabase reachability — ping the JWKS endpoint ──────────────────────
  if (hostname) {
    const jwks = await httpsGet(hostname, "/auth/v1/jwks");
    report.connectivity.jwks = {
      status: jwks.status,
      ok:     jwks.status === 200,
      error:  jwks.error || null,
      key_count: jwks.status === 200 && Array.isArray(jwks.body?.keys) ? jwks.body.keys.length : null,
    };
  } else {
    report.connectivity.jwks = { ok: false, error: "SUPABASE_URL not set" };
  }

  // ── 2. Can the service role key reach the admin API? ──────────────────────
  if (hostname && serviceKey) {
    const adminCheck = await httpsGet(hostname, "/rest/v1/", {
      "apikey":        serviceKey,
      "Authorization": `Bearer ${serviceKey}`,
    });
    report.connectivity.rest_api = {
      status: adminCheck.status,
      ok:     adminCheck.status === 200 || adminCheck.status === 204 || adminCheck.status === 404,
      error:  adminCheck.error || null,
      note:   "404 is fine here — just checking Supabase REST is reachable with this key",
    };
  }

  // ── 3. If Bearer token provided, test /auth/v1/user ───────────────────────
  const authHeader = req.headers.authorization || "";
  if (authHeader.startsWith("Bearer ") && hostname && serviceKey) {
    const userToken = authHeader.slice(7);

    // Attempt 1: apikey = service role key (current approach in auth.js)
    const attempt1 = await httpsGet(hostname, "/auth/v1/user", {
      "apikey":        serviceKey,
      "Authorization": `Bearer ${userToken}`,
    });

    // Attempt 2: no apikey header — just the user Bearer token
    const attempt2 = await httpsGet(hostname, "/auth/v1/user", {
      "Authorization": `Bearer ${userToken}`,
    });

    // Attempt 3: try /auth/v1/user with service key as admin (for reference)
    const attempt3 = await httpsGet(hostname, "/auth/v1/user", {
      "apikey":        serviceKey,
      "Authorization": `Bearer ${serviceKey}`,
    });

    report.token_test = {
      token_prefix:         userToken.slice(0, 20) + "...",
      token_looks_like_jwt: userToken.startsWith("eyJ"),
      "attempt1_serviceKey_as_apikey": {
        status: attempt1.status,
        ok:     attempt1.status === 200,
        user_id: attempt1.status === 200 ? attempt1.body?.id : null,
        error:   attempt1.status !== 200 ? (attempt1.body?.message || attempt1.body?.msg || attempt1.error) : null,
      },
      "attempt2_no_apikey": {
        status: attempt2.status,
        ok:     attempt2.status === 200,
        user_id: attempt2.status === 200 ? attempt2.body?.id : null,
        error:   attempt2.status !== 200 ? (attempt2.body?.message || attempt2.body?.msg || attempt2.error) : null,
      },
      "attempt3_serviceKey_as_bearer_admin_mode": {
        status: attempt3.status,
        ok:     attempt3.status === 200,
        note:   "This should work only if using service role as admin",
        error:   attempt3.status !== 200 ? (attempt3.body?.message || attempt3.body?.msg || attempt3.error) : null,
      },
    };
  } else if (!authHeader.startsWith("Bearer ")) {
    report.token_test = {
      skipped: true,
      reason:  "No Bearer token in Authorization header. Add ?full=1 and sign in first, then hit this URL from the test page.",
    };
  }

  return res.status(200).json(report);
};
