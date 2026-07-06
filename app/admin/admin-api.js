// ═══════════════════════════════════════════════════════════════════════════════
// API & Data Management
// ═══════════════════════════════════════════════════════════════════════════════

const API = "/api/sync-catalogue";
let activeDays = 3;
const RANGE_OPTIONS = [
  { label: "3d",   days: 3   },
  { label: "7d",   days: 7   },
  { label: "30d",  days: 30  },
  { label: "1y",   days: 365 },
  { label: "All",  days: 0   },
];

async function load() {
  const url = activeDays > 0 ? `${API}?days=${activeDays}` : API + "?days=0";
  const r = await fetch(url, { headers: { "x-admin-password": pw } });
  if (r.status === 401) { showLogin("Wrong password"); return; }
  if (!r.ok) { document.getElementById("content").innerHTML = `<div class="loading">Error loading stats</div>`; return; }
  const d = await r.json();
  render(d);
  document.getElementById("updated-at").textContent = "Updated " + timeAgo(d.generatedAt);
}

async function setRange(days) {
  activeDays = days;
  document.getElementById("range-pills").innerHTML = renderRangePills();
  document.getElementById("content").innerHTML = `<div class="loading">Loading…</div>`;
  await load();
}

document.addEventListener("click", async (ev) => {
  if (ev.target && ev.target.id === "lu-post") {
    const ta = document.getElementById("lu-text");
    const status = document.getElementById("lu-status");
    const text = ta.value.trim();
    if (!text) { status.textContent = "Write something first."; return; }
    if (!confirm("Publish this update to everyone's feed (as @liri)?")) return;
    status.textContent = "Posting…";
    try {
      const r = await fetch(API, { 
        method: "POST", 
        headers: { "x-admin-password": pw, "Content-Type": "application/json" }, 
        body: JSON.stringify({ action: "post-update", text }) 
      });
      if (r.ok) { status.textContent = "✓ Posted to the feed"; ta.value = ""; }
      else { const e = await r.json().catch(() => ({})); status.textContent = "✗ " + (e.error || ("HTTP " + r.status)); }
    } catch (e) { status.textContent = "✗ " + e.message; }
  }
});
