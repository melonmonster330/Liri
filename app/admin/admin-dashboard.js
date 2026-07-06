// ═══════════════════════════════════════════════════════════════════════════════
// Dashboard Rendering
// ═══════════════════════════════════════════════════════════════════════════════

function renderRangePills() {
  return `<div class="range-pills">${RANGE_OPTIONS.map(o =>
    `<button class="range-pill${activeDays === o.days ? " active" : ""}" onclick="setRange(${o.days})">${o.label}</button>`
  ).join("")}</div>`;
}

function render(d) {
  const { users, library, plays, topAlbums, topUsers, bugReports, catalogue } = d;
  const totalPlatform = plays.web + plays.ios || 1;
  const totalSource   = plays.recognition + plays.autoAdvance || 1;
  const topMax = topAlbums[0]?.count || 1;
  const rangeLabel = activeDays === 0 ? "all time" : activeDays === 1 ? "last 24h" : `last ${activeDays}d`;

  document.getElementById("range-pills").innerHTML = renderRangePills();
  document.getElementById("content").innerHTML = `
    <div class="grid">
      <div class="card card-gold">
        <div class="card-label">Total Users</div>
        <div class="card-value">${fmt(users.total)}</div>
        <div class="card-sub">+${users.new7d} this week · +${users.new30d} this month</div>
      </div>
      <div class="card">
        <div class="card-label">Premium</div>
        <div class="card-value">${fmt(users.premium)}</div>
        <div class="card-sub">${pct(users.premium, users.total)}% of users</div>
      </div>
      <div class="card clickable" onclick="openAlbums()">
        <div class="card-label">Avg Albums / User</div>
        <div class="card-value">${library.avgAlbums}</div>
        <div class="card-sub">${fmt(library.totalAlbums)} total in libraries · view →</div>
      </div>
    </div>

    <div class="grid">
      <div class="card card-gold">
        <div class="card-label">Listens (${rangeLabel})</div>
        <div class="card-value">${fmt(plays.window)}</div>
        <div class="card-sub">${fmt(plays.total)} all time · ${fmt(plays.songsTotal)} songs</div>
      </div>
      <div class="card">
        <div class="card-label">Listens (last 7d)</div>
        <div class="card-value">${fmt(plays.last7d)}</div>
        <div class="card-sub">album loads · rolling 7 days</div>
      </div>
      <div class="card">
        <div class="card-label">Catalogue</div>
        <div class="card-value">${fmt(catalogue.releases)}</div>
        <div class="card-sub">${fmt(catalogue.flips)} total flips</div>
      </div>
    </div>

    <div class="grid grid-2">
      <div class="section">
        <div class="section-title">Platform</div>
        <div class="split-row">
          <div class="split-item">
            <div class="split-label">iOS</div>
            <div class="split-value">${fmt(plays.ios)}</div>
            <div class="split-pct">${pct(plays.ios, totalPlatform)}%</div>
            <div class="split-bar"><div class="split-bar-fill" style="width:${pct(plays.ios, totalPlatform)}%"></div></div>
          </div>
          <div class="split-item">
            <div class="split-label">Web</div>
            <div class="split-value">${fmt(plays.web)}</div>
            <div class="split-pct">${pct(plays.web, totalPlatform)}%</div>
            <div class="split-bar"><div class="split-bar-fill" style="width:${pct(plays.web, totalPlatform)}%"></div></div>
          </div>
        </div>
      </div>
      <div class="section">
        <div class="section-title">Play Source</div>
        <div class="split-row">
          <div class="split-item">
            <div class="split-label">Recognition</div>
            <div class="split-value">${fmt(plays.recognition)}</div>
            <div class="split-pct">${pct(plays.recognition, totalSource)}%</div>
            <div class="split-bar"><div class="split-bar-fill" style="width:${pct(plays.recognition, totalSource)}%"></div></div>
          </div>
          <div class="split-item">
            <div class="split-label">Auto-advance</div>
            <div class="split-value">${fmt(plays.autoAdvance)}</div>
            <div class="split-pct">${pct(plays.autoAdvance, totalSource)}%</div>
            <div class="split-bar"><div class="split-bar-fill" style="width:${pct(plays.autoAdvance, totalSource)}%"></div></div>
          </div>
        </div>
      </div>
    </div>

    <div class="grid grid-2">
      <div class="section">
        <div class="section-title">Top Albums (${rangeLabel})</div>
        ${topAlbums.length === 0 ? '<div style="color:var(--muted);font-size:13px">No data yet</div>' :
          topAlbums.map(a => `
          <div class="bar-row">
            <div class="bar-label">${esc(a.album)}<span>${esc(a.artist)}</span></div>
            <div class="bar-track"><div class="bar-fill" style="width:${pct(a.count, topMax)}%"></div></div>
            <div class="bar-count">${a.count}</div>
          </div>`).join("")}
      </div>
      <div class="section clickable" onclick="openUsers()">
        <div class="section-title" style="display:flex;justify-content:space-between;align-items:center">
          <span>Recent Signups</span>
          <span style="color:var(--muted);font-size:11px">view all →</span>
        </div>
        ${users.recentSignups.length === 0 ? '<div style="color:var(--muted);font-size:13px">No signups yet</div>' :
          users.recentSignups.map(u => `
          <div class="signup-row">
            <span class="signup-email">${esc(u.email)}</span>
            <span class="signup-date">${timeAgo(u.created_at)}</span>
          </div>`).join("")}
      </div>
    </div>

    <div class="section">
      <div class="section-title">Top Users by Plays</div>
      ${!topUsers || topUsers.length === 0 ? '<div style="color:var(--muted);font-size:13px">No data yet</div>' : (() => {
        const topMax2 = topUsers[0]?.count || 1;
        return topUsers.map((u, i) => `
          <div class="bar-row">
            <div class="bar-label" style="width:220px">${esc(u.email)}<span>#${i+1}</span></div>
            <div class="bar-track"><div class="bar-fill" style="width:${pct(u.count, topMax2)}%"></div></div>
            <div class="bar-count">${u.count}</div>
          </div>`).join("");
      })()}
    </div>

    <div class="section">
      <div class="section-title" style="display:flex;justify-content:space-between;align-items:center;gap:12px">
        <span>Bug Reports — Open (${(bugReports || []).length})</span>
        ${d.backlogTotal > 0
          ? `<button class="back-btn" style="margin:0;padding:4px 10px" onclick="openBacklog()">View backlog (${d.backlogTotal}) →</button>`
          : ''}
      </div>
      ${!bugReports || bugReports.length === 0 ? '<div style="color:var(--muted);font-size:13px">No open reports 🎉</div>' :
        renderBugList(bugReports)}
    </div>
  `;
}
