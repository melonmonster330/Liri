#!/usr/bin/env node

// Produces a self-contained Tizen web-app directory from Liri's shared TV
// receiver. tv.html remains the source of truth for the display itself.

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const out = path.join(root, "samsung-tv", "dist");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "vendor"), { recursive: true });

let html = fs.readFileSync(path.join(root, "tv.html"), "utf8");
html = html
  .replace(/\s*<!-- Cast Receiver SDK[\s\S]*?cast_receiver_framework\.js"><\/script>/, "")
  .replace(
    '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>',
    '<script src="vendor/supabase.min.js"></script>'
  )
  .replace(
    /if \(typeof cast !== "undefined" && cast\.framework\) \{\s*initCastReceiverMode\(\);\s*\} else \{\s*initBrowserMode\(\);\s*\}/,
    "initBrowserMode();"
  )
  .replace("Apple TV browser, etc.", "Samsung TV app and other TV browsers")
  .replace("liri.tv · ", "Liri TV · ")
  .replace("</body>", `  <script>
    // Samsung's Back key should leave Liri like a native TV application.
    document.addEventListener("keydown", function (event) {
      if (event.keyCode === 10009 && window.tizen && tizen.application) {
        tizen.application.getCurrentApplication().exit();
      }
    });
  </script>
</body>`);

fs.writeFileSync(path.join(out, "index.html"), html);
fs.copyFileSync(path.join(root, "app", "vendor", "supabase.min.js"), path.join(out, "vendor", "supabase.min.js"));
fs.copyFileSync(path.join(root, "samsung-tv", "config.xml"), path.join(out, "config.xml"));
fs.copyFileSync(path.join(root, "favicon.png"), path.join(out, "icon.png"));

console.log(`Samsung TV app assembled at ${path.relative(root, out)}`);
