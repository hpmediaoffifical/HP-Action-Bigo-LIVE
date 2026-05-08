const $ = (id) => document.getElementById(id);

// =================== State ===================
let mapping = { version: 2, gifts: [], overlays: [], groups: [] };
let effects = [];

// Stats tổng tracking - reset khi connect/disconnect room mới
const sessionStats = {
  effects: 0,        // số hiệu ứng đã trigger play
  diamond: 0,        // tổng đậu nhận
  giftCount: 0,      // tổng quà count nhận
  users: new Set(),  // unique user names
};
function resetSessionStats() {
  sessionStats.effects = 0;
  sessionStats.diamond = 0;
  sessionStats.giftCount = 0;
  sessionStats.users.clear();
  updateConnectStats();
}
function updateConnectStats() {
  if (!els.csEffects) return;
  els.csEffects.textContent = sessionStats.effects;
  els.csDiamond.textContent = sessionStats.diamond;
  els.csUsers.textContent = sessionStats.users.size;
  els.csGifts.textContent = sessionStats.giftCount;
}

// =================== Effect Queue State ===================
const queueItems = []; // { id, ts, user, avatar, gift_id, gift_name, gift_icon, count, diamond, status }
const QUEUE_MAX = 100;
const PLAY_DURATION_MS = 5000; // assume effect ~5s — TODO sync với 'ended' từ overlay sau

function loadQueueSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('queueSettings') || '{}');
    if (s.font) els.qSizeFont.value = s.font;
    if (s.icon) els.qSizeIcon.value = s.icon;
  } catch {}
  applyQueueSize();
}
function saveQueueSettings() {
  localStorage.setItem('queueSettings', JSON.stringify({
    font: els.qSizeFont.value, icon: els.qSizeIcon.value,
  }));
}
function applyQueueSize() {
  const font = els.qSizeFont.value;
  const icon = els.qSizeIcon.value;
  els.effectQueue.style.setProperty('--queue-font', font + 'px');
  els.effectQueue.style.setProperty('--queue-icon', icon + 'px');
  els.qSizeFontVal.textContent = font;
  els.qSizeIconVal.textContent = icon;
}

function pushQueue(ev, matched, playTimes) {
  // Chỉ push gift events có hiệu ứng được map
  if (!matched || !matched.mediaFile) return;
  const item = {
    id: 'q_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
    ts: Date.now(),
    user: ev.user || '?',
    avatar: ev.user_avatar_url || '',
    gift_id: ev.gift_id,
    gift_name: ev.gift_name || matched.alias || '?',
    gift_icon: ev.gift_icon || ev.gift_icon_url || '',
    count: ev.gift_count || 1,
    combo: ev.combo || 1,
    playTimes: playTimes || 1,
    diamond: ev.total_diamond,
    mediaFile: matched.mediaFile,
    overlayId: matched.overlayId,
    status: 'queued',
  };
  queueItems.unshift(item);
  if (queueItems.length > QUEUE_MAX) queueItems.length = QUEUE_MAX;
  renderQueue();
  updateQueueStats();

  // Mark as playing sau 1 chút (giả định push vào overlay queue → sẽ play)
  setTimeout(() => {
    const found = queueItems.find(q => q.id === item.id);
    if (found && found.status === 'queued') {
      found.status = 'playing';
      renderQueue();
      // Sau 5s giả định effect xong (TODO: thay bằng IPC từ overlay khi ended)
      setTimeout(() => {
        const f2 = queueItems.find(q => q.id === item.id);
        if (f2) { f2.status = 'done'; renderQueue(); }
      }, PLAY_DURATION_MS);
    }
  }, 100);
}

function renderQueue() {
  if (!queueItems.length) {
    els.effectQueue.innerHTML = '<div style="color:#555;text-align:center;padding:16px">Chưa có hiệu ứng nào trong hàng đợi</div>';
    return;
  }
  els.effectQueue.innerHTML = queueItems.map(q => {
    const avatarHtml = q.avatar
      ? `<img class="avatar" src="${escapeHtml(q.avatar)}" loading="lazy" />`
      : `<div class="avatar"></div>`;
    const giftIconHtml = q.gift_icon
      ? `<img class="gift-icon" src="${escapeHtml(q.gift_icon)}" loading="lazy" />`
      : `<div class="gift-icon"></div>`;
    const statusBadge = q.status === 'playing'
      ? '<span class="badge-status playing">▶ ĐANG PHÁT</span>'
      : q.status === 'done' ? '<span class="badge-status done">✓ xong</span>'
      : '<span class="badge-status queued">⏳ chờ</span>';
    const playInfo = q.playTimes > 1 ? `<span style="color:#ffd166"> · phát ${q.playTimes} lần</span>` : '';
    return `<div class="queue-row ${q.status}" data-id="${q.id}">
      ${avatarHtml}
      ${giftIconHtml}
      <div class="meta">
        <div class="who">${escapeHtml(q.user)}${statusBadge}</div>
        <div class="what">tặng <span class="name">${escapeHtml(q.gift_name)}</span>${q.gift_id ? ` <span style="color:#666">id ${q.gift_id}</span>` : ''}${playInfo}</div>
      </div>
      <div class="right">
        <div class="cnt">×${q.count}${q.combo > 1 ? ` · combo ${q.combo}` : ''}</div>
        ${q.diamond != null ? `<div class="beans">💎 ${q.diamond}</div>` : ''}
      </div>
    </div>`;
  }).join('');
}

function updateQueueStats() {
  const totalGifts = queueItems.reduce((s, q) => s + (q.count || 0), 0);
  const totalDiamond = queueItems.reduce((s, q) => s + (q.diamond || 0), 0);
  const users = new Set(queueItems.map(q => q.user)).size;
  els.qStatGifts.textContent = totalGifts;
  els.qStatDiamond.textContent = totalDiamond;
  els.qStatUsers.textContent = users;
}

// =================== DOM refs ===================
const els = {
  status: $('status'), log: $('log'),
  // Embed tab
  embedBigoId: $('embedBigoId'),
  btnConnect: $('btnConnect'), btnEmbedShow: $('btnEmbedShow'),
  liveInfo: $('liveInfo'),
  metaPanel: $('metaPanel'), metaInfo: $('metaInfo'),
  liveChats: $('liveChats'), liveGifts: $('liveGifts'),
  csEffects: $('csEffects'), csDiamond: $('csDiamond'), csUsers: $('csUsers'), csGifts: $('csGifts'),
  btnPopupGifts: $('btnPopupGifts'),
  effectQueue: $('effectQueue'), btnClearQueue: $('btnClearQueue'),
  qStatGifts: $('qStatGifts'), qStatDiamond: $('qStatDiamond'), qStatUsers: $('qStatUsers'),
  qSizeFont: $('qSizeFont'), qSizeFontVal: $('qSizeFontVal'),
  qSizeIcon: $('qSizeIcon'), qSizeIconVal: $('qSizeIconVal'),
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
  dlgPickFile: $('dlgPickFile'), dlgOpenFolder: $('dlgOpenFolder'),
  dlgMasterFilter: $('dlgMasterFilter'), dlgMasterSort: $('dlgMasterSort'),
  dlgMasterTableBody: $('dlgMasterTableBody'), dlgMasterCount: $('dlgMasterCount'),
  // Overlay modal
  overlayDialog: $('overlayDialog'), overlayDialogTitle: $('overlayDialogTitle'),
  ovName: $('ovName'), ovBgColor: $('ovBgColor'), ovOpacity: $('ovOpacity'), ovOpacityVal: $('ovOpacityVal'),
  ovW: $('ovW'), ovH: $('ovH'), ovTop: $('ovTop'), ovClickThrough: $('ovClickThrough'),
  dlgOverlaySave: $('dlgOverlaySave'),
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

// =================== Queue listeners (sau khi els đã declared) ===================
els.qSizeFont.addEventListener('input', () => { applyQueueSize(); saveQueueSettings(); });
els.qSizeIcon.addEventListener('input', () => { applyQueueSize(); saveQueueSettings(); });
els.btnClearQueue.onclick = () => {
  queueItems.length = 0;
  renderQueue();
  updateQueueStats();
};

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
  loadQueueSettings();
  renderQueue();
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

els.dlgPickFile.onclick = async () => {
  const r = await window.bigo.effectsPickFiles();
  if (!r.ok) return;
  await reloadEffects();
  if (r.copied && r.copied.length) {
    // Auto-select file vừa thêm (đầu tiên)
    els.dlgFile.value = r.copied[0];
    appendLog(`đã copy ${r.copied.length} file vào assets/effects`);
  }
};
els.dlgOpenFolder.onclick = () => window.bigo.effectsOpenFolder();

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

// Cache master list 1 lần khi mở modal đầu tiên
let masterFullList = null;

async function ensureMasterLoaded() {
  if (masterFullList) return;
  masterFullList = await window.bigo.giftsMasterList();
}

function sortMasterArr(arr, key) {
  const nameCmp = (a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'vi', { sensitivity: 'base' });
  switch (key) {
    case 'id-desc': return arr.sort((a, b) => b.typeid - a.typeid);
    case 'kc-asc': return arr.sort((a, b) => (a.diamonds || 0) - (b.diamonds || 0));
    case 'kc-desc': return arr.sort((a, b) => (b.diamonds || 0) - (a.diamonds || 0));
    case 'name-asc': return arr.sort(nameCmp);
    case 'name-desc': return arr.sort((a, b) => nameCmp(b, a));
    case 'id-asc':
    default: return arr.sort((a, b) => a.typeid - b.typeid);
  }
}

function renderMasterTable() {
  if (!masterFullList) {
    els.dlgMasterCount.textContent = 'đang tải...';
    return;
  }
  const filter = els.dlgMasterFilter.value.toLowerCase().trim();
  const sortKey = els.dlgMasterSort.value;
  let arr = masterFullList.slice();
  if (filter) {
    arr = arr.filter(g => {
      const n = String(g.name || '').toLowerCase();
      const id = String(g.typeid || '');
      return n.includes(filter) || id.includes(filter);
    });
  }
  sortMasterArr(arr, sortKey);
  els.dlgMasterCount.textContent = `${arr.length}/${masterFullList.length} quà`;
  // Limit render to 500 first to avoid lag, but show count
  const renderLimit = 500;
  const display = arr.slice(0, renderLimit);
  els.dlgMasterTableBody.innerHTML = display.map(g => {
    const src = g.localIcon || g.img_url || '';
    return `<tr data-typeid="${g.typeid}" data-name="${escapeHtml(g.name)}">
      <td><img src="${escapeHtml(src)}" loading="lazy" draggable="true" data-typeid="${g.typeid}" title="Kéo ra desktop = ${g.typeid}.png" /></td>
      <td><span class="id">${g.typeid}</span></td>
      <td><span class="price">💎 ${g.diamonds ?? '?'}</span></td>
      <td><span class="name">${escapeHtml(g.name)}</span></td>
    </tr>`;
  }).join('');
  if (arr.length > renderLimit) {
    els.dlgMasterCount.textContent += ` · hiển thị ${renderLimit} đầu — gõ filter để thu hẹp`;
  }
  // Click row -> add to matchKeys
  els.dlgMasterTableBody.querySelectorAll('tr').forEach(row => {
    row.onclick = (e) => {
      if (e.target.tagName === 'IMG') return;
      const name = row.dataset.name;
      const typeid = row.dataset.typeid;
      const cur = els.dlgMatchKeys.value.split(',').map(s => s.trim()).filter(Boolean);
      if (!cur.includes(typeid)) cur.push(typeid);
      if (!cur.includes(name)) cur.push(name);
      els.dlgMatchKeys.value = cur.join(', ');
      if (!els.dlgAlias.value) els.dlgAlias.value = name;
    };
  });
  // Drag icon ra desktop
  els.dlgMasterTableBody.querySelectorAll('img[draggable]').forEach(img => {
    img.ondragstart = (e) => {
      e.preventDefault();
      window.bigo.giftsStartDrag(parseInt(img.dataset.typeid, 10));
    };
  });
}

let masterRenderTimer = null;
function scheduleRenderMaster() {
  clearTimeout(masterRenderTimer);
  masterRenderTimer = setTimeout(renderMasterTable, 80);
}
els.dlgMasterFilter.addEventListener('input', scheduleRenderMaster);
els.dlgMasterSort.addEventListener('change', renderMasterTable);

async function openGiftDialog(gift = null) {
  els.giftDialogTitle.textContent = gift ? 'Sửa quà' : 'Thêm quà';
  els.dlgMatchKeys.value = gift ? gift.matchKeys.join(', ') : '';
  els.dlgAlias.value = gift?.alias || '';
  els.dlgGroup.value = gift?.group || '';
  els.dlgMasterFilter.value = '';
  els.dlgMasterSort.value = 'id-asc';
  // refresh overlay options
  els.dlgOverlay.innerHTML = mapping.overlays.length
    ? mapping.overlays.map(o => `<option value="${o.id}">${escapeHtml(o.name)}</option>`).join('')
    : '<option value="">(chưa có overlay)</option>';
  els.dlgOverlay.value = gift?.overlayId || mapping.overlays[0]?.id || '';
  els.dlgFile.value = gift?.mediaFile || '';
  els.giftDialog.dataset.editingId = gift?.id || '';
  els.giftDialog.showModal();
  await ensureMasterLoaded();
  renderMasterTable();
}

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
    els.overlayTableBody.innerHTML = '<tr><td colspan="8" style="color:#555;text-align:center;padding:20px">Chưa có overlay — bấm "+ Thêm overlay"</td></tr>';
  } else {
    els.overlayTableBody.innerHTML = mapping.overlays.map(o => {
      const b = o.bounds || {};
      const lockBtn = o.clickThrough
        ? `<button class="tiny" data-act="unlock" data-id="${o.id}" title="Đang khoá - bấm để mở khoá">🔓</button>`
        : `<button class="tiny" data-act="lock" data-id="${o.id}" title="Bật click-through OBS mode">🔒</button>`;
      return `<tr data-id="${o.id}">
        <td>${escapeHtml(o.name)}</td>
        <td><span class="color-swatch" style="background:${o.bgColor}"></span><code>${escapeHtml(o.bgColor)}</code></td>
        <td>${Math.round((o.opacity ?? 1) * 100)}%</td>
        <td>${b.width || '?'} × ${b.height || '?'}</td>
        <td>${b.x != null ? `${Math.round(b.x)}, ${Math.round(b.y)}` : 'auto'}</td>
        <td>${o.alwaysOnTop ? '✓' : '—'}</td>
        <td>${o.clickThrough ? '🔒 Có' : '—'}</td>
        <td class="actions-col">
          <button class="tiny" data-act="show" data-id="${o.id}" title="Mở/hiện overlay">👁</button>
          <button class="tiny" data-act="hide" data-id="${o.id}" title="Ẩn overlay (gift về vẫn auto-show + play)">🙈</button>
          ${lockBtn}
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
  } else if (act === 'lock' || act === 'unlock') {
    o.clickThrough = (act === 'lock');
    await window.bigo.overlayApplyConfig({ ...o });
    renderOverlayTable();
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
  els.ovClickThrough.checked = !!ov?.clickThrough;
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
    clickThrough: els.ovClickThrough.checked,
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
  resetSessionStats();
  // Reset popup nếu đang mở
  if (window.bigo.popupResetGifts) window.bigo.popupResetGifts().catch(() => {});
}

// Toggle state: false=disconnected, true=connected
let isConnected = false;

function setConnectedUi(yes) {
  isConnected = yes;
  if (yes) {
    els.btnConnect.textContent = '⏹ Hủy kết nối';
    els.btnConnect.classList.remove('primary');
    els.btnConnect.classList.add('danger');
    els.btnEmbedShow.disabled = false;
  } else {
    els.btnConnect.textContent = '🔌 Kết nối phòng';
    els.btnConnect.classList.add('primary');
    els.btnConnect.classList.remove('danger');
    els.btnEmbedShow.disabled = true;
  }
}

async function disconnect() {
  await window.bigo.embedStop();
  els.status.textContent = 'disconnected';
  els.status.classList.remove('on');
  setConnectedUi(false);
  els.liveInfo.textContent = 'Đã hủy kết nối. Nhập BIGO ID khác và bấm Kết nối phòng.';
  els.liveInfo.className = 'live-info-inline';
  resetEmbedUi();
}

els.btnConnect.onclick = async () => {
  // Toggle: nếu đang connect → disconnect
  if (isConnected) {
    await disconnect();
    return;
  }
  const id = els.embedBigoId.value.trim();
  if (!id) { alert('Nhập BIGO ID'); return; }

  els.btnConnect.disabled = true;
  els.status.textContent = 'checking...';
  els.status.classList.remove('on');

  // 1. Stop session cũ + clear UI (đề phòng)
  await window.bigo.embedStop();
  resetEmbedUi();

  // 2. Check live
  const check = await window.bigo.checkLive(id);
  if (!check.ok) {
    els.liveInfo.textContent = `Lỗi check live: ${check.error}`;
    els.liveInfo.className = 'live-info-inline dead';
    els.btnConnect.disabled = false;
    return;
  }
  const d = check.data?.data || {};
  if (d.alive !== 1) {
    els.liveInfo.className = 'live-info-inline dead';
    els.liveInfo.textContent = `🔴 OFFLINE — ${d.nick_name || 'không tìm thấy ID'}`;
    els.status.textContent = 'offline';
    els.btnConnect.disabled = false;
    return;
  }

  els.liveInfo.className = 'live-info-inline live';
  els.liveInfo.textContent = `🟢 LIVE — ${d.nick_name} · roomId=${d.roomId} · uid=${d.uid} · "${d.roomTopic || ''}"`;

  // 3. Lưu BIGO ID
  const s = await window.bigo.settingsLoad();
  s.bigoId = id;
  await window.bigo.settingsSave(s);

  // 4. Start embed listener
  els.status.textContent = 'connecting...';
  const res = await window.bigo.embedStart({ bigoId: id, visible: false });
  els.btnConnect.disabled = false;
  if (!res.ok) {
    appendLog(`embed failed: ${res.error}`);
    alert(`Lỗi: ${res.error}`);
    return;
  }
  els.status.textContent = `listening · ${id}`;
  els.status.classList.add('on');
  setConnectedUi(true);
  appendLog(`connected to ${id}`);
};

els.btnPopupGifts.onclick = () => window.bigo.popupOpenGifts();

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
    // Update session stats (chỉ count gift, không count gift_overlay duplicate)
    if (ev.type === 'gift') {
      sessionStats.giftCount += (ev.gift_count || 1) * (ev.combo || 1);
      sessionStats.diamond += ev.total_diamond || 0;
      if (ev.user) sessionStats.users.add(ev.user);
      if (matched && matched.mediaFile) {
        sessionStats.effects += Math.max(1, Math.min(50, ev.total_count || ev.gift_count || 1));
      }
      updateConnectStats();
    }
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
      // Combo: tặng N lần thì phát N lần. total_count = gift_count × combo (combo mặc định 1).
      // Cap 50 để tránh spam quá đáng (vd tặng 1000 quà combo).
      const playTimes = Math.max(1, Math.min(50, ev.total_count || ev.gift_count || 1));
      for (let i = 0; i < playTimes; i++) {
        window.bigo.overlayPlay({ overlayId: matched.overlayId, file: matched.mediaFile });
      }
      pushQueue(ev, matched, playTimes);
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
