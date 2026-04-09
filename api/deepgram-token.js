// api/deepgram-token.js — Generate a short-lived Deepgram API token
//
// POST /api/deepgram-token
// Returns: { token: "..." }
//
// The client uses this token to open a WebSocket directly to Deepgram.
// The real API key never leaves the server.

const https = require("https");

const ALLOWED_ORIGINS = ["https://getliri.com", "capacitor://localhost", "http://localhost:3000"];

module.exports = async (req, res) => {
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Deepgram API key not configured" });

  try {
    // Create a temporary key scoped to usage only (no management permissions)
    const token = await new Promise((resolve, reject) => {
      const body = JSON.stringify({
        comment: "liri-listen",
        scopes: ["usage:write"],
        time_to_live_in_seconds: 30
      });
      const req2 = https.request({
        hostname: "api.deepgram.com",
        path: "/v1/projects/" + process.env.DEEPGRAM_PROJECT_ID + "/keys",
        method: "POST",
        headers: {
          "Authorization": `Token ${apiKey}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body)
        }
      }, (r) => {
        let data = "";
        r.on("data", c => data += c);
        r.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.key) resolve(parsed.key);
            else reject(new Error("No key in response: " + data));
          } catch (e) { reject(e); }
        });
      });
      req2.on("error", reject);
      req2.write(body);
      req2.end();
    });

    res.json({ token });
  } catch (e) {
    console.error("[deepgram-token] error:", e.message);
    res.status(500).json({ error: "Failed to generate token" });
  }
};
