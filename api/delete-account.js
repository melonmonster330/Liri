// api/delete-account.js — Permanently delete a user's account and all data
//
// POST /api/delete-account
// Returns: { success: true }
//
// Flow:
//   1. Verify JWT
//   2. Cancel active Stripe subscription (if any) immediately
//   3. Delete user from Supabase auth.users — cascades to all user tables

const { verifyAuth } = require("./_lib/auth");
const { stripeRequest } = require("./_lib/stripe");
const https = require("https");

const ALLOWED_ORIGINS = ["https://getliri.com", "https://www.getliri.com", "capacitor://localhost"];

function supabaseRequest(method, path, body) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const hostname = url.replace(/^https?:\/\//, "");
  const bodyStr = body ? JSON.stringify(body) : "";

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname,
        path: `/rest/v1/${path}`,
        method,
        headers: {
          "apikey":          key,
          "Authorization":   `Bearer ${key}`,
          "Content-Type":    "application/json",
          "Content-Length":  Buffer.byteLength(bodyStr),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
          catch { resolve({ status: res.statusCode, body: null }); }
        });
      }
    );
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function supabaseAdminDeleteUser(userId) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const hostname = url.replace(/^https?:\/\//, "");

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname,
        path: `/auth/v1/admin/users/${userId}`,
        method: "DELETE",
        headers: {
          "apikey":        key,
          "Authorization": `Bearer ${key}`,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => resolve(res.statusCode));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

module.exports = async (req, res) => {
  const origin = req.headers.origin || "";
  res.setHeader("Access-Control-Allow-Origin",  ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")   return res.status(405).json({ error: "Method not allowed" });

  const auth = await verifyAuth(req);
  if (!auth || auth._authError || !auth.userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    // Cancel Stripe subscription if active
    const subRows = await supabaseRequest(
      "GET",
      `subscriptions?user_id=eq.${encodeURIComponent(auth.userId)}&select=stripe_subscription_id,status&limit=1`
    );
    const sub = Array.isArray(subRows.body) && subRows.body[0];
    if (sub?.stripe_subscription_id && ["active", "trialing"].includes(sub.status)) {
      try {
        await stripeRequest("DELETE", `/v1/subscriptions/${sub.stripe_subscription_id}`);
      } catch (stripeErr) {
        // Log but don't block — user should still be able to delete their account
        console.error("[delete-account] stripe cancel error:", stripeErr.message);
      }
    }

    // Delete user — cascades to all user_vinyl_library, user_usage, song_history, etc.
    const statusCode = await supabaseAdminDeleteUser(auth.userId);
    if (statusCode >= 400) {
      return res.status(500).json({ error: "Failed to delete account. Please try again." });
    }

    return res.status(200).json({ success: true });
  } catch (e) {
    console.error("[delete-account] error:", e.message);
    return res.status(500).json({ error: "Could not delete account. Please try again." });
  }
};
