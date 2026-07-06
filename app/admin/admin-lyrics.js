// ═══════════════════════════════════════════════════════════════════════════════
// Missing Lyrics (LRC) Management
// ═══════════════════════════════════════════════════════════════════════════════

async function openMissingLyrics() {
  const c = document.getElementById("content");
  c.innerHTML = `<div class="loading">Finding tracks without lyrics…</div>`;
  const r = await fetch(API + "?action=missing-lyrics", { headers: { "x-admin-password": pw } });
  if (!r.ok) { c.innerHTML = `<div class="loading">Error — make sure sync-catalogue supports action=missing-lyrics</div>`; return; }
  const d = await r.json();
  const tracks = d.tracks || [];

  if (tracks.length === 0) {
    c.innerHTML = `
      <button class="back-btn" onclick="load()">← Dashboard</button>
      <div style="text-align:center;padding:80px 0;color:var(--muted);font-size:16px">🎉 Every track has lyrics!</div>`;
    return;
  }

  // Group by collection
  const albumMap = {}, albumOrder = [];
  tracks.forEach(t => {
    const cid = t.itunes_collection_id;
    if (!albumMap[cid]) { albumMap[cid] = { ...t, tracks: [] }; albumOrder.push(cid); }
    albumMap[cid].tracks.push(t);
  });

  const searchLinks = (name, artist) => {
    const q = `${name} ${artist}`.trim();
    const qAttr = esc(q).replace(/"/g, "&quot;");
    return `<a class="lrc-link" href="https://lrclib.net" target="_blank">lrclib.net ↗</a>`
         + `<span class="lrc-search" onclick="copySearch(this)" data-q="${qAttr}" title="Click to copy">${esc(q)} ⧉</span>`;
  };

  const fmt_dur = ms => ms ? `${Math.floor(ms/60000)}:${String(Math.floor((ms%60000)/1000)).padStart(2,"0")}` : "";

  const plainOnly = tracks.filter(t => t.has_plain).length;
  c.innerHTML = `
    <button class="back-btn" onclick="load()">← Dashboard</button>
    <div style="margin-bottom:20px">
      <div style="font-size:20px;font-weight:700;margin-bottom:6px">Missing Lyrics</div>
      <div style="font-size:13px;color:var(--muted)">${tracks.length} track${tracks.length!==1?"s":""} across ${albumOrder.length} album${albumOrder.length!==1?"s":""} without synced timestamps${plainOnly ? ` — <span style="color:var(--gold)">${plainOnly} have plain lyrics</span> and show as unsynced auto-scroll in the app` : ""}. Click a track → find LRC → paste → submit.</div>
    </div>
    ${albumOrder.map(cid => {
      const alb = albumMap[cid];
      return `
      <div class="lrc-album" id="lrc-alb-${cid}">
        <div class="lrc-album-hdr" onclick="toggleLrcAlbum('${cid}')">
          ${alb.artwork_url ? `<img class="lrc-album-art" src="${esc(alb.artwork_url)}">` : `<div class="lrc-album-art"></div>`}
          <div class="lrc-album-info">
            <div class="lrc-album-name">${esc(alb.album_name)}</div>
            <div class="lrc-album-artist">${esc(alb.artist_name)}</div>
          </div>
          <div class="lrc-badge">${alb.tracks.length} missing</div>
          <div class="lrc-chevron" id="lrc-chev-${cid}">›</div>
        </div>
        <div class="lrc-tracks" id="lrc-tracks-${cid}">
          ${alb.tracks.map((t, i) => {
            const tid = `${cid}-${i}`;
            return `
            <div class="lrc-track" id="lrc-t-${tid}">
              <div class="lrc-track-row" onclick="toggleLrcTrack('${tid}')">
                <div class="lrc-track-name">${esc(t.track_name)}</div>
                ${t.has_plain ? `<span style="flex-shrink:0;font-size:10px;font-weight:700;letter-spacing:0.5px;color:var(--gold);background:rgba(212,168,70,0.12);border:1px solid rgba(212,168,70,0.3);border-radius:8px;padding:2px 8px;margin-right:8px">PLAIN ONLY</span>` : `<span style="flex-shrink:0;font-size:10px;font-weight:700;letter-spacing:0.5px;color:#e07070;background:rgba(224,112,112,0.1);border:1px solid rgba(224,112,112,0.3);border-radius:8px;padding:2px 8px;margin-right:8px">NO LYRICS</span>`}
                <div class="lrc-track-dur">${fmt_dur(t.duration_ms)}</div>
                <div class="lrc-chevron" id="lrc-tc-${tid}">›</div>
              </div>
              <div class="lrc-submit" id="lrc-s-${tid}">
                <div class="lrc-links">${searchLinks(t.track_name, t.artist_name)}</div>
                <textarea class="lrc-textarea" id="lrc-txt-${tid}" rows="6"
                  placeholder="[00:12.34] First line\n[00:16.00] Second line…"></textarea>
                <div style="display:flex;align-items:center;gap:12px">
                  <button class="lrc-submit-btn" id="lrc-btn-${tid}"
                    onclick="submitLrc('${tid}','${esc(t.track_name).replace(/'/g,"\\'")}','${esc(t.artist_name).replace(/'/g,"\\'")}','${esc(t.album_name).replace(/'/g,"\\'")}',${t.duration_ms||0},${t.itunes_track_id||0})">
                    Save to Liri + lrclib
                  </button>
                  <span class="lrc-msg" id="lrc-msg-${tid}"></span>
                </div>
              </div>
            </div>`;
          }).join("")}
        </div>
      </div>`;
    }).join("")}
  `;
}

async function copySearch(el) {
  const text = el.dataset.q || el.textContent.replace(/\s*⧉$/, "");
  try {
    await navigator.clipboard.writeText(text);
    const prev = el.textContent;
    el.textContent = "copied ✓";
    el.classList.add("copied");
    setTimeout(() => { el.textContent = prev; el.classList.remove("copied"); }, 1200);
  } catch (e) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

function toggleLrcAlbum(cid) {
  const el = document.getElementById("lrc-tracks-" + cid);
  const ch = document.getElementById("lrc-chev-" + cid);
  el.classList.toggle("open");
  ch.style.transform = el.classList.contains("open") ? "rotate(90deg)" : "";
}

function toggleLrcTrack(tid) {
  const el = document.getElementById("lrc-s-" + tid);
  const ch = document.getElementById("lrc-tc-" + tid);
  el.classList.toggle("open");
  ch.style.transform = el.classList.contains("open") ? "rotate(90deg)" : "";
}

async function submitLrc(tid, trackName, artistName, albumName, durationMs, itunesTrackId) {
  const ta  = document.getElementById("lrc-txt-" + tid);
  const btn = document.getElementById("lrc-btn-" + tid);
  const msg = document.getElementById("lrc-msg-" + tid);
  const lrc = ta.value.trim();

  if (!lrc) { msg.className = "lrc-msg err"; msg.textContent = "Paste LRC first."; return; }
  if (!/\[\d{2}:\d{2}\.\d+\]/.test(lrc)) {
    msg.className = "lrc-msg err";
    msg.textContent = "Doesn't look like LRC — need lines like [00:12.34] lyric";
    return;
  }

  btn.disabled = true; btn.textContent = "Submitting…";
  msg.textContent = "";

  try {
    const r = await fetch("/api/sync-catalogue", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-password": pw },
      body: JSON.stringify({
        action: "submit-lyrics",
        trackName, artistName, albumName,
        duration: Math.round(durationMs / 1000),
        syncedLyrics: lrc,
        itunesTrackId: itunesTrackId || undefined,
      }),
    });
    const json = await r.json().catch(() => ({}));
    if (r.ok) {
      msg.className = "lrc-msg ok"; msg.textContent = json.message || "Saved ✓";
      btn.textContent = "Done ✓";
      setTimeout(() => {
        const row = document.getElementById("lrc-t-" + tid);
        if (row) row.style.opacity = "0.3";
      }, 1000);
    } else {
      msg.className = "lrc-msg err"; msg.textContent = json.error || ("Error " + r.status);
      btn.disabled = false; btn.textContent = "Save to Liri + lrclib";
    }
  } catch(e) {
    msg.className = "lrc-msg err"; msg.textContent = "Network error";
    btn.disabled = false; btn.textContent = "Save to Liri + lrclib";
  }
}

async function openMissingSideInfo() {
  const c = document.getElementById("content");
  c.innerHTML = `<div class="loading">Finding albums without side info…</div>`;
  const r = await fetch(API + "?action=missing-side-info", { headers: { "x-admin-password": pw } });
  if (!r.ok) { c.innerHTML = `<div class="loading">Error loading missing side info</div>`; return; }
  const d = await r.json();
  const albums = d.albums || [];

  if (albums.length === 0) {
    c.innerHTML = `
      <button class="back-btn" onclick="load()">← Dashboard</button>
      <div style="text-align:center;padding:80px 0;color:var(--muted);font-size:16px">💿 Every album has side info!</div>`;
    return;
  }

  c.innerHTML = `
    <button class="back-btn" onclick="load()">← Dashboard</button>
    <div style="margin-bottom:20px">
      <div style="font-size:20px;font-weight:700;margin-bottom:6px">Missing Side Info</div>
      <div style="font-size:13px;color:var(--muted)">${albums.length} album${albums.length!==1?"s":""} with missing side data. Click one to enter side counts.</div>
    </div>
    ${albums.map(a => `
      <div class="album-row" onclick="openAlbum(${a.itunes_collection_id})">
        <img class="album-art" src="${esc(a.artwork_url || '')}" onerror="this.style.visibility='hidden'">
        <div class="album-info">
          <div class="album-name">${esc(a.album_name || '(untitled)')}</div>
          <div class="album-artist">${esc(a.artist_name || '')}</div>
        </div>
        <div class="album-stats">
          <div class="album-stat"><div class="album-stat-val" style="color:rgba(224,112,112,0.85)">${a.missing}/${a.total}</div><div class="album-stat-lbl">missing</div></div>
        </div>
      </div>
    `).join("")}
  `;
}
