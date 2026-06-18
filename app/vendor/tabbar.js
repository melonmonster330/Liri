// Liri shared bottom tab bar.
// Usage in any page that loads React + this script:
//   <TabBar current="library" />   (current: "listen" | "library" | "feed" | "profile")
// Hides itself automatically when the user is signed out.
(function () {
  const h = React.createElement;

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

  function listenHref() {
    return window.Capacitor ? "/index.html" : "/app";
  }

  window.TabBar = function TabBar(props) {
    const current = (props && props.current) || "";

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

    const tabs = [
      { key: "listen",  label: "Listen",  href: listenHref(),          icon: Icon.listen },
      { key: "library", label: "My Records", href: "/app/library.html",   icon: Icon.library },
      { key: "feed",    label: "Feed",    href: "/app/feed.html",      icon: Icon.feed },
      { key: "explore", label: "Explore", href: "/app/explore.html",   icon: Icon.explore },
      { key: "profile", label: "You",     href: "/app/profile.html",   icon: Icon.profile },
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
              padding: "10px 0 10px",
              color: active ? "#d4a846" : "rgba(240,230,211,0.45)",
              textDecoration: "none",
              fontFamily: "inherit",
              transition: "color 0.15s",
            },
          },
          t.icon(active),
          h("div", { style: { fontSize: 10, fontWeight: 700, letterSpacing: 0.4 } }, t.label)
        );
      })
    );
  };
})();
