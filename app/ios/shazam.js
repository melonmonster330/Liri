// JS bridge to the native ShazamPlugin (ios/App/CapApp-SPM/Sources/CapApp-SPM/ShazamPlugin.swift).
//
// Why nativePromise instead of Capacitor.Plugins?
// The plugin is registered by the native iOS runtime, but @capacitor/core's
// JS wrapper (registerPlugin) requires the @capacitor/core bundle, which this
// app doesn't load. nativePromise is the low-level bridge that IS available.
//
// Lazy getter: window.Capacitor isn't ready at module-load time on iOS — the
// bridge is injected after the JS parses — so we re-check on every call.
//
// Methods:
//   findMatch({ timeout })       → { matched, title, artist, offset, matchTime } | { matched: false }
//   waitForSilence({ timeout })  → { silence: bool }
//   cancel()                     → void

function getPlugin() {
  const np = window.Capacitor?.nativePromise;
  if (!np) return null;
  return {
    findMatch:      (opts) => np("ShazamPlugin", "findMatch",      opts || {}),
    cancel:         ()     => np("ShazamPlugin", "cancel",         {}),
    waitForSilence: (opts) => np("ShazamPlugin", "waitForSilence", opts || {}),
  };
}

export const Shazam = {
  findMatch: (opts) => {
    const p = getPlugin();
    if (!p) return Promise.reject(new Error("ShazamPlugin unavailable"));
    return p.findMatch(opts);
  },
  cancel: () => { getPlugin()?.cancel().catch(() => {}); },
  waitForSilence: (opts) => {
    const p = getPlugin();
    if (!p) return Promise.resolve({ silence: false });
    return p.waitForSilence(opts);
  },
};
