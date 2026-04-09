// api/_lib/stripe.js — Stripe API helper for Liri
//
// Makes raw HTTPS calls to api.stripe.com using the secret key.
// No Stripe SDK needed — keeps dependencies at zero.
//
// Required Vercel environment variables:
//   STRIPE_SECRET_KEY      — sk_live_… or sk_test_…
//   STRIPE_WEBHOOK_SECRET  — whsec_… (from Stripe dashboard → Webhooks)
//   STRIPE_PRICE_ID        — price_… for Liri Premium monthly
//
// Set these in Vercel → Project Settings → Environment Variables.

const https  = require("https");
const crypto = require("crypto");
const qs     = require("querystring");

// ── Low-level Stripe HTTP call ────────────────────────────────────────────────
// Stripe REST API uses form-encoded bodies and Basic auth (secretKey as user).

function stripeRequest(method, path, params) {
  return new Promise((resolve, reject) => {
    const secretKey = process.env.STRIPE_SECRET_KEY || "";
    if (!secretKey) return reject(new Error("STRIPE_SECRET_KEY not set"));

    const body    = params ? qs.stringify(params) : "";
    const auth    = Buffer.from(`${secretKey}:`).toString("base64");
    const options = {
      hostname: "api.stripe.com",
      path,
      method,
      headers: {
        "Authorization":  `Basic ${auth}`,
        "Content-Type":   "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
        "Stripe-Version": "2024-06-20",
      },
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          if (res.statusCode >= 400) {
            const err = new Error(data?.error?.message || `Stripe error ${res.statusCode}`);
            err.stripeCode = data?.error?.code;
            err.statusCode = res.statusCode;
            return reject(err);
          }
          resolve(data);
        } catch (e) {
          reject(new Error(`Stripe response parse error: ${e.message}`));
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("Stripe request timed out")); });
    if (body) req.write(body);
    req.end();
  });
}

// ── Customer helpers ──────────────────────────────────────────────────────────

// Find an existing Stripe customer by Liri user_id (stored in metadata)
async function findCustomerByUserId(userId) {
  const data = await stripeRequest("GET", `/v1/customers/search?query=${encodeURIComponent(`metadata['liri_user_id']:'${userId}'`)}&limit=1`);
  return data?.data?.[0] || null;
}

// Create a Stripe customer linked to a Liri user
async function createCustomer(email, userId) {
  return stripeRequest("POST", "/v1/customers", {
    email,
    "metadata[liri_user_id]": userId,
  });
}

// Get or create a Stripe customer for a user
async function getOrCreateCustomer(email, userId) {
  const existing = await findCustomerByUserId(userId);
  if (existing) return existing;
  return createCustomer(email, userId);
}

// ── Checkout session ──────────────────────────────────────────────────────────

async function createCheckoutSession(customerId, userId, successUrl, cancelUrl) {
  const priceId = process.env.STRIPE_PRICE_ID;
  if (!priceId) throw new Error("STRIPE_PRICE_ID not set");

  return stripeRequest("POST", "/v1/checkout/sessions", {
    customer:                customerId,
    mode:                    "subscription",
    "line_items[0][price]":  priceId,
    "line_items[0][quantity]": "1",
    success_url:             successUrl,
    cancel_url:              cancelUrl,
    "metadata[liri_user_id]": userId,
    // Pre-fill email in checkout if Stripe doesn't have it on the customer
    customer_update_allowed_updates: "email",
  });
}

// ── Customer portal session ───────────────────────────────────────────────────

async function createPortalSession(customerId, returnUrl) {
  return stripeRequest("POST", "/v1/billing_portal/sessions", {
    customer:   customerId,
    return_url: returnUrl,
  });
}

// ── Webhook signature verification ───────────────────────────────────────────
// Verifies the Stripe-Signature header against the raw request body.
// Returns the parsed event object or throws if the signature is invalid.

function constructWebhookEvent(rawBody, signatureHeader) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET || "";
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET not set");

  // Stripe-Signature: t=timestamp,v1=sig1,v1=sig2,...
  const parts = {};
  for (const part of signatureHeader.split(",")) {
    const [k, v] = part.split("=");
    if (k === "t")  parts.timestamp = v;
    if (k === "v1") parts.v1 = v; // use last v1 (or could collect all)
  }

  if (!parts.timestamp || !parts.v1) {
    throw new Error("Invalid Stripe-Signature header");
  }

  // Reject events older than 5 minutes
  const tolerance = 5 * 60;
  const ts = parseInt(parts.timestamp, 10);
  if (Math.abs(Date.now() / 1000 - ts) > tolerance) {
    throw new Error("Stripe webhook timestamp out of tolerance");
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${parts.timestamp}.${rawBody}`)
    .digest("hex");

  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1))) {
    throw new Error("Stripe webhook signature mismatch");
  }

  return JSON.parse(rawBody);
}

module.exports = {
  stripeRequest,
  getOrCreateCustomer,
  createCheckoutSession,
  createPortalSession,
  constructWebhookEvent,
};
