// Analytics + social auto-post loggers — no React. `sb` (Supabase client) and
// any per-session/ref state the component owns are passed in explicitly so
// these stay pure and testable in isolation. None of these ever throw —
// analytics/social must never block or break playback.

// ── Analytics: log a song play to listening_events ──
// Called for both manual recognitions and vinyl auto-advances.
export async function logListeningEvent(sb, sessionId, params) {
  try {
    await sb.from("listening_events").insert({
      user_id: params.userId || null,
      session_id: sessionId,
      track_title: params.title,
      artist_name: params.artist,
      album_name: params.album || null,
      artwork_url: params.artwork || null,
      genre: params.genre || null,
      itunes_track_id: params.itunesTrackId ? Number(params.itunesTrackId) : null,
      itunes_collection_id: params.collectionId ? Number(params.collectionId) : null,
      vinyl_release_id: params.vinylReleaseId || null,
      vinyl_mode_on: params.vinylModeOn ?? false,
      source: params.source || "recognition",
      platform: window.Capacitor ? "ios" : "web",
      country_code: params.countryCode || null,
      playback_offset_s: params.offsetSecs != null ? Math.round(params.offsetSecs) : null,
      track_duration_s: params.durationSecs != null ? Math.round(params.durationSecs) : null,
      acr_confidence: params.acrScore || null
    });
  } catch (e) {
    console.error("logListeningEvent failed:", e.message);
  }
}

// ── Social: auto-post the record you're spinning (if the user opted in) ──
// Posts ONE album post per record per listening session — never per track —
// so auto-advancing through a side doesn't spam the feed. Cross-session spam
// is guarded by a 12h DB check.
// autoPostVisRef: ref holding the user's auto_post_visibility ("off"|"private"|"friends"|"public")
// autoPostedAlbumsRef: ref holding a Set of collection_ids already auto-posted this session
export async function maybeAutoPostPlay(sb, autoPostVisRef, autoPostedAlbumsRef, { userId, collectionId, album, artist, artwork }) {
  try {
    const vis = autoPostVisRef.current;
    if (!userId || vis === "off") return;
    if (!collectionId) return;
    const key = String(collectionId);
    if (autoPostedAlbumsRef.current.has(key)) return; // already posted this session
    autoPostedAlbumsRef.current.add(key);

    // Cross-session dedup: skip if we auto-posted this album in the last 12h.
    const since = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    const { data: recent } = await sb.from("posts")
      .select("id")
      .eq("author_id", userId)
      .eq("collection_id", Number(collectionId))
      .eq("source", "auto")
      .gte("created_at", since)
      .limit(1);
    if (recent && recent.length) return;

    await sb.from("posts").insert({
      author_id: userId,
      kind: "album",
      source: "auto",
      visibility: vis,
      collection_id: Number(collectionId),
      album_name: album || null,
      artist_name: artist || null,
      artwork_url: artwork || null,
    });
  } catch (e) {
    console.error("maybeAutoPostPlay failed:", e.message);
  }
}

// ── Analytics: log a vinyl side flip to flip_events ──
export async function logFlipEvent(sb, sessionId, params) {
  try {
    await sb.from("flip_events").insert({
      user_id: params.userId || null,
      session_id: sessionId,
      vinyl_release_id: params.vinylReleaseId || null,
      itunes_collection_id: params.collectionId ? Number(params.collectionId) : null,
      album_name: params.album || null,
      artist_name: params.artist || null,
      from_side: params.fromSide || null,
      to_side: params.toSide || null,
      detection_method: params.method || "heuristic"
    });
  } catch (e) {
    console.error("logFlipEvent failed:", e.message);
  }
}

// ── Analytics: log a button tap (resync / wrong_song) to button_events ──
// ctx: { sessionId, user, detectedSong, albumCollectionIdRef, lastRawMatchRef }
export async function logButtonEvent(sb, ctx, buttonName) {
  const { sessionId, user, detectedSong, albumCollectionIdRef, lastRawMatchRef } = ctx;
  try {
    const raw = lastRawMatchRef.current;
    await sb.from("button_events").insert({
      user_id: user?.id || null,
      session_id: sessionId,
      button_name: buttonName,
      track_title: detectedSong?.title || null,
      artist_name: detectedSong?.artist || null,
      album_name: detectedSong?.album || null,
      itunes_collection_id: albumCollectionIdRef?.current ? Number(albumCollectionIdRef.current) : null,
      platform: window.Capacitor ? "ios" : "web",
      identified_by: raw?.identified_by || null,
      raw_match_title: raw?.title || null,
      raw_match_artist: raw?.artist || null,
    });
  } catch (e) { /* silently ignore — table may not exist yet */ }
}
