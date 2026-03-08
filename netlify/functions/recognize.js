// Liri — ACRCloud Recognition Proxy
// Keeps API credentials server-side so they never appear in the app.
// Called by the Liri app at /.netlify/functions/recognize
//
// Uses Node's built-in https module (no fetch, no dependencies) so it
// works on any Node runtime Netlify happens to be running.

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

exports.handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: cors, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const { audio, mimeType = "audio/webm" } = JSON.parse(event.body);

    if (!audio) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "No audio provided" }) };
    }

    const host         = process.env.ACR_HOST;
    const accessKey    = process.env.ACR_ACCESS_KEY;
    const accessSecret = process.env.ACR_ACCESS_SECRET;

    if (!host || !accessKey || !accessSecret) {
      return {
        statusCode: 500,
        headers: cors,
        body: JSON.stringify({ error: "Server not configured — Netlify env vars missing" }),
      };
    }

    // HMAC-SHA1 signature
    const timestamp    = Math.floor(Date.now() / 1000);
    const stringToSign = `POST\n/v1/identify\n${accessKey}\naudio\n1\n${timestamp}`;
    const signature    = crypto.createHmac("sha1", accessSecret).update(stringToSign).digest("base64");

    const audioBuffer = Buffer.from(audio, "base64");

    // Build multipart/form-data using raw Buffers
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

    const formBody = Buffer.concat([
      textPart("access_key",        accessKey),
      textPart("data_type",         "audio"),
      textPart("signature_version", "1"),
      textPart("timestamp",         String(timestamp)),
      textPart("signature",         signature),
      textPart("sample_bytes",      String(audioBuffer.length)),
      filePart("sample", "sample.webm", mimeType, audioBuffer),
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

    return {
      statusCode: 200,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify(result),
    };

  } catch (err) {
    console.error("Recognize error:", err.message);
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: "Recognition failed", message: err.message }),
    };
  }
};
