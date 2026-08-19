// Daily missing-lyrics research worker.
//
// This worker never generates, completes, paraphrases, or rewrites lyrics. It
// only (1) fetches provider-supplied lyrics or (2) validates exact, opted-in
// user submissions. A user candidate is promoted automatically only when two
// independent users supplied the same text; a lone candidate needs review.

const crypto = require("crypto");
const { fetchLyrics, parseLrcToWords } = require("./_lib/lyrics");
const { validateUserLyricSubmission } = require("./_lib/user-lyric-validation");

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BATCH_LIMIT = Math.max(1, Math.min(50, Number(process.env.LYRICS_AGENT_BATCH_LIMIT || 20)));

function safeCompare(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

async function sb(path, { method = "GET", body, prefer } = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(prefer ? { Prefer: prefer } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch {}
  if (!response.ok) {
    const detail = data?.message || data?.details || data?.code || "request failed";
    throw new Error(`Supabase ${method} ${path}: ${response.status} ${detail}`);
  }
  return data;
}

async function promote(trackId, lyrics, source) {
  await sb("track_lyrics?on_conflict=itunes_track_id", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      itunes_track_id: trackId,
      lrc_raw: lyrics.lrc || null,
      lyrics_plain: lyrics.plain || null,
      words_json: lyrics.lrc ? parseLrcToWords(lyrics.lrc) : null,
      source,
      fetched_at: new Date().toISOString(),
    },
  });
}

async function researchBug(bug) {
  const meta = bug.meta || {};
  const trackId = Number(meta.itunes_track_id || 0);
  if (!trackId) return { id: bug.id, status: "skipped", reason: "missing track ID" };

  const existing = await sb(`track_lyrics?itunes_track_id=eq.${trackId}&select=itunes_track_id&limit=1`);
  if (existing?.length) {
    await sb(`bug_reports?id=eq.${bug.id}`, {
      method: "PATCH", body: { status: "fixed", fixed_at: new Date().toISOString() },
    });
    return { id: bug.id, trackId, status: "already_fixed" };
  }

  let trackName = meta.track_name || "";
  let artistName = meta.artist_name || "";
  let albumName = meta.album_name || "";
  let durationMs = Number(meta.duration_ms || 0) || null;
  if (!trackName || !artistName) {
    const tracks = await sb(`album_tracks?itunes_track_id=eq.${trackId}&select=track_name,artist_name,duration_ms,itunes_collection_id&limit=1`);
    const track = tracks?.[0];
    if (track) {
      trackName ||= track.track_name || "";
      artistName ||= track.artist_name || "";
      durationMs ||= track.duration_ms || null;
      if (!albumName && track.itunes_collection_id) {
        const albums = await sb(`catalogue?itunes_collection_id=eq.${track.itunes_collection_id}&select=album_name&limit=1`);
        albumName = albums?.[0]?.album_name || "";
      }
    }
  }

  const found = await fetchLyrics(trackName, artistName, albumName, durationMs ? durationMs / 1000 : null).catch(() => null);
  if (found?.lrc || found?.plain) {
    await promote(trackId, found, found.source || "provider");
    await sb(`bug_reports?id=eq.${bug.id}`, {
      method: "PATCH", body: { status: "fixed", fixed_at: new Date().toISOString() },
    });
    return { id: bug.id, trackId, status: "promoted_provider", source: found.source };
  }

  const candidates = await sb(
    `user_track_lyrics?itunes_track_id=eq.${trackId}&share_for_catalog=eq.true&review_status=in.(pending,needs_review)&is_instrumental=eq.false&select=id,user_id,lrc_raw,lyrics_plain,updated_at`
  );
  const valid = [];
  for (const candidate of candidates || []) {
    const checked = validateUserLyricSubmission(candidate, durationMs);
    if (checked.ok) valid.push({ row: candidate, checked });
    else {
      await sb(`user_track_lyrics?id=eq.${candidate.id}`, {
        method: "PATCH",
        body: { review_status: "rejected", review_note: checked.reason, reviewed_at: new Date().toISOString() },
      });
    }
  }

  const groups = new Map();
  for (const item of valid) {
    if (!groups.has(item.checked.signature)) groups.set(item.checked.signature, []);
    groups.get(item.checked.signature).push(item);
  }
  const consensus = [...groups.values()].find(group => new Set(group.map(x => x.row.user_id)).size >= 2);
  if (consensus) {
    const best = consensus.find(x => x.checked.lrc) || consensus[0];
    await promote(trackId, best.checked, "user_consensus");
    const ids = consensus.map(x => x.row.id);
    await sb(`user_track_lyrics?id=in.(${ids.join(",")})`, {
      method: "PATCH",
      body: { review_status: "promoted", review_note: "Matched an independent submission", reviewed_at: new Date().toISOString() },
    });
    await sb(`bug_reports?id=eq.${bug.id}`, {
      method: "PATCH", body: { status: "fixed", fixed_at: new Date().toISOString() },
    });
    return { id: bug.id, trackId, status: "promoted_user_consensus", submissions: consensus.length };
  }

  for (const item of valid) {
    await sb(`user_track_lyrics?id=eq.${item.row.id}`, {
      method: "PATCH",
      body: { review_status: "needs_review", review_note: "Valid format; awaiting independent confirmation", reviewed_at: new Date().toISOString() },
    });
  }
  const retryCount = Number(bug.retry_count || 0) + 1;
  await sb(`bug_reports?id=eq.${bug.id}`, {
    method: "PATCH",
    body: { retry_count: retryCount, last_retried_at: new Date().toISOString(), ...(retryCount >= 3 ? { status: "backlog" } : {}) },
  });
  return { id: bug.id, trackId, status: valid.length ? "awaiting_confirmation" : "not_found" };
}

module.exports = async (req, res) => {
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "GET or POST only" });
  if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: "Missing Supabase service configuration" });

  const cronSecret = process.env.CRON_SECRET;
  const supplied = req.headers["x-cron-secret"] || req.headers.authorization?.replace(/^Bearer\s+/i, "");
  // Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` when the project
  // secret is configured. Never trust x-vercel-cron by itself: clients can
  // spoof arbitrary request headers, and this endpoint writes canonical data.
  const authorized = cronSecret && supplied && safeCompare(cronSecret, supplied);
  if (!authorized) return res.status(401).json({ error: "Unauthorized" });

  try {
    const bugs = await sb(
      `bug_reports?status=in.(open,backlog)&meta->>category=eq.missing_lyrics&select=id,status,retry_count,meta&order=last_retried_at.asc.nullsfirst&limit=${BATCH_LIMIT}`
    );
    const results = [];
    // Sequential provider research avoids hammering external lyric services.
    for (const bug of bugs || []) {
      try {
        results.push(await researchBug(bug));
      } catch (error) {
        // One malformed catalogue row must not stop every later report. Move
        // the failure to the back of the queue and preserve it for inspection.
        const retryCount = Number(bug.retry_count || 0) + 1;
        try {
          await sb(`bug_reports?id=eq.${bug.id}`, {
            method: "PATCH",
            body: {
              retry_count: retryCount,
              last_retried_at: new Date().toISOString(),
              ...(retryCount >= 3 ? { status: "backlog" } : {}),
            },
          });
        } catch {}
        results.push({
          id: bug.id,
          trackId: Number(bug.meta?.itunes_track_id || 0) || null,
          status: "error",
          error: error.message || "Research failed",
        });
      }
    }
    return res.status(200).json({ processed: results.length, results });
  } catch (error) {
    console.error("[lyrics-agent]", error);
    return res.status(500).json({ error: error.message || "Lyrics research failed" });
  }
};
