// api/discogs-import.js — import a user's owned Discogs collection (cheap, list-only)
//
// Pulls the user's "All" folder (folder 0) from Discogs and stores each owned
// record in user_discogs_collection. Deliberately does NOT fetch per-release
// detail, iTunes matches, or lyrics here — that's lazy enrichment, done later on
// first play. This keeps the import to ~1 Discogs call per 100 records.
//
// Resumable + timeout-safe: processes up to MAX_PAGES_PER_CALL pages per
// invocation and returns { done, nextPage }. The client calls again with
// ?page=<nextPage> until done, so huge collections never blow the function
// timeout or the rate limit.
//
// Required env: DISCOGS_KEY, DISCOGS_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const { verifyAuth }        = require("./_lib/auth");
const { sbRequest, sbUpsert } = require("./_lib/supabase");
const discogs               = require("./_lib/discogs-oauth");

const ALLOWED = ["https://getliri.com", "https://www.getliri.com", "capacitor://localhost"];

const PER_PAGE           = 100; // Discogs max
const MAX_PAGES_PER_CALL = 10;  // 10 requests/call — well under 60/min, fast enough for one function run

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Discogs appends " (2)" etc. to disambiguate same-named artists — strip it.
const cleanArtist = name => (name || "").replace(/\s*\(\d+\)\s*$/, "").trim();

// Map a Discogs collection item to a user_discogs_collection row.
function toRow(userId, item) {
  const bi = item.basic_information || {};
  return {
    user_id:             userId,
    discogs_release_id:  item.id || bi.id,
    discogs_instance_id: item.instance_id || 0,
    artist_name:         cleanArtist(bi.artists?.[0]?.name),
    album_name:          bi.title || null,
    release_year:        bi.year || null,
    thumb_url:           bi.cover_image || bi.thumb || null,
    added_at:            item.date_added || new Date().toISOString(),
  };
}

module.exports = async (req, res) => {
  const origin = req.headers.origin || "";
  res.setHeader("Access-Control-Allow-Origin", ALLOWED.includes(origin) ? origin : "https://getliri.com");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "Method not allowed" });

  const auth = await verifyAuth(req);
  if (!auth || auth._authError) {
    return res.status(401).json({ error: "Session expired — please sign out and back in." });
  }

  // Load the user's stored Discogs tokens + username.
  const { data: accts } = await sbRequest(
    "GET",
    `user_discogs_accounts?user_id=eq.${encodeURIComponent(auth.userId)}` +
      `&select=discogs_username,oauth_token,oauth_token_secret&limit=1`
  );
  const acct = Array.isArray(accts) ? accts[0] : null;
  if (!acct) return res.status(400).json({ error: "Connect your Discogs account first." });

  const startPage = Math.max(1, parseInt(req.body?.page ?? req.query?.page ?? "1", 10) || 1);
  const endPage   = startPage + MAX_PAGES_PER_CALL - 1;

  let imported = 0;
  let totalItems = null;
  let totalPages = null;
  let page = startPage;

  try {
    for (; page <= endPage; page++) {
      const url =
        `https://api.discogs.com/users/${encodeURIComponent(acct.discogs_username)}` +
        `/collection/folders/0/releases?per_page=${PER_PAGE}&page=${page}`;
      const { status, json } = await discogs.signedGet(url, acct.oauth_token, acct.oauth_token_secret);

      if (status === 401) return res.status(401).json({ error: "Discogs access was revoked. Please reconnect." });
      if (status === 429) { await sleep(2000); page--; continue; } // backoff and retry this page
      if (status !== 200 || !json) {
        return res.status(502).json({ error: "Couldn't read your Discogs collection. Please try again." });
      }

      totalItems = json.pagination?.items ?? totalItems;
      totalPages = json.pagination?.pages ?? totalPages;

      const items = Array.isArray(json.releases) ? json.releases : [];
      if (items.length) {
        const rows = items.map(it => toRow(auth.userId, it)).filter(r => r.discogs_release_id);
        // ignore-duplicates + return=representation → the response contains only
        // the rows actually inserted, so its length is the count of NEW records.
        // (Also leaves already-imported/enriched rows untouched.)
        const onConflict = encodeURIComponent("user_id,discogs_release_id,discogs_instance_id");
        const up = await sbRequest(
          "POST",
          `user_discogs_collection?on_conflict=${onConflict}`,
          rows,
          "resolution=ignore-duplicates,return=representation"
        );
        if (up.status >= 300) {
          console.error("[discogs-import] insert failed, status", up.status, up.data);
          return res.status(500).json({ error: "Couldn't save your collection. Please try again." });
        }
        imported += Array.isArray(up.data) ? up.data.length : 0;
      }

      if (totalPages != null && page >= totalPages) break; // reached the last page
      await sleep(250); // be gentle on the rate limit
    }

    const done = totalPages == null || page >= totalPages;
    if (done) {
      // PATCH (not upsert): the row already exists; upsert would fail the
      // NOT NULL token columns since we're only setting last_synced_at.
      await sbRequest("PATCH",
        `user_discogs_accounts?user_id=eq.${encodeURIComponent(auth.userId)}`,
        { last_synced_at: new Date().toISOString() }
      ).catch(() => {});
    }

    return res.status(200).json({
      imported,
      total: totalItems,
      pages: totalPages,
      done,
      nextPage: done ? null : page + 1,
    });
  } catch (e) {
    console.error("[discogs-import] error:", e.message);
    return res.status(500).json({ error: "Import failed. Please try again." });
  }
};
