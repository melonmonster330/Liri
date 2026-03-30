// Liri — GPT Song Identification from Transcribed Lyrics (Vercel)
//
// Takes a short lyrics snippet (from Whisper transcription) and asks
// GPT-4o-mini to identify the song title + artist. Much more reliable
// than trying to search LRCLib by lyric text (LRCLib searches metadata,
// not lyric content).
//
// POST /api/identify-lyrics
// Body:    { text: "I hate this town I'm staying at my parent's house" }
// Returns: { title: "Song Name", artist: "Artist Name" }
//       or { title: null, artist: null } if not recognized

const https = require("https");

function callOpenAI(apiKey, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: "api.openai.com",
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(new Error("Non-JSON from OpenAI")); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

const { verifyAuth } = require("./_lib/auth");

module.exports = async (req, res) => {
  const ALLOWED_ORIGINS = ["https://getliri.com", "capacitor://localhost"];
  const origin = req.headers.origin || "";
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGINS.includes(origin) ? origin : "https://getliri.com");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  if (!await verifyAuth(req)) return res.status(401).json({ error: "Unauthorized" });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "OPENAI_API_KEY not configured" });

  const { text } = req.body || {};
  if (!text || text.trim().length < 4) {
    return res.status(400).json({ error: "Missing or too-short text" });
  }

  try {
    const result = await callOpenAI(apiKey, {
      model: "gpt-4o-mini",
      messages: [{
        role: "user",
        content: `These words were transcribed from a song playing in the background:\n\n"${text}"\n\nWhat song is this? Reply with ONLY this format: Title | Artist\nIf you cannot identify it, reply with: unknown`,
      }],
      max_tokens: 60,
      temperature: 0,
    });

    const answer = (result.choices?.[0]?.message?.content || "").trim();
    console.log("GPT song ID:", answer);

    if (!answer || answer.toLowerCase() === "unknown" || !answer.includes("|")) {
      return res.status(200).json({ title: null, artist: null });
    }

    const [title, artist] = answer.split("|").map(s => s.trim());
    return res.status(200).json({ title: title || null, artist: artist || null });

  } catch (err) {
    console.error("identify-lyrics error:", err.message);
    return res.status(500).json({ error: "Song identification failed. Please try again." });
  }
};
