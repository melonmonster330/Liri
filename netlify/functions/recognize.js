// Liri — ACRCloud Recognition Proxy
// Keeps API credentials server-side so they never appear in the app.
// Called by the Liri app at /.netlify/functions/recognize

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

    // Credentials live here in Netlify env vars — never in the app
    const host         = process.env.ACR_HOST;
    const accessKey    = process.env.ACR_ACCESS_KEY;
    const accessSecret = process.env.ACR_ACCESS_SECRET;

    if (!host || !accessKey || !accessSecret) {
      return { statusCode: 500, body: JSON.stringify({ error: "Server not configured" }) };
    }

    // Build HMAC-SHA1 signature
    const timestamp    = Math.floor(Date.now() / 1000);
    const stringToSign = `POST\n/v1/identify\n${accessKey}\naudio\n1\n${timestamp}`;
    const signature    = crypto.createHmac("sha1", accessSecret).update(stringToSign).digest("base64");

    // Decode audio from base64 and build multipart request
    const audioBuffer = Buffer.from(audio, "base64");

    const formData = new FormData();
    formData.append("access_key",        accessKey);
    formData.append("data_type",         "audio");
    formData.append("signature_version", "1");
    formData.append("timestamp",         String(timestamp));
    formData.append("signature",         signature);
    formData.append("sample_bytes",      String(audioBuffer.length));
    formData.append("sample",            new Blob([audioBuffer], { type: mimeType }), "sample.webm");

    const response = await fetch(`https://${host}/v1/identify`, {
      method: "POST",
      body: formData,
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
    console.error("Recognize function error:", err);
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Recognition failed" }),
    };
  }
};
