// Lazy bridge to Liri's native iOS idle-timer control.
export function getKeepAwake() {
  if (!window.Capacitor) return null;
  return window.Capacitor.Plugins?.KeepAwake
      ?? window.Capacitor.registerPlugin?.("KeepAwake")
      ?? null;
}
