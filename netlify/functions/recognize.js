// Liri — ACRCloud Recognition Proxy
// Keeps API credentials server-side so they never appear in the app.
// Called by the Liri app at /.netlify/functions/recognize
//
// Uses manual multipart/form-data construction with raw Buffers to avoid
// any dependency on FormData or Blob availability in the Node runtime.

const crypto = require("crypto");

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
      body: "",
    };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const { audio, mimeType = "audio/webm" } = JSON.parse(event.body);

    if (!audio) {
      return { statusCode: 400, body: JSON.stringify({ error: "No audio provided" }) };
    }

    // Credentials live in Netlify env vars — never in the app
    const host         = process.env.ACR_HOST;
    const accessKey    = process.env.ACR_ACCESS_KEY;
    const accessSecret = process.env.ACR_ACCESS_SECRET;

    if (!host || !accessKey || !accessSecret) {
      return {
        statusCode: 500,
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: "Server not configured — check Netlify env vars (ACR_HOST, ACR_ACCESS_KEY, ACR_ACCESS_SECRET)" }),
      };
    }

    // Build HMAC-SHA1 signature
    const timestamp    = Math.floor(Date.now() / 1000);
    const stringToSign = `POST\n/v1/identify\n${accessKey}\naudio\n1\n${timestamp}`;
    const signature    = crypto.createHmac("sha1", accessSecret).update(stringToSign).digest("base64");

    // Decode audio from base64
    const audioBuffer = Buffer.from(audio, "base64");

    // ── Build multipart/form-data manually using Buffers ──
    // This avoids any FormData/Blob availability issues across Node versions.
    const boundary = "LiriBoundary" + crypto.randomBytes(16).toString("hex");
    const CRLF     = "\r\n";

    const textPart = (name, value) => Buffer.concat([
      Buffer.from(`--${boundary}${CRLF}`),
      Buffer.from(`Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}`),
      Buffer.from(String(value)),
      Buffer.from(CRLF),
    ]);

    const filePart = (name, filename, contentType, data) => Buffer.concat([
      Buffer.from(`--${boundary}${CRLF}`),
      Buffer.from(`Content-Disposition: form-data; name="${name}"; filename="${filename}"${CRLF}`),
      Buffer.from(`Content-Type: ${contentType}${CRLF}${CRLF}`),
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

    const response = await fetch(`https://${host}/v1/identify`, {
      method: "POST",
      headers: {
        "Content-Type":   `multipart/form-data; boundary=${boundary}`,
        "Content-Length": String(formBody.length),
      },
      body: formBody,
    });

    const result = await response.json();

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify(result),
    };

  } catch (err) {
    console.error("Recognize function error:", err.message, err.stack);
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Recognition failed", message: err.message }),
    };
  }
};
