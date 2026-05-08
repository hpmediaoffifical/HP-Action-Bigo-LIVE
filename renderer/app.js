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
      // NHÓM CHUNG luôn bật. Các nhóm khác tuỳ enabled.
      .filter(g => (g.isCommon || g.enabled !== false) && g.type !== 'comment')
      .flatMap(g => (g.items || []).map(item => ({ ...item, _group: g })));
  }
  return (mapping.gifts || []).map(item => ({ ...item, _group: null }));
}
// Tìm/tạo NHÓM CHUNG ở renderer
function getCommonGroup() {
  if (!Array.isArray(mapping.groups)) mapping.groups = [];
  let common = mapping.groups.find(g => g.isCommon || g.id === 'g_common');
  if (!common) {
    common = { id: 'g_common', name: 'NHÓM CHUNG', type: 'gift', enabled: true, collapsed: false, bigoId: '', items: [], isCommon: true };
    mapping.groups.unshift(common);
  }
  return common;
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
function fmtStat(n) {
  // Format số lớn cho gọn: 1234 → 1,234; 12345 → 12.3K; 1234567 → 1.23M
  if (n == null) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (n >= 10_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return n.toLocaleString('en-US');
}
function updateConnectStats() {
  if (!els.csEffects) return;
  els.csEffects.textContent = fmtStat(sessionStats.effects);
  els.csDiamond.textContent = fmtStat(sessionStats.diamond);
  els.csUsers.textContent = fmtStat(sessionStats.users.size);
  els.csGifts.textContent = fmtStat(sessionStats.giftCount);
}

// =================== Effect Queue State ===================
const queueItems = []; // { id, ts, user, avatar, gift_id, gift_name, gift_icon, count, diamond, status }
const QUEUE_MAX = 5000; // Cho phép hold 5000 items in-memory; render UI giới hạn theo maxListItems.
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

// Push batch N entries (chia tách thành N hàng).
// Quà đang phát luôn ở [0] (top). Khi overlay 'ended' → shift [0] và mark next [0] = playing.
// Đảm bảo MỖI entry tương ứng MỘT lần play overlay (không bỏ sót).
function pushPlayBatch(item, ev, playTimes) {
  const batchId = 'b_' + Date.now() + '_' + Math.random().toString(36).slice(2, 4);
  const baseUser = ev?.user || 'NHPHUNG';
  // Avatar: NHPHUNG → logo HP. User thường → raw avatar (nếu scraper bắt được).
  const baseAvatar = resolveAvatarForUser(baseUser, ev?.user_avatar_url);
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
      ts: Date.now() + i,
      user: baseUser, avatar: baseAvatar,
      gift_name: baseName, gift_id: baseId, gift_icon: baseIcon,
      level: baseLevel,
      count: 1, step: i + 1, total: playTimes,
      diamond: baseDiamond,
      mediaFile, overlayId,
      status: 'queued', // tất cả queued — processor sẽ pick first
      playTimes: 1,
    });
  }

  // Priority: 0 = append cuối queue (FIFO chuẩn).
  // N > 0 = chèn vào HÀNG N (1-indexed, đếm từ trên cùng cả playing item).
  // User: "tôi chọn 2 nhưng không lên hàng 2" — fix off-by-one trước đó dùng
  // priority như array index (idx N), giờ chuyển sang display row N.
  const priority = item?.priority || 0;
  if (priority > 0 && queueItems.length > 0) {
    const hasPlaying = queueItems[0]?.status === 'playing';
    // Display row N (1-indexed) → array idx (N - 1).
    // Nếu queueItems[0] = playing, idx tối thiểu = 1 (không thể displace playing).
    const minIdx = hasPlaying ? 1 : 0;
    const desiredIdx = priority - 1; // row N → idx N-1
    const insertIdx = Math.max(minIdx, Math.min(desiredIdx, queueItems.length));
    queueItems.splice(insertIdx, 0, ...batch);
    appendLog(`[queue] ${baseName}: priority=${priority} → hàng ${insertIdx + 1} (queue có ${queueItems.length} hàng${hasPlaying ? ', đang phát ở hàng 1' : ''})`);
  } else {
    queueItems.push(...batch);
    if (priority > 0) {
      appendLog(`[queue] ${baseName}: priority=${priority} nhưng queue rỗng → append cuối`);
    }
  }
  while (queueItems.length > QUEUE_MAX) queueItems.shift();

  // Đảm bảo chỉ có 1 entry 'playing' tại 1 thời điểm. Nếu chưa có ai playing → mark [0]
  if (!queueItems.some(q => q.status === 'playing') && queueItems.length > 0) {
    queueItems[0].status = 'playing';
  }
  renderQueue(); renderMiniQueue(); updateQueueStats();
  forwardQueueSnapshot();
}

// Hook: overlay:effect-ended từ overlay window (player/audio fire 'ended')
// → advance UI queue: shift entry đang playing, mark new [0] playing.
// User wants: quà hết hiệu ứng → XOÁ LUÔN khỏi danh sách (không giữ 'done' state).
if (window.bigo.onOverlayEffectEnded) {
  window.bigo.onOverlayEffectEnded(() => {
    // Pre-effect ended → decrement ghost counter, không advance app queue.
    // Tránh off-by-one khi gift có pre-effect: overlay chạy N+1 plays nhưng
    // app queueItems chỉ có N entries (cho main effect). Nếu không skip 1 ended
    // event thì queue empty trước khi main effect cuối kết thúc.
    if (_preEffectPending > 0) {
      _preEffectPending--;
      return;
    }
    if (queueItems.length === 0) return;
    const playingIdx = queueItems.findIndex(q => q.status === 'playing');
    if (playingIdx !== -1) {
      // Xoá ngay để tránh memory bloat
      queueItems.splice(playingIdx, 1);
      // Mark next queued as playing
      if (queueItems.length > 0 && !queueItems.some(q => q.status === 'playing')) {
        const nextQ = queueItems.find(q => q.status === 'queued');
        if (nextQ) nextQ.status = 'playing';
      }
      // Decrement 🎵 counter khi item end naturally
      sessionStats.effects = Math.max(0, sessionStats.effects - 1);
      updateConnectStats();
      renderQueue(); renderMiniQueue(); updateQueueStats();
      forwardQueueSnapshot();
      // Cũ: setTimeout(...) — bỏ delay, xoá thẳng để DSHT luôn chỉ chứa playing + queued
      setTimeout(() => {
        // Empty placeholder để giữ tương thích với code cũ. Có thể xoá block sau.
        renderQueue(); renderMiniQueue();
      }, 400);
    }
  });
}

function pushQueueManual(item, group, playTimes) { pushPlayBatch(item, null, playTimes); }

// Sort queue: status='playing' luôn đứng đầu (thường chỉ có 1), sau đó queued theo
// thứ tự queueItems (đã được apply priority khi insert). 'done' items không hiển thị.
function getQueueDisplayList() {
  // Lọc ra non-done, đảm bảo playing đầu tiên (nếu có nhiều playing — hiếm — vẫn đầu)
  const playing = queueItems.filter(q => q.status === 'playing');
  const queued = queueItems.filter(q => q.status === 'queued');
  return [...playing, ...queued];
}

// Layout chuẩn (theo yêu cầu user):
//   [avatar] [gift_icon] [user (top, large) / "tặng <effect> ×N" (bottom)] [✕ del]
// Đang phát hiển thị border-left đỏ + badge "▶ ĐANG PHÁT" cạnh tên user.
function renderQueueRowHtml(q, opts = {}) {
  const isPlaying = q.status === 'playing';
  const avUrl = resolveAvatarForUser(q.user, q.avatar);
  const avHtml = avUrl ? `<img class="qrow-avatar" src="${escapeHtml(avUrl)}" loading="lazy" />` : '';
  const giftIconHtml = q.gift_icon
    ? `<img class="qrow-gift-icon" src="${escapeHtml(q.gift_icon)}" loading="lazy" />`
    : '<div class="qrow-gift-icon-empty"></div>';
  const playingBadge = isPlaying
    ? '<span class="badge-status playing">▶ ĐANG PHÁT</span>'
    : '';
  const cntInline = q.count > 1 || q.total > 1
    ? `<span class="cnt-inline">×${q.count}</span>` : '';
  const beansInline = q.diamond != null
    ? `<span class="beans-inline">💎 ${q.diamond.toLocaleString('en-US')}</span>` : '';
  const rowClass = opts.rowClass || 'mini-queue-row';
  return `<div class="${rowClass} ${q.status}" data-id="${escapeHtml(q.id)}">
    ${avHtml}
    ${giftIconHtml}
    <div class="qrow-meta">
      <div class="qrow-user">${escapeHtml(q.user)}${playingBadge}</div>
      <div class="qrow-effect">tặng <b>${escapeHtml(q.gift_name)}</b>${cntInline}${beansInline}</div>
    </div>
    <button class="qrow-del" data-qid="${escapeHtml(q.id)}" title="Xoá hàng này">✕</button>
  </div>`;
}

function renderMiniQueue() {
  const el = document.getElementById('miniQueue');
  if (!el) return;
  const list = getQueueDisplayList();
  if (list.length === 0) {
    el.innerHTML = '<div style="color:#555;text-align:center;padding:14px;font-size:11px">Chưa có hiệu ứng</div>';
    return;
  }
  // Render top N theo settings (default 20). Còn lại trong queue chạy hết, chỉ
  // không hiển thị UI (tránh lag). Khi item đầu hết → item dưới được "đẩy lên".
  const maxRows = Math.max(5, Math.min(200, parseInt(appSettings?.maxListItems, 10) || 20));
  const visible = list.slice(0, maxRows);
  const hidden = list.length - visible.length;
  let html = visible.map(q => renderQueueRowHtml(q, { rowClass: 'mini-queue-row' })).join('');
  if (hidden > 0) {
    html += `<div class="mini-queue-more" title="${hidden} hiệu ứng nữa đang chờ phát">+ ${hidden} đang chờ phát…</div>`;
  }
  el.innerHTML = html;
  el.querySelectorAll('[data-qid]').forEach(btn => {
    btn.onclick = (e) => { e.stopPropagation(); removeQueueItemById(btn.dataset.qid); };
  });
  el.querySelectorAll('.mini-queue-row').forEach(row => wireQueueContextMenu(row));
}

function removeQueueItemById(id) {
  const idx = queueItems.findIndex(q => q.id === id);
  if (idx === -1) return;
  const removed = queueItems[idx];
  queueItems.splice(idx, 1);
  // QUAN TRỌNG: Nếu xoá item đang playing → STOP effect ở overlay window (tránh
  // hiệu ứng chạy ẩn dù đã xoá khỏi DSHT). Overlay tự fire 'queue-empty' để
  // resume BGM nếu cần.
  if (removed.status === 'playing' && removed.overlayId && window.bigo.overlayStopEffect) {
    window.bigo.overlayStopEffect(removed.overlayId).catch(() => {});
  }
  // Mark playing cho item tiếp theo (nếu có)
  if (removed.status === 'playing' && queueItems.length > 0) {
    const nextQ = queueItems.find(q => q.status === 'queued');
    if (nextQ) nextQ.status = 'playing';
  }
  // Decrement counter 🎵 effects
  sessionStats.effects = Math.max(0, sessionStats.effects - 1);
  updateConnectStats();
  renderQueue(); renderMiniQueue(); updateQueueStats();
  forwardQueueSnapshot();
}

function clearAllQueue() {
  // DEFENSIVE: Stop TẤT CẢ overlays trong mapping (không chỉ playing items).
  // Lý do: race condition — IPC overlay:play có thể IN-FLIGHT từ event handler
  // for-loop (combo gift fires N plays sync). Stop hết để overlay's block window
  // (500ms) drain mọi play in-flight.
  if (window.bigo.overlayStopEffect && mapping?.overlays) {
    for (const ov of mapping.overlays) {
      window.bigo.overlayStopEffect(ov.id).catch(() => {});
    }
  }
  // Decrement counter
  sessionStats.effects = Math.max(0, sessionStats.effects - queueItems.length);
  updateConnectStats();
  queueItems.length = 0;
  renderQueue(); renderMiniQueue(); updateQueueStats();
  forwardQueueSnapshot();
  if (window.bigo.popupResetQueue) window.bigo.popupResetQueue().catch(() => {});
}

// Forward FULL snapshot of queue to popup. Mỗi lần queue thay đổi gọi 1 lần.
function forwardQueueSnapshot() {
  if (!window.bigo.popupQueueSnapshot) return;
  const list = getQueueDisplayList();
  window.bigo.popupQueueSnapshot(list).catch(() => {});
}

// Default avatar URL cho admin NHPHUNG → logo HP. Cho mọi user khác trả về raw URL.
const HP_LOGO_URL = './../logo-hp.png';
function resolveAvatarForUser(user, rawAvatar) {
  const u = String(user || '').trim().toUpperCase();
  if (u === 'NHPHUNG' || u === 'NHPHUNG (ADMIN)') return HP_LOGO_URL;
  return rawAvatar || '';
}

// Bigo level tier (1-6) cho color coding. Bigo total levels 1-119.
function levelTier(lv) {
  const n = parseInt(lv, 10);
  if (!n || n < 1) return 1;
  if (n <= 15) return 1;
  if (n <= 30) return 2;
  if (n <= 45) return 3;
  if (n <= 60) return 4;
  if (n <= 90) return 5;
  return 6;
}

// Match 1 special effect cfg với 1 gift event (by typeid hoặc giftName).
function matchSpecialGift(ev, cfg) {
  if (!cfg || !cfg.enabled) return false;
  if (!cfg.typeid && !cfg.giftName) return false;
  if (cfg.typeid && ev.gift_id && Number(ev.gift_id) === Number(cfg.typeid)) return true;
  if (cfg.giftName && ev.gift_name) {
    const a = String(ev.gift_name).toLowerCase().trim();
    const b = String(cfg.giftName).toLowerCase().trim();
    if (a === b) return true;
  }
  return false;
}

// Check & trigger TẤT CẢ special effects khi 1 gift event đến từ live.
// Trả về true nếu gift này match ít nhất 1 trigger (caller có thể dùng để skip
// duplicate flow nếu cần).
function checkSpecialEffectsTriggers(ev) {
  const se = appSettings?.specialEffects;
  if (!se) return false;
  let triggered = false;
  if (matchSpecialGift(ev, se.clearQueue)) {
    appendLog(`[se:clearQueue] ${ev.user || '?'} tặng "${ev.gift_name || '?'}" → xoá DSHT`);
    clearAllQueue();
    triggered = true;
  }
  // 4 speed triggers: audio/video × up/down
  for (const key of ['speedUpAudio','speedDownAudio','speedUpVideo','speedDownVideo']) {
    if (matchSpecialGift(ev, se[key])) {
      const dur = parseInt(se[key].duration, 10) || 10;
      const axis = SPEED_AXIS[key];
      appendLog(`[se:${key}] ${ev.user || '?'} tặng "${ev.gift_name || '?'}" → ${axis} ×${se[key].factor} trong ${dur}s`);
      triggerSpeedEffect(key);
      triggered = true;
      break; // chỉ 1 speed trigger 1 lúc (lock semantics)
    }
  }
  return triggered;
}

// Backward compat shim
function checkClearGiftTrigger(ev) {
  return matchSpecialGift(ev, appSettings?.specialEffects?.clearQueue);
}

function pushQueue(ev, matched, playTimes) {
  if (!matched || !matched.mediaFile) return;
  // Dùng pushPlayBatch để chia tách thành playTimes entries
  pushPlayBatch(matched, ev, playTimes);
}

function renderQueue() {
  const list = getQueueDisplayList();
  if (!list.length) {
    els.effectQueue.innerHTML = '<div style="color:#555;text-align:center;padding:16px">Chưa có hiệu ứng nào trong danh sách</div>';
    return;
  }
  const maxRows = Math.max(5, Math.min(500, parseInt(appSettings?.maxListItems, 10) || 20));
  const visible = list.slice(0, maxRows);
  const hidden = list.length - visible.length;
  let html = visible.map(q => renderQueueRowHtml(q, { rowClass: 'queue-row' })).join('');
  if (hidden > 0) {
    html += `<div class="mini-queue-more">+ ${hidden} hiệu ứng nữa đang chờ phát…</div>`;
  }
  els.effectQueue.innerHTML = html;
  els.effectQueue.querySelectorAll('[data-qid]').forEach(btn => {
    btn.onclick = (e) => { e.stopPropagation(); removeQueueItemById(btn.dataset.qid); };
  });
  els.effectQueue.querySelectorAll('.queue-row').forEach(row => wireQueueContextMenu(row));
}

// Wire right-click context menu cho 1 queue row (mini hoặc main).
// Actions: Ưu tiên lên đầu / Lên 1 hàng / Xuống 1 hàng / Xoá.
function wireQueueContextMenu(row) {
  row.oncontextmenu = (e) => {
    e.preventDefault();
    const id = row.dataset.id || row.querySelector('[data-qid]')?.dataset.qid;
    if (!id) return;
    const idx = queueItems.findIndex(q => q.id === id);
    if (idx === -1) return;
    showContextMenu(e.clientX, e.clientY, [
      { icon: '🔝', label: 'Ưu tiên lên đầu', action: () => queueMoveTop(id) },
      { icon: '⬆️', label: 'Di chuyển lên 1 hàng', action: () => queueMoveUp(id) },
      { icon: '⬇️', label: 'Di chuyển xuống 1 hàng', action: () => queueMoveDown(id) },
      { divider: true },
      { icon: '🗑', label: 'Xoá', danger: true, action: () => removeQueueItemById(id) },
    ]);
  };
}

// Helpers reorder queueItems. Bỏ qua items 'playing' (không di chuyển playing item).
function queueMoveTop(id) {
  const idx = queueItems.findIndex(q => q.id === id);
  if (idx === -1) return;
  const item = queueItems[idx];
  if (item.status === 'playing') return; // playing không di chuyển
  queueItems.splice(idx, 1);
  // Chèn ngay sau playing (idx 1 nếu playing ở [0]) hoặc top nếu không có playing
  const playingIdx = queueItems.findIndex(q => q.status === 'playing');
  const insertAt = playingIdx >= 0 ? playingIdx + 1 : 0;
  queueItems.splice(insertAt, 0, item);
  renderQueue(); renderMiniQueue(); updateQueueStats(); forwardQueueSnapshot();
}
function queueMoveUp(id) {
  const idx = queueItems.findIndex(q => q.id === id);
  if (idx <= 0) return;
  const item = queueItems[idx];
  const above = queueItems[idx - 1];
  if (item.status === 'playing' || above.status === 'playing') return;
  queueItems[idx - 1] = item;
  queueItems[idx] = above;
  renderQueue(); renderMiniQueue(); updateQueueStats(); forwardQueueSnapshot();
}
function queueMoveDown(id) {
  const idx = queueItems.findIndex(q => q.id === id);
  if (idx === -1 || idx >= queueItems.length - 1) return;
  const item = queueItems[idx];
  const below = queueItems[idx + 1];
  if (item.status === 'playing') return;
  queueItems[idx + 1] = item;
  queueItems[idx] = below;
  renderQueue(); renderMiniQueue(); updateQueueStats(); forwardQueueSnapshot();
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
  btnResetStats: $('btnResetStats'),
  btnPopupGifts: $('btnPopupGifts'),
  // Settings tab
  bgmAudio: $('bgmAudio'), bgmFileLabel: $('bgmFileLabel'),
  btnPickBgm: $('btnPickBgm'), btnPlayBgm: $('btnPlayBgm'), btnStopBgm: $('btnStopBgm'), btnClearBgm: $('btnClearBgm'),
  // Pre-effect sound (Cài đặt chung)
  preFxFileLabel: $('preFxFileLabel'), preFxEnabled: $('preFxEnabled'),
  btnPickPreFx: $('btnPickPreFx'), btnTestPreFx: $('btnTestPreFx'), btnClearPreFx: $('btnClearPreFx'),
  // (Hiệu Ứng Đặc Biệt: dùng document.getElementById trực tiếp trong applySpecialEffectsUi)
  audioDevice: $('audioDevice'), btnRefreshDevices: $('btnRefreshDevices'),
  bgmVol: $('bgmVol'), bgmVolVal: $('bgmVolVal'),
  fxVol: $('fxVol'), fxVolVal: $('fxVolVal'),
  maxListItems: $('maxListItems'),
  // Gift dialog extras
  dlgPauseBgm: $('dlgPauseBgm'), dlgPreFx: $('dlgPreFx'),
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
  ovAutoHide: $('ovAutoHide'), ovLockRatio: $('ovLockRatio'),
  ovAutoOpen: $('ovAutoOpen'), ovAutoFocus: $('ovAutoFocus'),
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
  if (!confirm('Xoá tất cả hiệu ứng đang chờ?')) return;
  clearAllQueue();
};

// IPC listeners từ popup window (popup user bấm X / Xoá tất cả / right-click)
if (window.bigo.onQueueRemove) window.bigo.onQueueRemove(id => removeQueueItemById(id));
if (window.bigo.onQueueClearAll) window.bigo.onQueueClearAll(() => clearAllQueue());
if (window.bigo.onQueueAction) {
  window.bigo.onQueueAction(({ type, id }) => {
    if (!id) return;
    if (type === 'top') queueMoveTop(id);
    else if (type === 'up') queueMoveUp(id);
    else if (type === 'down') queueMoveDown(id);
  });
}

// (legacy, bỏ qua dòng dưới — giữ để giảm rủi ro break code khác)
if (false) {
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

// =================== Config Export / Import ===================
const btnConfigExport = document.getElementById('btnConfigExport');
const btnConfigImport = document.getElementById('btnConfigImport');
if (btnConfigExport) {
  btnConfigExport.addEventListener('click', async () => {
    btnConfigExport.disabled = true;
    try {
      // Lưu mapping hiện tại trước khi xuất (bảo đảm export là state mới nhất)
      await persistMapping();
      const r = await window.bigo.configExport();
      if (r.canceled) return;
      if (!r.ok) { alert('Xuất thất bại: ' + (r.error || 'unknown')); return; }
      alert(`✅ Đã xuất cấu hình vào:\n${r.filePath}\n\nMang file này sang máy khác rồi bấm "Nhập cấu hình" để khôi phục.`);
    } finally {
      btnConfigExport.disabled = false;
    }
  });
}
if (btnConfigImport) {
  btnConfigImport.addEventListener('click', async () => {
    if (!confirm('⚠️ Nhập cấu hình sẽ GHI ĐÈ toàn bộ:\n• Danh sách quà\n• Nhóm\n• Overlay\n• Cài đặt chung (BGM, pre-effect, audio device, volume)\n\nNên Xuất cấu hình hiện tại trước để backup. Tiếp tục?')) return;
    btnConfigImport.disabled = true;
    try {
      const r = await window.bigo.configImport();
      if (r.canceled) return;
      if (!r.ok) { alert('Nhập thất bại: ' + (r.error || 'unknown')); return; }
      const s = r.stats || {};
      alert(`✅ Đã nhập cấu hình:\n• ${s.groups || 0} nhóm\n• ${s.items || 0} quà\n• ${s.overlays || 0} overlay\n${s.exportedAt ? '\nFile xuất từ: ' + s.exportedAt : ''}\n\nApp sẽ reload để áp dụng.`);
      // Reload để re-fetch mapping + settings từ disk và re-render UI
      location.reload();
    } finally {
      btnConfigImport.disabled = false;
    }
  });
}

// Reset stats button → bộ đếm về 0 (giữ session vẫn chạy)
if (els.btnResetStats) {
  els.btnResetStats.addEventListener('click', () => {
    if (!confirm('Reset bộ đếm 🎵 💎 👤 🎁 về 0?')) return;
    resetSessionStats();
  });
}

// Sidebar lock settings button — toggle chế độ Khoá cài đặt (chống chỉnh nhầm khi stream)
(function wireLockSettings() {
  const btn = document.getElementById('sidebarLockSettings');
  if (!btn) return;
  const KEY = 'hp_app_locked';
  const apply = (locked) => {
    document.body.classList.toggle('app-locked', locked);
    btn.classList.toggle('locked', locked);
    btn.title = locked
      ? 'Đang khoá — bấm để mở khoá cài đặt'
      : 'Khoá cài đặt — chống chỉnh nhầm trong khi stream';
    btn.textContent = locked ? '🔒' : '🔐';
  };
  // Restore from localStorage
  try { apply(localStorage.getItem(KEY) === '1'); } catch {}
  btn.addEventListener('click', () => {
    const next = !document.body.classList.contains('app-locked');
    apply(next);
    try { localStorage.setItem(KEY, next ? '1' : '0'); } catch {}
  });
})();

// Brand link → mở hpvn.media trong trình duyệt mặc định (không mở trong app)
(function wireBrandLink() {
  const link = document.getElementById('brandLink');
  if (!link) return;
  link.addEventListener('click', (e) => {
    e.preventDefault();
    try { window.bigo.openExternal('https://hpvn.media'); } catch {}
  });
})();

// Phiên bản hiện tại + license key (tab ℹ️) — wire với Google Apps Script.
let _machineId = null;
async function ensureMachineId() {
  if (_machineId) return _machineId;
  try { _machineId = await window.bigo.licenseMachineId(); } catch { _machineId = ''; }
  return _machineId || '';
}

function renderLicenseStatus(data) {
  const statusEl = document.getElementById('licenseStatus');
  const detailEl = document.getElementById('licenseDetail');
  if (!statusEl) return;
  if (!data) { statusEl.textContent = ''; if (detailEl) detailEl.innerHTML = ''; return; }
  const trang = String(data.TRANG_THAI || data.status || '').toUpperCase();
  const tier = String(data.TINH_NANG || data.tier || data.tinh_nang || 'BASIC').toUpperCase();
  const expiry = data.HAN_SU_DUNG || data.expiry || data.han_su_dung || '';
  const quotaMax = data.SL_QUA_TOI_DA ?? data.quota_max ?? '?';
  const quotaUsed = data.SL_QUA_DA_DUNG ?? data.quota_used ?? 0;
  const tenKh = data.TEN_KH || data.customer || '';
  const isOk = trang === 'ACTIVE' || trang === 'INACTIVE'; // INACTIVE = chưa kích hoạt nhưng valid
  const isExpired = trang === 'EXPIRED' || (expiry && new Date(expiry) < new Date());
  const isBanned = trang === 'BANNED' || trang === 'REVOKED';

  let icon, color, msg;
  if (isBanned) { icon = '🚫'; color = '#ff6b6b'; msg = `Key bị ${trang === 'BANNED' ? 'cấm' : 'thu hồi'}`; }
  else if (isExpired) { icon = '⏰'; color = '#ff6b6b'; msg = 'Key đã HẾT HẠN'; }
  else if (isOk) { icon = '✓'; color = '#4ad07a'; msg = trang === 'ACTIVE' ? 'Key hợp lệ + đã kích hoạt' : 'Key hợp lệ, sẵn sàng kích hoạt'; }
  else { icon = '?'; color = '#ffd166'; msg = `Trạng thái: ${trang || 'không rõ'}`; }
  statusEl.textContent = `${icon} ${msg}`;
  statusEl.style.color = color;

  if (detailEl) {
    // Format hạn sử dụng đẹp: Date object → dd/mm/yyyy, string ISO/dd-mm → giữ nguyên
    let expiryDisplay = '—';
    if (expiry) {
      const d = new Date(expiry);
      if (!isNaN(d.getTime())) {
        const dd = String(d.getDate()).padStart(2, '0');
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const yy = d.getFullYear();
        expiryDisplay = `${dd}/${mm}/${yy}`;
        // Bonus: tính số ngày còn lại
        const daysLeft = Math.ceil((d.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
        if (daysLeft >= 0) expiryDisplay += ` <span style="color:#8a8f9a; font-weight:400">(còn ${daysLeft} ngày)</span>`;
      } else {
        expiryDisplay = String(expiry);
      }
    }
    const quotaDisplay = quotaMax === 0 || quotaMax === '0'
      ? `<span style="color:#ffb627">${escapeHtml(String(quotaUsed))} / ∞ Unlimited</span>`
      : `${escapeHtml(String(quotaUsed))}/${escapeHtml(String(quotaMax))}`;
    detailEl.innerHTML = `
      <div class="dev-row"><span class="dev-key">Khách hàng:</span><span class="dev-val"><b>${escapeHtml(tenKh || '—')}</b></span></div>
      <div class="dev-row"><span class="dev-key">Gói:</span><span class="dev-val"><b style="color:${tier === 'SVIP' ? '#ffb627' : tier === 'VIP' ? '#a447e8' : '#8ad6ff'}">${escapeHtml(tier)}</b></span></div>
      <div class="dev-row"><span class="dev-key">Hạn sử dụng:</span><span class="dev-val"><b>${expiryDisplay}</b></span></div>
      <div class="dev-row"><span class="dev-key">Quota quà:</span><span class="dev-val"><b>${quotaDisplay}</b></span></div>
      <div class="dev-row"><span class="dev-key">Trạng thái:</span><span class="dev-val"><b style="color:${color}">${escapeHtml(trang || '?')}</b></span></div>
    `;
  }
}

async function verifyLicense(key, action = 'verify') {
  const statusEl = document.getElementById('licenseStatus');
  if (!key) {
    if (statusEl) { statusEl.textContent = '⚠️ Chưa nhập key'; statusEl.style.color = '#ff6b6b'; }
    return null;
  }
  if (statusEl) { statusEl.textContent = '⏳ Đang xác minh...'; statusEl.style.color = '#8a8f9a'; }
  const machineId = await ensureMachineId();
  const r = await window.bigo.licenseVerify({ key, machineId, action });
  if (!r.ok) {
    if (statusEl) {
      statusEl.textContent = `✗ Lỗi: ${r.error}`;
      statusEl.style.color = '#ff6b6b';
    }
    return null;
  }
  // Apps Script có thể trả { ok: false, error } hoặc { ... data ... }
  const data = r.data;
  if (data && data.error) {
    if (statusEl) {
      statusEl.textContent = `✗ ${data.error}`;
      statusEl.style.color = '#ff6b6b';
    }
    return null;
  }
  if (data && data.ok === false) {
    if (statusEl) {
      statusEl.textContent = `✗ ${data.message || data.error || 'Key không hợp lệ'}`;
      statusEl.style.color = '#ff6b6b';
    }
    return null;
  }
  // Apps Script có thể wrap { ok: true, data: {...} } hoặc trả thẳng row data
  const info = data?.data || data || {};
  renderLicenseStatus(info);
  // Cache local
  try {
    localStorage.setItem('hp_license_key', key);
    localStorage.setItem('hp_license_info', JSON.stringify(info));
    localStorage.setItem('hp_license_verified_at', String(Date.now()));
  } catch {}
  return info;
}

(async function wireInfoTab() {
  const verEl = document.getElementById('appVersion');
  if (verEl && window.bigo.appGetVersion) {
    try { verEl.textContent = await window.bigo.appGetVersion(); } catch { verEl.textContent = '?'; }
  }
  const keyInput = document.getElementById('licenseKey');
  const verifyBtn = document.getElementById('btnVerifyLicense');
  const activateBtn = document.getElementById('btnActivateLicense');

  if (keyInput) {
    try { keyInput.value = localStorage.getItem('hp_license_key') || ''; } catch {}
    keyInput.addEventListener('change', () => {
      try { localStorage.setItem('hp_license_key', keyInput.value.trim()); } catch {}
    });
  }
  if (verifyBtn) {
    verifyBtn.onclick = async () => {
      verifyBtn.disabled = true;
      try { await verifyLicense(keyInput?.value.trim() || '', 'verify'); }
      finally { verifyBtn.disabled = false; }
    };
  }
  if (activateBtn) {
    activateBtn.onclick = async () => {
      activateBtn.disabled = true;
      try { await verifyLicense(keyInput?.value.trim() || '', 'activate'); }
      finally { activateBtn.disabled = false; }
    };
  }

  // Auto-load cached info on app start
  try {
    const cached = localStorage.getItem('hp_license_info');
    if (cached) renderLicenseStatus(JSON.parse(cached));
    const cachedKey = localStorage.getItem('hp_license_key');
    if (cachedKey) {
      // Background re-verify (silent)
      setTimeout(() => verifyLicense(cachedKey, 'verify').catch(() => {}), 2000);
    }
  } catch {}
})();

// Mọi link có data-ext → mở trong trình duyệt mặc định (panel Thông tin NPT)
document.body.addEventListener('click', (e) => {
  const link = e.target.closest('[data-ext]');
  if (!link) return;
  e.preventDefault();
  const url = link.dataset.ext;
  if (url) { try { window.bigo.openExternal(url); } catch {} }
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

// Display label cho file URL: "📁 filename.mp4" để phân biệt với file legacy trong assets/effects.
// Với basename thuần (legacy) thì hiển thị raw.
function fileDisplayLabel(value) {
  if (!value) return '';
  if (/^file:\/\//i.test(value) || /^[a-z]:[\\\/]/i.test(value) || value.includes('/') || value.includes('\\')) {
    // Full URL/path → show only basename with 📁 prefix
    const base = value.replace(/[\/\\]+$/, '').split(/[\/\\]/).pop() || value;
    try { return '📁 ' + decodeURIComponent(base); } catch { return '📁 ' + base; }
  }
  return value;
}

async function reloadEffects() {
  effects = await window.bigo.effectsList();
  // Bao gồm: legacy files trong assets/effects + giữ option hiện tại nếu là URL ngoài.
  const currentVal = els.dlgFile.value;
  const opts = ['<option value="">— chọn file —</option>',
    ...effects.map(e => `<option value="${escapeHtml(e.file)}">${escapeHtml(e.file)}</option>`)];
  // Nếu currentVal là full URL/path không có trong list → giữ thêm option
  if (currentVal && !effects.find(e => e.file === currentVal)) {
    opts.push(`<option value="${escapeHtml(currentVal)}" selected>${escapeHtml(fileDisplayLabel(currentVal))}</option>`);
  }
  els.dlgFile.innerHTML = opts.join('');
  if (currentVal) els.dlgFile.value = currentVal;
}

els.dlgPickFile.onclick = async () => {
  const r = await window.bigo.effectsPickFiles();
  if (!r.ok || !r.files || !r.files.length) return;
  // KHÔNG copy — lưu fileUrl trực tiếp. Thêm option mới vào dropdown và select.
  const picked = r.files[0]; // chọn file đầu tiên (hoặc duy nhất nếu user chỉ chọn 1)
  // Add options cho TẤT CẢ files đã pick
  for (const f of r.files) {
    const exists = Array.from(els.dlgFile.options).some(o => o.value === f.fileUrl);
    if (!exists) {
      const opt = document.createElement('option');
      opt.value = f.fileUrl;
      opt.textContent = '📁 ' + f.fileName;
      els.dlgFile.appendChild(opt);
    }
  }
  els.dlgFile.value = picked.fileUrl;
  appendLog(`đã chọn ${r.files.length} file (giữ ở vị trí gốc, không copy vào assets/effects)`);
};
// dlgOpenFolder button đã bỏ — không cần mở thư mục assets/effects nữa.
if (els.dlgOpenFolder) els.dlgOpenFolder.onclick = () => window.bigo.effectsOpenFolder();

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
  const isCommon = !!grp.isCommon;
  const enabled = isCommon ? true : grp.enabled !== false;
  const collapsed = !!grp.collapsed;
  const itemsHtml = (grp.items || []).map(item => {
    const iconUrl = getGiftIcon(item);
    const iconCell = iconUrl
      ? `<img src="${escapeHtml(iconUrl)}" class="grow-icon" loading="lazy" />`
      : '<div class="grow-icon-empty"></div>';
    const displayName = item.alias || (item.matchKeys || [])[0] || '?';
    const priorityBadge = item.priority > 0 ? `<span class="prio-badge" title="Ưu tiên: chèn vào hàng ${item.priority} trong queue">⚡ Ưu tiên #${item.priority}</span>` : '';
    // Hiển thị tên file rút gọn (basename) nếu là full path/URL
    const fileDisplay = item.mediaFile
      ? (item.mediaFile.includes('/') || item.mediaFile.includes('\\')
        ? (() => { try { return decodeURIComponent(item.mediaFile.split(/[\\\/]/).pop() || item.mediaFile); } catch { return item.mediaFile.split(/[\\\/]/).pop() || item.mediaFile; } })()
        : item.mediaFile)
      : '';
    const fileLine = item.mediaFile
      ? `<div class="grow-sub"><code>${escapeHtml(fileDisplay)}</code>${priorityBadge}</div>`
      : '<div class="grow-sub" style="color:#ff6b6b">— chưa có file hiệu ứng —</div>';
    return `<div class="group-item" data-iid="${item.id}" data-gid="${grp.id}">
      ${iconCell}
      <div class="grow-meta">
        <div class="grow-name"><b>${escapeHtml(displayName)}</b></div>
        ${fileLine}
      </div>
      <div class="grow-actions">
        <input type="number" class="play-count" min="1" max="50" value="1" data-iid="${item.id}" title="Số lượng phát" onclick="event.stopPropagation()" />
        <button class="tiny" data-act="play" data-iid="${item.id}" title="Phát N lần">▶</button>
        <button class="tiny" data-act="edit-item" data-iid="${item.id}">✏️</button>
        <button class="tiny danger" data-act="del-item" data-iid="${item.id}">🗑</button>
      </div>
    </div>`;
  }).join('') || '<div style="color:#555;padding:8px;font-size:11px">Nhóm trống</div>';

  // NHÓM CHUNG: không có toggle bật/tắt + không xoá được + tên cố định
  const toggleHtml = isCommon
    ? '<span class="group-status common">⭐ Luôn bật</span>'
    : `<span class="group-status">${enabled ? 'Đang bật' : 'Đang tắt'}</span>
       <label class="switch" title="Bật/tắt nhóm">
         <input type="checkbox" data-act="toggle-group" data-gid="${grp.id}" ${enabled ? 'checked' : ''} />
         <span class="slider"></span>
       </label>`;
  const editBtn = isCommon ? '' :
    `<button class="tiny" data-act="edit-group" data-gid="${grp.id}" title="Sửa nhóm">✏️</button>`;
  const delBtn = isCommon ? '' :
    `<button class="tiny danger" data-act="del-group" data-gid="${grp.id}" title="Xoá nhóm (items chuyển về NHÓM CHUNG)">🗑</button>`;

  return `<div class="group-card ${enabled ? 'on' : 'off'} ${collapsed ? 'collapsed' : ''} ${isCommon ? 'common' : ''}" data-gid="${grp.id}">
    <div class="group-head">
      <span class="group-name">${escapeHtml(grp.name)}</span>
      <span class="group-badge">${(grp.items || []).length} mục</span>
      ${toggleHtml}
      <button class="tiny" data-act="add-item" data-gid="${grp.id}" title="Thêm vào nhóm">+ mục</button>
      ${editBtn}
      ${delBtn}
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
    if (grp.isCommon) { alert('Không thể xoá NHÓM CHUNG'); return; }
    const itemCount = (grp.items || []).length;
    const msg = itemCount > 0
      ? `Xoá nhóm "${grp.name}"?\n${itemCount} quà bên trong sẽ tự động chuyển về NHÓM CHUNG (KHÔNG mất).`
      : `Xoá nhóm "${grp.name}"?`;
    if (!confirm(msg)) return;
    // Auto-move items về NHÓM CHUNG để KHÔNG mất data
    if (itemCount > 0) {
      const common = getCommonGroup();
      common.items.push(...(grp.items || []));
    }
    mapping.groups = mapping.groups.filter(g => g.id !== gid);
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
      const playTimes = Math.max(1, Math.min(1000, parseInt(countInput?.value || '1', 10) || 1));
      if (found.item.pauseBgm) pauseBgmForEffect();
      // Pre-effect: phát ÂM THANH/VIDEO trước (1 lần) nếu cả gift + setting cùng bật
      maybeDispatchPreEffect(found.item);
      const payload = resolveMediaPayload(found.item.mediaFile);
      for (let i = 0; i < playTimes; i++) {
        await window.bigo.overlayPlay({ overlayId: found.item.overlayId, ...payload });
      }
      // Manual play cũng counter 🎵 effects để user thấy stats hoạt động khi test
      sessionStats.effects += playTimes;
      updateConnectStats();
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
  // Group: tên nhóm hiện tại của gift / groupId pass vào / fallback Mặc định
  let groupName = '';
  if (groupId) {
    const grp = findGroupById(groupId);
    if (grp) groupName = grp.name;
  } else if (gift) {
    const found = findItemById(gift.id);
    if (found) groupName = found.group.name;
  }
  // Populate select Nhóm với tất cả groups
  const allGroups = mapping.groups || [];
  if (allGroups.length === 0) {
    els.dlgGroup.innerHTML = '<option value="Mặc định">Mặc định</option>';
  } else {
    els.dlgGroup.innerHTML = allGroups.map(g =>
      `<option value="${escapeHtml(g.name)}">${escapeHtml(g.name)}</option>`
    ).join('');
  }
  els.dlgGroup.value = groupName || allGroups[0]?.name || 'Mặc định';
  // Priority field
  if (els.dlgPriority) els.dlgPriority.value = gift?.priority || 0;
  els.giftDialog.dataset.editingGroupId = groupId || '';
  els.dlgMasterFilter.value = '';
  els.dlgMasterSort.value = 'kc-asc';
  // refresh overlay options
  els.dlgOverlay.innerHTML = mapping.overlays.length
    ? mapping.overlays.map(o => `<option value="${o.id}">${escapeHtml(o.name)}</option>`).join('')
    : '<option value="">(chưa có overlay)</option>';
  els.dlgOverlay.value = gift?.overlayId || mapping.overlays[0]?.id || '';
  // Nếu mediaFile là full URL/path không có trong dropdown → add option để select được
  const mf = gift?.mediaFile || '';
  if (mf && !Array.from(els.dlgFile.options).some(o => o.value === mf)) {
    const opt = document.createElement('option');
    opt.value = mf;
    opt.textContent = fileDisplayLabel(mf);
    els.dlgFile.appendChild(opt);
  }
  els.dlgFile.value = mf;
  if (els.dlgPauseBgm) els.dlgPauseBgm.checked = !!gift?.pauseBgm;
  // preEffect opt-in: chỉ tick khi user đã explicit set true. undefined/false → unchecked.
  if (els.dlgPreFx) els.dlgPreFx.checked = gift?.preEffect === true;
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
    preEffect: els.dlgPreFx ? els.dlgPreFx.checked : false,
    priority: els.dlgPriority ? Math.max(0, Math.min(100, parseInt(els.dlgPriority.value, 10) || 0)) : 0,
  };
  // Diagnostic log để user verify priority được save đúng
  console.log('[gift saved]', { id: data.id, alias: data.alias, priority: data.priority });
  if (data.priority > 0) appendLog(`[gift saved] "${data.alias || data.matchKeys?.[0]}" priority = ${data.priority}`);
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

// Shared handler cho TẤT CẢ button "+ Thêm quà" — dù bấm ở Tương tác hay Bảng quà,
// flow giống hệt: ensure overlay default → mở giftDialog (no preselect group → vào NHÓM CHUNG).
// Single source of truth: edit logic ở 1 chỗ → cả 2 button đồng bộ.
function openNewGiftDialog() {
  ensureDefaultOverlay();
  openGiftDialog();
}

// Tab Tương tác/Bảng quà: nút Thêm quà — auto tạo overlay default nếu chưa có
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

// Button "+ Thêm quà" của tab Bảng quà. (btnAddGiftEmbed đã xoá khỏi UI vì user
// gặp lỗi sau nhiều lần fix → chỉ còn 1 entry point.)
els.btnAddGift.onclick = openNewGiftDialog;
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
    // Chỉ gửi id + clickThrough — KHÔNG gửi bounds (renderer's bounds có thể stale,
    // bounds thực tế đã được track trong main qua onBoundsChanged khi user move/resize).
    o.clickThrough = (act === 'lock');
    await window.bigo.overlayApplyConfig({ id: o.id, clickThrough: o.clickThrough });
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
  if (els.ovLockRatio) els.ovLockRatio.checked = ov?.lockRatio !== false;
  if (els.ovAutoOpen) els.ovAutoOpen.checked = !!ov?.autoOpen;
  if (els.ovAutoFocus) els.ovAutoFocus.checked = !!ov?.autoFocus;
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
    lockRatio: els.ovLockRatio ? els.ovLockRatio.checked : true,
    autoOpen: els.ovAutoOpen ? els.ovAutoOpen.checked : false,
    autoFocus: els.ovAutoFocus ? els.ovAutoFocus.checked : false,
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
  forwardReceivedGiftsSnapshot();
  recentChats.length = 0;
  if (window.bigo.popupChatsReset) window.bigo.popupChatsReset().catch(() => {});
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
    els.btnConnect.textContent = 'HỦY KẾT NỐI';
    els.btnConnect.classList.remove('primary');
    els.btnConnect.classList.add('danger');
    els.btnEmbedShow.disabled = false;
  } else {
    els.btnConnect.textContent = 'KẾT NỐI';
    els.btnConnect.classList.add('primary');
    els.btnConnect.classList.remove('danger');
    els.btnEmbedShow.disabled = true;
  }
}

async function disconnect() {
  await window.bigo.embedStop();
  els.status.textContent = 'disconnected';
  els.status.classList.remove('on');
  els.status.classList.remove('connected');
  setConnectedUi(false);
  setLiveInfo('Đã hủy kết nối. Nhập BIGO ID khác và bấm KẾT NỐI.', '');
  resetEmbedUi();
}

els.btnConnect.onclick = async () => {
  // Toggle: nếu đang connect → disconnect (confirm tránh bấm nhầm)
  if (isConnected) {
    if (!confirm('⚠️ HỦY KẾT NỐI khỏi room hiện tại?\n\nLịch sử quà + chat trong session này sẽ bị xoá. Tiếp tục?')) return;
    await disconnect();
    return;
  }
  const id = els.embedBigoId.value.trim();
  if (!id) { alert('Nhập BIGO ID'); return; }

  els.btnConnect.disabled = true;
  els.status.textContent = 'checking...';
  els.status.classList.remove('on');
  els.status.classList.remove('connected');

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
  els.status.textContent = `Đã kết nối · ${id}`;
  els.status.classList.add('on');
  els.status.classList.add('connected');
  setConnectedUi(true);
  appendLog(`connected to ${id}`);
  // Auto-play BGM khi kết nối thành công (theo nhóm active hoặc Cài đặt chung)
  applyActiveBgm();
  playBgmIfHas();
};

els.btnPopupGifts.onclick = () => window.bigo.popupOpenGifts();
if (els.btnPopupQueue) els.btnPopupQueue.onclick = () => window.bigo.popupOpenQueue();
// Nút "🗑 Xoá tất cả" trên panel DSHT mini (trang chính) — confirm trước
const btnClearMiniQueue = document.getElementById('btnClearMiniQueue');
if (btnClearMiniQueue) btnClearMiniQueue.onclick = () => {
  if (queueItems.length === 0) {
    appendLog('[queue] DSHT đã trống');
    return;
  }
  if (confirm(`⚠️ Xoá TOÀN BỘ ${queueItems.length} hiệu ứng đang chờ?\n\nThao tác này không thể hoàn tác. Hiệu ứng đang phát cũng sẽ dừng ngay.`)) {
    clearAllQueue();
  }
};
// Chat popup button
const btnPopupChats = document.getElementById('btnPopupChats');
if (btnPopupChats) btnPopupChats.onclick = () => window.bigo.popupOpenChats();

// Recent chats history — popup khi mở sẽ request snapshot để hiển thị history.
const recentChats = [];
const RECENT_CHATS_MAX = 300;
// Khi popup vừa mở → request snapshot → app gửi full recentChats.
if (window.bigo.onChatsRequestSnapshot) {
  window.bigo.onChatsRequestSnapshot(() => {
    if (window.bigo.popupChatsSnapshot) {
      window.bigo.popupChatsSnapshot(recentChats).catch(() => {});
    }
  });
}
// Reset khi disconnect (gắn vào resetEmbedUi nếu có).
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
    avatar: resolveAvatarForUser(ev.user, ev.user_avatar_url),
    gift_name: ev.gift_name || '?',
    gift_id: ev.gift_id,
    gift_icon: ev.gift_icon || ev.gift_icon_url || '',
    count: total,
    diamond: ev.total_diamond,
    level: ev.level,
  });
  if (receivedGifts.length > RECEIVED_MAX) receivedGifts.length = RECEIVED_MAX;
  renderReceivedGifts();
  forwardReceivedGiftsSnapshot();
}

function renderReceivedGifts() {
  const cont = els.liveGifts;
  if (!cont) return;
  if (receivedGifts.length === 0) {
    cont.innerHTML = '';
    return;
  }
  // Tổng quan: tổng KC + số quà + số user (hiển thị header trên list)
  const totalDiamond = receivedGifts.reduce((s, g) => s + (g.diamond || 0), 0);
  const totalCount = receivedGifts.reduce((s, g) => s + (g.count || 0), 0);
  const uniqueUsers = new Set(receivedGifts.map(g => g.user)).size;
  cont.innerHTML = `
    <div class="rcv-summary">
      <span title="Tổng KC nhận được">💎 <b>${totalDiamond.toLocaleString('en-US')}</b></span>
      <span title="Tổng số quà">🎁 <b>${totalCount}</b></span>
      <span title="Số user khác nhau">👤 <b>${uniqueUsers}</b></span>
    </div>
  ` + receivedGifts.map(g => {
    const iconHtml = g.gift_icon
      ? `<img class="rcv-icon" src="${escapeHtml(g.gift_icon)}" loading="lazy" />`
      : '<div class="rcv-icon-empty"></div>';
    // Avatar: chỉ render khi CÓ URL — bỏ avatar trống cho gọn UI.
    const avUrl = resolveAvatarForUser(g.user, g.avatar);
    const avHtml = avUrl ? `<img class="rcv-avatar" src="${escapeHtml(avUrl)}" loading="lazy" />` : '';
    const lvlBadge = g.level ? `<span class="lvl tier-${levelTier(g.level)}" style="margin-right:4px">Lv.${g.level}</span>` : '';
    // Tổng KC = (đơn giá × số lượng). Tooltip show breakdown nếu có data.
    let beansHtml;
    if (g.diamond != null) {
      const unit = g.count > 0 ? Math.round(g.diamond / g.count) : g.diamond;
      const tooltip = g.count > 1
        ? `${unit.toLocaleString('en-US')} KC × ${g.count} = ${g.diamond.toLocaleString('en-US')} KC`
        : `${g.diamond.toLocaleString('en-US')} KC`;
      beansHtml = `<span class="rcv-beans" title="${escapeHtml(tooltip)}">💎 ${g.diamond.toLocaleString('en-US')}</span>`;
    } else {
      beansHtml = `<span class="rcv-beans rcv-beans-unknown" title="Chưa có dữ liệu KC trong master">💎 ?</span>`;
    }
    return `<div class="rcv-row ${avUrl ? '' : 'no-avatar'}" data-gid="${g.id}">
      ${avHtml}
      ${iconHtml}
      <div class="rcv-meta">
        <div class="rcv-who">${lvlBadge}${escapeHtml(g.user)}</div>
        <div class="rcv-gift">${escapeHtml(g.gift_name)}${g.gift_id != null ? ` <span style="color:#666">#${g.gift_id}</span>` : ''}</div>
      </div>
      <span class="rcv-count">×${g.count}</span>
      ${beansHtml}
    </div>`;
  }).join('');
  // QUÀ ĐÃ NHẬN: read-only — không có delete button, không có context menu.
  // User: NPC chỉ xem để nắm thông tin, không xoá. Quà mới nhất ở trên cùng
  // (đã handled bởi receivedGifts.unshift trong addReceivedGift).
}

function priorityTopReceived(idx) {
  if (idx <= 0 || idx >= receivedGifts.length) return;
  const [item] = receivedGifts.splice(idx, 1);
  receivedGifts.unshift(item);
  renderReceivedGifts();
  forwardReceivedGiftsSnapshot();
}
function moveUpReceived(idx) {
  if (idx <= 0 || idx >= receivedGifts.length) return;
  [receivedGifts[idx], receivedGifts[idx - 1]] = [receivedGifts[idx - 1], receivedGifts[idx]];
  renderReceivedGifts();
  forwardReceivedGiftsSnapshot();
}
function moveDownReceived(idx) {
  if (idx < 0 || idx >= receivedGifts.length - 1) return;
  [receivedGifts[idx], receivedGifts[idx + 1]] = [receivedGifts[idx + 1], receivedGifts[idx]];
  renderReceivedGifts();
  forwardReceivedGiftsSnapshot();
}
function removeReceivedGift(id) {
  const idx = receivedGifts.findIndex(g => g.id === id);
  if (idx === -1) return;
  receivedGifts.splice(idx, 1);
  renderReceivedGifts();
  forwardReceivedGiftsSnapshot();
}
function clearAllReceivedGifts() {
  receivedGifts.length = 0;
  renderReceivedGifts();
  forwardReceivedGiftsSnapshot();
}

// Forward FULL snapshot of receivedGifts to popup window. Đảm bảo popup luôn mirror
// chính xác state của main page — kể cả popup mới mở sau khi quà đã đến.
function forwardReceivedGiftsSnapshot() {
  if (!window.bigo.popupGiftsSnapshot) return;
  window.bigo.popupGiftsSnapshot(receivedGifts).catch(() => {});
}

// IPC từ popup window
if (window.bigo.onReceivedGiftsRemove) {
  window.bigo.onReceivedGiftsRemove(id => removeReceivedGift(id));
}
if (window.bigo.onReceivedGiftsClearAll) {
  window.bigo.onReceivedGiftsClearAll(() => {
    if (confirm('Xoá toàn bộ lịch sử quà (cả ở trang chính và popup)?')) clearAllReceivedGifts();
  });
}
// Popup mới mở → request snapshot
if (window.bigo.onReceivedGiftsRequestSnapshot) {
  window.bigo.onReceivedGiftsRequestSnapshot(() => forwardReceivedGiftsSnapshot());
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

// Defensive dedup ở renderer (lớp 2 — primary là preload-embed seenGifts/seenChats).
// User report: tặng quà 2 lần liên tiếp → chỉ count 1. Vì 1s window quá rộng cho gift.
// Fix: chia type-window — gift chỉ 250ms (chỉ tránh DOM race), chat giữ 1s.
const recentEventHashes = new Map();
function shouldDropDuplicate(ev) {
  if (!ev || (ev.type !== 'chat' && ev.type !== 'gift' && ev.type !== 'gift_overlay')) return false;
  const isGift = ev.type === 'gift' || ev.type === 'gift_overlay';
  const key = ev.type === 'chat'
    ? `c|${ev.level}|${normEv(ev.user)}|${normEv(ev.content)}`
    : `g|${normEv(ev.user)}|${normEv(ev.gift_name)}|${ev.gift_count || 1}`;
  const window = isGift ? 250 : 1000;  // Gift: 250ms, Chat: 1s.
  const now = Date.now();
  const last = recentEventHashes.get(key);
  if (last && now - last < window) return true;
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
    const avUrl = resolveAvatarForUser(ev.user, ev.user_avatar_url);
    const av = avUrl ? `<img class="avatar" src="${escapeHtml(avUrl)}" loading="lazy" style="width:20px;height:20px" />` : '';
    const tier = levelTier(ev.level);
    const lvlText = ev.level ? `Lv.${ev.level}` : 'Lv.?';
    div.innerHTML = `${av}<span class="lvl tier-${tier}">${lvlText}</span><span class="who">${escapeHtml(ev.user)}</span><span class="what">${escapeHtml(ev.content)}</span>`;
    // Lưu vào recentChats để popup snapshot khi mở.
    const chatItem = { user: ev.user, level: ev.level, content: ev.content, user_avatar_url: avUrl, ts: Date.now() };
    recentChats.push(chatItem);
    if (recentChats.length > RECENT_CHATS_MAX) recentChats.shift();
    // Forward to chats popup nếu đang mở (per-event live update).
    if (window.bigo.popupChatsEvent) {
      window.bigo.popupChatsEvent(chatItem).catch(() => {});
    }
    // Mới nhất ở DƯỚI: append + auto scroll xuống cuối
    els.liveChats.appendChild(div);
    while (els.liveChats.children.length > 200) els.liveChats.firstChild.remove();
    els.liveChats.scrollTop = els.liveChats.scrollHeight;
    return;
  }
  if (ev.type === 'gift' || ev.type === 'gift_overlay') {
    // Hiệu Ứng Đặc Biệt: check tất cả triggers (clearQueue / speedUp / speedDown)
    if (ev.type === 'gift') {
      checkSpecialEffectsTriggers(ev);
    }
    const matched = findGiftByEvent(ev);
    // Update session stats (chỉ count gift, không count gift_overlay duplicate)
    if (ev.type === 'gift') {
      sessionStats.giftCount += (ev.gift_count || 1) * (ev.combo || 1);
      sessionStats.diamond += ev.total_diamond || 0;
      if (ev.user) sessionStats.users.add(ev.user);
      if (matched && matched.mediaFile) {
        sessionStats.effects += Math.max(1, Math.min(1000, ev.total_count || ev.gift_count || 1));
      }
      updateConnectStats();
      // Push vào received gifts list (right panel) — layout mới gọn
      addReceivedGift(ev);
    }
    if (ev.type === 'gift' && matched && matched.mediaFile && matched.overlayId) {
      // Combo: tặng N lần thì phát N lần. total_count = gift_count × combo.
      const playTimes = Math.max(1, Math.min(1000, ev.total_count || ev.gift_count || 1));
      // Tạm dừng nhạc nền nếu gift cấu hình "không chạy chung"
      if (matched.pauseBgm) pauseBgmForEffect();
      // Pre-effect: phát ÂM THANH/VIDEO trước MỘT LẦN (không lặp theo combo)
      maybeDispatchPreEffect(matched);
      const payload = resolveMediaPayload(matched.mediaFile);
      for (let i = 0; i < playTimes; i++) {
        window.bigo.overlayPlay({ overlayId: matched.overlayId, ...payload });
      }
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

function nudgeAutoFocusOverlays() {
  // Auto-focus: overlay nào có cfg.autoFocus → showInactive (không steal focus)
  for (const ov of (mapping.overlays || [])) {
    if (ov.autoFocus) {
      try { window.bigo.overlayNudge(ov.id); } catch {}
    }
  }
}

function renderEmbedEvent(ev) {
  if (ev.kind === 'parsed') {
    // Auto-focus on gift or chat event
    if (ev.type === 'gift' || ev.type === 'chat') nudgeAutoFocusOverlays();
    // Heart event → bump heart KPI counter
    if (ev.type === 'heart') {
      const n = parseInt(ev.count, 10) || 1;
      bumpHeartCount(n);
    }
    return renderParsed(ev);
  }
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
  preFx: { enabled: false, file: null, fileName: '' },  // Âm thanh phát trước hiệu ứng
  // Hiệu Ứng Đặc Biệt: trigger gift cho action đặc biệt
  specialEffects: {
    clearQueue:      { enabled: false, typeid: null, giftName: '', iconUrl: '' },
    // 4 speed riêng — tách audio (mp3/wav) vs video (mp4/webm) độc lập.
    // Video không nên tăng giảm tốc nhiều (cảm giác khó chịu) → user setup factor riêng.
    speedUpAudio:    { enabled: false, typeid: null, giftName: '', iconUrl: '', factor: 1.25, duration: 10 },
    speedDownAudio:  { enabled: false, typeid: null, giftName: '', iconUrl: '', factor: 0.75, duration: 10 },
    speedUpVideo:    { enabled: false, typeid: null, giftName: '', iconUrl: '', factor: 1.20, duration: 8 },
    speedDownVideo:  { enabled: false, typeid: null, giftName: '', iconUrl: '', factor: 0.80, duration: 8 },
    // TÁP TIM: KPI hearts. Khi đạt target → phát media (mp3/mp4).
    heartGoal:       { enabled: false, target: 100, mediaFile: '', overlayId: '', currentCount: 0 },
  },
  fxVolume: 100,
  maxListItems: 200,
};

async function saveAppSettings(patch) {
  const s = await window.bigo.settingsLoad();
  if (patch) {
    if (patch.bgm) s.bgm = { ...(s.bgm || {}), ...patch.bgm };
    if (patch.preFx) s.preFx = { ...(s.preFx || {}), ...patch.preFx };
    if (patch.specialEffects) {
      s.specialEffects = s.specialEffects || {};
      for (const [k, v] of Object.entries(patch.specialEffects)) {
        s.specialEffects[k] = { ...(s.specialEffects[k] || {}), ...v };
      }
    }
    if ('fxVolume' in patch) s.fxVolume = patch.fxVolume;
    if ('maxListItems' in patch) s.maxListItems = patch.maxListItems;
  }
  await window.bigo.settingsSave(s);
}

// Resolve mediaFile thành payload cho overlay:play IPC.
// - Basename (không có slash, không có file://) → { file } (legacy assets/effects)
// - Full path / file:// URL → { fileUrl } (file user pick từ ổ đĩa, không copy)
function resolveMediaPayload(mediaFile) {
  if (!mediaFile) return null;
  const isUrl = /^file:\/\//i.test(mediaFile);
  const isAbsPath = /^[a-z]:[\\\/]/i.test(mediaFile) || /^\//.test(mediaFile);
  if (isUrl) return { fileUrl: mediaFile };
  if (isAbsPath) {
    return { fileUrl: 'file:///' + mediaFile.replace(/\\/g, '/').replace(/^\/+/, '') };
  }
  return { file: mediaFile };
}

// Phát file pre-effect (mp3/mp4/wav/webm) qua overlay.
// Gọi 1 LẦN trước khi dispatch effect chính (không lặp theo combo).
// Pre-effect file được user pick từ ổ đĩa → dùng raw fileUrl IPC variant.
//
// MODEL OPT-IN: mặc định OFF cho mọi quà. User phải EXPLICIT tick checkbox trên dialog
// từng quà → giftItem.preEffect === true → mới phát. Toggle global setting off/on
// nhiều lần KHÔNG tự bật lại quà nào — mỗi quà giữ nguyên trạng thái user đã set.
// Pre-effect "ghost" count: số ended events đến từ pre-effect plays (KHÔNG phải
// main effect). Khi onOverlayEffectEnded fire, nếu _preEffectPending > 0 thì
// decrement counter — KHÔNG advance app queueItems (vì app queue chỉ track
// main effects, pre-effect là phụ).
let _preEffectPending = 0;

function maybeDispatchPreEffect(giftItem) {
  if (!giftItem) return;
  if (giftItem.preEffect !== true) return;
  const cfg = appSettings.preFx;
  if (!cfg || !cfg.enabled || !cfg.file) return;
  if (!giftItem.overlayId) return;
  try {
    _preEffectPending++;
    window.bigo.overlayPlay({ overlayId: giftItem.overlayId, fileUrl: cfg.file });
  } catch (e) { console.warn('preFx dispatch failed:', e); }
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
  appSettings.preFx = { ...appSettings.preFx, ...(s.preFx || {}) };
  // Migrate old clearGift → specialEffects.clearQueue (backward compat)
  if (s.clearGift && !s.specialEffects?.clearQueue) {
    appSettings.specialEffects.clearQueue = {
      enabled: !!s.clearGift.enabled,
      typeid: s.clearGift.typeid || null,
      giftName: s.clearGift.giftName || '',
      iconUrl: '',
    };
  }
  if (s.specialEffects) {
    // Migrate speedUp/speedDown cu → speedUpAudio + speedUpVideo (cùng factor).
    if (s.specialEffects.speedUp && !s.specialEffects.speedUpAudio) {
      appSettings.specialEffects.speedUpAudio = { ...appSettings.specialEffects.speedUpAudio, ...s.specialEffects.speedUp };
      appSettings.specialEffects.speedUpVideo = { ...appSettings.specialEffects.speedUpVideo, ...s.specialEffects.speedUp };
    }
    if (s.specialEffects.speedDown && !s.specialEffects.speedDownAudio) {
      appSettings.specialEffects.speedDownAudio = { ...appSettings.specialEffects.speedDownAudio, ...s.specialEffects.speedDown };
      appSettings.specialEffects.speedDownVideo = { ...appSettings.specialEffects.speedDownVideo, ...s.specialEffects.speedDown };
    }
    for (const k of ['clearQueue','speedUpAudio','speedDownAudio','speedUpVideo','speedDownVideo','heartGoal']) {
      if (s.specialEffects[k]) {
        appSettings.specialEffects[k] = { ...appSettings.specialEffects[k], ...s.specialEffects[k] };
      }
    }
  }
  appSettings.fxVolume = s.fxVolume != null ? s.fxVolume : 100;
  appSettings.maxListItems = s.maxListItems || 200;
  // Apply special effects UI
  applySpecialEffectsUi();
  applyHeartGoalUi();
  // Apply BGM
  if (els.bgmAudio) {
    els.bgmAudio.volume = (appSettings.bgm.volume || 80) / 100;
    if (appSettings.bgm.file) els.bgmAudio.src = appSettings.bgm.file;
    if (appSettings.bgm.fileName) els.bgmFileLabel.value = appSettings.bgm.fileName;
  }
  // Apply pre-effect UI
  if (els.preFxFileLabel) els.preFxFileLabel.value = appSettings.preFx.fileName || '';
  if (els.preFxEnabled) els.preFxEnabled.checked = !!appSettings.preFx.enabled;
  // Apply UI controls
  if (els.bgmVol) { els.bgmVol.value = appSettings.bgm.volume || 80; els.bgmVolVal.textContent = els.bgmVol.value; }
  if (els.fxVol) { els.fxVol.value = appSettings.fxVolume; els.fxVolVal.textContent = appSettings.fxVolume; }
  if (els.maxListItems) els.maxListItems.value = appSettings.maxListItems;
  // Devices
  await refreshAudioDevices();
  await applyBgmSinkId();
}

// =================== Pre-effect sound controls ===================
if (els.btnPickPreFx) {
  els.btnPickPreFx.onclick = async () => {
    const r = await window.bigo.pickPreFxFile();
    if (!r.ok) return;
    appSettings.preFx.file = r.fileUrl;
    appSettings.preFx.fileName = r.fileName;
    if (els.preFxFileLabel) els.preFxFileLabel.value = r.fileName;
    await saveAppSettings({ preFx: { file: r.fileUrl, fileName: r.fileName } });
  };
}
if (els.btnTestPreFx) {
  els.btnTestPreFx.onclick = () => {
    if (!appSettings.preFx.file) { alert('Chưa chọn file'); return; }
    // Phát test qua overlay đầu tiên (hoặc renderer audio nếu không có overlay)
    const ov = (mapping?.overlays || [])[0];
    if (ov) {
      window.bigo.overlayPlay({ overlayId: ov.id, fileUrl: appSettings.preFx.file });
    } else {
      // fallback: phát bằng audio element tạm
      const a = new Audio(appSettings.preFx.file);
      a.volume = (appSettings.fxVolume || 100) / 100;
      a.play().catch(e => alert('Không phát được: ' + e.message));
    }
  };
}
if (els.btnClearPreFx) {
  els.btnClearPreFx.onclick = async () => {
    appSettings.preFx.file = null;
    appSettings.preFx.fileName = '';
    if (els.preFxFileLabel) els.preFxFileLabel.value = '';
    await saveAppSettings({ preFx: { file: null, fileName: '' } });
  };
}
if (els.preFxEnabled) {
  els.preFxEnabled.addEventListener('change', async () => {
    appSettings.preFx.enabled = !!els.preFxEnabled.checked;
    await saveAppSettings({ preFx: { enabled: appSettings.preFx.enabled } });
  });
}

// =================== Hiệu Ứng Đặc Biệt ===================
// 3 trigger gift: clearQueue | speedUp | speedDown. Dùng dedicated picker dialog
// có master table giống dlgMaster. User click row → save typeid+name+icon.

const SE_LABELS = {
  clearQueue:      { id: 'seClearQueueLabel',      enabled: 'seClearQueueEnabled',      factor: null,                     duration: null },
  speedUpAudio:    { id: 'seSpeedUpAudioLabel',    enabled: 'seSpeedUpAudioEnabled',    factor: 'seSpeedUpAudioFactor',   duration: 'seSpeedUpAudioDuration' },
  speedDownAudio:  { id: 'seSpeedDownAudioLabel',  enabled: 'seSpeedDownAudioEnabled',  factor: 'seSpeedDownAudioFactor', duration: 'seSpeedDownAudioDuration' },
  speedUpVideo:    { id: 'seSpeedUpVideoLabel',    enabled: 'seSpeedUpVideoEnabled',    factor: 'seSpeedUpVideoFactor',   duration: 'seSpeedUpVideoDuration' },
  speedDownVideo:  { id: 'seSpeedDownVideoLabel',  enabled: 'seSpeedDownVideoEnabled',  factor: 'seSpeedDownVideoFactor', duration: 'seSpeedDownVideoDuration' },
};

function applySpecialEffectsUi() {
  for (const [key, ref] of Object.entries(SE_LABELS)) {
    const cfg = appSettings.specialEffects[key] || {};
    const labelEl = document.getElementById(ref.id);
    const enabledEl = document.getElementById(ref.enabled);
    if (labelEl) {
      if (cfg.giftName) {
        const idText = cfg.typeid ? ` (id ${cfg.typeid})` : '';
        const iconHtml = cfg.iconUrl ? `<img src="${escapeHtml(cfg.iconUrl)}" style="width:18px;height:18px;vertical-align:middle;margin-right:6px;border-radius:3px" />` : '';
        labelEl.innerHTML = `${iconHtml}<b>${escapeHtml(cfg.giftName)}</b>${idText}`;
      } else {
        labelEl.textContent = '— chưa chọn —';
      }
    }
    if (enabledEl) enabledEl.checked = !!cfg.enabled;
    if (ref.factor) {
      const facEl = document.getElementById(ref.factor);
      if (facEl && cfg.factor != null) facEl.value = cfg.factor;
    }
    if (ref.duration) {
      const durEl = document.getElementById(ref.duration);
      if (durEl && cfg.duration != null) durEl.value = cfg.duration;
    }
  }
}

// Dedicated master picker dialog
function openSpecialPicker(targetKey) {
  const dlg = document.getElementById('specialPickerDialog');
  if (!dlg) return;
  dlg.dataset.target = targetKey;
  document.getElementById('specialPickerTitle').textContent = `Chọn quà tặng cho "${SE_TITLES[targetKey] || targetKey}"`;
  const filter = document.getElementById('spMasterFilter');
  const sort = document.getElementById('spMasterSort');
  if (filter) filter.value = '';
  if (sort) sort.value = 'kc-asc';
  renderSpecialPickerTable();
  dlg.showModal();
}

const SE_TITLES = {
  clearQueue: 'Xoá danh sách hiệu ứng',
  speedUp: 'Tăng tốc nhạc nền',
  speedDown: 'Giảm tốc nhạc nền',
};

let _spRenderTimer = null;
function scheduleSpecialPickerRender() {
  clearTimeout(_spRenderTimer);
  _spRenderTimer = setTimeout(renderSpecialPickerTable, 80);
}

function renderSpecialPickerTable() {
  const body = document.getElementById('spMasterTableBody');
  const total = document.getElementById('spMasterTotal');
  const count = document.getElementById('spMasterCount');
  const filter = (document.getElementById('spMasterFilter')?.value || '').toLowerCase().trim();
  const sortVal = document.getElementById('spMasterSort')?.value || 'kc-asc';
  const vnOnly = document.getElementById('spMasterVnOnly')?.checked;
  const favOnly = document.getElementById('spMasterFavOnly')?.checked;
  if (!masterFullList) {
    if (body) body.innerHTML = '';
    if (count) count.textContent = 'đang tải master...';
    return;
  }
  if (total) total.textContent = masterFullList.length;
  let arr = masterFullList.slice();
  if (filter) {
    const fnum = parseInt(filter, 10);
    arr = arr.filter(g => {
      if (!isNaN(fnum) && String(fnum) === filter) return g.typeid === fnum;
      return String(g.name || '').toLowerCase().includes(filter) || String(g.typeid).includes(filter);
    });
  }
  if (vnOnly) arr = arr.filter(g => isVnGift(g));
  if (favOnly) arr = arr.filter(g => giftFavorites.has(g.typeid));
  arr = sortMasterArr(arr, sortVal);
  const renderLimit = 200;
  if (count) count.textContent = `${arr.length} kết quả`;
  if (body) {
    body.innerHTML = arr.slice(0, renderLimit).map(g => {
      const iconUrl = g.localIcon || g.img_url || '';
      const isFav = giftFavorites.has(g.typeid);
      return `<tr data-typeid="${g.typeid}" data-name="${escapeHtml(g.name)}" data-icon="${escapeHtml(iconUrl)}">
        <td>${iconUrl ? `<img src="${escapeHtml(iconUrl)}" style="width:32px;height:32px;object-fit:contain" />` : ''}</td>
        <td><span class="id">${g.typeid}</span></td>
        <td><span class="price">💎 ${g.diamonds ?? '?'}</span></td>
        <td><span class="name">${escapeHtml(g.name)}</span></td>
        <td><button type="button" class="fav-btn ${isFav ? 'on' : ''}" data-fav="${g.typeid}" title="Yêu thích">${isFav ? '⭐' : '☆'}</button></td>
      </tr>`;
    }).join('');
    if (arr.length > renderLimit && count) count.textContent += ` · hiển thị ${renderLimit} đầu`;
    body.querySelectorAll('tr').forEach(row => {
      row.style.cursor = 'pointer';
      row.onclick = (e) => {
        if (e.target.classList && e.target.classList.contains('fav-btn')) return;
        const dlg = document.getElementById('specialPickerDialog');
        const targetKey = dlg.dataset.target;
        if (!targetKey || !appSettings.specialEffects[targetKey]) return;
        appSettings.specialEffects[targetKey].typeid = parseInt(row.dataset.typeid, 10);
        appSettings.specialEffects[targetKey].giftName = row.dataset.name;
        appSettings.specialEffects[targetKey].iconUrl = row.dataset.icon;
        saveAppSettings({ specialEffects: { [targetKey]: {
          typeid: appSettings.specialEffects[targetKey].typeid,
          giftName: appSettings.specialEffects[targetKey].giftName,
          iconUrl: appSettings.specialEffects[targetKey].iconUrl,
        } } });
        applySpecialEffectsUi();
        dlg.close();
      };
    });
    body.querySelectorAll('.fav-btn').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.fav, 10);
        if (giftFavorites.has(id)) giftFavorites.delete(id);
        else giftFavorites.add(id);
        saveFavorites(giftFavorites);
        renderSpecialPickerTable();
      };
    });
  }
}

// Wire pick / unpick / enable / factor inputs
document.querySelectorAll('.se-pick').forEach(btn => {
  btn.onclick = () => openSpecialPicker(btn.dataset.seKey);
});
document.querySelectorAll('.se-unpick').forEach(btn => {
  btn.onclick = async () => {
    const key = btn.dataset.seKey;
    if (!appSettings.specialEffects[key]) return;
    appSettings.specialEffects[key].typeid = null;
    appSettings.specialEffects[key].giftName = '';
    appSettings.specialEffects[key].iconUrl = '';
    await saveAppSettings({ specialEffects: { [key]: { typeid: null, giftName: '', iconUrl: '' } } });
    applySpecialEffectsUi();
  };
});
['clearQueue','speedUpAudio','speedDownAudio','speedUpVideo','speedDownVideo'].forEach(key => {
  const enabledEl = document.getElementById(SE_LABELS[key].enabled);
  if (enabledEl) enabledEl.addEventListener('change', async () => {
    appSettings.specialEffects[key].enabled = !!enabledEl.checked;
    await saveAppSettings({ specialEffects: { [key]: { enabled: enabledEl.checked } } });
  });
  const facKey = SE_LABELS[key].factor;
  if (facKey) {
    const facEl = document.getElementById(facKey);
    if (facEl) facEl.addEventListener('change', async () => {
      const v = parseFloat(facEl.value) || 1;
      appSettings.specialEffects[key].factor = v;
      await saveAppSettings({ specialEffects: { [key]: { factor: v } } });
    });
  }
  const durKey = SE_LABELS[key].duration;
  if (durKey) {
    const durEl = document.getElementById(durKey);
    if (durEl) durEl.addEventListener('change', async () => {
      const v = Math.max(1, Math.min(600, parseInt(durEl.value, 10) || 10));
      appSettings.specialEffects[key].duration = v;
      durEl.value = v;
      await saveAppSettings({ specialEffects: { [key]: { duration: v } } });
    });
  }
});

// =================== TÁP TIM (heart goal KPI) ===================
// Trigger: khi tổng số tym đạt target → phát media. Counter reset sau đó.
// Nguồn data heart count: scraper bigo.tv (preload-embed) phải detect heart UI
// element và emit 'heart_count' event. Hiện tại scraper CHƯA detect → tính năng
// này wire UI + logic, chờ DOM live test để add scraper hook.
function applyHeartGoalUi() {
  const cfg = appSettings.specialEffects?.heartGoal || {};
  const enabledEl = document.getElementById('seHeartEnabled');
  const targetEl = document.getElementById('seHeartTarget');
  const targetDispEl = document.getElementById('seHeartTargetDisp');
  const countEl = document.getElementById('seHeartCount');
  if (enabledEl) enabledEl.checked = !!cfg.enabled;
  if (targetEl) targetEl.value = cfg.target || 100;
  if (targetDispEl) targetDispEl.textContent = cfg.target || 100;
  if (countEl) countEl.textContent = cfg.currentCount || 0;
  // Populate file dropdown from effects
  const fileEl = document.getElementById('seHeartFile');
  if (fileEl) {
    fileEl.innerHTML = '<option value="">— chọn file hoặc bấm 📁 —</option>'
      + (effects || []).map(e => `<option value="${escapeHtml(e.file)}"${cfg.mediaFile === e.file ? ' selected' : ''}>${escapeHtml(e.file)}</option>`).join('');
    if (cfg.mediaFile && !(effects || []).find(e => e.file === cfg.mediaFile)) {
      // URL → add option
      const opt = document.createElement('option');
      opt.value = cfg.mediaFile;
      opt.textContent = '📁 ' + (cfg.mediaFile.split(/[\/\\]/).pop() || cfg.mediaFile);
      opt.selected = true;
      fileEl.appendChild(opt);
    }
  }
  // Populate overlay dropdown
  const ovEl = document.getElementById('seHeartOverlay');
  if (ovEl) {
    ovEl.innerHTML = (mapping?.overlays || []).map(o =>
      `<option value="${o.id}"${cfg.overlayId === o.id ? ' selected' : ''}>${escapeHtml(o.name)}</option>`
    ).join('') || '<option value="">(chưa có overlay)</option>';
  }
}

function bumpHeartCount(n = 1) {
  const cfg = appSettings.specialEffects.heartGoal;
  if (!cfg || !cfg.enabled) return;
  cfg.currentCount = (cfg.currentCount || 0) + n;
  const countEl = document.getElementById('seHeartCount');
  if (countEl) countEl.textContent = cfg.currentCount;
  if (cfg.currentCount >= (cfg.target || 100)) {
    // Reach target → fire media + reset counter
    appendLog(`[se:heartGoal] Đạt ${cfg.currentCount}/${cfg.target} tym → phát media`);
    if (cfg.mediaFile && cfg.overlayId) {
      const payload = resolveMediaPayload(cfg.mediaFile);
      window.bigo.overlayPlay({ overlayId: cfg.overlayId, ...payload }).catch(() => {});
    }
    cfg.currentCount = 0;
    if (countEl) countEl.textContent = 0;
    saveAppSettings({ specialEffects: { heartGoal: { currentCount: 0 } } });
  }
}

// Wire UI
(function wireHeartGoal() {
  const enabledEl = document.getElementById('seHeartEnabled');
  const targetEl = document.getElementById('seHeartTarget');
  const fileEl = document.getElementById('seHeartFile');
  const ovEl = document.getElementById('seHeartOverlay');
  const pickBtn = document.getElementById('btnHeartPickFile');
  const resetBtn = document.getElementById('btnHeartReset');
  if (enabledEl) enabledEl.addEventListener('change', () => {
    appSettings.specialEffects.heartGoal.enabled = enabledEl.checked;
    saveAppSettings({ specialEffects: { heartGoal: { enabled: enabledEl.checked } } });
  });
  if (targetEl) targetEl.addEventListener('change', () => {
    const v = Math.max(1, Math.min(10000, parseInt(targetEl.value, 10) || 100));
    appSettings.specialEffects.heartGoal.target = v;
    targetEl.value = v;
    document.getElementById('seHeartTargetDisp').textContent = v;
    saveAppSettings({ specialEffects: { heartGoal: { target: v } } });
  });
  if (fileEl) fileEl.addEventListener('change', () => {
    appSettings.specialEffects.heartGoal.mediaFile = fileEl.value;
    saveAppSettings({ specialEffects: { heartGoal: { mediaFile: fileEl.value } } });
  });
  if (ovEl) ovEl.addEventListener('change', () => {
    appSettings.specialEffects.heartGoal.overlayId = ovEl.value;
    saveAppSettings({ specialEffects: { heartGoal: { overlayId: ovEl.value } } });
  });
  if (pickBtn) pickBtn.onclick = async () => {
    const r = await window.bigo.effectsPickFiles();
    if (!r.ok || !r.files?.length) return;
    const picked = r.files[0];
    appSettings.specialEffects.heartGoal.mediaFile = picked.fileUrl;
    if (fileEl) {
      const opt = document.createElement('option');
      opt.value = picked.fileUrl;
      opt.textContent = '📁 ' + picked.fileName;
      opt.selected = true;
      fileEl.appendChild(opt);
      fileEl.value = picked.fileUrl;
    }
    saveAppSettings({ specialEffects: { heartGoal: { mediaFile: picked.fileUrl } } });
  };
  if (resetBtn) resetBtn.onclick = () => {
    appSettings.specialEffects.heartGoal.currentCount = 0;
    document.getElementById('seHeartCount').textContent = 0;
    saveAppSettings({ specialEffects: { heartGoal: { currentCount: 0 } } });
  };
})();

// "▶ Test" button: phát thử ngay (không cần gift trigger).
document.querySelectorAll('.se-test').forEach(btn => {
  btn.onclick = () => {
    const key = btn.dataset.seKey;
    if (key === 'speedUp' || key === 'speedDown') {
      triggerSpeedEffect(key);
      appendLog(`[se:${key}] TEST ngay (không qua gift)`);
    } else if (key === 'clearQueue') {
      if (!confirm('Test xoá toàn bộ DSHT?')) return;
      clearAllQueue();
      appendLog(`[se:clearQueue] TEST clearAllQueue`);
    }
  };
});
// Picker filter/sort live update
['spMasterFilter','spMasterSort','spMasterVnOnly','spMasterFavOnly'].forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  if (el.tagName === 'INPUT' && el.type !== 'checkbox') el.addEventListener('input', scheduleSpecialPickerRender);
  else el.addEventListener('change', renderSpecialPickerTable);
});
// Reset Effect speed button — clear cả pending để bypass lock
const btnResetBgmSpeed = document.getElementById('btnResetBgmSpeed');
if (btnResetBgmSpeed) {
  btnResetBgmSpeed.onclick = () => {
    if (_speedRevertTimer) { clearTimeout(_speedRevertTimer); _speedRevertTimer = null; }
    _speedRevertEndsAt = 0;
    _pendingSpeedKey = null;
    applyEffectSpeed(1.0);
  };
}

// Effect speed control — tác động vào HIỆU ỨNG (mp3/mp4/webm) trên overlay.
// Tách 2 axis: audioRate (mp3/wav) + videoRate (mp4/webm) độc lập.
let _currentAudioSpeed = 1.0;
let _currentVideoSpeed = 1.0;

function applyAudioSpeed(rate) {
  const r = Math.max(0.25, Math.min(3, parseFloat(rate) || 1));
  _currentAudioSpeed = r;
  if (window.bigo.overlaySetSpeed) window.bigo.overlaySetSpeed({ audioRate: r }).catch(() => {});
  updateSpeedDisplay();
}
function applyVideoSpeed(rate) {
  const r = Math.max(0.25, Math.min(3, parseFloat(rate) || 1));
  _currentVideoSpeed = r;
  if (window.bigo.overlaySetSpeed) window.bigo.overlaySetSpeed({ videoRate: r }).catch(() => {});
  updateSpeedDisplay();
}
function applyAllSpeed(rate) { applyAudioSpeed(rate); applyVideoSpeed(rate); }
// Backward compat alias
function applyEffectSpeed(rate) { applyAllSpeed(rate); }

function updateSpeedDisplay() {
  const disp = document.getElementById('bgmSpeedDisplay');
  if (!disp) return;
  const fmtRate = (r) => r.toFixed(2).replace(/\.?0+$/, '');
  if (_currentAudioSpeed === _currentVideoSpeed) {
    disp.textContent = `Tốc độ: ×${fmtRate(_currentAudioSpeed)} (cả audio + video)`;
  } else {
    disp.textContent = `🎵 Audio: ×${fmtRate(_currentAudioSpeed)} · 🎬 Video: ×${fmtRate(_currentVideoSpeed)}`;
  }
}

// Trigger speed effect: apply factor + auto-revert về 1.0 sau duration giây.
//
// LOCK SEMANTICS (theo yêu cầu user): Trong thời gian speed effect đang active
// (timer chưa expire), trigger MỚI sẽ KHÔNG apply ngay — thay vào đó được QUEUE
// để apply sau khi current revert về 1.0. Tránh việc "ai tặng nhanh/chậm là
// thay đổi liền" → effect dứt khoát theo duration đã cài.
let _speedRevertTimer = null;
let _speedRevertEndsAt = 0;     // timestamp ms — khi nào current speed effect kết thúc
let _pendingSpeedKey = null;     // key tiếp theo đang đợi (latest wins)

function triggerSpeedEffect(key) {
  if (_speedRevertTimer) {
    // Đang có speed effect active → queue trigger này, sẽ apply sau khi revert.
    _pendingSpeedKey = key;
    const remainMs = Math.max(0, _speedRevertEndsAt - Date.now());
    const remainSec = Math.ceil(remainMs / 1000);
    appendLog(`[se:${key}] đang có speed effect chạy → queued, áp dụng sau ${remainSec}s`);
    const disp = document.getElementById('bgmSpeedDisplay');
    if (disp) disp.textContent += ` · queued: ${key}`;
    return;
  }
  _applyAndScheduleSpeed(key);
}

// Map key → axis ('audio' / 'video' / 'both') để biết apply lên đâu.
const SPEED_AXIS = {
  speedUpAudio: 'audio', speedDownAudio: 'audio',
  speedUpVideo: 'video', speedDownVideo: 'video',
  // legacy keys (đã migrate, vẫn handle nếu còn)
  speedUp: 'both', speedDown: 'both',
};

function _applyAndScheduleSpeed(key) {
  const cfg = appSettings.specialEffects?.[key];
  if (!cfg) return;
  const factor = parseFloat(cfg.factor) || 1;
  const duration = Math.max(1, parseInt(cfg.duration, 10) || 10);
  const axis = SPEED_AXIS[key] || 'both';
  // Apply theo axis
  if (axis === 'audio') applyAudioSpeed(factor);
  else if (axis === 'video') applyVideoSpeed(factor);
  else applyAllSpeed(factor);
  _speedRevertEndsAt = Date.now() + duration * 1000;
  _speedRevertTimer = setTimeout(() => {
    // Revert cùng axis về 1.0
    if (axis === 'audio') applyAudioSpeed(1.0);
    else if (axis === 'video') applyVideoSpeed(1.0);
    else applyAllSpeed(1.0);
    appendLog(`[se] ${key} (${axis}) kết thúc (${duration}s) → revert ×1.0`);
    _speedRevertTimer = null;
    _speedRevertEndsAt = 0;
    if (_pendingSpeedKey) {
      const nextKey = _pendingSpeedKey;
      _pendingSpeedKey = null;
      setTimeout(() => {
        appendLog(`[se] Apply pending speed: ${nextKey}`);
        _applyAndScheduleSpeed(nextKey);
      }, 100);
    }
  }, duration * 1000);
}

// Backward compat: old code có thể gọi applyBgmSpeed → forward sang applyEffectSpeed.
function applyBgmSpeed(rate) { applyEffectSpeed(rate); }

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
async function settingsGroupRename(gid) {
  console.log('[settingsGroupRename]', gid);
  const g = findGroupById(gid);
  if (!g) { alert('Nhóm không tồn tại (gid=' + gid + ')'); return; }
  if (g.isCommon) { alert('Không thể đổi tên NHÓM CHUNG'); return; }
  const newName = prompt('Đổi tên nhóm:', g.name);
  if (!newName || !newName.trim()) return;
  const lower = newName.trim().toLowerCase();
  const dup = (mapping.groups || []).find(x => x.id !== gid && x.name.toLowerCase() === lower);
  if (dup) { alert(`Đã có nhóm "${dup.name}" - tên trùng (không phân biệt hoa/thường)`); return; }
  g.name = newName.trim();
  await persistMapping();
  renderSettingsGroupsList();
  renderGiftTable();
}

async function settingsGroupDelete(gid) {
  const g = findGroupById(gid);
  if (!g) return;
  if (g.isCommon) { alert('Không thể xoá NHÓM CHUNG'); return; }
  const itemCount = (g.items || []).length;
  const msg = itemCount > 0
    ? `Xoá nhóm "${g.name}"?\n${itemCount} quà bên trong sẽ tự động chuyển về NHÓM CHUNG (KHÔNG mất).`
    : `Xoá nhóm "${g.name}"?`;
  if (!confirm(msg)) return;
  if (itemCount > 0) {
    const common = getCommonGroup();
    common.items.push(...(g.items || []));
  }
  mapping.groups = (mapping.groups || []).filter(x => x.id !== gid);
  await persistMapping();
  renderSettingsGroupsList();
  renderGiftTable();
}

// Expose ra window để onclick attribute có thể gọi
window.settingsGroupRename = settingsGroupRename;
window.settingsGroupDelete = settingsGroupDelete;

function renderSettingsGroupsList() {
  const container = document.getElementById('groupsListSettings');
  if (!container) return;
  const groups = mapping.groups || [];
  if (groups.length === 0) {
    container.innerHTML = '<div class="gls-empty">Chưa có nhóm nào — gõ tên rồi bấm "+ Tạo nhóm"</div>';
    return;
  }
  // KHÔNG inline onclick (Electron CSP block). KHÔNG attach listener trong render
  // (race condition khi re-render). Click delegated qua document.body — single
  // listener bulletproof bên dưới.
  container.innerHTML = groups.map(g => `
    <div class="gls-row" data-gid="${g.id}">
      <span class="name">${escapeHtml(g.name)}${g.isCommon ? ' <span style="color:#ffd166">⭐</span>' : ''}</span>
      <span class="count">${(g.items || []).length} mục</span>
      ${g.isCommon ? '' : `<button class="tiny" data-glsact="rename" data-gid="${g.id}" title="Đổi tên">✏️</button>`}
      ${g.isCommon ? '' : `<button class="tiny danger" data-glsact="del" data-gid="${g.id}" title="Xoá (items về NHÓM CHUNG)">🗑</button>`}
    </div>
  `).join('');
}

// =================== GLOBAL CLICK DELEGATION ===================
// Single listener trên document.body — bulletproof, KHÔNG bị mất khi innerHTML
// re-render. Match qua data attributes. Pattern chuẩn cho dynamic content.
async function _handleCreateGroup() {
  const input = document.getElementById('newGroupName');
  if (!input) return;
  const name = input.value.trim();
  if (!name) { alert('Nhập tên nhóm'); return; }
  const lower = name.toLowerCase();
  const exists = (mapping.groups || []).find(g => (g.name || '').toLowerCase() === lower);
  if (exists) {
    alert(`Đã có nhóm "${exists.name}" - không phân biệt hoa/thường`);
    return;
  }
  findOrCreateGroupCI(name, 'gift');
  await persistMapping();
  input.value = '';
  renderSettingsGroupsList();
  renderGiftTable();
}

document.body.addEventListener('click', async (e) => {
  // Settings groups list — nút Sửa
  const renameBtn = e.target.closest('[data-glsact="rename"]');
  if (renameBtn) {
    e.preventDefault();
    console.log('[delegated] gls rename:', renameBtn.dataset.gid);
    settingsGroupRename(renameBtn.dataset.gid);
    return;
  }
  // Settings groups list — nút Xoá
  const delBtn = e.target.closest('[data-glsact="del"]');
  if (delBtn) {
    e.preventDefault();
    console.log('[delegated] gls delete:', delBtn.dataset.gid);
    settingsGroupDelete(delBtn.dataset.gid);
    return;
  }
  // Nút + Tạo nhóm
  if (e.target.closest('#btnCreateGroup')) {
    e.preventDefault();
    console.log('[delegated] create group');
    await _handleCreateGroup();
    return;
  }
});

// Enter key trong input newGroupName → trigger tạo nhóm
const _newGroupInput = document.getElementById('newGroupName');
if (_newGroupInput) {
  _newGroupInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      _handleCreateGroup();
    }
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
