const OpenAI = require("openai");

// Raw body needed — Vercel's default JSON parser would corrupt the audio binary
module.exports.config = { api: { bodyParser: false } };

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "OPENAI_API_KEY not set" });

  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    if (buffer.length < 500) return res.json({ text: "" }); // too small to transcribe

    const mimeType = req.headers["content-type"] || "audio/webm";
    const ext = mimeType.includes("mp4") ? "mp4" : "webm";

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const file = new File([buffer], `audio.${ext}`, { type: mimeType });

    const prompt = req.headers["x-prompt"] || undefined;

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
