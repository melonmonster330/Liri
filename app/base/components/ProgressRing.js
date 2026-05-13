// <ProgressRing size={96} />
//
// Self-animating circular progress ring — fills clockwise over a 30s loop.
// No external progress prop; uses an internal setInterval so callers don't
// need to drive it. Used as the "listening" indicator on iOS while Shazam
// is matching.

const { useState, useEffect } = React;

export function ProgressRing({ size = 96 }) {
  const r    = size / 2 - 5;
  const circ = 2 * Math.PI * r;

  const [t, setT] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const id = setInterval(() => setT(((Date.now() - start) % 30000) / 30000), 50);
    return () => clearInterval(id);
  }, []);

  return /*#__PURE__*/React.createElement("svg", {
    width: size,
    height: size,
    style: { transform: "rotate(-90deg)" }
  },
    /*#__PURE__*/React.createElement("circle", {
      cx: size / 2, cy: size / 2, r,
      fill: "none",
      stroke: "rgba(255,255,255,0.06)",
      strokeWidth: "3"
    }),
    /*#__PURE__*/React.createElement("circle", {
      cx: size / 2, cy: size / 2, r,
      fill: "none",
      strokeWidth: "3",
      strokeLinecap: "round",
      stroke: "url(#pg2)",
      strokeDasharray: `${circ * t} ${circ}`
    }),
    /*#__PURE__*/React.createElement("defs", null,
      /*#__PURE__*/React.createElement("linearGradient", {
        id: "pg2", x1: "0%", y1: "0%", x2: "100%", y2: "0%"
      },
        /*#__PURE__*/React.createElement("stop", { offset: "0%",   stopColor: "#d4a846" }),
        /*#__PURE__*/React.createElement("stop", { offset: "100%", stopColor: "#e8a0a8" })
      )
    )
  );
}
