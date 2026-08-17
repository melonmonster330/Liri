// api/discogs-status.js — is this user connected to Discogs?
//
// Returns safe connection info for the logged-in user. Never returns tokens —
// that's why the client can't read user_discogs_accounts directly (it's
// service-role only) and goes through this endpoint instead.
//
// Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const { verifyAuth } = require("./_lib/auth");
const { sbRequest }  = require("./_lib/supabase");

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
        `&select=discogs_username,connected_at,last_synced_at&limit=1`
    );
    const row = Array.isArray(data) ? data[0] : null;
    if (!row) return res.status(200).json({ connected: false });

    return res.status(200).json({
      connected:      true,
      username:       row.discogs_username,
      connected_at:   row.connected_at,
      last_synced_at: row.last_synced_at || null,
    });
  } catch (e) {
    console.error("[discogs-status] error:", e.message);
    return res.status(500).json({ error: "Couldn't check Discogs status." });
  }
};
