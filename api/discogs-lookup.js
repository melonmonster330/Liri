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
      headers: { "User-Agent": "Liri/1.48 +https://getliri.app" },
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
    res.status(500).json({ error: "Discogs API error", detail: e.message });
  }
};
