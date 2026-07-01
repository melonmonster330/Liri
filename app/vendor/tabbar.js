// Liri shared nav.
//   - Mobile (default) + Capacitor (iOS): bottom tab bar.  Byte-identical to
//     the pre-rail version so native iOS keeps its exact current feel.
//   - Web at >= 900px viewport: left vertical rail using MCM theme tokens.
//
// Usage in any page that loads React + this script:
//   <TabBar current="library" />
//     current: "sync" | "library" | "feed" | "explore" | "profile"
//
// Hides itself automatically when the user is signed out.
// When the desktop rail is visible, sets  <body data-liri-nav="rail">  so
// theme.css can shift the page content over.
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

  // In Capacitor, webDir="app" means the app/ folder is served as "/".
  // Web paths are /app/library.html etc.; in Capacitor they must be /library.html.
  function pageHref(webPath) {
    return window.Capacitor ? webPath.replace(/^\/app/, "") : webPath;
  }

  // The desktop rail is web-only. iOS native keeps the bottom tab bar at any
  // width (iPad included) so it matches the platform's expected feel.
  const DESKTOP_QUERY = "(min-width: 900px)";
  const supportsRail  = typeof window !== "undefined"
                        && !window.Capacitor
                        && !!window.matchMedia;

  function useIsDesktop() {
    const [isDesktop, setIsDesktop] = React.useState(
      supportsRail && window.matchMedia(DESKTOP_QUERY).matches
    );
    React.useEffect(() => {
      if (!supportsRail) return;
      const mq = window.matchMedia(DESKTOP_QUERY);
      const handler = (e) => setIsDesktop(e.matches);
      if (mq.addEventListener)      mq.addEventListener("change", handler);
      else if (mq.addListener)      mq.addListener(handler);
      return () => {
        if (mq.removeEventListener) mq.removeEventListener("change", handler);
        else if (mq.removeListener) mq.removeListener(handler);
      };
    }, []);
    return isDesktop;
  }

  window.TabBar = function TabBar(props) {
    const current   = (props && props.current) || "";
    const isDesktop = useIsDesktop();

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

    // Toggle the body flag so theme.css shifts page content over for the rail.
    React.useEffect(() => {
      const railActive = signedIn && isDesktop;
      if (railActive) document.body.dataset.liriNav = "rail";
      else            delete document.body.dataset.liriNav;
      return () => { delete document.body.dataset.liriNav; };
    }, [signedIn, isDesktop]);

    if (!signedIn) return null;

    const tabs = [
      { key: "sync",    label: "Sync",       href: pageHref("/app/index.html"),   icon: Icon.listen },
      { key: "library", label: "My Records", href: pageHref("/app/library.html"), icon: Icon.library },
      { key: "feed",    label: "Feed",       href: pageHref("/app/feed.html"),    icon: Icon.feed },
      { key: "explore", label: "Explore",    href: pageHref("/app/explore.html"), icon: Icon.explore },
      { key: "profile", label: "You",        href: pageHref("/app/profile.html"), icon: Icon.profile },
    ];

    return isDesktop ? renderRail(tabs, current) : renderBottomBar(tabs, current);
  };

  // ── Desktop left rail (web, viewport >= 900px) ──────────────────────────
  function renderRail(tabs, current) {
    return h(
      "nav",
      {
        className: "liri-nav-rail",
        "aria-label": "Primary",
        style: {
          position: "fixed",
          top: 0, bottom: 0, left: 0,
          width: "var(--nav-rail-width, 240px)",
          background: "var(--bg-surface, #FFFFFF)",
          borderRight: "1px solid var(--border-subtle, rgba(0,0,0,0.08))",
          padding: "28px 14px 20px",
          display: "flex", flexDirection: "column", gap: 2,
          zIndex: "var(--z-nav, 50)",
          fontFamily: "var(--font-sans)",
        },
      },
      h(
        "a",
        {
          key: "wordmark",
          href: pageHref("/app/index.html"),
          "aria-label": "Liri home",
          style: {
            display: "block",
            padding: "6px 14px 28px",
            fontFamily: "var(--font-serif)",
            fontSize: 28,
            fontWeight: 500,
            letterSpacing: "-0.025em",
            color: "var(--text-primary, #2C2523)",
            textDecoration: "none",
          },
        },
        "Liri"
      ),
      tabs.map((t) => {
        const active = t.key === current;
        return h(
          "a",
          {
            key: t.key,
            href: t.href,
            "aria-current": active ? "page" : undefined,
            style: {
              display: "flex", alignItems: "center", gap: 14,
              padding: "11px 14px",
              borderRadius: "var(--radius-pill, 9999px)",
              textDecoration: "none",
              color: active
                ? "var(--text-on-accent, #FFFFFF)"
                : "var(--text-secondary, #6E625E)",
              background: active
                ? "var(--accent-primary, #C86B45)"
                : "transparent",
              fontSize: 14.5,
              fontWeight: active ? 600 : 500,
              letterSpacing: "-0.005em",
              transition: "background 160ms cubic-bezier(0.16,1,0.3,1), color 160ms cubic-bezier(0.16,1,0.3,1)",
              WebkitTapHighlightColor: "transparent",
            },
          },
          t.icon(active),
          h("span", null, t.label)
        );
      })
    );
  }

  // ── Mobile bottom tab bar (default + Capacitor) ─────────────────────────
  //   Byte-identical to the pre-rail version. Do not change without care —
  //   this is what native iOS renders.
  function renderBottomBar(tabs, current) {
    const iconsOnly = !!window.Capacitor;
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
  }
})();
