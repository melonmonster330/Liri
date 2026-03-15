// Liri — ACRCloud credential ping (debug only)
// Sends a minimal 1-byte audio payload to ACRCloud to test if credentials are valid.
// A valid account returns 1001 (no match) — an invalid one returns 3000/3002.
// Access at: GET /api/ping-acr

const crypto = require("crypto");
const https  = require("https");

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method: "POST", headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
          catch (e) { reject(new Error("Non-JSON response")); }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const host         = process.env.ACR_HOST;
  const accessKey    = process.env.ACR_ACCESS_KEY;
  const accessSecret = process.env.ACR_ACCESS_SECRET;

  if (!host || !accessKey || !accessSecret) {
    res.status(500).json({ ok: false, error: "Missing env vars", has: { host: !!host, key: !!accessKey, secret: !!accessSecret } });
    return;
  }

  try {
    const timestamp    = Math.floor(Date.now() / 1000);
    const stringToSign = `POST\n/v1/identify\n${accessKey}\naudio\n1\n${timestamp}`;
    const signature    = crypto.createHmac("sha1", accessSecret).update(stringToSign).digest("base64");

    // Minimal 1-byte body — will return 1001 (no result) if credentials are valid,
    // or 3000/3002 if the credentials themselves are wrong.
    const audioBuffer = Buffer.from([0x00]);
    const boundary    = "LiriBoundary" + crypto.randomBytes(8).toString("hex");
    const CRLF        = "\r\n";
    const tp = (name, value) => Buffer.concat([
      Buffer.from(`--${boundary}${CRLF}`),
      Buffer.from(`Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}`),
      Buffer.from(String(value)), Buffer.from(CRLF),
    ]);
    const formBody = Buffer.concat([
      tp("access_key", accessKey), tp("data_type", "audio"),
      tp("signature_version", "1"), tp("timestamp", String(timestamp)),
      tp("signature", signature), tp("sample_bytes", "1"),
      Buffer.from(`--${boundary}${CRLF}`),
      Buffer.from(`Content-Disposition: form-data; name="sample"; filename="ping.webm"${CRLF}`),
      Buffer.from(`Content-Type: audio/webm${CRLF}${CRLF}`),
      audioBuffer, Buffer.from(CRLF),
      Buffer.from(`--${boundary}--${CRLF}`),
    ]);

    const result = await httpsPost(host, "/v1/identify", {
      "Content-Type":   `multipart/form-data; boundary=${boundary}`,
      "Content-Length": formBody.length,
    }, formBody);

    const code = result?.status?.code;
    res.status(200).json({
      ok: true,
      host,
      keyPrefix: accessKey.slice(0, 6) + "…",
      acrCode: code,
      acrMsg: result?.status?.msg,
      // 1001 = credentials valid, audio just didn't match (expected for a ping)
      // 3000 = invalid access key
      // 3002 = invalid signature (wrong secret)
      credentialsValid: code === 1001 || code === 0,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
};
