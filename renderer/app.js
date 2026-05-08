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
// Tìm group theo tên không phân biệt hoa/thường. Nếu không có thì tạo mới.
function findOrCreateGroupCI(name, type = 'gift') {
  const trimmed = String(name || '').trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (!Array.isArray(mapping.groups)) mapping.groups = [];
  let grp = mapping.groups.find(g => String(g.name || '').toLowerCase() === lower);
  if (!grp) {
    grp = { id: uid('g_'), name: trimmed, type, enabled: true, collapsed: false, bigoId: '', items: [] };
    mapping.groups.push(grp);
  }
  return grp;
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

// Push batch N entries (chia tách thành N hàng, đếm lùi giảm dần)
// Dùng chung cho cả manual play và live gift event.
function pushPlayBatch(item, ev, playTimes) {
  const batchId = 'b_' + Date.now() + '_' + Math.random().toString(36).slice(2, 4);
  const baseUser = ev?.user || 'You (test)';
  const baseAvatar = ev?.user_avatar_url || '';
  const baseName = ev?.gift_name || item?.alias || (item?.matchKeys || [])[0] || '?';
  const baseId = ev?.gift_id ?? null;
  const baseIcon = ev?.gift_icon || ev?.gift_icon_url || (item ? getGiftIcon(item) : '');
  const baseDiamond = ev?.total_diamond ?? null;
  const baseLevel = ev?.level ?? null;
  const mediaFile = item?.mediaFile || null;
  const overlayId = item?.overlayId || null;

  const batch = [];
  for (let i = 0; i < playTimes; i++) {
    batch.push({
      id: 'q_' + batchId + '_' + i,
      batchId,
      ts: Date.now() + i, // tăng dần để stable sort
      user: baseUser,
      avatar: baseAvatar,
      gift_name: baseName,
      gift_id: baseId,
      gift_icon: baseIcon,
      level: baseLevel,
      count: 1,
      step: i + 1,
      total: playTimes,
      diamond: baseDiamond,
      mediaFile, overlayId,
      status: i === 0 ? 'playing' : 'queued',
      playTimes: 1,
    });
  }
  // Prepend whole batch — batch[0] sẽ ở top
  queueItems.unshift(...batch);
  while (queueItems.length > QUEUE_MAX) queueItems.pop();
  renderQueue(); renderMiniQueue(); updateQueueStats();
  batch.forEach(forwardToQueuePopup);

  // Schedule progression: mỗi PLAY_DURATION_MS, entry kế tiếp → playing, entry hiện → done → remove
  for (let i = 0; i < playTimes; i++) {
    setTimeout(() => {
      const entry = queueItems.find(q => q.id === `q_${batchId}_${i}`);
      if (entry) {
        entry.status = 'done';
        forwardToQueuePopup({ ...entry });
      }
      const next = queueItems.find(q => q.id === `q_${batchId}_${i + 1}`);
      if (next) {
        next.status = 'playing';
        forwardToQueuePopup({ ...next });
      }
      renderQueue(); renderMiniQueue();
      // Remove entry done sau 600ms để có hiệu ứng giảm dần
      setTimeout(() => {
        const idx = queueItems.findIndex(q => q.id === `q_${batchId}_${i}`);
        if (idx !== -1) {
          queueItems.splice(idx, 1);
          renderQueue(); renderMiniQueue();
        }
      }, 600);
    }, (i + 1) * PLAY_DURATION_MS);
  }
}

// Backward-compat wrapper (giữ tên cũ trong case còn ai gọi)
function pushQueueManual(item, group, playTimes) { pushPlayBatch(item, null, playTimes); }

function renderMiniQueue() {
  const el = document.getElementById('miniQueue');
  if (!el) return;
  if (queueItems.length === 0) {
    el.innerHTML = '<div style="color:#555;text-align:center;padding:14px;font-size:11px">Chưa có hiệu ứng</div>';
    return;
  }
  // Top 10 entries — mỗi entry là 1 lần phát riêng (pushPlayBatch tách thành N hàng)
  el.innerHTML = queueItems.slice(0, 10).map(q => {
    const iconHtml = q.gift_icon
      ? `<img class="gift-icon" src="${escapeHtml(q.gift_icon)}" loading="lazy" />`
      : '<div class="gift-icon"></div>';
    const status = q.status === 'playing' ? '<span class="badge-status playing">▶</span>'
      : q.status === 'done' ? '<span class="badge-status done">✓</span>'
      : '<span class="badge-status queued">⏳</span>';
    // Hiện step/total nếu là batch (vd 3/10), ngược lại hiện ×count
    const cntLabel = q.total > 1 ? `<span class="step">${q.step}/${q.total}</span>` : `×${q.count}`;
    return `<div class="mini-queue-row ${q.status}">
      ${iconHtml}
      <div class="mini-meta">
        <div class="who">${escapeHtml(q.user)}</div>
        <div class="what"><b>${escapeHtml(q.gift_name)}</b> ${cntLabel}</div>
      </div>
      ${status}
    </div>`;
  }).join('');
}

function pushQueue(ev, matched, playTimes) {
  if (!matched || !matched.mediaFile) return;
  // Dùng pushPlayBatch để chia tách thành playTimes entries
  pushPlayBatch(matched, ev, playTimes);
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
    // Tab Hàng đợi (queue) → mở popup, không switch
    if (t.dataset.tab === 'queue') {
      window.bigo.popupOpenQueue();
      return;
    }
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    document.querySelector(`.tab-panel[data-tab="${t.dataset.tab}"]`).classList.add('active');
    if (t.dataset.tab === 'embed' || t.dataset.tab === 'gifts') {
      try { renderGiftTable(); } catch (e) { console.warn(e); }
    }
    if (t.dataset.tab === 'settings') {
      try { renderSettingsGroupsList(); } catch (e) { console.warn(e); }
    }
  };
});

// =================== Init ===================
// Marquee suffix branding (chữ chạy)
const LIVE_SUFFIX = ' - Phần mềm Độc quyền thuộc về HP Media | HPVN.MEDIA';
function setLiveInfo(text, cls) {
  if (!els.liveInfo) return;
  els.liveInfo.className = `live-info-inline ${cls || ''}`;
  const safe = escapeHtml(text);
  const brand = escapeHtml(LIVE_SUFFIX);
  // 2 bản copy để loop seamless via translateX(-50%)
  els.liveInfo.innerHTML = `<div class="live-marquee">
    <span>${safe}<span class="brand">${brand}</span></span>
    <span>${safe}<span class="brand">${brand}</span></span>
  </div>`;
}

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
  renderMiniQueue();
  renderSettingsGroupsList();
  // Chat font size slider — persist localStorage
  const chatFont = document.getElementById('chatFontSize');
  if (chatFont) {
    const saved = parseInt(localStorage.getItem('chatFontSize') || '', 10);
    if (saved >= 11 && saved <= 18) chatFont.value = saved;
    const apply = () => {
      const v = parseInt(chatFont.value, 10);
      if (els.liveChats) els.liveChats.style.fontSize = v + 'px';
      localStorage.setItem('chatFontSize', String(v));
    };
    chatFont.addEventListener('input', apply);
    apply();
  }
  // Pre-load master để gift table có icon ngay (background)
  ensureMasterLoaded().catch(() => {});
  updateBgmSidebarIcon();

  // Right panel: collapse buttons + persist heights
  initRightPanelControls();
}

function initRightPanelControls() {
  // Collapse buttons
  document.querySelectorAll('.rps-collapse').forEach(btn => {
    const target = btn.dataset.rpsTarget;
    const sec = btn.closest('.right-panel-section');
    if (!sec) return;
    // Restore state
    const saved = localStorage.getItem('rps_collapsed_' + target) === '1';
    if (saved) sec.classList.add('collapsed');
    btn.onclick = () => {
      sec.classList.toggle('collapsed');
      const isCollapsed = sec.classList.contains('collapsed');
      localStorage.setItem('rps_collapsed_' + target, isCollapsed ? '1' : '0');
    };
  });
  // Restore + save heights via ResizeObserver
  const resizables = [
    { el: document.getElementById('miniQueue'), key: 'rps_h_queue' },
    { el: document.getElementById('liveGifts'), key: 'rps_h_gifts' },
    { el: document.getElementById('liveChats'), key: 'rps_h_chats' },
  ];
  for (const { el, key } of resizables) {
    if (!el) continue;
    const saved = parseInt(localStorage.getItem(key) || '', 10);
    if (saved > 60 && saved < window.innerHeight) el.style.height = saved + 'px';
    let savingTimer = null;
    const ro = new ResizeObserver(() => {
      clearTimeout(savingTimer);
      savingTimer = setTimeout(() => {
        localStorage.setItem(key, String(el.offsetHeight));
      }, 300);
    });
    ro.observe(el);
  }
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
  // Tab Bảng quà (sidebar 🎁) — replace table 1 lần đầu nếu chưa có groupsContainer
  let groupsContainer = document.getElementById('groupsContainer');
  if (!groupsContainer) {
    const tableBody = document.getElementById('giftTableBody');
    if (tableBody) {
      const tableWrap = tableBody.closest('.table-wrap');
      if (tableWrap) {
        const div = document.createElement('div');
        div.id = 'groupsContainer';
        div.className = 'groups-container';
        tableWrap.replaceWith(div);
        groupsContainer = div;
      }
    }
  }
  if (groupsContainer) renderGroupsInto(groupsContainer, {});

  // Tab Tương tác (sidebar 💬, trang chính)
  const embedContainer = document.getElementById('embedGroupsContainer');
  if (embedContainer) {
    const search = (document.getElementById('embedGroupSearch')?.value || '').toLowerCase().trim();
    renderGroupsInto(embedContainer, { search });
  }
}

function renderGroupsInto(container, opts) {
  const search = (opts?.search || '').toLowerCase().trim();
  if (!container) return;

  const overlayMap = new Map((mapping.overlays || []).map(o => [o.id, o]));
  // Hiển thị tất cả groups (không filter theo type)
  let groups = mapping.groups || [];
  if (search) groups = groups.filter(g => (g.name || '').toLowerCase().includes(search));

  if (groups.length === 0) {
    container.innerHTML = `<div style="color:#555;text-align:center;padding:24px">Chưa có nhóm nào — bấm "+ Nhóm" để tạo</div>`;
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
  // Drag-drop reorder items trong group
  wireDragDrop(container);
  // Update group datalist
  if (els.groupList) {
    const groupNames = (mapping.groups || []).map(g => g.name).filter(Boolean);
    els.groupList.innerHTML = groupNames.map(g => `<option value="${escapeHtml(g)}"></option>`).join('');
  }
}

// Drag-drop reorder cho items trong cùng group + giữa groups
function wireDragDrop(container) {
  let dragIid = null;
  let dragGid = null;
  container.querySelectorAll('.group-item').forEach(row => {
    row.draggable = true;
    row.ondragstart = (e) => {
      dragIid = row.dataset.iid;
      dragGid = row.dataset.gid;
      e.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
    };
    row.ondragend = () => {
      row.classList.remove('dragging');
      container.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
    };
    row.ondragover = (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      // Highlight target
      container.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
      row.classList.add('drop-target');
    };
    row.ondragleave = () => {
      row.classList.remove('drop-target');
    };
    row.ondrop = async (e) => {
      e.preventDefault();
      row.classList.remove('drop-target');
      const targetIid = row.dataset.iid;
      const targetGid = row.dataset.gid;
      if (!dragIid || dragIid === targetIid) return;
      await moveItem(dragIid, dragGid, targetIid, targetGid);
    };
  });
}

async function moveItem(srcIid, srcGid, dstIid, dstGid) {
  const srcGroup = findGroupById(srcGid);
  const dstGroup = findGroupById(dstGid);
  if (!srcGroup || !dstGroup) return;
  const srcIdx = srcGroup.items.findIndex(i => i.id === srcIid);
  if (srcIdx === -1) return;
  const [moved] = srcGroup.items.splice(srcIdx, 1);
  const dstIdx = dstGroup.items.findIndex(i => i.id === dstIid);
  if (dstIdx === -1) {
    dstGroup.items.push(moved);
  } else {
    dstGroup.items.splice(dstIdx, 0, moved);
  }
  await persistMapping();
  renderGiftTable();
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
        <input type="number" class="play-count" min="1" max="50" value="1" data-iid="${item.id}" title="Số lượng phát" onclick="event.stopPropagation()" />
        <button class="tiny" data-act="play" data-iid="${item.id}" title="Phát N lần theo số lượng">▶</button>
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
    if (grp) {
      grp.enabled = !!value;
      await persistMapping();
      // Khi BẬT nhóm: đưa tên nhóm vào search + auto-fill BIGO ID + apply BGM theo nhóm
      if (value && grp.name) {
        if (els.embedGroupSearch) els.embedGroupSearch.value = grp.name;
        if (grp.bigoId && els.embedBigoId && !els.embedBigoId.value.trim()) {
          els.embedBigoId.value = grp.bigoId;
        }
      }
      applyActiveBgm();
      if (value) playBgmIfHas();
      renderGiftTable();
    }
    return;
  }
  if (act === 'collapse') {
    if (grp) { grp.collapsed = !grp.collapsed; await persistMapping(); renderGiftTable(); }
    return;
  }
  if (act === 'edit-group') {
    if (!grp) return;
    openGroupEditDialog(grp);
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
      // Lấy số lượng từ input cùng row
      const countInput = document.querySelector(`.play-count[data-iid="${itemId}"]`);
      const playTimes = Math.max(1, Math.min(50, parseInt(countInput?.value || '1', 10) || 1));
      if (found.item.pauseBgm) pauseBgmForEffect();
      for (let i = 0; i < playTimes; i++) {
        await window.bigo.overlayPlay({ overlayId: found.item.overlayId, file: found.item.mediaFile });
      }
      // Chia tách thành playTimes entries (đếm lùi giảm dần)
      pushPlayBatch(found.item, null, playTimes);
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
  // Refresh datalist với toàn bộ tên nhóm hiện có (case khi user mở dialog
  // trước khi renderGroupsInto chạy — vẫn phải thấy đầy đủ groups)
  if (els.groupList) {
    const allNames = (mapping.groups || []).map(g => g.name).filter(Boolean);
    els.groupList.innerHTML = allNames.map(n => `<option value="${escapeHtml(n)}"></option>`).join('');
  }
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
  // Tìm/tạo group case-insensitive (NPC = npc = Npc)
  const targetGroup = findOrCreateGroupCI(targetGroupName, 'gift');
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
  ensureDefaultOverlay();
  openGiftDialog();
};

// Tab Tương tác: nút Thêm quà — auto tạo overlay default nếu chưa có
function ensureDefaultOverlay() {
  if (!mapping.overlays || mapping.overlays.length === 0) {
    mapping.overlays = mapping.overlays || [];
    mapping.overlays.push({
      id: uid('ov_'), name: 'Overlay 1', bgColor: '#00FF00',
      opacity: 1.0, bounds: { x: null, y: null, width: 540, height: 960 },
      alwaysOnTop: true,
    });
    persistMapping();
    if (typeof renderOverlayTable === 'function') renderOverlayTable();
  }
}
if (els.btnAddGiftEmbed) {
  els.btnAddGiftEmbed.onclick = () => {
    ensureDefaultOverlay();
    openGiftDialog(); // không pass groupId → save sẽ vào "Mặc định"
  };
}
if (els.embedGroupSearch) {
  let searchTimer = null;
  els.embedGroupSearch.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderGiftTable, 150);
  });
}

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
  if (els.metaPanel) els.metaPanel.style.display = 'none';
  if (els.metaInfo) els.metaInfo.innerHTML = '';
  els.liveChats.innerHTML = '';
  receivedGifts.length = 0;
  renderReceivedGifts();
  resetSessionStats();
  // Reset popup nếu đang mở
  if (window.bigo.popupResetGifts) window.bigo.popupResetGifts().catch(() => {});
  if (window.bigo.popupResetQueue) window.bigo.popupResetQueue().catch(() => {});
  // Reset mini queue UI luôn
  const miniQ = document.getElementById('miniQueue');
  if (miniQ) miniQ.innerHTML = '<div style="color:#555;text-align:center;padding:14px;font-size:11px">Chưa có hiệu ứng</div>';
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
  setLiveInfo('Đã hủy kết nối. Nhập BIGO ID khác và bấm Kết nối phòng.', '');
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
    setLiveInfo(`Lỗi check live: ${check.error}`, 'dead');
    els.btnConnect.disabled = false;
    return;
  }
  const d = check.data?.data || {};
  if (d.alive !== 1) {
    setLiveInfo(`🔴 OFFLINE — ${d.nick_name || 'không tìm thấy ID'}`, 'dead');
    els.status.textContent = 'offline';
    els.btnConnect.disabled = false;
    return;
  }

  setLiveInfo(`🟢 LIVE — ${d.nick_name} · roomId=${d.roomId} · uid=${d.uid} · "${d.roomTopic || ''}"`, 'live');

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
  // Auto-play BGM khi kết nối thành công (theo nhóm active hoặc Cài đặt chung)
  applyActiveBgm();
  playBgmIfHas();
};

els.btnPopupGifts.onclick = () => window.bigo.popupOpenGifts();
if (els.btnPopupQueue) els.btnPopupQueue.onclick = () => window.bigo.popupOpenQueue();
const btnPopupQueueRight = document.getElementById('btnPopupQueueRight');
if (btnPopupQueueRight) btnPopupQueueRight.onclick = () => window.bigo.popupOpenQueue();

els.btnEmbedShow.onclick = async () => {
  const r = await window.bigo.embedShow();
  if (!r.ok) appendLog('embed-show: ' + (r.error || 'no listener'));
};

// =================== Context menu helper ===================
function showContextMenu(x, y, items) {
  removeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  // Tính position để không tràn viewport
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = 200, h = items.length * 36 + 8;
  if (x + w > vw) x = vw - w - 8;
  if (y + h > vh) y = vh - h - 8;
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.innerHTML = items.map((it, i) => {
    if (it.divider) return '<div class="ctx-divider"></div>';
    return `<div class="ctx-item ${it.danger ? 'danger' : ''}" data-i="${i}">
      <span style="width:18px">${it.icon || ''}</span><span>${escapeHtml(it.label)}</span>
    </div>`;
  }).join('');
  document.body.appendChild(menu);
  menu.querySelectorAll('.ctx-item').forEach(el => {
    el.onclick = () => {
      const i = +el.dataset.i;
      removeContextMenu();
      try { items[i].action(); } catch (e) { console.error(e); }
    };
  });
  setTimeout(() => {
    document.addEventListener('click', removeContextMenu, { once: true });
    document.addEventListener('contextmenu', removeContextMenu, { once: true });
    document.addEventListener('keydown', escContextMenu, { once: true });
  }, 0);
}
function removeContextMenu() {
  document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
}
function escContextMenu(e) { if (e.key === 'Escape') removeContextMenu(); }

// =================== Received gifts (right panel) ===================
const receivedGifts = [];
const RECEIVED_MAX = 200;

function addReceivedGift(ev) {
  if (!ev || ev.type !== 'gift') return;
  const total = ev.total_count != null ? ev.total_count : ((ev.gift_count || 1) * (ev.combo || 1));
  receivedGifts.unshift({
    id: 'rg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
    ts: Date.now(),
    user: ev.user || '?',
    avatar: ev.user_avatar_url || '',
    gift_name: ev.gift_name || '?',
    gift_id: ev.gift_id,
    gift_icon: ev.gift_icon || ev.gift_icon_url || '',
    count: total,
    diamond: ev.total_diamond,
    level: ev.level,
  });
  if (receivedGifts.length > RECEIVED_MAX) receivedGifts.length = RECEIVED_MAX;
  renderReceivedGifts();
}

function renderReceivedGifts() {
  const cont = els.liveGifts;
  if (!cont) return;
  if (receivedGifts.length === 0) {
    cont.innerHTML = '';
    return;
  }
  cont.innerHTML = receivedGifts.map(g => {
    const iconHtml = g.gift_icon
      ? `<img class="rcv-icon" src="${escapeHtml(g.gift_icon)}" loading="lazy" />`
      : '<div class="rcv-icon-empty"></div>';
    return `<div class="rcv-row" data-gid="${g.id}">
      ${iconHtml}
      <div class="rcv-meta">
        <div class="rcv-who">${escapeHtml(g.user)}</div>
        <div class="rcv-gift">${escapeHtml(g.gift_name)}${g.gift_id != null ? ` <span style="color:#666">#${g.gift_id}</span>` : ''}</div>
      </div>
      <span class="rcv-count">×${g.count}</span>
      <button class="rcv-del" data-gid="${g.id}" title="Xoá">🗑</button>
    </div>`;
  }).join('');
  // Wire delete + context menu
  cont.querySelectorAll('.rcv-row').forEach(row => {
    const id = row.dataset.gid;
    const delBtn = row.querySelector('.rcv-del');
    if (delBtn) delBtn.onclick = (e) => {
      e.stopPropagation();
      removeReceivedGift(id);
    };
    row.oncontextmenu = (e) => {
      e.preventDefault();
      const idx = receivedGifts.findIndex(g => g.id === id);
      if (idx === -1) return;
      showContextMenu(e.clientX, e.clientY, [
        { icon: '🔝', label: 'Ưu tiên lên đầu', action: () => priorityTopReceived(idx) },
        { icon: '⬆️', label: 'Di chuyển lên 1 hàng', action: () => moveUpReceived(idx) },
        { icon: '⬇️', label: 'Di chuyển xuống 1 hàng', action: () => moveDownReceived(idx) },
        { divider: true },
        { icon: '🗑', label: 'Xoá', danger: true, action: () => removeReceivedGift(id) },
      ]);
    };
  });
}

function priorityTopReceived(idx) {
  if (idx <= 0 || idx >= receivedGifts.length) return;
  const [item] = receivedGifts.splice(idx, 1);
  receivedGifts.unshift(item);
  renderReceivedGifts();
}
function moveUpReceived(idx) {
  if (idx <= 0 || idx >= receivedGifts.length) return;
  [receivedGifts[idx], receivedGifts[idx - 1]] = [receivedGifts[idx - 1], receivedGifts[idx]];
  renderReceivedGifts();
}
function moveDownReceived(idx) {
  if (idx < 0 || idx >= receivedGifts.length - 1) return;
  [receivedGifts[idx], receivedGifts[idx + 1]] = [receivedGifts[idx + 1], receivedGifts[idx]];
  renderReceivedGifts();
}
function removeReceivedGift(id) {
  const idx = receivedGifts.findIndex(g => g.id === id);
  if (idx === -1) return;
  receivedGifts.splice(idx, 1);
  renderReceivedGifts();
}

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
  if (ev.type === 'gift_overlay') {
    console.log('[bigo gift_overlay skipped]', { user: ev.user, gift_name: ev.gift_name, combo: ev.combo });
    return;
  }
  if (shouldDropDuplicate(ev)) {
    console.log('[bigo dup-dropped]', { type: ev.type, user: ev.user, content: ev.content || ev.gift_name });
    return;
  }
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
    // Mới nhất ở DƯỚI: append + auto scroll xuống cuối
    els.liveChats.appendChild(div);
    while (els.liveChats.children.length > 200) els.liveChats.firstChild.remove();
    els.liveChats.scrollTop = els.liveChats.scrollHeight;
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
      // Push vào received gifts list (right panel) — layout mới gọn
      addReceivedGift(ev);
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
    // Panel "Room hiện tại" đã bỏ - silently ignore meta event
    if (els.metaPanel && els.metaInfo) {
      els.metaPanel.style.display = 'block';
      const parts = [];
      if (ev.bigoId) parts.push(`<span><b>BIGO ID</b>: ${escapeHtml(ev.bigoId)}</span>`);
      if (ev.title) parts.push(`<span><b>Title</b>: ${escapeHtml(ev.title)}</span>`);
      els.metaInfo.innerHTML = parts.join('');
    }
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

// =================== Group Edit Dialog ===================
const groupEditDialog = document.getElementById('groupEditDialog');
let editingGrpId = null;
let editingGrpBgmFile = null;
let editingGrpBgmName = '';

function openGroupEditDialog(grp) {
  if (!groupEditDialog) return;
  editingGrpId = grp.id;
  editingGrpBgmFile = grp.bgmFile || null;
  editingGrpBgmName = grp.bgmFileName || '';
  document.getElementById('grpDlgName').value = grp.name || '';
  document.getElementById('grpDlgBigoId').value = grp.bigoId || '';
  document.getElementById('grpDlgBgmLabel').value = editingGrpBgmName;
  groupEditDialog.showModal();
}

const grpDlgBgmPick = document.getElementById('grpDlgBgmPick');
const grpDlgBgmClear = document.getElementById('grpDlgBgmClear');
const grpDlgSave = document.getElementById('grpDlgSave');
if (grpDlgBgmPick) {
  grpDlgBgmPick.onclick = async () => {
    const r = await window.bigo.pickBgmFile();
    if (!r.ok) return;
    editingGrpBgmFile = r.fileUrl;
    editingGrpBgmName = r.fileName;
    document.getElementById('grpDlgBgmLabel').value = r.fileName;
  };
}
if (grpDlgBgmClear) {
  grpDlgBgmClear.onclick = () => {
    editingGrpBgmFile = null;
    editingGrpBgmName = '';
    document.getElementById('grpDlgBgmLabel').value = '';
  };
}
if (grpDlgSave) {
  grpDlgSave.onclick = async (e) => {
    const newName = document.getElementById('grpDlgName').value.trim();
    if (!newName) { e.preventDefault(); alert('Tên nhóm không được trống'); return; }
    const grp = findGroupById(editingGrpId);
    if (!grp) return;
    // Check trùng tên (case-insensitive, exclude self)
    const lower = newName.toLowerCase();
    const dup = (mapping.groups || []).find(x => x.id !== grp.id && x.name.toLowerCase() === lower);
    if (dup) { e.preventDefault(); alert(`Đã có nhóm "${dup.name}" - tên trùng (không phân biệt hoa/thường)`); return; }
    grp.name = newName;
    grp.bigoId = document.getElementById('grpDlgBigoId').value.trim();
    grp.bgmFile = editingGrpBgmFile;
    grp.bgmFileName = editingGrpBgmName;
    await persistMapping();
    renderGiftTable();
    renderSettingsGroupsList();
    applyActiveBgm();
  };
}

// =================== Quản lý nhóm trong tab Cài đặt ===================
function renderSettingsGroupsList() {
  const container = document.getElementById('groupsListSettings');
  if (!container) return;
  const groups = mapping.groups || [];
  if (groups.length === 0) {
    container.innerHTML = '<div class="gls-empty">Chưa có nhóm nào — gõ tên rồi bấm "+ Tạo nhóm"</div>';
    return;
  }
  container.innerHTML = groups.map(g => `
    <div class="gls-row" data-gid="${g.id}">
      <span class="name">${escapeHtml(g.name)}</span>
      <span class="count">${(g.items || []).length} mục</span>
      <button class="tiny" data-act="settings-rename" data-gid="${g.id}" title="Đổi tên">✏️</button>
      <button class="tiny danger" data-act="settings-del" data-gid="${g.id}" title="Xoá nhóm">🗑</button>
    </div>
  `).join('');
}

// Event delegation cho settings groups list — gắn 1 lần (không bị mất khi re-render innerHTML)
const settingsGroupsContainer = document.getElementById('groupsListSettings');
if (settingsGroupsContainer && !settingsGroupsContainer._wired) {
  settingsGroupsContainer._wired = true;
  settingsGroupsContainer.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const gid = btn.dataset.gid;
    const g = findGroupById(gid);
    if (!g) return;
    if (btn.dataset.act === 'settings-rename') {
      const newName = prompt('Đổi tên nhóm:', g.name);
      if (!newName || !newName.trim()) return;
      const lower = newName.trim().toLowerCase();
      const dup = mapping.groups.find(x => x.id !== gid && x.name.toLowerCase() === lower);
      if (dup) { alert(`Đã có nhóm "${dup.name}" - tên trùng (không phân biệt hoa/thường)`); return; }
      g.name = newName.trim();
      await persistMapping();
      renderSettingsGroupsList();
      renderGiftTable();
    } else if (btn.dataset.act === 'settings-del') {
      if (!confirm(`Xoá nhóm "${g.name}" và ${(g.items || []).length} quà bên trong?`)) return;
      mapping.groups = mapping.groups.filter(x => x.id !== gid);
      await persistMapping();
      renderSettingsGroupsList();
      renderGiftTable();
    }
  });
}

const btnCreateGroup = document.getElementById('btnCreateGroup');
const newGroupNameInput = document.getElementById('newGroupName');
if (btnCreateGroup && newGroupNameInput) {
  const createGroup = async () => {
    const name = newGroupNameInput.value.trim();
    if (!name) { alert('Nhập tên nhóm'); return; }
    const lower = name.toLowerCase();
    const exists = (mapping.groups || []).find(g => g.name.toLowerCase() === lower);
    if (exists) {
      alert(`Đã có nhóm "${exists.name}" - không phân biệt hoa/thường`);
      return;
    }
    findOrCreateGroupCI(name, 'gift');
    await persistMapping();
    newGroupNameInput.value = '';
    renderSettingsGroupsList();
    renderGiftTable();
  };
  btnCreateGroup.onclick = createGroup;
  newGroupNameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') createGroup(); });
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

// Tìm BGM nguồn ưu tiên: group enabled có bgmFile > Cài đặt chung
function getActiveBgmSrc() {
  for (const g of (mapping.groups || [])) {
    if (g.enabled !== false && g.bgmFile) return g.bgmFile;
  }
  return appSettings?.bgm?.file || '';
}

// Switch BGM source nếu cần (khi enable/disable group có bgmFile riêng)
function applyActiveBgm() {
  if (!els.bgmAudio) return;
  const target = getActiveBgmSrc();
  const current = els.bgmAudio.src || '';
  if (current === target) return;
  const wasPlaying = !els.bgmAudio.paused && current;
  if (target) {
    els.bgmAudio.src = target;
    if (wasPlaying) els.bgmAudio.play().catch(() => {});
  } else {
    els.bgmAudio.pause();
    els.bgmAudio.removeAttribute('src');
    els.bgmAudio.load();
  }
}

// Helper: play BGM nếu có file và đang paused (dùng cho auto-trigger)
function playBgmIfHas() {
  if (!els.bgmAudio) return;
  applyActiveBgm();
  if (!els.bgmAudio.src) return;
  if (els.bgmAudio.paused) {
    els.bgmAudio.play().catch(() => {});
  }
}

// Update icon BGM trên sidebar theo trạng thái play/pause
function updateBgmSidebarIcon() {
  const btn = document.getElementById('sidebarBgmToggle');
  if (!btn || !els.bgmAudio) return;
  if (!els.bgmAudio.paused && els.bgmAudio.src) {
    btn.textContent = '⏸';
    btn.classList.add('playing');
    btn.title = 'Đang phát nhạc nền — bấm để dừng';
  } else {
    btn.textContent = '🎵';
    btn.classList.remove('playing');
    btn.title = els.bgmAudio.src ? 'Bấm để phát nhạc nền' : 'Chưa chọn nhạc nền (vào tab Cài đặt)';
  }
}

if (els.bgmAudio) {
  els.bgmAudio.addEventListener('play', updateBgmSidebarIcon);
  els.bgmAudio.addEventListener('pause', updateBgmSidebarIcon);
  els.bgmAudio.addEventListener('loadedmetadata', updateBgmSidebarIcon);
}

// Sidebar BGM toggle button
const sidebarBgmBtn = document.getElementById('sidebarBgmToggle');
if (sidebarBgmBtn) {
  sidebarBgmBtn.onclick = () => {
    if (!els.bgmAudio.src) {
      alert('Chưa chọn nhạc nền — vào tab ⚙️ Cài đặt chung để chọn file');
      return;
    }
    if (els.bgmAudio.paused) els.bgmAudio.play().catch(e => alert('Không phát được: ' + e.message));
    else els.bgmAudio.pause();
  };
}

// =================== Wire up ===================
window.bigo.onLog(appendLog);
window.bigo.onEmbedEvent(renderEmbedEvent);

init();
