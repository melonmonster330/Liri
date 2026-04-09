// api/deepgram-token.js — Generate a short-lived Deepgram token for the client
// Only needs DEEPGRAM_API_KEY in env — project ID is auto-discovered.

const https = require("https");

const ALLOWED_ORIGINS = ["https://getliri.com", "capacitor://localhost", "http://localhost:3000"];

function dg(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: "api.deepgram.com",
      path,
      method,
      headers: {
        "Authorization": `Token ${process.env.DEEPGRAM_API_KEY}`,
        "Content-Type": "application/json",
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {})
      }
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error("Bad JSON: " + data)); }
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = async (req, res) => {
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!process.env.DEEPGRAM_API_KEY) return res.status(500).json({ error: "DEEPGRAM_API_KEY not set" });

  try {
    // Auto-discover project ID from the API key
    const { projects } = await dg("GET", "/v1/projects");
    const projectId = projects?.[0]?.project_id;
    if (!projectId) return res.status(500).json({ error: "No Deepgram project found" });

    // Create a 30-second temp key scoped to usage only
    const result = await dg("POST", `/v1/projects/${projectId}/keys`, {
      comment: "liri-listen",
      scopes: ["usage:write"],
      time_to_live_in_seconds: 30
    });

    if (!result.key) return res.status(500).json({ error: "Failed to create temp key" });
    res.json({ token: result.key });
  } catch (e) {
    console.error("[deepgram-token]", e.message);
    res.status(500).json({ error: e.message });
  }
};
