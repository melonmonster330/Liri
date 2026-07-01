// ============================================================================
// Liri — theme controller
// Reads/writes localStorage.liri_theme = "light" | "dark" | "auto".
// Sets data-theme on <html> so the CSS variables in theme.css take effect.
//
// MUST be loaded in <head> as a blocking <script> BEFORE any React root
// so the attribute is set before first paint (prevents theme flash).
//
// Public API — window.LiriTheme:
//   .get()               → "light" | "dark" | "auto" (persisted preference)
//   .resolved()          → "light" | "dark"          (what's actually rendered)
//   .set(theme)          → persist + apply
//   .toggle()            → light ↔ dark (auto is resolved first)
//   .cycle()             → auto → light → dark → auto
//   .onChange(handler)   → subscribe to changes; returns unsubscribe fn
// ============================================================================

(function () {
  var KEY = 'liri_theme';
  var VALID = ['light', 'dark', 'auto'];
  var listeners = [];

  function read() {
    try {
      var v = localStorage.getItem(KEY);
      return VALID.indexOf(v) >= 0 ? v : 'auto';
    } catch (e) { return 'auto'; }
  }

  function write(v) {
    try { localStorage.setItem(KEY, v); } catch (e) { /* private mode etc. */ }
  }

  function systemDark() {
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  function apply(theme) {
    var t = VALID.indexOf(theme) >= 0 ? theme : 'auto';
    document.documentElement.setAttribute('data-theme', t);
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i]({ preference: t, resolved: resolve(t) }); } catch (e) {}
    }
  }

  function resolve(theme) {
    if (theme === 'light' || theme === 'dark') return theme;
    return systemDark() ? 'dark' : 'light';
  }

  var api = {
    get: read,
    resolved: function () { return resolve(read()); },
    set: function (theme) {
      if (VALID.indexOf(theme) < 0) return;
      write(theme);
      apply(theme);
    },
    toggle: function () {
      var current = resolve(read());
      api.set(current === 'dark' ? 'light' : 'dark');
    },
    cycle: function () {
      var pref = read();
      var next = pref === 'auto' ? 'light' : pref === 'light' ? 'dark' : 'auto';
      api.set(next);
    },
    onChange: function (fn) {
      if (typeof fn !== 'function') return function () {};
      listeners.push(fn);
      return function () {
        var i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
  };

  // Apply persisted preference immediately (before body renders).
  apply(read());

  // Re-notify when the OS flips light/dark, but only if user is on "auto".
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var handler = function () { if (read() === 'auto') apply('auto'); };
    if (mq.addEventListener) mq.addEventListener('change', handler);
    else if (mq.addListener) mq.addListener(handler);
  }

  window.LiriTheme = api;
})();
