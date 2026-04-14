// api/stripe-portal.js — Open the Stripe Customer Portal
//
// POST /api/stripe-portal
// Returns: { url: "https://billing.stripe.com/..." }
//
// The portal lets premium users manage their subscription:
//   • Update payment method
//   • Cancel subscription
//   • View billing history
//
// Required env vars: STRIPE_SECRET_KEY (see _lib/stripe.js)

const { verifyAuth }          = require("./_lib/auth");
const { createPortalSession } = require("./_lib/stripe");

const ALLOWED_ORIGINS = ["https://getliri.com", "https://www.getliri.com", "capacitor://localhost"];
const RETURN_URL      = "https://getliri.com/library";

// ── Supabase lookup: find the Stripe customer_id for a user ──────────────────
const https = require("https");

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
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
          catch { resolve(null); }
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
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")   return res.status(405).json({ error: "Method not allowed" });

  const auth = await verifyAuth(req);
  if (!auth) return res.status(401).json({ error: "Unauthorized" });

  try {
    // Look up the Stripe customer id from the subscriptions table
    const rows = await supabaseGet(
      `subscriptions?user_id=eq.${encodeURIComponent(auth.userId)}&select=stripe_customer_id&limit=1`
    );
    const customerId = Array.isArray(rows) && rows[0]?.stripe_customer_id;

    if (!customerId) {
      return res.status(404).json({ error: "No active subscription found." });
    }

    const session = await createPortalSession(customerId, RETURN_URL);
    return res.status(200).json({ url: session.url });
  } catch (e) {
    console.error("[stripe-portal] error:", e.message);
    return res.status(500).json({ error: "Could not open billing portal. Please try again." });
  }
};
