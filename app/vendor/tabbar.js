// Liri shared bottom tab bar.
// Usage in any page that loads React + this script:
//   <TabBar current="library" />   (current: "sync" | "library" | "feed" | "profile")
// Hides itself automatically when the user is signed out.
(function () {
  const h = React.createElement;

  // iOS app: anchor the tab bar by moving all scrolling into #root. WKWebView
  // otherwise scrolls/rubber-bands the whole body, which drags the "fixed"
  // tab bar off screen until you scroll it back. Web keeps body scrolling.
  //
  // NOTE: we deliberately do NOT use `position:fixed` on <body> here. That is
  // the classic iOS trick, but focusing an <input> makes WKWebView scroll the
  // fixed body to reveal the field and then leaves it shifted — which reads as
  // the page "getting scrolly" while typing (e.g. Explore search). Plain
  // `overflow:hidden` + a scrollable #root anchors the bar without that bug.
  if (window.Capacitor) {
    const s = document.createElement("style");
    s.textContent =
      // background on <html> too so page-to-page navigation paints the app's
      // dark colour instead of a black WKWebView flash between tabs.
      "html,body{height:100%;overflow:hidden;overscroll-behavior:none;background:#080810;}" +
      "#root{height:100%;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:none;}";
    document.head.appendChild(s);
  }

  function checkSignedIn() {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith("sb-") && key.endsWith("-auth-token")) {
          const v = JSON.parse(localStorage.getItem(key));
          if (v && v.access_token) {
            if (v.expires_at && v.expires_at * 1000 < Date.now()) return false;
            return true;
          }
        }
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  const Icon = {
    listen: (a) => h("svg", { width: 22, height: 22, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
      h("circle", { cx: 12, cy: 12, r: 9 }),
      h("circle", { cx: 12, cy: 12, r: 2.5, fill: "currentColor" })
    ),
    library: () => h("svg", { width: 22, height: 22, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
      h("path", { d: "M4 4v16M8 4v16M12 4v16M16 4v16M20 4v16" })
    ),
    feed: () => h("svg", { width: 22, height: 22, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
      h("path", { d: "M4 6h16M4 12h16M4 18h10" })
    ),
    explore: () => h("svg", { width: 22, height: 22, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
      h("circle", { cx: 11, cy: 11, r: 7 }),
      h("line", { x1: 21, y1: 21, x2: 16.5, y2: 16.5 })
    ),
    profile: () => h("svg", { width: 22, height: 22, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
      h("circle", { cx: 12, cy: 8, r: 4 }),
      h("path", { d: "M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" })
    ),
  };

  // In Capacitor, webDir="app" means the app/ folder is served as "/".
  // Web paths are /app/library.html etc., but in Capacitor they must be /library.html.
  function pageHref(webPath) {
    if (!window.Capacitor) return webPath;
    // Strip the /app prefix; a bare "/app" (the signed-out "Open app" CTA)
    // becomes "" which would reload the current page — send it to root instead.
    const stripped = webPath.replace(/^\/app/, "");
    return stripped === "" ? "/" : stripped;
  }

  // Exposed so in-page links on every page (settings gear, profile rows, etc.)
  // can use the same web ↔ Capacitor path rewrite the tab bar uses. Without it
  // hardcoded "/app/..." links are dead paths inside the iOS bundle.
  window.liriHref = pageHref;

  // ── Persistent now-playing bar ────────────────────────────────────────────
  // While a sync session is live, its snapshot is saved to liri_nowplaying (the
  // sync page restores from it on return). We surface that snapshot as a slim
  // sticky bar on the OTHER tabs — proof your spot is still held — that taps
  // back to the sync page. Fresh window matches the sync page's 1h restore.
  function readNowPlaying() {
    try {
      const s = JSON.parse(localStorage.getItem("liri_nowplaying") || "null");
      if (!s || !s.detectedSong || !s.savedAt) return null;
      if (Date.now() - s.savedAt > 60 * 60 * 1000) return null;
      return { title: s.detectedSong.title, artist: s.detectedSong.artist, artwork: s.detectedSong.artwork };
    } catch (e) { return null; }
  }

  window.NowPlayingBar = function NowPlayingBar() {
    const [np, setNp] = React.useState(readNowPlaying());
    React.useEffect(() => {
      const tick = () => setNp(readNowPlaying());
      const id = setInterval(tick, 3000);
      window.addEventListener("focus", tick);
      window.addEventListener("storage", tick);
      return () => { clearInterval(id); window.removeEventListener("focus", tick); window.removeEventListener("storage", tick); };
    }, []);
    if (!np) return null;

    return h("a", {
      href: pageHref("/app/index.html"),
      "aria-label": "Return to now playing",
      style: {
        position: "sticky", top: 0, zIndex: 90,
        display: "flex", alignItems: "center", gap: "10px",
        padding: "calc(env(safe-area-inset-top) + 8px) 16px 8px",
        background: "rgba(14,14,26,0.96)",
        backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)",
        borderBottom: "1px solid rgba(212,168,70,0.25)",
        textDecoration: "none", color: "#f0e6d3",
      },
    },
      h("span", { style: { width: 8, height: 8, borderRadius: "50%", background: "#d4a846", flexShrink: 0, animation: "nppulse 1.4s ease-in-out infinite" } }),
      np.artwork ? h("img", { src: np.artwork, alt: "", style: { width: 30, height: 30, borderRadius: 5, objectFit: "cover", flexShrink: 0 } }) : null,
      h("div", { style: { flex: 1, minWidth: 0 } },
        h("div", { style: { fontSize: 13, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, np.title || "Now playing"),
        h("div", { style: { fontSize: 11, color: "rgba(255,255,255,0.45)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, np.artist || "")
      ),
      h("span", { style: { fontSize: 11, fontWeight: 700, color: "#d4a846", flexShrink: 0, letterSpacing: 0.3 } }, "Now playing ›")
    );
  };

  // Keyframes for the pulsing dot (injected once).
  (function () {
    var st = document.createElement("style");
    st.textContent = "@keyframes nppulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.7)}}";
    document.head.appendChild(st);
  })();

  window.TabBar = function TabBar(props) {
    const current = (props && props.current) || "";
    const hidden = !!(props && props.hidden); // fades the bar out (e.g. idle lyrics view on iOS)

    const [signedIn, setSignedIn] = React.useState(checkSignedIn());
    React.useEffect(() => {
      const tick = () => setSignedIn(checkSignedIn());
      const id = setInterval(tick, 1000);
      window.addEventListener("storage", tick);
      window.addEventListener("focus", tick);
      return () => {
        clearInterval(id);
        window.removeEventListener("storage", tick);
        window.removeEventListener("focus", tick);
      };
    }, []);

    if (!signedIn) return null;

    // On the iOS app, show icons only (no labels) for a cleaner native feel.
    const iconsOnly = !!window.Capacitor;

    const tabs = [
      { key: "sync",    label: "Sync",       href: pageHref("/app/index.html"),   icon: Icon.listen },
      { key: "library", label: "My Records", href: pageHref("/app/library.html"), icon: Icon.library },
      { key: "feed",    label: "Feed",       href: pageHref("/app/feed.html"),    icon: Icon.feed },
      { key: "explore", label: "Explore",    href: pageHref("/app/explore.html"), icon: Icon.explore },
      { key: "profile", label: "You",        href: pageHref("/app/profile.html"), icon: Icon.profile },
    ];

    return h(
      "nav",
      {
        style: {
          position: "fixed",
          bottom: 0, left: 0, right: 0,
          background: "rgba(12,12,20,0.92)",
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          borderTop: "1px solid rgba(255,255,255,0.06)",
          paddingBottom: "env(safe-area-inset-bottom)",
          display: "flex",
          zIndex: 100,
          opacity: hidden ? 0 : 1,
          transition: "opacity 0.35s",
          pointerEvents: hidden ? "none" : "auto",
        },
      },
      tabs.map((t) => {
        const active = t.key === current;
        return h(
          "a",
          {
            key: t.key,
            href: t.href,
            style: {
              flex: 1,
              display: "flex", flexDirection: "column",
              alignItems: "center", justifyContent: "center",
              gap: 3,
              padding: iconsOnly ? "14px 0" : "10px 0 10px",
              color: active ? "#d4a846" : "rgba(240,230,211,0.45)",
              textDecoration: "none",
              fontFamily: "inherit",
              transition: "color 0.15s",
            },
          },
          t.icon(active),
          iconsOnly ? null : h("div", { style: { fontSize: 10, fontWeight: 700, letterSpacing: 0.4 } }, t.label)
        );
      })
    );
  };
})();
