// ═══════════════════════════════════════════════════════════════════════════════
// Utility Functions
// ═══════════════════════════════════════════════════════════════════════════════

function fmt(n) { return n?.toLocaleString() ?? "—"; }
function pct(a, b) { return b > 0 ? Math.round(a / b * 100) : 0; }
function esc(s) { return (s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

function timeAgo(iso) {
  const d = new Date(iso), now = new Date();
  const diff = now - d, mins = Math.floor(diff / 60000), hrs = Math.floor(mins / 60), days = Math.floor(hrs / 24);
  if (days > 30) return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  if (days > 0)  return `${days}d ago`;
  if (hrs > 0)   return `${hrs}h ago`;
  return `${mins}m ago`;
}

function toggleBug(i) {
  const el = document.getElementById("bug-" + i);
  if (el) el.classList.toggle("open");
}

function renderBugList(bugs, idPrefix = "bug") {
  return bugs.map((b, i) => `
    <div class="bug-row">
      <div class="bug-summary" onclick="document.getElementById('${idPrefix}-${i}').classList.toggle('open')">
        <span class="bug-badge ${b.platform === 'ios' ? 'badge-ios' : 'badge-web'}">${esc(b.platform || '?')}</span>
        <span class="bug-desc">${esc(b.description)}</span>
        <span class="bug-meta">${b.user_email ? esc(b.user_email) + ' · ' : ''}v${esc(b.app_version || '?')} · ${b.retry_count ? 'retries:' + b.retry_count + ' · ' : ''}${timeAgo(b.created_at)}</span>
      </div>
      <div class="bug-detail" id="${idPrefix}-${i}">
        <strong>${esc(b.description)}</strong>
        ${b.user_email ? `<div>👤 ${esc(b.user_email)}</div>` : '<div style="color:var(--muted)">Anonymous</div>'}
        <div>📱 ${esc(b.platform || '—')} · v${esc(b.app_version || '—')} · ${new Date(b.created_at).toLocaleString()}</div>
        ${b.retry_count ? `<div>🔁 ${b.retry_count} retries${b.last_retried_at ? ' · last ' + timeAgo(b.last_retried_at) : ''}</div>` : ''}
        ${b.meta ? `<pre>${esc(JSON.stringify(b.meta, null, 2))}</pre>` : ''}
      </div>
    </div>`).join("");
}
