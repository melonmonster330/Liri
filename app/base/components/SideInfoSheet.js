// <SideInfoSheet tracks={...} initialBreaks={...} onSave={letters => ...} onClose={...} />
//
// Bottom sheet for marking which tracks are on which vinyl side. Uses a
// "new side starts here" model: the user taps the track that opens each
// side (track 1 is always the start of side A). Side letters are assigned
// sequentially from the breaks, so the result is monotonic by construction —
// required, because vinyl_sides rows are matched to tracks positionally
// after sorting A1…B1… (a non-monotonic assignment would scramble tracks).
//
// Props:
//   tracks        — [{ trackId, trackName, durationMs? }] in album order
//   initialBreaks — array of track indexes that start a new side (optional;
//                   defaults to a midpoint A/B split)
//   saving        — bool
//   error         — string | null
//   onSave        — (letters: string[]) => void, one letter per track
//   onClose       — () => void

const { useState } = React;

const e = React.createElement;

function lettersFromBreaks(count, breakSet) {
  const out = [];
  let side = 0;
  for (let i = 0; i < count; i++) {
    if (i > 0 && breakSet.has(i)) side++;
    out.push(String.fromCharCode(65 + side));
  }
  return out;
}

export function SideInfoSheet({ tracks, initialBreaks, saving, error, onSave, onClose }) {
  const [breaks, setBreaks] = useState(() => {
    if (initialBreaks?.length) return new Set(initialBreaks.filter(i => i > 0));
    return new Set([Math.ceil((tracks?.length || 0) / 2)]); // default midpoint A/B
  });

  const letters = lettersFromBreaks(tracks?.length || 0, breaks);

  const toggleBreak = i => {
    if (i === 0) return; // track 1 always starts side A
    setBreaks(prev => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  };

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
      e("div", { style: { flex: 1, paddingRight: 12 } },
        e("div", { style: { fontSize: 17, fontWeight: 700, color: "#f0e6d3" } }, "Add side info"),
        e("div", { style: { fontSize: 12, color: "rgba(255,255,255,0.4)", marginTop: 3, lineHeight: 1.5 } },
          "Tap the first track of each side. Check your record sleeve or the disc labels.")),
      e("button", {
        onClick: onClose,
        style: { background: "rgba(255,255,255,0.07)", border: "none", color: "rgba(255,255,255,0.5)", width: 30, height: 30, borderRadius: "50%", cursor: "pointer", fontFamily: "inherit", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }
      }, e("svg", { width: "12", height: "12", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2.5", strokeLinecap: "round" },
        e("line", { x1: "18", y1: "6", x2: "6", y2: "18" }), e("line", { x1: "6", y1: "6", x2: "18", y2: "18" })))),
    e("div", {
      style: { overflowY: "auto", flex: 1, minHeight: 0, padding: "8px 24px 32px", WebkitOverflowScrolling: "touch" }
    },
      (tracks || []).map((t, i) => {
        const startsSide = i === 0 || breaks.has(i);
        return e(React.Fragment, { key: t.trackId || i },
          startsSide && e("div", {
            style: { padding: "16px 0 6px", fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", color: "rgba(212,168,70,0.75)", textTransform: "uppercase" }
          }, "Side " + letters[i]),
          e("button", {
            onClick: () => toggleBreak(i),
            style: {
              width: "100%", display: "flex", alignItems: "center", gap: 12,
              padding: "11px 2px", background: "none", border: "none",
              borderBottom: "1px solid rgba(255,255,255,0.04)",
              cursor: i === 0 ? "default" : "pointer", textAlign: "left", fontFamily: "inherit",
            }
          },
            e("div", { style: { width: 28, fontSize: 12, fontWeight: 700, color: "rgba(212,168,70,0.65)", flexShrink: 0 } },
              letters[i] + (letters.slice(0, i + 1).filter(l => l === letters[i]).length)),
            e("div", { style: { flex: 1, minWidth: 0, fontSize: 14, color: "#f0e6d3", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
              t.trackName),
            i > 0 && e("div", {
              style: {
                fontSize: 10, fontWeight: 600, flexShrink: 0, borderRadius: 50, padding: "4px 10px",
                background: breaks.has(i) ? "rgba(212,168,70,0.15)" : "rgba(255,255,255,0.04)",
                border: breaks.has(i) ? "1px solid rgba(212,168,70,0.4)" : "1px solid rgba(255,255,255,0.08)",
                color: breaks.has(i) ? "rgba(212,168,70,0.9)" : "rgba(255,255,255,0.3)",
              }
            }, breaks.has(i) ? "starts side " + letters[i] : "same side")));
      })),
    e("div", { style: { padding: "12px 24px max(24px, env(safe-area-inset-bottom))", borderTop: "1px solid rgba(255,255,255,0.06)" } },
      error && e("div", { style: { color: "#c9807a", fontSize: 12, marginBottom: 8 } }, String(error)),
      e("button", {
        onClick: () => !saving && onSave(letters),
        disabled: saving,
        style: {
          width: "100%",
          background: saving ? "rgba(255,255,255,0.08)" : "linear-gradient(135deg, #d4a846, #c9807a)",
          color: saving ? "rgba(255,255,255,0.3)" : "#080810",
          border: "none", borderRadius: 50, padding: "15px 0",
          fontSize: 14, fontWeight: 700, letterSpacing: "0.5px",
          cursor: saving ? "default" : "pointer", fontFamily: "inherit",
        }
      }, saving ? "Saving…" : "Save side info"))));
}
