// api/discogs.js — single Discogs serverless function.
//
// Dispatches on ?action= to keep the whole feature to ONE function (the Hobby
// plan caps a deployment at 12). The old paths still work via rewrites in
// vercel.json:
//   /api/discogs-oauth-start    → /api/discogs?action=start
//   /api/discogs-oauth-callback → /api/discogs?action=callback
//   /api/discogs-status         → /api/discogs?action=status
//   /api/discogs-import         → /api/discogs?action=import
//   /api/discogs-disconnect     → /api/discogs?action=disconnect

const handlers = require("./_lib/discogs-handlers");

module.exports = async (req, res) => {
  const action = (req.query && req.query.action) || "";
  switch (action) {
    case "start":      return handlers.start(req, res);
    case "callback":   return handlers.callback(req, res);
    case "status":     return handlers.status(req, res);
    case "import":     return handlers.importCollection(req, res);
    case "disconnect": return handlers.disconnect(req, res);
    default:           return res.status(400).json({ error: "Unknown Discogs action" });
  }
};
