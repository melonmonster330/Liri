// <Vinyl size={120} spinning={false} />
// Stylised vinyl record SVG — purely decorative, no state.
// Used as the album-cover placeholder when artwork is missing or loading.

export function Vinyl({ size = 120, spinning = false }) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      width: size,
      height: size,
      margin: "0 auto",
      animation: spinning ? "vinyl-spin 2s linear infinite" : "none",
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 100 100",
    style: { width: "100%", height: "100%" }
  }, /*#__PURE__*/React.createElement("defs", null, /*#__PURE__*/React.createElement("radialGradient", {
    id: "vg2", cx: "50%", cy: "50%", r: "50%"
  }, /*#__PURE__*/React.createElement("stop", { offset: "0%",   stopColor: "#1e1828" }),
     /*#__PURE__*/React.createElement("stop", { offset: "70%",  stopColor: "#0a0812" }),
     /*#__PURE__*/React.createElement("stop", { offset: "100%", stopColor: "#050508" }))),
  /*#__PURE__*/React.createElement("circle", { cx: "50", cy: "50", r: "49", fill: "url(#vg2)" }),
  [46, 42, 38, 34, 30, 26, 22].map((r, i) => /*#__PURE__*/React.createElement("circle", {
    key: i, cx: "50", cy: "50", r, fill: "none",
    stroke: "rgba(255,255,255,0.04)", strokeWidth: "0.8"
  })),
  /*#__PURE__*/React.createElement("circle", { cx: "50", cy: "50", r: "10",  fill: "#d4a846", opacity: "0.85" }),
  /*#__PURE__*/React.createElement("circle", { cx: "50", cy: "50", r: "3.5", fill: "#080810" })));
}
