// api/deepgram-token.js — Return a Deepgram token for client-side streaming.
// The key is used for one WebSocket session, never stored client-side.

const { verifyAuth } = require("./_lib/auth");

const ALLOWED_ORIGINS = ["https://getliri.com", "https://www.getliri.com", "capacitor://localhost", "http://localhost:3000"];

module.exports = async (req, res) => {
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const auth = await verifyAuth(req);
  if (!auth || auth._authError || !auth.userId)
    return res.status(401).json({ error: "Unauthorized" });

  if (!process.env.DEEPGRAM_API_KEY) return res.status(500).json({ error: "DEEPGRAM_API_KEY not set" });
  res.json({ token: process.env.DEEPGRAM_API_KEY });
};
