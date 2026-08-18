// api/discogs-oauth-start.js — begin "Connect Discogs" (OAuth step 1)
//
// Called via fetch from the logged-in app. Requires a Supabase session.
// Gets a Discogs request token, remembers it (tied to this Liri user) in
// discogs_oauth_pending, and returns the Discogs authorize URL for the
// client to redirect the browser to.
//
// Required env: DISCOGS_KEY, DISCOGS_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const { verifyAuth } = require("./_lib/auth");
const { sbRequest }  = require("./_lib/supabase");
const discogs        = require("./_lib/discogs-oauth");

const ALLOWED = ["https://getliri.com", "https://www.getliri.com", "capacitor://localhost"];

module.exports = async (req, res) => {
  const origin = req.headers.origin || "";
  res.setHeader("Access-Control-Allow-Origin", ALLOWED.includes(origin) ? origin : "https://getliri.com");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "Method not allowed" });

  if (!discogs.hasCredentials()) {
    console.error("[discogs-oauth-start] DISCOGS_KEY/DISCOGS_SECRET not configured");
    return res.status(500).json({ error: "Discogs sign-in isn't configured yet." });
  }

  const auth = await verifyAuth(req);
  if (!auth || auth._authError) {
    return res.status(401).json({ error: "Session expired — please sign out and back in." });
  }

  // Discogs redirects the browser back here after the user authorizes. Build the
  // callback on the same host that initiated the flow so preview and production
  // each come back to themselves. (This host must be allowed on the Discogs app.)
  const host = req.headers.host;
  const callbackUrl = `https://${host}/api/discogs-oauth-callback`;

  // Where to send the user after they authorize. Same-site paths only — reject
  // anything that isn't a plain "/path" to avoid an open redirect.
  const rawReturn = req.body && req.body.return_to;
  const returnTo = (typeof rawReturn === "string" && rawReturn.startsWith("/") && !rawReturn.startsWith("//"))
    ? rawReturn : "/app";

  try {
    const { oauth_token, oauth_token_secret } = await discogs.getRequestToken(callbackUrl);

    // Remember the request-token secret + which user started this, so the
    // (unauthenticated) callback can finish the exchange.
    const { status } = await sbRequest("POST", "discogs_oauth_pending", {
      oauth_token,
      oauth_token_secret,
      user_id: auth.userId,
      return_to: returnTo,
    });
    if (status >= 300) {
      console.error("[discogs-oauth-start] failed to store pending token, status", status);
      return res.status(500).json({ error: "Couldn't start Discogs sign-in. Please try again." });
    }

    return res.status(200).json({ authorizeUrl: discogs.authorizeUrl(oauth_token) });
  } catch (e) {
    console.error("[discogs-oauth-start] error:", e.message);
    return res.status(502).json({ error: "Couldn't reach Discogs. Please try again." });
  }
};
