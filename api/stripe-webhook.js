// api/stripe-webhook.js — Handle Stripe webhook events
//
// POST /api/stripe-webhook  (registered in Stripe dashboard)
//
// Listens for:
//   checkout.session.completed        → create/activate premium subscription
//   customer.subscription.updated     → sync tier/status changes
//   customer.subscription.deleted     → mark subscription as canceled
//
// The raw body must NOT be parsed as JSON before signature verification.
// Vercel body parsing is disabled via the config export below.
//
// Required env vars: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET (see _lib/stripe.js)

const { constructWebhookEvent } = require("./_lib/stripe");

// ── Disable Vercel's automatic body parsing ────────────────────────────────
// We need the raw bytes to verify the Stripe-Signature header.
module.exports.config = { api: { bodyParser: false } };

// ── Supabase REST helper (service role) ───────────────────────────────────────
const https = require("https");

function supabaseRequest(method, path, body) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
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
          "Prefer":        "resolution=merge-duplicates,return=minimal",
          ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }); }
          catch { resolve({ status: res.statusCode, data: null }); }
        });
      }
    );
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// Upsert a row into the subscriptions table
async function upsertSubscription(row) {
  return supabaseRequest("POST", "subscriptions?on_conflict=user_id", {
    ...row,
    updated_at: new Date().toISOString(),
  });
}

// Look up a Liri user_id from their Stripe customer_id
// We store liri_user_id in customer metadata at checkout time.
async function getUserIdFromCustomer(customerId, customerObj) {
  // Prefer metadata stored on the customer object (passed in from the event)
  if (customerObj?.metadata?.liri_user_id) {
    return customerObj.metadata.liri_user_id;
  }
  // Fall back to querying subscriptions table by stripe_customer_id
  const { data } = await supabaseRequest(
    "GET",
    `subscriptions?stripe_customer_id=eq.${encodeURIComponent(customerId)}&select=user_id&limit=1`
  );
  return Array.isArray(data) && data[0] ? data[0].user_id : null;
}

// Map Stripe subscription status → Liri status
function mapStatus(stripeStatus) {
  const map = {
    active:            "active",
    trialing:          "trialing",
    past_due:          "past_due",
    canceled:          "canceled",
    unpaid:            "unpaid",
    incomplete:        "past_due",
    incomplete_expired: "canceled",
    paused:            "canceled",
  };
  return map[stripeStatus] || "canceled";
}

// ── Raw body reader ────────────────────────────────────────────────────────────
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ── Main handler ──────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();

  // ── Read raw body & verify signature ───────────────────────────────────────
  const rawBody = await getRawBody(req);
  const sig     = req.headers["stripe-signature"] || "";

  let event;
  try {
    event = constructWebhookEvent(rawBody.toString("utf8"), sig);
  } catch (e) {
    console.error("[stripe-webhook] Signature verification failed:", e.message);
    return res.status(400).json({ error: e.message });
  }

  console.log(`[stripe-webhook] Received event: ${event.type} (${event.id})`);

  try {
    switch (event.type) {

      // ── Checkout completed → activate subscription ─────────────────────────
      case "checkout.session.completed": {
        const session  = event.data.object;
        if (session.mode !== "subscription") break;

        const userId = session.metadata?.liri_user_id;
        if (!userId) {
          console.error("[stripe-webhook] checkout.session.completed: no liri_user_id in metadata");
          break;
        }

        await upsertSubscription({
          user_id:                userId,
          stripe_customer_id:     session.customer,
          stripe_subscription_id: session.subscription,
          tier:                   "premium",
          status:                 "active",
          current_period_end:     null, // will be filled on subscription.updated
        });

        console.log(`[stripe-webhook] Activated premium for user ${userId}`);
        break;
      }

      // ── Subscription updated → sync status & period ────────────────────────
      case "customer.subscription.updated": {
        const sub    = event.data.object;
        const status = mapStatus(sub.status);
        const tier   = (status === "active" || status === "trialing") ? "premium" : "free";
        const endTs  = sub.current_period_end
          ? new Date(sub.current_period_end * 1000).toISOString()
          : null;

        // Find user_id from customer
        const userId = await getUserIdFromCustomer(sub.customer, sub.customer);
        if (!userId) {
          console.error("[stripe-webhook] subscription.updated: cannot find user for customer", sub.customer);
          break;
        }

        await upsertSubscription({
          user_id:                userId,
          stripe_customer_id:     sub.customer,
          stripe_subscription_id: sub.id,
          tier,
          status,
          current_period_end: endTs,
        });

        console.log(`[stripe-webhook] Updated subscription for user ${userId}: ${tier}/${status}`);
        break;
      }

      // ── Subscription deleted → downgrade to free ───────────────────────────
      case "customer.subscription.deleted": {
        const sub    = event.data.object;
        const userId = await getUserIdFromCustomer(sub.customer, sub.customer);
        if (!userId) {
          console.error("[stripe-webhook] subscription.deleted: cannot find user for customer", sub.customer);
          break;
        }

        await upsertSubscription({
          user_id:                userId,
          stripe_customer_id:     sub.customer,
          stripe_subscription_id: sub.id,
          tier:                   "free",
          status:                 "canceled",
          current_period_end:     sub.current_period_end
            ? new Date(sub.current_period_end * 1000).toISOString()
            : null,
        });

        console.log(`[stripe-webhook] Canceled subscription for user ${userId}`);
        break;
      }

      default:
        // Unhandled event type — Stripe expects a 200 anyway
        break;
    }
  } catch (e) {
    console.error(`[stripe-webhook] Error handling ${event.type}:`, e.message);
    // Still return 200 so Stripe doesn't retry — log the error for investigation
  }

  return res.status(200).json({ received: true });
};
