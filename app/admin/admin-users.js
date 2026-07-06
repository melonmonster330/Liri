// ═══════════════════════════════════════════════════════════════════════════════
// Users Management
// ═══════════════════════════════════════════════════════════════════════════════

function signupPlatform(u) {
  if (u.signup_platform === "ios") return "📱 iOS App Store";
  if (u.signup_platform === "web") return "🌐 Web";
  if (u.platform_inferred === "ios")  return "📱 iOS (inferred)";
  if (u.platform_inferred === "web")  return "🌐 Web (inferred)";
  if (u.platform_inferred === "both") return "📱🌐 Both (inferred)";
  return "· platform unknown";
}

async function openUsers() {
  const c = document.getElementById("content");
  c.innerHTML = `<div class="loading">Loading users…</div>`;
  const r = await fetch(API + "?action=users", { headers: { "x-admin-password": pw } });
  if (!r.ok) { c.innerHTML = `<div class="loading">Error loading users</div>`; return; }
  const d = await r.json();
  const users = d.users || [];
  c.innerHTML = `
    <button class="back-btn" onclick="load()">← Back to dashboard</button>
    <div class="section">
      <div class="section-title">All users (${users.length}) — newest first</div>
      ${users.length === 0 ? '<div style="color:var(--muted);font-size:13px">No users yet</div>' :
        users.map(u => `
          <div class="album-row" onclick="openUser('${esc(u.id)}')">
            <div class="album-info">
              <div class="album-name">${esc(u.email)}</div>
              <div class="album-artist">${esc(u.provider)} · joined ${timeAgo(u.created_at)}</div>
              <div class="album-artist" style="margin-top:2px">${signupPlatform(u)}</div>
            </div>
            <div class="album-stats">
              <div class="album-stat"><div class="album-stat-val">${fmt(u.plays)}</div><div class="album-stat-lbl">plays</div></div>
              <div class="album-stat"><div class="album-stat-val">${fmt(u.albums)}</div><div class="album-stat-lbl">albums</div></div>
            </div>
          </div>
        `).join("")}
    </div>
  `;
}

async function openUser(uid) {
  const c = document.getElementById("content");
  c.innerHTML = `<div class="loading">Loading user…</div>`;
  const r = await fetch(API + "?action=user&id=" + encodeURIComponent(uid), { headers: { "x-admin-password": pw } });
  if (!r.ok) { c.innerHTML = `<div class="loading">Error loading user</div>`; return; }
  const d = await r.json();
  if (d.error) { c.innerHTML = `<div class="loading">${esc(d.error)}</div>`; return; }
  renderUser(d);
}

function renderUser(d) {
  const c = document.getElementById("content");
  const p = d.profile || {};
  const albums = d.albums || [];
  const plays = d.plays || { total: 0, byPlatform: {}, bySource: {}, engagement: { active: 0, passive: 0 }, sessions: { total: 0, auto_recognized: 0, manual_select: 0 } };
  const bugs  = d.bugs   || [];
  const totalPlatform = (plays.byPlatform.ios || 0) + (plays.byPlatform.web || 0) || 1;
  const totalSessions = plays.sessions.total || 1;
  const eng = plays.engagement || { active: 0, passive: 0 };
  const totalEng = (eng.active || 0) + (eng.passive || 0) || 1;
  c.innerHTML = `
    <button class="back-btn" onclick="openUsers()">← Back to users</button>

    <div class="section">
      <div style="font-size:18px;font-weight:700">${esc(p.email || '(no email)')}</div>
      <div style="font-size:12px;color:var(--muted);margin-top:6px">
        ${esc(p.provider || 'email')} · joined ${new Date(p.created_at).toLocaleDateString()}
        ${p.last_sign_in_at ? ' · last seen ' + timeAgo(p.last_sign_in_at) : ''}
        ${p.confirmed ? '' : ' · <span style="color:#e07070">email unconfirmed</span>'}
      </div>
    </div>

    <div class="grid grid-2">
      <div class="section">
        <div class="section-title">Activity</div>
        <div class="split-row">
          <div class="split-item"><div class="split-label">Albums</div><div class="split-value">${fmt(albums.length)}</div></div>
          <div class="split-item"><div class="split-label">Plays</div><div class="split-value">${fmt(plays.total)}</div></div>
          <div class="split-item"><div class="split-label">Sessions</div><div class="split-value">${fmt(plays.sessions.total)}</div></div>
        </div>
      </div>
      <div class="section">
        <div class="section-title">Platform</div>
        <div class="split-row">
          <div class="split-item">
            <div class="split-label">iOS</div>
            <div class="split-value">${fmt(plays.byPlatform.ios || 0)}</div>
            <div class="split-pct">${pct(plays.byPlatform.ios || 0, totalPlatform)}%</div>
            <div class="split-bar"><div class="split-bar-fill" style="width:${pct(plays.byPlatform.ios || 0, totalPlatform)}%"></div></div>
          </div>
          <div class="split-item">
            <div class="split-label">Web</div>
            <div class="split-value">${fmt(plays.byPlatform.web || 0)}</div>
            <div class="split-pct">${pct(plays.byPlatform.web || 0, totalPlatform)}%</div>
            <div class="split-bar"><div class="split-bar-fill" style="width:${pct(plays.byPlatform.web || 0, totalPlatform)}%"></div></div>
          </div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Engagement</div>
      <div style="color:var(--muted);font-size:12px;margin-bottom:10px">
        Active = chose this track (identify / shazam / turntable jump). Passive = turntable rolled to it (auto-advance).
      </div>
      <div class="split-row">
        <div class="split-item">
          <div class="split-label">Active plays</div>
          <div class="split-value">${fmt(eng.active)}</div>
          <div class="split-pct">${pct(eng.active, totalEng)}%</div>
          <div class="split-bar"><div class="split-bar-fill" style="width:${pct(eng.active, totalEng)}%"></div></div>
        </div>
        <div class="split-item">
          <div class="split-label">Passive plays</div>
          <div class="split-value">${fmt(eng.passive)}</div>
          <div class="split-pct">${pct(eng.passive, totalEng)}%</div>
          <div class="split-bar"><div class="split-bar-fill" style="width:${pct(eng.passive, totalEng)}%"></div></div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">How they identify songs</div>
      <div style="color:var(--muted);font-size:12px;margin-bottom:10px">
        How each session was kicked off (first event per session)
      </div>
      <div class="split-row">
        <div class="split-item">
          <div class="split-label">Auto-recognized (Shazam / Identify)</div>
          <div class="split-value">${fmt(plays.sessions.auto_recognized)}</div>
          <div class="split-pct">${pct(plays.sessions.auto_recognized, totalSessions)}% of sessions</div>
          <div class="split-bar"><div class="split-bar-fill" style="width:${pct(plays.sessions.auto_recognized, totalSessions)}%"></div></div>
        </div>
        <div class="split-item">
          <div class="split-label">Manual select (from list)</div>
          <div class="split-value">${fmt(plays.sessions.manual_select)}</div>
          <div class="split-pct">${pct(plays.sessions.manual_select, totalSessions)}% of sessions</div>
          <div class="split-bar"><div class="split-bar-fill" style="width:${pct(plays.sessions.manual_select, totalSessions)}%"></div></div>
        </div>
      </div>
      <div style="margin-top:14px;display:flex;flex-wrap:wrap;gap:14px;font-size:12px;color:var(--muted)">
        <div>recognition: <span style="color:#fff">${fmt(plays.bySource.recognition || 0)}</span></div>
        <div>shazam: <span style="color:#fff">${fmt(plays.bySource.shazam || 0)}</span></div>
        <div>auto-advance: <span style="color:#fff">${fmt(plays.bySource.auto_advance || 0)}</span></div>
        <div>turntable jump: <span style="color:#fff">${fmt(plays.bySource.turntable_jump || 0)}</span></div>
        ${plays.bySource.other ? `<div>other: <span style="color:#fff">${fmt(plays.bySource.other)}</span></div>` : ''}
      </div>
    </div>

    <div class="section">
      <div class="section-title">Albums (${albums.length})</div>
      ${albums.length === 0 ? '<div style="color:var(--muted);font-size:13px">No albums added</div>' :
        albums.map(a => `
          <div class="album-row" onclick="openAlbum(${a.itunes_collection_id})">
            <img class="album-art" src="${esc(a.artwork_url || '')}" onerror="this.style.visibility='hidden'">
            <div class="album-info">
              <div class="album-name">${esc(a.album_name)}</div>
              <div class="album-artist">${esc(a.artist_name)}${a.release_year ? ' · ' + a.release_year : ''} · added ${timeAgo(a.added_at)}</div>
            </div>
            <div class="album-stats">
              <div class="album-stat"><div class="album-stat-val">${fmt(a.plays)}</div><div class="album-stat-lbl">plays</div></div>
            </div>
          </div>
        `).join("")}
    </div>

    <div class="section">
      <div class="section-title">Bug reports filed (${bugs.length})</div>
      ${bugs.length === 0 ? '<div style="color:var(--muted);font-size:13px">None</div>' :
        renderBugList(bugs, "user-bug")}
    </div>
  `;
}

async function openBacklog() {
  const c = document.getElementById("content");
  c.innerHTML = `<div class="loading">Loading backlog…</div>`;
  const r = await fetch(API + "?action=bugs&status=backlog", { headers: { "x-admin-password": pw } });
  if (!r.ok) { c.innerHTML = `<div class="loading">Error loading backlog</div>`; return; }
  const d = await r.json();
  const bugs = d.bugs || [];
  c.innerHTML = `
    <button class="back-btn" onclick="load()">← Back to dashboard</button>
    <div class="section">
      <div class="section-title">Backlog — likely unobtainable (${bugs.length})</div>
      <div style="color:var(--muted);font-size:12px;margin-bottom:12px">
        Bugs that failed 3+ sweep retries. Still re-checked when running
        <code>node scripts/sweep-missing-lyrics.js --include-backlog</code>.
      </div>
      ${bugs.length === 0 ? '<div style="color:var(--muted);font-size:13px">Nothing backlogged 🎉</div>' :
        renderBugList(bugs, "backlog")}
    </div>
  `;
}
