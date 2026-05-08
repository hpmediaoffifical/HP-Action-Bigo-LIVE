const $ = (id) => document.getElementById(id);

// =================== State ===================
let mapping = { version: 3, groups: [], overlays: [] };
let effects = [];

// =================== Helper: groups & items ===================
// v3: mapping.groups = [{ id, name, type, enabled, collapsed, bigoId, items: [...] }]
// Backward-compat: nếu mapping.gifts (v2 flat) tồn tại, treat như 1 group default
function getAllItems() {
  if (Array.isArray(mapping.groups)) {
    return mapping.groups.flatMap(g => (g.items || []).map(item => ({ ...item, _group: g })));
  }
  return (mapping.gifts || []).map(item => ({ ...item, _group: null }));
}
function getEnabledGiftItems() {
  if (Array.isArray(mapping.groups)) {
    return mapping.groups
      .filter(g => g.enabled !== false && g.type !== 'comment')
      .flatMap(g => (g.items || []).map(item => ({ ...item, _group: g })));
  }
  return (mapping.gifts || []).map(item => ({ ...item, _group: null }));
}
function getEnabledCommentItems() {
  if (Array.isArray(mapping.groups)) {
    return mapping.groups
      .filter(g => g.enabled !== false && g.type === 'comment')
      .flatMap(g => (g.items || []).map(item => ({ ...item, _group: g })));
  }
  return [];
}
function findGroupById(gid) {
  return (mapping.groups || []).find(g => g.id === gid);
}
function findItemById(itemId) {
  for (const grp of (mapping.groups || [])) {
    const item = (grp.items || []).find(i => i.id === itemId);
    if (item) return { item, group: grp };
  }
  return null;
}

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
  // Tổng count = gift_count × combo (Bigo render combo trong overlay panel)
  const totalCount = ev.total_count || (ev.gift_count || 1) * (ev.combo || 1);
  const item = {
    id: 'q_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
    ts: Date.now(),
    user: ev.user || '?',
    avatar: ev.user_avatar_url || '',
    gift_id: ev.gift_id,
    gift_name: ev.gift_name || matched.alias || '?',
    gift_icon: ev.gift_icon || ev.gift_icon_url || '',
    count: totalCount,            // ← dùng total_count (đã nhân combo)
    rawCount: ev.gift_count || 1,
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
  forwardToQueuePopup(item);

  // Mark as playing sau 1 chút (giả định push vào overlay queue → sẽ play)
  setTimeout(() => {
    const found = queueItems.find(q => q.id === item.id);
    if (found && found.status === 'queued') {
      found.status = 'playing';
      renderQueue();
      forwardToQueuePopup({ ...found });
      // Sau 5s giả định effect xong (TODO: thay bằng IPC từ overlay khi ended)
      setTimeout(() => {
        const f2 = queueItems.find(q => q.id === item.id);
        if (f2) { f2.status = 'done'; renderQueue(); forwardToQueuePopup({ ...f2 }); }
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
  // Settings tab
  bgmAudio: $('bgmAudio'), bgmFileLabel: $('bgmFileLabel'),
  btnPickBgm: $('btnPickBgm'), btnPlayBgm: $('btnPlayBgm'), btnStopBgm: $('btnStopBgm'), btnClearBgm: $('btnClearBgm'),
  audioDevice: $('audioDevice'), btnRefreshDevices: $('btnRefreshDevices'),
  bgmVol: $('bgmVol'), bgmVolVal: $('bgmVolVal'),
  fxVol: $('fxVol'), fxVolVal: $('fxVolVal'),
  maxListItems: $('maxListItems'),
  // Gift dialog extras
  dlgPauseBgm: $('dlgPauseBgm'),
  effectQueue: $('effectQueue'), btnClearQueue: $('btnClearQueue'),
  btnPopupQueue: $('btnPopupQueue'),
  qStatGifts: $('qStatGifts'), qStatDiamond: $('qStatDiamond'), qStatUsers: $('qStatUsers'),
  qSizeFont: $('qSizeFont'), qSizeFontVal: $('qSizeFontVal'),
  qSizeIcon: $('qSizeIcon'), qSizeIconVal: $('qSizeIconVal'),
  // (OAuth tab đã được xoá - các els bên dưới có thể null)
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
  dlgMasterVnOnly: $('dlgMasterVnOnly'), dlgMasterFavOnly: $('dlgMasterFavOnly'),
  dlgMasterTotal: $('dlgMasterTotal'),
  // Overlay modal
  overlayDialog: $('overlayDialog'), overlayDialogTitle: $('overlayDialogTitle'),
  ovName: $('ovName'), ovBgColor: $('ovBgColor'), ovOpacity: $('ovOpacity'), ovOpacityVal: $('ovOpacityVal'),
  ovW: $('ovW'), ovH: $('ovH'), ovTop: $('ovTop'), ovClickThrough: $('ovClickThrough'),
  ovAutoHide: $('ovAutoHide'),
  dlgOverlaySave: $('dlgOverlaySave'),
};

// =================== Utils ===================
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function appendLog(msg) {
  // Log panel đã được bỏ. Giữ console.log để debug qua DevTools.
  if (!els.log) { console.log('[bigo]', msg); return; }
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
  els.embedBigoId.value = s.bigoId || '';
  await initAppSettings(s);

  mapping = await window.bigo.mappingLoad();
  await reloadEffects();
  renderGiftTable();
  renderOverlayTable();
  refreshIconCacheStatus();
  loadQueueSettings();
  renderQueue();
  // Pre-load master để gift table có icon ngay (background)
  ensureMasterLoaded().catch(() => {});
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
// Tìm icon URL master theo matchKeys (ưu tiên typeid là số)
function getGiftIcon(g) {
  if (!masterFullList) return '';
  for (const k of (g.matchKeys || [])) {
    const id = parseInt(k, 10);
    if (!isNaN(id)) {
      const m = masterFullList.find(x => x.typeid === id);
      if (m && (m.localIcon || m.img_url)) return m.localIcon || m.img_url;
    }
  }
  for (const k of (g.matchKeys || [])) {
    const lower = String(k).toLowerCase();
    const m = masterFullList.find(x => String(x.name || '').toLowerCase() === lower);
    if (m && (m.localIcon || m.img_url)) return m.localIcon || m.img_url;
  }
  return '';
}

// State cho subtab type filter (per container)
const subtypeByContainer = new WeakMap();

function renderGiftTable() {
  // v3: render groups list trong container của tab Bảng quà
  let groupsContainer = $('groupsContainer');
  if (!groupsContainer && els.giftTableBody) {
    const tableWrap = els.giftTableBody.closest('.table-wrap');
    if (tableWrap) {
      groupsContainer = document.createElement('div');
      groupsContainer.id = 'groupsContainer';
      groupsContainer.className = 'groups-container';
      tableWrap.replaceWith(groupsContainer);
      els.groupsContainer = groupsContainer;
    }
  }
  els.groupsContainer = groupsContainer || $('groupsContainer');
  if (els.groupsContainer) renderGroupsInto(els.groupsContainer, { subtype: 'gift' });
  // Render cả container trong tab Tương tác
  if (els.embedGroupsContainer) {
    const subtype = subtypeByContainer.get(els.embedGroupsContainer) || 'gift';
    const search = els.embedGroupSearch?.value.toLowerCase().trim() || '';
    renderGroupsInto(els.embedGroupsContainer, { subtype, search });
  }
}

function renderGroupsInto(container, opts) {
  const subtype = opts?.subtype || 'gift';
  const search = (opts?.search || '').toLowerCase().trim();
  if (!container) return;

  const overlayMap = new Map((mapping.overlays || []).map(o => [o.id, o]));
  let groups = (mapping.groups || []).filter(g => (g.type || 'gift') === subtype);
  if (search) groups = groups.filter(g => (g.name || '').toLowerCase().includes(search));

  if (groups.length === 0) {
    container.innerHTML = `<div style="color:#555;text-align:center;padding:24px">Chưa có nhóm ${subtype === 'comment' ? 'comment' : 'quà'} nào</div>`;
    return;
  }

  if (groups.every(g => (g.items || []).length === 0)) {
    // Render groups vẫn hiển thị nhưng thông báo không có item
    container.innerHTML = groups.map(grp => renderGroupCard(grp, overlayMap)).join('') ||
      '<div style="color:#555;text-align:center;padding:24px">Chưa có quà</div>';
  } else {
    container.innerHTML = groups.map(grp => renderGroupCard(grp, overlayMap)).join('');
  }
  // Wire actions
  container.querySelectorAll('[data-act]').forEach(el => {
    const act = el.dataset.act;
    if (el.tagName === 'INPUT' && el.type === 'checkbox') {
      el.onchange = () => groupAction(act, el.dataset.gid, el.checked);
    } else {
      el.onclick = () => groupAction(act, el.dataset.gid, undefined, el.dataset.iid);
    }
  });
  // Update group datalist
  if (els.groupList) {
    const groupNames = (mapping.groups || []).map(g => g.name).filter(Boolean);
    els.groupList.innerHTML = groupNames.map(g => `<option value="${escapeHtml(g)}"></option>`).join('');
  }
}

function renderGroupCard(grp, overlayMap) {
  const enabled = grp.enabled !== false;
  const collapsed = !!grp.collapsed;
  const itemsHtml = (grp.items || []).map(item => {
    const ov = overlayMap.get(item.overlayId);
    const iconUrl = getGiftIcon(item);
    const iconCell = iconUrl
      ? `<img src="${escapeHtml(iconUrl)}" class="grow-icon" loading="lazy" />`
      : '<div class="grow-icon-empty"></div>';
    const matchKeys = (item.matchKeys || []).map(k => `<code>${escapeHtml(k)}</code>`).join(' ');
    return `<div class="group-item" data-iid="${item.id}" data-gid="${grp.id}">
      ${iconCell}
      <div class="grow-meta">
        <div class="grow-name"><b>${escapeHtml(item.alias || (item.matchKeys || [])[0] || '?')}</b> ${matchKeys}</div>
        <div class="grow-sub">${item.mediaFile ? `<code>${escapeHtml(item.mediaFile)}</code>` : '<span style="color:#666">—</span>'} → ${ov ? escapeHtml(ov.name) : '<span style="color:#ff6b6b">overlay xoá</span>'}</div>
      </div>
      <div class="grow-actions">
        <button class="tiny" data-act="play" data-iid="${item.id}">▶</button>
        <button class="tiny" data-act="edit-item" data-iid="${item.id}">✏️</button>
        <button class="tiny danger" data-act="del-item" data-iid="${item.id}">🗑</button>
      </div>
    </div>`;
  }).join('') || '<div style="color:#555;padding:8px;font-size:11px">Nhóm trống</div>';

  return `<div class="group-card ${enabled ? 'on' : 'off'} ${collapsed ? 'collapsed' : ''}" data-gid="${grp.id}">
    <div class="group-head">
      <span class="group-name">${escapeHtml(grp.name)}</span>
      <span class="group-badge">${(grp.items || []).length} mục</span>
      <span class="group-status">${enabled ? 'Đang bật' : 'Đang tắt'}</span>
      <label class="switch" title="Bật/tắt nhóm">
        <input type="checkbox" data-act="toggle-group" data-gid="${grp.id}" ${enabled ? 'checked' : ''} />
        <span class="slider"></span>
      </label>
      <button class="tiny" data-act="add-item" data-gid="${grp.id}" title="Thêm vào nhóm">+ mục</button>
      <button class="tiny" data-act="edit-group" data-gid="${grp.id}" title="Sửa tên nhóm">✏️</button>
      <button class="tiny danger" data-act="del-group" data-gid="${grp.id}" title="Xoá nhóm">🗑</button>
      <button class="tiny" data-act="collapse" data-gid="${grp.id}" title="Thu gọn/Mở">${collapsed ? '▶' : '▼'}</button>
    </div>
    ${collapsed ? '' : `<div class="group-items">${itemsHtml}</div>`}
  </div>`;
}

async function groupAction(act, gid, value, itemId) {
  const grp = findGroupById(gid);
  if (act === 'toggle-group') {
    if (grp) { grp.enabled = !!value; await persistMapping(); renderGiftTable(); }
    return;
  }
  if (act === 'collapse') {
    if (grp) { grp.collapsed = !grp.collapsed; await persistMapping(); renderGiftTable(); }
    return;
  }
  if (act === 'edit-group') {
    if (!grp) return;
    const newName = prompt('Tên nhóm:', grp.name);
    if (!newName) return;
    grp.name = newName.trim();
    await persistMapping();
    renderGiftTable();
    return;
  }
  if (act === 'del-group') {
    if (!grp) return;
    if (!confirm(`Xoá nhóm "${grp.name}" và ${(grp.items || []).length} quà bên trong?`)) return;
    mapping.groups = mapping.groups.filter(g => g.id !== gid);
    if (mapping.groups.length === 0) mapping.groups.push({
      id: 'g_default_' + Date.now().toString(36),
      name: 'Mặc định', type: 'gift', enabled: true, collapsed: false, bigoId: '', items: [],
    });
    await persistMapping();
    renderGiftTable();
    return;
  }
  if (act === 'add-item') {
    openGiftDialog(null, gid);
    return;
  }
  // Item-level actions
  if (act === 'play' || act === 'edit-item' || act === 'del-item') {
    const found = findItemById(itemId);
    if (!found) return;
    if (act === 'play') {
      if (!found.item.mediaFile || !found.item.overlayId) { alert('Quà chưa có file hoặc overlay'); return; }
      if (found.item.pauseBgm) pauseBgmForEffect();
      const r = await window.bigo.overlayPlay({ overlayId: found.item.overlayId, file: found.item.mediaFile });
      if (!r.ok) alert('Không phát được: ' + (r.error || 'unknown'));
    } else if (act === 'edit-item') {
      openGiftDialog(found.item, found.group.id);
    } else if (act === 'del-item') {
      if (!confirm(`Xoá "${found.item.alias || found.item.matchKeys.join(',')}"?`)) return;
      found.group.items = found.group.items.filter(i => i.id !== itemId);
      await persistMapping();
      renderGiftTable();
    }
  }
}

// Legacy: giftAction giữ làm noop wrapper, code v3 dùng groupAction
async function giftAction(act, id) {
  return groupAction(act, null, undefined, id);
}

// Cache master list 1 lần khi mở modal đầu tiên
let masterFullList = null;

async function ensureMasterLoaded() {
  if (masterFullList) return;
  masterFullList = await window.bigo.giftsMasterList();
  // Sau khi master load, re-render gift table để show icons
  renderGiftTable();
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

// Heuristic detect quà Việt Nam: tên chứa từ khoá VN hoặc dấu Việt
const VN_KEYWORDS = /việt|vietnam|tết|sài\s?gòn|hà\s?nội|đà\s?nẵng|phở|áo\s?dài|hoa\s?sen|trống|nón\s?lá|VN|hp\s|HPMedia/i;
const VN_ACCENTS = /[àáảãạâầấẩẫậăằắẳẵặèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i;
function isVnGift(g) {
  const n = String(g.name || '');
  return VN_KEYWORDS.test(n) || VN_ACCENTS.test(n);
}

// Favorites lưu local
function loadFavorites() {
  try { return new Set(JSON.parse(localStorage.getItem('giftFavorites') || '[]')); } catch { return new Set(); }
}
function saveFavorites(set) {
  localStorage.setItem('giftFavorites', JSON.stringify([...set]));
}
let giftFavorites = loadFavorites();

function renderMasterTable() {
  if (!masterFullList) {
    els.dlgMasterCount.textContent = 'đang tải...';
    return;
  }
  if (els.dlgMasterTotal) els.dlgMasterTotal.textContent = masterFullList.length;
  const filter = els.dlgMasterFilter.value.toLowerCase().trim();
  const sortKey = els.dlgMasterSort.value;
  const vnOnly = els.dlgMasterVnOnly && els.dlgMasterVnOnly.checked;
  const favOnly = els.dlgMasterFavOnly && els.dlgMasterFavOnly.checked;
  let arr = masterFullList.slice();
  if (favOnly) arr = arr.filter(g => giftFavorites.has(g.typeid));
  if (vnOnly) arr = arr.filter(isVnGift);
  if (filter) {
    arr = arr.filter(g => {
      const n = String(g.name || '').toLowerCase();
      const id = String(g.typeid || '');
      return n.includes(filter) || id.includes(filter);
    });
  }
  sortMasterArr(arr, sortKey);
  els.dlgMasterCount.textContent = `${arr.length}/${masterFullList.length} quà`;
  const renderLimit = 500;
  const display = arr.slice(0, renderLimit);
  els.dlgMasterTableBody.innerHTML = display.map(g => {
    const src = g.localIcon || g.img_url || '';
    const isFav = giftFavorites.has(g.typeid);
    return `<tr data-typeid="${g.typeid}" data-name="${escapeHtml(g.name)}">
      <td><img src="${escapeHtml(src)}" loading="lazy" draggable="true" data-typeid="${g.typeid}" title="Kéo ra desktop = ${g.typeid}.png" /></td>
      <td><span class="id">${g.typeid}</span></td>
      <td><span class="price">💎 ${g.diamonds ?? '?'}</span></td>
      <td><span class="name">${escapeHtml(g.name)}</span></td>
      <td><button class="fav-btn ${isFav ? 'on' : ''}" data-fav="${g.typeid}" title="Đánh dấu yêu thích">${isFav ? '⭐' : '☆'}</button></td>
    </tr>`;
  }).join('');
  if (arr.length > renderLimit) {
    els.dlgMasterCount.textContent += ` · hiển thị ${renderLimit} đầu — gõ filter để thu hẹp`;
  }
  // Click row -> add to matchKeys (skip nếu click vào fav button hoặc img)
  els.dlgMasterTableBody.querySelectorAll('tr').forEach(row => {
    row.onclick = (e) => {
      if (e.target.tagName === 'IMG') return;
      if (e.target.classList && e.target.classList.contains('fav-btn')) return;
      const name = row.dataset.name;
      const typeid = row.dataset.typeid;
      const cur = els.dlgMatchKeys.value.split(',').map(s => s.trim()).filter(Boolean);
      if (!cur.includes(typeid)) cur.push(typeid);
      if (!cur.includes(name)) cur.push(name);
      els.dlgMatchKeys.value = cur.join(', ');
      if (!els.dlgAlias.value) els.dlgAlias.value = name;
    };
  });
  els.dlgMasterTableBody.querySelectorAll('.fav-btn').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.fav, 10);
      if (giftFavorites.has(id)) giftFavorites.delete(id);
      else giftFavorites.add(id);
      saveFavorites(giftFavorites);
      renderMasterTable();
    };
  });
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
if (els.dlgMasterVnOnly) els.dlgMasterVnOnly.addEventListener('change', renderMasterTable);
if (els.dlgMasterFavOnly) els.dlgMasterFavOnly.addEventListener('change', renderMasterTable);

async function openGiftDialog(gift = null, groupId = null) {
  els.giftDialogTitle.textContent = gift ? 'Sửa quà' : 'Thêm quà';
  els.dlgMatchKeys.value = gift ? gift.matchKeys.join(', ') : '';
  els.dlgAlias.value = gift?.alias || '';
  // Group: nếu pass groupId thì dùng tên group đó, fallback gift._group hoặc empty
  let groupName = '';
  if (groupId) {
    const grp = findGroupById(groupId);
    if (grp) groupName = grp.name;
  } else if (gift) {
    const found = findItemById(gift.id);
    if (found) groupName = found.group.name;
  }
  els.dlgGroup.value = groupName;
  els.giftDialog.dataset.editingGroupId = groupId || '';
  els.dlgMasterFilter.value = '';
  els.dlgMasterSort.value = 'kc-asc';
  // refresh overlay options
  els.dlgOverlay.innerHTML = mapping.overlays.length
    ? mapping.overlays.map(o => `<option value="${o.id}">${escapeHtml(o.name)}</option>`).join('')
    : '<option value="">(chưa có overlay)</option>';
  els.dlgOverlay.value = gift?.overlayId || mapping.overlays[0]?.id || '';
  els.dlgFile.value = gift?.mediaFile || '';
  if (els.dlgPauseBgm) els.dlgPauseBgm.checked = !!gift?.pauseBgm;
  els.giftDialog.dataset.editingId = gift?.id || '';
  els.giftDialog.showModal();
  await ensureMasterLoaded();
  renderMasterTable();
}

els.dlgGiftSave.onclick = async (e) => {
  if (!els.dlgMatchKeys.value.trim()) { e.preventDefault(); alert('Match keys không được trống'); return; }
  const itemId = els.giftDialog.dataset.editingId;
  const targetGroupName = els.dlgGroup.value.trim() || 'Mặc định';
  const matchKeys = els.dlgMatchKeys.value.split(',').map(s => s.trim()).filter(Boolean);
  const data = {
    id: itemId || uid('i_'),
    matchKeys,
    alias: els.dlgAlias.value.trim(),
    mediaFile: els.dlgFile.value,
    overlayId: els.dlgOverlay.value,
    pauseBgm: els.dlgPauseBgm ? els.dlgPauseBgm.checked : false,
  };
  // Tìm/tạo group theo tên
  if (!Array.isArray(mapping.groups)) mapping.groups = [];
  let targetGroup = mapping.groups.find(g => g.name === targetGroupName && g.type === 'gift');
  if (!targetGroup) {
    targetGroup = { id: uid('g_'), name: targetGroupName, type: 'gift', enabled: true, collapsed: false, bigoId: '', items: [] };
    mapping.groups.push(targetGroup);
  }
  if (itemId) {
    // Edit: tìm item trong group hiện tại; nếu group đổi, move
    const found = findItemById(itemId);
    if (found) {
      if (found.group.id === targetGroup.id) {
        const idx = found.group.items.findIndex(i => i.id === itemId);
        if (idx !== -1) found.group.items[idx] = data;
      } else {
        // Move to new group
        found.group.items = found.group.items.filter(i => i.id !== itemId);
        targetGroup.items.push(data);
      }
    } else {
      targetGroup.items.push(data);
    }
  } else {
    targetGroup.items.push(data);
  }
  await persistMapping();
  renderGiftTable();
};

els.btnAddGift.onclick = () => {
  if (mapping.overlays.length === 0) { alert('Tạo ít nhất 1 overlay trước (tab Overlay)'); return; }
  openGiftDialog();
};

// Tab Tương tác: nút Thêm quà / Thêm nhóm + search nhóm + sub-tabs
if (els.btnAddGiftEmbed) {
  els.btnAddGiftEmbed.onclick = () => {
    if (mapping.overlays.length === 0) { alert('Tạo ít nhất 1 overlay trước (tab Overlay)'); return; }
    openGiftDialog();
  };
}
if (els.btnAddGroupEmbed) {
  els.btnAddGroupEmbed.onclick = async () => {
    const subtype = subtypeByContainer.get(els.embedGroupsContainer) || 'gift';
    const name = prompt(`Tên nhóm ${subtype === 'comment' ? 'Comment' : 'Quà tặng'} mới:`);
    if (!name || !name.trim()) return;
    if (!Array.isArray(mapping.groups)) mapping.groups = [];
    mapping.groups.push({
      id: uid('g_'), name: name.trim(), type: subtype,
      enabled: true, collapsed: false, bigoId: '', items: [],
    });
    await persistMapping();
    renderGiftTable();
  };
}
if (els.embedGroupSearch) {
  let searchTimer = null;
  els.embedGroupSearch.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderGiftTable, 150);
  });
}
// Sub-tab Comment/Quà tặng trong tab Tương tác
document.querySelectorAll('.subtab-btn').forEach(b => {
  b.onclick = () => {
    document.querySelectorAll('.subtab-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    if (els.embedGroupsContainer) {
      subtypeByContainer.set(els.embedGroupsContainer, b.dataset.subtype);
      renderGiftTable();
    }
  };
});

els.btnTestGift.onclick = async () => {
  const allItems = getAllItems();
  if (allItems.length === 0) { alert('Chưa có quà nào'); return; }
  const g = allItems[0];
  if (!g.mediaFile || !g.overlayId) { alert('Quà đầu tiên chưa có file hoặc overlay'); return; }
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
  els.ovAutoHide.checked = !!ov?.autoHide;
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
    autoHide: els.ovAutoHide.checked,
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
  if (window.bigo.popupResetQueue) window.bigo.popupResetQueue().catch(() => {});
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
if (els.btnPopupQueue) els.btnPopupQueue.onclick = () => window.bigo.popupOpenQueue();

els.btnEmbedShow.onclick = async () => {
  const r = await window.bigo.embedShow();
  if (!r.ok) appendLog('embed-show: ' + (r.error || 'no listener'));
};

// =================== Embed parsed events ===================
function findGiftByName(name) {
  if (!name) return null;
  const lower = name.toLowerCase();
  for (const item of getEnabledGiftItems()) {
    if ((item.matchKeys || []).some(k => String(k).toLowerCase() === lower)) return item;
  }
  return null;
}

function findGiftByEvent(ev) {
  // Ưu tiên match theo gift_id (chính xác nhất sau enrich master)
  if (ev.gift_id != null) {
    for (const item of getEnabledGiftItems()) {
      if ((item.matchKeys || []).some(k => String(k) === String(ev.gift_id))) return item;
    }
  }
  return findGiftByName(ev.gift_name);
}

// Strong normalize: strip invisible Unicode + collapse whitespace
function normEv(s) {
  return String(s || '')
    .replace(/[​-‏‪-‮⁠-⁯﻿]/g, '')
    .replace(/[︀-️]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Defensive dedup ở renderer (lớp 2). Window 1s, hash type-agnostic cho gift.
const recentEventHashes = new Map();
function shouldDropDuplicate(ev) {
  if (!ev || (ev.type !== 'chat' && ev.type !== 'gift' && ev.type !== 'gift_overlay')) return false;
  // Hash gift KHÔNG include combo/type — gift vs gift_overlay cùng quà coi là 1
  const key = ev.type === 'chat'
    ? `c|${ev.level}|${normEv(ev.user)}|${normEv(ev.content)}`
    : `g|${normEv(ev.user)}|${normEv(ev.gift_name)}|${ev.gift_count || 1}`;
  const now = Date.now();
  const last = recentEventHashes.get(key);
  if (last && now - last < 1000) return true; // 1s window
  recentEventHashes.set(key, now);
  if (recentEventHashes.size > 800) {
    const cutoff = now - 30000;
    for (const [k, t] of recentEventHashes) if (t < cutoff) recentEventHashes.delete(k);
  }
  return false;
}

function renderParsed(ev) {
  // Bỏ gift_overlay UI render hoàn toàn — đây là duplicate của gift event từ chat
  // (cùng người tặng cùng quà, chỉ khác source DOM). Skip giữ data sạch.
  if (ev.type === 'gift_overlay') {
    // chỉ log debug, không render và không trigger play (gift event đã trigger rồi)
    console.log('[bigo gift_overlay skipped]', { user: ev.user, gift_name: ev.gift_name, combo: ev.combo });
    return;
  }
  if (shouldDropDuplicate(ev)) {
    console.log('[bigo dup-dropped]', { type: ev.type, user: ev.user, content: ev.content || ev.gift_name });
    return;
  }
  // Debug: log gift events ra console
  if (ev.type === 'gift') {
    console.log('[bigo gift]', {
      user: ev.user, gift_name: ev.gift_name, gift_id: ev.gift_id,
      count: ev.gift_count, total: ev.total_count, icon: ev.gift_icon, raw: ev.raw,
    });
  }
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
      // Combo: tặng N lần thì phát N lần. total_count = gift_count × combo.
      const playTimes = Math.max(1, Math.min(50, ev.total_count || ev.gift_count || 1));
      for (let i = 0; i < playTimes; i++) {
        window.bigo.overlayPlay({ overlayId: matched.overlayId, file: matched.mediaFile });
      }
      // Tạm dừng nhạc nền nếu gift cấu hình "không chạy chung"
      if (matched.pauseBgm) pauseBgmForEffect();
      pushQueue(ev, matched, playTimes);
    }
  }
}

// Forward to queue popup if open
function forwardToQueuePopup(item) {
  if (window.bigo.popupSendQueue) {
    window.bigo.popupSendQueue(item).catch(() => {});
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

// =================== Cài đặt chung (BGM, audio device, volume) ===================
let appSettings = {
  bgm: { file: null, fileName: '', volume: 80, deviceId: 'default' },
  fxVolume: 100,
  maxListItems: 200,
};

async function saveAppSettings(patch) {
  const s = await window.bigo.settingsLoad();
  if (patch) {
    if (patch.bgm) s.bgm = { ...(s.bgm || {}), ...patch.bgm };
    if ('fxVolume' in patch) s.fxVolume = patch.fxVolume;
    if ('maxListItems' in patch) s.maxListItems = patch.maxListItems;
  }
  await window.bigo.settingsSave(s);
}

async function refreshAudioDevices() {
  if (!els.audioDevice) return;
  try {
    // Cần media permission để có labels
    try { await navigator.mediaDevices.getUserMedia({ audio: true }); } catch {}
    const devs = await navigator.mediaDevices.enumerateDevices();
    const outputs = devs.filter(d => d.kind === 'audiooutput');
    els.audioDevice.innerHTML = outputs.map(d =>
      `<option value="${d.deviceId}">${escapeHtml(d.label || `Device ${d.deviceId.slice(0, 6)}`)}</option>`
    ).join('') || '<option value="default">Mặc định</option>';
    // Restore selected
    if (appSettings.bgm.deviceId) {
      els.audioDevice.value = appSettings.bgm.deviceId;
    }
  } catch (e) {
    console.warn('enumerateDevices failed:', e);
    els.audioDevice.innerHTML = '<option value="default">Mặc định</option>';
  }
}

async function applyBgmSinkId() {
  if (!els.bgmAudio || !els.bgmAudio.setSinkId) return;
  try { await els.bgmAudio.setSinkId(appSettings.bgm.deviceId || 'default'); } catch (e) { console.warn('setSinkId:', e.message); }
}

async function initAppSettings(s) {
  appSettings.bgm = { ...appSettings.bgm, ...(s.bgm || {}) };
  appSettings.fxVolume = s.fxVolume != null ? s.fxVolume : 100;
  appSettings.maxListItems = s.maxListItems || 200;
  // Apply BGM
  if (els.bgmAudio) {
    els.bgmAudio.volume = (appSettings.bgm.volume || 80) / 100;
    if (appSettings.bgm.file) els.bgmAudio.src = appSettings.bgm.file;
    if (appSettings.bgm.fileName) els.bgmFileLabel.value = appSettings.bgm.fileName;
  }
  // Apply UI controls
  if (els.bgmVol) { els.bgmVol.value = appSettings.bgm.volume || 80; els.bgmVolVal.textContent = els.bgmVol.value; }
  if (els.fxVol) { els.fxVol.value = appSettings.fxVolume; els.fxVolVal.textContent = appSettings.fxVolume; }
  if (els.maxListItems) els.maxListItems.value = appSettings.maxListItems;
  // Devices
  await refreshAudioDevices();
  await applyBgmSinkId();
}

if (els.btnPickBgm) {
  els.btnPickBgm.onclick = async () => {
    const r = await window.bigo.pickBgmFile();
    if (!r.ok) return;
    appSettings.bgm.file = r.fileUrl;
    appSettings.bgm.fileName = r.fileName;
    els.bgmAudio.src = r.fileUrl;
    els.bgmFileLabel.value = r.fileName;
    await saveAppSettings({ bgm: { file: r.fileUrl, fileName: r.fileName } });
  };
}
if (els.btnPlayBgm) {
  els.btnPlayBgm.onclick = () => {
    if (!els.bgmAudio.src) { alert('Chưa chọn file nhạc nền'); return; }
    els.bgmAudio.play().catch(e => alert('Không phát được: ' + e.message));
  };
}
if (els.btnStopBgm) {
  els.btnStopBgm.onclick = () => { els.bgmAudio.pause(); els.bgmAudio.currentTime = 0; };
}
if (els.btnClearBgm) {
  els.btnClearBgm.onclick = async () => {
    els.bgmAudio.pause();
    els.bgmAudio.removeAttribute('src');
    els.bgmAudio.load();
    els.bgmFileLabel.value = '';
    appSettings.bgm.file = null;
    appSettings.bgm.fileName = '';
    await saveAppSettings({ bgm: { file: null, fileName: '' } });
  };
}
if (els.btnRefreshDevices) {
  els.btnRefreshDevices.onclick = refreshAudioDevices;
}
if (els.audioDevice) {
  els.audioDevice.addEventListener('change', async () => {
    appSettings.bgm.deviceId = els.audioDevice.value;
    await applyBgmSinkId();
    await saveAppSettings({ bgm: { deviceId: els.audioDevice.value } });
  });
}
if (els.bgmVol) {
  els.bgmVol.addEventListener('input', () => {
    const v = parseInt(els.bgmVol.value, 10);
    els.bgmVolVal.textContent = v;
    appSettings.bgm.volume = v;
    if (els.bgmAudio) els.bgmAudio.volume = v / 100;
  });
  els.bgmVol.addEventListener('change', () => saveAppSettings({ bgm: { volume: appSettings.bgm.volume } }));
}
if (els.fxVol) {
  els.fxVol.addEventListener('input', () => {
    const v = parseInt(els.fxVol.value, 10);
    els.fxVolVal.textContent = v;
    appSettings.fxVolume = v;
  });
  els.fxVol.addEventListener('change', () => saveAppSettings({ fxVolume: appSettings.fxVolume }));
}
if (els.maxListItems) {
  els.maxListItems.addEventListener('change', () => {
    appSettings.maxListItems = parseInt(els.maxListItems.value, 10) || 200;
    saveAppSettings({ maxListItems: appSettings.maxListItems });
  });
}

// Pause BGM khi effect play, resume khi overlay queue rỗng (effect xong).
// KHÔNG reset currentTime — pause/play giữ vị trí gốc (nhạc tiếp tục từ chỗ ngắt).
let bgmPausedForEffect = false;
let bgmResumeTimer = null;
function pauseBgmForEffect() {
  if (!els.bgmAudio || !els.bgmAudio.src) return;
  // Chỉ pause nếu đang phát (nếu đã pause thủ công thì không can thiệp)
  if (!els.bgmAudio.paused) {
    els.bgmAudio.pause();
    bgmPausedForEffect = true;
  }
  // Fallback timer 30s: nếu IPC overlay:queue-empty không tới, vẫn resume
  if (bgmResumeTimer) clearTimeout(bgmResumeTimer);
  bgmResumeTimer = setTimeout(resumeBgmAfterEffect, 30000);
}
function resumeBgmAfterEffect() {
  if (bgmResumeTimer) { clearTimeout(bgmResumeTimer); bgmResumeTimer = null; }
  if (!bgmPausedForEffect) return;
  bgmPausedForEffect = false;
  if (els.bgmAudio && els.bgmAudio.src) {
    // play() resume từ currentTime hiện tại — không reset về 0
    els.bgmAudio.play().catch(() => {});
  }
}
// Hook IPC overlay:queue-empty từ main process
if (window.bigo.onOverlayQueueEmpty) {
  window.bigo.onOverlayQueueEmpty(() => {
    resumeBgmAfterEffect();
  });
}

// =================== Wire up ===================
window.bigo.onLog(appendLog);
window.bigo.onEmbedEvent(renderEmbedEvent);

init();
