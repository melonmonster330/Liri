// Liri — ACRCloud Recognition Proxy (Vercel)
// Keeps API credentials server-side so they never appear in the app.
// Called by the Liri app at /api/recognize

const crypto = require("crypto");
const https  = require("https");

// Simple https POST helper — returns parsed JSON
function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method: "POST", headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()));
          } catch (e) {
            reject(new Error("ACRCloud returned non-JSON response"));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

module.exports = async (req, res) => {
  const cors = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST")    { res.status(405).send("Method Not Allowed"); return; }

  try {
    const { audio, mimeType = "audio/webm" } = req.body;

    if (!audio) { res.status(400).json({ error: "No audio provided" }); return; }

    const host         = process.env.ACR_HOST;
    const accessKey    = process.env.ACR_ACCESS_KEY;
    const accessSecret = process.env.ACR_ACCESS_SECRET;

    if (!host || !accessKey || !accessSecret) {
      res.status(500).json({ error: "Server not configured — check Vercel env vars" });
      return;
    }

    // HMAC-SHA1 signature
    const timestamp    = Math.floor(Date.now() / 1000);
    const stringToSign = `POST\n/v1/identify\n${accessKey}\naudio\n1\n${timestamp}`;
    const signature    = crypto.createHmac("sha1", accessSecret).update(stringToSign).digest("base64");

    const audioBuffer = Buffer.from(audio, "base64");

    // Build multipart/form-data using raw Buffers (no FormData/Blob dependency)
    const boundary = "LiriBoundary" + crypto.randomBytes(16).toString("hex");
    const CRLF     = "\r\n";

    const textPart = (name, value) => Buffer.concat([
      Buffer.from(`--${boundary}${CRLF}`),
      Buffer.from(`Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}`),
      Buffer.from(String(value)),
      Buffer.from(CRLF),
    ]);

    const filePart = (name, filename, type, data) => Buffer.concat([
      Buffer.from(`--${boundary}${CRLF}`),
      Buffer.from(`Content-Disposition: form-data; name="${name}"; filename="${filename}"${CRLF}`),
      Buffer.from(`Content-Type: ${type}${CRLF}${CRLF}`),
      data,
      Buffer.from(CRLF),
    ]);

    // Use the correct file extension so ACRCloud knows the container format
    const sampleExt = mimeType.includes("mp4") ? "m4a"
                    : mimeType.includes("ogg") ? "ogg"
                    : "webm";

    const formBody = Buffer.concat([
      textPart("access_key",        accessKey),
      textPart("data_type",         "audio"),
      textPart("signature_version", "1"),
      textPart("timestamp",         String(timestamp)),
      textPart("signature",         signature),
      textPart("sample_bytes",      String(audioBuffer.length)),
      filePart("sample", `sample.${sampleExt}`, mimeType, audioBuffer),
      Buffer.from(`--${boundary}--${CRLF}`),
    ]);

    const result = await httpsPost(
      host,
      "/v1/identify",
      {
        "Content-Type":   `multipart/form-data; boundary=${boundary}`,
        "Content-Length": formBody.length,
      },
      formBody
    );

    // Log ACRCloud's response so we can debug in Vercel logs
    console.log("ACRCloud response:", JSON.stringify(result));

    // Attach the user's country (from Vercel's edge network headers) so the
    // client can store it in listening_events without a separate geo lookup.
    const countryCode = req.headers["x-vercel-ip-country"] || null;
    res.status(200).json({ ...result, _liri: { country_code: countryCode } });

  } catch (err) {
    console.error("Recognize error:", err.message);
    res.status(500).json({ error: "Recognition failed", message: err.message });
  }
};
