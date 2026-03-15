// Liri — OpenAI / Whisper credential ping (debug only)
// Checks whether OPENAI_API_KEY is set and valid by calling the models list endpoint.
// Access at: GET /api/ping-whisper

const https = require("https");

function httpsGet(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: "GET", headers }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch (e) { reject(new Error("Non-JSON from OpenAI")); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(200).json({ ok: false, error: "OPENAI_API_KEY is not set in Vercel env vars" });
    return;
  }

  try {
    // Ping the models list — lightweight, no audio needed, confirms key is valid
    const result = await httpsGet("api.openai.com", "/v1/models", {
      "Authorization": `Bearer ${apiKey}`,
    });

    if (result.status === 200) {
      const whisperAvailable = result.body?.data?.some(m => m.id?.includes("whisper"));
      res.status(200).json({
        ok: true,
        keyPrefix: apiKey.slice(0, 7) + "…",
        whisperAvailable,
        message: whisperAvailable ? "OpenAI key valid, whisper-1 available" : "OpenAI key valid but whisper-1 not listed",
      });
    } else {
      res.status(200).json({
        ok: false,
        httpStatus: result.status,
        error: result.body?.error?.message || "OpenAI rejected the key",
      });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
};
