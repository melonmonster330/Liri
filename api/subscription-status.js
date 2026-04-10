// api/subscription-status.js — Get current user's subscription tier
//
// GET /api/subscription-status
// Returns:
//   {
//     tier:       "free" | "premium",
//     status:     "active" | "trialing" | "past_due" | "canceled" | ...,
//     albumCount: number,   // current library size
//     albumLimit: 10 | null // null = unlimited
//   }
//
// Used by library.html on load to show plan info and enforce the album limit UI.

const { verifyAuth } = require("./_lib/auth");
const https = require("https");

const ALLOWED_ORIGINS = ["https://getliri.com", "capacitor://localhost"];
const FREE_ALBUM_LIMIT = 10;

function supabaseGet(path) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const hostname = url.replace(/^https?:\/\//, "");

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname,
        path: `/rest/v1/${path}`,
        method: "GET",
        headers: {
          "apikey":        key,
          "Authorization": `Bearer ${key}`,
          "Content-Type":  "application/json",
          "Prefer":        "count=exact",
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()), headers: res.headers }); }
          catch { resolve({ status: res.statusCode, data: null, headers: res.headers }); }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

module.exports = async (req, res) => {
  const origin = req.headers.origin || "";
  res.setHeader("Access-Control-Allow-Origin",  ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET")    return res.status(405).json({ error: "Method not allowed" });

  const auth = await verifyAuth(req);
  if (!auth) return res.status(401).json({ error: "Unauthorized" });

  try {
    // Fetch subscription row and ever-added count in parallel
    // albumCount uses user_library_ever (never decrements on delete) so deleting
    // a record doesn't free up a free slot.
    const [subResult, libResult] = await Promise.all([
      supabaseGet(`subscriptions?user_id=eq.${encodeURIComponent(auth.userId)}&select=tier,status,current_period_end&limit=1`),
      supabaseGet(`user_library_ever?user_id=eq.${encodeURIComponent(auth.userId)}&select=itunes_collection_id`),
    ]);

    const sub        = Array.isArray(subResult.data) ? subResult.data[0] : null;
    const albumCount = Array.isArray(libResult.data) ? libResult.data.length : 0;
    // Also expose ever-added IDs so client can detect re-addable albums
    const everAddedIds = Array.isArray(libResult.data)
      ? libResult.data.map(r => String(r.itunes_collection_id))
      : [];

    // Determine effective tier
    // Unlimited email list bypasses all limits
    let tier   = "free";
    let status = "active";

    if (auth.isUnlimited) {
      tier = "premium";
    } else if (sub) {
      tier   = sub.tier   || "free";
      status = sub.status || "active";
      // Treat past_due or unpaid as still premium (grace period)
      if (tier === "premium" && status === "canceled") {
        tier = "free";
      }
    }

    const isPremium  = tier === "premium";
    const albumLimit = isPremium ? null : FREE_ALBUM_LIMIT;

    return res.status(200).json({
      tier,
      status,
      albumCount,
      albumLimit,
      everAddedIds,
      currentPeriodEnd: sub?.current_period_end || null,
    });
  } catch (e) {
    console.error("[subscription-status] error:", e.message);
    return res.status(500).json({ error: "Could not fetch subscription status." });
  }
};
