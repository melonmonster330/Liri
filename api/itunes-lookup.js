// Liri — iTunes Lookup Proxy (Vercel)
// Proxies iTunes lookup API to avoid CORS issues on the web.

const https = require("https");

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch { resolve(null); }
      });
    }).on("error", reject);
  });
}

module.exports = async (req, res) => {
  const { id, term, entity, limit } = req.query;

  if (!id && !term) {
    return res.status(400).json({ error: "id or term required" });
  }

  try {
    let url;
    if (id) {
      url = `https://itunes.apple.com/lookup?id=${encodeURIComponent(id)}&entity=${entity || "song"}&limit=${limit || 200}`;
    } else {
      url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=${entity || "album"}&limit=${limit || 8}`;
    }

    const data = await httpsGet(url);
    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
    res.json(data || { resultCount: 0, results: [] });
  } catch (e) {
    res.status(500).json({ error: "iTunes API error", detail: e.message });
  }
};
