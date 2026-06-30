// Liri — Re-fetch track_lyrics with the improved logic
//
// Many albums were added under an older fetchLyrics that fell through to a
// non-duration-matched LRClib version when Discogs lacked per-track durations,
// producing lyrics whose timestamps don't match the pressing and drift every
// song. The new fetchLyrics (api/_lib/lyrics.js) uses iTunes as a secondary
// duration source and refuses to store wrong-tempo synced lyrics. This endpoint
// re-runs that fetcher against existing rows so already-added albums get fixed
// without users having to remove/re-add anything.
//
// Auth: x-cron-secret header (same as sync-catalogue).
//
// Modes:
//   POST /api/refresh-lyrics?collection_id=12345
//     → refresh every track on that album
//   POST /api/refresh-lyrics?sweep=1&limit=50&offset=0
//     → process the next `limit` tracks across all albums; repeat with
//       offset = previous nextOffset until done=true
//
// Never downgrades: a track with synced lyrics is only replaced if the new
// pass also returns synced (since the new fetcher only returns synced when
// duration-matched, that means the replacement is verified-correct).

const crypto = require("crypto");
const https  = require("https");
const { fetchLyrics, parseLrcToWords } = require("./_lib/lyrics");

function safeCompare(a, b) {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Supabase REST helpers (service role) ─────────────────────────────────────

function sbRequest(method, path, body) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return Promise.resolve({ status: 0, data: null });

  const hostname = url.replace(/^https?:\/\//, "");
  const bodyStr  = body ? JSON.stringify(body) : "";

  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  if (method === "POST" || method === "PATCH") {
    headers.Prefer = "resolution=merge-duplicates,return=minimal";
  }
  if (body) headers["Content-Length"] = Buffer.byteLength(bodyStr);

  return new Promise((resolve) => {
    const req = https.request({ hostname, path: `/rest/v1/${path}`, method, headers }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        let data = null; try { data = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, data });
      });
    });
    req.on("error", () => resolve({ status: 0, data: null }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ status: 0, data: null }); });
    if (body) req.write(bodyStr);
    req.end();
  });
}

// ── Replace policy: never downgrade ──────────────────────────────────────────
// New chain only returns synced lyrics when duration-matched; if it returns
// only plain text, we keep whatever's already stored (which might be old wrong-
// tempo synced, but plain text wouldn't be an upgrade either way).
function shouldReplace(stored, fresh) {
  if (!fresh) return false;
  if (fresh.lrc) return fresh.lrc !== (stored.lrc_raw || null);
  if (stored.lrc_raw) return false; // never replace synced with plain
  return (fresh.plain || "") !== (stored.lyrics_plain || "");
}

async function refreshOne(track, album_name, stored) {
  const fresh = await fetchLyrics(
    track.track_name, track.artist_name, album_name,
    track.duration_ms ? track.duration_ms / 1000 : null
  ).catch(() => null);

  if (!fresh) return { itunes_track_id: track.itunes_track_id, status: "no_lyrics_found" };
  if (!shouldReplace(stored, fresh)) {
    return { itunes_track_id: track.itunes_track_id, status: "kept_existing" };
  }

  const row = {
    itunes_track_id: track.itunes_track_id,
    lrc_raw:      fresh.lrc || null,
    lyrics_plain: fresh.plain || null,
    words_json:   fresh.lrc ? parseLrcToWords(fresh.lrc) : null,
    source:       fresh.source,
    fetched_at:   new Date().toISOString(),
  };
  const { status } = await sbRequest("POST", "track_lyrics?on_conflict=itunes_track_id", [row]);
  return {
    itunes_track_id: track.itunes_track_id,
    status: status < 300
      ? (fresh.lrc ? "updated_synced" : "updated_plain")
      : `error_${status}`,
  };
}

// ── Main handler ─────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  const url    = new URL(req.url || "/", "http://x");
  const action = url.searchParams.get("action");

  // Vercel cron hits this with GET (no body); manual sweep/refresh uses POST.
  // Reject anything else.
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ error: "POST or GET only" });
  }

  // Auth — accept Vercel's signed cron header in addition to the manual cron
  // secret. Vercel automatically attaches x-vercel-cron when it fires a
  // scheduled job, so the daily email run doesn't require any extra setup.
  const cronSecret = process.env.CRON_SECRET;
  const provided   = req.headers["x-cron-secret"]
                  || req.headers["authorization"]?.replace("Bearer ", "");
  const isVercelCron = !!req.headers["x-vercel-cron"];
  const secretOk     = cronSecret && provided && safeCompare(cronSecret, provided);
  if (!isVercelCron && !secretOk) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (action === "lyrics-ready-emails") {
    const dryRun = url.searchParams.get("dry") === "1";
    return res.status(200).json(await sendLyricsReadyEmails(dryRun));
  }

  // Everything below is the original sweep/refresh-by-id flow, POST only.
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only for this action" });
  }

  const collectionId = url.searchParams.get("collection_id");
  const sweep        = url.searchParams.get("sweep") === "1";
  const limit        = Math.min(parseInt(url.searchParams.get("limit")  || "50", 10), 200);
  const offset       = parseInt(url.searchParams.get("offset") || "0", 10);

  if (!collectionId && !sweep) {
    return res.status(400).json({ error: "pass ?collection_id=X, ?sweep=1, or ?action=lyrics-ready-emails" });
  }

  // ── Load the tracks to process ───────────────────────────────────────────
  const trackPath = collectionId
    ? `album_tracks?itunes_collection_id=eq.${encodeURIComponent(collectionId)}&select=itunes_track_id,track_name,artist_name,itunes_collection_id,duration_ms`
    : `album_tracks?select=itunes_track_id,track_name,artist_name,itunes_collection_id,duration_ms&order=itunes_track_id.asc&limit=${limit}&offset=${offset}`;

  const { data: tracks } = await sbRequest("GET", trackPath);
  if (!Array.isArray(tracks) || tracks.length === 0) {
    return res.status(200).json({ processed: 0, results: [], done: true });
  }

  // ── Resolve album names for the cids in this batch ───────────────────────
  const cids = [...new Set(tracks.map(t => t.itunes_collection_id).filter(x => x != null))];
  const albumNameByCid = new Map();
  if (cids.length > 0) {
    const { data: cats } = await sbRequest(
      "GET",
      `catalogue?itunes_collection_id=in.(${cids.join(",")})&select=itunes_collection_id,album_name`
    );
    for (const c of (cats || [])) albumNameByCid.set(c.itunes_collection_id, c.album_name);
  }

  // ── Load currently-stored lyrics in one batch ────────────────────────────
  const tids = tracks.map(t => t.itunes_track_id).filter(x => x != null);
  const { data: lyricRows } = await sbRequest(
    "GET",
    `track_lyrics?itunes_track_id=in.(${tids.join(",")})&select=itunes_track_id,lrc_raw,lyrics_plain,source`
  );
  const storedByTid = new Map((lyricRows || []).map(r => [r.itunes_track_id, r]));

  // ── Process sequentially with a small delay (be kind to iTunes/LRClib) ──
  const results = [];
  for (const t of tracks) {
    const stored     = storedByTid.get(t.itunes_track_id) || {};
    const album_name = albumNameByCid.get(t.itunes_collection_id) || "";
    const r = await refreshOne(t, album_name, stored);
    results.push(r);
    await sleep(250);
  }

  const counts = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});

  res.status(200).json({
    processed: results.length,
    counts,
    nextOffset: sweep ? offset + tracks.length : null,
    done:       sweep ? tracks.length < limit : true,
    results,
  });
};

// ── "Lyrics ready" email cron ────────────────────────────────────────────────
// For every album that has full lyric coverage (every track has lrc_raw or
// lyrics_plain), email anyone who has it in their library and hasn't been
// notified yet about that album. One row in lyrics_ready_notifications per
// (user, album) is what makes the dedup possible.

async function sbGetAllPages(pathBase) {
  const out = []; let from = 0; const step = 1000;
  while (true) {
    const sep = pathBase.includes("?") ? "&" : "?";
    const { data } = await sbRequest("GET", `${pathBase}${sep}offset=${from}&limit=${step}`);
    if (!Array.isArray(data) || data.length === 0) break;
    out.push(...data);
    if (data.length < step) break;
    from += step;
  }
  return out;
}

// Resend send. Returns the resend message id on success, null on failure.
function resendSend({ to, subject, html, text, from }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return Promise.resolve({ ok: false, error: "RESEND_API_KEY not set" });
  const body = JSON.stringify({ from, to: [to], subject, html, text });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: "api.resend.com",
      path: "/emails",
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        let parsed = null; try { parsed = JSON.parse(raw); } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300 && parsed?.id) {
          resolve({ ok: true, id: parsed.id });
        } else {
          resolve({ ok: false, error: parsed?.message || `HTTP ${res.statusCode}`, raw });
        }
      });
    });
    req.on("error", (e) => resolve({ ok: false, error: e.message }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ ok: false, error: "timeout" }); });
    req.write(body);
    req.end();
  });
}

// Fetch user emails via the Supabase Auth admin API (no REST equivalent).
async function fetchUserEmails(userIds) {
  if (!userIds.length) return new Map();
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return new Map();
  const hostname = url.replace(/^https?:\/\//, "");
  const want = new Set(userIds);
  const emails = new Map();
  // Auth admin API only paginates — fetch pages until we've covered the set
  // or run out. With ~39 users today this is one request.
  for (let page = 1; page <= 10; page++) {
    const { status, data } = await new Promise((resolve) => {
      const req = https.request({
        hostname, path: `/auth/v1/admin/users?page=${page}&per_page=1000`, method: "GET",
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      }, (res) => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }); }
          catch { resolve({ status: res.statusCode, data: null }); }
        });
      });
      req.on("error", () => resolve({ status: 0, data: null }));
      req.setTimeout(15000, () => { req.destroy(); resolve({ status: 0, data: null }); });
      req.end();
    });
    if (status !== 200 || !data?.users) break;
    for (const u of data.users) {
      if (want.has(u.id) && u.email) emails.set(u.id, u.email);
    }
    if (data.users.length < 1000) break;
  }
  return emails;
}

function renderEmail({ albumName, artistName, artworkUrl, deepLink }) {
  const safe = s => String(s || "").replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
  const album = safe(albumName);
  const artist = safe(artistName);
  const subject = `Good news — Liri now has the full lyrics for ${album}`;
  const text = `Good news!\n\nLiri now has the full synced lyrics for ${album}${artist ? " by " + artist : ""} in your library.\n\nClick to sync now:\n${deepLink}\n\n— Liri\nhttps://getliri.com`;
  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#080810;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#f0e6d3">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#080810;padding:32px 16px">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;background:#0e0e1a;border-radius:20px;border:1px solid rgba(255,255,255,0.08);padding:32px">
        <tr><td align="center" style="padding-bottom:8px">
          <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:rgba(212,168,70,0.85);font-weight:700">Liri</div>
        </td></tr>
        <tr><td align="center" style="padding-bottom:24px">
          <div style="font-size:22px;font-weight:700;color:#f0e6d3;line-height:1.3">Good news — lyrics are ready</div>
        </td></tr>
        ${artworkUrl ? `<tr><td align="center" style="padding-bottom:20px"><img src="${safe(artworkUrl)}" width="160" height="160" alt="" style="border-radius:10px;display:block"></td></tr>` : ""}
        <tr><td align="center" style="padding-bottom:8px"><div style="font-size:18px;font-weight:700;color:#f0e6d3">${album}</div></td></tr>
        ${artist ? `<tr><td align="center" style="padding-bottom:24px"><div style="font-size:14px;color:rgba(255,255,255,0.5)">${artist}</div></td></tr>` : ""}
        <tr><td align="center" style="padding-bottom:24px">
          <div style="font-size:14px;color:rgba(255,255,255,0.7);line-height:1.5;max-width:360px">
            Liri now has the full synced lyrics for this album. Put the record on and tap below to start syncing.
          </div>
        </td></tr>
        <tr><td align="center" style="padding-bottom:24px">
          <a href="${deepLink}" style="background:linear-gradient(135deg,#d4a846,#c9807a);color:#080810;text-decoration:none;border-radius:50px;padding:14px 32px;font-size:14px;font-weight:700;display:inline-block">Sync now →</a>
        </td></tr>
        <tr><td align="center" style="padding-top:16px;border-top:1px solid rgba(255,255,255,0.06)">
          <div style="font-size:11px;color:rgba(255,255,255,0.3)">getliri.com</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
  return { subject, html, text };
}

async function sendLyricsReadyEmails(dryRun = false) {
  const fromAddress = process.env.RESEND_FROM || "Liri <hello@getliri.com>";

  // 1. Compute the set of "complete" albums (every track has lrc_raw or lyrics_plain).
  const [allTracks, lyricsRows] = await Promise.all([
    sbGetAllPages(`album_tracks?select=itunes_track_id,itunes_collection_id`),
    sbGetAllPages(`track_lyrics?select=itunes_track_id&or=(lrc_raw.not.is.null,lyrics_plain.not.is.null)`),
  ]);
  const haveLyrics = new Set(lyricsRows.map(r => r.itunes_track_id));
  const byAlbum = new Map();
  for (const t of allTracks) {
    if (!byAlbum.has(t.itunes_collection_id)) byAlbum.set(t.itunes_collection_id, { total: 0, withLyrics: 0 });
    const s = byAlbum.get(t.itunes_collection_id);
    s.total += 1;
    if (haveLyrics.has(t.itunes_track_id)) s.withLyrics += 1;
  }
  const completeCids = [...byAlbum.entries()]
    .filter(([, s]) => s.total > 0 && s.total === s.withLyrics)
    .map(([cid]) => cid);

  if (completeCids.length === 0) {
    return { stage: "no-complete-albums", complete: 0, candidates: 0, sent: 0, skipped: 0, errors: 0 };
  }

  // 2. Who owns these albums?
  const libraryRows = await sbGetAllPages(
    `user_library?select=user_id,itunes_collection_id&itunes_collection_id=in.(${completeCids.join(",")})`
  );
  if (libraryRows.length === 0) {
    return { stage: "no-library-matches", complete: completeCids.length, candidates: 0, sent: 0, skipped: 0, errors: 0 };
  }

  // 3. Who's already been notified?
  const notifiedRows = await sbGetAllPages(
    `lyrics_ready_notifications?select=user_id,itunes_collection_id&itunes_collection_id=in.(${completeCids.join(",")})`
  );
  const notifiedKey = (uid, cid) => `${uid}::${cid}`;
  const alreadyNotified = new Set(notifiedRows.map(r => notifiedKey(r.user_id, r.itunes_collection_id)));

  const pending = libraryRows.filter(r => !alreadyNotified.has(notifiedKey(r.user_id, r.itunes_collection_id)));
  if (pending.length === 0) {
    return { stage: "all-notified", complete: completeCids.length, candidates: 0, sent: 0, skipped: 0, errors: 0 };
  }

  // 4. Resolve user emails + album metadata.
  const userIds = [...new Set(pending.map(p => p.user_id))];
  const pendingCids = [...new Set(pending.map(p => p.itunes_collection_id))];
  const [emails, catalogueRows] = await Promise.all([
    fetchUserEmails(userIds),
    sbRequest("GET", `catalogue?itunes_collection_id=in.(${pendingCids.join(",")})&select=itunes_collection_id,album_name,artist_name,artwork_url`)
      .then(r => Array.isArray(r.data) ? r.data : []),
  ]);
  const catByCid = new Map(catalogueRows.map(c => [c.itunes_collection_id, c]));

  // 5. Send + record.
  let sent = 0, skipped = 0, errors = 0;
  const details = [];
  for (const p of pending) {
    const email  = emails.get(p.user_id);
    const albumMeta = catByCid.get(p.itunes_collection_id);
    if (!email || !albumMeta?.album_name) {
      skipped += 1;
      details.push({ user_id: p.user_id, cid: p.itunes_collection_id, status: "skipped", reason: !email ? "no_email" : "no_album_meta" });
      continue;
    }
    const deepLink = `https://getliri.com/library?sync=${p.itunes_collection_id}`;
    const { subject, html, text } = renderEmail({
      albumName:  albumMeta.album_name,
      artistName: albumMeta.artist_name,
      artworkUrl: albumMeta.artwork_url,
      deepLink,
    });

    if (dryRun) {
      sent += 1;
      details.push({ user_id: p.user_id, email, cid: p.itunes_collection_id, status: "would_send", subject });
      continue;
    }

    const result = await resendSend({ from: fromAddress, to: email, subject, html, text });
    if (!result.ok) {
      errors += 1;
      details.push({ user_id: p.user_id, email, cid: p.itunes_collection_id, status: "error", error: result.error });
      continue;
    }
    // Record the send so we don't double-email.
    const { status: insertStatus } = await sbRequest("POST", "lyrics_ready_notifications", {
      user_id: p.user_id,
      itunes_collection_id: p.itunes_collection_id,
      resend_message_id: result.id,
    });
    sent += 1;
    details.push({ user_id: p.user_id, email, cid: p.itunes_collection_id, status: "sent", message_id: result.id, recorded: insertStatus < 300 });
    // Resend free tier is 2 req/sec — stay well under
    await sleep(600);
  }

  return {
    stage: dryRun ? "dry-run" : "complete",
    complete: completeCids.length,
    candidates: pending.length,
    sent, skipped, errors,
    details: details.slice(0, 50),
  };
}
