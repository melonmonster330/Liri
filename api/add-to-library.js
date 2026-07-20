// Liri — Add Album to Library (Vercel)
//
// HYBRID data model:
//   • iTunes/Apple supplies canonical album metadata, artwork, stable song IDs,
//     durations, and the titles ShazamKit recognizes.
//   • A confidently matched Discogs vinyl layout is the physical source of
//     truth. It supplies the ordered songs and side positions, which prevents
//     Apple-only messages/digital bonuses from appearing as record tracks.
//   • When Discogs is ambiguous, we preserve the complete iTunes list rather
//     than silently hiding a real song.
//
// Flow (iTunes path):
//   1. Fetch iTunes album lookup → collection meta + ordered tracklist
//   2. Save catalogue + album_tracks (real iTunes track IDs)
//   3. Fetch lyrics from LRCLib per track (by name matching)
//   4. Best-effort: find a matching Discogs vinyl release → map side/position
//      data onto the iTunes tracks → save vinyl_sides
//   5. Link user → album in user_library
//
// A legacy { discogs_release_id } path is kept for back-compat (older clients
// / already-cached Discogs-sourced albums).
//
// Required Vercel env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DISCOGS_KEY, DISCOGS_SECRET

const https = require("https");
const { verifyAuth, getSubscriptionTier } = require("./_lib/auth");
const { fetchLyrics, parseLrcToWords, lrcToPlain } = require("./_lib/lyrics");

const FREE_ALBUM_LIMIT = 10;

// ── Generic HTTPS GET ─────────────────────────────────────────────────────────

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch { resolve({ status: res.statusCode, data: null }); }
      });
    });
    req.on("error", reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error("Request timed out")); });
  });
}

async function batchedAll(items, fn, batchSize = 3) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = await Promise.all(items.slice(i, i + batchSize).map(fn));
    results.push(...batch);
  }
  return results;
}

// ── Supabase helpers ──────────────────────────────────────────────────────────

function sbRequest(method, path, body) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return Promise.reject(new Error("Supabase env vars not set"));
  const hostname = url.replace(/^https?:\/\//, "");
  const bodyStr  = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname,
      path: `/rest/v1/${path}`,
      method,
      headers: {
        "apikey":        key,
        "Authorization": `Bearer ${key}`,
        "Content-Type":  "application/json",
        "Prefer":        "resolution=merge-duplicates,return=minimal",
        ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
      }
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch { resolve({ status: res.statusCode, data: null }); }
      });
    });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function upsert(table, row, onConflict) {
  const qs = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : "";
  return sbRequest("POST", `${table}${qs}`, row);
}

async function exists(table, col, val) {
  const { data } = await sbRequest("GET", `${table}?${col}=eq.${encodeURIComponent(val)}&select=id&limit=1`);
  return Array.isArray(data) && data.length > 0;
}

// ── Text normalization (shared with the Discogs side-mapping) ──────────────────
const norm = s => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// ── iTunes ─────────────────────────────────────────────────────────────────────

// Fetch an album + its tracklist from the iTunes lookup API.
// Returns { albumName, artistName, artworkUrl, year, tracks: [...] } or null.
async function fetchItunesAlbum(collectionId) {
  const url = `https://itunes.apple.com/lookup?id=${encodeURIComponent(collectionId)}&entity=song&limit=200`;
  const { data } = await httpsGet(url);
  const results = data?.results || [];
  if (!results.length) return null;

  const collection = results.find(r => r.wrapperType === "collection") || results[0];
  const songs = results.filter(r => r.wrapperType === "track" && r.kind === "song");
  if (!songs.length) return null;

  // Order by disc then track number — this is the canonical album order and
  // also the order Discogs vinyl positions follow (A1, A2 … B1 …).
  songs.sort((a, b) =>
    (a.discNumber || 1) - (b.discNumber || 1) ||
    (a.trackNumber || 0) - (b.trackNumber || 0));

  const artworkUrl = (collection.artworkUrl100 || songs[0].artworkUrl100 || "")
    .replace("100x100bb", "600x600bb") || null;

  return {
    albumName:  collection.collectionName || "",
    artistName: collection.artistName || songs[0].artistName || "",
    artworkUrl: artworkUrl || null,
    year:       collection.releaseDate ? new Date(collection.releaseDate).getFullYear() : null,
    tracks: songs.map((s, idx) => ({
      itunes_track_id: s.trackId,
      title:           s.trackName,
      track_number:    idx + 1,            // sequential album order
      disc_number:     s.discNumber || 1,
      duration_ms:     s.trackTimeMillis || null,
    })),
  };
}

// ── MusicBrainz ────────────────────────────────────────────────────────────────

// One best-effort lookup per NEW album: MusicBrainz's human-curated sort name
// ("Bowie, David"; "Rolling Stones, The") drives record-shop ordering in the
// library. Returns null on any miss or low-confidence match — clients fall
// back to the plain artist name.
const foldName = s => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s*&\s*/g, " and ").replace(/\s+/g, " ").trim();

async function fetchArtistSortName(artistName) {
  if (!artistName) return null;
  try {
    const q = `artist:"${artistName.replace(/"/g, '\\"')}"`;
    const url = `https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(q)}&fmt=json&limit=1`;
    const { data } = await httpsGet(url, { "User-Agent": "Liri/1.0 +https://getliri.com" });
    const artist = data?.artists?.[0];
    // Score alone lets partial-name hits through ("Tokyo" → "Tokyo Blade"),
    // so the matched name must also equal what we asked for.
    const nameOk = artist && foldName(artist.name) === foldName(artistName);
    return (nameOk && artist.score >= 90 && artist["sort-name"]) ? artist["sort-name"] : null;
  } catch (e) {
    console.warn("[add-to-library] MusicBrainz sort-name lookup failed (non-fatal):", e.message);
    return null;
  }
}

// ── Discogs ─────────────────────────────────────────────────────────────────────

function discogsHeaders() {
  const key    = process.env.DISCOGS_KEY;
  const secret = process.env.DISCOGS_SECRET;
  return {
    "User-Agent": "Liri/1.0 +https://getliri.com",
    ...(key ? { "Authorization": `Discogs key=${key}, secret=${secret}` } : {}),
  };
}

async function fetchDiscogsRelease(releaseId) {
  const url = `https://api.discogs.com/releases/${releaseId}`;
  try {
    const { data } = await httpsGet(url, discogsHeaders());
    return data;
  } catch { return null; }
}

// Search Discogs for a vinyl release matching this album, return its full
// detail (with tracklist+positions) or null. Best-effort — never throws.
function physicalTracklist(detail) {
  return (detail?.tracklist || []).filter(t => t.position && /^[A-Za-z]+\d+/.test(t.position));
}

function layoutSignature(tracks) {
  return tracks.map(t => `${String(t.position).toUpperCase()}:${norm(t.title)}`).join("|");
}

// Match a physical list onto Apple's stable song records. Projection is only
// safe when every physical track has one unique Apple match. It is deliberately
// conservative: combined/split titles and genuinely different editions fall
// back to Apple's list until a human selects the pressing.
function projectPhysicalTracks(itunesTracks, discogsTracks) {
  const used = new Set();
  const projected = [];
  for (const dt of discogsTracks) {
    const wanted = norm(dt.title);
    let idx = itunesTracks.findIndex((t, i) => !used.has(i) && norm(t.title) === wanted);
    if (idx < 0 && wanted.length >= 6) {
      const fuzzy = itunesTracks
        .map((t, i) => ({ i, title: norm(t.title) }))
        .filter(x => !used.has(x.i) && x.title.length >= 6 && (x.title.includes(wanted) || wanted.includes(x.title)));
      if (fuzzy.length === 1) idx = fuzzy[0].i;
    }
    if (idx < 0) return null;
    used.add(idx);
    projected.push({
      ...itunesTracks[idx],
      track_number: projected.length + 1,
      disc_number: 1,
    });
  }
  // A candidate with far fewer tracks is probably a different edition, not a
  // harmless digital extra. Allow only a small number of Apple-only entries.
  if (projected.length < 2 || projected.length / itunesTracks.length < 0.75 || itunesTracks.length - projected.length > 3) return null;
  return projected;
}

async function findDiscogsVinyl(artistName, albumName, itunesTracks = []) {
  try {
    const q = `${artistName} ${albumName}`.trim();
    const searchUrl = `https://api.discogs.com/database/search`
      + `?q=${encodeURIComponent(q)}&type=release&format=Vinyl&per_page=10`;
    const { data } = await httpsGet(searchUrl, discogsHeaders());
    const candidates = data?.results || [];
    if (!candidates.length) return null;

    // Prefer exact album/artist metadata before looking at layouts.
    const nAlbum = norm(albumName);
    const ranked = candidates.sort((a, b) => {
      const am = norm(a.title || "").includes(nAlbum) ? 1 : 0;
      const bm = norm(b.title || "").includes(nAlbum) ? 1 : 0;
      return bm - am;
    });

    const viable = [];
    for (const c of ranked.slice(0, 6)) {
      const detail = await fetchDiscogsRelease(c.id);
      const tracks = physicalTracklist(detail);
      const detailAlbum = norm(detail?.title || "");
      const detailArtist = norm((detail?.artists?.[0]?.name || "").replace(/\s*\(\d+\)$/, ""));
      if (!tracks.length || detailAlbum !== nAlbum || detailArtist !== norm(artistName)) continue;
      const projection = itunesTracks.length ? projectPhysicalTracks(itunesTracks, tracks) : null;
      viable.push({ release: detail, tracks, projection, signature: layoutSignature(tracks) });
    }
    if (!viable.length) return null;

    // Collapse pressings with identical physical layouts. The most commonly
    // represented layout wins; ties favor the one closest to Apple's count.
    const groups = new Map();
    for (const item of viable) {
      const group = groups.get(item.signature) || [];
      group.push(item);
      groups.set(item.signature, group);
    }
    const chosenGroup = [...groups.values()].sort((a, b) =>
      b.length - a.length
      || Math.abs(itunesTracks.length - a[0].tracks.length) - Math.abs(itunesTracks.length - b[0].tracks.length)
    )[0];
    return chosenGroup.find(x => x.projection) || chosenGroup[0];
  } catch (e) {
    console.warn("[add-to-library] Discogs vinyl search failed (non-fatal):", e.message);
    return null;
  }
}

// Parse Discogs "M:SS" duration → milliseconds
function parseDuration(str) {
  if (!str) return null;
  const parts = str.split(":").map(Number);
  if (parts.length === 2 && !parts.some(isNaN)) return (parts[0] * 60 + parts[1]) * 1000;
  return null;
}

// Legacy: Discogs release ID used directly as the collection ID.
const discogsTrackId = (releaseId, idx) => releaseId * 10000 + idx;

// ── Save side/position data by overlaying a Discogs tracklist onto our tracks ──
//
// `tracks` are our saved tracks in album order (each has itunes_track_id).
// `discogsTracks` are the Discogs vinyl tracklist (each has position like "A1").
// If the counts match we zip by index (the common case). Otherwise we try a
// fuzzy title match. Tracks we can't place are reported as missing side info.
// Returns the list of tracks we couldn't place.
async function saveSidesFromDiscogs(collectionId, masterId, tracks, discogsTracks) {
  const unplaced = [];
  const sideOf = pos => (pos || "").replace(/\d.*$/, "").toUpperCase();
  const numOf  = (pos, fallback) => parseInt((pos || "").replace(/^[A-Za-z]+/, "")) || fallback;

  const sameCount = tracks.length === discogsTracks.length;

  await batchedAll(tracks, async (t, i) => {
    let dt = sameCount ? discogsTracks[i] : null;
    if (!dt) {
      // Fuzzy match by title when counts differ.
      dt = discogsTracks.find(d => norm(d.title) === norm(t.title))
        || discogsTracks.find(d => norm(d.title) && (norm(d.title).includes(norm(t.title)) || norm(t.title).includes(norm(d.title))) && norm(t.title).length > 3);
    }
    const side = dt ? sideOf(dt.position) : "";
    if (!side) { unplaced.push(t); return; }
    await upsert("vinyl_sides", {
      itunes_collection_id: collectionId,
      itunes_track_id:    t.itunes_track_id,
      discogs_release_id: masterId?.releaseId || null,
      discogs_master_id:  masterId?.masterId || null,
      side,
      side_track_number:  numOf(dt.position, t.track_number),
      position:           (dt.position || "").toUpperCase(),
      fetched_at:         new Date().toISOString(),
    }, "itunes_track_id");
  }, 5);

  return unplaced;
}

// ── Shared: save tracks + fetch lyrics ─────────────────────────────────────────
async function saveTracksAndLyrics(collectionId, artistName, albumName, tracks, userId, userEmail, discogsReleaseId) {
  await batchedAll(tracks, async (t) => {
    await upsert("album_tracks", {
      itunes_collection_id: collectionId,
      itunes_track_id:  t.itunes_track_id,
      track_name:       t.title,
      artist_name:      artistName,
      track_number:     t.track_number,
      disc_number:      t.disc_number || 1,
      duration_ms:      t.duration_ms,
    }, "itunes_track_id");

    const found = await fetchLyrics(
      t.title, artistName, albumName,
      t.duration_ms ? t.duration_ms / 1000 : null
    );
    if (found) {
      await upsert("track_lyrics", {
        itunes_track_id: t.itunes_track_id,
        lrc_raw:      found.lrc,
        lyrics_plain: found.plain,
        words_json:   found.lrc ? parseLrcToWords(found.lrc) : null,
        source:       found.source,
        fetched_at:   new Date().toISOString(),
      }, "itunes_track_id");
    } else {
      try {
        await sbRequest("POST", "bug_reports", {
          user_id:     userId,
          user_email:  userEmail || null,
          app_version: null,
          platform:    "auto",
          description: `Missing lyrics: "${t.title}" by ${artistName} on ${albumName}`,
          meta: {
            category:            "missing_lyrics",
            source:              "auto",
            requires_app_push:   false,
            itunes_track_id:     t.itunes_track_id,
            itunes_collection_id: collectionId,
            discogs_release_id:  discogsReleaseId || null,
            track_name:          t.title,
            artist_name:         artistName,
            album_name:          albumName,
            duration_ms:         t.duration_ms,
          },
        });
      } catch (e) {
        console.warn("[add-to-library] bug_report insert failed (non-fatal):", e.message);
      }
    }
  }, 3);
}

async function fileMissingSidesBug(userId, userEmail, collectionId, albumName, artistName, totalTracks, unplaced, discogsReleaseId) {
  if (!unplaced.length) return;
  try {
    await sbRequest("POST", "bug_reports", {
      user_id:     userId,
      user_email:  userEmail || null,
      app_version: null,
      platform:    "auto",
      description: `Missing side info on "${albumName}" by ${artistName} (${unplaced.length}/${totalTracks} tracks)`,
      meta: {
        category:             "missing_side_info",
        source:               "auto",
        requires_app_push:    false,
        itunes_collection_id: collectionId,
        discogs_release_id:   discogsReleaseId || null,
        album_name:           albumName,
        artist_name:          artistName,
        total_tracks:         totalTracks,
        missing_count:        unplaced.length,
        missing_track_names:  unplaced.map(t => t.title),
      },
    });
  } catch (e) {
    console.warn("[add-to-library] side-info bug_report insert failed (non-fatal):", e.message);
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  const ALLOWED = ["https://getliri.com", "https://www.getliri.com", "capacitor://localhost"];
  const origin  = req.headers.origin || "";
  res.setHeader("Access-Control-Allow-Origin", ALLOWED.includes(origin) ? origin : "https://getliri.com");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")   return res.status(405).json({ error: "Method not allowed" });

  // ── Auth ──────────────────────────────────────────────────────────────────
  const auth = await verifyAuth(req);
  if (!auth || auth._authError) {
    const reason = auth?._authError || "No auth result";
    console.error("[add-to-library] auth failed:", reason);
    return res.status(401).json({ error: "Session expired — please sign out and back in.", debug: reason });
  }

  const { itunes_collection_id, discogs_release_id } = req.body || {};
  const useItunes = itunes_collection_id != null;
  if (!useItunes && discogs_release_id == null)
    return res.status(400).json({ error: "itunes_collection_id or discogs_release_id required" });

  const collectionId = useItunes ? parseInt(itunes_collection_id, 10) : parseInt(discogs_release_id, 10);
  if (!Number.isFinite(collectionId))
    return res.status(400).json({ error: "Invalid collection id" });

  // ── Free tier limit ────────────────────────────────────────────────────────
  {
    const tier = await getSubscriptionTier(auth.userId);
    if (tier === "free") {
      const { data: everRows } = await sbRequest(
        "GET",
        `user_library_ever?user_id=eq.${encodeURIComponent(auth.userId)}&itunes_collection_id=eq.${collectionId}&select=id&limit=1`
      );
      const wasEverAdded = Array.isArray(everRows) && everRows.length > 0;
      if (!wasEverAdded) {
        const { data: allEverRows } = await sbRequest(
          "GET", `user_library_ever?user_id=eq.${encodeURIComponent(auth.userId)}&select=id`
        );
        const everCount = Array.isArray(allEverRows) ? allEverRows.length : 0;
        if (everCount >= FREE_ALBUM_LIMIT) {
          return res.status(403).json({ error: "free_limit_reached", limit: FREE_ALBUM_LIMIT, count: everCount });
        }
      }
    }
  }

  try {
    const alreadyExists = await exists("catalogue", "itunes_collection_id", collectionId);

    if (!alreadyExists && useItunes) {
      // ── iTunes-primary path (hybrid) ───────────────────────────────────────
      console.log(`[add-to-library] Fetching iTunes album ${collectionId}`);
      const album = await fetchItunesAlbum(collectionId);
      if (!album || !album.tracks.length)
        return res.status(404).json({ error: "Album not found on iTunes" });

      const artistSortName = await fetchArtistSortName(album.artistName);

      // Resolve the physical layout before saving tracks. Only a complete,
      // unique projection is allowed to remove Apple-only digital entries.
      const vinyl = await findDiscogsVinyl(album.artistName, album.albumName, album.tracks);
      const physicalTracks = vinyl?.projection || album.tracks;

      await upsert("catalogue", {
        itunes_collection_id: collectionId,
        album_name:    album.albumName,
        artist_name:   album.artistName,
        artist_sort_name: artistSortName,
        artwork_url:   album.artworkUrl,
        release_year:  album.year,
        track_count:   physicalTracks.length,
        last_synced_at: new Date().toISOString(),
      }, "itunes_collection_id");

      await saveTracksAndLyrics(collectionId, album.artistName, album.albumName, physicalTracks, auth.userId, auth.email, null);

      // ── Enrich with Discogs vinyl side data (best-effort) ──────────────────
      let unplaced = physicalTracks; // assume none placed until proven otherwise
      let discogsReleaseId = null;
      if (vinyl) {
        discogsReleaseId = vinyl.release?.id || null;
        try {
          unplaced = await saveSidesFromDiscogs(
            collectionId,
            { releaseId: discogsReleaseId, masterId: vinyl.release?.master_id || null },
            physicalTracks,
            vinyl.tracks
          );
        } catch (e) {
          console.warn("[add-to-library] vinyl_sides overlay failed (non-fatal):", e.message);
        }
      }
      await fileMissingSidesBug(auth.userId, auth.email, collectionId, album.albumName, album.artistName, physicalTracks.length, unplaced, discogsReleaseId);

    } else if (!alreadyExists) {
      // ── Legacy Discogs-primary path (back-compat) ──────────────────────────
      const releaseId = collectionId;
      console.log(`[add-to-library] Fetching Discogs release ${releaseId}`);

      const release = await fetchDiscogsRelease(releaseId);
      if (!release) return res.status(404).json({ error: "Release not found on Discogs" });

      const artistName = (release.artists?.[0]?.name || "").replace(/\s*\(\d+\)$/, "").trim();
      const albumName  = release.title || "";
      const artworkUrl = release.images?.[0]?.uri || null;

      const rawTracks = (release.tracklist || [])
        .filter(t => t.position && /\d/.test(t.position))
        .map((t, idx) => ({ ...t, _idx: idx }));

      const sides    = [...new Set(rawTracks.map(t => t.position.replace(/\d.*$/, "").toUpperCase()))];
      const sideDisc = Object.fromEntries(sides.map((s, i) => [s, Math.floor(i / 2) + 1]));

      await upsert("catalogue", {
        itunes_collection_id: collectionId,
        album_name:    albumName,
        artist_name:   artistName,
        artist_sort_name: await fetchArtistSortName(artistName),
        artwork_url:   artworkUrl,
        release_year:  release.year || null,
        track_count:   rawTracks.length,
        last_synced_at: new Date().toISOString(),
      }, "itunes_collection_id");

      const tracks = rawTracks.map(t => ({
        itunes_track_id: discogsTrackId(releaseId, t._idx),
        title:           t.title,
        track_number:    t._idx + 1,
        disc_number:     sideDisc[t.position.replace(/\d.*$/, "").toUpperCase()] || 1,
        duration_ms:     parseDuration(t.duration),
        _position:       t.position,
      }));

      await saveTracksAndLyrics(collectionId, artistName, albumName, tracks, auth.userId, auth.email, releaseId);

      // Sides come straight from the Discogs positions we already have.
      const unplaced = [];
      try {
        await batchedAll(tracks, (t) => {
          const sidePrefix = (t._position || "").replace(/\d.*$/, "").toUpperCase();
          if (!sidePrefix) { unplaced.push(t); return Promise.resolve(); }
          const side_track_number = parseInt(t._position.replace(/^[A-Za-z]+/, "")) || t.track_number;
          return upsert("vinyl_sides", {
            itunes_collection_id: collectionId,
            itunes_track_id:    t.itunes_track_id,
            discogs_release_id: releaseId,
            discogs_master_id:  release.master_id || null,
            side:               sidePrefix,
            side_track_number,
            position:           t._position.toUpperCase(),
            fetched_at:         new Date().toISOString(),
          }, "itunes_track_id");
        }, 5);
      } catch (e) {
        console.warn("[add-to-library] vinyl_sides failed (non-fatal):", e.message);
        unplaced.push(...tracks);
      }
      await fileMissingSidesBug(auth.userId, auth.email, collectionId, albumName, artistName, tracks.length, unplaced, releaseId);

    } else {
      console.log(`[add-to-library] Collection ${collectionId} already in DB — skipping fetch`);
    }

    // ── Link user → album ────────────────────────────────────────────────────
    await upsert("user_library", {
      user_id:              auth.userId,
      itunes_collection_id: collectionId,
      added_at:             new Date().toISOString(),
    }, "user_id,itunes_collection_id");

    await upsert("user_library_ever", {
      user_id:              auth.userId,
      itunes_collection_id: collectionId,
      first_added_at:       new Date().toISOString(),
    }, "user_id,itunes_collection_id");

    return res.status(200).json({ success: true, cached: alreadyExists });

  } catch (e) {
    console.error("[add-to-library] error:", e.message);
    return res.status(500).json({ error: "Failed to add album. Please try again." });
  }
};
