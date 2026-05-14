// Whisper chunk recorder.
//
// Shared by initial listen, resync, and any future listening entry points.
// Opens a recording loop on `stream`, sends each chunk to Whisper, calls
// onText(text, chunkEndTime) for every non-empty result.
//
//   startWhisperChunks(stream, onText, chunkMs, prompt?) → { stop() }
//
// Two code paths because the iOS WebView and desktop browsers produce
// MediaRecorder output that needs to be handled differently:
//
// iOS path:
//   iOS MediaRecorder emits fragmented MP4 (fMP4). Only the FIRST chunk
//   carries the codec init data (moov box). Subsequent chunks are raw
//   moof+mdat — Whisper can't decode them standalone and hallucinates
//   instead of transcribing. Workaround: keep one recorder running and
//   accumulate every chunk into a growing blob, sending the full blob
//   (init + all media) on each interval. Always a valid decodable MP4.
//
// Web path:
//   WebM is self-contained per chunk, so we use a series of short
//   independent recorders (cheap, and we get real chunk boundaries).

const WHISPER_PROXY = window.Capacitor
  ? "https://www.getliri.com/api/whisper"
  : "/api/whisper";

export function startWhisperChunks(stream, onText, chunkMs, prompt) {
  let active = true;

  // ── iOS path ────────────────────────────────────────────────────────────────
  if (window.Capacitor) {
    const iosChunks = [];
    const recorder = new MediaRecorder(stream);
    recorder.ondataavailable = async (e) => {
      if (!active || e.data.size < 500) return;
      iosChunks.push(e.data);
      const fullBlob = new Blob(iosChunks, { type: e.data.type || "audio/mp4" });
      const chunkEndTime = Date.now();
      try {
        const base64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload  = () => resolve(reader.result.split(",")[1]);
          reader.onerror = reject;
          reader.readAsDataURL(fullBlob);
        });
        const res = await fetch(WHISPER_PROXY, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ audio: base64, mimeType: fullBlob.type || "audio/mp4", ...(prompt ? { prompt } : {}) }),
        });
        if (!res.ok || !active) return;
        const { text } = await res.json();
        onText(text, chunkEndTime);
      } catch (err) { console.error("[whisper] chunk error:", err); }
    };
    recorder.start(chunkMs); // timeslice — ondataavailable fires every chunkMs
    const stop = () => {
      active = false;
      try { recorder.stop(); } catch {}
      stream.getTracks().forEach(t => t.stop());
    };
    return { stop };
  }

  // ── Web path ────────────────────────────────────────────────────────────────
  const mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/mp4";
  let currentRecorder = null;
  const stop = () => {
    active = false;
    try { currentRecorder?.stop(); } catch {}
    stream.getTracks().forEach(t => t.stop());
  };
  const recordChunk = () => {
    if (!active) return;
    const recorder = new MediaRecorder(stream, { mimeType });
    currentRecorder = recorder;
    recorder.ondataavailable = async (e) => {
      if (e.data.size < 500 || !active) return;
      const chunkEndTime = Date.now();
      try {
        const base64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload  = () => resolve(reader.result.split(",")[1]);
          reader.onerror = reject;
          reader.readAsDataURL(e.data);
        });
        const res = await fetch(WHISPER_PROXY, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ audio: base64, mimeType: e.data.type || mimeType, ...(prompt ? { prompt } : {}) }),
        });
        if (!res.ok || !active) return;
        const { text } = await res.json();
        onText(text, chunkEndTime);
      } catch (err) { console.error("[whisper] chunk error:", err); }
    };
    recorder.start();
    setTimeout(() => {
      if (recorder.state === "recording") recorder.stop();
      recordChunk();
    }, chunkMs);
  };
  recordChunk();
  return { stop };
}
