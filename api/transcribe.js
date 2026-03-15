// api/transcribe.js — Liri Audio Transcription Proxy (Vercel)
//
// Sends an audio blob to OpenAI Whisper and returns the transcribed text.
// Used as a fallback when ACRCloud fingerprinting doesn't find a match —
// Whisper transcribes the sung lyrics, which Liri then searches on LRCLib.
//
// Requires: OPENAI_API_KEY environment variable set in Vercel project settings.
// Cost: ~$0.006/minute of audio — a 30s clip costs about $0.003.
//
// POST /api/transcribe
// Body: { audio: <base64 string>, mimeType: "audio/webm" }
// Response: { text: "transcribed lyrics fragment" }

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "OPENAI_API_KEY not configured" });

  const { audio, mimeType = "audio/webm" } = req.body || {};
  if (!audio) return res.status(400).json({ error: "Missing audio" });

  try {
    const audioBuffer = Buffer.from(audio, "base64");

    // Build multipart/form-data manually (no npm packages needed)
    const boundary = "----LiriBoundary" + Date.now().toString(16);
    // Pick the right file extension so Whisper knows the format.
    // Mismatched extension + Content-Type causes Whisper to reject the file.
    const ext = mimeType.includes("ogg") ? "ogg"
              : mimeType.includes("mp4") ? "m4a"
              : mimeType.includes("mp3") ? "mp3"
              : "webm";

    const preamble = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="language"\r\n\r\nen\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="response_format"\r\n\r\njson\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="audio.${ext}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`
    );
    const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([preamble, audioBuffer, epilogue]);

    const result = await new Promise((resolve, reject) => {
      const https = require("https");
      const req = https.request(
        {
          hostname: "api.openai.com",
          path: "/v1/audio/transcriptions",
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "Content-Length": body.length,
          },
        },
        (r) => {
          const chunks = [];
          r.on("data", c => chunks.push(c));
          r.on("end", () => {
            try { resolve({ status: r.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
            catch (e) { reject(new Error("Non-JSON from OpenAI")); }
          });
        }
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });

    if (result.status !== 200) {
      const msg = result.body?.error?.message || "Whisper failed";
      console.error("Whisper error:", result.status, result.body);
      return res.status(502).json({ error: msg, whisperStatus: result.status });
    }

    console.log("Whisper transcribed:", result.body.text?.slice(0, 80));
    return res.status(200).json({ text: result.body.text || "" });

  } catch (err) {
    console.error("Transcribe error:", err);
    return res.status(500).json({ error: err.message });
  }
};
