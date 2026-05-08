const $ = (id) => document.getElementById(id);

// =================== State ===================
let mapping = { version: 2, gifts: [], overlays: [], groups: [] };
let effects = [];

// =================== DOM refs ===================
const els = {
  status: $('status'), log: $('log'),
  // Embed tab
  embedBigoId: $('embedBigoId'),
  btnConnect: $('btnConnect'), btnEmbedStop: $('btnEmbedStop'), btnEmbedShow: $('btnEmbedShow'),
  liveInfo: $('liveInfo'),
  metaPanel: $('metaPanel'), metaInfo: $('metaInfo'),
  liveChats: $('liveChats'), liveGifts: $('liveGifts'),
  // Open API tab
  env: $('env'), bigoId: $('bigoId'), openid: $('openid'), gameId: $('gameId'), accessToken: $('accessToken'),
  btnSave: $('btnSave'), btnStart: $('btnStart'), btnStop: $('btnStop'),
  btnTestHeart: $('btnTestHeart'), btnTestMsg: $('btnTestMsg'),
  events: $('events'),
  // Gifts tab
  giftTableBody: $('giftTableBody'), btnAddGift: $('btnAddGift'), btnTestGift: $('btnTestGift'),
  iconCacheStatus: $('iconCacheStatus'), btnDownloadIcons: $('btnDownloadIcons'), iconProgress: $('iconProgress'),
  // Overlays tab
  overlayTableBody: $('overlayTableBody'), btnAddOverlay: $('btnAddOverlay'),
  // Gift modal
  giftDialog: $('giftDialog'), giftDialogTitle: $('giftDialogTitle'),
  dlgMatchKeys: $('dlgMatchKeys'), dlgAlias: $('dlgAlias'),
  dlgGroup: $('dlgGroup'), dlgFile: $('dlgFile'), dlgOverlay: $('dlgOverlay'),
  dlgGiftSave: $('dlgGiftSave'), groupList: $('groupList'),
  dlgMasterQuery: $('dlgMasterQuery'), dlgMasterResults: $('dlgMasterResults'),
  // Overlay modal
  overlayDialog: $('overlayDialog'), overlayDialogTitle: $('overlayDialogTitle'),
  ovName: $('ovName'), ovBgColor: $('ovBgColor'), ovOpacity: $('ovOpacity'), ovOpacityVal: $('ovOpacityVal'),
  ovW: $('ovW'), ovH: $('ovH'), ovTop: $('ovTop'), dlgOverlaySave: $('dlgOverlaySave'),
};

// =================== Utils ===================
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function appendLog(msg) {
  const t = new Date().toLocaleTimeString();
  els.log.textContent = `[${t}] ${msg}\n` + els.log.textContent;
  if (els.log.textContent.length > 12000) els.log.textContent = els.log.textContent.slice(0, 12000);
}
function uid(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// =================== Tabs ===================
document.querySelectorAll('.tab').forEach(t => {
  t.onclick = () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    document.querySelector(`.tab-panel[data-tab="${t.dataset.tab}"]`).classList.add('active');
  };
});

// =================== Init ===================
async function init() {
  const s = await window.bigo.settingsLoad();
  els.env.value = s.env || 'prod';
  els.bigoId.value = s.bigoId || '';
  els.embedBigoId.value = s.bigoId || '';
  els.openid.value = s.openid || '';
  els.gameId.value = s.gameId || '';
  els.accessToken.value = s.accessToken || '';

  mapping = await window.bigo.mappingLoad();
  await reloadEffects();
  renderGiftTable();
  renderOverlayTable();
  refreshIconCacheStatus();
}

async function refreshIconCacheStatus() {
  const s = await window.bigo.giftsIconsStatus();
  els.iconCacheStatus.textContent = `Kho icon: ${s.count}/${s.total || '?'} đã tải · ${s.dir}`;
}

// Listen progress từ cả nút Tải lẫn auto-download lúc khởi động
window.bigo.giftsOnDownloadProgress(p => {
  if (!p || !p.total) return;
  els.iconProgress.style.display = 'inline-block';
  els.iconProgress.value = (p.done / p.total) * 100;
  els.iconCacheStatus.textContent = `Đang tải: ${p.done}/${p.total} (mới ${p.ok}, sẵn ${p.skip}, lỗi ${p.fail})`;
  if (p.done >= p.total) {
    setTimeout(() => {
      els.iconProgress.style.display = 'none';
      refreshIconCacheStatus();
    }, 1500);
  }
});

els.btnDownloadIcons.onclick = async () => {
  els.btnDownloadIcons.disabled = true;
  els.iconProgress.style.display = 'inline-block';
  els.iconProgress.value = 0;
  els.iconProgress.max = 100;
  // Progress đã được listen ở init() → không cần đăng ký lại
  const r = await window.bigo.giftsDownloadIcons();
  els.btnDownloadIcons.disabled = false;
  els.iconCacheStatus.textContent = `Hoàn tất: ${r.ok} mới · ${r.skip} bỏ qua · ${r.fail} lỗi · tổng ${r.total}`;
};

async function reloadEffects() {
  effects = await window.bigo.effectsList();
  const opts = ['<option value="">— chọn file —</option>',
    ...effects.map(e => `<option value="${escapeHtml(e.file)}">${escapeHtml(e.file)}</option>`)];
  els.dlgFile.innerHTML = opts.join('');
}

async function persistMapping() {
  await window.bigo.mappingSave(mapping);
}

// =================== Gift Table ===================
function renderGiftTable() {
  const overlayMap = new Map(mapping.overlays.map(o => [o.id, o]));
  if (mapping.gifts.length === 0) {
    els.giftTableBody.innerHTML = '<tr><td colspan="6" style="color:#555;text-align:center;padding:20px">Chưa có quà nào — bấm "+ Thêm quà"</td></tr>';
  } else {
    els.giftTableBody.innerHTML = mapping.gifts.map(g => {
      const ov = overlayMap.get(g.overlayId);
      return `<tr data-id="${g.id}">
        <td>${g.matchKeys.map(k => `<code>${escapeHtml(k)}</code>`).join(' ')}</td>
        <td>${escapeHtml(g.alias || '')}</td>
        <td>${escapeHtml(g.group || '')}</td>
        <td>${g.mediaFile ? `<code>${escapeHtml(g.mediaFile)}</code>` : '<span style="color:#666">—</span>'}</td>
        <td>${ov ? escapeHtml(ov.name) : '<span style="color:#ff6b6b">overlay đã xoá</span>'}</td>
        <td class="actions-col">
          <button class="tiny" data-act="play" data-id="${g.id}">▶ Phát</button>
          <button class="tiny" data-act="edit" data-id="${g.id}">✏️</button>
          <button class="tiny danger" data-act="del" data-id="${g.id}">🗑</button>
        </td>
      </tr>`;
    }).join('');
  }
  els.giftTableBody.querySelectorAll('button[data-act]').forEach(b => {
    b.onclick = () => giftAction(b.dataset.act, b.dataset.id);
  });
  // Update group datalist
  const groups = [...new Set(mapping.gifts.map(g => g.group).filter(Boolean))];
  els.groupList.innerHTML = groups.map(g => `<option value="${escapeHtml(g)}"></option>`).join('');
}

async function giftAction(act, id) {
  const g = mapping.gifts.find(x => x.id === id);
  if (!g) return;
  if (act === 'edit') openGiftDialog(g);
  else if (act === 'del') {
    if (!confirm(`Xoá "${g.alias || g.matchKeys.join(',')}"?`)) return;
    mapping.gifts = mapping.gifts.filter(x => x.id !== id);
    await persistMapping();
    renderGiftTable();
  } else if (act === 'play') {
    if (!g.mediaFile || !g.overlayId) { alert('Quà chưa có file hoặc overlay'); return; }
    const r = await window.bigo.overlayPlay({ overlayId: g.overlayId, file: g.mediaFile });
    if (!r.ok) alert('Không phát được: ' + (r.error || 'unknown'));
  }
}

function openGiftDialog(gift = null) {
  els.giftDialogTitle.textContent = gift ? 'Sửa quà' : 'Thêm quà';
  els.dlgMatchKeys.value = gift ? gift.matchKeys.join(', ') : '';
  els.dlgAlias.value = gift?.alias || '';
  els.dlgGroup.value = gift?.group || '';
  els.dlgMasterQuery.value = '';
  els.dlgMasterResults.style.display = 'none';
  els.dlgMasterResults.innerHTML = '';
  // refresh overlay options
  els.dlgOverlay.innerHTML = mapping.overlays.length
    ? mapping.overlays.map(o => `<option value="${o.id}">${escapeHtml(o.name)}</option>`).join('')
    : '<option value="">(chưa có overlay)</option>';
  els.dlgOverlay.value = gift?.overlayId || mapping.overlays[0]?.id || '';
  els.dlgFile.value = gift?.mediaFile || '';
  els.giftDialog.dataset.editingId = gift?.id || '';
  els.giftDialog.showModal();
}

// Master search inside gift dialog
let masterSearchTimer = null;
els.dlgMasterQuery.addEventListener('input', () => {
  clearTimeout(masterSearchTimer);
  const q = els.dlgMasterQuery.value.trim();
  if (!q) {
    els.dlgMasterResults.style.display = 'none';
    els.dlgMasterResults.innerHTML = '';
    return;
  }
  masterSearchTimer = setTimeout(async () => {
    const results = await window.bigo.giftsLookup(q);
    if (!results.length) {
      els.dlgMasterResults.innerHTML = '<div style="padding:8px;color:#666">không tìm thấy</div>';
    } else {
      els.dlgMasterResults.innerHTML = results.map(g => {
        const src = g.localIcon || g.img_url || '';
        return `<div class="master-search-row" data-typeid="${g.typeid}" data-name="${escapeHtml(g.name)}">
          <img src="${escapeHtml(src)}" loading="lazy" draggable="true" data-typeid="${g.typeid}" title="Kéo ra desktop để lưu ${g.typeid}.png" />
          <div><b>${escapeHtml(g.name)}</b></div>
          <div class="id">id ${g.typeid}</div>
          <div class="price">💎 ${g.diamonds ?? '?'}</div>
        </div>`;
      }).join('');
      els.dlgMasterResults.querySelectorAll('.master-search-row').forEach(row => {
        row.onclick = (e) => {
          if (e.target.tagName === 'IMG') return; // image drag, không trigger click
          const name = row.dataset.name;
          const typeid = row.dataset.typeid;
          // Match key có thể là gift_id (số) hoặc name. Dùng cả 2 cho linh hoạt.
          const cur = els.dlgMatchKeys.value.split(',').map(s => s.trim()).filter(Boolean);
          if (!cur.includes(typeid)) cur.push(typeid);
          if (!cur.includes(name)) cur.push(name);
          els.dlgMatchKeys.value = cur.join(', ');
          if (!els.dlgAlias.value) els.dlgAlias.value = name;
          els.dlgMasterResults.style.display = 'none';
          els.dlgMasterResults.innerHTML = '';
          els.dlgMasterQuery.value = '';
        };
      });
      // Native drag — kéo icon ra desktop, file lưu thành <typeid>.png
      els.dlgMasterResults.querySelectorAll('img[draggable]').forEach(img => {
        img.ondragstart = (e) => {
          e.preventDefault();
          window.bigo.giftsStartDrag(parseInt(img.dataset.typeid, 10));
        };
      });
    }
    els.dlgMasterResults.style.display = 'block';
  }, 200);
});

els.dlgGiftSave.onclick = async (e) => {
  // dialog default behavior closes form; we hijack save
  if (!els.dlgMatchKeys.value.trim()) { e.preventDefault(); alert('Match keys không được trống'); return; }
  const id = els.giftDialog.dataset.editingId;
  const matchKeys = els.dlgMatchKeys.value.split(',').map(s => s.trim()).filter(Boolean);
  const data = {
    id: id || uid('g_'),
    matchKeys,
    alias: els.dlgAlias.value.trim(),
    group: els.dlgGroup.value.trim(),
    mediaFile: els.dlgFile.value,
    overlayId: els.dlgOverlay.value,
  };
  if (id) {
    const idx = mapping.gifts.findIndex(g => g.id === id);
    if (idx !== -1) mapping.gifts[idx] = data;
  } else {
    mapping.gifts.push(data);
  }
  await persistMapping();
  renderGiftTable();
};

els.btnAddGift.onclick = () => {
  if (mapping.overlays.length === 0) { alert('Tạo ít nhất 1 overlay trước (tab Overlay)'); return; }
  openGiftDialog();
};

els.btnTestGift.onclick = async () => {
  if (mapping.gifts.length === 0) { alert('Chưa có quà nào'); return; }
  const g = mapping.gifts[0];
  await window.bigo.overlayPlay({ overlayId: g.overlayId, file: g.mediaFile });
};

// =================== Overlay Table ===================
function renderOverlayTable() {
  if (mapping.overlays.length === 0) {
    els.overlayTableBody.innerHTML = '<tr><td colspan="7" style="color:#555;text-align:center;padding:20px">Chưa có overlay — bấm "+ Thêm overlay"</td></tr>';
  } else {
    els.overlayTableBody.innerHTML = mapping.overlays.map(o => {
      const b = o.bounds || {};
      return `<tr data-id="${o.id}">
        <td>${escapeHtml(o.name)}</td>
        <td><span class="color-swatch" style="background:${o.bgColor}"></span><code>${escapeHtml(o.bgColor)}</code></td>
        <td>${Math.round((o.opacity ?? 1) * 100)}%</td>
        <td>${b.width || '?'} × ${b.height || '?'}</td>
        <td>${b.x != null ? `${Math.round(b.x)}, ${Math.round(b.y)}` : 'auto'}</td>
        <td>${o.alwaysOnTop ? '✓' : '—'}</td>
        <td class="actions-col">
          <button class="tiny" data-act="show" data-id="${o.id}">👁 Hiện</button>
          <button class="tiny" data-act="hide" data-id="${o.id}">🙈 Ẩn</button>
          <button class="tiny" data-act="edit" data-id="${o.id}">✏️</button>
          <button class="tiny danger" data-act="del" data-id="${o.id}">🗑</button>
        </td>
      </tr>`;
    }).join('');
  }
  els.overlayTableBody.querySelectorAll('button[data-act]').forEach(b => {
    b.onclick = () => overlayAction(b.dataset.act, b.dataset.id);
  });
}

async function overlayAction(act, id) {
  const o = mapping.overlays.find(x => x.id === id);
  if (!o) return;
  if (act === 'show') {
    const r = await window.bigo.overlayShow(id);
    if (!r.ok) alert('Lỗi: ' + (r.error || 'unknown'));
  } else if (act === 'hide') {
    await window.bigo.overlayHide(id);
  } else if (act === 'edit') {
    openOverlayDialog(o);
  } else if (act === 'del') {
    const usingGifts = mapping.gifts.filter(g => g.overlayId === id);
    let msg = `Xoá overlay "${o.name}"?`;
    if (usingGifts.length) msg += `\n${usingGifts.length} quà đang dùng overlay này sẽ bị unmap.`;
    if (!confirm(msg)) return;
    await window.bigo.overlayDelete(id);
    mapping.overlays = mapping.overlays.filter(x => x.id !== id);
    mapping.gifts.forEach(g => { if (g.overlayId === id) g.overlayId = mapping.overlays[0]?.id || ''; });
    await persistMapping();
    renderOverlayTable();
    renderGiftTable();
  }
}

els.ovOpacity.oninput = () => { els.ovOpacityVal.textContent = els.ovOpacity.value; };

function openOverlayDialog(ov = null) {
  els.overlayDialogTitle.textContent = ov ? 'Sửa overlay' : 'Thêm overlay';
  els.ovName.value = ov?.name || `Overlay ${mapping.overlays.length + 1}`;
  els.ovBgColor.value = ov?.bgColor || '#00FF00';
  const op = Math.round((ov?.opacity ?? 1) * 100);
  els.ovOpacity.value = op; els.ovOpacityVal.textContent = op;
  els.ovW.value = ov?.bounds?.width || 540;
  els.ovH.value = ov?.bounds?.height || 960;
  els.ovTop.checked = ov?.alwaysOnTop !== false;
  els.overlayDialog.dataset.editingId = ov?.id || '';
  els.overlayDialog.showModal();
}

els.dlgOverlaySave.onclick = async (e) => {
  if (!els.ovName.value.trim()) { e.preventDefault(); alert('Tên overlay không được trống'); return; }
  const id = els.overlayDialog.dataset.editingId;
  const existing = id ? mapping.overlays.find(o => o.id === id) : null;
  const data = {
    id: id || uid('ov_'),
    name: els.ovName.value.trim(),
    bgColor: els.ovBgColor.value,
    opacity: parseInt(els.ovOpacity.value, 10) / 100,
    bounds: {
      x: existing?.bounds?.x ?? null,
      y: existing?.bounds?.y ?? null,
      width: parseInt(els.ovW.value, 10) || 540,
      height: parseInt(els.ovH.value, 10) || 960,
    },
    alwaysOnTop: els.ovTop.checked,
  };
  if (existing) {
    Object.assign(existing, data);
    await window.bigo.overlayApplyConfig(existing);
  } else {
    mapping.overlays.push(data);
    await persistMapping();
  }
  renderOverlayTable();
  renderGiftTable();
};

els.btnAddOverlay.onclick = () => openOverlayDialog();

// =================== Embed flow (auto-listen) ===================
function resetEmbedUi() {
  els.metaPanel.style.display = 'none';
  els.metaInfo.innerHTML = '';
  els.liveChats.innerHTML = '';
  els.liveGifts.innerHTML = '';
}

els.btnConnect.onclick = async () => {
  const id = els.embedBigoId.value.trim();
  if (!id) { alert('Nhập BIGO ID'); return; }

  els.btnConnect.disabled = true;
  els.status.textContent = 'checking...';
  els.status.classList.remove('on');

  // 1. Stop session cũ + clear UI
  await window.bigo.embedStop();
  resetEmbedUi();

  // 2. Check live
  const check = await window.bigo.checkLive(id);
  if (!check.ok) {
    els.liveInfo.textContent = `Lỗi check live: ${check.error}`;
    els.liveInfo.className = 'live-info dead';
    els.btnConnect.disabled = false;
    return;
  }
  const d = check.data?.data || {};
  if (d.alive !== 1) {
    els.liveInfo.className = 'live-info dead';
    els.liveInfo.textContent = `🔴 OFFLINE — ${d.nick_name || 'không tìm thấy ID'}`;
    els.status.textContent = 'offline';
    els.btnConnect.disabled = false;
    return;
  }

  els.liveInfo.className = 'live-info live';
  els.liveInfo.textContent = `🟢 LIVE — ${d.nick_name} · roomId=${d.roomId} · uid=${d.uid} · "${d.roomTopic || ''}"`;

  // 3. Lưu BIGO ID
  const s = await window.bigo.settingsLoad();
  s.bigoId = id;
  await window.bigo.settingsSave(s);

  // 4. Start embed listener
  els.status.textContent = 'connecting...';
  const res = await window.bigo.embedStart({ bigoId: id, visible: false });
  if (!res.ok) {
    els.btnConnect.disabled = false;
    appendLog(`embed failed: ${res.error}`);
    alert(`Lỗi: ${res.error}`);
    return;
  }
  els.status.textContent = `listening · ${id}`;
  els.status.classList.add('on');
  els.btnConnect.disabled = false;
  els.btnEmbedStop.disabled = false;
  els.btnEmbedShow.disabled = false;
  appendLog(`connected to ${id}`);
};

els.btnEmbedStop.onclick = async () => {
  await window.bigo.embedStop();
  els.status.textContent = 'disconnected';
  els.status.classList.remove('on');
  els.btnEmbedStop.disabled = true;
  els.btnEmbedShow.disabled = true;
  resetEmbedUi();
};

els.btnEmbedShow.onclick = async () => {
  const r = await window.bigo.embedShow();
  if (!r.ok) appendLog('embed-show: ' + (r.error || 'no listener'));
};

// =================== Embed parsed events ===================
function findGiftByName(name) {
  if (!name) return null;
  const lower = name.toLowerCase();
  return mapping.gifts.find(g => g.matchKeys.some(k => k.toLowerCase() === lower));
}

function findGiftByEvent(ev) {
  // Ưu tiên match theo gift_id (chính xác nhất nếu master đã enrich)
  if (ev.gift_id != null) {
    const byId = mapping.gifts.find(g => g.matchKeys.some(k => String(k) === String(ev.gift_id)));
    if (byId) return byId;
  }
  return findGiftByName(ev.gift_name);
}

function renderParsed(ev) {
  if (ev.type === 'chat') {
    const div = document.createElement('div');
    div.className = 'chat-row';
    const av = ev.user_avatar_url ? `<img class="avatar" src="${escapeHtml(ev.user_avatar_url)}" loading="lazy" style="width:20px;height:20px" />` : '';
    div.innerHTML = `${av}<span class="lvl">Lv.${ev.level}</span><span class="who">${escapeHtml(ev.user)}</span><span class="what">${escapeHtml(ev.content)}</span>`;
    els.liveChats.prepend(div);
    while (els.liveChats.children.length > 200) els.liveChats.lastChild.remove();
    return;
  }
  if (ev.type === 'gift' || ev.type === 'gift_overlay') {
    const matched = findGiftByEvent(ev);
    const div = document.createElement('div');
    div.className = 'gift-row';
    const avatar = ev.user_avatar_url
      ? `<img class="avatar" src="${escapeHtml(ev.user_avatar_url)}" loading="lazy" />`
      : `<div class="avatar"></div>`;
    const giftIconUrl = ev.gift_icon || ev.gift_icon_url || '';
    const dragAttrs = ev.gift_id != null ? `draggable="true" data-typeid="${ev.gift_id}" title="Kéo ra desktop để lưu ${ev.gift_id}.png"` : '';
    const giftIcon = giftIconUrl ? `<img class="gift-icon" src="${escapeHtml(giftIconUrl)}" loading="lazy" ${dragAttrs} />` : '';
    const idText = ev.gift_id != null
      ? `id <b>${ev.gift_id}</b>${ev.gift_value != null ? ` · 💎 ${ev.gift_value}` : ''}`
      : (ev.gift_ambiguous ? `<span style="color:#ff9a4a">${ev.gift_ambiguous} match</span>` : '<span style="color:#666">chưa map id</span>');
    const totalCount = ev.total_count != null ? ev.total_count : (ev.gift_count || 1) * (ev.combo || 1);
    const totalDiamond = ev.total_diamond != null
      ? ev.total_diamond
      : (ev.gift_value != null ? totalCount * ev.gift_value : null);
    const beansLine = totalDiamond != null
      ? `<span class="beans">💎 ${totalDiamond}</span>`
      : '';
    const matchedBadge = matched ? `<span class="matched">▶ ${escapeHtml(matched.alias || matched.matchKeys.join(','))}</span>` : '';
    const userLine = ev.level != null
      ? `<span class="lvl">Lv.${ev.level}</span><span class="who">${escapeHtml(ev.user)}</span>`
      : `<span class="who">${escapeHtml(ev.user)}</span>`;
    const cntStr = ev.type === 'gift_overlay' && ev.combo > 1
      ? `×${ev.gift_count} · combo ${ev.combo}`
      : `×${ev.gift_count}`;
    div.innerHTML = `
      ${avatar}
      <div class="body">
        <div class="row1">${userLine}${matchedBadge}</div>
        <div class="row2">${giftIcon}<span class="what">${escapeHtml(ev.gift_name || '?')}</span><span class="gift-id">${idText}</span></div>
      </div>
      <div class="right"><span class="cnt">${cntStr}</span>${beansLine}</div>
    `;
    els.liveGifts.prepend(div);
    while (els.liveGifts.children.length > 200) els.liveGifts.lastChild.remove();

    // Native drag handler cho icon trong panel quà nhận
    const draggableImg = div.querySelector('img[draggable]');
    if (draggableImg) {
      draggableImg.ondragstart = (e) => {
        e.preventDefault();
        window.bigo.giftsStartDrag(parseInt(draggableImg.dataset.typeid, 10));
      };
    }

    if (ev.type === 'gift' && matched && matched.mediaFile && matched.overlayId) {
      window.bigo.overlayPlay({ overlayId: matched.overlayId, file: matched.mediaFile });
    }
  }
}

function renderEmbedEvent(ev) {
  if (ev.kind === 'parsed') return renderParsed(ev);
  if (ev.kind === 'meta') {
    els.metaPanel.style.display = 'block';
    const parts = [];
    if (ev.bigoId) parts.push(`<span><b>BIGO ID</b>: ${escapeHtml(ev.bigoId)}</span>`);
    if (ev.title) parts.push(`<span><b>Title</b>: ${escapeHtml(ev.title)}</span>`);
    els.metaInfo.innerHTML = parts.join('');
    return;
  }
  if (ev.kind === 'dom-attached' || ev.kind === 'ready') {
    appendLog(`embed ${ev.kind}: ${ev._frame || ev.url || ''}`);
  }
  if (ev.kind === 'scrape-error') appendLog(`scrape error: ${ev.msg}`);
}

// =================== Open API tab ===================
els.btnSave.onclick = async () => {
  await window.bigo.settingsSave({
    env: els.env.value, bigoId: els.bigoId.value.trim(),
    openid: els.openid.value.trim(), gameId: els.gameId.value.trim(),
    accessToken: els.accessToken.value.trim(),
  });
  appendLog('settings saved');
};
els.btnStart.onclick = async () => {
  await els.btnSave.onclick();
  els.btnStart.disabled = true;
  els.status.textContent = 'connecting...';
  const res = await window.bigo.start({
    env: els.env.value, accessToken: els.accessToken.value.trim(),
    gameId: els.gameId.value.trim(), openid: els.openid.value.trim(),
  });
  if (res.ok) {
    els.status.textContent = `OAuth · sess=${res.gameSess.slice(0, 8)}`;
    els.status.classList.add('on');
    els.btnStop.disabled = false;
  } else {
    els.status.textContent = 'error';
    els.btnStart.disabled = false;
    appendLog(`OAuth start failed: ${res.error}`);
    alert(`Không kết nối được: ${res.error}`);
  }
};
els.btnStop.onclick = async () => {
  await window.bigo.stop();
  els.status.textContent = 'disconnected';
  els.status.classList.remove('on');
  els.btnStop.disabled = true;
  els.btnStart.disabled = false;
};
els.btnTestHeart.onclick = () => window.bigo.testEvent('heart');
els.btnTestMsg.onclick = () => window.bigo.testEvent('msg');

function handleOpenApiEvent(ev) {
  const div = document.createElement('div');
  div.className = `event ${ev.type || 'msg'}`;
  let line;
  if (ev.type === 'gift') {
    line = `🎁 [${ev.nick_name || ev.user}] ${ev.gift_name || ev.gift_id} ×${ev.gift_count || 1}`;
    const matched = findGiftByName(ev.gift_name);
    if (matched && matched.mediaFile && matched.overlayId) {
      window.bigo.overlayPlay({ overlayId: matched.overlayId, file: matched.mediaFile });
    }
  } else if (ev.type === 'heart') line = `❤ [${ev.nick_name || ev.user}] +${ev.count || 1}`;
  else if (ev.type === 'msg') line = `💬 [${ev.nick_name || ev.user}] ${ev.content || ''}`;
  else line = JSON.stringify(ev);
  div.textContent = `${new Date().toLocaleTimeString()} ${line}`;
  els.events.prepend(div);
  while (els.events.children.length > 200) els.events.lastChild.remove();
}

// =================== Wire up ===================
window.bigo.onEvent(handleOpenApiEvent);
window.bigo.onLog(appendLog);
window.bigo.onEmbedEvent(renderEmbedEvent);

init();
