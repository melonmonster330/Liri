// api/discogs-status.js — is this user connected to Discogs?
//
// Returns safe connection info for the logged-in user. Never returns tokens —
// that's why the client can't read user_discogs_accounts directly (it's
// service-role only) and goes through this endpoint instead.
//
// Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const { verifyAuth } = require("./_lib/auth");
const { sbRequest }  = require("./_lib/supabase");
const discogs        = require("./_lib/discogs-oauth");

const ALLOWED = ["https://getliri.com", "https://www.getliri.com", "capacitor://localhost"];

module.exports = async (req, res) => {
  const origin = req.headers.origin || "";
  res.setHeader("Access-Control-Allow-Origin", ALLOWED.includes(origin) ? origin : "https://getliri.com");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET")     return res.status(405).json({ error: "Method not allowed" });

  const auth = await verifyAuth(req);
  if (!auth || auth._authError) {
    return res.status(401).json({ error: "Session expired — please sign out and back in." });
  }

  try {
    const { data } = await sbRequest(
      "GET",
      `user_discogs_accounts?user_id=eq.${encodeURIComponent(auth.userId)}` +
        `&select=discogs_username,discogs_email,discogs_avatar_url,discogs_num_collection,` +
        `oauth_token,oauth_token_secret,connected_at,last_synced_at&limit=1`
    );
    const row = Array.isArray(data) ? data[0] : null;
    if (!row) return res.status(200).json({ connected: false });

    let email     = row.discogs_email;
    let avatarUrl = row.discogs_avatar_url;
    let numColl   = row.discogs_num_collection;

    // Lazy backfill: older connections (and ones made before we stored profile
    // info) fetch it once here, then cache it on the row.
    if (email == null && avatarUrl == null && numColl == null) {
      try {
        const profile = await discogs.getProfile(row.discogs_username, row.oauth_token, row.oauth_token_secret);
        if (profile) {
          email     = profile.email      || null;
          avatarUrl = profile.avatar_url || null;
          numColl   = profile.num_collection != null ? profile.num_collection : null;
          await sbRequest("PATCH",
            `user_discogs_accounts?user_id=eq.${encodeURIComponent(auth.userId)}`,
            { discogs_email: email, discogs_avatar_url: avatarUrl, discogs_num_collection: numColl }
          ).catch(() => {});
        }
      } catch (e) { console.warn("[discogs-status] profile backfill failed:", e.message); }
    }

    return res.status(200).json({
      connected:      true,
      username:       row.discogs_username,
      email:          email || null,
      avatar_url:     avatarUrl || null,
      num_collection: numColl != null ? numColl : null,
      connected_at:   row.connected_at,
      last_synced_at: row.last_synced_at || null,
    });
  } catch (e) {
    console.error("[discogs-status] error:", e.message);
    return res.status(500).json({ error: "Couldn't check Discogs status." });
  }
};
