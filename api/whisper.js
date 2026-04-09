const OpenAI = require("openai");

// Disable body parser so we can handle both raw binary (web) and base64 JSON (iOS)
module.exports.config = { api: { bodyParser: false } };

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "OPENAI_API_KEY not set" });

  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks);

    if (rawBody.length < 10) return res.json({ text: "" });

    let buffer, mimeType, prompt;

    const contentType = req.headers["content-type"] || "";

    if (contentType.includes("application/json")) {
      // iOS path: base64-encoded audio inside JSON { audio, mimeType, prompt }
      const { audio, mimeType: mt, prompt: p } = JSON.parse(rawBody.toString());
      buffer = Buffer.from(audio, "base64");
      mimeType = mt || "audio/mp4";
      prompt = p;
    } else {
      // Web path: raw binary audio blob
      buffer = rawBody;
      mimeType = contentType || "audio/webm";
      prompt = req.headers["x-prompt"] || undefined;
    }

    if (buffer.length < 500) return res.json({ text: "" });

    const ext = mimeType.includes("mp4") ? "mp4" : "webm";
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const file = new File([buffer], `audio.${ext}`, { type: mimeType });

    const { text } = await openai.audio.transcriptions.create({
      model: "whisper-1",
      file,
      language: "en",
      ...(prompt ? { prompt } : {}),
    });

    res.json({ text: text || "" });
  } catch (err) {
    console.error("[whisper] error:", err);
    res.status(500).json({ error: err.message });
  }
};
