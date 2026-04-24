// api/stripe-checkout.js — Stripe Checkout session + Apple IAP verification
//
// POST /api/stripe-checkout
//   Body: {}                          → create Stripe checkout session (web)
//   Body: { appleTransaction: "..." } → verify Apple JWS & grant premium (iOS)

const { verifyAuth }            = require("./_lib/auth");
const { getOrCreateCustomer, createCheckoutSession } = require("./_lib/stripe");
const crypto = require("crypto");
const https  = require("https");

const ALLOWED_ORIGINS = ["https://getliri.com", "https://www.getliri.com", "capacitor://localhost"];
const SUCCESS_URL = "https://getliri.com/library?checkout_success=true";
const CANCEL_URL  = "https://getliri.com/library";

const APPLE_BUNDLE_ID  = "com.getliri.app";
const APPLE_PRODUCT_ID = "com.getliri.app.premium.monthly";

// ── Apple JWS verification ────────────────────────────────────────────────────

function b64urlDecode(s) {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

// Convert JWS ECDSA signature (R||S, 64 bytes) → DER for Node crypto
function jwsSigToDer(raw) {
  const r = raw.slice(0, 32);
  const s = raw.slice(32, 64);
  const rPad = r[0] & 0x80 ? Buffer.concat([Buffer.from([0x00]), r]) : r;
  const sPad = s[0] & 0x80 ? Buffer.concat([Buffer.from([0x00]), s]) : s;
  const seq  = 2 + rPad.length + 2 + sPad.length;
  return Buffer.concat([
    Buffer.from([0x30, seq, 0x02, rPad.length]), rPad,
    Buffer.from([0x02, sPad.length]), sPad,
  ]);
}

function verifyAppleJWS(jws) {
  const parts = jws.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWS format");

  const header  = JSON.parse(b64urlDecode(parts[0]).toString());
  const payload = JSON.parse(b64urlDecode(parts[1]).toString());

  // Verify signature against leaf certificate from Apple's x5c chain
  const certPem  = `-----BEGIN CERTIFICATE-----\n${header.x5c[0]}\n-----END CERTIFICATE-----`;
  const leafCert = new crypto.X509Certificate(certPem);
  const sigInput = Buffer.from(`${parts[0]}.${parts[1]}`);
  const sigDer   = jwsSigToDer(b64urlDecode(parts[2]));

  const verifier = crypto.createVerify("SHA256");
  verifier.update(sigInput);
  if (!verifier.verify(leafCert.publicKey, sigDer)) {
    throw new Error("JWS signature verification failed");
  }

  return payload;
}

// ── Supabase upsert helper ────────────────────────────────────────────────────

function supabaseUpsert(path, body) {
  const url      = process.env.SUPABASE_URL;
  const key      = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const hostname = url.replace(/^https?:\/\//, "");
  const bodyStr  = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path: `/rest/v1/${path}`, method: "POST",
      headers: {
        "apikey": key, "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
        "Content-Length": Buffer.byteLength(bodyStr),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

// ── Main handler ──────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  const origin = req.headers.origin || "";
  res.setHeader("Access-Control-Allow-Origin",  ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")   return res.status(405).json({ error: "Method not allowed" });

  const auth = await verifyAuth(req);
  if (!auth || auth._authError || !auth.userId) return res.status(401).json({ error: "Unauthorized" });

  const body = req.body || {};

  // ── Apple IAP branch ───────────────────────────────────────────────────────
  if (body.appleTransaction) {
    try {
      const payload = verifyAppleJWS(body.appleTransaction);

      if (payload.bundleId  !== APPLE_BUNDLE_ID)  throw new Error("Bundle ID mismatch");
      if (payload.productId !== APPLE_PRODUCT_ID) throw new Error("Product ID mismatch");
      if (payload.expiresDate && payload.expiresDate < Date.now()) throw new Error("Subscription expired");

      const expiresAt = payload.expiresDate ? new Date(payload.expiresDate).toISOString() : null;

      await supabaseUpsert(
        "subscriptions?on_conflict=user_id",
        {
          user_id:                auth.userId,
          tier:                   "premium",
          status:                 "active",
          stripe_subscription_id: null,          // Apple sub — no Stripe ID
          current_period_end:     expiresAt,
          updated_at:             new Date().toISOString(),
        }
      );

      console.log(`[apple-iap] granted premium to ${auth.userId} expires ${expiresAt}`);
      return res.status(200).json({ success: true, tier: "premium" });
    } catch (e) {
      console.error("[apple-iap] error:", e.message);
      return res.status(400).json({ error: e.message });
    }
  }

  // ── Stripe branch (existing) ───────────────────────────────────────────────
  try {
    const customer = await getOrCreateCustomer(auth.email, auth.userId);
    const session  = await createCheckoutSession(customer.id, auth.userId, SUCCESS_URL, CANCEL_URL);
    return res.status(200).json({ url: session.url });
  } catch (e) {
    console.error("[stripe-checkout] error:", e.message);
    return res.status(500).json({ error: "Could not start checkout. Please try again." });
  }
};
