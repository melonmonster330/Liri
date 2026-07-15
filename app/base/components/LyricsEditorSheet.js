// <LyricsEditorSheet track={...} onSave={text => ...} onClose={...} />
//
// Bottom sheet for pasting lyrics when Liri has none for a track. Accepts
// plain text or LRC (auto-detected by the caller via looksLikeLRC). Shows
// homepage links to lyric sites — homepages only, the user searches there
// themselves. Caller owns the actual DB write; this sheet is pure UI.
//
// Props:
//   track   — { trackName, artistName } (display only)
//   sites   — LYRIC_SITES from base/lib/usermeta.js
//   saving  — bool, disables the save button
//   error   — string | null, shown under the textarea
//   onSave  — (text) => void
//   onClose — () => void

const { useState } = React;

const e = React.createElement;

export function LyricsEditorSheet({ track, sites, saving, error, onSave, onClose }) {
  const [text, setText] = useState("");

  const openSite = url => window.open(url, window.Capacitor ? "_system" : "_blank");

  return e("div", {
    onClick: onClose,
    style: {
      position: "fixed", inset: 0, zIndex: 650,
      background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)",
      // Flex column pinning the sheet to the bottom — gives the scroll child
      // a real bounded height on iOS (absolute panels don't scroll there).
      display: "flex", flexDirection: "column", justifyContent: "flex-end",
    }
  }, e("div", {
    onClick: ev => ev.stopPropagation(),
    style: {
      width: "100%", background: "#0f0f1c", borderRadius: "24px 24px 0 0",
      maxHeight: "85vh", overflow: "hidden", display: "flex", flexDirection: "column",
      minHeight: 0, boxShadow: "0 -8px 48px rgba(0,0,0,0.6)", animation: "slide-up 0.3s ease",
    }
  },
    e("div", { style: { display: "flex", justifyContent: "center", padding: "12px 0 4px" } },
      e("div", { style: { width: 36, height: 4, borderRadius: 2, background: "rgba(255,255,255,0.12)" } })),
    e("div", { style: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", padding: "10px 24px 4px" } },
      e("div", { style: { flex: 1, minWidth: 0, paddingRight: 12 } },
        e("div", { style: { fontSize: 17, fontWeight: 700, color: "#f0e6d3" } }, "Add lyrics"),
        e("div", { style: { fontSize: 12, color: "rgba(255,255,255,0.4)", marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
          track?.trackName, track?.artistName ? " · " + track.artistName : "")),
      e("button", {
        onClick: onClose,
        style: { background: "rgba(255,255,255,0.07)", border: "none", color: "rgba(255,255,255,0.5)", width: 30, height: 30, borderRadius: "50%", cursor: "pointer", fontFamily: "inherit", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }
      }, e("svg", { width: "12", height: "12", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2.5", strokeLinecap: "round" },
        e("line", { x1: "18", y1: "6", x2: "6", y2: "18" }), e("line", { x1: "6", y1: "6", x2: "18", y2: "18" })))),
    e("div", {
      style: { overflowY: "auto", flex: 1, minHeight: 0, padding: "8px 24px", WebkitOverflowScrolling: "touch", paddingBottom: "max(24px, env(safe-area-inset-bottom))" }
    },
      e("div", { style: { fontSize: 12, color: "rgba(255,255,255,0.45)", lineHeight: 1.6, marginBottom: 10 } },
        "Search one of these sites for the song, then paste the lyrics below. Timestamped LRC lines (e.g. [00:12.34]) sync automatically; plain text scrolls at reading speed."),
      e("div", { style: { display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 } },
        (sites || []).map(s => e("button", {
          key: s.name,
          onClick: () => openSite(s.url),
          style: {
            background: "rgba(212,168,70,0.08)", border: "1px solid rgba(212,168,70,0.25)",
            color: "rgba(212,168,70,0.9)", borderRadius: 50, padding: "7px 14px",
            fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
          }
        }, s.name, " ↗"))),
      e("textarea", {
        value: text,
        onChange: ev => setText(ev.target.value),
        placeholder: "Paste lyrics here…",
        rows: 10,
        style: {
          width: "100%", boxSizing: "border-box", background: "rgba(255,255,255,0.04)",
          border: "1px solid rgba(255,255,255,0.1)", borderRadius: 14, color: "#f0e6d3",
          fontFamily: "inherit", fontSize: 14, lineHeight: 1.6, padding: "12px 14px",
          resize: "vertical", minHeight: 160, outline: "none",
        }
      }),
      error && e("div", { style: { color: "#c9807a", fontSize: 12, marginTop: 8 } }, String(error)),
      e("button", {
        onClick: () => !saving && text.trim() && onSave(text),
        disabled: saving || !text.trim(),
        style: {
          width: "100%", marginTop: 14,
          background: text.trim() && !saving ? "linear-gradient(135deg, #d4a846, #c9807a)" : "rgba(255,255,255,0.08)",
          color: text.trim() && !saving ? "#080810" : "rgba(255,255,255,0.3)",
          border: "none", borderRadius: 50, padding: "15px 0",
          fontSize: 14, fontWeight: 700, letterSpacing: "0.5px",
          cursor: text.trim() && !saving ? "pointer" : "default", fontFamily: "inherit",
        }
      }, saving ? "Saving…" : "Save lyrics"))));
}
