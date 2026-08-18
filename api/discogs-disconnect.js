// api/discogs-disconnect.js — disconnect the user's Discogs account
//
// Deletes the stored connection (tokens + profile). Imported records are left
// in place — they're the user's library. Reconnecting re-imports as usual.
//
// Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const { verifyAuth } = require("./_lib/auth");
const { sbRequest }  = require("./_lib/supabase");

const ALLOWED = ["https://getliri.com", "https://www.getliri.com", "capacitor://localhost"];

module.exports = async (req, res) => {
  const origin = req.headers.origin || "";
  res.setHeader("Access-Control-Allow-Origin", ALLOWED.includes(origin) ? origin : "https://getliri.com");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "Method not allowed" });

  const auth = await verifyAuth(req);
  if (!auth || auth._authError) {
    return res.status(401).json({ error: "Session expired — please sign out and back in." });
  }

  try {
    const { status } = await sbRequest(
      "DELETE",
      `user_discogs_accounts?user_id=eq.${encodeURIComponent(auth.userId)}`
    );
    if (status >= 300) {
      console.error("[discogs-disconnect] delete failed, status", status);
      return res.status(500).json({ error: "Couldn't disconnect. Please try again." });
    }
    return res.status(200).json({ disconnected: true });
  } catch (e) {
    console.error("[discogs-disconnect] error:", e.message);
    return res.status(500).json({ error: "Couldn't disconnect. Please try again." });
  }
};
