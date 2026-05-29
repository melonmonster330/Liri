// Liri — Discogs Lookup Proxy (Vercel)
// Proxies Discogs database search + release detail to keep the
// User-Agent header consistent and avoid browser CORS issues.
//
// Usage:
//   /api/discogs-lookup?q=Taylor+Swift+Fearless&per_page=5   → search
//   /api/discogs-lookup?id=12345678                          → release detail

const https = require("https");

function httpsGet(url) {
  const token  = process.env.DISCOGS_TOKEN;
  const key    = process.env.DISCOGS_KEY;
  const secret = process.env.DISCOGS_SECRET;
  // Build auth header: prefer personal token, fall back to key+secret
  let authHeader = {};
  if (token) {
    authHeader = { "Authorization": `Discogs token=${token}` };
  } else if (key) {
    authHeader = { "Authorization": `Discogs key=${key}, secret=${secret}` };
  }
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        "User-Agent": "Liri/1.0 +https://getliri.com",
        ...authHeader,
      },
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
  const ALLOWED_ORIGINS = ["https://getliri.com", "https://www.getliri.com", "capacitor://localhost"];
  const origin = req.headers.origin || "";
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGINS.includes(origin) ? origin : "https://getliri.com");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { q, id, per_page = 5 } = req.query;

  if (!q && !id) return res.status(400).json({ error: "q or id required" });

  try {
    // ── Release detail by id ──
    if (id) {
      const data = await httpsGet(`https://api.discogs.com/releases/${encodeURIComponent(id)}`);
      // Release detail is stable — safe to cache hard.
      res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=604800");
      return res.json(data || {});
    }

    // ── Search ──
    // Vinyl pressings are ideal (they carry A1/B2 side positions that power
    // Liri's side detection), so we ask for those FIRST. But a brand-new album
    // often has no vinyl release indexed in Discogs yet — the old hard
    // `format=Vinyl` filter made those albums un-findable. So if vinyl results
    // don't fill the page, fall back to any release (CD/digital). Those add fine
    // (lyrics still work); side data just falls back to the heuristic and gets
    // flagged for later, instead of the album being completely missing.
    const want = Math.max(1, parseInt(per_page, 10) || 5);
    const base = `https://api.discogs.com/database/search?q=${encodeURIComponent(q)}&type=release&per_page=${want}`;

    const vinyl = await httpsGet(`${base}&format=Vinyl`);
    const results = Array.isArray(vinyl?.results) ? [...vinyl.results] : [];

    if (results.length < want) {
      const any = await httpsGet(base);
      const seen = new Set(results.map(r => r.id));
      for (const r of (any?.results || [])) {
        if (r?.id && !seen.has(r.id)) { results.push(r); seen.add(r.id); }
        if (results.length >= want) break;
      }
    }

    // Shorter cache than detail so a newly-indexed pressing surfaces within ~1h.
    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
    res.json({ ...(vinyl || {}), results });
  } catch (e) {
    console.error("Discogs error:", e.message);
    res.status(500).json({ error: "Lookup failed. Please try again." });
  }
};
