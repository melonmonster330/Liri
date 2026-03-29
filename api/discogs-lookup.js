// Liri — Discogs Lookup Proxy (Vercel)
// Proxies Discogs database search + release detail to keep the
// User-Agent header consistent and avoid browser CORS issues.
//
// Usage:
//   /api/discogs-lookup?q=Taylor+Swift+Fearless&per_page=5   → search
//   /api/discogs-lookup?id=12345678                          → release detail

const https = require("https");

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { "User-Agent": "Liri/1.116 +https://getliri.com" },
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch { resolve(null); }
      });
    }).on("error", reject);
  });
}

module.exports = async (req, res) => {
  const ALLOWED_ORIGINS = ["https://getliri.com", "capacitor://localhost"];
  const origin = req.headers.origin || "";
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGINS.includes(origin) ? origin : "https://getliri.com");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { q, id, per_page = 5 } = req.query;

  if (!q && !id) return res.status(400).json({ error: "q or id required" });

  let url;
  if (id) {
    url = `https://api.discogs.com/releases/${encodeURIComponent(id)}`;
  } else {
    url = `https://api.discogs.com/database/search?q=${encodeURIComponent(q)}&type=release&format=Vinyl&per_page=${per_page}`;
  }

  try {
    const data = await httpsGet(url);
    res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=604800");
    res.json(data || {});
  } catch (e) {
    console.error("Discogs error:", e.message);
    res.status(500).json({ error: "Lookup failed. Please try again." });
  }
};
