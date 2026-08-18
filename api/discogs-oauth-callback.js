// api/discogs-oauth-callback.js — finish "Connect Discogs" (OAuth steps 3–4)
//
// Discogs redirects the user's browser here after they authorize, with
// ?oauth_token & ?oauth_verifier. This endpoint is intentionally NOT
// authenticated — the browser arriving from Discogs has no Supabase JWT.
// It's safe because oauth_token is a server-minted secret we stored in
// discogs_oauth_pending against a specific Liri user; nobody can reach this
// meaningfully without that pending row and Discogs's verifier.
//
// It exchanges the request token for a long-lived access token, reads the
// user's Discogs identity, stores it, and redirects back into the app.

const { sbRequest, sbUpsert } = require("./_lib/supabase");
const discogs                 = require("./_lib/discogs-oauth");

// Redirect the browser back into the app with a status flag the UI can read.
// `path` is where the user started the flow (e.g. /library); default /app.
// Same-site paths only — reject anything that isn't a plain "/path".
function backToApp(res, host, path, params) {
  const safePath = (typeof path === "string" && path.startsWith("/") && !path.startsWith("//")) ? path : "/app";
  const qs = new URLSearchParams(params).toString();
  res.statusCode = 302;
  res.setHeader("Location", `https://${host}${safePath}?${qs}`);
  res.end();
}

module.exports = async (req, res) => {
  const host = req.headers.host;
  const url  = new URL(req.url, `https://${host}`);
  const oauthToken = url.searchParams.get("oauth_token");
  const verifier   = url.searchParams.get("oauth_verifier");
  const denied     = url.searchParams.get("denied"); // Discogs sends this if the user declines

  if (denied) return backToApp(res, host, "/app", { discogs: "cancelled" });
  if (!oauthToken || !verifier) return backToApp(res, host, "/app", { discogs: "error", reason: "missing_params" });

  try {
    // Recover the request-token secret, which user started this flow, and where
    // to send them back to.
    const { data } = await sbRequest(
      "GET",
      `discogs_oauth_pending?oauth_token=eq.${encodeURIComponent(oauthToken)}&select=oauth_token_secret,user_id,return_to&limit=1`
    );
    const pending = Array.isArray(data) ? data[0] : null;
    if (!pending) return backToApp(res, host, "/app", { discogs: "error", reason: "expired" });
    const returnTo = pending.return_to || "/app";

    // Exchange for the long-lived access token.
    const access = await discogs.getAccessToken(oauthToken, pending.oauth_token_secret, verifier);

    // Who did we just connect?
    const identity = await discogs.getIdentity(access.oauth_token, access.oauth_token_secret);

    // Store the connection (one per Liri user; re-connecting refreshes it).
    const up = await sbUpsert("user_discogs_accounts", {
      user_id:            pending.user_id,
      discogs_user_id:    identity.id || null,
      discogs_username:   identity.username,
      oauth_token:        access.oauth_token,
      oauth_token_secret: access.oauth_token_secret,
      connected_at:       new Date().toISOString(),
    }, "user_id");
    if (up.status >= 300) {
      console.error("[discogs-oauth-callback] store failed, status", up.status, up.data);
      return backToApp(res, host, returnTo, { discogs: "error", reason: "store_failed" });
    }

    // Clean up the one-time request token.
    await sbRequest("DELETE", `discogs_oauth_pending?oauth_token=eq.${encodeURIComponent(oauthToken)}`)
      .catch(() => {});

    return backToApp(res, host, returnTo, { discogs: "connected", u: identity.username });
  } catch (e) {
    console.error("[discogs-oauth-callback] error:", e.message);
    return backToApp(res, host, "/app", { discogs: "error", reason: "exchange_failed" });
  }
};
