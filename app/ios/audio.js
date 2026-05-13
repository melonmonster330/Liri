// JS bridge to the native NativeAudio Capacitor plugin (registered in
// ios/App/App/AppDelegate.swift via _retainPlugins).
//
// Currently unused in main.js — kept here so it's discoverable for future use
// (e.g. precise audio scheduling, chime playback that needs sub-WebAudio
// latency, etc.). Delete if it stays unused long-term.
//
// Lazy getter: window.Capacitor isn't ready at module-load time on iOS — the
// bridge is injected after the JS parses — so re-check on every call.

export function getNativeAudio() {
  if (!window.Capacitor) return null;
  return window.Capacitor.Plugins?.NativeAudio
      ?? window.Capacitor.registerPlugin?.("NativeAudio")
      ?? null;
}
