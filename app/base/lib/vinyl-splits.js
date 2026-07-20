// Curated exceptions where a digital service combines songs that are separate
// physical tracks on vinyl. Keep these explicit: guessing from punctuation
// alone could incorrectly split intentional medleys on other records.
const SPLITS = {
  "1429663168": {
    parts: [
      {
        trackId: 1429663168,
        title: "Hard Feelings",
        durationMs: 234000,
        side: "A",
        sideTrackNumber: 6,
        position: "A6",
        lyricStartSeconds: 0,
        lyricEndSeconds: 234,
      },
      {
        // Stable synthetic ID used only inside Liri's playback model.
        trackId: 1429663168001,
        title: "Loveless",
        durationMs: 133391,
        side: "B",
        sideTrackNumber: 1,
        position: "B1",
        lyricStartSeconds: 234,
        lyricEndSeconds: null,
      },
    ],
  },
};

const formatLrcTime = seconds => {
  const mins = Math.floor(seconds / 60);
  const secs = (seconds - mins * 60).toFixed(3).padStart(6, "0");
  return `${String(mins).padStart(2, "0")}:${secs}`;
};

const sliceLrc = (lrc, start, end) => (lrc || "").split("\n").flatMap(line => {
  const m = line.match(/^\[(\d{2}):(\d{2})[.:](\d{2,3})\](.*)$/);
  if (!m) return [];
  const time = Number(m[1]) * 60 + Number(m[2])
    + Number(m[3].padEnd(3, "0").slice(0, 3)) / 1000;
  if (time < start || (end != null && time >= end)) return [];
  return [`[${formatLrcTime(Math.max(0, time - start))}]${m[4]}`];
}).join("\n");

const lrcToPlain = lrc => (lrc || "").split("\n")
  .map(line => line.replace(/^\[\d{2}:\d{2}[.:]\d{2,3}\]/, "").trim())
  .filter(Boolean)
  .join("\n");

export function expandKnownVinylSplitTracks(trackRows) {
  const expanded = [];
  for (const row of trackRows || []) {
    const split = SPLITS[String(row.itunes_track_id)];
    if (!split) {
      expanded.push(row);
      continue;
    }
    split.parts.forEach(part => expanded.push({
      ...row,
      itunes_track_id: part.trackId,
      track_name: part.title,
      duration_ms: part.durationMs,
      _vinylSplitSourceId: row.itunes_track_id,
      _vinylSplitPart: part,
    }));
  }
  return expanded.map((row, i) => ({ ...row, track_number: i + 1 }));
}

export function expandKnownVinylSplitLyrics(cache, expandedRows) {
  const sourceCache = { ...(cache || {}) };
  const next = { ...(cache || {}) };
  for (const row of expandedRows || []) {
    const part = row._vinylSplitPart;
    if (!part) continue;
    const source = sourceCache[String(row._vinylSplitSourceId)];
    if (!source) continue;
    const lrc = sliceLrc(source.lrc_raw, part.lyricStartSeconds, part.lyricEndSeconds);
    const words = Array.isArray(source.words_json)
      ? source.words_json
          .filter(w => w.start_ms >= part.lyricStartSeconds * 1000
            && (part.lyricEndSeconds == null || w.start_ms < part.lyricEndSeconds * 1000))
          .map(w => ({ ...w, start_ms: Math.max(0, w.start_ms - part.lyricStartSeconds * 1000) }))
      : null;
    next[String(row.itunes_track_id)] = {
      lrc_raw: lrc || null,
      words_json: words,
      lyrics_plain: lrc ? lrcToPlain(lrc) : source.lyrics_plain,
    };
  }
  return next;
}

export function reconcileKnownVinylSplitSides(originalRows, sideRows) {
  const reconciled = [];
  (originalRows || []).forEach((row, i) => {
    const split = SPLITS[String(row.itunes_track_id)];
    if (!split) {
      reconciled.push(sideRows?.[i] || null);
      return;
    }
    split.parts.forEach(part => reconciled.push({
      side: part.side,
      side_track_number: part.sideTrackNumber,
      position: part.position,
    }));
  });
  return reconciled;
}
