// Liri — Submit lyrics to lrclib.net
//
// lrclib uses a proof-of-work challenge to prevent spam submissions.
// This route handles the full flow server-side:
//   1. POST /api/request-challenge → { prefix, target }
//   2. Solve PoW: find nonce where SHA256(prefix:nonce) < target
//   3. POST /api/publish with X-Publish-Token: prefix:nonce
//
// Caller must be authenticated as Helen (admin) — checked via Supabase.

const https = require("https");
const crypto = require("crypto");

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function httpsRequest(hostname, path, method, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const opts = { hostname, path, method, headers };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, raw: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("timeout")); });
    if (body) req.write(body);
    req.end();
  });
}

// ── Proof-of-work solver ─────────────────────────────────────────────────────
// lrclib's challenge: find nonce where SHA256(`${prefix}:${nonce}`) < target
// Target is a 64-char hex string — compare as BigInt.

function solveChallenge(prefix, target) {
  const targetBig = BigInt("0x" + target);
  let nonce = 0;
  while (true) {
    const attempt = `${prefix}:${nonce}`;
    const hash = crypto.createHash("sha256").update(attempt).digest("hex");
    if (BigInt("0x" + hash) < targetBig) return nonce;
    nonce++;
    // Safety: bail after 10M iterations (~5-10s) — lrclib targets << 1M normally
    if (nonce > 10_000_000) throw new Error("PoW took too long — target may be too hard");
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-admin-password");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Auth — admin password (same as sync-catalogue)
  const adminPw  = process.env.ADMIN_PASSWORD;
  const provided = req.headers["x-admin-password"];
  const pwBuf = Buffer.from(String(adminPw || ""));
  const prBuf = Buffer.from(String(provided || ""));
  const pwOk  = pwBuf.length === prBuf.length && crypto.timingSafeEqual(pwBuf, prBuf);
  if (!adminPw || !provided || !pwOk) return res.status(401).json({ error: "Unauthorized" });

  const { trackName, artistName, albumName, duration, syncedLyrics, plainLyrics } = req.body || {};
  if (!trackName || !artistName || !albumName || !duration) {
    return res.status(400).json({ error: "trackName, artistName, albumName, duration required" });
  }
  if (!syncedLyrics && !plainLyrics) {
    return res.status(400).json({ error: "Provide syncedLyrics or plainLyrics (or both)" });
  }

  try {
    // Step 1: request challenge
    const challengeRes = await httpsRequest(
      "lrclib.net", "/api/request-challenge", "POST",
      { "Content-Type": "application/json", "Lrclib-Client": "Liri/1.0 (https://getliri.com)" },
      JSON.stringify({})
    );
    const challenge = JSON.parse(challengeRes.raw);
    if (!challenge.prefix || !challenge.target) {
      return res.status(502).json({ error: "Failed to get PoW challenge from lrclib" });
    }

    // Step 2: solve PoW
    const nonce = solveChallenge(challenge.prefix, challenge.target);
    const token = `${challenge.prefix}:${nonce}`;

    // Step 3: publish
    const publishBody = JSON.stringify({
      trackName,
      artistName,
      albumName,
      duration: Number(duration),
      ...(syncedLyrics ? { syncedLyrics } : {}),
      ...(plainLyrics  ? { plainLyrics  } : {}),
    });

    const publishRes = await httpsRequest(
      "lrclib.net", "/api/publish", "POST",
      {
        "Content-Type": "application/json",
        "X-Publish-Token": token,
        "Lrclib-Client": "Liri/1.0 (https://getliri.com)",
        "Content-Length": Buffer.byteLength(publishBody),
      },
      publishBody
    );

    if (publishRes.status === 201 || publishRes.status === 200) {
      return res.status(200).json({ ok: true, message: "Lyrics published to lrclib!" });
    }

    let errBody = {};
    try { errBody = JSON.parse(publishRes.raw); } catch {}
    return res.status(publishRes.status).json({
      error: errBody.message || errBody.error || `lrclib returned ${publishRes.status}`,
    });

  } catch (e) {
    console.error("submit-lyrics error:", e);
    return res.status(500).json({ error: e.message || "Internal error" });
  }
};
