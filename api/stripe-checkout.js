// api/stripe-checkout.js — Create a Stripe Checkout session
//
// POST /api/stripe-checkout
// Body: {} (no body required — user identity comes from the auth token)
//
// Returns: { url: "https://checkout.stripe.com/..." }
// The client should redirect window.location.href to that URL.
//
// After payment Stripe redirects to:
//   success: https://getliri.com/library?checkout_success=true
//   cancel:  https://getliri.com/library

const { verifyAuth }            = require("./_lib/auth");
const { getOrCreateCustomer, createCheckoutSession } = require("./_lib/stripe");

const ALLOWED_ORIGINS = ["https://getliri.com", "capacitor://localhost"];

const SUCCESS_URL = "https://getliri.com/library?checkout_success=true";
const CANCEL_URL  = "https://getliri.com/library";

module.exports = async (req, res) => {
  const origin = req.headers.origin || "";
  res.setHeader("Access-Control-Allow-Origin",  ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")   return res.status(405).json({ error: "Method not allowed" });

  // ── Auth ──────────────────────────────────────────────────────────────────
  const auth = await verifyAuth(req);
  if (!auth) return res.status(401).json({ error: "Unauthorized" });

  try {
    // ── Get or create a Stripe customer for this Liri user ─────────────────
    const customer = await getOrCreateCustomer(auth.email, auth.userId);

    // ── Create the Checkout session ────────────────────────────────────────
    const session = await createCheckoutSession(
      customer.id,
      auth.userId,
      SUCCESS_URL,
      CANCEL_URL,
    );

    return res.status(200).json({ url: session.url });
  } catch (e) {
    console.error("[stripe-checkout] error:", e.message);
    return res.status(500).json({ error: "Could not start checkout. Please try again." });
  }
};
