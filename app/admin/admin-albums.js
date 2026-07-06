// ═══════════════════════════════════════════════════════════════════════════════
// Albums Management (Browse, Side Data, Track Reordering)
// ═══════════════════════════════════════════════════════════════════════════════

let albumsCache = null;
let albumDetailCache = null;
let reorderTracks = null;

async function openAlbums() {
  const c = document.getElementById("content");
  c.innerHTML = `<div class="loading">Loading albums…</div>`;
  const r = await fetch(API + "?action=albums", { headers: { "x-admin-password": pw } });
  if (!r.ok) { c.innerHTML = `<div class="loading">Error loading albums</div>`; return; }
  const d = await r.json();
  albumsCache = d.albums || [];
  renderAlbums(albumsCache);
}

function renderAlbums(albums) {
  const c = document.getElementById("content");
  c.innerHTML = `
    <button class="back-btn" onclick="load()">← Back to dashboard</button>
    <div class="section">
      <div class="section-title">User-added albums (${albums.length})</div>
      <input class="search-input" id="album-search" placeholder="Search by album or artist…" oninput="filterAlbums(this.value)">
      <div id="album-list">
        ${albums.length === 0 ? '<div style="color:var(--muted);font-size:13px">No albums yet</div>' :
          albums.map(a => `
            <div class="album-row" onclick="openAlbum(${a.itunes_collection_id})">
              <img class="album-art" src="${esc(a.artwork_url || '')}" onerror="this.style.visibility='hidden'">
              <div class="album-info">
                <div class="album-name">${esc(a.album_name || '(untitled)')}</div>
                <div class="album-artist">${esc(a.artist_name || '')}${a.release_year ? ' · ' + a.release_year : ''}</div>
              </div>
              <div class="album-stats">
                <div class="album-stat">
                  <div class="album-stat-val">${fmt(a.plays)}</div>
                  <div class="album-stat-lbl">plays</div>
                </div>
                <div class="album-stat">
                  <div class="album-stat-val">${fmt(a.added_by)}</div>
                  <div class="album-stat-lbl">added</div>
                </div>
              </div>
            </div>
          `).join("")}
      </div>
    </div>
  `;
}

function filterAlbums(q) {
  if (!albumsCache) return;
  const s = q.trim().toLowerCase();
  const filtered = s
    ? albumsCache.filter(a =>
        (a.album_name || "").toLowerCase().includes(s) ||
        (a.artist_name || "").toLowerCase().includes(s))
    : albumsCache;
  const list = document.getElementById("album-list");
  if (!list) return;
  list.innerHTML = filtered.map(a => `
    <div class="album-row" onclick="openAlbum(${a.itunes_collection_id})">
      <img class="album-art" src="${esc(a.artwork_url || '')}" onerror="this.style.visibility='hidden'">
      <div class="album-info">
        <div class="album-name">${esc(a.album_name || '(untitled)')}</div>
        <div class="album-artist">${esc(a.artist_name || '')}${a.release_year ? ' · ' + a.release_year : ''}</div>
      </div>
      <div class="album-stats">
        <div class="album-stat"><div class="album-stat-val">${fmt(a.plays)}</div><div class="album-stat-lbl">plays</div></div>
        <div class="album-stat"><div class="album-stat-val">${fmt(a.added_by)}</div><div class="album-stat-lbl">added</div></div>
      </div>
    </div>`).join("");
}

async function openAlbum(id) {
  const c = document.getElementById("content");
  c.innerHTML = `<div class="loading">Loading tracks…</div>`;
  const r = await fetch(API + "?action=album&id=" + id, { headers: { "x-admin-password": pw } });
  if (!r.ok) { c.innerHTML = `<div class="loading">Error loading album</div>`; return; }
  const d = await r.json();
  renderAlbum(d);
}

function renderAlbum(d) {
  const c = document.getElementById("content");
  albumDetailCache = d;
  const a = d.album || {};
  const tracks = d.tracks || [];
  const sc = d.sideCoverage || { total: tracks.length, with_side: 0, missing: tracks.length };
  const missingLyrics = tracks.filter(t => !t.has_lyrics).length;
  c.innerHTML = `
    <button class="back-btn" onclick="openAlbums()">← Back to albums</button>
    <div class="section">
      <div style="display:flex;gap:14px;align-items:center;margin-bottom:18px">
        <img src="${esc(a.artwork_url || '')}" style="width:80px;height:80px;border-radius:10px;background:var(--dim);object-fit:cover" onerror="this.style.visibility='hidden'">
        <div>
          <div style="font-size:18px;font-weight:700">${esc(a.album_name || '')}</div>
          <div style="font-size:13px;color:var(--muted);margin-top:2px">${esc(a.artist_name || '')}${a.release_year ? ' · ' + a.release_year : ''}</div>
          <div style="font-size:11px;color:var(--muted);margin-top:6px">
            ${tracks.length} track${tracks.length === 1 ? '' : 's'}
            · ${missingLyrics} missing lyrics
            · ${sc.missing === 0 ? `<span style="color:rgba(120,200,120,0.6)">side info ✓</span>`
                                 : `<span style="color:rgba(224,112,112,0.6)">side info missing on ${sc.missing}/${sc.total}</span>`}
          </div>
        </div>
      </div>
      ${tracks.length > 1 ? `<button class="back-btn" style="margin:0 0 14px" onclick="openReorder()">⇅ Fix track order</button>` : ''}
      ${tracks.length === 0 ? '<div style="color:var(--muted);font-size:13px">No track data</div>' :
        tracks.map(t => `
          <div class="track-row">
            <div class="track-num">${t.disc_number > 1 ? t.disc_number + '-' : ''}${t.track_number || ''}</div>
            <div class="track-side ${t.position ? '' : 'missing'}">${t.position ? esc(t.position) : '—'}</div>
            <div class="track-name">${esc(t.track_name || '')}</div>
            <div class="track-plays">${fmt(t.plays)} plays</div>
            <div class="track-flag ${t.has_lyrics ? 'ok' : ''}">
              ${t.has_lyrics ? '✓ lyrics' : '✗ missing'}
              ${t.lyrics_source ? `<span class="source">via ${esc(t.lyrics_source)}</span>` : ''}
            </div>
          </div>`).join("")}
      ${sc.missing > 0 ? `
      <div class="side-form" id="side-form-${a.itunes_collection_id || ''}">
        <div class="side-form-title">⚠︎ Add side data (${sc.missing}/${sc.total} tracks missing)</div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:12px">Enter how many tracks are on each side. Leave a side at 0 to skip it.</div>
        <div class="side-inputs">
          <div class="side-input-group"><div class="side-input-label">Side A</div><input class="side-input" id="side-a-${a.itunes_collection_id}" type="number" min="0" value="${Math.ceil(tracks.length / 2)}"></div>
          <div class="side-input-group"><div class="side-input-label">Side B</div><input class="side-input" id="side-b-${a.itunes_collection_id}" type="number" min="0" value="${Math.floor(tracks.length / 2)}"></div>
          <div class="side-input-group"><div class="side-input-label">Side C</div><input class="side-input" id="side-c-${a.itunes_collection_id}" type="number" min="0" value="0"></div>
          <div class="side-input-group"><div class="side-input-label">Side D</div><input class="side-input" id="side-d-${a.itunes_collection_id}" type="number" min="0" value="0"></div>
        </div>
        <button class="side-form-btn" onclick="submitSideData(${a.itunes_collection_id}, ${tracks.length})">Save Side Data</button>
        <div class="side-form-msg" id="side-msg-${a.itunes_collection_id}"></div>
      </div>` : ''}
    </div>
  `;
}

function openReorder() {
  if (!albumDetailCache) return;
  reorderTracks = (albumDetailCache.tracks || []).map(t => ({
    itunes_track_id: t.itunes_track_id,
    track_name: t.track_name,
  }));
  renderReorder();
}

function renderReorder() {
  const c = document.getElementById("content");
  const a = (albumDetailCache && albumDetailCache.album) || {};
  const cid = a.itunes_collection_id;
  c.innerHTML = `
    <button class="back-btn" onclick="openAlbum(${cid})">← Back to album</button>
    <div class="section">
      <div class="section-title">Fix track order — ${esc(a.album_name || '')}</div>
      <div style="font-size:12px;color:var(--muted);margin-bottom:14px">Reorder so the sequence matches the vinyl pressing. Saving rewrites the track numbers for this album and clears its side data (re-enter it afterward).</div>
      <div id="reorder-list">
        ${reorderTracks.map((t, i) => `
          <div class="track-row">
            <div class="track-num">${i + 1}</div>
            <div class="track-name">${esc(t.track_name || '')}</div>
            <div style="display:flex;gap:6px;flex-shrink:0">
              <button class="back-btn" style="margin:0;padding:4px 10px" ${i === 0 ? 'disabled' : ''} onclick="moveReorder(${i},-1)">▲</button>
              <button class="back-btn" style="margin:0;padding:4px 10px" ${i === reorderTracks.length - 1 ? 'disabled' : ''} onclick="moveReorder(${i},1)">▼</button>
            </div>
          </div>`).join("")}
      </div>
      <button class="side-form-btn" style="margin-top:16px" onclick="saveOrder(${cid})">Save order</button>
      <div class="side-form-msg" id="reorder-msg"></div>
    </div>
  `;
}

function moveReorder(idx, dir) {
  const j = idx + dir;
  if (j < 0 || j >= reorderTracks.length) return;
  const tmp = reorderTracks[idx]; reorderTracks[idx] = reorderTracks[j]; reorderTracks[j] = tmp;
  renderReorder();
}

async function saveOrder(collectionId) {
  const msg = document.getElementById("reorder-msg");
  const btn = document.querySelector("#content .side-form-btn");
  btn.disabled = true;
  msg.textContent = "Saving…"; msg.className = "side-form-msg";
  try {
    const r = await fetch(API, {
      method: "POST",
      headers: { "x-admin-password": pw, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reorder-tracks", collectionId, trackIds: reorderTracks.map(t => t.itunes_track_id) }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.ok) {
      msg.textContent = `✓ Saved new order (${d.updated} tracks). Re-enter side data on the album page.`;
      msg.className = "side-form-msg ok";
      setTimeout(() => openAlbum(collectionId), 1500);
    } else {
      msg.textContent = "✗ " + (d.error || ("HTTP " + r.status));
      msg.className = "side-form-msg err";
      btn.disabled = false;
    }
  } catch (e) {
    msg.textContent = "✗ " + e.message;
    msg.className = "side-form-msg err";
    btn.disabled = false;
  }
}

async function submitSideData(collectionId, totalTracks) {
  const msg = document.getElementById("side-msg-" + collectionId);
  const btn = document.querySelector(`#side-form-${collectionId} .side-form-btn`);
  const getVal = (id) => parseInt(document.getElementById(id + "-" + collectionId)?.value || "0", 10) || 0;
  const sides = [
    { letter: "A", count: getVal("side-a") },
    { letter: "B", count: getVal("side-b") },
    { letter: "C", count: getVal("side-c") },
    { letter: "D", count: getVal("side-d") },
  ].filter(s => s.count > 0);

  if (!sides.length) { msg.textContent = "Enter at least one side count."; msg.className = "side-form-msg err"; return; }
  const assigned = sides.reduce((s, x) => s + x.count, 0);
  if (assigned !== totalTracks) {
    msg.textContent = `Side totals (${assigned}) must equal track count (${totalTracks}).`;
    msg.className = "side-form-msg err";
    return;
  }

  btn.disabled = true;
  msg.textContent = "Saving…";
  msg.className = "side-form-msg";
  try {
    const r = await fetch(API, {
      method: "POST",
      headers: { "x-admin-password": pw, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "add-vinyl-sides", collectionId, sides }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.ok) {
      msg.textContent = `✓ Saved ${d.inserted} side assignments`;
      msg.className = "side-form-msg ok";
      setTimeout(() => openAlbum(collectionId), 1200);
    } else {
      msg.textContent = "✗ " + (d.error || ("HTTP " + r.status));
      msg.className = "side-form-msg err";
      btn.disabled = false;
    }
  } catch (e) {
    msg.textContent = "✗ " + e.message;
    msg.className = "side-form-msg err";
    btn.disabled = false;
  }
}
