// Liri — Image Proxy (Vercel)
// Proxies Discogs CDN images so hotlink protection doesn't block browser requests.

const https = require("https");

module.exports = async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).end();

  // Only proxy Discogs image domains
  if (!url.startsWith("https://i.discogs.com/") && !url.startsWith("https://img.discogs.com/")) {
    return res.status(403).end();
  }

  try {
    const { statusCode, contentType, buffer } = await new Promise((resolve, reject) => {
      const request = https.get(url, {
        headers: {
          "User-Agent": "Liri/1.0 +https://getliri.com",
          "Referer":    "https://www.discogs.com/",
        },
      }, (upstream) => {
        const chunks = [];
        upstream.on("data", c => chunks.push(c));
        upstream.on("end", () => resolve({
          statusCode:  upstream.statusCode,
          contentType: upstream.headers["content-type"] || "image/jpeg",
          buffer:      Buffer.concat(chunks),
        }));
        upstream.on("error", reject);
      });
      request.on("error", reject);
      request.setTimeout(8000, () => { request.destroy(); reject(new Error("timeout")); });
    });

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "s-maxage=604800, stale-while-revalidate=2592000");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(statusCode).send(buffer);
  } catch (e) {
    res.status(502).end();
  }
};
