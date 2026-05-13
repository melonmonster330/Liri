// <WaveAnimation active analyserRef={...} level={...} size={1} />
//
// Frequency-domain visualiser.
// • When analyserRef.current is set: reads live frequency bins via rAF (60fps).
// • Falls back to chunk-size history stagger when no analyser (iOS fallback).
// • Falls back to idle sine when no audio at all.
//
// Updates DOM directly via refs — no setState in the rAF loop.

const { useRef, useEffect } = React;

const BAR_MULTS = [0.55, 0.85, 1.0, 0.75, 0.95, 0.65, 0.90, 0.70, 1.0, 0.60, 0.80, 0.50];

export function WaveAnimation({ active, size = 1, analyserRef, level }) {
  const barRefs   = useRef([]);
  const rafRef    = useRef(null);
  const smoothRef = useRef(new Float32Array(BAR_MULTS.length));
  const histRef   = useRef([]); // { t, v } for chunk-size fallback

  // Build timestamped history from chunk-size level prop (fallback path)
  useEffect(() => {
    if (!level || level <= 0) { histRef.current = []; return; }
    const now = Date.now();
    histRef.current.push({ t: now, v: level });
    histRef.current = histRef.current.filter(e => now - e.t < 3000);
  }, [level]);

  useEffect(() => {
    if (!active) { cancelAnimationFrame(rafRef.current); return; }

    let freqBuf = null;
    let smoothedEnergy = 0; // single smoothed energy value driving wave amplitude
    const n = BAR_MULTS.length;

    const tick = () => {
      const an = analyserRef?.current;
      const now = Date.now();

      if (an) {
        // ── Energy-driven traveling wave (AnalyserNode) ─────────────────────
        // Rather than mapping each bar to its own frequency bin (which causes
        // block-jitter on beats), we compute ONE smoothed energy value from
        // all bass/kick bins and use it as the amplitude of a sine wave that
        // ripples across the bars. Result: a smooth wave whose height pulses
        // with the beat.
        if (!freqBuf || freqBuf.length !== an.frequencyBinCount) {
          freqBuf = new Uint8Array(an.frequencyBinCount);
        }
        an.getByteFrequencyData(freqBuf);
        // Sum bass+kick bins (~43–600Hz at fftSize=1024) into one energy value
        const firstBin = 1, lastBin = Math.min(freqBuf.length - 2, 14);
        let sum = 0;
        for (let b = firstBin; b <= lastBin; b++) sum += freqBuf[b];
        const rawEnergy = sum / ((lastBin - firstBin + 1) * 255);
        // Smooth energy: fast attack on beat hits, slow release so wave stays alive
        smoothedEnergy += rawEnergy > smoothedEnergy
          ? (rawEnergy - smoothedEnergy) * 0.3   // quick beat hit
          : (rawEnergy - smoothedEnergy) * 0.05; // slow, graceful decay
        // Traveling sine — each bar has a phase offset so motion ripples left→right
        const t = now * 0.0022;
        BAR_MULTS.forEach((mult, i) => {
          const phase = (i / (n - 1)) * Math.PI * 2.4;
          const wave = (Math.sin(t + phase) + 1) / 2; // 0–1
          const base = Math.max(0.07, smoothedEnergy);
          const target = base * 0.45 + wave * base * 0.9 * mult;
          const prev = smoothRef.current[i];
          smoothRef.current[i] = prev + (target - prev) * 0.09; // gentle per-bar smoothing
          const h = Math.max(3, smoothRef.current[i] * 68) * size;
          if (barRefs.current[i]) barRefs.current[i].style.height = h + "px";
        });
      } else if (histRef.current.length > 0) {
        // ── Chunk-size fallback (no stagger — all bars react to current level) ──
        const v = histRef.current[histRef.current.length - 1]?.v || 0;
        BAR_MULTS.forEach((mult, i) => {
          const prev = smoothRef.current[i];
          smoothRef.current[i] = v > prev ? prev + (v - prev) * 0.45 : prev * 0.92;
          const h = Math.max(4, Math.pow(smoothRef.current[i], 0.38) * 58 * mult) * size;
          if (barRefs.current[i]) barRefs.current[i].style.height = h + "px";
        });
      } else {
        // ── Idle sine — bars have staggered phases so they move independently ─
        const t = now * 0.001;
        BAR_MULTS.forEach((mult, i) => {
          const sinVal = (Math.sin(t * (1.8 + i * 0.18) + i * 0.72) + 1) / 2;
          const h = Math.max(3, 48 * 0.55 * mult * (0.45 + 0.55 * sinVal)) * size;
          if (barRefs.current[i]) barRefs.current[i].style.height = h + "px";
        });
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [active]);

  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: `${4 * size}px`,
      alignItems: "center",
      height: `${52 * size}px`,
      justifyContent: "center"
    }
  }, BAR_MULTS.map((mult, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    ref: el => barRefs.current[i] = el,
    style: {
      width: `${3 * size}px`,
      borderRadius: "2px",
      background: "linear-gradient(to top, #d4a846, #c9807a)",
      height: `${3 * size}px`,
      opacity: active ? 1 : 0.3
    }
  })));
}
