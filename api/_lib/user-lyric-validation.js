const { lrcToPlain } = require("./lyrics");

const compact = text => (text || "").replace(/\r/g, "").trim();
const signature = text => compact(text).toLowerCase().replace(/\s+/g, " ");

function validateUserLyricSubmission(row, durationMs) {
  const rawLrc = compact(row.lrc_raw);
  const rawPlain = compact(row.lyrics_plain);
  if (!rawLrc && !rawPlain) return { ok: false, reason: "empty submission" };
  const combined = rawLrc || rawPlain;
  if (/<(?:html|script|body|div|iframe)\b/i.test(combined) || /https?:\/\//i.test(combined)) {
    return { ok: false, reason: "contains webpage markup or links" };
  }

  if (rawLrc) {
    const timed = [];
    const re = /^\s*\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\](.*)$/;
    for (const line of rawLrc.split("\n")) {
      const m = line.match(re);
      if (!m || !m[4].trim()) continue;
      const fraction = (m[3] || "0").padEnd(3, "0").slice(0, 3);
      const time = Number(m[1]) * 60 + Number(m[2]) + Number(fraction) / 1000;
      timed.push({ time, text: m[4].trim() });
    }
    if (timed.length < 4) return { ok: false, reason: "fewer than four timed lines" };
    if (timed.some((line, i) => i > 0 && line.time < timed[i - 1].time)) {
      return { ok: false, reason: "timestamps are out of order" };
    }
    const durationS = Number(durationMs || 0) / 1000;
    if (durationS && timed[timed.length - 1].time > durationS + 15) {
      return { ok: false, reason: "timestamps overrun track duration" };
    }
    const normalized = timed.map(line => {
      const mins = Math.floor(line.time / 60);
      const secs = (line.time - mins * 60).toFixed(3).padStart(6, "0");
      return `[${String(mins).padStart(2, "0")}:${secs}]${line.text}`;
    }).join("\n");
    const plain = lrcToPlain(normalized);
    return { ok: true, lrc: normalized, plain, signature: signature(plain) };
  }

  const lines = rawPlain.split("\n").map(s => s.trim()).filter(Boolean);
  if (lines.length < 4 || rawPlain.length < 80) {
    return { ok: false, reason: "plain lyrics are too short to validate" };
  }
  const plain = lines.join("\n");
  return { ok: true, lrc: null, plain, signature: signature(plain) };
}

module.exports = { validateUserLyricSubmission, signature };
