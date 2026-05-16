const $ = (id) => document.getElementById(id);

// =================== State ===================
let mapping = { version: 3, groups: [], overlays: [] };
let effects = [];

// =================== Toast notifications ===================
const _toastSeen = new Map();
function showToast({ key, title, body, type = 'info', ttl = 6000, throttle = 10000 }) {
  if (key) {
    const last = _toastSeen.get(key) || 0;
    if (Date.now() - last < throttle) return;
    _toastSeen.set(key, Date.now());
  }
  const container = $('toastContainer');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `
    ${title ? `<div class="toast-title"></div>` : ''}
    ${body ? `<div class="toast-body"></div>` : ''}
  `;
  if (title) el.querySelector('.toast-title').textContent = title;
  if (body) el.querySelector('.toast-body').textContent = body;
  const remove = () => {
    el.classList.add('fading');
    setTimeout(() => { try { el.remove(); } catch {} }, 350);
  };
  el.onclick = remove;
  container.appendChild(el);
  setTimeout(remove, ttl);
}
if (window.bigo && window.bigo.onWarnNoObs) {
  window.bigo.onWarnNoObs((payload) => {
    if (!payload) return;
    showToast({
      key: `no-obs-${payload.overlayId || 'default'}`,
      title: '⚠️ Chưa kết nối OBS',
      body: `Overlay "${payload.overlayName}" đang gửi qua OBS nhưng chưa có Browser Source kết nối — hiệu ứng bị bỏ qua. Mở OBS Studio và thêm Browser Source với URL của overlay này.`,
      type: 'warn',
      ttl: 8000,
      throttle: 15000,
    });
  });
}

// =================== Updater dialog modal ===================
// Main process gọi qua IPC khi cần hỏi user (có cập nhật / sẵn sàng cài / lỗi / info).
// Modal phong cách giống app-confirm pattern: dark card, accent orange, blur backdrop.
const UPDATER_DIALOG_VARIANTS = {
  'update-available': { icon: '⬇️', accent: 'orange', primaryStyle: 'success' },
  'update-ready':     { icon: '🚀', accent: 'green',  primaryStyle: 'success' },
  'info':             { icon: 'ℹ',  accent: 'blue',   primaryStyle: 'neutral' },
  'error':            { icon: '⚠',  accent: 'red',    primaryStyle: 'danger' },
  'question':         { icon: '?',  accent: 'orange', primaryStyle: 'neutral' },
};
function showUpdaterModal({ id, type, title, message, detail, buttons, defaultId, cancelId }) {
  const variant = UPDATER_DIALOG_VARIANTS[type] || UPDATER_DIALOG_VARIANTS.info;
  const respond = (idx) => {
    if (window.bigo && window.bigo.updaterDialogResponse) {
      window.bigo.updaterDialogResponse(id, idx);
    }
    document.removeEventListener('keydown', onKey);
    try { backdrop.remove(); } catch {}
  };
  const backdrop = document.createElement('div');
  backdrop.className = 'upd-modal-backdrop';
  backdrop.innerHTML = `
    <div class="upd-modal-card upd-accent-${variant.accent}" role="dialog" aria-modal="true">
      <button type="button" class="upd-modal-close" aria-label="Đóng">✕</button>
      <div class="upd-modal-icon">${variant.icon}</div>
      <div class="upd-modal-body">
        <div class="upd-modal-title"></div>
        <div class="upd-modal-message"></div>
        <pre class="upd-modal-detail"></pre>
      </div>
      <div class="upd-modal-actions"></div>
    </div>
  `;
  backdrop.querySelector('.upd-modal-title').textContent = title || '';
  backdrop.querySelector('.upd-modal-message').textContent = message || '';
  const detailEl = backdrop.querySelector('.upd-modal-detail');
  if (detail) detailEl.textContent = detail; else detailEl.style.display = 'none';
  const actions = backdrop.querySelector('.upd-modal-actions');
  const btns = (Array.isArray(buttons) && buttons.length ? buttons : ['OK']);
  const dId = typeof defaultId === 'number' ? defaultId : 0;
  const cId = typeof cancelId === 'number' ? cancelId : (btns.length > 1 ? btns.length - 1 : 0);
  btns.forEach((label, idx) => {
    const b = document.createElement('button');
    b.type = 'button';
    if (idx === dId) {
      b.className = `upd-btn upd-btn-primary upd-btn-${variant.primaryStyle}`;
    } else {
      b.className = 'upd-btn upd-btn-secondary';
    }
    b.textContent = label;
    b.onclick = () => respond(idx);
    actions.appendChild(b);
  });
  backdrop.querySelector('.upd-modal-close').onclick = () => respond(cId);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) respond(cId); });
  const onKey = (e) => {
    if (e.key === 'Escape') respond(cId);
    else if (e.key === 'Enter') {
      e.preventDefault();
      respond(dId);
    }
  };
  document.addEventListener('keydown', onKey);
  document.body.appendChild(backdrop);
  // Focus default button cho dễ Enter
  setTimeout(() => {
    const defBtn = actions.children[dId];
    if (defBtn) try { defBtn.focus(); } catch {}
  }, 30);
}
if (window.bigo && window.bigo.onUpdaterDialog) {
  window.bigo.onUpdaterDialog((payload) => {
    if (!payload) return;
    showUpdaterModal(payload);
  });
}

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
  viewers: 0,        // số người xem live từ public room info
  users: new Set(),  // unique user names
};
function resetSessionStats() {
  sessionStats.effects = 0;
  sessionStats.diamond = 0;
  sessionStats.giftCount = 0;
  sessionStats.viewers = 0;
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
  if (els.csViewers) els.csViewers.textContent = fmtStat(sessionStats.viewers);
}

// =================== Effect Queue State ===================
const queueItems = []; // { id, ts, user, avatar, gift_id, gift_name, gift_icon, count, diamond, status }
const QUEUE_MAX = 5000; // Cho phép hold 5000 items in-memory; render UI giới hạn theo maxListItems.
let queuePaused = false;
const missingMediaWarned = new Set();

function loadQueueSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('queueSettings') || '{}');
    if (s.font) els.qSizeFont.value = s.font;
    if (s.icon) els.qSizeIcon.value = s.icon;
    if (s.cardIcon && els.qCardIcon) els.qCardIcon.value = s.cardIcon;
    if (s.cardCount && els.qCardCount) els.qCardCount.value = s.cardCount;
  } catch {}
  applyQueueSize();
}
function saveQueueSettings() {
  localStorage.setItem('queueSettings', JSON.stringify({
    font: els.qSizeFont.value, icon: els.qSizeIcon.value,
    cardIcon: els.qCardIcon?.value || 34,
    cardCount: els.qCardCount?.value || 11,
  }));
}
function applyQueueSize() {
  const font = els.qSizeFont.value;
  const icon = els.qSizeIcon.value;
  els.effectQueue.style.setProperty('--queue-font', font + 'px');
  els.effectQueue.style.setProperty('--queue-icon', icon + 'px');
  els.qSizeFontVal.textContent = font;
  els.qSizeIconVal.textContent = icon;
  if (els.miniQueueCards && els.qCardIcon && els.qCardCount) {
    els.miniQueueCards.style.setProperty('--queue-card-icon', els.qCardIcon.value + 'px');
    els.miniQueueCards.style.setProperty('--queue-card-count', els.qCardCount.value + 'px');
    if (els.qCardIconVal) els.qCardIconVal.textContent = els.qCardIcon.value;
    if (els.qCardCountVal) els.qCardCountVal.textContent = els.qCardCount.value;
  }
}

// Push batch N entries (chia tách thành N hàng).
// Quà đang phát luôn ở [0] (top). Khi overlay 'ended' → shift [0] và mark next [0] = playing.
// Đảm bảo MỖI entry tương ứng MỘT lần play overlay (không bỏ sót).
function pushPlayBatch(item, ev, playTimes) {
  const batchId = 'b_' + Date.now() + '_' + Math.random().toString(36).slice(2, 4);
  const baseUser = ev?.user || 'NHPHUNG';
  // Avatar: NHPHUNG → logo HP. User thường → raw avatar (nếu scraper bắt được).
  const baseAvatar = resolveAvatarForUser(baseUser, ev?.user_avatar_url);
  const baseName = item?.alias || ev?.gift_name || (item?.matchKeys || [])[0] || '?';
  const baseId = ev?.gift_id ?? null;
  const baseIcon = ev?.gift_icon || ev?.gift_icon_url || (item ? getGiftIcon(item) : '');
  const baseGiftKey = buildQueueGiftKey(baseId, baseName, baseIcon);
  const baseDiamond = ev?.total_diamond != null && playTimes > 0
    ? Math.max(1, Math.round(ev.total_diamond / playTimes))
    : null;
  const baseLevel = ev?.level ?? null;
  const mediaFiles = normalizeMediaFiles(item);
  const overlayId = item?.overlayId || null;

  const batch = [];
  for (let i = 0; i < playTimes; i++) {
    const selectedMediaFile = mediaFiles.length > 1 ? chooseEffectMedia(item) : (mediaFiles[0] || null);
    batch.push({
      id: 'q_' + batchId + '_' + i,
      batchId,
      ts: Date.now() + i,
      user: baseUser, avatar: baseAvatar,
      gift_name: baseName, gift_id: baseId, gift_icon: baseIcon,
      gift_key: baseGiftKey,
      level: baseLevel,
      count: 1, step: i + 1, total: playTimes,
      diamond: baseDiamond,
      mediaFile: selectedMediaFile,
      effect_name: selectedMediaFile ? effectNameFromMediaFile(selectedMediaFile) : baseName,
      mediaFiles,
      overlayId,
      pauseBgm: !!item?.pauseBgm,
      itemId: item?.id || null,
      status: 'queued', // tất cả queued — processor sẽ pick first
      playTimes: 1,
    });
  }
  const shouldAutoStart = !queuePaused && !queueItems.some(q => q.status === 'playing');

  // Priority: 0 = append cuối queue (FIFO chuẩn).
  // N > 0 = chèn vào hàng chờ N. Quà đang phát nằm trên cùng và KHÔNG tính là hàng chờ.
  const priority = item?.priority || 0;
  if (priority > 0 && queueItems.length > 0) {
    insertBatchByQueuePriority(batch, priority);
    appendLog(`[queue] ${baseName}: priority=${priority} → chèn vào hàng chờ ${priority}`);
  } else {
    queueItems.push(...batch);
    if (priority > 0) {
      appendLog(`[queue] ${baseName}: priority=${priority} nhưng queue rỗng → append cuối`);
    }
  }
  while (queueItems.length > QUEUE_MAX) queueItems.shift();

  // Đảm bảo chỉ có 1 entry 'playing' tại 1 thời điểm. Nếu chưa có ai playing → mark [0]
  if (shouldAutoStart && queueItems.length > 0) {
    const firstQueued = queueItems.find(q => q.status === 'queued');
    if (firstQueued) {
      firstQueued.status = 'playing';
      firstQueued.playStartedAt = Date.now();
      playQueueItem(firstQueued);
    }
  }
  renderQueue(); renderMiniQueue(); renderQueueCards(); updateQueueStats();
  forwardQueueSnapshot();
}

function insertBatchByQueuePriority(batch, priority) {
  const playing = queueItems.filter(q => q.status === 'playing');
  const queued = queueItems.filter(q => q.status === 'queued');
  const insertAt = Math.max(0, Math.min((parseInt(priority, 10) || 1) - 1, queued.length));
  queued.splice(insertAt, 0, ...batch);
  queueItems.length = 0;
  queueItems.push(...playing, ...queued);
}

async function playQueueItem(q) {
  if (!q || !q.overlayId || !q.mediaFile || !window.bigo.overlayPlay) return;
  if (q.pauseBgm) pauseBgmForEffect();
  if (window.bigo.effectsExists) {
    let exists = true;
    try { exists = await window.bigo.effectsExists(q.mediaFile); } catch { exists = false; }
    if (!exists) { await handleMissingQueueMedia(q); return; }
  }
  const payload = resolveMediaPayload(q.mediaFile);
  const r = await window.bigo.overlayPlay({ overlayId: q.overlayId, ...payload }).catch(e => ({ ok: false, error: e.message }));
  if (r && r.ok === false) await handleMissingQueueMedia(q);
}

async function handleMissingQueueMedia(q) {
  const file = q?.mediaFile || '';
  const label = fileDisplayLabel(file);
  if (q?.itemId) {
    const found = findItemById(q.itemId);
    if (found) {
      const remaining = normalizeMediaFiles(found.item).filter(x => x !== file);
      found.item.mediaFiles = remaining;
      found.item.mediaFile = remaining[0] || '';
    }
  }
  const idx = queueItems.findIndex(x => x.id === q.id);
  if (idx !== -1) queueItems.splice(idx, 1);
  await persistMapping().catch(() => {});
  renderGiftTable();
  renderQueue(); renderMiniQueue(); renderQueueCards(); updateQueueStats(); forwardQueueSnapshot();
  if (!missingMediaWarned.has(file)) {
    missingMediaWarned.add(file);
    setTimeout(() => alert(`Thiếu dữ liệu nhạc/video:\n${label}\n\nApp đã xoá tên file bị thiếu khỏi cấu hình. Hãy chọn lại file hiệu ứng.`), 100);
  }
  if (!queuePaused && !queueItems.some(x => x.status === 'playing')) {
    markNextQueueItemPlaying();
    renderQueue(); renderMiniQueue(); renderQueueCards(); updateQueueStats(); forwardQueueSnapshot();
  }
}

function markNextQueueItemPlaying(delayMs = 0) {
  if (queuePaused) return;
  const nextQ = queueItems.find(q => q.status === 'queued');
  if (!nextQ) return;
  nextQ.status = 'playing';
  nextQ.playStartedAt = Date.now();
  const play = () => playQueueItem(nextQ);
  if (delayMs > 0) setTimeout(play, delayMs);
  else play();
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
        markNextQueueItemPlaying();
      }
      syncBgmAfterQueueChange();
      // Decrement 🎵 counter khi item end naturally
      sessionStats.effects = Math.max(0, sessionStats.effects - 1);
      updateConnectStats();
      renderQueue(); renderMiniQueue(); renderQueueCards(); updateQueueStats();
      forwardQueueSnapshot();
      // Cũ: setTimeout(...) — bỏ delay, xoá thẳng để DSHT luôn chỉ chứa playing + queued
      setTimeout(() => {
        // Empty placeholder để giữ tương thích với code cũ. Có thể xoá block sau.
        renderQueue(); renderMiniQueue(); renderQueueCards();
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

function buildQueueGiftKey(giftId, giftName, giftIcon) {
  if (giftId != null && String(giftId).trim()) return 'id:' + String(giftId).trim();
  const name = String(giftName || '').trim().toLowerCase();
  if (name) return 'name:' + name;
  const icon = String(giftIcon || '').trim();
  return icon ? 'icon:' + icon : 'unknown';
}

function getQueueGiftKey(q) {
  return q?.gift_key || buildQueueGiftKey(q?.gift_id, q?.gift_name, q?.gift_icon);
}

function getQueueGroups() {
  const groups = new Map();
  for (const q of getQueueDisplayList()) {
    const key = getQueueGiftKey(q);
    let g = groups.get(key);
    if (!g) {
      g = { key, name: q.gift_name || '?', icon: q.gift_icon || '', total: 0, diamond: 0, playing: null, itemIds: new Set(), identities: new Set() };
      groups.set(key, g);
    }
    if (q.itemId) {
      g.itemIds.add(q.itemId);
      const found = findItemById(q.itemId);
      if (found?.item) g.identities.add(gameplayItemIdentity(found.item));
    }
    if (q.gift_id != null && String(q.gift_id).trim()) g.identities.add(`id:${String(q.gift_id).trim()}`);
    else if (q.gift_name) g.identities.add(`name:${String(q.gift_name).trim().toLowerCase()}`);
    g.total += 1;
    g.diamond += Number(q.diamond || 0);
    if (q.status === 'playing' && !g.playing) g.playing = q;
  }
  return [...groups.values()].map(g => ({ ...g, itemIds: [...g.itemIds], identities: [...g.identities] }));
}

function renderQueueCards() {
  const el = document.getElementById('miniQueueCards');
  if (!el) return;
  const groups = getQueueGroups();
  if (!groups.length) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = groups.map(g => {
    const icon = g.icon
      ? `<img class="queue-card-icon" src="${escapeHtml(g.icon)}" loading="lazy" />`
      : '<div class="queue-card-icon empty"></div>';
    return `<button class="queue-card ${g.playing ? 'playing' : ''}" data-gift-key="${escapeHtml(g.key)}" title="Ưu tiên tất cả ${escapeHtml(g.name)} lên đầu hàng chờ">
      ${icon}
      <span class="queue-card-count">${g.total.toLocaleString('en-US')}</span>
    </button>`;
  }).join('');
  el.querySelectorAll('[data-gift-key]').forEach(card => {
    card.onclick = () => queuePromoteGiftGroup(card.dataset.giftKey);
  });
  syncGameplayCountsFromQueue();
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
    ? `<span class="beans-inline">${beanIconHtml('small')} x${q.diamond.toLocaleString('en-US')}</span>` : '';
  const effectName = q.effect_name || q.gift_name || 'Hiệu ứng';
  const rowClass = opts.rowClass || 'mini-queue-row';
  return `<div class="${rowClass} ${q.status}" data-id="${escapeHtml(q.id)}">
    ${avHtml}
    ${giftIconHtml}
    <div class="qrow-meta">
      <div class="qrow-user">${escapeHtml(q.user)}${playingBadge}</div>
      <div class="qrow-effect">tặng <b>${escapeHtml(effectName)}</b>${cntInline}${beansInline}</div>
    </div>
    <div class="qrow-actions">
      <button class="qrow-toggle" data-toggle-qid="${escapeHtml(q.id)}" title="${isPlaying ? 'Tạm dừng hiệu ứng đang phát' : 'Phát hiệu ứng này'}">${isPlaying ? '⏸' : '▶'}</button>
      <button class="qrow-del" data-qid="${escapeHtml(q.id)}" title="Xoá hàng này">✕</button>
    </div>
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
  el.querySelectorAll('[data-toggle-qid]').forEach(btn => {
    btn.onclick = (e) => { e.stopPropagation(); queueToggleById(btn.dataset.toggleQid); };
  });
  el.querySelectorAll('.mini-queue-row').forEach(row => wireQueueContextMenu(row));
}

async function confirmDeleteOneQueueItem(q) {
  return appConfirm({
    title: 'Xoá hành động này?',
    message: q?.gift_name ? `Xoá "${q.gift_name}" khỏi HÀNH ĐỘNG?` : 'Xoá hành động này khỏi danh sách?',
    detail: q?.status === 'playing' ? 'Hành động đang phát sẽ dừng ngay.' : 'Thao tác này không thể hoàn tác.',
    okText: 'Có, xoá',
    cancelText: 'Không',
    danger: true,
  });
}

async function removeQueueItemById(id) {
  const idx = queueItems.findIndex(q => q.id === id);
  if (idx === -1) return;
  const removed = queueItems[idx];
  if (!(await confirmDeleteOneQueueItem(removed))) return;
  queueItems.splice(idx, 1);
  // QUAN TRỌNG: Nếu xoá item đang playing → STOP effect ở overlay window (tránh
  // hiệu ứng chạy ẩn dù đã xoá khỏi DSHT). Overlay tự fire 'queue-empty' để
  // resume BGM nếu cần.
  if (removed.status === 'playing' && removed.overlayId && window.bigo.overlayStopEffect) {
    window.bigo.overlayStopEffect(removed.overlayId).catch(() => {});
  }
  // Mark playing cho item tiếp theo (nếu có)
  if (removed.status === 'playing' && queueItems.length > 0) {
    markNextQueueItemPlaying(removed.overlayId ? 550 : 0);
  }
  syncBgmAfterQueueChange();
  // Decrement counter 🎵 effects
  sessionStats.effects = Math.max(0, sessionStats.effects - 1);
  updateConnectStats();
  renderQueue(); renderMiniQueue(); renderQueueCards(); updateQueueStats();
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
  syncBgmAfterQueueChange();
  renderQueue(); renderMiniQueue(); renderQueueCards(); updateQueueStats();
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

// Render VIP/SVIP/Top/Family badges → chips trước user name. NPC nhận biết user
// quan trọng (VIP cao, top contributor, family member) để chăm sóc tốt hơn.
function renderUserBadges(badges) {
  if (!Array.isArray(badges) || !badges.length) return '';
  const order = { svip: 0, vip: 1, top: 2, family: 3 };
  const sorted = [...badges].sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9));
  return sorted.map(b => {
    if (b.type === 'svip') return `<span class="user-badge badge-svip" title="Super VIP tier ${b.tier} — VIP cao, hãy chú ý!">👑 SVIP${b.tier}</span>`;
    if (b.type === 'vip')  return `<span class="user-badge badge-vip" title="VIP tier ${b.tier}">💜 VIP${b.tier}</span>`;
    if (b.type === 'top')  {
      const lbl = { WEEK: 'tuần', DAY: 'ngày', MONTH: 'tháng' }[b.period] || b.period.toLowerCase();
      return `<span class="user-badge badge-top" title="Top ${b.rank} contributor ${lbl}">⭐ Top${b.rank}</span>`;
    }
    if (b.type === 'family') return `<span class="user-badge badge-family" title="Family ${escapeHtml(b.name)} lvl ${b.level}">${b.level} ${escapeHtml(b.name)}♥</span>`;
    return '';
  }).join('');
}

function getRowVipClass(badges) {
  if (!Array.isArray(badges) || !badges.length) return '';
  if (badges.some(b => b.type === 'svip')) return 'chat-row-svip';
  if (badges.some(b => b.type === 'vip'))  return 'chat-row-vip';
  if (badges.some(b => b.type === 'top'))  return 'chat-row-top';
  if (badges.some(b => b.type === 'family')) return 'chat-row-family';
  return '';
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
  if (!matched || !hasEffectMedia(matched)) return;
  scoreHandleGift(ev);
  // Dùng pushPlayBatch để chia tách thành playTimes entries
  pushPlayBatch(matched, ev, playTimes);
}

function renderQueue() {
  const list = getQueueDisplayList();
  if (!list.length) {
    els.effectQueue.innerHTML = '<div style="color:#555;text-align:center;padding:16px">Chưa có hiệu ứng nào trong danh sách</div>';
    updateQueueControlButtons();
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
  els.effectQueue.querySelectorAll('[data-toggle-qid]').forEach(btn => {
    btn.onclick = (e) => { e.stopPropagation(); queueToggleById(btn.dataset.toggleQid); };
  });
  els.effectQueue.querySelectorAll('.queue-row').forEach(row => wireQueueContextMenu(row));
  updateQueueControlButtons();
}

function updateQueueControlButtons() {
  const playing = queueItems.some(q => q.status === 'playing');
  const label = playing ? '⏸' : '▶';
  const title = playing ? 'Tạm dừng hiệu ứng đang phát' : 'Phát/kích hoạt lại hiệu ứng kế tiếp';
  for (const id of ['btnToggleMiniQueue', 'btnToggleQueue']) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    btn.textContent = id === 'btnToggleQueue' ? `${label} ${playing ? 'Dừng' : 'Phát'}` : label;
    btn.title = title;
  }
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
      { icon: '▶', label: 'Phát/kích hoạt lại', action: () => queuePlayById(id) },
      { icon: '⏹', label: 'Dừng hiệu ứng', action: () => queueStopById(id) },
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
  renderQueue(); renderMiniQueue(); renderQueueCards(); updateQueueStats(); forwardQueueSnapshot();
}
function queueMoveUp(id) {
  const idx = queueItems.findIndex(q => q.id === id);
  if (idx <= 0) return;
  const item = queueItems[idx];
  const above = queueItems[idx - 1];
  if (item.status === 'playing' || above.status === 'playing') return;
  queueItems[idx - 1] = item;
  queueItems[idx] = above;
  renderQueue(); renderMiniQueue(); renderQueueCards(); updateQueueStats(); forwardQueueSnapshot();
}
function queueMoveDown(id) {
  const idx = queueItems.findIndex(q => q.id === id);
  if (idx === -1 || idx >= queueItems.length - 1) return;
  const item = queueItems[idx];
  const below = queueItems[idx + 1];
  if (item.status === 'playing') return;
  queueItems[idx + 1] = item;
  queueItems[idx] = below;
  renderQueue(); renderMiniQueue(); renderQueueCards(); updateQueueStats(); forwardQueueSnapshot();
}

function queueStopById(id) {
  const q = queueItems.find(x => x.id === id) || queueItems.find(x => x.status === 'playing');
  if (!q || q.status !== 'playing') return;
  queuePaused = true;
  if (q.overlayId && window.bigo.overlayStopEffect) {
    window.bigo.overlayStopEffect(q.overlayId).catch(() => {});
  }
  q.status = 'queued';
  q.stoppedAt = Date.now();
  syncBgmAfterQueueChange();
  renderQueue(); renderMiniQueue(); renderQueueCards(); updateQueueStats(); forwardQueueSnapshot();
}

function queuePlayById(id) {
  let q = id ? queueItems.find(x => x.id === id) : null;
  if (!q) q = queueItems.find(x => x.status === 'queued') || queueItems.find(x => x.status === 'playing');
  if (!q) return;
  if (q.status === 'playing') {
    queueStopById(q.id);
    setTimeout(() => queuePlayById(q.id), 550);
    return;
  }
  queuePaused = false;
  const current = queueItems.find(x => x.status === 'playing' && x.id !== q.id);
  if (current) queueStopById(current.id);
  q.status = 'playing';
  q.playStartedAt = Date.now();
  const wait = current || (q.stoppedAt && Date.now() - q.stoppedAt < 550) ? 550 : 0;
  if (wait) setTimeout(() => playQueueItem(q), wait);
  else playQueueItem(q);
  renderQueue(); renderMiniQueue(); renderQueueCards(); updateQueueStats(); forwardQueueSnapshot();
}

function queueStopCurrent() {
  const current = queueItems.find(q => q.status === 'playing');
  if (current) queueStopById(current.id);
}

function queuePlayCurrent() {
  queuePlayById(null);
}

function queueToggleById(id) {
  const q = id ? queueItems.find(x => x.id === id) : null;
  if (q?.status === 'playing' || (!q && queueItems.some(x => x.status === 'playing'))) queueStopCurrent();
  else queuePlayById(id || null);
}

function queueToggleCurrent() {
  if (queueItems.some(q => q.status === 'playing')) queueStopCurrent();
  else queuePlayCurrent();
}

function queueShuffleQueued() {
  const playing = queueItems.filter(q => q.status === 'playing');
  const queued = queueItems.filter(q => q.status === 'queued');
  if (queued.length < 2) return;
  for (let i = queued.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [queued[i], queued[j]] = [queued[j], queued[i]];
  }
  queueItems.length = 0;
  queueItems.push(...playing, ...queued);
  renderQueue(); renderMiniQueue(); renderQueueCards(); updateQueueStats(); forwardQueueSnapshot();
}

function queuePromoteGiftGroup(giftKey) {
  if (!giftKey) return;
  const promote = [];
  const rest = [];
  for (const q of queueItems) {
    if (q.status === 'queued' && getQueueGiftKey(q) === giftKey) promote.push(q);
    else rest.push(q);
  }
  if (!promote.length) return;
  const playingIdx = rest.findIndex(q => q.status === 'playing');
  const insertAt = playingIdx >= 0 ? playingIdx + 1 : 0;
  rest.splice(insertAt, 0, ...promote);
  queueItems.length = 0;
  queueItems.push(...rest);
  renderQueue(); renderMiniQueue(); renderQueueCards(); updateQueueStats(); forwardQueueSnapshot();
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
  liveInfo: $('liveInfo'), headerLiveInfo: $('headerLiveInfo'),
  metaPanel: $('metaPanel'), metaInfo: $('metaInfo'),
  liveChats: $('liveChats'), liveGifts: $('liveGifts'),
  csViewers: $('csViewers'), csEffects: $('csEffects'), csDiamond: $('csDiamond'), csUsers: $('csUsers'), csGifts: $('csGifts'),
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
  memberEditId: $('memberEditId'), memberName: $('memberName'), memberAvatar: $('memberAvatar'), btnMemberPickAvatar: $('btnMemberPickAvatar'), btnMemberClearForm: $('btnMemberClearForm'), btnMemberSave: $('btnMemberSave'), membersList: $('membersList'),
  miniQueueCards: $('miniQueueCards'),
  qCardIcon: $('qCardIcon'), qCardIconVal: $('qCardIconVal'),
  qCardCount: $('qCardCount'), qCardCountVal: $('qCardCountVal'),
  gameplayGroup: $('gameplayGroup'), gameplayGroupChecks: $('gameplayGroupChecks'), gameplayUseCommonGroup: $('gameplayUseCommonGroup'), gameplayOrientation: $('gameplayOrientation'), gameplayLabelPosition: $('gameplayLabelPosition'),
  gameplayNameMode: $('gameplayNameMode'), gameplayIconSize: $('gameplayIconSize'), gameplayIconSizeVal: $('gameplayIconSizeVal'), gameplayCountSize: $('gameplayCountSize'), gameplayCountSizeVal: $('gameplayCountSizeVal'), gameplayItemGap: $('gameplayItemGap'), gameplayItemGapVal: $('gameplayItemGapVal'), gameplayEnlargeActive: $('gameplayEnlargeActive'), gameplayActiveScale: $('gameplayActiveScale'), gameplayActiveScaleVal: $('gameplayActiveScaleVal'),
  gameplayCardBg: $('gameplayCardBg'), gameplayCardOpacity: $('gameplayCardOpacity'), gameplayCardOpacityVal: $('gameplayCardOpacityVal'),
  gameplayTextFont: $('gameplayTextFont'), gameplayTextColor: $('gameplayTextColor'), gameplaySlotNumberColor: $('gameplaySlotNumberColor'), gameplayCountColor: $('gameplayCountColor'), gameplayUppercase: $('gameplayUppercase'), gameplayShowName: $('gameplayShowName'), gameplayShowCount: $('gameplayShowCount'),
  gameplayCenterLargest: $('gameplayCenterLargest'), gameplayGrayInactive: $('gameplayGrayInactive'), gameplayKeepScore: $('gameplayKeepScore'),
  gameplayReview: $('gameplayReview'), gameplayGridEditor: $('gameplayGridEditor'), gameplayItems: $('gameplayItems'), btnGameplayAddCol: $('btnGameplayAddCol'), btnGameplayAddRow: $('btnGameplayAddRow'), btnGameplayDelCol: $('btnGameplayDelCol'), btnGameplayDelRow: $('btnGameplayDelRow'), btnGameplaySave: $('btnGameplaySave'), btnGameplayCopyUrl: $('btnGameplayCopyUrl'),
  scoreHours: $('scoreHours'), scoreMinutes: $('scoreMinutes'), scoreSeconds: $('scoreSeconds'), scoreDelay: $('scoreDelay'), scoreTarget: $('scoreTarget'), scoreMemberGroup: $('scoreMemberGroup'), scoreMember: $('scoreMember'), scoreContent: $('scoreContent'), scoreCreatorName: $('scoreCreatorName'), scoreCreatorAvatar: $('scoreCreatorAvatar'), scoreTimeColor: $('scoreTimeColor'), scoreContentColor: $('scoreContentColor'), scoreOverColor: $('scoreOverColor'), scoreBarColor1: $('scoreBarColor1'), scoreBarColor2: $('scoreBarColor2'), scoreWaveColor: $('scoreWaveColor'), scoreBigGiftThreshold: $('scoreBigGiftThreshold'), scorePrepSeconds: $('scorePrepSeconds'), scoreThemePreset: $('scoreThemePreset'), scoreBarStyle: $('scoreBarStyle'), scoreOverlaySize: $('scoreOverlaySize'), scoreCustomMilestones: $('scoreCustomMilestones'), scoreShowGiftUser: $('scoreShowGiftUser'), scoreShowMissing: $('scoreShowMissing'), scoreShowTopUsers: $('scoreShowTopUsers'), scoreShowSpeed: $('scoreShowSpeed'), scoreCompactMode: $('scoreCompactMode'), scoreHideAvatar: $('scoreHideAvatar'), scoreHideCreator: $('scoreHideCreator'), scoreStartSoundLabel: $('scoreStartSoundLabel'), scoreWarningSoundLabel: $('scoreWarningSoundLabel'), scoreGoalSoundLabel: $('scoreGoalSoundLabel'), scoreSuccessSoundLabel: $('scoreSuccessSoundLabel'), scoreFailSoundLabel: $('scoreFailSoundLabel'), btnScorePickStartSound: $('btnScorePickStartSound'), btnScoreClearStartSound: $('btnScoreClearStartSound'), btnScorePickWarningSound: $('btnScorePickWarningSound'), btnScoreClearWarningSound: $('btnScoreClearWarningSound'), btnScorePickGoalSound: $('btnScorePickGoalSound'), btnScoreClearGoalSound: $('btnScoreClearGoalSound'), btnScorePickSuccessSound: $('btnScorePickSuccessSound'), btnScoreClearSuccessSound: $('btnScoreClearSuccessSound'), btnScorePickFailSound: $('btnScorePickFailSound'), btnScoreClearFailSound: $('btnScoreClearFailSound'), btnScoreStart: $('btnScoreStart'), btnScoreStop: $('btnScoreStop'), btnScoreReset: $('btnScoreReset'), scoreTestPoints: $('scoreTestPoints'), btnScoreTest: $('btnScoreTest'), btnScoreTestBig: $('btnScoreTestBig'), btnScoreTestWarning: $('btnScoreTestWarning'), btnScoreTestSuccess: $('btnScoreTestSuccess'), btnScoreTestFail: $('btnScoreTestFail'), btnScoreCopyUrl: $('btnScoreCopyUrl'), scorePreview: $('scorePreview'), scoreReviewStatus: $('scoreReviewStatus'), scoreReviewStats: $('scoreReviewStats'), scoreGiftLog: $('scoreGiftLog'), scoreUserTotals: $('scoreUserTotals'),
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
  dlgPriority: $('dlgPriority'),
  dlgGiftSave: $('dlgGiftSave'), groupList: $('groupList'),
  dlgPickFile: $('dlgPickFile'), dlgOpenFolder: $('dlgOpenFolder'), dlgMediaDrop: $('dlgMediaDrop'), dlgMediaList: $('dlgMediaList'),
  dlgMasterFilter: $('dlgMasterFilter'), dlgMasterSort: $('dlgMasterSort'),
  dlgMasterTableBody: $('dlgMasterTableBody'), dlgMasterCount: $('dlgMasterCount'),
  dlgMasterVnOnly: $('dlgMasterVnOnly'), dlgMasterFavOnly: $('dlgMasterFavOnly'),
  dlgMasterTotal: $('dlgMasterTotal'),
  // Overlay modal
  overlayDialog: $('overlayDialog'), overlayDialogTitle: $('overlayDialogTitle'),
  ovName: $('ovName'), ovBgColor: $('ovBgColor'), ovOpacity: $('ovOpacity'), ovOpacityVal: $('ovOpacityVal'),
  ovW: $('ovW'), ovH: $('ovH'), ovTop: $('ovTop'), ovClickThrough: $('ovClickThrough'),
  ovAutoHide: $('ovAutoHide'), ovLockRatio: $('ovLockRatio'),
  ovAutoOpen: $('ovAutoOpen'), ovAutoFocus: $('ovAutoFocus'), ovTarget: $('ovTarget'),
  dlgOverlaySave: $('dlgOverlaySave'),
};

// =================== Utils ===================
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function beanIconHtml(cls = '') {
  return `<span class="bean-icon ${cls}" aria-label="BIGO bean"></span>`;
}
function displayEffectName(mediaFile) {
  if (!mediaFile) return '';
  let name = mediaFile;
  if (name.includes('/') || name.includes('\\')) {
    try { name = decodeURIComponent(name.split(/[\\\/]/).pop() || name); }
    catch { name = name.split(/[\\\/]/).pop() || name; }
  }
  return name.replace(/\.(webm|mp4|mp3|wav|ogg|gif)$/i, '');
}
function normalizeMediaFiles(itemOrFiles) {
  const raw = Array.isArray(itemOrFiles)
    ? itemOrFiles
    : [itemOrFiles?.mediaFile, ...(Array.isArray(itemOrFiles?.mediaFiles) ? itemOrFiles.mediaFiles : [])];
  const seen = new Set();
  const files = [];
  for (const value of raw) {
    const file = String(value || '').trim();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    files.push(file);
  }
  return files;
}
function hasEffectMedia(item) {
  return normalizeMediaFiles(item).length > 0;
}
function chooseEffectMedia(item) {
  const files = normalizeMediaFiles(item);
  if (!files.length) return '';
  if (files.length === 1) return files[0];
  return files[Math.floor(Math.random() * files.length)];
}
function fileUrlFromPath(filePath) {
  return 'file:///' + String(filePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
}
function mediaIconFor(file) {
  return /\.(mp3|wav|ogg|m4a|flac)(\?|#|$)/i.test(String(file || '')) ? '🎵' : '🎬';
}
function effectNameFromMediaFile(file) {
  return displayEffectName(fileDisplayLabel(file)).replace(/^📁\s*/, '') || 'Hiệu ứng';
}
function isAudioEffectFile(mediaFile) {
  return /\.(mp3|wav|ogg)(\?|#|$)/i.test(String(mediaFile || ''));
}
function autoEnablePauseBgmForAudio(mediaFile) {
  if (els.dlgPauseBgm && isAudioEffectFile(mediaFile)) els.dlgPauseBgm.checked = true;
}
function appendLog(msg) {
  // Log panel đã được bỏ. Giữ console.log để debug qua DevTools.
  if (!els.log) { console.log('[bigo]', msg); return; }
  const t = new Date().toLocaleTimeString();
  els.log.textContent = `[${t}] ${msg}\n` + els.log.textContent;
  if (els.log.textContent.length > 12000) els.log.textContent = els.log.textContent.slice(0, 12000);
}
function uid(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function appConfirm({ title = 'Xác nhận thao tác', message = '', detail = '', okText = 'Đồng ý', cancelText = 'Huỷ', danger = false } = {}) {
  return new Promise(resolve => {
    const existing = document.querySelector('.app-confirm-backdrop');
    if (existing) existing.remove();
    const backdrop = document.createElement('div');
    backdrop.className = 'app-confirm-backdrop';
    backdrop.innerHTML = `
      <div class="app-confirm-card ${danger ? 'danger' : ''}" role="dialog" aria-modal="true">
        <button class="app-confirm-close" data-confirm="cancel" title="Đóng">✕</button>
        <div class="app-confirm-icon">${danger ? '⚠' : '✓'}</div>
        <div class="app-confirm-body">
          <div class="app-confirm-title">${escapeHtml(title)}</div>
          <div class="app-confirm-message">${escapeHtml(message)}</div>
          ${detail ? `<div class="app-confirm-detail">${escapeHtml(detail)}</div>` : ''}
        </div>
        <div class="app-confirm-actions">
          <button class="tiny" data-confirm="cancel">${escapeHtml(cancelText)}</button>
          <button class="tiny primary ${danger ? 'danger' : ''}" data-confirm="ok">${escapeHtml(okText)}</button>
        </div>
      </div>`;
    const done = (value) => { backdrop.remove(); resolve(value); };
    backdrop.addEventListener('click', (e) => {
      const action = e.target.closest('[data-confirm]')?.dataset.confirm;
      if (action) done(action === 'ok');
      else if (e.target === backdrop) done(false);
    });
    const onKey = (e) => {
      if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); done(false); }
      if (e.key === 'Enter') { document.removeEventListener('keydown', onKey); done(true); }
    };
    document.addEventListener('keydown', onKey);
    document.body.appendChild(backdrop);
    backdrop.querySelector('[data-confirm="ok"]')?.focus();
  });
}

async function confirmClearQueue() {
  if (queueItems.length === 0) {
    appendLog('[queue] HÀNH ĐỘNG đã trống');
    return false;
  }
  return appConfirm({
    title: 'Xoá toàn bộ HÀNH ĐỘNG?',
    message: `${queueItems.length.toLocaleString('en-US')} hành động đang chờ sẽ bị xoá.`,
    detail: 'Thao tác này không thể hoàn tác. Hành động đang phát cũng sẽ dừng ngay.',
    okText: 'Xoá tất cả',
    cancelText: 'Giữ lại',
    danger: true,
  });
}

// =================== Queue listeners (sau khi els đã declared) ===================
els.qSizeFont.addEventListener('input', () => { applyQueueSize(); saveQueueSettings(); });
els.qSizeIcon.addEventListener('input', () => { applyQueueSize(); saveQueueSettings(); });
if (els.qCardIcon) els.qCardIcon.addEventListener('input', () => { applyQueueSize(); saveQueueSettings(); });
if (els.qCardCount) els.qCardCount.addEventListener('input', () => { applyQueueSize(); saveQueueSettings(); });
els.btnClearQueue.onclick = async () => {
  if (!(await confirmClearQueue())) return;
  clearAllQueue();
};

// IPC listeners từ popup window (popup user bấm X / Xoá tất cả / right-click)
if (window.bigo.onQueueRemove) window.bigo.onQueueRemove(id => removeQueueItemById(id));
if (window.bigo.onQueueClearAll) window.bigo.onQueueClearAll(async () => {
  if (await confirmClearQueue()) clearAllQueue();
});
if (window.bigo.onQueueAction) {
  window.bigo.onQueueAction(({ type, id, giftKey }) => {
    if (type === 'shuffle') { queueShuffleQueued(); return; }
    if (type === 'promote-group') { queuePromoteGiftGroup(giftKey); return; }
    if (type === 'play-current') { queuePlayCurrent(); return; }
    if (type === 'stop-current') { queueStopCurrent(); return; }
    if (type === 'toggle-current') { queueToggleCurrent(); return; }
    if (!id) return;
    if (type === 'top') queueMoveTop(id);
    else if (type === 'up') queueMoveUp(id);
    else if (type === 'down') queueMoveDown(id);
    else if (type === 'play') queuePlayById(id);
    else if (type === 'stop') queueStopById(id);
    else if (type === 'toggle') queueToggleById(id);
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
    if (t.dataset.tab === 'special') {
      try { applyHeartGoalUi(); } catch (e) { console.warn(e); }
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
    if (!confirm('Reset bộ đếm 🎵 đậu 👤 🎁 về 0?')) return;
    resetSessionStats();
  });
}

// Sidebar lock settings button — toggle chế độ Khoá cài đặt (chống chỉnh nhầm khi stream)
(function wireLockSettings() {
  const btn = document.getElementById('sidebarLockSettings');
  if (!btn) return;
  const KEY = 'hp_app_locked';
  const apply = (locked) => {
    btn.classList.toggle('locked', locked);
    btn.title = locked
      ? 'Đang khoá kích thước cửa sổ — bấm để mở resize'
      : 'Khoá kích thước cửa sổ hiện tại sau khi đã chỉnh vừa màn hình';
    btn.textContent = locked ? '🔒' : '🔓';
    if (window.bigo?.windowSizeLock) window.bigo.windowSizeLock(locked).catch(() => {});
  };
  // Mặc định mở resize; user chỉnh kích thước theo màn hình rồi bấm khoá để giữ layout hiện tại.
  try { apply(localStorage.getItem(KEY) === '1'); } catch { apply(false); }
  btn.addEventListener('click', () => {
    const next = !btn.classList.contains('locked');
    apply(next);
    try { localStorage.setItem(KEY, next ? '1' : '0'); } catch {}
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

// Update header license info (góc phải header) — show TEN_KH + HAN_SU_DUNG.
function updateHeaderLicense(info) {
  const headerEl = document.getElementById('headerLicense');
  const customerEl = document.getElementById('hlCustomer');
  const expiryEl = document.getElementById('hlExpiry');
  if (!headerEl || !customerEl || !expiryEl) return;
  if (!info || (!info.TEN_KH && !info.HAN_SU_DUNG)) {
    headerEl.style.display = 'none';
    return;
  }
  headerEl.style.display = 'flex';
  customerEl.textContent = info.TEN_KH || '—';
  // Format expiry + color theo days-left
  const expiry = info.HAN_SU_DUNG;
  expiryEl.className = 'hl-value';
  if (!expiry) {
    expiryEl.textContent = '—';
    return;
  }
  const d = new Date(expiry);
  if (isNaN(d.getTime())) { expiryEl.textContent = String(expiry); return; }
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = d.getFullYear();
  const daysLeft = Math.ceil((d.getTime() - Date.now()) / 86400000);
  let display = `${dd}/${mm}/${yy}`;
  if (daysLeft < 0) {
    display += ' · HẾT HẠN';
    expiryEl.classList.add('expired');
  } else {
    display += ` (còn ${daysLeft} ngày)`;
    if (daysLeft <= 7) expiryEl.classList.add('expiring-critical');
    else if (daysLeft <= 30) expiryEl.classList.add('expiring-soon');
  }
  expiryEl.textContent = display;
}

// Reminder logic theo days-left.
// >30 ngày: reset flags. ≤30: show 1 lần. ≤15: show 1 lần. ≤7: show MỖI lần khởi động.
function checkLicenseReminder(info) {
  if (!info || !info.HAN_SU_DUNG) return;
  const d = new Date(info.HAN_SU_DUNG);
  if (isNaN(d.getTime())) return;
  const daysLeft = Math.ceil((d.getTime() - Date.now()) / 86400000);
  if (daysLeft < 0) {
    showLicenseExpiredPopup(info);
    return;
  }
  const KEY30 = 'hp_reminded_30';
  const KEY15 = 'hp_reminded_15';
  if (daysLeft > 30) {
    // Reset flags để khi expiry tới gần lần sau (vd renew + đến hạn lại) báo lại.
    try { localStorage.removeItem(KEY30); localStorage.removeItem(KEY15); } catch {}
  } else if (daysLeft <= 7) {
    // CRITICAL: hiện popup MỖI lần mở app (không skip qua localStorage).
    showLicenseExpiringPopup(daysLeft, info, true);
  } else if (daysLeft <= 15) {
    if (!localStorage.getItem(KEY15)) {
      showLicenseExpiringPopup(daysLeft, info, false);
      try { localStorage.setItem(KEY15, '1'); } catch {}
    }
  } else if (daysLeft <= 30) {
    if (!localStorage.getItem(KEY30)) {
      showLicenseExpiringPopup(daysLeft, info, false);
      try { localStorage.setItem(KEY30, '1'); } catch {}
    }
  }
}

function showLicenseExpiringPopup(daysLeft, info, critical) {
  const customer = info.TEN_KH || 'Khách hàng';
  const expiry = info.HAN_SU_DUNG || '';
  const header = critical
    ? '🚨 KEY SẮP HẾT HẠN — CHỈ CÒN ' + daysLeft + ' NGÀY'
    : '⏰ Lời nhắc gia hạn key bản quyền';
  alert(
    `${header}\n\n` +
    `Khách hàng: ${customer}\n` +
    `Hạn sử dụng: ${expiry} (còn ${daysLeft} ngày)\n\n` +
    (critical
      ? '⚠️ Key sắp hết hạn! Sau khi hết hạn, app sẽ KHÔNG dùng được các tính năng.\n\n'
      : ''
    ) +
    'Liên hệ HP MEDIA để gia hạn:\n' +
    '🌐 https://hpvn.media\n' +
    '📘 facebook.com/hpvn.media\n' +
    '👤 facebook.com/hoangphung.nguyen56553'
  );
}

function showLicenseExpiredPopup(info) {
  alert(
    `🚫 KEY ĐÃ HẾT HẠN\n\n` +
    `Khách hàng: ${info.TEN_KH || '?'}\n` +
    `Hạn cũ: ${info.HAN_SU_DUNG}\n\n` +
    `App sẽ giới hạn tính năng cho đến khi gia hạn.\n\n` +
    `Liên hệ HP MEDIA để gia hạn:\n` +
    `🌐 https://hpvn.media\n` +
    `📘 facebook.com/hpvn.media`
  );
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
  updateHeaderLicense(info);
  checkLicenseReminder(info);
  // Cache local
  try {
    localStorage.setItem('hp_license_key', key);
    localStorage.setItem('hp_license_info', JSON.stringify(info));
    localStorage.setItem('hp_license_verified_at', String(Date.now()));
  } catch {}
  return info;
}

function isLicenseUsable(info) {
  if (!info || typeof info !== 'object') return { ok: false, error: 'KEY không hợp lệ' };
  const status = String(info.TRANG_THAI || info.status || '').toUpperCase();
  const expiry = info.HAN_SU_DUNG || info.expiry || info.han_su_dung || '';
  if (status && !['ACTIVE', 'INACTIVE'].includes(status)) return { ok: false, error: status === 'EXPIRED' ? 'KEY đã hết hạn' : 'KEY không khả dụng' };
  if (expiry) {
    const d = new Date(expiry);
    if (!isNaN(d.getTime()) && d.getTime() < Date.now()) return { ok: false, error: 'KEY đã hết hạn' };
  }
  return { ok: true };
}

function setLicenseGateMessage(text, kind = '') {
  const el = document.getElementById('licenseGateMessage');
  if (!el) return;
  el.textContent = text || '';
  el.className = `license-message ${kind}`.trim();
}

function updateLicenseLockoutUi() {
  const input = document.getElementById('licenseGateKey');
  const btn = document.getElementById('licenseGateSubmit');
  const until = parseInt(localStorage.getItem('hp_license_lock_until') || '0', 10);
  const left = Math.ceil((until - Date.now()) / 1000);
  if (left > 0) {
    if (input) input.disabled = true;
    if (btn) btn.disabled = true;
    setLicenseGateMessage(`Nhập sai quá 5 lần. Vui lòng thử lại sau ${left} giây.`, 'err');
    return true;
  }
  if (until) {
    localStorage.removeItem('hp_license_lock_until');
    localStorage.removeItem('hp_license_fail_count');
  }
  if (input) input.disabled = false;
  if (btn) btn.disabled = false;
  return false;
}

function recordLicenseFailure(message) {
  const count = (parseInt(localStorage.getItem('hp_license_fail_count') || '0', 10) || 0) + 1;
  if (count >= 5) {
    localStorage.setItem('hp_license_lock_until', String(Date.now() + 60000));
    localStorage.setItem('hp_license_fail_count', '5');
    updateLicenseLockoutUi();
    return;
  }
  localStorage.setItem('hp_license_fail_count', String(count));
  setLicenseGateMessage(`${message || 'KEY sai hoặc không hợp lệ'} (${count}/5 lần)`, 'err');
}

function waitForLicenseGateUnlock() {
  return new Promise(resolve => {
    const wait = setInterval(() => {
      if (document.body.classList.contains('license-ok')) { clearInterval(wait); resolve(true); }
    }, 200);
  });
}

async function unlockLicenseGate(info, key, machineId) {
  try {
    localStorage.setItem('hp_license_key', key);
    localStorage.setItem('hp_license_info', JSON.stringify(info || {}));
    localStorage.setItem('hp_license_machine_id', machineId || '');
    localStorage.setItem('hp_license_verified_at', String(Date.now()));
    localStorage.removeItem('hp_license_fail_count');
    localStorage.removeItem('hp_license_lock_until');
  } catch {}
  renderLicenseStatus(info);
  updateHeaderLicense(info);
  checkLicenseReminder(info);
  setLicenseGateMessage('KEY hợp lệ. Đang mở ứng dụng...', 'ok');
  document.body.classList.add('license-ok');
}

async function submitLicenseGateKey(key, action = 'activate') {
  const input = document.getElementById('licenseGateKey');
  const btn = document.getElementById('licenseGateSubmit');
  key = String(key || '').trim();
  if (!key) { setLicenseGateMessage('Vui lòng nhập KEY bản quyền.', 'err'); return false; }
  if (updateLicenseLockoutUi()) return false;
  if (btn) btn.disabled = true;
  if (input) input.disabled = true;
  setLicenseGateMessage('Đang kiểm tra KEY và thiết bị...', '');
  try {
    const machineId = await ensureMachineId();
    const info = await verifyLicense(key, action);
    const usable = isLicenseUsable(info);
    if (!info || !usable.ok) {
      recordLicenseFailure(usable.error || 'KEY sai hoặc không hợp lệ');
      return false;
    }
    await unlockLicenseGate(info, key, machineId);
    return true;
  } catch (e) {
    recordLicenseFailure(e?.message || 'Không kiểm tra được KEY');
    return false;
  } finally {
    if (!document.body.classList.contains('license-ok') && !updateLicenseLockoutUi()) {
      if (btn) btn.disabled = false;
      if (input) input.disabled = false;
    }
  }
}

async function ensureLicenseGate() {
  document.body.classList.remove('license-ok');
  const form = document.getElementById('licenseGateForm');
  const input = document.getElementById('licenseGateKey');
  if (input) {
    try { input.value = localStorage.getItem('hp_license_key') || ''; } catch {}
  }
  if (form && !form.dataset.wired) {
    form.dataset.wired = '1';
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submitLicenseGateKey(input?.value || '', 'activate').catch(() => {});
    });
  }
  setInterval(updateLicenseLockoutUi, 1000);
  if (updateLicenseLockoutUi()) return waitForLicenseGateUnlock();
  const cachedKey = (input?.value || '').trim();
  if (!cachedKey) {
    setLicenseGateMessage('Nhập KEY bản quyền để tiếp tục.', '');
    return waitForLicenseGateUnlock();
  }
  const machineId = await ensureMachineId();
  const cachedMachine = localStorage.getItem('hp_license_machine_id') || '';
  if (cachedMachine && cachedMachine !== machineId) {
    setLicenseGateMessage('KEY này đã được kích hoạt trên thiết bị khác.', 'err');
  } else {
    const ok = await submitLicenseGateKey(cachedKey, 'verify');
    if (ok) return true;
  }
  return waitForLicenseGateUnlock();
}

(async function wireInfoTab() {
  const verEl = document.getElementById('appVersion');
  if (verEl && window.bigo.appGetVersion) {
    try { verEl.textContent = 'v' + (await window.bigo.appGetVersion()); } catch { verEl.textContent = '?'; }
  }

  // --- Auto-updater UI ---
  const upBtn = document.getElementById('btnCheckUpdate');
  const upStatus = document.getElementById('updateStatus');
  const upProgRow = document.getElementById('updateProgressRow');
  const upProgBar = document.getElementById('updateProgressBar');
  const upProgMeta = document.getElementById('updateProgressMeta');
  const setUpText = (txt, color) => {
    if (!upStatus) return;
    upStatus.textContent = txt || '';
    upStatus.style.color = color || '';
  };
  const showProgress = (visible) => {
    if (upProgRow) upProgRow.style.display = visible ? '' : 'none';
  };
  const fmtMB = (bytes) => (bytes / (1024 * 1024)).toFixed(1);
  const fmtSpeed = (bps) => {
    if (!bps) return '';
    const mbs = bps / (1024 * 1024);
    if (mbs >= 1) return `${mbs.toFixed(2)} MB/s`;
    return `${Math.round(bps / 1024)} KB/s`;
  };
  const fmtEta = (bps, remaining) => {
    if (!bps || !remaining) return '';
    const sec = Math.max(0, Math.round(remaining / bps));
    if (sec < 60) return `còn ${sec}s`;
    const m = Math.floor(sec / 60), s = sec % 60;
    return `còn ${m}p${String(s).padStart(2, '0')}`;
  };
  if (window.bigo.onUpdaterStatus) {
    window.bigo.onUpdaterStatus((s) => {
      if (!s) return;
      switch (s.state) {
        case 'checking':
          setUpText('🔄 Đang kiểm tra...', '#888');
          showProgress(false);
          break;
        case 'not-available':
          setUpText('✅ Đã là bản mới nhất', '#2ecc71');
          showProgress(false);
          if (upBtn) upBtn.disabled = false;
          break;
        case 'available':
          setUpText(`⬇️ Có bản mới v${s.version}`, '#e67e22');
          showProgress(false);
          break;
        case 'downloading': {
          const pct = s.percent != null ? s.percent : 0;
          setUpText(`⬇️ Đang tải bản mới...`, '#3498db');
          showProgress(true);
          if (upProgBar) upProgBar.value = pct;
          if (upProgMeta) {
            const speed = fmtSpeed(s.bytesPerSecond);
            const remaining = (s.total || 0) - (s.transferred || 0);
            const eta = fmtEta(s.bytesPerSecond, remaining);
            const sizes = (s.transferred && s.total)
              ? `${fmtMB(s.transferred)} / ${fmtMB(s.total)} MB`
              : '';
            upProgMeta.textContent = [`${pct}%`, sizes, speed, eta].filter(Boolean).join(' · ');
          }
          if (upBtn) upBtn.disabled = true;
          break;
        }
        case 'downloaded':
          setUpText(`📦 Đã tải xong v${s.version} — chờ cài đặt`, '#2ecc71');
          if (upProgBar) upProgBar.value = 100;
          if (upProgMeta) upProgMeta.textContent = '100% — sẵn sàng cài đặt';
          if (upBtn) upBtn.disabled = false;
          break;
        case 'error':
          setUpText(`⚠️ Lỗi: ${s.message || 'unknown'}`, '#e74c3c');
          showProgress(false);
          if (upBtn) upBtn.disabled = false;
          break;
      }
    });
  }
  if (upBtn && window.bigo.updaterCheck) {
    upBtn.onclick = async () => {
      upBtn.disabled = true;
      setUpText('🔄 Đang kiểm tra...', '#888');
      try {
        const r = await window.bigo.updaterCheck();
        if (r && r.dev) setUpText('💻 Dev mode — chỉ bản setup mới có updater', '#888');
      } catch (e) {
        setUpText(`⚠️ ${e?.message || e}`, '#e74c3c');
      } finally {
        upBtn.disabled = false;
      }
    };
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
    if (cached) {
      const info = JSON.parse(cached);
      renderLicenseStatus(info);
      updateHeaderLicense(info);
      // Check reminder ngay tu cache (offline-friendly)
      checkLicenseReminder(info);
    }
    const cachedKey = localStorage.getItem('hp_license_key');
    if (cachedKey) {
      // Background re-verify (silent) — sau 2s để không block UI startup.
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

// Status dot — textContent ẩn (font-size:0), nhưng title hiện khi hover.
// Theo dõi textContent → đồng bộ vào attribute title để user vẫn biết trạng thái chi tiết.
if (els.status) {
  const syncStatusTitle = () => {
    const txt = (els.status.textContent || '').trim();
    els.status.title = txt || 'Chưa kết nối';
  };
  syncStatusTitle();
  try {
    new MutationObserver(syncStatusTitle).observe(els.status, {
      childList: true, characterData: true, subtree: true,
    });
  } catch {}
}

function setLiveInfo(text, cls) {
  const target = els.headerLiveInfo || els.liveInfo;
  if (!target) return;
  target.className = `header-live-info ${cls || ''}`;
  const safe = escapeHtml(text);
  const brand = escapeHtml(LIVE_SUFFIX);
  // 2 bản copy để loop seamless via translateX(-50%)
  target.innerHTML = `<div class="live-marquee">
    <span>${safe}<span class="brand">${brand}</span></span>
    <span>${safe}<span class="brand">${brand}</span></span>
  </div>`;
}

function getEffectPlayTimes(ev) {
  // HÀNH ĐỘNG chạy theo số lượng quà/combo, không theo tổng đậu.
  // Ví dụ Bell x10 = 10 hàng hành động; 14 combo x10 = 140 hàng.
  const total = parseInt(ev?.total_count, 10) || ((parseInt(ev?.gift_count, 10) || 1) * (parseInt(ev?.combo, 10) || 1));
  return Math.max(1, Math.min(1000, total || 1));
}

function readViewerCount(roomData) {
  const candidates = [
    roomData?.viewerCount, roomData?.viewers, roomData?.audienceCount,
    roomData?.onlineCount, roomData?.online_num, roomData?.user_count,
  ];
  for (const v of candidates) {
    const n = parseInt(v, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0;
}

function setLiveViewerCount(roomData) {
  const n = readViewerCount(roomData);
  if (n <= 0 && sessionStats.viewers > 0) return;
  sessionStats.viewers = n;
  updateConnectStats();
}

async function init() {
  await ensureLicenseGate();
  const s = await window.bigo.settingsLoad();
  els.embedBigoId.value = s.bigoId || '';
  await initAppSettings(s);

  mapping = await window.bigo.mappingLoad();
  await reloadEffects();
  await validateConfiguredMediaFiles();
  renderGiftTable();
  renderOverlayTable();
  // Re-apply heart goal UI sau khi mapping load (vì lần đầu chạy trong initAppSettings,
  // mapping chưa có → overlay dropdown trống "(chưa có overlay)").
  applyHeartGoalUi();
  refreshIconCacheStatus();
  loadQueueSettings();
  renderQueue();
  renderMiniQueue();
  renderQueueCards();
  renderSettingsGroupsList();
  renderGameplayUi();
  renderRankingMemberSelectors();
  renderRankingEditor();
  pushRankingState();
  renderPkDuo();
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

async function validateConfiguredMediaFiles() {
  if (!window.bigo.effectsExists) return;
  const missing = [];
  for (const grp of (mapping.groups || [])) {
    for (const item of (grp.items || [])) {
      const files = normalizeMediaFiles(item);
      if (!files.length) continue;
      const valid = [];
      for (const file of files) {
        let exists = true;
        try { exists = await window.bigo.effectsExists(file); } catch { exists = false; }
        if (exists) valid.push(file);
        else missing.push(`${item.alias || (item.matchKeys || [])[0] || 'Quà'}: ${fileDisplayLabel(file)}`);
      }
      item.mediaFiles = valid;
      item.mediaFile = valid[0] || '';
    }
  }
  if (!missing.length) return;
  await persistMapping();
  renderGiftTable();
  const msg = `Thiếu dữ liệu nhạc/video:\n${missing.slice(0, 12).join('\n')}${missing.length > 12 ? `\n... và ${missing.length - 12} file khác` : ''}\n\nApp đã xoá tên file bị thiếu khỏi cấu hình để bạn chọn lại.`;
  appendLog('[media] ' + msg.replace(/\n/g, ' | '));
  setTimeout(() => alert(msg), 300);
}

function getDialogMediaFiles() {
  return normalizeMediaFiles(window._dlgMediaFiles || []);
}

function setDialogMediaFiles(files, { autosave = true } = {}) {
  window._dlgMediaFiles = normalizeMediaFiles(files);
  const primary = window._dlgMediaFiles[0] || '';
  if (els.dlgFile) {
    for (const file of window._dlgMediaFiles) {
      if (!Array.from(els.dlgFile.options).some(o => o.value === file)) {
        const opt = document.createElement('option');
        opt.value = file;
        opt.textContent = fileDisplayLabel(file);
        els.dlgFile.appendChild(opt);
      }
    }
    els.dlgFile.value = primary;
  }
  renderDialogMediaList();
  if (primary) autoEnablePauseBgmForAudio(primary);
  if (autosave) autoSaveOpenGiftFields();
}

function addDialogMediaFiles(files) {
  const next = [...getDialogMediaFiles(), ...files];
  setDialogMediaFiles(next);
}

function renderDialogMediaList() {
  if (!els.dlgMediaList) return;
  const files = getDialogMediaFiles();
  els.dlgMediaList.classList.toggle('empty', files.length === 0);
  els.dlgMediaList.innerHTML = files.map((file, idx) => `<div class="media-row" data-media-idx="${idx}">
    <span class="media-row-icon">${mediaIconFor(file)}</span>
    <span class="media-row-name ${idx === 0 ? 'primary' : ''}" title="${escapeHtml(fileDisplayLabel(file))}">${escapeHtml(fileDisplayLabel(file))}</span>
    <span class="media-row-actions">
      <button type="button" class="tiny" data-media-act="up" ${idx === 0 ? 'disabled' : ''}>↑</button>
      <button type="button" class="tiny" data-media-act="down" ${idx === files.length - 1 ? 'disabled' : ''}>↓</button>
      <button type="button" class="tiny danger" data-media-act="remove">×</button>
    </span>
  </div>`).join('');
}

function mediaFileFromDroppedFile(file) {
  if (!file) return '';
  const filePath = (window.bigo.getPathForFile ? window.bigo.getPathForFile(file) : '') || file.path || '';
  if (filePath) return fileUrlFromPath(filePath);
  return '';
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
  addDialogMediaFiles(r.files.map(f => f.fileUrl));
  els.dlgFile.value = picked.fileUrl;
  autoEnablePauseBgmForAudio(picked.fileUrl || picked.fileName);
  appendLog(`đã chọn ${r.files.length} file (giữ ở vị trí gốc, không copy vào assets/effects)`);
};
// dlgOpenFolder button đã bỏ — không cần mở thư mục assets/effects nữa.
if (els.dlgOpenFolder) els.dlgOpenFolder.onclick = () => window.bigo.effectsOpenFolder();

async function persistMapping() {
  await window.bigo.mappingSave(mapping);
}

async function autoSaveOpenGiftFields() {
  const itemId = els.giftDialog?.dataset?.editingId;
  if (!itemId) return;
  const found = findItemById(itemId);
  if (!found) return;
  const mediaFiles = getDialogMediaFiles();
  found.item.mediaFiles = mediaFiles;
  found.item.mediaFile = mediaFiles[0] || els.dlgFile.value || '';
  found.item.overlayId = els.dlgOverlay.value;
  found.item.priority = els.dlgPriority ? Math.max(0, Math.min(100, parseInt(els.dlgPriority.value, 10) || 0)) : 0;
  found.item.pauseBgm = els.dlgPauseBgm ? els.dlgPauseBgm.checked : false;
  found.item.preEffect = els.dlgPreFx ? els.dlgPreFx.checked : false;
  await persistMapping();
  renderGiftTable();
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
  renderGameplayUi();
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

// =================== Gameplay Overlay ===================
const gameplayReviewState = new Map();
const gameplayScoreTotals = new Map();

function getGameplayGroups() {
  return (mapping.groups || []).filter(g => g.type !== 'comment');
}

function gameplayItemIdentity(item) {
  const keys = (item?.matchKeys || []).map(k => String(k).trim()).filter(Boolean);
  const typeId = keys.find(k => /^\d+$/.test(k));
  if (typeId) return `id:${typeId}`;
  return `name:${String(item?.alias || keys[0] || item?.id || '').trim().toLowerCase()}`;
}

function getGameplayGroupWithCommon(group) {
  if (!group) return null;
  const common = getCommonGroup();
  const useCommon = appSettings.gameplay?.useCommonGroup !== false;
  const sourceGroups = group.isCommon || group.id === common.id ? [common] : (useCommon ? [common, group] : [group]);
  const seen = new Set();
  const items = [];
  for (const source of sourceGroups) {
    for (const item of (source.items || [])) {
      const key = gameplayItemIdentity(item);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
  }
  return { ...group, items };
}

function getGameplayItemIconId(item) {
  for (const k of (item?.matchKeys || [])) {
    const s = String(k).trim();
    if (/^\d+$/.test(s)) return s;
  }
  return '';
}

function getGameplayItemIcon(item) {
  return getGiftIcon(item) || item?.iconUrl || item?.gift_icon || '';
}

function normalizeGameplayIconUrl(icon) {
  return String(icon || '')
    .replace(/\\/g, '/')
    .replace(/[?#].*$/, '')
    .trim()
    .toLowerCase();
}

function normalizeGameplayGiftKey(s) {
  return String(s || '')
    .replace(/[​-‏‪-‮⁠-⁯﻿]/g, '')
    .replace(/[︀-️]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function getGameplayMatchKeys(item) {
  const keys = [...(item?.matchKeys || [])];
  if (item?.alias) keys.push(item.alias);
  return [...new Set(keys.map(k => String(k).trim()).filter(Boolean))];
}

function normalizeGameplaySettings() {
  if (!appSettings.gameplay) appSettings.gameplay = { groupId: '', useCommonGroup: true, orientation: 'horizontal', labelPosition: 'bottom', nameMode: 'marquee', cardBg: '#8d8d8d', cardOpacity: 86, textFont: 'Segoe UI', textColor: '#ffffff', slotNumberColor: '#ffffff', countColor: '#ffffff', countSize: 12, uppercase: false, showName: true, showCount: true, iconSize: 54, itemGap: 10, enlargeActive: false, activeScale: 140, centerLargest: false, grayInactive: false, keepScore: false, gridCols: 5, gridRows: 1, gridSlots: [], order: [], hiddenIds: [] };
  const groups = getGameplayGroups();
  if (!groups.length) return null;
  const selectedGroup = groups.find(g => g.id === appSettings.gameplay.groupId) || groups[0];
  appSettings.gameplay.groupId = selectedGroup.id;
  const group = getGameplayGroupWithCommon(selectedGroup);
  appSettings.gameplay.useCommonGroup = appSettings.gameplay.useCommonGroup !== false;
  appSettings.gameplay.orientation = appSettings.gameplay.orientation === 'vertical' ? 'vertical' : 'horizontal';
  if (!['top', 'bottom', 'left', 'right'].includes(appSettings.gameplay.labelPosition)) appSettings.gameplay.labelPosition = 'bottom';
  if (!['normal', 'marquee', 'wrap'].includes(appSettings.gameplay.nameMode)) appSettings.gameplay.nameMode = 'marquee';
  if (!/^#[0-9a-f]{6}$/i.test(String(appSettings.gameplay.cardBg || ''))) appSettings.gameplay.cardBg = '#8d8d8d';
  if (!/^#[0-9a-f]{6}$/i.test(String(appSettings.gameplay.textColor || ''))) appSettings.gameplay.textColor = '#ffffff';
  if (!/^#[0-9a-f]{6}$/i.test(String(appSettings.gameplay.slotNumberColor || ''))) appSettings.gameplay.slotNumberColor = '#ffffff';
  if (!/^#[0-9a-f]{6}$/i.test(String(appSettings.gameplay.countColor || ''))) appSettings.gameplay.countColor = '#ffffff';
  appSettings.gameplay.countSize = Math.max(9, Math.min(28, parseInt(appSettings.gameplay.countSize, 10) || 12));
  if (!['Segoe UI', 'Arial', 'Tahoma', 'Impact', 'Consolas'].includes(appSettings.gameplay.textFont)) appSettings.gameplay.textFont = 'Segoe UI';
  appSettings.gameplay.uppercase = !!appSettings.gameplay.uppercase;
  appSettings.gameplay.showName = appSettings.gameplay.showName !== false;
  appSettings.gameplay.showCount = appSettings.gameplay.showCount !== false;
  appSettings.gameplay.cardOpacity = Math.max(20, Math.min(100, parseInt(appSettings.gameplay.cardOpacity, 10) || 86));
  appSettings.gameplay.iconSize = Math.max(28, Math.min(120, parseInt(appSettings.gameplay.iconSize, 10) || 54));
  appSettings.gameplay.itemGap = Math.max(0, Math.min(60, Number.isFinite(parseInt(appSettings.gameplay.itemGap, 10)) ? parseInt(appSettings.gameplay.itemGap, 10) : 10));
  appSettings.gameplay.activeScale = Math.max(100, Math.min(200, parseInt(appSettings.gameplay.activeScale, 10) || 140));
  appSettings.gameplay.enlargeActive = !!appSettings.gameplay.enlargeActive;
  appSettings.gameplay.centerLargest = !!appSettings.gameplay.centerLargest;
  appSettings.gameplay.grayInactive = !!appSettings.gameplay.grayInactive;
  appSettings.gameplay.keepScore = !!appSettings.gameplay.keepScore;
  appSettings.gameplay.gridCols = Math.max(1, Math.min(40, parseInt(appSettings.gameplay.gridCols, 10) || 5));
  appSettings.gameplay.gridRows = Math.max(1, Math.min(40, parseInt(appSettings.gameplay.gridRows, 10) || 1));
  const ids = new Set((group.items || []).map(i => i.id));
  appSettings.gameplay.order = (appSettings.gameplay.order || []).filter(id => ids.has(id));
  for (const item of (group.items || [])) {
    if (!appSettings.gameplay.order.includes(item.id)) appSettings.gameplay.order.push(item.id);
  }
  appSettings.gameplay.hiddenIds = (appSettings.gameplay.hiddenIds || []).filter(id => ids.has(id));
  appSettings.gameplay.gridRows = Math.max(appSettings.gameplay.gridRows, Math.ceil(appSettings.gameplay.order.length / appSettings.gameplay.gridCols) || 1);
  const slotCount = appSettings.gameplay.gridCols * appSettings.gameplay.gridRows;
  const currentSlots = Array.isArray(appSettings.gameplay.gridSlots) ? appSettings.gameplay.gridSlots : [];
  appSettings.gameplay.gridSlots = Array.from({ length: slotCount }, (_, idx) => {
    const slot = currentSlots[idx] || {};
    const itemId = ids.has(slot.itemId) ? slot.itemId : '';
    return { itemId, text: String(slot.text || ''), number: String(slot.number || ''), visible: !!itemId };
  });
  let fillIdx = 0;
  for (const itemId of appSettings.gameplay.order) {
    if (appSettings.gameplay.gridSlots.some(s => s.itemId === itemId)) continue;
    while (fillIdx < slotCount && appSettings.gameplay.gridSlots[fillIdx].itemId) fillIdx++;
    if (fillIdx >= slotCount) break;
    appSettings.gameplay.gridSlots[fillIdx] = { itemId, text: '', number: '', visible: true };
  }
  return group;
}

function getGameplayOrderedItems(group) {
  const byId = new Map((group?.items || []).map(item => [item.id, item]));
  return (appSettings.gameplay.order || []).map(id => byId.get(id)).filter(Boolean);
}

function getGameplayItemById(itemId) {
  return findItemById(itemId)?.item || null;
}

function getGameplayItemName(item) {
  return item?.alias || (item?.matchKeys || [])[0] || 'Quà';
}

function buildGameplaySlots() {
  const slots = appSettings.gameplay.gridSlots || [];
  const hidden = new Set(appSettings.gameplay.hiddenIds || []);
  return slots.map((slot, idx) => {
    const item = getGameplayItemById(slot.itemId);
    const visible = slot.visible !== false && (!item || !hidden.has(item.id));
    if (!item) return { index: idx, itemId: '', text: slot.text || '', number: slot.number || '', visible: false };
    const name = slot.text || getGameplayItemName(item);
    return {
      index: idx,
      itemId: item.id,
      id: item.id,
      name,
      text: slot.text || '',
      number: slot.number || '',
      visible,
      icon: getGameplayItemIcon(item),
      iconId: getGameplayItemIconId(item),
      matchKeys: getGameplayMatchKeys(item),
    };
  });
}

function buildGameplayConfig() {
  const group = normalizeGameplaySettings();
  if (!group) return { items: [], orientation: 'horizontal', labelPosition: 'bottom' };
  const hidden = new Set(appSettings.gameplay.hiddenIds || []);
  return {
    orientation: appSettings.gameplay.orientation,
    labelPosition: appSettings.gameplay.labelPosition,
    nameMode: appSettings.gameplay.nameMode,
    cardBg: appSettings.gameplay.cardBg,
    cardOpacity: appSettings.gameplay.cardOpacity,
    textFont: appSettings.gameplay.textFont,
    textColor: appSettings.gameplay.textColor,
    slotNumberColor: appSettings.gameplay.slotNumberColor,
    countColor: appSettings.gameplay.countColor,
    countSize: appSettings.gameplay.countSize,
    uppercase: appSettings.gameplay.uppercase,
    showName: appSettings.gameplay.showName,
    showCount: appSettings.gameplay.showCount,
    iconSize: appSettings.gameplay.iconSize,
    itemGap: appSettings.gameplay.itemGap,
    enlargeActive: appSettings.gameplay.enlargeActive,
    activeScale: appSettings.gameplay.activeScale,
    centerLargest: appSettings.gameplay.centerLargest,
    grayInactive: appSettings.gameplay.grayInactive,
    keepScore: appSettings.gameplay.keepScore,
    gridCols: appSettings.gameplay.gridCols,
    gridRows: appSettings.gameplay.gridRows,
    slots: buildGameplaySlots(),
    items: getGameplayOrderedItems(group).filter(item => !hidden.has(item.id)).map(item => ({
      id: item.id,
      name: item.alias || (item.matchKeys || [])[0] || 'Quà',
      icon: getGameplayItemIcon(item),
      iconId: getGameplayItemIconId(item),
      matchKeys: getGameplayMatchKeys(item),
    })),
  };
}

function itemMatchesGameplayGift(item, ev) {
  const keys = getGameplayMatchKeys(item);
  if (ev?.gift_id != null && keys.some(k => k === String(ev.gift_id))) return true;
  const name = String(ev?.gift_name || '').toLowerCase().trim();
  const normalizedName = normalizeGameplayGiftKey(ev?.gift_name);
  if (normalizedName && keys.some(k => normalizeGameplayGiftKey(k) === normalizedName)) return true;
  const icon = String(ev?.gift_icon || ev?.gift_icon_url || '').trim();
  const itemIcon = String(getGameplayItemIcon(item) || '').trim();
  return !!icon && !!itemIcon && normalizeGameplayIconUrl(icon) === normalizeGameplayIconUrl(itemIcon);
}

function queueGroupMatchesGameplayItem(g, item) {
  if (!item) return false;
  if ((g.itemIds || []).includes(item.id)) return true;
  if ((g.identities || []).includes(gameplayItemIdentity(item))) return true;
  const gIcon = normalizeGameplayIconUrl(g.icon);
  const itemIcon = normalizeGameplayIconUrl(getGameplayItemIcon(item));
  if (gIcon && itemIcon && gIcon === itemIcon) return true;
  const idMatch = /^id:(.+)$/.exec(g.key || '');
  const ev = { gift_id: idMatch ? idMatch[1] : null, gift_name: g.name, gift_icon: g.icon };
  return itemMatchesGameplayGift(item, ev);
}

function queueGroupMatchesGameplaySlot(g, slot) {
  if (!slot?.itemId) return false;
  if ((g.itemIds || []).includes(slot.itemId)) return true;
  if (slot.iconId && (g.identities || []).includes(`id:${String(slot.iconId)}`)) return true;
  const gIcon = normalizeGameplayIconUrl(g.icon);
  const slotIcon = normalizeGameplayIconUrl(slot.icon);
  if (gIcon && slotIcon && gIcon === slotIcon) return true;
  const gName = normalizeGameplayGiftKey(g.name);
  if (gName && (normalizeGameplayGiftKey(slot.name) === gName || (slot.matchKeys || []).some(k => normalizeGameplayGiftKey(k) === gName))) return true;
  const item = getGameplayItemById(slot.itemId);
  return queueGroupMatchesGameplayItem(g, item);
}

function getGameplayQueueCountForSlot(slot, groups = getQueueGroups()) {
  let total = 0;
  for (const g of groups) {
    if (queueGroupMatchesGameplaySlot(g, slot)) total += g.total || 0;
  }
  return total;
}

function getGameplayVisibleItems() {
  const group = normalizeGameplaySettings();
  if (!group) return [];
  const hidden = new Set(appSettings.gameplay.hiddenIds || []);
  return getGameplayOrderedItems(group).filter(item => !hidden.has(item.id));
}

function getGameplayActiveIdsFromQueue(items = getGameplayVisibleItems()) {
  const active = new Set();
  const groups = getQueueGroups();
  for (const item of items) {
    for (const g of groups) {
      if (!g.playing) continue;
      if (queueGroupMatchesGameplayItem(g, item)) active.add(item.id);
    }
  }
  return active;
}

function orderGameplayItemsForDisplay(items) {
  if (!appSettings.gameplay?.centerLargest || items.length < 3) return items;
  let maxIdx = -1;
  let maxCount = 0;
  items.forEach((item, idx) => {
    const count = gameplayReviewState.get(item.id)?.count || 0;
    if (count > maxCount) { maxCount = count; maxIdx = idx; }
  });
  if (maxIdx < 0 || maxCount <= 0) return items;
  const arr = [...items];
  const [top] = arr.splice(maxIdx, 1);
  arr.splice(Math.floor(arr.length / 2), 0, top);
  return arr;
}

function getGameplayDisplaySlots() {
  return buildGameplaySlots();
}

function gameplayNameClass(name) {
  const mode = appSettings.gameplay?.nameMode || 'marquee';
  if (mode === 'wrap') return ' wrap';
  if (mode === 'marquee' && String(name || '').length > 9) return ' marquee';
  return '';
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return { r: 141, g: 141, b: 141 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function renderGameplayReview() {
  if (!els.gameplayReview) return;
  const baseItems = getGameplayVisibleItems();
  const activeIds = getGameplayActiveIdsFromQueue(baseItems);
  const slots = getGameplayDisplaySlots();
  const queueGroups = getQueueGroups();
  const hidden = new Set(appSettings.gameplay?.hiddenIds || []);
  els.gameplayReview.classList.toggle('vertical', appSettings.gameplay?.orientation === 'vertical');
  els.gameplayReview.classList.add('grid-mode');
  els.gameplayReview.dataset.labelPosition = appSettings.gameplay?.labelPosition || 'bottom';
  els.gameplayReview.style.setProperty('--gameplay-grid-cols', appSettings.gameplay?.gridCols || 10);
  els.gameplayReview.classList.toggle('gray-inactive', !!appSettings.gameplay?.grayInactive);
  els.gameplayReview.style.setProperty('--gameplay-active-scale', String((appSettings.gameplay?.activeScale || 140) / 100));
  const bg = hexToRgb(appSettings.gameplay?.cardBg || '#8d8d8d');
  els.gameplayReview.style.setProperty('--gameplay-card-bg-rgb', `${bg.r}, ${bg.g}, ${bg.b}`);
  els.gameplayReview.style.setProperty('--gameplay-card-opacity', String((appSettings.gameplay?.cardOpacity || 86) / 100));
  els.gameplayReview.style.setProperty('--gameplay-text-color', appSettings.gameplay?.textColor || '#ffffff');
  els.gameplayReview.style.setProperty('--gameplay-slot-number-color', appSettings.gameplay?.slotNumberColor || '#ffffff');
  els.gameplayReview.style.setProperty('--gameplay-count-color', appSettings.gameplay?.countColor || '#ffffff');
  els.gameplayReview.style.setProperty('--gameplay-count-size', `${Math.max(9, Math.min(28, parseInt(appSettings.gameplay?.countSize, 10) || 12))}px`);
  els.gameplayReview.style.setProperty('--gameplay-text-font', `'${String(appSettings.gameplay?.textFont || 'Segoe UI').replace(/'/g, '')}', sans-serif`);
  const iconSize = Math.max(28, Math.min(120, parseInt(appSettings.gameplay?.iconSize, 10) || 54));
  const parsedItemGap = parseInt(appSettings.gameplay?.itemGap, 10);
  const itemGap = Math.max(0, Math.min(60, Number.isFinite(parsedItemGap) ? parsedItemGap : 10));
  els.gameplayReview.style.setProperty('--gameplay-icon-size', `${iconSize}px`);
  els.gameplayReview.style.setProperty('--gameplay-icon-lift', `${Math.round(iconSize / 2)}px`);
  els.gameplayReview.style.setProperty('--gameplay-item-gap', `${itemGap}px`);
  els.gameplayReview.classList.toggle('uppercase', !!appSettings.gameplay?.uppercase);
  els.gameplayReview.classList.toggle('hide-name', appSettings.gameplay?.showName === false);
  if (!slots.length) {
    els.gameplayReview.innerHTML = '<div class="gameplay-empty">Chưa bật quà nào để hiển thị Review.</div>';
    return;
  }
  els.gameplayReview.innerHTML = slots.map(slot => {
    if (!slot.itemId || slot.visible === false || hidden.has(slot.itemId)) {
      return `<div class="gameplay-review-cell empty" data-slot="${slot.index}"></div>`;
    }
    const icon = slot.icon || '';
    const name = slot.name || 'Quà';
    const slotNumber = String(slot.number || '').trim();
    const queueCount = getGameplayQueueCountForSlot(slot, queueGroups);
    const labelPosition = appSettings.gameplay?.labelPosition || 'bottom';
    const isActive = activeIds.has(slot.itemId);
    const classes = [
      'gameplay-review-cell',
      'gameplay-review-card',
      `label-${labelPosition}`,
      isActive ? 'active' : '',
      appSettings.gameplay?.enlargeActive && isActive ? 'enlarged' : '',
    ].filter(Boolean).join(' ');
    return `<div class="${escapeHtml(classes)}" data-iid="${escapeHtml(slot.itemId)}" data-slot="${slot.index}">
      <div class="gameplay-review-icon-wrap">
        ${icon ? `<img src="${escapeHtml(icon)}" loading="lazy" />` : '<div class="gameplay-review-icon-empty"></div>'}
        ${queueCount ? `<span class="gameplay-review-count">${Number(queueCount).toLocaleString('en-US')}</span>` : ''}
      </div>
      ${slotNumber ? `<div class="gameplay-review-slot-number">${escapeHtml(slotNumber)}</div>` : ''}
      ${appSettings.gameplay?.showName === false ? '' : `<div class="gameplay-review-name${gameplayNameClass(name)}"><span>${escapeHtml(name)}</span></div>`}
    </div>`;
  }).join('');
}

function syncGameplayCountsFromQueue() {
  if (!appSettings?.gameplay) return;
  const items = getGameplayVisibleItems();
  const slots = buildGameplaySlots();
  const groups = getQueueGroups();
  gameplayReviewState.clear();
  const counts = {};
  const activeIds = [...getGameplayActiveIdsFromQueue(items)];
  for (const slot of slots) {
    if (!slot.itemId || slot.visible === false) continue;
    const total = getGameplayQueueCountForSlot(slot, groups);
    if (total > 0) {
      gameplayReviewState.set(slot.itemId, { count: total });
      counts[slot.itemId] = total;
    }
  }
  renderGameplayReview();
  if (window.bigo.gameplayCounts) window.bigo.gameplayCounts({ counts, activeIds }).catch(() => {});
}

function addGameplayScoreForEvent(ev) {
  if (!appSettings?.gameplay?.keepScore) return;
  const total = parseInt(ev.total_count, 10) || ((parseInt(ev.gift_count, 10) || 1) * (parseInt(ev.combo, 10) || 1));
  for (const item of getGameplayVisibleItems()) {
    if (!itemMatchesGameplayGift(item, ev)) continue;
    gameplayScoreTotals.set(item.id, (gameplayScoreTotals.get(item.id) || 0) + Math.max(1, total || 1));
  }
}

function addGameplayScoreForItem(item, count) {
  if (!appSettings?.gameplay?.keepScore || !item?.id) return;
  gameplayScoreTotals.set(item.id, (gameplayScoreTotals.get(item.id) || 0) + Math.max(1, parseInt(count, 10) || 1));
}

function initializeGameplayScoreFromQueue() {
  gameplayScoreTotals.clear();
  const items = getGameplayVisibleItems();
  const groups = getQueueGroups();
  for (const item of items) {
    let total = 0;
    for (const g of groups) {
      if (queueGroupMatchesGameplayItem(g, item)) total += g.total || 0;
    }
    if (total > 0) gameplayScoreTotals.set(item.id, total);
  }
}

function sendGameplayConfig() {
  if (!window.bigo.gameplayConfig) return;
  window.bigo.gameplayConfig(buildGameplayConfig()).catch(() => {});
}

async function saveGameplayToObs() {
  normalizeGameplaySettings();
  await saveAppSettings({ gameplay: appSettings.gameplay });
  sendGameplayConfig();
  syncGameplayCountsFromQueue();
  appendLog('[group dance] đã lưu và cập nhật OBS overlay');
}

function renderGameplayGridEditor(group) {
  if (!els.gameplayGridEditor) return;
  normalizeGameplaySettings();
  const items = getGameplayOrderedItems(group || findGroupById(appSettings.gameplay.groupId));
  els.gameplayGridEditor.style.setProperty('--gameplay-grid-cols', appSettings.gameplay.gridCols || 10);
  els.gameplayGridEditor.style.setProperty('--gameplay-slot-number-color', appSettings.gameplay.slotNumberColor || '#ffffff');
  els.gameplayGridEditor.innerHTML = (appSettings.gameplay.gridSlots || []).map((slot, idx) => {
    const item = getGameplayItemById(slot.itemId);
    const icon = item ? getGameplayItemIcon(item) : '';
    const name = item ? getGameplayItemName(item) : 'Chọn quà';
    const visible = !!item && slot.visible !== false;
    const pickerItems = prioritizeVnGifts(items, isVnMappingItem).map(pickerItem => {
      const pickerIcon = getGameplayItemIcon(pickerItem);
      const pickerName = getGameplayItemName(pickerItem);
      const vnBadge = isVnMappingItem(pickerItem) ? '<small class="vn-badge">VN</small>' : '';
      return `<button type="button" class="slot-picker-item" data-slot-pick="${idx}" data-item-id="${escapeHtml(pickerItem.id)}">${pickerIcon ? `<img src="${escapeHtml(pickerIcon)}" loading="lazy" />` : '<span class="slot-picker-empty"></span>'}<span>${escapeHtml(pickerName)} ${vnBadge}</span></button>`;
    }).join('');
    return `<div class="gameplay-grid-slot ${visible ? '' : 'slot-hidden'}" draggable="true" data-slot="${idx}">
      <div class="slot-topline">
        <span class="slot-index">#${idx + 1}</span>
        <span class="slot-drag" title="Kéo để đổi vị trí">☰</span>
        <button type="button" class="slot-check ${visible ? 'on' : ''}" data-slot-visible="${idx}" title="${item ? (visible ? 'Đang hiển thị trên Review/OBS' : 'Đang ẩn khỏi Review/OBS') : 'Ô trống không hiển thị'}" ${item ? '' : 'disabled'}>${visible ? '✓' : ''}</button>
      </div>
      <div class="slot-thumb-wrap">
        <button type="button" class="slot-thumb" data-slot-open="${idx}" title="Chọn quà">${icon ? `<img src="${escapeHtml(icon)}" loading="lazy" />` : '<span>+</span>'}</button>
        <input class="slot-number-input" data-slot-number="${idx}" value="${escapeHtml(slot.number || '')}" placeholder="Số" inputmode="numeric" />
      </div>
      <div class="slot-info-row">
        <span class="slot-current-name">${escapeHtml(name)}</span>
        <button type="button" class="tiny" data-slot-open="${idx}">Đổi</button>
      </div>
      <input data-slot-text="${idx}" value="${escapeHtml(slot.text || '')}" placeholder="Tên hiển thị" />
      <div class="slot-picker" hidden>
        <button type="button" class="slot-picker-item muted" data-slot-clear="${idx}"><span>+</span><span>Ô trống</span></button>
        ${pickerItems}
      </div>
    </div>`;
  }).join('');
  wireGameplayGridEditorDrag();
}

function wireGameplayGridEditorDrag() {
  if (!els.gameplayGridEditor) return;
  let dragIdx = null;
  els.gameplayGridEditor.querySelectorAll('.gameplay-grid-slot').forEach(cell => {
    cell.ondragstart = () => { dragIdx = parseInt(cell.dataset.slot, 10); cell.classList.add('dragging'); };
    cell.ondragend = () => { cell.classList.remove('dragging'); els.gameplayGridEditor.querySelectorAll('.drop-target').forEach(x => x.classList.remove('drop-target')); };
    cell.ondragover = (e) => { e.preventDefault(); cell.classList.add('drop-target'); };
    cell.ondragleave = () => cell.classList.remove('drop-target');
    cell.ondrop = (e) => {
      e.preventDefault();
      const targetIdx = parseInt(cell.dataset.slot, 10);
      if (!Number.isFinite(dragIdx) || !Number.isFinite(targetIdx) || dragIdx === targetIdx) return;
      const slots = [...(appSettings.gameplay.gridSlots || [])];
      [slots[dragIdx], slots[targetIdx]] = [slots[targetIdx], slots[dragIdx]];
      saveGameplaySettings({ gridSlots: slots });
    };
  });
}

function resizeGameplayGrid(cols, rows) {
  normalizeGameplaySettings();
  cols = Math.max(1, Math.min(40, parseInt(cols, 10) || 5));
  rows = Math.max(1, Math.min(40, parseInt(rows, 10) || 1));
  const oldCols = appSettings.gameplay.gridCols;
  const oldRows = appSettings.gameplay.gridRows;
  const oldSlots = appSettings.gameplay.gridSlots || [];
  const nextSlots = Array.from({ length: cols * rows }, () => ({ itemId: '', text: '', number: '', visible: false }));
  for (let r = 0; r < Math.min(oldRows, rows); r++) {
    for (let c = 0; c < Math.min(oldCols, cols); c++) {
      nextSlots[r * cols + c] = oldSlots[r * oldCols + c] || { itemId: '', text: '', number: '', visible: false };
    }
  }
  saveGameplaySettings({ gridCols: cols, gridRows: rows, gridSlots: nextSlots });
}

function slotHasContent(slot) {
  return !!(slot?.itemId || String(slot?.text || '').trim() || String(slot?.number || '').trim());
}

async function deleteGameplayGridColumn() {
  normalizeGameplaySettings();
  const cols = appSettings.gameplay.gridCols || 5;
  const rows = appSettings.gameplay.gridRows || 1;
  if (cols <= 1) return;
  const slots = appSettings.gameplay.gridSlots || [];
  const removed = [];
  for (let r = 0; r < rows; r++) removed.push(slots[r * cols + cols - 1]);
  if (removed.some(slotHasContent)) {
    const ok = await appConfirm({ title: 'Xoá cột cuối?', message: 'Cột cuối đang có quà hoặc chữ.', detail: 'Chọn Có để xoá cột và các ô trong cột này.', okText: 'Có, xoá cột', cancelText: 'Không', danger: true });
    if (!ok) return;
  }
  const nextSlots = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols - 1; c++) nextSlots.push(slots[r * cols + c] || { itemId: '', text: '', number: '', visible: false });
  }
  saveGameplaySettings({ gridCols: cols - 1, gridRows: rows, gridSlots: nextSlots });
}

async function deleteGameplayGridRow() {
  normalizeGameplaySettings();
  const cols = appSettings.gameplay.gridCols || 5;
  const rows = appSettings.gameplay.gridRows || 1;
  if (rows <= 1) return;
  const slots = appSettings.gameplay.gridSlots || [];
  const start = (rows - 1) * cols;
  const removed = slots.slice(start, start + cols);
  if (removed.some(slotHasContent)) {
    const ok = await appConfirm({ title: 'Xoá hàng cuối?', message: 'Hàng cuối đang có quà hoặc chữ.', detail: 'Chọn Có để xoá hàng và các ô trong hàng này.', okText: 'Có, xoá hàng', cancelText: 'Không', danger: true });
    if (!ok) return;
  }
  saveGameplaySettings({ gridCols: cols, gridRows: rows - 1, gridSlots: slots.slice(0, start) });
}

function renderGameplayUi() {
  if (!els.gameplayGroup || !els.gameplayItems) return;
  const groups = getGameplayGroups();
  if (!groups.length) {
    els.gameplayGroup.innerHTML = '<option value="">Chưa có nhóm</option>';
    els.gameplayItems.innerHTML = '';
    if (els.gameplayGridEditor) els.gameplayGridEditor.innerHTML = '';
    renderGameplayReview();
    sendGameplayConfig();
    syncGameplayCountsFromQueue();
    return;
  }
  const group = normalizeGameplaySettings();
  els.gameplayGroup.innerHTML = groups.map(g => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.name || 'Nhóm')}</option>`).join('');
  els.gameplayGroup.value = appSettings.gameplay.groupId;
  if (els.gameplayGroupChecks) {
    const common = getCommonGroup();
    els.gameplayGroupChecks.innerHTML = groups.map(g => {
      const isCommon = g.isCommon || g.id === common.id;
      const checked = isCommon ? appSettings.gameplay.useCommonGroup !== false : g.id === appSettings.gameplay.groupId;
      return `<button type="button" class="gameplay-group-check ${checked ? 'on' : ''}" data-gameplay-group-check="${escapeHtml(g.id)}"><span class="box">${checked ? '✓' : ''}</span><span>${escapeHtml(g.name || 'Nhóm')}</span></button>`;
    }).join('');
  }
  if (els.gameplayOrientation) els.gameplayOrientation.value = appSettings.gameplay.orientation;
  if (els.gameplayLabelPosition) els.gameplayLabelPosition.value = appSettings.gameplay.labelPosition;
  if (els.gameplayNameMode) els.gameplayNameMode.value = appSettings.gameplay.nameMode;
  if (els.gameplayCardBg) els.gameplayCardBg.value = appSettings.gameplay.cardBg;
  if (els.gameplayCardOpacity) els.gameplayCardOpacity.value = appSettings.gameplay.cardOpacity;
  if (els.gameplayCardOpacityVal) els.gameplayCardOpacityVal.textContent = `${appSettings.gameplay.cardOpacity}%`;
  if (els.gameplayTextFont) els.gameplayTextFont.value = appSettings.gameplay.textFont;
  if (els.gameplayTextColor) els.gameplayTextColor.value = appSettings.gameplay.textColor;
  if (els.gameplaySlotNumberColor) els.gameplaySlotNumberColor.value = appSettings.gameplay.slotNumberColor;
  if (els.gameplayCountColor) els.gameplayCountColor.value = appSettings.gameplay.countColor;
  if (els.gameplayUseCommonGroup) els.gameplayUseCommonGroup.checked = appSettings.gameplay.useCommonGroup !== false;
  if (els.gameplayUppercase) els.gameplayUppercase.checked = !!appSettings.gameplay.uppercase;
  if (els.gameplayShowName) els.gameplayShowName.checked = appSettings.gameplay.showName !== false;
  if (els.gameplayShowCount) els.gameplayShowCount.checked = appSettings.gameplay.showCount !== false;
  if (els.gameplayIconSize) els.gameplayIconSize.value = appSettings.gameplay.iconSize;
  if (els.gameplayIconSizeVal) els.gameplayIconSizeVal.textContent = `${appSettings.gameplay.iconSize}px`;
  if (els.gameplayCountSize) els.gameplayCountSize.value = appSettings.gameplay.countSize;
  if (els.gameplayCountSizeVal) els.gameplayCountSizeVal.textContent = `${appSettings.gameplay.countSize}px`;
  if (els.gameplayItemGap) els.gameplayItemGap.value = appSettings.gameplay.itemGap;
  if (els.gameplayItemGapVal) els.gameplayItemGapVal.textContent = `${appSettings.gameplay.itemGap}px`;
  if (els.gameplayEnlargeActive) els.gameplayEnlargeActive.checked = !!appSettings.gameplay.enlargeActive;
  if (els.gameplayActiveScale) els.gameplayActiveScale.value = appSettings.gameplay.activeScale;
  if (els.gameplayActiveScaleVal) els.gameplayActiveScaleVal.textContent = `${appSettings.gameplay.activeScale}%`;
  if (els.gameplayCenterLargest) els.gameplayCenterLargest.checked = !!appSettings.gameplay.centerLargest;
  if (els.gameplayGrayInactive) els.gameplayGrayInactive.checked = !!appSettings.gameplay.grayInactive;
  if (els.gameplayKeepScore) els.gameplayKeepScore.checked = !!appSettings.gameplay.keepScore;

  const items = getGameplayOrderedItems(group);
  if (!items.length) {
    els.gameplayItems.innerHTML = '';
    renderGameplayGridEditor(group);
    renderGameplayReview();
    sendGameplayConfig();
    syncGameplayCountsFromQueue();
    return;
  }
  els.gameplayItems.innerHTML = '';
  renderGameplayGridEditor(group);
  renderGameplayReview();
  sendGameplayConfig();
  syncGameplayCountsFromQueue();
}

function wireGameplayDragDrop() {
  if (!els.gameplayItems) return;
  let dragId = null;
  els.gameplayItems.querySelectorAll('.gameplay-item').forEach(row => {
    row.draggable = true;
    row.ondragstart = (e) => {
      dragId = row.dataset.iid;
      e.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
    };
    row.ondragend = () => {
      row.classList.remove('dragging');
      els.gameplayItems.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
    };
    row.ondragover = (e) => {
      e.preventDefault();
      row.classList.add('drop-target');
    };
    row.ondragleave = () => row.classList.remove('drop-target');
    row.ondrop = (e) => {
      e.preventDefault();
      row.classList.remove('drop-target');
      const targetId = row.dataset.iid;
      if (!dragId || !targetId || dragId === targetId) return;
      normalizeGameplaySettings();
      const order = [...(appSettings.gameplay.order || [])];
      const from = order.indexOf(dragId);
      const to = order.indexOf(targetId);
      if (from === -1 || to === -1) return;
      const [moved] = order.splice(from, 1);
      order.splice(to, 0, moved);
      saveGameplaySettings({ order });
    };
  });
}

async function saveGameplaySettings(patch) {
  appSettings.gameplay = { ...appSettings.gameplay, ...patch };
  await saveAppSettings({ gameplay: appSettings.gameplay });
  renderGameplayUi();
}

function forwardGameplayGiftEvent(ev) {
  if (!ev || ev.type !== 'gift') return;
  addGameplayScoreForEvent(ev);
  syncGameplayCountsFromQueue();
}

function isSpecialTriggerItem(item) {
  const keys = new Set((item?.matchKeys || []).map(k => String(k).toLowerCase().trim()).filter(Boolean));
  if (item?.alias) keys.add(String(item.alias).toLowerCase().trim());
  const se = appSettings?.specialEffects || {};
  for (const cfg of Object.values(se)) {
    if (!cfg || typeof cfg !== 'object') continue;
    if (cfg.typeid != null && keys.has(String(cfg.typeid).toLowerCase())) return true;
    if (cfg.giftName && keys.has(String(cfg.giftName).toLowerCase().trim())) return true;
  }
  return false;
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
    const overlayTarget = overlayMap.get(item.overlayId)?.target || 'native';
    const priorityBadge = item.priority > 0 ? `<span class="gift-state-badge prio-badge" title="Ưu tiên: chèn vào hàng ${item.priority} trong queue">⚡#${item.priority}</span>` : '';
    const pauseBgmBadge = item.pauseBgm ? '<span class="gift-state-badge pause-bgm-badge" title="Tạm dừng nhạc nền khi hiệu ứng này phát">🔇</span>' : '';
    const preEffectBadge = item.preEffect ? '<span class="gift-state-badge pre-effect-badge" title="Phát âm thanh/video trước hiệu ứng">🔔</span>' : '';
    const targetBadge = item.overlayId ? `<span class="gift-state-badge target-badge" title="Đích phát: ${overlayTarget === 'obs' ? 'OBS localhost' : overlayTarget === 'both' ? 'Cửa sổ + OBS localhost' : 'Cửa sổ máy tính'}">${overlayTarget === 'obs' ? '🔗' : overlayTarget === 'both' ? '🖥🔗' : '🖥'}</span>` : '';
    const mediaFiles = normalizeMediaFiles(item);
    const missingBadge = !mediaFiles.length ? '<span class="gift-state-badge missing-badge" title="Chưa chọn file hiệu ứng">⚠️</span>' : '';
    const randomBadge = mediaFiles.length > 1 ? `<span class="gift-state-badge target-badge" title="${mediaFiles.length} hiệu ứng: tự phát ngẫu nhiên">🎲 ${mediaFiles.length}</span>` : '';
    const specialBadge = isSpecialTriggerItem(item) ? '<span class="gift-state-badge special-badge" title="Quà này đang dùng làm trigger Hiệu Ứng Đặc Biệt">🎯</span>' : '';
    // Hiển thị tên file rút gọn (basename) nếu là full path/URL
    const mediaTypeIcon = mediaFiles.length > 1 ? '🎲' : mediaIconFor(mediaFiles[0] || '');
    const fileDisplay = mediaFiles.length > 1 ? `${mediaFiles.length} hiệu ứng ngẫu nhiên` : displayEffectName(mediaFiles[0] || '');
    const actionBadges = mediaFiles.length
      ? `${priorityBadge}${pauseBgmBadge}${preEffectBadge}${randomBadge}${targetBadge}${specialBadge}`
      : `${missingBadge}${targetBadge}${specialBadge}`;
    const fileLine = mediaFiles.length
      ? `<div class="grow-sub"><code><span class="media-kind-icon">${escapeHtml(mediaTypeIcon)}</span>${escapeHtml(fileDisplay)}</code></div>`
      : `<div class="grow-sub"><span style="color:#ff6b6b">— chưa có file hiệu ứng —</span></div>`;
    return `<div class="group-item" data-iid="${item.id}" data-gid="${grp.id}">
      ${iconCell}
      <div class="grow-meta">
        <div class="grow-name"><b>${escapeHtml(displayName)}</b></div>
        ${fileLine}
      </div>
      <div class="grow-actions">
        <span class="gift-state-badges action-badges">${actionBadges}</span>
        <input type="number" class="play-count" min="1" max="50" value="1" data-iid="${item.id}" title="Số lượng phát" onclick="event.stopPropagation()" />
        <button class="tiny" data-act="play" data-iid="${item.id}" title="Phát N lần">▶</button>
        <button class="tiny" data-act="edit-item" data-iid="${item.id}">✏️</button>
        <button class="tiny danger" data-act="del-item" data-iid="${item.id}">🗑</button>
      </div>
    </div>`;
  }).join('') || '<div style="color:#555;padding:8px;font-size:11px">Nhóm trống</div>';

  // NHÓM CHUNG: không có toggle bật/tắt + không xoá được + tên cố định
  const toggleHtml = isCommon
    ? ''
    : `<label class="switch" title="Bật/tắt nhóm">
         <input type="checkbox" data-act="toggle-group" data-gid="${grp.id}" ${enabled ? 'checked' : ''} />
         <span class="slider"></span>
       </label>`;
  const editBtn = isCommon ? '' :
    `<button class="tiny" data-act="edit-group" data-gid="${grp.id}" title="Sửa nhóm">✏️</button>`;
  const groupMembers = getGroupMembers(grp);
  const memberBadge = groupMembers.length ? `<span class="group-badge member-count" title="Thành viên: ${escapeHtml(groupMembers.map(m => m.name).join(', '))}">👤 ${groupMembers.length}</span>` : '';

  return `<div class="group-card ${enabled ? 'on' : 'off'} ${collapsed ? 'collapsed' : ''} ${isCommon ? 'common' : ''}" data-gid="${grp.id}">
    <div class="group-head">
      <span class="group-name">${escapeHtml(grp.name)}</span>
      <span class="group-head-spacer"></span>
      ${memberBadge}
      <span class="group-badge">${(grp.items || []).length} mục</span>
      <button class="tiny" data-act="add-item" data-gid="${grp.id}" title="Thêm quà vào nhóm">+ Thêm quà</button>
      ${editBtn}
      <button class="tiny" data-act="collapse" data-gid="${grp.id}" title="Thu gọn/Mở">${collapsed ? '▶' : '▼'}</button>
      ${toggleHtml}
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
    const ok = await appConfirm({
      title: 'Xoá nhóm?',
      message: `Xoá nhóm "${grp.name}"?`,
      detail: itemCount > 0 ? `${itemCount} quà bên trong sẽ tự động chuyển về NHÓM CHUNG, không mất cấu hình quà.` : 'Thao tác này không thể hoàn tác.',
      okText: 'Có, xoá nhóm',
      cancelText: 'Không',
      danger: true,
    });
    if (!ok) return;
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
      if (!hasEffectMedia(found.item) || !found.item.overlayId) { alert('Quà chưa có file hoặc overlay'); return; }
      // Lấy số lượng từ input cùng row
      const countInput = document.querySelector(`.play-count[data-iid="${itemId}"]`);
      const playTimes = Math.max(1, Math.min(1000, parseInt(countInput?.value || '1', 10) || 1));
      // BGM pause/resume chạy theo item đang phát trong playQueueItem().
      // Pre-effect: phát ÂM THANH/VIDEO trước (1 lần) nếu cả gift + setting cùng bật
      maybeDispatchPreEffect(found.item);
      // Manual play cũng counter 🎵 effects để user thấy stats hoạt động khi test
      sessionStats.effects += playTimes;
      updateConnectStats();
      // Chia tách thành playTimes entries (đếm lùi giảm dần)
      addGameplayScoreForItem(found.item, playTimes);
      pushPlayBatch(found.item, null, playTimes);
    } else if (act === 'edit-item') {
      openGiftDialog(found.item, found.group.id);
    } else if (act === 'del-item') {
      const name = found.item.alias || found.item.matchKeys.join(',') || 'quà này';
      const ok = await appConfirm({
        title: 'Xoá quà khỏi nhóm?',
        message: `Xoá "${name}" khỏi nhóm "${found.group.name}"?`,
        detail: 'Thao tác này sẽ xoá cấu hình quà này khỏi nhóm hiện tại.',
        okText: 'Có, xoá',
        cancelText: 'Không',
        danger: true,
      });
      if (!ok) return;
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

// Detect quà Việt Nam: ưu tiên flag vn_match từ main process (chính xác — match theo
// file vietnam-gifts.json đã import). Heuristic regex chỉ dùng fallback cho master
// records cũ chưa có flag (vd điểm release cũ).
const VN_KEYWORDS = /việt|vietnam|tết|sài\s?gòn|hà\s?nội|đà\s?nẵng|phở|áo\s?dài|hoa\s?sen|trống|nón\s?lá|VN|hp\s|HPMedia/i;
const VN_ACCENTS = /[àáảãạâầấẩẫậăằắẳẵặèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i;
function isVnGift(g) {
  if (!g) return false;
  if (g.vn_match) return true;
  const n = String(g.name || '');
  return VN_KEYWORDS.test(n) || VN_ACCENTS.test(n);
}

function prioritizeVnGifts(arr, predicate = isVnGift) {
  return arr.map((item, idx) => ({ item, idx }))
    .sort((a, b) => (predicate(b.item) ? 1 : 0) - (predicate(a.item) ? 1 : 0) || a.idx - b.idx)
    .map(x => x.item);
}

function isVnMappingItem(item) {
  if (!item) return false;
  const keys = [...(item.matchKeys || []), item.alias || ''];
  for (const key of keys) {
    const id = parseInt(key, 10);
    if (!Number.isFinite(id)) continue;
    const master = (masterFullList || []).find(g => Number(g.typeid) === id);
    if (master && isVnGift(master)) return true;
  }
  return isVnGift({ name: getGameplayItemName(item) });
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
  if (els.dlgMasterTotal) els.dlgMasterTotal.textContent = `Số lượng: ${masterFullList.length.toLocaleString('en-US')} quà`;
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
  arr = prioritizeVnGifts(sortMasterArr(arr, sortKey));
  els.dlgMasterCount.textContent = `${arr.length}/${masterFullList.length} quà`;
  const display = arr;
  els.dlgMasterTableBody.innerHTML = display.map(g => {
    const src = g.localIcon || g.img_url || '';
    const isFav = giftFavorites.has(g.typeid);
    const vnBadge = isVnGift(g)
      ? `<span class="vn-badge" title="Quà có trong danh mục khu vực Việt Nam">🇻🇳 VN</span>`
      : '';
    return `<tr data-typeid="${g.typeid}" data-name="${escapeHtml(g.name)}">
      <td><img src="${escapeHtml(src)}" loading="lazy" draggable="true" data-typeid="${g.typeid}" title="Kéo ra desktop = ${g.typeid}.png" /></td>
      <td><span class="id">${g.typeid}</span></td>
      <td><span class="price">${beanIconHtml('small')} ${g.diamonds ?? '?'}</span></td>
      <td><span class="name">${escapeHtml(g.name)} ${vnBadge}</span></td>
      <td><button class="fav-btn ${isFav ? 'on' : ''}" data-fav="${g.typeid}" title="Đánh dấu yêu thích">${isFav ? '⭐' : '☆'}</button></td>
    </tr>`;
  }).join('');
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
if (els.dlgFile) els.dlgFile.addEventListener('change', () => {
  const selected = els.dlgFile.value;
  if (selected) {
    const files = getDialogMediaFiles();
    if (!files.includes(selected)) setDialogMediaFiles([selected, ...files]);
    else if (files[0] !== selected) setDialogMediaFiles([selected, ...files.filter(f => f !== selected)]);
  }
  autoEnablePauseBgmForAudio(els.dlgFile.value);
  autoSaveOpenGiftFields();
});
if (els.dlgOverlay) els.dlgOverlay.addEventListener('change', () => autoSaveOpenGiftFields());
if (els.dlgPriority) els.dlgPriority.addEventListener('change', () => autoSaveOpenGiftFields());
if (els.dlgPriority) els.dlgPriority.addEventListener('input', () => autoSaveOpenGiftFields());
if (els.dlgPauseBgm) els.dlgPauseBgm.addEventListener('change', () => autoSaveOpenGiftFields());
if (els.dlgPreFx) els.dlgPreFx.addEventListener('change', () => autoSaveOpenGiftFields());
if (els.dlgMediaList) {
  els.dlgMediaList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-media-act]');
    if (!btn) return;
    const row = btn.closest('[data-media-idx]');
    const idx = parseInt(row?.dataset.mediaIdx, 10);
    const files = getDialogMediaFiles();
    if (!Number.isFinite(idx) || !files[idx]) return;
    if (btn.dataset.mediaAct === 'remove') files.splice(idx, 1);
    else if (btn.dataset.mediaAct === 'up' && idx > 0) [files[idx - 1], files[idx]] = [files[idx], files[idx - 1]];
    else if (btn.dataset.mediaAct === 'down' && idx < files.length - 1) [files[idx], files[idx + 1]] = [files[idx + 1], files[idx]];
    setDialogMediaFiles(files);
  });
}
if (els.dlgMediaDrop) {
  els.dlgMediaDrop.addEventListener('dragover', (e) => { e.preventDefault(); els.dlgMediaDrop.classList.add('drag-over'); });
  els.dlgMediaDrop.addEventListener('dragleave', () => els.dlgMediaDrop.classList.remove('drag-over'));
  els.dlgMediaDrop.addEventListener('drop', (e) => {
    e.preventDefault();
    els.dlgMediaDrop.classList.remove('drag-over');
    const files = Array.from(e.dataTransfer?.files || [])
      .filter(file => /\.(mp4|webm|mp3|wav|ogg|gif)$/i.test(file.name || ''))
      .map(mediaFileFromDroppedFile)
      .filter(Boolean);
    if (!files.length) { alert('Không đọc được đường dẫn file. Hãy dùng nút 📁 Chọn để thêm file.'); return; }
    addDialogMediaFiles(files);
  });
}

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
  const mediaFiles = normalizeMediaFiles(gift || {});
  setDialogMediaFiles(mediaFiles, { autosave: false });
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
    mediaFile: getDialogMediaFiles()[0] || els.dlgFile.value,
    mediaFiles: getDialogMediaFiles(),
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
  const mediaFile = chooseEffectMedia(g);
  if (!mediaFile || !g.overlayId) { alert('Quà đầu tiên chưa có file hoặc overlay'); return; }
  await window.bigo.overlayPlay({ overlayId: g.overlayId, ...resolveMediaPayload(mediaFile) });
};

// =================== Overlay Table ===================
function renderOverlayTable() {
  if (mapping.overlays.length === 0) {
    els.overlayTableBody.innerHTML = '<tr><td colspan="9" style="color:#555;text-align:center;padding:20px">Chưa có overlay — bấm "+ Thêm overlay"</td></tr>';
  } else {
    els.overlayTableBody.innerHTML = mapping.overlays.map(o => {
      const b = o.bounds || {};
      const target = o.target || 'native';
      const targetText = target === 'obs' ? '🔗 OBS' : target === 'both' ? '🖥 + 🔗' : '🖥 Máy tính';
      const lockBtn = o.clickThrough
        ? `<button class="tiny" data-act="unlock" data-id="${o.id}" title="Đang khoá - bấm để mở khoá">🔓</button>`
        : `<button class="tiny" data-act="lock" data-id="${o.id}" title="Bật click-through OBS mode">🔒</button>`;
      return `<tr data-id="${o.id}">
        <td>${escapeHtml(o.name)}</td>
        <td><span class="color-swatch" style="background:${o.bgColor}"></span><code>${escapeHtml(o.bgColor)}</code></td>
        <td>${Math.round((o.opacity ?? 1) * 100)}%</td>
        <td>${b.width || '?'} × ${b.height || '?'}</td>
        <td>${b.x != null ? `${Math.round(b.x)}, ${Math.round(b.y)}` : 'auto'}</td>
        <td>${targetText}</td>
        <td>${o.alwaysOnTop ? '✓' : '—'}</td>
        <td>${o.clickThrough ? '🔒 Có' : '—'}</td>
        <td class="actions-col">
          <button class="tiny" data-act="show" data-id="${o.id}" title="Mở/hiện overlay">👁</button>
          <button class="tiny" data-act="obs-copy" data-id="${o.id}" title="Copy link overlay localhost cho OBS Browser Source">🔗 OBS</button>
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
  } else if (act === 'obs-copy') {
    const r = await window.bigo.obsOverlayCopyUrl(id);
    if (!r.ok) alert('Lỗi copy OBS link: ' + (r.error || 'unknown'));
    else alert(`Đã copy link OBS Browser Source:\n${r.url}\n\nTrong OBS: Add Browser Source → paste URL này. Khi OBS đang mở link, hiệu ứng sẽ chạy qua localhost, không cần mở cửa sổ overlay desktop.`);
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
    const usingGifts = getAllItems().filter(g => g.overlayId === id);
    const ok = await appConfirm({
      title: 'Xoá overlay?',
      message: `Xoá overlay "${o.name}"?`,
      detail: usingGifts.length ? `${usingGifts.length} quà đang dùng overlay này sẽ bị bỏ liên kết overlay.` : 'Thao tác này không thể hoàn tác.',
      okText: 'Có, xoá overlay',
      cancelText: 'Không',
      danger: true,
    });
    if (!ok) return;
    await window.bigo.overlayDelete(id);
    mapping.overlays = mapping.overlays.filter(x => x.id !== id);
    for (const grp of (mapping.groups || [])) {
      for (const item of (grp.items || [])) if (item.overlayId === id) item.overlayId = mapping.overlays[0]?.id || '';
    }
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
  if (els.ovTarget) els.ovTarget.value = ov?.target || 'native';
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
    target: els.ovTarget ? els.ovTarget.value : 'native',
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
let liveViewerTimer = null;

function stopLiveViewerRefresh() {
  if (liveViewerTimer) clearInterval(liveViewerTimer);
  liveViewerTimer = null;
}

function startLiveViewerRefresh(bigoId) {
  stopLiveViewerRefresh();
  liveViewerTimer = setInterval(async () => {
    if (!isConnected || !bigoId) return;
    try {
      const check = await window.bigo.checkLive(bigoId);
      const d = check?.data?.data || {};
      if (check?.ok && d.alive === 1 && readViewerCount(d) > 0) setLiveViewerCount(d);
    } catch {}
  }, 30_000);
}

function setConnectedUi(yes) {
  isConnected = yes;
  if (els.embedBigoId) {
    els.embedBigoId.disabled = !!yes;
    els.embedBigoId.title = yes ? 'Đã kết nối. Bấm HỦY KẾT NỐI để nhập BIGO ID khác.' : '';
  }
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
  stopLiveViewerRefresh();
  if (typeof scoreStop === 'function') scoreStop();
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
  stopLiveViewerRefresh();
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
    setLiveViewerCount(d);
    setLiveInfo(`🔴 OFFLINE — ${d.nick_name || 'không tìm thấy ID'}`, 'dead');
    els.status.textContent = 'offline';
    els.btnConnect.disabled = false;
    return;
  }

  setLiveViewerCount(d);
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
  startLiveViewerRefresh(id);
  // Auto-play BGM khi kết nối thành công (theo nhóm active hoặc Cài đặt chung)
  applyActiveBgm();
  playBgmIfHas();
};

els.btnPopupGifts.onclick = () => window.bigo.popupOpenGifts();
if (els.btnPopupQueue) els.btnPopupQueue.onclick = () => window.bigo.popupOpenQueue();
// Nút "🗑 Xoá tất cả" trên panel DSHT mini (trang chính) — confirm trước
const btnClearMiniQueue = document.getElementById('btnClearMiniQueue');
if (btnClearMiniQueue) btnClearMiniQueue.onclick = async () => {
  if (await confirmClearQueue()) clearAllQueue();
};
const btnShuffleMiniQueue = document.getElementById('btnShuffleMiniQueue');
if (btnShuffleMiniQueue) btnShuffleMiniQueue.onclick = () => queueShuffleQueued();
const btnToggleMiniQueue = document.getElementById('btnToggleMiniQueue');
if (btnToggleMiniQueue) btnToggleMiniQueue.onclick = () => queueToggleCurrent();
const btnToggleQueue = document.getElementById('btnToggleQueue');
if (btnToggleQueue) btnToggleQueue.onclick = () => queueToggleCurrent();
const btnQueueSettings = document.getElementById('btnQueueSettings');
const queueSettings = document.getElementById('queueSettings');
if (btnQueueSettings && queueSettings) btnQueueSettings.onclick = () => queueSettings.classList.toggle('open');
const btnQueueCardSettings = document.getElementById('btnQueueCardSettings');
const queueCardSettings = document.getElementById('queueCardSettings');
if (btnQueueCardSettings && queueCardSettings) btnQueueCardSettings.onclick = () => queueCardSettings.classList.toggle('open');
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
  document.removeEventListener('pointerdown', closePkDuoPickerOnPointer, true);
  document.removeEventListener('contextmenu', closePkDuoPickerOnPointer, true);
  document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
}
function escContextMenu(e) { if (e.key === 'Escape') removeContextMenu(); }
function closePkDuoPickerOnPointer(e) {
  const menu = document.querySelector('.pkduo-picker-menu');
  if (!menu || menu.contains(e.target)) return;
  removeContextMenu();
}

// =================== Received gifts (right panel) ===================
const receivedGifts = [];
const RECEIVED_MAX = 200;

function giftTotalCountFromEvent(ev) {
  return ev?.total_count != null ? ev.total_count : ((ev?.gift_count || 1) * (ev?.combo || 1));
}

function giftDiamondPointsFromEvent(ev) {
  if (!ev) return 0;
  if (ev.total_diamond != null) return Math.max(0, Math.round(Number(ev.total_diamond) || 0));
  if (ev.gift_value != null) return Math.max(0, Math.round((Number(ev.gift_value) || 0) * Math.max(1, giftTotalCountFromEvent(ev) || 1)));
  return 0;
}

function addReceivedGift(ev) {
  if (!ev || ev.type !== 'gift') return;
  const total = giftTotalCountFromEvent(ev);
  const diamond = giftDiamondPointsFromEvent(ev);
  receivedGifts.unshift({
    id: 'rg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
    ts: Date.now(),
    user: ev.user || '?',
    avatar: resolveAvatarForUser(ev.user, ev.user_avatar_url),
    gift_name: ev.gift_name || '?',
    gift_id: ev.gift_id,
    gift_icon: ev.gift_icon || ev.gift_icon_url || '',
    count: Math.max(1, total || 1),
    diamond: diamond || null,
    level: ev.level,
    total,
  });
  if (receivedGifts.length > RECEIVED_MAX) receivedGifts.length = RECEIVED_MAX;
  renderReceivedGifts();
  forwardReceivedGiftsSnapshot();
  rankingHandleGift(ev);
  pkDuoHandleGift(ev);
  scoreHandleGift(ev);
}

function renderReceivedGifts() {
  const cont = els.liveGifts;
  if (!cont) return;
  if (receivedGifts.length === 0) {
    cont.innerHTML = '';
    return;
  }
  // Tổng quan: tổng đậu + số quà + số user (hiển thị header trên list)
  const totalDiamond = receivedGifts.reduce((s, g) => s + (g.diamond || 0), 0);
  const totalCount = receivedGifts.reduce((s, g) => s + (g.count || 0), 0);
  const uniqueUsers = new Set(receivedGifts.map(g => g.user)).size;
  cont.innerHTML = `
    <div class="rcv-summary">
      <span title="Tổng đậu nhận được">${beanIconHtml('inline')}<b>${totalDiamond.toLocaleString('en-US')}</b></span>
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
    // Tổng đậu = (đơn giá × số lượng). Tooltip show breakdown nếu có data.
    let beansHtml;
    if (g.diamond != null) {
      const unit = g.count > 0 ? Math.round(g.diamond / g.count) : g.diamond;
      const tooltip = g.count > 1
        ? `${unit.toLocaleString('en-US')} đậu × ${g.count} = ${g.diamond.toLocaleString('en-US')} đậu`
        : `${g.diamond.toLocaleString('en-US')} đậu`;
      beansHtml = `<span class="rcv-beans" title="${escapeHtml(tooltip)}">${beanIconHtml('small')} ${g.diamond.toLocaleString('en-US')}</span>`;
    } else {
      beansHtml = `<span class="rcv-beans rcv-beans-unknown" title="Chưa có dữ liệu đậu trong master">${beanIconHtml('small')} ?</span>`;
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

// Defensive dedup ở renderer (lớp 2). User report: tặng 2 quà liên tiếp chỉ thấy 1.
// Sau khi scraper bỏ hash dedup (rely WeakSet), layer này còn risk drop gifts
// nếu IPC echo cùng event 2 lần. Window CỰC NGẮN (50ms) — đủ catch IPC race
// (~1-10ms) nhưng KHÔNG drop human taps (200ms+).
// Chat giữ 1s (re-rendered chat row legitimately).
const recentEventHashes = new Map();
function shouldDropDuplicate(ev) {
  if (!ev) return false;
  // KHÔNG dedup gift events ở renderer — scraper đã rely WeakMap content-tracking.
  // Drop ở đây gây loss legit gifts (user tặng N → ghi nhận M < N).
  if (ev.type === 'gift') return false;
  if (ev.type !== 'chat' && ev.type !== 'gift_overlay') return false;
  const key = ev.type === 'chat'
    ? `c|${ev.level}|${normEv(ev.user)}|${normEv(ev.content)}`
    : `o|${normEv(ev.user)}|${normEv(ev.gift_name)}|${ev.gift_count || 1}`;
  // Chat lặp 1s thường là DOM re-scan. gift_overlay popup linger 2-3s nên 100ms
  // dedup đủ tránh same-popup re-detect.
  const window = ev.type === 'chat' ? 1000 : 100;
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
    const vipClass = getRowVipClass(ev.badges);
    div.className = `chat-row ${vipClass}`.trim();
    const avUrl = resolveAvatarForUser(ev.user, ev.user_avatar_url);
    const av = avUrl ? `<img class="avatar" src="${escapeHtml(avUrl)}" loading="lazy" style="width:20px;height:20px" />` : '';
    const tier = levelTier(ev.level);
    const lvlText = ev.level ? `Lv.${ev.level}` : 'Lv.?';
    const badgesHtml = renderUserBadges(ev.badges);
    div.innerHTML = `${badgesHtml}${av}<span class="lvl tier-${tier}">${lvlText}</span><span class="who">${escapeHtml(ev.user)}</span><span class="what">${escapeHtml(ev.content)}</span>`;
    // Lưu vào recentChats để popup snapshot khi mở.
    const chatItem = { user: ev.user, level: ev.level, content: ev.content, user_avatar_url: avUrl, badges: ev.badges, ts: Date.now() };
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
    const playTimes = ev.type === 'gift' ? getEffectPlayTimes(ev) : 1;
    // Update session stats (chỉ count gift, không count gift_overlay duplicate)
    if (ev.type === 'gift') {
      sessionStats.giftCount += (ev.gift_count || 1) * (ev.combo || 1);
      sessionStats.diamond += giftDiamondPointsFromEvent(ev);
      if (ev.user) sessionStats.users.add(ev.user);
      if (matched && hasEffectMedia(matched)) {
        sessionStats.effects += playTimes;
      }
      updateConnectStats();
      // Push vào received gifts list (right panel) — layout mới gọn
      addReceivedGift(ev);
      // Gameplay overlay chỉ nhận bản sao event, không tác động queue/effect pipeline.
      forwardGameplayGiftEvent(ev);
    }
    if (ev.type === 'gift' && matched && hasEffectMedia(matched) && matched.overlayId) {
      // Mỗi quà/combo tương ứng 1 hàng hành động. Ví dụ Bell x10 → 10 hàng.
      // BGM pause/resume chạy theo item đang phát trong playQueueItem().
      // Pre-effect: phát ÂM THANH/VIDEO trước MỘT LẦN (không lặp theo combo)
      maybeDispatchPreEffect(matched);
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
    if (ev.viewerCount != null) setLiveViewerCount(ev);
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
  gameplay: { groupId: '', useCommonGroup: true, orientation: 'horizontal', labelPosition: 'bottom', nameMode: 'marquee', cardBg: '#8d8d8d', cardOpacity: 86, textFont: 'Segoe UI', textColor: '#ffffff', slotNumberColor: '#ffffff', countColor: '#ffffff', countSize: 12, uppercase: false, showName: true, showCount: true, iconSize: 54, itemGap: 10, enlargeActive: false, activeScale: 140, centerLargest: false, grayInactive: false, keepScore: false, gridCols: 5, gridRows: 1, gridSlots: [], order: [], hiddenIds: [] },
  ranking: { title: 'Ranking list', memberGroupId: '', rows: [], activeId: '', running: false, linkScoreTimer: true, roundSeconds: 60, streakSeconds: 12, streakColor: '#67e8f9', grayLosers: true, showRank: true, showAvatar: true, showGift: true, showRound: true, hideAllScores: false, rankStart: 1, rankEnd: 20, gridRows: 3, gridCols: 3, gridFlow: 'row', nameMode: 'two-line', overlayBgColor: '#2a2d37', overlayBgOpacity: 74, showVerticalPreview: true, showGridPreview: true, compactPreview: true },
  pkDuo: { running: false, status: 'idle', prepSeconds: 10, delaySeconds: 5, durationSeconds: 60, endsAt: 0, teamA: { name: 'ĐỘI A', content: 'HP Media', color: '#d8587c', giftIds: ['', '', ''] }, teamB: { name: 'ĐỘI B', content: 'HP Media', color: '#6380ff', giftIds: ['', '', ''] }, scoreA: 0, scoreB: 0, joinMode: false, userTeams: {}, bgColor: '#000000', bgOpacity: 88, giftSize: 46, content: 'Vui lòng chờ', textSize: 21, startSound: '', startSoundName: '', warningSound: '', warningSoundName: '', teamASound: '', teamASoundName: '', teamBSound: '', teamBSoundName: '', drawSound: '', drawSoundName: '' },
  scoreVote: { hours: 0, minutes: 3, seconds: 0, delaySeconds: 5, target: 30000, memberGroupId: '', memberId: '', content: 'Kêu gọi điểm ĐẬU', creatorName: 'Creator', creatorAvatar: '', timeColor: '#ffffff', contentColor: '#f0eef6', overColor: '#ff0000', barColor1: '#b93678', barColor2: '#ff8ed1', waveColor: '#ffffff', bigGiftThreshold: 500, prepSeconds: 3, themePreset: 'custom', barStyle: 'pill', overlaySize: 'medium', customMilestones: '', showGiftUser: true, showMissing: true, showTopUsers: true, showSpeed: true, compactMode: false, hideAvatar: false, hideCreator: false, startSound: '', startSoundName: '', warningSound: '', warningSoundName: '', goalSound: '', goalSoundName: '', successSound: '', successSoundName: '', failSound: '', failSoundName: '' },
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
  members: [],
  fxVolume: 100,
  maxListItems: 200,
};

async function saveAppSettings(patch) {
  const s = await window.bigo.settingsLoad();
  if (patch) {
    if (patch.bgm) s.bgm = { ...(s.bgm || {}), ...patch.bgm };
    if (patch.preFx) s.preFx = { ...(s.preFx || {}), ...patch.preFx };
    if (patch.gameplay) s.gameplay = { ...(s.gameplay || {}), ...patch.gameplay };
    if (patch.ranking) s.ranking = { ...(s.ranking || {}), ...patch.ranking };
    if (patch.pkDuo) s.pkDuo = { ...(s.pkDuo || {}), ...patch.pkDuo };
    if (patch.scoreVote) s.scoreVote = { ...(s.scoreVote || {}), ...patch.scoreVote };
    if (patch.members) s.members = Array.isArray(patch.members) ? patch.members : [];
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
  appSettings.gameplay = { ...appSettings.gameplay, ...(s.gameplay || {}) };
  appSettings.ranking = { ...appSettings.ranking, ...(s.ranking || {}) };
  appSettings.ranking.rows = Array.isArray(appSettings.ranking.rows) ? appSettings.ranking.rows : [];
  appSettings.pkDuo = { ...appSettings.pkDuo, ...(s.pkDuo || {}) };
  appSettings.scoreVote = { ...appSettings.scoreVote, ...(s.scoreVote || {}) };
  appSettings.members = Array.isArray(s.members) ? s.members : [];
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
  renderMembersList();
  applyRankingSettingsUi();
  applyScoreSettingsUi();
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
    const ok = await appConfirm({
      title: 'Xoá âm thanh phát trước?',
      message: 'Xoá file âm thanh/video phát trước hiệu ứng?',
      detail: 'Chỉ xoá liên kết trong app, không xoá file gốc trên máy.',
      okText: 'Có, xoá',
      cancelText: 'Không',
      danger: true,
    });
    if (!ok) return;
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
  arr = prioritizeVnGifts(sortMasterArr(arr, sortVal));
  const renderLimit = 200;
  if (count) count.textContent = `${arr.length} kết quả`;
  if (body) {
    body.innerHTML = arr.slice(0, renderLimit).map(g => {
      const iconUrl = g.localIcon || g.img_url || '';
      const isFav = giftFavorites.has(g.typeid);
      const vnBadge = isVnGift(g) ? `<span class="vn-badge" title="Quà có trong danh mục khu vực Việt Nam">🇻🇳 VN</span>` : '';
      return `<tr data-typeid="${g.typeid}" data-name="${escapeHtml(g.name)}" data-icon="${escapeHtml(iconUrl)}">
        <td>${iconUrl ? `<img src="${escapeHtml(iconUrl)}" style="width:32px;height:32px;object-fit:contain" />` : ''}</td>
        <td><span class="id">${g.typeid}</span></td>
      <td><span class="price">${beanIconHtml('small')} ${g.diamonds ?? '?'}</span></td>
        <td><span class="name">${escapeHtml(g.name)} ${vnBadge}</span></td>
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
    const overlays = mapping?.overlays || [];
    if (overlays.length) {
      ovEl.innerHTML = overlays.map(o =>
        `<option value="${o.id}"${cfg.overlayId === o.id ? ' selected' : ''}>${escapeHtml(o.name)}</option>`
      ).join('');
      // Auto-select first overlay nếu cfg chưa set
      if (!cfg.overlayId && overlays[0]) {
        appSettings.specialEffects.heartGoal.overlayId = overlays[0].id;
        ovEl.value = overlays[0].id;
      }
    } else {
      ovEl.innerHTML = '<option value="">(chưa có overlay)</option>';
    }
  }
  // Color pickers — load saved values
  const colorMap = { seHeartRingColor: cfg.ringColor || '#4a8ef7',
                     seHeartRingComplete: cfg.ringComplete || '#4ad07a',
                     seHeartTextColor: cfg.textColor || '#ffffff' };
  for (const [id, val] of Object.entries(colorMap)) {
    const el = document.getElementById(id);
    if (el) el.value = val;
  }
}

function bumpHeartCount(n = 1) {
  const cfg = appSettings.specialEffects.heartGoal;
  if (!cfg || !cfg.enabled) return;
  cfg.currentCount = (cfg.currentCount || 0) + n;
  const countEl = document.getElementById('seHeartCount');
  if (countEl) countEl.textContent = cfg.currentCount;
  // Update vòng tròn overlay nếu đang mở
  pushHeartOverlayUpdate();
  if (cfg.currentCount >= (cfg.target || 100)) {
    appendLog(`[se:heartGoal] Đạt ${cfg.currentCount}/${cfg.target} tym → phát media`);
    if (cfg.mediaFile && cfg.overlayId) {
      const payload = resolveMediaPayload(cfg.mediaFile);
      window.bigo.overlayPlay({ overlayId: cfg.overlayId, ...payload }).catch(() => {});
    }
    // Hold complete state 2.5s rồi reset (cho overlay show animation)
    setTimeout(() => {
      cfg.currentCount = 0;
      if (countEl) countEl.textContent = 0;
      saveAppSettings({ specialEffects: { heartGoal: { currentCount: 0 } } });
      pushHeartOverlayUpdate();
    }, 2500);
  }
}

// Gửi update tới heart overlay window (nếu đang mở).
function pushHeartOverlayUpdate() {
  if (!window.bigo.heartOverlayUpdate) return;
  const cfg = appSettings.specialEffects?.heartGoal || {};
  window.bigo.heartOverlayUpdate({
    current: cfg.currentCount || 0,
    target: cfg.target || 100,
    config: {
      ringColor: cfg.ringColor || '#4a8ef7',
      ringBg: cfg.ringBg || '#3a3f4b',
      ringComplete: cfg.ringComplete || '#4ad07a',
      textColor: cfg.textColor || '#ffffff',
    },
  }).catch(() => {});
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
    pushHeartOverlayUpdate();
  };
  // +10 Test button: bump counter để test vòng tròn overlay khi chưa có heart event thật.
  const testBtn = document.getElementById('btnHeartTest');
  if (testBtn) testBtn.onclick = () => {
    if (!appSettings.specialEffects.heartGoal.enabled) {
      appSettings.specialEffects.heartGoal.enabled = true;
      const enEl = document.getElementById('seHeartEnabled');
      if (enEl) enEl.checked = true;
      saveAppSettings({ specialEffects: { heartGoal: { enabled: true } } });
    }
    bumpHeartCount(10);
  };
  // Show/Hide overlay window
  const showOvBtn = document.getElementById('btnHeartOverlayShow');
  const hideOvBtn = document.getElementById('btnHeartOverlayHide');
  if (showOvBtn) showOvBtn.onclick = async () => {
    if (window.bigo.heartOverlayShow) await window.bigo.heartOverlayShow();
    pushHeartOverlayUpdate(); // sync state ngay
  };
  if (hideOvBtn) hideOvBtn.onclick = () => {
    if (window.bigo.heartOverlayHide) window.bigo.heartOverlayHide();
  };
  // Color pickers — save + update overlay realtime
  for (const [id, key] of [['seHeartRingColor','ringColor'],['seHeartRingComplete','ringComplete'],['seHeartTextColor','textColor']]) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener('input', () => {
      appSettings.specialEffects.heartGoal[key] = el.value;
      pushHeartOverlayUpdate();
    });
    el.addEventListener('change', () => {
      saveAppSettings({ specialEffects: { heartGoal: { [key]: el.value } } });
    });
  }
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
    const ok = await appConfirm({
      title: 'Xoá nhạc nền?',
      message: 'Xoá file nhạc nền đang chọn?',
      detail: 'Chỉ xoá liên kết trong app, không xoá file gốc trên máy.',
      okText: 'Có, xoá',
      cancelText: 'Không',
      danger: true,
    });
    if (!ok) return;
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

function normalizeMember(member = {}) {
  return {
    id: member.id || `mem_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name: String(member.name || '').trim(),
    avatar: String(member.avatar || '').trim(),
  };
}

function clearMemberForm() {
  if (els.memberEditId) els.memberEditId.value = '';
  if (els.memberName) els.memberName.value = '';
  if (els.memberAvatar) els.memberAvatar.value = '';
  if (els.btnMemberSave) els.btnMemberSave.textContent = '+ Lưu thành viên';
}

async function persistMembers() {
  appSettings.members = (appSettings.members || []).map(normalizeMember).filter(m => m.name);
  await saveAppSettings({ members: appSettings.members });
  renderMembersList();
}

function renderMembersList() {
  if (!els.membersList) return;
  const members = Array.isArray(appSettings.members) ? appSettings.members : [];
  if (!members.length) {
    els.membersList.innerHTML = '<div class="score-log-empty">Chưa có thành viên nào. Có thể bỏ trống, không ảnh hưởng các tính năng hiện tại.</div>';
    return;
  }
  els.membersList.innerHTML = members.map(member => {
    const item = normalizeMember(member);
    const avatar = item.avatar ? `<img src="${escapeHtml(item.avatar)}" loading="lazy" />` : '👤';
    return `<div class="member-row" data-id="${escapeHtml(item.id)}">
      <div class="member-avatar">${avatar}</div>
      <div class="member-main"><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.avatar || 'Chưa có avatar')}</small></div>
      <button type="button" class="tiny" data-member-edit="${escapeHtml(item.id)}">Sửa</button>
      <button type="button" class="tiny danger" data-member-delete="${escapeHtml(item.id)}">Xoá</button>
    </div>`;
  }).join('');
}

function getMemberById(id) {
  return (appSettings.members || []).find(m => m.id === id) || null;
}

function getGroupMembers(group) {
  const ids = Array.isArray(group?.memberIds) ? group.memberIds : [];
  return ids.map(getMemberById).filter(Boolean);
}

function renderGroupMemberPicker(group) {
  const box = document.getElementById('grpDlgMembers');
  if (!box) return;
  const members = Array.isArray(appSettings.members) ? appSettings.members : [];
  if (!members.length) {
    box.innerHTML = '<div class="group-member-empty">Chưa có thành viên. Tạo ở Cài đặt chung → THÀNH VIÊN.</div>';
    return;
  }
  const selected = new Set(Array.isArray(group?.memberIds) ? group.memberIds : []);
  box.innerHTML = members.map(member => {
    const item = normalizeMember(member);
    const avatar = item.avatar ? `<img src="${escapeHtml(item.avatar)}" loading="lazy" />` : '👤';
    return `<label class="group-member-option">
      <input type="checkbox" value="${escapeHtml(item.id)}" ${selected.has(item.id) ? 'checked' : ''} />
      <span class="group-member-avatar">${avatar}</span>
      <span class="group-member-name">${escapeHtml(item.name)}</span>
    </label>`;
  }).join('');
}

function renderScoreMemberSelectors() {
  if (!els.scoreMemberGroup || !els.scoreMember) return;
  const groups = (mapping.groups || []).filter(g => !g.isCommon && getGroupMembers(g).length);
  const currentGroupId = els.scoreMemberGroup.value || appSettings.scoreVote?.memberGroupId || '';
  els.scoreMemberGroup.innerHTML = '<option value="">Không chọn nhóm</option>' + groups.map(g => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.name)} (${getGroupMembers(g).length})</option>`).join('');
  if (groups.some(g => g.id === currentGroupId)) els.scoreMemberGroup.value = currentGroupId;
  const group = (mapping.groups || []).find(g => g.id === els.scoreMemberGroup.value);
  const members = group ? getGroupMembers(group) : [];
  const currentMemberId = els.scoreMember.value || appSettings.scoreVote?.memberId || '';
  els.scoreMember.innerHTML = '<option value="">Không chọn thành viên</option>' + members.map(m => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`).join('');
  if (members.some(m => m.id === currentMemberId)) els.scoreMember.value = currentMemberId;
}

function applyScoreSelectedMember() {
  if (!els.scoreMember) return;
  const member = getMemberById(els.scoreMember.value);
  if (!member) return;
  if (els.scoreCreatorName) els.scoreCreatorName.value = member.name || '';
  if (els.scoreCreatorAvatar) els.scoreCreatorAvatar.value = member.avatar || '';
  persistScoreConfig();
}

async function saveMemberFromForm() {
  const name = String(els.memberName?.value || '').trim();
  if (!name) { alert('Tên Creator không được trống'); return; }
  const id = String(els.memberEditId?.value || '').trim() || `mem_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const avatar = String(els.memberAvatar?.value || '').trim();
  const members = Array.isArray(appSettings.members) ? [...appSettings.members] : [];
  const idx = members.findIndex(m => m.id === id);
  const next = normalizeMember({ id, name, avatar });
  if (idx >= 0) members[idx] = next;
  else members.push(next);
  appSettings.members = members;
  await persistMembers();
  renderScoreMemberSelectors();
  clearMemberForm();
}

if (els.btnMemberPickAvatar) {
  els.btnMemberPickAvatar.onclick = async () => {
    const r = await window.bigo.effectsPickFiles();
    if (!r.ok || !r.files?.length) return;
    const picked = r.files[0];
    if (els.memberAvatar) els.memberAvatar.value = picked.fileUrl || picked.file || '';
  };
}
if (els.btnMemberClearForm) els.btnMemberClearForm.onclick = clearMemberForm;
if (els.btnMemberSave) els.btnMemberSave.onclick = () => saveMemberFromForm().catch(e => alert('Lỗi lưu thành viên: ' + e.message));
if (els.membersList) {
  els.membersList.onclick = async (e) => {
    const editBtn = e.target.closest('[data-member-edit]');
    const delBtn = e.target.closest('[data-member-delete]');
    if (editBtn) {
      const member = (appSettings.members || []).find(m => m.id === editBtn.dataset.memberEdit);
      if (!member) return;
      if (els.memberEditId) els.memberEditId.value = member.id;
      if (els.memberName) els.memberName.value = member.name || '';
      if (els.memberAvatar) els.memberAvatar.value = member.avatar || '';
      if (els.btnMemberSave) els.btnMemberSave.textContent = 'Lưu thay đổi';
      return;
    }
    if (delBtn) {
      const ok = await appConfirm({ title: 'Xoá thành viên?', message: 'Xoá thành viên này khỏi danh sách?', okText: 'Xoá', cancelText: 'Không', danger: true });
      if (!ok) return;
      appSettings.members = (appSettings.members || []).filter(m => m.id !== delBtn.dataset.memberDelete);
      (mapping.groups || []).forEach(g => {
        if (Array.isArray(g.memberIds)) g.memberIds = g.memberIds.filter(id => id !== delBtn.dataset.memberDelete);
      });
      await persistMapping();
      await persistMembers();
      renderScoreMemberSelectors();
      renderRankingMemberSelectors();
      clearMemberForm();
    }
  };
}

// =================== Bảng xếp hạng (BXH) ===================
let rankingTimer = null;
let rankingGridSuggestSource = 'cols';

function rankingEls() {
  return {
    memberGroup: $('rankingMemberGroup'), member: $('rankingMember'), rows: $('rankingRows'), preview: $('rankingPreview'), gridPreview: $('rankingGridPreview'), verticalPreviewSection: $('rankingVerticalPreviewSection'), gridPreviewSection: $('rankingGridPreviewSection'),
    title: $('rankingTitle'), manualName: $('rankingManualName'), manualAvatar: $('rankingManualAvatar'), roundSeconds: $('rankingRoundSeconds'),
    streakSeconds: $('rankingStreakSeconds'), streakColor: $('rankingStreakColor'), grayLosers: $('rankingGrayLosers'),
    showRank: $('rankingShowRank'), showAvatar: $('rankingShowAvatar'), showGift: $('rankingShowGift'), showRound: $('rankingShowRound'), hideAllScores: $('rankingHideAllScores'), linkScoreTimer: $('rankingLinkScoreTimer'), rankStart: $('rankingRankStart'), rankEnd: $('rankingRankEnd'), nameMode: $('rankingNameMode'), overlayBgColor: $('rankingOverlayBgColor'), overlayBgOpacity: $('rankingOverlayBgOpacity'), overlayBgOpacityVal: $('rankingOverlayBgOpacityVal'),
    gridRows: $('rankingGridRows'), gridCols: $('rankingGridCols'), gridFlow: $('rankingGridFlow'), gridRowsHint: $('rankingGridRowsHint'), gridColsHint: $('rankingGridColsHint'), gridSuggestionText: $('rankingGridSuggestionText'), btnGridApply: $('btnRankingGridApply'), btnGridUseSuggestion: $('btnRankingGridUseSuggestion'),
    showVerticalPreview: $('rankingShowVerticalPreview'), showGridPreview: $('rankingShowGridPreview'), compactPreview: $('rankingCompactPreview'),
    btnAddMember: $('btnRankingAddMember'), btnAddManual: $('btnRankingAddManual'), btnSave: $('btnRankingSave'), btnCopyUrl: $('btnRankingCopyUrl'), btnGridCopyUrl: $('btnRankingGridCopyUrl'),
    btnStartRound: $('btnRankingStartRound'), btnStopRound: $('btnRankingStopRound'), btnReset: $('btnRankingReset'),
  };
}

function normalizeRankingRow(row = {}) {
  return {
    id: row.id || uid('rank_'),
    memberGroupId: row.memberGroupId || '',
    memberId: row.memberId || '',
    name: String(row.name || '').trim() || 'Idol',
    avatar: String(row.avatar || '').trim(),
    points: Math.max(0, Math.round(Number(row.points) || 0)),
    giftItemId: row.giftItemId || '',
    giftName: row.giftName || '',
    giftIcon: row.giftIcon || '',
    giftIconId: row.giftIconId || '',
    round: Math.max(0, Math.round(Number(row.round) || 0)),
    activePoints: Math.max(0, Math.round(Number(row.activePoints) || 0)),
    hideScore: !!row.hideScore,
    lost: !!row.lost,
    excludeOverlay: !!row.excludeOverlay,
    settingsOpen: !!row.settingsOpen,
    streakText: row.streakText || '',
    streakUntil: Math.max(0, Number(row.streakUntil) || 0),
  };
}

function rankingConfig() {
  const r = appSettings.ranking || {};
  return {
    memberGroupId: String(r.memberGroupId || '').trim(),
    title: String(r.title || 'Ranking list').trim() || 'Ranking list',
    rows: (r.rows || []).map(normalizeRankingRow),
    activeId: String(r.activeId || '').trim(),
    running: !!r.running,
    linkScoreTimer: r.linkScoreTimer !== false,
    roundSeconds: Math.max(5, Math.min(7200, parseInt(r.roundSeconds, 10) || 60)),
    streakSeconds: Math.max(1, Math.min(300, parseInt(r.streakSeconds, 10) || 12)),
    streakColor: /^#[0-9a-f]{6}$/i.test(String(r.streakColor || '')) ? r.streakColor : '#67e8f9',
    grayLosers: r.grayLosers !== false,
    showRank: r.showRank !== false,
    showAvatar: r.showAvatar !== false,
    showGift: r.showGift !== false,
    showRound: r.showRound !== false,
    hideAllScores: !!r.hideAllScores,
    rankStart: Math.max(0, parseInt(r.rankStart, 10) || 0),
    rankEnd: Math.max(0, Math.min(100, parseInt(r.rankEnd ?? r.rankLimit, 10) || 0)),
    gridRows: Math.max(1, Math.min(20, parseInt(r.gridRows, 10) || 3)),
    gridCols: Math.max(1, Math.min(10, parseInt(r.gridCols, 10) || 3)),
    gridFlow: r.gridFlow === 'column' ? 'column' : 'row',
    nameMode: r.nameMode === 'marquee' ? 'marquee' : 'two-line',
    overlayBgColor: /^#[0-9a-f]{6}$/i.test(String(r.overlayBgColor || '')) ? r.overlayBgColor : '#2a2d37',
    overlayBgOpacity: Math.max(0, Math.min(100, parseInt(r.overlayBgOpacity, 10) || 74)),
    showVerticalPreview: r.showVerticalPreview !== false,
    showGridPreview: r.showGridPreview !== false,
    compactPreview: r.compactPreview !== false,
    roundEndsAt: Math.max(0, Number(r.roundEndsAt) || 0),
  };
}

function rankingNextCreatorName() {
  const rows = (appSettings.ranking?.rows || []).map(normalizeRankingRow);
  const maxNamed = rows.reduce((max, row) => {
    const m = String(row.name || '').trim().match(/^(?:HP Media|New Creator)\s+(\d+)$/i);
    return m ? Math.max(max, parseInt(m[1], 10) || 0) : max;
  }, 0);
  return `HP Media ${Math.max(maxNamed + 1, rows.length + 1)}`;
}

function rankingHexToRgb(hex, fallback = '42,45,55') {
  const m = String(hex || '').trim().match(/^#([0-9a-f]{6})$/i);
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}

function rankingGridSuggestion() {
  const cfg = rankingConfig();
  const totalRows = rankingSortedRows(cfg.rows.filter(row => !row.excludeOverlay)).length;
  const start = Math.max(1, cfg.rankStart || 1);
  const end = cfg.rankEnd > 0 ? Math.max(start, cfg.rankEnd) : totalRows;
  const total = Math.max(1, Math.min(totalRows, end) - start + 1);
  const currentRows = Math.max(1, Math.min(20, parseInt(cfg.gridRows, 10) || 1));
  const currentCols = Math.max(1, Math.min(10, parseInt(cfg.gridCols, 10) || 1));
  const rows = rankingGridSuggestSource === 'rows' ? currentRows : Math.max(1, Math.min(20, Math.ceil(total / currentCols)));
  const cols = rankingGridSuggestSource === 'rows' ? Math.max(1, Math.min(10, Math.ceil(total / currentRows))) : currentCols;
  return {
    rows,
    cols,
    total,
  };
}

function updateRankingGridSuggestionUi() {
  const el = rankingEls();
  const s = rankingGridSuggestion();
  if (el.gridRowsHint) el.gridRowsHint.textContent = `(${s.rows})`;
  if (el.gridColsHint) el.gridColsHint.textContent = `(${s.cols})`;
  if (el.gridSuggestionText) el.gridSuggestionText.textContent = `Đề xuất theo ${s.total} creator: nếu giữ số cột hiện tại thì ${s.rows} hàng; nếu giữ số hàng hiện tại thì ${s.cols} cột.`;
}

function rankingGiftItems() {
  return prioritizeVnGifts(getAllItems().filter(item => item.type !== 'comment'), isVnMappingItem);
}

function rankingGiftInfo(itemId) {
  const found = findItemById(itemId)?.item;
  if (!found) return { giftName: '', giftIcon: '', giftIconId: '' };
  return { giftName: getGameplayItemName(found), giftIcon: getGameplayItemIcon(found), giftIconId: getGameplayItemIconId(found) };
}

function rankingGiftMatches(row, ev) {
  if (!row.giftItemId || !ev) return false;
  const found = findItemById(row.giftItemId)?.item;
  if (!found) return false;
  return itemMatchesGameplayGift(found, ev);
}

function rankingInitials(name) {
  return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(s => s[0]).join('').toUpperCase() || '?';
}

function rankingSortedRows(rows = rankingConfig().rows) {
  return [...rows].sort((a, b) => b.points - a.points || b.activePoints - a.activePoints || a.name.localeCompare(b.name));
}

function rankingPublicState() {
  const cfg = rankingConfig();
  const now = Date.now();
  const rowsAll = rankingSortedRows(cfg.rows.filter(row => !row.excludeOverlay)).map((row, idx) => ({
    ...row,
    rank: idx + 1,
    initials: rankingInitials(row.name),
    active: row.id === cfg.activeId,
    streakText: row.streakUntil > now ? row.streakText : '',
  }));
  const start = Math.max(1, cfg.rankStart || 1);
  const end = cfg.rankEnd > 0 ? Math.max(start, cfg.rankEnd) : rowsAll.length;
  const rows = rowsAll.slice(start - 1, end);
  const active = rowsAll.find(r => r.active) || null;
  return { ...cfg, rows, totalRows: rowsAll.length, active, remainingMs: cfg.roundEndsAt ? Math.max(0, cfg.roundEndsAt - now) : 0 };
}

function renderRankingMemberSelectors() {
  const el = rankingEls();
  if (!el.memberGroup || !el.member) return;
  const groups = (mapping.groups || []).filter(g => !g.isCommon && getGroupMembers(g).length);
  const currentGroupId = el.memberGroup.value || appSettings.ranking?.memberGroupId || '';
  el.memberGroup.innerHTML = '<option value="">Không chọn nhóm</option>' + groups.map(g => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.name)} (${getGroupMembers(g).length})</option>`).join('');
  if (groups.some(g => g.id === currentGroupId)) el.memberGroup.value = currentGroupId;
  const group = (mapping.groups || []).find(g => g.id === el.memberGroup.value);
  const members = group ? getGroupMembers(group) : [];
  el.member.innerHTML = '<option value="">Không chọn thành viên</option>' + members.map(m => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`).join('');
}

function applyRankingSettingsUi() {
  const cfg = rankingConfig();
  appSettings.ranking = { ...appSettings.ranking, ...cfg };
  const el = rankingEls();
  renderRankingMemberSelectors();
  if (el.memberGroup) el.memberGroup.value = cfg.memberGroupId || '';
  renderRankingMemberSelectors();
  if (el.roundSeconds) el.roundSeconds.value = cfg.roundSeconds;
  if (el.title) el.title.value = cfg.title;
  if (el.streakSeconds) el.streakSeconds.value = cfg.streakSeconds;
  if (el.streakColor) el.streakColor.value = cfg.streakColor;
  if (el.grayLosers) el.grayLosers.checked = cfg.grayLosers;
  if (el.showRank) el.showRank.checked = cfg.showRank;
  if (el.showAvatar) el.showAvatar.checked = cfg.showAvatar;
  if (el.showGift) el.showGift.checked = cfg.showGift;
  if (el.showRound) el.showRound.checked = cfg.showRound;
  if (el.hideAllScores) el.hideAllScores.checked = cfg.hideAllScores;
  if (el.linkScoreTimer) el.linkScoreTimer.checked = cfg.linkScoreTimer;
  if (el.rankStart) el.rankStart.value = cfg.rankStart;
  if (el.rankEnd) el.rankEnd.value = cfg.rankEnd;
  if (el.gridRows) el.gridRows.value = cfg.gridRows;
  if (el.gridCols) el.gridCols.value = cfg.gridCols;
  if (el.gridFlow) el.gridFlow.value = cfg.gridFlow;
  if (el.nameMode) el.nameMode.value = cfg.nameMode;
  if (el.overlayBgColor) el.overlayBgColor.value = cfg.overlayBgColor;
  if (el.overlayBgOpacity) el.overlayBgOpacity.value = cfg.overlayBgOpacity;
  if (el.overlayBgOpacityVal) el.overlayBgOpacityVal.textContent = `${cfg.overlayBgOpacity}%`;
  if (el.showVerticalPreview) el.showVerticalPreview.checked = cfg.showVerticalPreview;
  if (el.showGridPreview) el.showGridPreview.checked = cfg.showGridPreview;
  if (el.compactPreview) el.compactPreview.checked = cfg.compactPreview;
  updateRankingGridSuggestionUi();
  if (cfg.roundEndsAt > Date.now() && !rankingTimer) rankingTimer = setInterval(rankingTick, 500);
  renderRankingEditor();
  pushRankingState();
}

function persistRankingConfig() {
  const el = rankingEls();
  appSettings.ranking = {
    ...appSettings.ranking,
    memberGroupId: el.memberGroup?.value || '',
    title: String(el.title?.value || 'Ranking list').trim() || 'Ranking list',
    roundSeconds: Math.max(5, Math.min(7200, parseInt(el.roundSeconds?.value, 10) || 60)),
    streakSeconds: Math.max(1, Math.min(300, parseInt(el.streakSeconds?.value, 10) || 12)),
    streakColor: el.streakColor?.value || '#67e8f9',
    grayLosers: el.grayLosers ? el.grayLosers.checked : true,
    showRank: el.showRank ? el.showRank.checked : true,
    showAvatar: el.showAvatar ? el.showAvatar.checked : true,
    showGift: el.showGift ? el.showGift.checked : true,
    showRound: el.showRound ? el.showRound.checked : true,
    hideAllScores: el.hideAllScores ? el.hideAllScores.checked : false,
    linkScoreTimer: el.linkScoreTimer ? el.linkScoreTimer.checked : true,
    rankStart: Math.max(0, parseInt(el.rankStart?.value, 10) || 0),
    rankEnd: Math.max(0, Math.min(100, parseInt(el.rankEnd?.value, 10) || 0)),
    gridRows: Math.max(1, Math.min(20, parseInt(el.gridRows?.value, 10) || 3)),
    gridCols: Math.max(1, Math.min(10, parseInt(el.gridCols?.value, 10) || 3)),
    gridFlow: el.gridFlow?.value === 'column' ? 'column' : 'row',
    nameMode: el.nameMode?.value === 'marquee' ? 'marquee' : 'two-line',
    overlayBgColor: /^#[0-9a-f]{6}$/i.test(String(el.overlayBgColor?.value || '')) ? el.overlayBgColor.value : '#2a2d37',
    overlayBgOpacity: Math.max(0, Math.min(100, parseInt(el.overlayBgOpacity?.value, 10) || 0)),
    showVerticalPreview: el.showVerticalPreview ? el.showVerticalPreview.checked : true,
    showGridPreview: el.showGridPreview ? el.showGridPreview.checked : true,
    compactPreview: el.compactPreview ? el.compactPreview.checked : true,
  };
  saveAppSettings({ ranking: appSettings.ranking }).catch(() => {});
  updateRankingGridSuggestionUi();
  pushRankingState();
}

function pushRankingState() {
  const state = rankingPublicState();
  renderRankingPreview(state);
  renderRankingGridPreview(state);
  updateRankingPreviewVisibility(state);
  updateRankingButtons(state);
  if (window.bigo?.rankingUpdate) window.bigo.rankingUpdate(state).catch(() => {});
}

function updateRankingPreviewVisibility(state = rankingPublicState()) {
  const el = rankingEls();
  if (el.verticalPreviewSection) el.verticalPreviewSection.hidden = state.showVerticalPreview === false;
  if (el.gridPreviewSection) el.gridPreviewSection.hidden = state.showGridPreview === false;
  if (el.preview) el.preview.classList.toggle('compact', state.compactPreview !== false);
  if (el.gridPreview) el.gridPreview.classList.toggle('compact', state.compactPreview !== false);
}

function updateRankingButtons(state = rankingPublicState()) {
  const el = rankingEls();
  if (el.btnStartRound) {
    el.btnStartRound.textContent = state.running ? 'KẾT THÚC' : 'BẮT ĐẦU';
    el.btnStartRound.classList.toggle('danger', !!state.running);
  }
  if (el.btnStopRound) el.btnStopRound.style.display = 'none';
  if (el.linkScoreTimer) el.linkScoreTimer.disabled = !!state.running;
}

function rankingGiftOptions(selectedId = '') {
  return '<option value="">Chọn quà</option>' + rankingGiftItems().map(item => {
    const name = getGameplayItemName(item);
    const prefix = isVnMappingItem(item) ? 'VN - ' : '';
    return `<option value="${escapeHtml(item.id)}" ${item.id === selectedId ? 'selected' : ''}>${escapeHtml(prefix + name)}</option>`;
  }).join('');
}

function rankingMemberGroupOptions(selectedId = '') {
  const groups = (mapping.groups || []).filter(g => !g.isCommon && getGroupMembers(g).length);
  return '<option value="">Chọn nhóm</option>' + groups.map(g => `<option value="${escapeHtml(g.id)}" ${g.id === selectedId ? 'selected' : ''}>${escapeHtml(g.name)} (${getGroupMembers(g).length})</option>`).join('');
}

function rankingMemberOptions(groupId = '', selectedId = '') {
  const group = (mapping.groups || []).find(g => g.id === groupId);
  const members = group ? getGroupMembers(group) : [];
  return '<option value="">Chọn thành viên</option>' + members.map(m => `<option value="${escapeHtml(m.id)}" ${m.id === selectedId ? 'selected' : ''}>${escapeHtml(m.name)}</option>`).join('');
}

function renderRankingEditor() {
  const el = rankingEls();
  if (!el.rows) return;
  const rows = rankingSortedRows(rankingConfig().rows);
  if (!rows.length) {
    el.rows.innerHTML = '<div class="score-log-empty">Chưa có idol nào trong BXH.</div>';
    return;
  }
  el.rows.innerHTML = rows.map(row => {
    const active = row.id === appSettings.ranking.activeId;
    const badges = [active ? 'VOTE' : '', row.lost ? 'THUA' : '', row.hideScore ? 'Ẩn điểm' : '', row.excludeOverlay ? 'Ẩn OBS' : ''].filter(Boolean).map(t => `<span>${escapeHtml(t)}</span>`).join('');
    return `<div class="ranking-editor-row ${active ? 'active' : ''} ${row.lost ? 'lost' : ''}" data-rank-id="${escapeHtml(row.id)}">
      <div class="ranking-editor-summary">
        <div class="ranking-editor-avatar">${row.avatar ? `<img src="${escapeHtml(row.avatar)}" loading="lazy" />` : escapeHtml(rankingInitials(row.name))}</div>
        <div class="ranking-summary-main"><b>${escapeHtml(row.name)}</b><small>${Number(row.points || 0).toLocaleString('en-US')} Đậu · R${Number(row.round || 0)}</small></div>
        <div class="ranking-summary-gift">${row.giftIcon ? `<img src="${escapeHtml(row.giftIcon)}" loading="lazy" />` : '🎁'}<span>${escapeHtml(row.giftName || 'Chưa chọn quà')}</span></div>
        <label class="ranking-summary-vote"><span>VOTE</span><input data-rank-active type="checkbox" ${active ? 'checked' : ''} /></label>
        <div class="ranking-summary-badges">${badges}</div>
        <button type="button" class="tiny" data-rank-toggle-settings>${row.settingsOpen ? 'Ẩn cài đặt' : 'Cài đặt'}</button>
        <button type="button" class="tiny danger" data-rank-delete>Xoá</button>
      </div>
      <div class="ranking-editor-details" ${row.settingsOpen ? '' : 'hidden'}>
      <div class="ranking-editor-mainline">
        <label>Chọn thành viên<select data-rank-group>${rankingMemberGroupOptions(row.memberGroupId)}</select></label>
        <label>Thành viên<select data-rank-member>${rankingMemberOptions(row.memberGroupId, row.memberId)}</select></label>
        <div class="ranking-editor-avatar">${row.avatar ? `<img src="${escapeHtml(row.avatar)}" loading="lazy" />` : escapeHtml(rankingInitials(row.name))}</div>
        <label>Tên thành viên<input class="ranking-name-input" data-rank-name value="${escapeHtml(row.name)}" /></label>
        <label>Quà tặng<div class="ranking-gift-select-row"><span class="ranking-editor-gift-icon">${row.giftIcon ? `<img src="${escapeHtml(row.giftIcon)}" loading="lazy" />` : '🎁'}</span><select data-rank-gift>${rankingGiftOptions(row.giftItemId)}</select></div></label>
        <button type="button" class="tiny danger" data-rank-delete>Xoá</button>
      </div>
      <div class="ranking-editor-subline">
        <label>Điểm Đậu<input data-rank-points type="number" min="0" value="${row.points}" /></label>
        <label class="ranking-round-edit">Round<input data-rank-round type="number" min="0" value="${row.round}" /></label>
        <label class="ranking-toggle"><span>Ẩn điểm</span><input data-rank-hide-score type="checkbox" ${row.hideScore ? 'checked' : ''} /></label>
        <label class="ranking-toggle vote"><span>VOTE</span><input data-rank-active type="checkbox" ${active ? 'checked' : ''} /></label>
        <label class="ranking-toggle lost"><span>THUA</span><input data-rank-lost type="checkbox" ${row.lost ? 'checked' : ''} /></label>
        <label class="ranking-toggle"><span>Ẩn OBS</span><input data-rank-exclude-overlay type="checkbox" ${row.excludeOverlay ? 'checked' : ''} /></label>
      </div>
      </div>
    </div>`;
  }).join('');
}

function renderRankingPreview(state = rankingPublicState()) {
  const el = rankingEls();
  if (!el.preview) return;
  el.preview.innerHTML = rankingBoardHtml(state);
}

function rankingNameHtml(name, className) {
  const text = String(name || 'Idol');
  const longClass = text.length > 12 ? ' long' : '';
  return `<div class="${className}${longClass}" title="${escapeHtml(text)}"><span>${escapeHtml(text)}</span></div>`;
}

function renderRankingGridPreview(state = rankingPublicState()) {
  const el = rankingEls();
  if (!el.gridPreview) return;
  el.gridPreview.innerHTML = rankingGridBoardHtml(state);
}

function rankingBoardHtml(state) {
  const rows = state.rows || [];
  const maxPoints = rows.length ? Math.max(...rows.map(r => r.points || 0)) : 0;
  const loserClass = state.grayLosers ? ' gray-losers' : '';
  const compactClass = `${state.showRank === false ? ' hide-rank' : ''}${state.showAvatar === false ? ' hide-avatar' : ''}${state.showGift === false ? ' hide-gift' : ''}${state.showRound === false ? ' hide-round' : ''}`;
  const activeName = state.active ? escapeHtml(state.active.name) : '';
  const activePoints = state.active ? Number(state.active.points || 0).toLocaleString('en-US') : '';
  const activeLong = state.active && `${state.active.name || ''} ${activePoints}`.length > 18;
  return `<div class="ranking-board${loserClass}${compactClass} name-${state.nameMode === 'marquee' ? 'marquee' : 'two-line'}" style="--ranking-card-bg-rgb:${rankingHexToRgb(state.overlayBgColor)};--ranking-card-bg-opacity:${(Number(state.overlayBgOpacity ?? 74) / 100).toFixed(2)};--ranking-streak-color:${escapeHtml(state.streakColor || '#67e8f9')}">
    <div class="ranking-title">${escapeHtml(state.title || 'Ranking list')}</div>
    <div class="ranking-list">
      ${rows.map(row => rankingRowHtml(row, maxPoints, state)).join('') || '<div class="ranking-empty">Chưa có dữ liệu BXH</div>'}
    </div>
    ${state.active ? `<div class="ranking-active-name ${activeLong ? 'long' : ''}">
      <div class="ranking-active-avatar">${state.active.avatar ? `<img src="${escapeHtml(state.active.avatar)}" />` : escapeHtml(state.active.initials || rankingInitials(state.active.name))}</div>
      <div class="ranking-active-main"><div>${activeName}</div><b>${activePoints}</b></div>
    </div>` : ''}
  </div>`;
}

function rankingRowHtml(row, maxPoints, state = rankingPublicState()) {
  const rankHtml = row.rank === 1 ? '🥇' : (row.rank === 2 ? '🥈' : (row.rank === 3 ? '🥉' : row.rank));
  const isLoser = !!row.lost;
  const gift = row.giftIcon ? `<img src="${escapeHtml(row.giftIcon)}" />` : (row.giftName ? '🎁' : '');
  return `<div class="ranking-row top-${row.rank <= 3 ? row.rank : 0} ${row.active ? 'active' : ''} ${isLoser || row.lost ? 'loser' : ''}">
    ${stateFlag('rank', state) ? `<div class="ranking-rank rank-${row.rank}">${rankHtml}</div>` : ''}
    ${stateFlag('avatar', state) ? `<div class="ranking-avatar">${row.avatar ? `<img src="${escapeHtml(row.avatar)}" />` : escapeHtml(row.initials || rankingInitials(row.name))}</div>` : ''}
    <div class="ranking-main">
      ${rankingNameHtml(row.name, 'ranking-name')}
      ${row.hideScore || state.hideAllScores ? '' : `<div class="ranking-points">${Number(row.points || 0).toLocaleString('en-US')}</div>`}
    </div>
    ${stateFlag('gift', state) ? `<div class="ranking-gift">${gift}</div>` : ''}
    ${stateFlag('round', state) ? `<div class="ranking-round">R${Number(row.round || 0)}</div>` : ''}
  </div>`;
}

function rankingGridRows(state) {
  const rows = Array.isArray(state.rows) ? state.rows : [];
  const gridRows = Math.max(1, Math.min(20, parseInt(state.gridRows, 10) || 3));
  const gridCols = Math.max(1, Math.min(10, parseInt(state.gridCols, 10) || 3));
  const capacity = gridRows * gridCols;
  const visible = rows.slice(0, capacity);
  const cells = [];
  for (let r = 0; r < gridRows; r++) {
    const line = [];
    for (let c = 0; c < gridCols; c++) {
      const index = state.gridFlow === 'column' ? c * gridRows + r : r * gridCols + c;
      line.push(visible[index] || null);
    }
    cells.push(line);
  }
  return { cells, gridRows, gridCols };
}

function rankingGridBoardHtml(state) {
  const { cells, gridCols } = rankingGridRows(state);
  const compactClass = `${state.showRank === false ? ' hide-rank' : ''}${state.showAvatar === false ? ' hide-avatar' : ''}${state.showGift === false ? ' hide-gift' : ''}${state.showRound === false ? ' hide-round' : ''}`;
  const activePoints = state.active ? Number(state.active.points || 0).toLocaleString('en-US') : '';
  return `<div class="ranking-grid-board${compactClass} name-${state.nameMode === 'marquee' ? 'marquee' : 'two-line'}" style="--ranking-grid-cols:${gridCols};--ranking-card-bg-rgb:${rankingHexToRgb(state.overlayBgColor)};--ranking-card-bg-opacity:${(Number(state.overlayBgOpacity ?? 74) / 100).toFixed(2)};--ranking-streak-color:${escapeHtml(state.streakColor || '#67e8f9')}">
    <div class="ranking-grid-title">${escapeHtml(state.title || 'Ranking list')}</div>
    <div class="ranking-grid-list">
      ${cells.flat().some(Boolean) ? cells.map(line => line.map(row => row ? rankingGridCellHtml(row, state) : '<div class="ranking-grid-cell empty"></div>').join('')).join('') : '<div class="ranking-empty">Chưa có dữ liệu BXH</div>'}
    </div>
    ${state.active ? `<div class="ranking-grid-active-name">
      <div class="ranking-grid-active-avatar">${state.active.avatar ? `<img src="${escapeHtml(state.active.avatar)}" />` : escapeHtml(state.active.initials || rankingInitials(state.active.name))}</div>
      <div class="ranking-grid-active-main"><div>${escapeHtml(state.active.name)}</div><b>${activePoints}</b></div>
    </div>` : ''}
  </div>`;
}

function rankingGridCellHtml(row, state) {
  const rankHtml = row.rank === 1 ? '🥇' : (row.rank === 2 ? '🥈' : (row.rank === 3 ? '🥉' : row.rank));
  const gift = row.giftIcon ? `<img src="${escapeHtml(row.giftIcon)}" />` : (row.giftName ? '🎁' : '');
  return `<div class="ranking-grid-cell top-${row.rank <= 3 ? row.rank : 0} ${row.active ? 'active' : ''} ${row.lost ? 'loser' : ''}">
    ${stateFlag('rank', state) ? `<div class="ranking-grid-rank rank-${row.rank}">${rankHtml}</div>` : ''}
    ${stateFlag('avatar', state) ? `<div class="ranking-grid-avatar">${row.avatar ? `<img src="${escapeHtml(row.avatar)}" />` : escapeHtml(row.initials || rankingInitials(row.name))}</div>` : ''}
    <div class="ranking-grid-main">
      ${rankingNameHtml(row.name, 'ranking-grid-name')}
      ${row.hideScore || state.hideAllScores ? '' : `<div class="ranking-grid-points">${Number(row.points || 0).toLocaleString('en-US')}</div>`}
    </div>
    ${stateFlag('gift', state) ? `<div class="ranking-grid-gift">${gift}</div>` : ''}
    ${stateFlag('round', state) ? `<div class="ranking-grid-round">R${Number(row.round || 0)}</div>` : ''}
  </div>`;
}

function stateFlag(kind, state = rankingPublicState()) {
  if (kind === 'rank') return state.showRank !== false;
  if (kind === 'avatar') return state.showAvatar !== false;
  if (kind === 'gift') return state.showGift !== false;
  if (kind === 'round') return state.showRound !== false;
  return true;
}

function rankingAddRow(row) {
  const next = normalizeRankingRow(row);
  appSettings.ranking.rows = [...(appSettings.ranking.rows || []).map(normalizeRankingRow), next];
  if (!appSettings.ranking.activeId) appSettings.ranking.activeId = next.id;
  persistRankingConfig();
  renderRankingEditor();
}

function rankingApplyRow(id, patch) {
  appSettings.ranking.rows = (appSettings.ranking.rows || []).map(row => {
    if (row.id !== id) return normalizeRankingRow(row);
    const next = normalizeRankingRow({ ...row, ...patch });
    if (patch.giftItemId != null) Object.assign(next, rankingGiftInfo(next.giftItemId));
    return next;
  });
  saveAppSettings({ ranking: appSettings.ranking }).catch(() => {});
  renderRankingEditor();
  pushRankingState();
}

function rankingHandleGift(ev) {
  if (!ev || ev.type !== 'gift') return;
  const cfg = rankingConfig();
  if (!cfg.running || !cfg.rows.length || !cfg.activeId) return;
  if (cfg.linkScoreTimer && ['prestart', 'success', 'failed', 'idle'].includes(scoreState.status)) return;
  const activeId = cfg.activeId;
  const hasConfiguredGifts = cfg.rows.some(row => row.giftItemId);
  const matched = cfg.rows.find(row => rankingGiftMatches(row, ev)) || (!hasConfiguredGifts ? cfg.rows.find(r => r.id === activeId) : null);
  if (!matched) return;
  const points = giftDiamondPointsFromEvent(ev) || giftTotalCountFromEvent(ev) || 1;
  const until = Date.now() + cfg.streakSeconds * 1000;
  appSettings.ranking.rows = cfg.rows.map(row => {
    if (row.id !== matched.id) return row;
    const n = normalizeRankingRow(row);
    n.points += points;
    if (n.id === activeId) n.activePoints += points;
    n.streakText = `${ev.gift_name || n.giftName || 'Quà'} x${giftTotalCountFromEvent(ev) || 1}`;
    n.streakUntil = until;
    return n;
  });
  saveAppSettings({ ranking: appSettings.ranking }).catch(() => {});
  renderRankingEditor();
  pushRankingState();
}

function rankingStartVote({ syncScore = true } = {}) {
  if (!appSettings.ranking.activeId) { alert('Vui lòng chọn idol VOTE trước'); return false; }
  appSettings.ranking.running = true;
  const cfg = rankingConfig();
  if (syncScore && cfg.linkScoreTimer && !['prestart', 'running', 'grace'].includes(scoreState.status)) {
    if (!isConnected) { alert('Vui lòng kết nối LIVE để sử dụng tính năng'); return false; }
    scoreReset({ silent: true });
    scoreStart({ fromRanking: true });
  }
  persistRankingConfig();
  pushRankingState();
  return true;
}

function rankingStopVote({ incrementRound = false } = {}) {
  const cfg = rankingConfig();
  if (incrementRound && cfg.running && cfg.activeId) {
    appSettings.ranking.rows = cfg.rows.map(row => row.id === cfg.activeId ? { ...row, round: (Number(row.round) || 0) + 1 } : row);
  }
  appSettings.ranking.running = false;
  appSettings.ranking.roundEndsAt = 0;
  if (rankingTimer) clearInterval(rankingTimer);
  rankingTimer = null;
  saveAppSettings({ ranking: appSettings.ranking }).catch(() => {});
  renderRankingEditor();
  pushRankingState();
}

function rankingToggleVote() {
  if (rankingConfig().running) {
    rankingStopVote();
    if (rankingConfig().linkScoreTimer && ['prestart', 'running', 'grace'].includes(scoreState.status)) scoreStop({ fromRanking: true });
  } else {
    rankingStartVote();
  }
}

function rankingTick() {
  const cfg = rankingConfig();
  if (!cfg.roundEndsAt) return pushRankingState();
  if (Date.now() < cfg.roundEndsAt) return pushRankingState();
  if (cfg.activeId) {
    appSettings.ranking.rows = cfg.rows.map(row => row.id === cfg.activeId ? { ...row, round: (Number(row.round) || 0) + 1 } : row);
  }
  appSettings.ranking.roundEndsAt = 0;
  if (rankingTimer) clearInterval(rankingTimer);
  rankingTimer = null;
  saveAppSettings({ ranking: appSettings.ranking }).catch(() => {});
  renderRankingEditor();
  pushRankingState();
}

function wireRankingUi() {
  const el = rankingEls();
  if (el.memberGroup) el.memberGroup.onchange = () => { appSettings.ranking.memberGroupId = el.memberGroup.value; renderRankingMemberSelectors(); persistRankingConfig(); };
  if (el.btnAddMember) el.btnAddMember.onclick = () => {
    const member = getMemberById(el.member?.value);
    if (!member) return alert('Vui lòng chọn thành viên');
    rankingAddRow({ memberGroupId: el.memberGroup?.value || '', memberId: member.id, name: member.name, avatar: member.avatar });
  };
  if (el.btnAddManual) el.btnAddManual.onclick = () => {
    rankingAddRow({ name: rankingNextCreatorName(), avatar: '' });
  };
  ['title','roundSeconds','streakSeconds','streakColor','grayLosers','showRank','showAvatar','showGift','showRound','hideAllScores','linkScoreTimer','rankStart','rankEnd','gridFlow','nameMode','showVerticalPreview','showGridPreview','compactPreview'].forEach(k => { if (el[k]) el[k].onchange = persistRankingConfig; });
  if (el.overlayBgColor) el.overlayBgColor.oninput = persistRankingConfig;
  if (el.overlayBgOpacity) el.overlayBgOpacity.oninput = () => { if (el.overlayBgOpacityVal) el.overlayBgOpacityVal.textContent = `${el.overlayBgOpacity.value}%`; persistRankingConfig(); };
  if (el.gridRows) el.gridRows.onchange = () => { rankingGridSuggestSource = 'rows'; persistRankingConfig(); };
  if (el.gridCols) el.gridCols.onchange = () => { rankingGridSuggestSource = 'cols'; persistRankingConfig(); };
  if (el.title) el.title.oninput = persistRankingConfig;
  if (el.btnSave) el.btnSave.onclick = () => { persistRankingConfig(); appendLog('[ranking] đã lưu và cập nhật OBS overlay'); };
  if (el.btnCopyUrl) el.btnCopyUrl.onclick = async () => { const r = await window.bigo.rankingCopyUrl(); if (!r.ok) alert(r.error || 'Không copy được link BXH'); };
  if (el.btnGridCopyUrl) el.btnGridCopyUrl.onclick = async () => { const r = await window.bigo.rankingGridCopyUrl(); if (!r.ok) alert(r.error || 'Không copy được link BXH ngang'); };
  if (el.btnGridApply) el.btnGridApply.onclick = () => { persistRankingConfig(); appendLog('[ranking] đã xác nhận lưới BXH ngang và cập nhật OBS overlay riêng'); };
  if (el.btnGridUseSuggestion) el.btnGridUseSuggestion.onclick = () => {
    const s = rankingGridSuggestion();
    if (el.gridRows) el.gridRows.value = s.rows;
    if (el.gridCols) el.gridCols.value = s.cols;
    persistRankingConfig();
  };
  if (el.btnStartRound) el.btnStartRound.onclick = rankingToggleVote;
  if (el.btnStopRound) el.btnStopRound.onclick = () => rankingStopVote();
  if (el.btnReset) el.btnReset.onclick = async () => {
    const ok = await appConfirm({ title: 'Reset BXH?', message: 'Đưa toàn bộ KC, round và chuỗi quà về 0?', okText: 'Reset', cancelText: 'Không', danger: true });
    if (!ok) return;
    appSettings.ranking.rows = (appSettings.ranking.rows || []).map(row => ({ ...row, points: 0, round: 0, activePoints: 0, streakText: '', streakUntil: 0 }));
    appSettings.ranking.roundEndsAt = 0;
    appSettings.ranking.running = false;
    persistRankingConfig(); renderRankingEditor();
  };
  if (el.rows) el.rows.onchange = e => {
    const rowEl = e.target.closest('[data-rank-id]');
    if (!rowEl) return;
    const id = rowEl.dataset.rankId;
    if (e.target.matches('[data-rank-group]')) rankingApplyRow(id, { memberGroupId: e.target.value, memberId: '' });
    if (e.target.matches('[data-rank-member]')) {
      const member = getMemberById(e.target.value);
      rankingApplyRow(id, { memberId: e.target.value, name: member?.name || '', avatar: member?.avatar || '' });
    }
    if (e.target.matches('[data-rank-name]')) rankingApplyRow(id, { name: e.target.value });
    if (e.target.matches('[data-rank-avatar]')) rankingApplyRow(id, { avatar: e.target.value });
    if (e.target.matches('[data-rank-gift]')) rankingApplyRow(id, { giftItemId: e.target.value });
    if (e.target.matches('[data-rank-points]')) rankingApplyRow(id, { points: e.target.value });
    if (e.target.matches('[data-rank-round]')) rankingApplyRow(id, { round: e.target.value });
    if (e.target.matches('[data-rank-hide-score]')) rankingApplyRow(id, { hideScore: e.target.checked });
    if (e.target.matches('[data-rank-lost]')) rankingApplyRow(id, { lost: e.target.checked });
    if (e.target.matches('[data-rank-exclude-overlay]')) rankingApplyRow(id, { excludeOverlay: e.target.checked });
    if (e.target.matches('[data-rank-active]')) { appSettings.ranking.activeId = e.target.checked ? id : ''; persistRankingConfig(); renderRankingEditor(); }
  };
  if (el.rows) el.rows.onclick = async e => {
    const rowEl = e.target.closest('[data-rank-id]');
    if (!rowEl) return;
    const id = rowEl.dataset.rankId;
    if (e.target.matches('[data-rank-toggle-settings]')) {
      const row = (appSettings.ranking.rows || []).find(r => r.id === id);
      rankingApplyRow(id, { settingsOpen: !row?.settingsOpen });
    }
    if (e.target.matches('[data-rank-delete]')) {
      const row = (appSettings.ranking.rows || []).find(r => r.id === id);
      const ok = await appConfirm({ title: 'Xoá idol khỏi BXH?', message: `Xoá ${row?.name || 'idol này'} khỏi danh sách BXH?`, okText: 'Xoá', cancelText: 'Không', danger: true });
      if (!ok) return;
      appSettings.ranking.rows = (appSettings.ranking.rows || []).filter(row => row.id !== id);
      if (appSettings.ranking.activeId === id) appSettings.ranking.activeId = '';
      persistRankingConfig(); renderRankingEditor();
    }
    if (e.target.matches('[data-rank-delta]')) {
      const row = (appSettings.ranking.rows || []).find(r => r.id === id);
      if (!row) return;
      rankingApplyRow(id, { points: Math.max(0, (Number(row.points) || 0) + (Number(e.target.dataset.rankDelta) || 0)) });
    }
  };
}
wireRankingUi();

// =================== PK Đôi ===================
let pkDuoTimer = null;
let pkDuoWarningSoundPlayed = false;
let pkDuoResultSoundPlayed = false;

function pkDuoEls() {
  return {
    hours: $('pkDuoHours'), minutes: $('pkDuoMinutes'), seconds: $('pkDuoSeconds'), prep: $('pkDuoPrepSeconds'), delay: $('pkDuoDelaySeconds'), content: $('pkDuoContent'), textSize: $('pkDuoTextSize'), textSizeVal: $('pkDuoTextSizeVal'), bgColor: $('pkDuoBgColor'), bgOpacity: $('pkDuoBgOpacity'), bgOpacityVal: $('pkDuoBgOpacityVal'), giftSize: $('pkDuoGiftSize'), giftSizeVal: $('pkDuoGiftSizeVal'),
    aName: $('pkDuoTeamAName'), bName: $('pkDuoTeamBName'), aColor: $('pkDuoTeamAColor'), bColor: $('pkDuoTeamBColor'), joinMode: $('pkDuoJoinMode'),
    aGifts: $('pkDuoTeamAGifts'), bGifts: $('pkDuoTeamBGifts'), preview: $('pkDuoPreview'), status: $('pkDuoStatus'),
    start: $('btnPkDuoStart'), stop: $('btnPkDuoStop'), reset: $('btnPkDuoReset'), save: $('btnPkDuoSave'), copy: $('btnPkDuoCopyUrl'),
    startSoundLabel: $('pkDuoStartSoundLabel'), warningSoundLabel: $('pkDuoWarningSoundLabel'), teamASoundLabel: $('pkDuoTeamASoundLabel'), teamBSoundLabel: $('pkDuoTeamBSoundLabel'), drawSoundLabel: $('pkDuoDrawSoundLabel'),
    pickStartSound: $('btnPkDuoPickStartSound'), clearStartSound: $('btnPkDuoClearStartSound'), pickWarningSound: $('btnPkDuoPickWarningSound'), clearWarningSound: $('btnPkDuoClearWarningSound'), pickTeamASound: $('btnPkDuoPickTeamASound'), clearTeamASound: $('btnPkDuoClearTeamASound'), pickTeamBSound: $('btnPkDuoPickTeamBSound'), clearTeamBSound: $('btnPkDuoClearTeamBSound'), pickDrawSound: $('btnPkDuoPickDrawSound'), clearDrawSound: $('btnPkDuoClearDrawSound'),
  };
}

function normalizePkDuo() {
  const p = appSettings.pkDuo || {};
  const teamA = { ...(p.teamA || {}) };
  const teamB = { ...(p.teamB || {}) };
  const defaultGiftSlots = p.joinMode ? [''] : ['', '', ''];
  const giftIdsA = Array.isArray(teamA.giftIds) && teamA.giftIds.length ? teamA.giftIds.slice(0, 12) : [...defaultGiftSlots];
  const giftIdsB = Array.isArray(teamB.giftIds) && teamB.giftIds.length ? teamB.giftIds.slice(0, 12) : [...defaultGiftSlots];
  return {
    running: !!p.running,
    status: ['idle','prestart','running','finished'].includes(p.status) ? p.status : 'idle',
    prepSeconds: Math.max(0, Math.min(120, parseInt(p.prepSeconds, 10) || 0)),
    delaySeconds: Math.max(0, Math.min(120, parseInt(p.delaySeconds, 10) || 5)),
    durationSeconds: Math.max(5, Math.min(7200, parseInt(p.durationSeconds, 10) || 60)),
    endsAt: Math.max(0, Number(p.endsAt) || 0),
    scoreA: Math.max(0, Math.round(Number(p.scoreA) || 0)),
    scoreB: Math.max(0, Math.round(Number(p.scoreB) || 0)),
    joinMode: !!p.joinMode,
    userTeams: p.userTeams && typeof p.userTeams === 'object' ? p.userTeams : {},
    bgColor: /^#[0-9a-f]{6}$/i.test(String(p.bgColor || '')) ? p.bgColor : '#000000',
    bgOpacity: Math.max(0, Math.min(100, parseInt(p.bgOpacity, 10) || 88)),
    giftSize: Math.max(28, Math.min(90, parseInt(p.giftSize, 10) || 46)),
    content: String(p.content || 'Vui lòng chờ').trim() || 'Vui lòng chờ',
    textSize: Math.max(14, Math.min(42, parseInt(p.textSize, 10) || 21)),
    startSound: String(p.startSound || ''), startSoundName: String(p.startSoundName || ''),
    warningSound: String(p.warningSound || ''), warningSoundName: String(p.warningSoundName || ''),
    teamASound: String(p.teamASound || ''), teamASoundName: String(p.teamASoundName || ''),
    teamBSound: String(p.teamBSound || ''), teamBSoundName: String(p.teamBSoundName || ''),
    drawSound: String(p.drawSound || ''), drawSoundName: String(p.drawSoundName || ''),
    teamA: { name: String(teamA.name || 'ĐỘI A').trim() || 'ĐỘI A', color: /^#[0-9a-f]{6}$/i.test(String(teamA.color || '')) ? teamA.color : '#d8587c', giftIds: giftIdsA },
    teamB: { name: String(teamB.name || 'ĐỘI B').trim() || 'ĐỘI B', color: /^#[0-9a-f]{6}$/i.test(String(teamB.color || '')) ? teamB.color : '#6380ff', giftIds: giftIdsB },
  };
}

function pkDuoGiftCanonicalId(itemId) {
  const id = String(itemId || '');
  if (!id) return '';
  if (id.startsWith('master:')) return `id:${id.slice(7)}`;
  const found = findItemById(id)?.item;
  const iconId = getGameplayItemIconId(found);
  return iconId ? `id:${iconId}` : `item:${id}`;
}

function pkDuoGiftCatalog() {
  const items = [];
  const seen = new Set();
  for (const g of (masterFullList || [])) {
    const id = `master:${g.typeid}`;
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({ id, name: g.gift_name || g.name || `Gift ${g.typeid}`, icon: g.localIcon || g.icon || g.img_url || '', iconId: String(g.typeid || ''), source: 'master', vn: isVnGift(g) });
  }
  for (const item of rankingGiftItems()) {
    const id = item.id;
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({ id, name: getGameplayItemName(item), icon: getGameplayItemIcon(item), iconId: getGameplayItemIconId(item), source: 'mapping', vn: isVnMappingItem(item) });
  }
  return items.sort((a, b) => (b.vn ? 1 : 0) - (a.vn ? 1 : 0) || String(a.name).localeCompare(String(b.name), 'vi', { sensitivity: 'base' }));
}

function pkDuoGiftMatches(itemId, ev) {
  const id = String(itemId || '');
  if (!id || !ev) return false;
  if (id.startsWith('master:')) {
    const typeid = id.slice(7);
    if (ev.gift_id != null && String(ev.gift_id) === typeid) return true;
    const gift = pkDuoGiftMeta(id);
    if (!gift) return false;
    const evName = normalizeGameplayGiftKey(ev.gift_name);
    if (evName && normalizeGameplayGiftKey(gift.name) === evName) return true;
    const evIcon = normalizeGameplayIconUrl(ev.gift_icon || ev.gift_icon_url || ev.gift_url || '');
    const giftIcon = normalizeGameplayIconUrl(gift.icon || '');
    return !!evIcon && !!giftIcon && evIcon === giftIcon;
  }
  return rankingGiftMatches({ giftItemId: id }, ev);
}

function pkDuoGiftMeta(itemId) {
  if (String(itemId || '').startsWith('master:')) {
    const typeid = String(itemId).slice(7);
    const g = (masterFullList || []).find(x => String(x.typeid) === typeid);
    if (!g) return null;
    return { id: itemId, name: g.gift_name || g.name || `Gift ${typeid}`, icon: g.localIcon || g.icon || g.img_url || '', iconId: typeid };
  }
  const found = findItemById(itemId)?.item;
  if (!found) return null;
  return { id: itemId, name: getGameplayItemName(found), icon: getGameplayItemIcon(found), iconId: getGameplayItemIconId(found) };
}

function pkDuoPublicState() {
  const p = normalizePkDuo();
  const total = p.scoreA + p.scoreB;
  const push = total > 0 ? Math.max(-42, Math.min(42, ((p.scoreA - p.scoreB) / total) * 42)) : 0;
  return { ...p, remainingMs: p.endsAt ? Math.max(0, p.endsAt - Date.now()) : 0, push, teamA: { ...p.teamA, gifts: p.teamA.giftIds.map(pkDuoGiftMeta).filter(Boolean) }, teamB: { ...p.teamB, gifts: p.teamB.giftIds.map(pkDuoGiftMeta).filter(Boolean) } };
}

function persistPkDuoConfig() {
  const el = pkDuoEls();
  const p = normalizePkDuo();
  const hours = Math.max(0, Math.min(24, parseInt(el.hours?.value, 10) || 0));
  const minutes = Math.max(0, Math.min(59, parseInt(el.minutes?.value, 10) || 0));
  const seconds = Math.max(0, Math.min(59, parseInt(el.seconds?.value, 10) || 0));
  const durationSeconds = Math.max(5, Math.min(86400, hours * 3600 + minutes * 60 + seconds));
  appSettings.pkDuo = {
    ...appSettings.pkDuo,
    prepSeconds: Math.max(0, Math.min(120, parseInt(el.prep?.value, 10) || 0)),
    delaySeconds: Math.max(0, Math.min(120, parseInt(el.delay?.value, 10) || 0)),
    durationSeconds,
    content: String(el.content?.value || 'Vui lòng chờ').trim() || 'Vui lòng chờ',
    textSize: Math.max(14, Math.min(42, parseInt(el.textSize?.value, 10) || 21)),
    bgColor: el.bgColor?.value || '#000000',
    bgOpacity: Math.max(0, Math.min(100, parseInt(el.bgOpacity?.value, 10) || 0)),
    giftSize: Math.max(28, Math.min(90, parseInt(el.giftSize?.value, 10) || 46)),
    joinMode: !!el.joinMode?.checked,
    teamA: { ...p.teamA, name: el.aName?.value || 'ĐỘI A', color: el.aColor?.value || '#d8587c' },
    teamB: { ...p.teamB, name: el.bName?.value || 'ĐỘI B', color: el.bColor?.value || '#6380ff' },
  };
  if (el.bgOpacityVal) el.bgOpacityVal.textContent = `${appSettings.pkDuo.bgOpacity}%`;
  if (el.giftSizeVal) el.giftSizeVal.textContent = `${appSettings.pkDuo.giftSize}px`;
  if (el.textSizeVal) el.textSizeVal.textContent = `${appSettings.pkDuo.textSize}px`;
  saveAppSettings({ pkDuo: appSettings.pkDuo }).catch(() => {});
  renderPkDuo();
}

function renderPkDuoGiftList(side) {
  const p = normalizePkDuo();
  let ids = side === 'A' ? p.teamA.giftIds : p.teamB.giftIds;
  if (!ids.length) ids = p.joinMode ? [''] : ['', '', ''];
  if (p.joinMode) ids = ids.slice(0, 1);
  const disabledAdd = p.joinMode && ids.length >= 1;
  return ids.map((id, idx) => {
    const gift = pkDuoGiftMeta(id);
    return `<div class="pkduo-gift-row" data-pk-side="${side}" data-pk-idx="${idx}">
      <button type="button" class="pkduo-gift-picker" data-pk-pick>${gift?.icon ? `<img src="${escapeHtml(gift.icon)}" />` : '<span>🎁</span>'}<b>${escapeHtml(gift?.name || 'Chọn quà')}</b></button>
      <button type="button" class="tiny primary" data-pk-test title="Test cộng điểm nhanh">TEST</button>
      <button type="button" class="tiny danger" data-pk-del>🗑</button>
    </div>`;
  }).join('') + `<button type="button" class="pkduo-add-gift" data-pk-add="${side}" ${disabledAdd ? 'disabled' : ''}>+</button>`;
}

function pkDuoBoardHtml(state = pkDuoPublicState()) {
  const fmt = n => Math.max(0, Math.round(Number(n) || 0)).toLocaleString('en-US');
  const giftHtml = gift => `<span class="pkduo-gift-icon" title="${escapeHtml(gift.name)}">${gift.icon ? `<img src="${escapeHtml(gift.icon)}" />` : '🎁'}</span>`;
  const sec = Math.ceil((state.remainingMs || 0) / 1000);
  const status = state.status === 'prestart' ? `${sec}s` : (state.status === 'running' ? `${sec}s` : (state.status === 'finished' ? 'Kết thúc' : state.content));
  const urgent = state.status === 'running' && sec <= 10 && sec > 0;
  const neutral = Number(state.scoreA || 0) === Number(state.scoreB || 0);
  const centerIcon = neutral ? 'pk-duo-neutral.svg' : 'pk-duo-boost.svg';
  const centerClass = neutral ? 'neutral' : (state.scoreB > state.scoreA ? 'flip' : '');
  const barClass = neutral ? 'neutral' : (state.scoreA > state.scoreB ? 'lead-a' : 'lead-b');
  const sweepDelay = -((Date.now() % 3000) / 1000).toFixed(3);
  return `<div class="pkduo-board status-${escapeHtml(state.status || 'idle')}${urgent ? ' urgent' : ''}" style="--pk-a:${escapeHtml(state.teamA.color)};--pk-b:${escapeHtml(state.teamB.color)};--pk-bg:${pkDuoHexToRgb(state.bgColor)};--pk-bg-opacity:${(state.bgOpacity / 100).toFixed(2)};--pk-gift:${state.giftSize}px;--pk-text:${state.textSize}px;--pk-push:${state.push}%;--pk-a-width:${Math.max(8, Math.min(92, 50 + Number(state.push || 0)))}%;--pk-sweep-delay:${sweepDelay}s">
    <div class="pkduo-head"><b>${escapeHtml(state.teamA.name)}</b><span>${escapeHtml(status)}</span><b>${escapeHtml(state.teamB.name)}</b></div>
    <div class="pkduo-gifts"><div>${state.teamA.gifts.map(giftHtml).join('')}</div><i></i><div>${state.teamB.gifts.map(giftHtml).join('')}</div></div>
    <div class="pkduo-bar ${barClass}"><strong class="score-a">${fmt(state.scoreA)}</strong><span class="pkduo-team-label a">HP MEDIA</span><em class="${centerClass}"><img src="${centerIcon}" alt="" /></em><span class="pkduo-team-label b">HP MEDIA</span><strong class="score-b">${fmt(state.scoreB)}</strong></div>
  </div>`;
}

function pkDuoHexToRgb(hex) { return rankingHexToRgb(hex, '0,0,0'); }

function renderPkDuo() {
  const el = pkDuoEls();
  const p = normalizePkDuo();
  appSettings.pkDuo = { ...appSettings.pkDuo, ...p };
  const totalDuration = Math.max(5, Number(p.durationSeconds) || 60);
  if (el.hours) el.hours.value = Math.floor(totalDuration / 3600);
  if (el.minutes) el.minutes.value = Math.floor((totalDuration % 3600) / 60);
  if (el.seconds) el.seconds.value = totalDuration % 60;
  if (el.prep) el.prep.value = p.prepSeconds;
  if (el.delay) el.delay.value = p.delaySeconds;
  if (el.content) el.content.value = p.content;
  if (el.textSize) el.textSize.value = p.textSize;
  if (el.textSizeVal) el.textSizeVal.textContent = `${p.textSize}px`;
  if (el.bgColor) el.bgColor.value = p.bgColor;
  if (el.bgOpacity) el.bgOpacity.value = p.bgOpacity;
  if (el.bgOpacityVal) el.bgOpacityVal.textContent = `${p.bgOpacity}%`;
  if (el.giftSize) el.giftSize.value = p.giftSize;
  if (el.giftSizeVal) el.giftSizeVal.textContent = `${p.giftSize}px`;
  if (el.aName) el.aName.value = p.teamA.name;
  if (el.bName) el.bName.value = p.teamB.name;
  if (el.aColor) el.aColor.value = p.teamA.color;
  if (el.bColor) el.bColor.value = p.teamB.color;
  if (el.startSoundLabel) el.startSoundLabel.value = p.startSoundName || '';
  if (el.warningSoundLabel) el.warningSoundLabel.value = p.warningSoundName || '';
  if (el.teamASoundLabel) el.teamASoundLabel.value = p.teamASoundName || '';
  if (el.teamBSoundLabel) el.teamBSoundLabel.value = p.teamBSoundName || '';
  if (el.drawSoundLabel) el.drawSoundLabel.value = p.drawSoundName || '';
  if (el.joinMode) el.joinMode.checked = p.joinMode;
  if (el.aGifts) el.aGifts.innerHTML = renderPkDuoGiftList('A');
  if (el.bGifts) el.bGifts.innerHTML = renderPkDuoGiftList('B');
  const state = pkDuoPublicState();
  if (el.preview) el.preview.innerHTML = pkDuoBoardHtml(state);
  if (el.status) el.status.textContent = state.status === 'running' ? 'ĐANG PK' : (state.status === 'prestart' ? 'CHUẨN BỊ' : (state.status === 'finished' ? 'KẾT THÚC' : 'CHỜ'));
  if (el.start) el.start.disabled = !!state.running || state.status === 'prestart' || state.status === 'running';
  if (window.bigo?.pkDuoUpdate) window.bigo.pkDuoUpdate(state).catch(() => {});
}

function pkDuoGiftSide(ev) {
  const p = normalizePkDuo();
  const match = id => pkDuoGiftMatches(id, ev);
  if (p.teamA.giftIds.some(match)) return 'A';
  if (p.teamB.giftIds.some(match)) return 'B';
  return '';
}

function playPkDuoCue(kind) {
  const cfg = appSettings.pkDuo || {};
  const src = cfg[`${kind}Sound`];
  if (!src) return;
  try {
    const audio = new Audio(src);
    audio.volume = Math.max(0, Math.min(1, (appSettings.fxVolume || 100) / 100));
    audio.play().catch(() => {});
  } catch {}
}

function playPkDuoResultSound() {
  if (pkDuoResultSoundPlayed) return;
  pkDuoResultSoundPlayed = true;
  const p = normalizePkDuo();
  if (p.scoreA > p.scoreB) playPkDuoCue('teamA');
  else if (p.scoreB > p.scoreA) playPkDuoCue('teamB');
  else playPkDuoCue('draw');
}

async function pickPkDuoSound(kind) {
  const r = await window.bigo.effectsPickFiles();
  if (!r.ok || !r.files?.length) return;
  const picked = r.files[0];
  const soundSrc = picked.fileUrl || picked.file;
  appSettings.pkDuo[`${kind}Sound`] = soundSrc;
  appSettings.pkDuo[`${kind}SoundName`] = picked.fileName;
  renderPkDuo();
  await saveAppSettings({ pkDuo: { [`${kind}Sound`]: soundSrc, [`${kind}SoundName`]: picked.fileName } });
}

async function clearPkDuoSound(kind) {
  appSettings.pkDuo[`${kind}Sound`] = '';
  appSettings.pkDuo[`${kind}SoundName`] = '';
  renderPkDuo();
  await saveAppSettings({ pkDuo: { [`${kind}Sound`]: '', [`${kind}SoundName`]: '' } });
}

function pkDuoHandleGift(ev) {
  if (!ev || ev.type !== 'gift') return;
  const p = normalizePkDuo();
  if (!p.running || p.status !== 'running') return;
  const points = giftDiamondPointsFromEvent(ev) || giftTotalCountFromEvent(ev) || 1;
  const user = String(ev.user || ev.nick_name || ev.user_id || '').trim();
  let side = pkDuoGiftSide(ev);
  if (p.joinMode) {
    if (side && user) appSettings.pkDuo.userTeams = { ...(appSettings.pkDuo.userTeams || {}), [user]: side };
    if (!side && user) side = appSettings.pkDuo.userTeams?.[user] || '';
  }
  if (!side) return;
  if (side === 'A') appSettings.pkDuo.scoreA = (Number(appSettings.pkDuo.scoreA) || 0) + points;
  if (side === 'B') appSettings.pkDuo.scoreB = (Number(appSettings.pkDuo.scoreB) || 0) + points;
  saveAppSettings({ pkDuo: appSettings.pkDuo }).catch(() => {});
  renderPkDuo();
}

function pkDuoStart() {
  const current = normalizePkDuo();
  if (current.running || current.status === 'prestart' || current.status === 'running') return;
  persistPkDuoConfig();
  const cfg = normalizePkDuo();
  const prep = cfg.prepSeconds;
  appSettings.pkDuo.running = true;
  appSettings.pkDuo.status = prep > 0 ? 'prestart' : 'running';
  appSettings.pkDuo.scoreA = 0;
  appSettings.pkDuo.scoreB = 0;
  appSettings.pkDuo.userTeams = {};
  appSettings.pkDuo.endsAt = Date.now() + (prep > 0 ? prep : (cfg.durationSeconds + cfg.delaySeconds)) * 1000;
  pkDuoWarningSoundPlayed = false;
  pkDuoResultSoundPlayed = false;
  if (!prep) playPkDuoCue('start');
  if (pkDuoTimer) clearInterval(pkDuoTimer);
  pkDuoTimer = setInterval(pkDuoTick, 500);
  saveAppSettings({ pkDuo: appSettings.pkDuo }).catch(() => {});
  renderPkDuo();
}

function pkDuoStop() {
  appSettings.pkDuo.running = false;
  appSettings.pkDuo.status = 'finished';
  appSettings.pkDuo.endsAt = 0;
  playPkDuoResultSound();
  if (pkDuoTimer) clearInterval(pkDuoTimer);
  pkDuoTimer = null;
  saveAppSettings({ pkDuo: appSettings.pkDuo }).catch(() => {});
  renderPkDuo();
}

function pkDuoTick() {
  const p = normalizePkDuo();
  if (!p.running || !p.endsAt) return renderPkDuo();
  const remaining = p.endsAt - Date.now();
  if (p.status === 'running' && remaining <= 10000 && remaining > 0 && !pkDuoWarningSoundPlayed) {
    pkDuoWarningSoundPlayed = true;
    playPkDuoCue('warning');
  }
  if (remaining > 0) return renderPkDuo();
  if (p.status === 'prestart') {
    appSettings.pkDuo.status = 'running';
    appSettings.pkDuo.endsAt = Date.now() + (p.durationSeconds + p.delaySeconds) * 1000;
    playPkDuoCue('start');
  } else {
    appSettings.pkDuo.running = false;
    appSettings.pkDuo.status = 'finished';
    appSettings.pkDuo.endsAt = 0;
    playPkDuoResultSound();
    clearInterval(pkDuoTimer); pkDuoTimer = null;
  }
  saveAppSettings({ pkDuo: appSettings.pkDuo }).catch(() => {});
  renderPkDuo();
}

function wirePkDuoUi() {
  const el = pkDuoEls();
  ['hours','minutes','seconds','prep','delay','bgColor','bgOpacity','giftSize','textSize','aName','bName','aColor','bColor','joinMode'].forEach(k => { if (el[k]) el[k].onchange = persistPkDuoConfig; });
  ['bgOpacity','giftSize','textSize','aName','bName'].forEach(k => { if (el[k]) el[k].oninput = persistPkDuoConfig; });
  if (el.content) {
    el.content.oninput = () => {
      appSettings.pkDuo.content = String(el.content.value || '').trim() || 'Vui lòng chờ';
      const state = pkDuoPublicState();
      if (el.preview) el.preview.innerHTML = pkDuoBoardHtml(state);
      if (window.bigo?.pkDuoUpdate) window.bigo.pkDuoUpdate(state).catch(() => {});
    };
    el.content.onchange = persistPkDuoConfig;
  }
  if (el.start) el.start.onclick = pkDuoStart;
  if (el.stop) el.stop.onclick = pkDuoStop;
  if (el.reset) el.reset.onclick = () => { appSettings.pkDuo.scoreA = 0; appSettings.pkDuo.scoreB = 0; appSettings.pkDuo.userTeams = {}; appSettings.pkDuo.running = false; appSettings.pkDuo.status = 'idle'; appSettings.pkDuo.endsAt = 0; saveAppSettings({ pkDuo: appSettings.pkDuo }).catch(() => {}); renderPkDuo(); };
  if (el.save) el.save.onclick = () => { persistPkDuoConfig(); appendLog('[pk-duo] đã lưu cấu hình'); };
  if (el.copy) el.copy.onclick = async () => { const r = await window.bigo.pkDuoCopyUrl(); if (!r.ok) alert(r.error || 'Không copy được link PK ĐÔI'); };
  ['start','warning','teamA','teamB','draw'].forEach(kind => {
    const cap = kind[0].toUpperCase() + kind.slice(1);
    if (el[`pick${cap}Sound`]) el[`pick${cap}Sound`].onclick = () => pickPkDuoSound(kind);
    if (el[`clear${cap}Sound`]) el[`clear${cap}Sound`].onclick = () => clearPkDuoSound(kind);
  });
  [el.aGifts, el.bGifts].forEach(list => {
    if (!list) return;
    list.onclick = e => {
      const pick = e.target.closest('[data-pk-pick]');
      if (pick) { const row = pick.closest('[data-pk-side]'); openPkDuoGiftPicker(row.dataset.pkSide, Number(row.dataset.pkIdx) || 0); return; }
      const sideAdd = e.target.dataset.pkAdd;
      if (sideAdd) { const key = sideAdd === 'A' ? 'teamA' : 'teamB'; const p = normalizePkDuo(); if (!p.joinMode || p[key].giftIds.length < 1) p[key].giftIds.push(''); appSettings.pkDuo[key] = p[key]; persistPkDuoConfig(); return; }
      const row = e.target.closest('[data-pk-side]');
      if (row && e.target.matches('[data-pk-test]')) { pkDuoTestGift(row.dataset.pkSide, Number(row.dataset.pkIdx) || 0); return; }
      if (row && e.target.matches('[data-pk-del]')) { const side = row.dataset.pkSide; const key = side === 'A' ? 'teamA' : 'teamB'; const p = normalizePkDuo(); p[key].giftIds.splice(Number(row.dataset.pkIdx) || 0, 1); appSettings.pkDuo[key] = p[key]; persistPkDuoConfig(); }
    };
  });
}
wirePkDuoUi();

function pkDuoTestGift(side, idx) {
  const p = normalizePkDuo();
  const key = side === 'A' ? 'teamA' : 'teamB';
  const id = p[key].giftIds[idx];
  const gift = pkDuoGiftMeta(id);
  if (!gift) { alert('Vui lòng chọn quà trước khi test'); return; }
  const points = 100;
  if (side === 'A') appSettings.pkDuo.scoreA = (Number(appSettings.pkDuo.scoreA) || 0) + points;
  else appSettings.pkDuo.scoreB = (Number(appSettings.pkDuo.scoreB) || 0) + points;
  appSettings.pkDuo.status = p.status === 'idle' ? 'running' : p.status;
  saveAppSettings({ pkDuo: appSettings.pkDuo }).catch(() => {});
  renderPkDuo();
}

function openPkDuoGiftPicker(side, idx) {
  ensureMasterLoaded().catch(() => {}).finally(() => {
    removeContextMenu();
    const p = normalizePkDuo();
    const picker = document.createElement('div');
    picker.className = 'ctx-menu pkduo-picker-menu';
    picker.innerHTML = `<input class="pkduo-picker-search" placeholder="Tìm quà trong ${pkDuoGiftCatalog().length} quà..." /><label class="pkduo-picker-tools"><input type="checkbox" data-pk-vn-only /> Chỉ quà VN</label><div class="pkduo-picker-list"></div>`;
    document.body.appendChild(picker);
    const input = picker.querySelector('.pkduo-picker-search');
    const vnOnly = picker.querySelector('[data-pk-vn-only]');
    const list = picker.querySelector('.pkduo-picker-list');
    const render = () => {
      const q = normalizeGameplayGiftKey(input.value);
      const arr = pkDuoGiftCatalog().filter(g => (!vnOnly?.checked || g.vn) && (!q || normalizeGameplayGiftKey(g.name).includes(q) || String(g.iconId || '').includes(q))).slice(0, 250);
      list.innerHTML = arr.map(g => `<button type="button" data-pk-gift-id="${escapeHtml(g.id)}">${g.icon ? `<img src="${escapeHtml(g.icon)}" />` : '<span>🎁</span>'}<b>${escapeHtml(g.name)} ${g.vn ? '<span class="vn-badge">VN</span>' : ''}</b><small>${escapeHtml(g.iconId || '')}</small></button>`).join('') || '<div class="score-log-empty">Không tìm thấy quà</div>';
    };
    input.oninput = render;
    if (vnOnly) vnOnly.onchange = render;
    list.onclick = e => {
      const btn = e.target.closest('[data-pk-gift-id]'); if (!btn) return;
      const id = btn.dataset.pkGiftId;
      const cur = normalizePkDuo(); const otherIds = side === 'A' ? cur.teamB.giftIds : cur.teamA.giftIds;
      if (id && otherIds.some(otherId => pkDuoGiftCanonicalId(otherId) === pkDuoGiftCanonicalId(id))) { alert('Quà PK hai đội không được trùng nhau'); return; }
      const key = side === 'A' ? 'teamA' : 'teamB'; cur[key].giftIds[idx] = id; appSettings.pkDuo[key] = cur[key]; persistPkDuoConfig(); removeContextMenu();
    };
    const rect = document.querySelector(`[data-pk-side="${side}"][data-pk-idx="${idx}"]`)?.getBoundingClientRect();
    picker.style.left = `${Math.max(8, Math.min(window.innerWidth - 360, rect?.left || 80))}px`;
    picker.style.top = `${Math.max(8, Math.min(window.innerHeight - 520, (rect?.bottom || 120) + 6))}px`;
    render(); input.focus();
    setTimeout(() => {
      document.addEventListener('keydown', escContextMenu, { once: true });
      document.addEventListener('pointerdown', closePkDuoPickerOnPointer, true);
      document.addEventListener('contextmenu', closePkDuoPickerOnPointer, true);
    }, 0);
  });
}

if (els.gameplayGroup) {
  els.gameplayGroup.addEventListener('change', () => {
    gameplayReviewState.clear();
    saveGameplaySettings({ groupId: els.gameplayGroup.value, order: [], hiddenIds: [] });
  });
}
if (els.gameplayGroupChecks) {
  els.gameplayGroupChecks.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-gameplay-group-check]');
    if (!btn) return;
    const gid = btn.dataset.gameplayGroupCheck;
    const group = findGroupById(gid);
    if (!group) return;
    const common = getCommonGroup();
    gameplayReviewState.clear();
    if (group.isCommon || group.id === common.id) {
      if (appSettings.gameplay.groupId !== common.id) {
        saveGameplaySettings({ groupId: common.id, useCommonGroup: true, order: [], hiddenIds: [] });
      } else {
        saveGameplaySettings({ useCommonGroup: appSettings.gameplay.useCommonGroup === false, order: [], hiddenIds: [] });
      }
    } else {
      saveGameplaySettings({ groupId: group.id, order: [], hiddenIds: [] });
    }
  });
}
if (els.gameplayUseCommonGroup) {
  els.gameplayUseCommonGroup.addEventListener('change', () => {
    gameplayReviewState.clear();
    saveGameplaySettings({ useCommonGroup: els.gameplayUseCommonGroup.checked, order: [], hiddenIds: [] });
  });
}
if (els.gameplayOrientation) {
  els.gameplayOrientation.addEventListener('change', () => {
    saveGameplaySettings({ orientation: els.gameplayOrientation.value === 'vertical' ? 'vertical' : 'horizontal' });
  });
}
if (els.gameplayLabelPosition) {
  els.gameplayLabelPosition.addEventListener('change', () => {
    const v = els.gameplayLabelPosition.value;
    saveGameplaySettings({ labelPosition: ['top', 'bottom', 'left', 'right'].includes(v) ? v : 'bottom' });
  });
}
if (els.gameplayNameMode) {
  els.gameplayNameMode.addEventListener('change', () => {
    const v = els.gameplayNameMode.value;
    saveGameplaySettings({ nameMode: ['normal', 'marquee', 'wrap'].includes(v) ? v : 'marquee' });
  });
}
if (els.gameplayCardBg) {
  els.gameplayCardBg.addEventListener('input', () => {
    appSettings.gameplay.cardBg = els.gameplayCardBg.value;
    renderGameplayReview();
    sendGameplayConfig();
  });
  els.gameplayCardBg.addEventListener('change', () => saveGameplaySettings({ cardBg: els.gameplayCardBg.value }));
}
if (els.gameplayCardOpacity) {
  els.gameplayCardOpacity.addEventListener('input', () => {
    const cardOpacity = Math.max(20, Math.min(100, parseInt(els.gameplayCardOpacity.value, 10) || 86));
    if (els.gameplayCardOpacityVal) els.gameplayCardOpacityVal.textContent = `${cardOpacity}%`;
    appSettings.gameplay.cardOpacity = cardOpacity;
    renderGameplayReview();
    sendGameplayConfig();
  });
  els.gameplayCardOpacity.addEventListener('change', () => saveGameplaySettings({ cardOpacity: Math.max(20, Math.min(100, parseInt(els.gameplayCardOpacity.value, 10) || 86)) }));
}
if (els.gameplayTextFont) {
  els.gameplayTextFont.addEventListener('change', () => saveGameplaySettings({ textFont: els.gameplayTextFont.value }));
}
if (els.gameplayTextColor) {
  els.gameplayTextColor.addEventListener('input', () => {
    appSettings.gameplay.textColor = els.gameplayTextColor.value;
    renderGameplayReview();
    sendGameplayConfig();
  });
  els.gameplayTextColor.addEventListener('change', () => saveGameplaySettings({ textColor: els.gameplayTextColor.value }));
}
if (els.gameplaySlotNumberColor) {
  els.gameplaySlotNumberColor.addEventListener('input', () => {
    appSettings.gameplay.slotNumberColor = els.gameplaySlotNumberColor.value;
    renderGameplayGridEditor(normalizeGameplaySettings());
    renderGameplayReview();
    sendGameplayConfig();
  });
  els.gameplaySlotNumberColor.addEventListener('change', () => saveGameplaySettings({ slotNumberColor: els.gameplaySlotNumberColor.value }));
}
if (els.gameplayCountColor) {
  els.gameplayCountColor.addEventListener('input', () => {
    appSettings.gameplay.countColor = els.gameplayCountColor.value;
    renderGameplayReview();
    sendGameplayConfig();
  });
  els.gameplayCountColor.addEventListener('change', () => saveGameplaySettings({ countColor: els.gameplayCountColor.value }));
}
if (els.gameplayUppercase) {
  els.gameplayUppercase.addEventListener('change', () => saveGameplaySettings({ uppercase: els.gameplayUppercase.checked }));
}
if (els.gameplayShowName) {
  els.gameplayShowName.addEventListener('change', () => saveGameplaySettings({ showName: els.gameplayShowName.checked }));
}
if (els.gameplayShowCount) {
  els.gameplayShowCount.addEventListener('change', () => saveGameplaySettings({ showCount: els.gameplayShowCount.checked }));
}
if (els.gameplayIconSize) {
  els.gameplayIconSize.addEventListener('input', () => {
    const iconSize = Math.max(28, Math.min(120, parseInt(els.gameplayIconSize.value, 10) || 54));
    if (els.gameplayIconSizeVal) els.gameplayIconSizeVal.textContent = `${iconSize}px`;
    appSettings.gameplay.iconSize = iconSize;
    renderGameplayReview();
    sendGameplayConfig();
  });
  els.gameplayIconSize.addEventListener('change', () => saveGameplaySettings({ iconSize: Math.max(28, Math.min(120, parseInt(els.gameplayIconSize.value, 10) || 54)) }));
}
if (els.gameplayCountSize) {
  els.gameplayCountSize.addEventListener('input', () => {
    const countSize = Math.max(9, Math.min(28, parseInt(els.gameplayCountSize.value, 10) || 12));
    if (els.gameplayCountSizeVal) els.gameplayCountSizeVal.textContent = `${countSize}px`;
    appSettings.gameplay.countSize = countSize;
    renderGameplayReview();
    sendGameplayConfig();
  });
  els.gameplayCountSize.addEventListener('change', () => saveGameplaySettings({ countSize: Math.max(9, Math.min(28, parseInt(els.gameplayCountSize.value, 10) || 12)) }));
}
if (els.gameplayItemGap) {
  els.gameplayItemGap.addEventListener('input', () => {
    const parsedItemGap = parseInt(els.gameplayItemGap.value, 10);
    const itemGap = Math.max(0, Math.min(60, Number.isFinite(parsedItemGap) ? parsedItemGap : 10));
    if (els.gameplayItemGapVal) els.gameplayItemGapVal.textContent = `${itemGap}px`;
    appSettings.gameplay.itemGap = itemGap;
    renderGameplayReview();
    sendGameplayConfig();
  });
  els.gameplayItemGap.addEventListener('change', () => {
    const parsedItemGap = parseInt(els.gameplayItemGap.value, 10);
    saveGameplaySettings({ itemGap: Math.max(0, Math.min(60, Number.isFinite(parsedItemGap) ? parsedItemGap : 10)) });
  });
}
if (els.gameplayEnlargeActive) {
  els.gameplayEnlargeActive.addEventListener('change', () => saveGameplaySettings({ enlargeActive: els.gameplayEnlargeActive.checked }));
}
if (els.gameplayActiveScale) {
  els.gameplayActiveScale.addEventListener('input', () => {
    const activeScale = Math.max(100, Math.min(200, parseInt(els.gameplayActiveScale.value, 10) || 140));
    if (els.gameplayActiveScaleVal) els.gameplayActiveScaleVal.textContent = `${activeScale}%`;
    appSettings.gameplay.activeScale = activeScale;
    renderGameplayReview();
    sendGameplayConfig();
  });
  els.gameplayActiveScale.addEventListener('change', () => saveGameplaySettings({ activeScale: Math.max(100, Math.min(200, parseInt(els.gameplayActiveScale.value, 10) || 140)) }));
}
if (els.gameplayCenterLargest) {
  els.gameplayCenterLargest.addEventListener('change', () => saveGameplaySettings({ centerLargest: els.gameplayCenterLargest.checked }));
}
if (els.gameplayGrayInactive) {
  els.gameplayGrayInactive.addEventListener('change', () => saveGameplaySettings({ grayInactive: els.gameplayGrayInactive.checked }));
}
if (els.gameplayKeepScore) {
  els.gameplayKeepScore.addEventListener('change', () => {
    if (els.gameplayKeepScore.checked) initializeGameplayScoreFromQueue();
    else gameplayScoreTotals.clear();
    saveGameplaySettings({ keepScore: els.gameplayKeepScore.checked });
  });
}
if (els.btnGameplayCopyUrl) {
  els.btnGameplayCopyUrl.onclick = async () => {
    sendGameplayConfig();
    syncGameplayCountsFromQueue();
    const r = await window.bigo.gameplayCopyUrl().catch(e => ({ ok: false, error: e.message }));
    if (r?.ok) appendLog('[gameplay] đã copy link OBS: ' + r.url);
    else alert(r?.error || 'Không copy được link Gameplay Overlay');
  };
}
if (els.btnGameplaySave) {
  els.btnGameplaySave.onclick = () => saveGameplayToObs().catch(e => alert('Lỗi lưu GROUP DANCE: ' + e.message));
}
if (els.gameplayItems) {
  els.gameplayItems.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-gpact]');
    if (!btn) return;
    const row = btn.closest('.gameplay-item');
    const iid = row?.dataset?.iid;
    if (!iid) return;
    normalizeGameplaySettings();
    const order = [...(appSettings.gameplay.order || [])];
    const idx = order.indexOf(iid);
    if (idx === -1) return;
    if (btn.dataset.gpact === 'up' && idx > 0) {
      [order[idx - 1], order[idx]] = [order[idx], order[idx - 1]];
      saveGameplaySettings({ order });
    } else if (btn.dataset.gpact === 'down' && idx < order.length - 1) {
      [order[idx], order[idx + 1]] = [order[idx + 1], order[idx]];
      saveGameplaySettings({ order });
    } else if (btn.dataset.gpact === 'toggle') {
      const hidden = new Set(appSettings.gameplay.hiddenIds || []);
      if (hidden.has(iid)) hidden.delete(iid); else hidden.add(iid);
      saveGameplaySettings({ hiddenIds: [...hidden] });
    }
  });
}
if (els.gameplayGridEditor) {
  els.gameplayGridEditor.addEventListener('click', (e) => {
    const open = e.target.closest('[data-slot-open]');
    if (open) {
      const cell = open.closest('.gameplay-grid-slot');
      const picker = cell?.querySelector('.slot-picker');
      if (!picker) return;
      els.gameplayGridEditor.querySelectorAll('.slot-picker').forEach(el => { if (el !== picker) el.hidden = true; });
      picker.hidden = !picker.hidden;
      return;
    }
    const pick = e.target.closest('[data-slot-pick]');
    if (pick) {
      const idx = parseInt(pick.dataset.slotPick, 10);
      const item = getGameplayItemById(pick.dataset.itemId);
      if (!item) return;
      const slots = [...(appSettings.gameplay.gridSlots || [])];
      slots[idx] = { ...(slots[idx] || {}), itemId: item.id, text: getGameplayItemName(item), visible: true };
      saveGameplaySettings({ gridSlots: slots });
      return;
    }
    const clear = e.target.closest('[data-slot-clear]');
    if (clear) {
      const idx = parseInt(clear.dataset.slotClear, 10);
      const slots = [...(appSettings.gameplay.gridSlots || [])];
      slots[idx] = { itemId: '', text: '', number: '', visible: false };
      saveGameplaySettings({ gridSlots: slots });
      return;
    }
    const visible = e.target.closest('[data-slot-visible]');
    if (visible) {
      const idx = parseInt(visible.dataset.slotVisible, 10);
      const slots = [...(appSettings.gameplay.gridSlots || [])];
      const slot = { ...(slots[idx] || {}) };
      if (!slot.itemId) return;
      slot.visible = slot.visible === false;
      slots[idx] = slot;
      saveGameplaySettings({ gridSlots: slots });
      return;
    }
  });
  els.gameplayGridEditor.addEventListener('input', (e) => {
    const input = e.target.closest('[data-slot-text], [data-slot-number]');
    if (!input) return;
    const isNumber = input.matches('[data-slot-number]');
    const idx = parseInt(isNumber ? input.dataset.slotNumber : input.dataset.slotText, 10);
    const slots = [...(appSettings.gameplay.gridSlots || [])];
    slots[idx] = { ...(slots[idx] || {}), [isNumber ? 'number' : 'text']: input.value };
    appSettings.gameplay.gridSlots = slots;
    renderGameplayReview();
    sendGameplayConfig();
  });
  els.gameplayGridEditor.addEventListener('focusout', (e) => {
    const input = e.target.closest('[data-slot-text], [data-slot-number]');
    if (!input) return;
    saveAppSettings({ gameplay: appSettings.gameplay }).catch(() => {});
  });
}
if (els.btnGameplayAddCol) {
  els.btnGameplayAddCol.onclick = () => resizeGameplayGrid((appSettings.gameplay?.gridCols || 5) + 1, appSettings.gameplay?.gridRows || 1);
}
if (els.btnGameplayAddRow) {
  els.btnGameplayAddRow.onclick = () => resizeGameplayGrid(appSettings.gameplay?.gridCols || 5, (appSettings.gameplay?.gridRows || 1) + 1);
}
if (els.btnGameplayDelCol) {
  els.btnGameplayDelCol.onclick = () => deleteGameplayGridColumn().catch(e => alert('Lỗi xoá cột: ' + e.message));
}
if (els.btnGameplayDelRow) {
  els.btnGameplayDelRow.onclick = () => deleteGameplayGridRow().catch(e => alert('Lỗi xoá hàng: ' + e.message));
}

// =================== Score Vote Overlay ===================
let scoreState = {
  status: 'idle',
  score: 0,
  target: 30000,
  durationMs: 180000,
  delayMs: 5000,
  startedAt: 0,
  runStartedAt: 0,
  prepEndAt: 0,
  endAt: 0,
  delayEndAt: 0,
  resultAt: 0,
  lastAdd: 0,
  lastAddUser: '',
  timeText: '03:00',
};
let scoreTimer = null;
let scoreLastAddTimer = null;
let scoreAutoResetTimer = null;
let scoreResultSoundPlayed = false;
let scoreWarningSoundPlayed = false;
let scoreGoalSoundPlayed = false;
const scoreGiftLog = [];
const scoreCountedEventKeys = new Set();
const scoreUserTotals = new Map();
const SCORE_LOG_MAX = 40;

function scoreEventKey(ev) {
  if (ev?.event_id) return `event:${ev.event_id}`;
  const total = giftTotalCountFromEvent(ev);
  const points = giftDiamondPointsFromEvent(ev);
  return [ev?.ts || ev?.time || '', ev?.user || '', ev?.gift_id || '', ev?.gift_name || '', total, points, ev?.raw || ''].join('|');
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
function scoreReadConfig() {
  const hours = clampInt(els.scoreHours?.value, 0, 24, 0);
  const minutes = clampInt(els.scoreMinutes?.value, 0, 59, 3);
  const seconds = clampInt(els.scoreSeconds?.value, 0, 59, 0);
  const delaySeconds = clampInt(els.scoreDelay?.value, 0, 120, 5);
  const target = Math.max(1, parseInt(els.scoreTarget?.value, 10) || 30000);
  return {
    hours, minutes, seconds, delaySeconds, target,
    memberGroupId: String(els.scoreMemberGroup?.value || '').trim(),
    memberId: String(els.scoreMember?.value || '').trim(),
    content: String(els.scoreContent?.value || '').trim() || 'Kêu gọi điểm ĐẬU',
    creatorName: String(els.scoreCreatorName?.value || '').trim() || 'Creator',
    creatorAvatar: String(els.scoreCreatorAvatar?.value || '').trim(),
    timeColor: String(els.scoreTimeColor?.value || '#ffffff').trim(),
    contentColor: String(els.scoreContentColor?.value || '#f0eef6').trim(),
    overColor: String(els.scoreOverColor?.value || '#ff0000').trim(),
    barColor1: String(els.scoreBarColor1?.value || '#b93678').trim(),
    barColor2: String(els.scoreBarColor2?.value || '#ff8ed1').trim(),
    waveColor: String(els.scoreWaveColor?.value || '#ffffff').trim(),
    bigGiftThreshold: Math.max(1, parseInt(els.scoreBigGiftThreshold?.value, 10) || 500),
    prepSeconds: clampInt(els.scorePrepSeconds?.value, 0, 30, 3),
    themePreset: String(els.scoreThemePreset?.value || 'custom'),
    barStyle: String(els.scoreBarStyle?.value || 'pill'),
    overlaySize: String(els.scoreOverlaySize?.value || 'medium'),
    customMilestones: String(els.scoreCustomMilestones?.value || '').trim(),
    showGiftUser: els.scoreShowGiftUser ? els.scoreShowGiftUser.checked : true,
    showMissing: els.scoreShowMissing ? els.scoreShowMissing.checked : true,
    showTopUsers: els.scoreShowTopUsers ? els.scoreShowTopUsers.checked : true,
    showSpeed: els.scoreShowSpeed ? els.scoreShowSpeed.checked : true,
    compactMode: els.scoreCompactMode ? els.scoreCompactMode.checked : false,
    hideAvatar: els.scoreHideAvatar ? els.scoreHideAvatar.checked : false,
    hideCreator: els.scoreHideCreator ? els.scoreHideCreator.checked : false,
  };
}
function scoreDurationMs(cfg) {
  const ms = ((cfg.hours * 3600) + (cfg.minutes * 60) + cfg.seconds) * 1000;
  return Math.max(1000, ms || 180000);
}
function formatScoreTime(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function scorePublicState() {
  const cfg = scoreReadConfig();
  const status = scoreState.status || 'idle';
  return { ...scoreState, ...cfg, hidden: false, topUsers: scoreTopUsers(), customMilestoneValues: scoreMilestoneValues(cfg.customMilestones, cfg.target) };
}

function scoreMilestoneValues(text, target) {
  return String(text || '').split(/[;,\s]+/).map(v => Math.round(Number(v) || 0)).filter(v => v > 0 && v < target).slice(0, 8);
}

function scoreTopUsers(limit = 3) {
  return [...scoreUserTotals.values()].sort((a, b) => b.points - a.points || b.gifts - a.gifts).slice(0, limit).map(item => ({ user: item.user, points: item.points, gifts: item.gifts }));
}

function scoreMetrics(state = scorePublicState()) {
  const target = Math.max(1, Number(state.target) || 1);
  const score = Math.max(0, Number(state.score) || 0);
  const elapsedMs = state.runStartedAt ? Math.max(0, Date.now() - state.runStartedAt) : 0;
  const avgPerMin = elapsedMs > 5000 ? Math.round(score / (elapsedMs / 60000)) : 0;
  const remainingMs = state.status === 'running' ? Math.max(0, state.endAt - Date.now()) : 0;
  const projected = avgPerMin && remainingMs ? Math.round(score + avgPerMin * (remainingMs / 60000)) : 0;
  return { missing: Math.max(0, target - score), over: Math.max(0, score - target), pct: Math.max(0, Math.min(100, (score / target) * 100)), avgPerMin, projected };
}

function playScoreCue(kind) {
  const cfg = appSettings.scoreVote || {};
  const src = cfg[`${kind}Sound`];
  if (!src) return;
  try {
    const audio = new Audio(src);
    audio.volume = Math.max(0, Math.min(1, (appSettings.fxVolume || 100) / 100));
    audio.play().catch(() => {});
  } catch {}
}

function playScoreResultSound(status) {
  if (scoreResultSoundPlayed) return;
  scoreResultSoundPlayed = true;
  playScoreCue(status === 'success' ? 'success' : 'fail');
}

function setScoreStatus(status) {
  if (scoreState.status === status) return;
  scoreState.status = status;
  if (status === 'success' || status === 'failed') {
    scoreState.resultAt = Date.now();
    playScoreResultSound(status);
    rankingStopVote({ incrementRound: true });
  }
}

async function pickScoreSound(kind) {
  const r = await window.bigo.effectsPickFiles();
  if (!r.ok || !r.files?.length) return;
  const picked = r.files[0];
  const soundSrc = picked.fileUrl || picked.file;
  appSettings.scoreVote[`${kind}Sound`] = soundSrc;
  appSettings.scoreVote[`${kind}SoundName`] = picked.fileName;
  const label = els[`score${kind[0].toUpperCase()}${kind.slice(1)}SoundLabel`];
  if (label) label.value = picked.fileName;
  await saveAppSettings({ scoreVote: { [`${kind}Sound`]: soundSrc, [`${kind}SoundName`]: picked.fileName } });
}

async function clearScoreSound(kind) {
  appSettings.scoreVote[`${kind}Sound`] = '';
  appSettings.scoreVote[`${kind}SoundName`] = '';
  const label = els[`score${kind[0].toUpperCase()}${kind.slice(1)}SoundLabel`];
  if (label) label.value = '';
  await saveAppSettings({ scoreVote: { [`${kind}Sound`]: '', [`${kind}SoundName`]: '' } });
}
function pushScoreState() {
  const publicState = scorePublicState();
  renderScorePreview(publicState);
  renderScoreMcReview(publicState);
  updateScoreButtons(publicState.status);
  if (window.bigo.scoreUpdate) window.bigo.scoreUpdate(publicState).catch(() => {});
}
function updateScoreButtons(status = scoreState.status) {
  const active = status && status !== 'idle';
  if (els.btnScoreStart) els.btnScoreStart.style.display = active ? 'none' : '';
  if (els.btnScoreStop) els.btnScoreStop.style.display = active ? '' : 'none';
}
function renderScorePreview(state = scorePublicState()) {
  if (!els.scorePreview) return;
  const target = Math.max(1, Number(state.target) || 1);
  const score = Math.max(0, Number(state.score) || 0);
  const metrics = scoreMetrics(state);
  const { over, pct, missing, avgPerMin, projected } = metrics;
  const popLeft = Math.max(11, Math.min(88, pct));
  const status = state.status || 'idle';
  const statusText = status === 'success' ? 'THÀNH CÔNG' : (status === 'failed' ? 'KHÔNG HOÀN THÀNH' : (state.timeText || '03:00'));
  const avatar = state.creatorAvatar || '';
  const activeRunner = ['running', 'grace'].includes(status) && !!state.lastAdd;
  const runnerUser = state.showGiftUser !== false && state.lastAddUser ? `${state.lastAddUser} ` : '';
  const runnerPoints = state.lastAdd ? `+${Number(state.lastAdd).toLocaleString('en-US')}` : '';
  const runnerAtStart = pct < 28;
  const remainingMs = status === 'running' ? Math.max(0, state.endAt - Date.now()) : 0;
  const urgent = ['running', 'grace'].includes(status) && remainingMs <= 10000 && remainingMs > 0;
  const nearGoal = ['running', 'grace'].includes(status) && pct >= 80 && score < target;
  const milestoneValues = Array.isArray(state.customMilestoneValues) ? state.customMilestoneValues : [];
  const milestones = milestoneValues.map(v => `<span class="score-preview-marker ${score >= v ? 'reached' : ''}" style="left:${Math.max(0, Math.min(100, (v / target) * 100))}%"></span>`).join('');
  const topUsers = Array.isArray(state.topUsers) ? state.topUsers : [];
  const topText = topUsers.length ? topUsers.map(u => `${escapeHtml(u.user || '?')} ${Number(u.points || 0).toLocaleString('en-US')}`).join(' | ') : '';
  const predictionText = avgPerMin ? (projected >= target ? 'Dự kiến đạt' : 'Cần tăng tốc') : 'Đang tính tốc độ';
  els.scorePreview.className = `score-preview status-${status} theme-${state.themePreset || 'custom'} size-${state.overlaySize || 'medium'} bar-${state.barStyle || 'pill'}${state.compactMode ? ' compact' : ''}${activeRunner ? ' has-add' : ''}${urgent ? ' urgent' : ''}${nearGoal ? ' near-goal' : ''}`;
  els.scorePreview.style.setProperty('--score-time-color', state.timeColor || '#ffffff');
  els.scorePreview.style.setProperty('--score-content-color', state.contentColor || '#f0eef6');
  els.scorePreview.style.setProperty('--score-over-color', state.overColor || '#ff0000');
  els.scorePreview.style.setProperty('--score-bar-color-1', state.barColor1 || '#b93678');
  els.scorePreview.style.setProperty('--score-bar-color-2', state.barColor2 || '#ff8ed1');
  els.scorePreview.style.setProperty('--score-wave-color', state.waveColor || '#ffffff');
  els.scorePreview.innerHTML = `
    <div class="score-preview-time">${escapeHtml(statusText)}</div>
    <div class="score-preview-bar" style="--score-pct:${pct}%"><div class="score-preview-fill" style="width:${pct}%"></div><div class="score-preview-flash"></div><div class="score-preview-wave"></div>${milestones}${over > 0 ? `<div class="score-preview-over">+Over: ${over.toLocaleString('en-US')}</div>` : ''}${activeRunner ? `<div class="score-preview-pop ${Number(state.lastAdd) >= Number(state.bigGiftThreshold || 500) ? 'big' : ''} ${runnerAtStart ? 'at-start' : ''}" style="left:${runnerAtStart ? 6 : popLeft}${runnerAtStart ? 'px' : '%'}"><span>${escapeHtml(runnerUser)}${runnerPoints}</span><b>🏃</b></div>` : ''}<div class="score-preview-flag">⚑</div></div>
    <div class="score-preview-meta">
      ${state.hideAvatar ? '' : `<div class="score-preview-avatar">${avatar ? `<img src="${escapeHtml(avatar)}" />` : '👤'}</div>`}
      ${state.hideCreator ? '' : `<b>${escapeHtml(state.creatorName || 'Creator')}</b>`}
      <span>${escapeHtml(state.content || 'Kêu gọi điểm ĐẬU')}</span>
      <b>Điểm: ${score.toLocaleString('en-US')}/${target.toLocaleString('en-US')}</b>
    </div>
    ${state.showTopUsers !== false && topText ? `<div class="score-preview-extra">Top: ${topText}</div>` : ''}
    ${state.showSpeed !== false ? `<div class="score-preview-extra">${escapeHtml(predictionText)}</div>` : ''}`;
}
function scoreStatusLabel(status) {
  if (status === 'prestart') return 'CHUẨN BỊ';
  if (status === 'running') return 'ĐANG CHẠY';
  if (status === 'grace') return 'ĐANG CHỜ QUÀ TRỄ';
  if (status === 'success') return 'THÀNH CÔNG';
  if (status === 'failed') return 'KHÔNG HOÀN THÀNH';
  return 'CHƯA CHẠY';
}
function renderScoreMcReview(state = scorePublicState()) {
  const target = Math.max(1, Number(state.target) || 1);
  const score = Math.max(0, Number(state.score) || 0);
  const { missing, over, pct, avgPerMin, projected } = scoreMetrics(state);
  const status = state.status || 'idle';
  if (els.scoreReviewStatus) {
    els.scoreReviewStatus.textContent = scoreStatusLabel(status);
    els.scoreReviewStatus.className = `score-review-status status-${status}`;
  }
  if (els.scoreReviewStats) {
    const giftCount = scoreGiftLog.length;
    const delayText = status === 'grace' ? state.timeText : `${Math.round((state.delayMs || 0) / 1000)}s`;
    const predictText = avgPerMin ? (projected >= target ? 'Dự kiến đạt' : 'Cần tăng tốc') : '—';
    els.scoreReviewStats.innerHTML = `
      <div class="score-stat-card primary"><span>Điểm hiện tại</span><b>${score.toLocaleString('en-US')}</b></div>
      <div class="score-stat-card ${over > 0 ? 'over' : ''}"><span>${over > 0 ? '+Over: số dư' : 'Còn thiếu'}</span><b>${(over > 0 ? over : missing).toLocaleString('en-US')}</b></div>
      <div class="score-stat-card"><span>Tiến độ</span><b>${pct.toFixed(1).replace('.0', '')}%</b></div>
      <div class="score-stat-card"><span>Thời gian</span><b>${escapeHtml(state.timeText || '03:00')}</b></div>
      <div class="score-stat-card"><span>Trễ quà</span><b>${escapeHtml(delayText)}</b></div>
      <div class="score-stat-card"><span>Tốc độ</span><b>${avgPerMin ? `${avgPerMin.toLocaleString('en-US')}/phút` : '—'}</b></div>
      <div class="score-stat-card"><span>Dự đoán</span><b>${escapeHtml(predictText)}</b></div>
      <div class="score-stat-card"><span>Lượt quà tính</span><b>${giftCount.toLocaleString('en-US')}</b></div>`;
  }
  if (els.scoreGiftLog) {
    if (!scoreGiftLog.length) {
      els.scoreGiftLog.innerHTML = '<div class="score-log-empty">Chưa có quà nào được tính điểm trong phiên này.</div>';
    } else {
      els.scoreGiftLog.innerHTML = scoreGiftLog.map(item => {
      const icon = item.gift_icon ? `<img class="score-log-icon" src="${escapeHtml(item.gift_icon)}" loading="lazy" />` : '<div class="score-log-icon empty"></div>';
      const avatar = item.avatar ? `<img class="score-log-avatar" src="${escapeHtml(item.avatar)}" loading="lazy" />` : '';
      const countText = item.count > 1 ? ` ×${item.count}` : '';
      return `<div class="score-log-row">
        ${avatar}${icon}
        <div class="score-log-main">
          <div><b>${escapeHtml(item.user || '?')}</b> <span>tặng ${escapeHtml(item.gift_name || '?')}${countText}</span></div>
          <small>${escapeHtml(item.timeText)}</small>
        </div>
        <div class="score-log-points">+${item.points.toLocaleString('en-US')}</div>
      </div>`;
      }).join('');
    }
  }
  renderScoreUserTotals();
}

function renderScoreUserTotals() {
  if (!els.scoreUserTotals) return;
  const rows = [...scoreUserTotals.values()].sort((a, b) => b.points - a.points || b.gifts - a.gifts);
  if (!rows.length) {
    els.scoreUserTotals.innerHTML = '<div class="score-user-summary">Tổng số người tặng: 0</div><div class="score-log-empty">Chưa có user nào tặng điểm trong vòng đấu.</div>';
    return;
  }
  const totalUsers = rows.length;
  els.scoreUserTotals.innerHTML = `<div class="score-user-summary">Tổng số người tặng: ${totalUsers.toLocaleString('en-US')}</div>` + rows.map((item, idx) => {
    const avatar = item.avatar ? `<img class="score-log-avatar" src="${escapeHtml(item.avatar)}" loading="lazy" />` : '<div class="score-log-avatar empty">👤</div>';
    return `<div class="score-user-row">
      <div class="score-user-rank">${idx + 1}</div>
      ${avatar}
      <div class="score-user-main">
        <b>${escapeHtml(item.user || '?')}</b>
        <small>${item.gifts.toLocaleString('en-US')} lượt tặng</small>
      </div>
      <div class="score-user-points">${item.points.toLocaleString('en-US')}</div>
    </div>`;
  }).join('');
}
function applyScoreSettingsUi() {
  const cfg = appSettings.scoreVote || {};
  if (els.scoreHours) els.scoreHours.value = cfg.hours ?? 0;
  if (els.scoreMinutes) els.scoreMinutes.value = cfg.minutes ?? 3;
  if (els.scoreSeconds) els.scoreSeconds.value = cfg.seconds ?? 0;
  if (els.scoreDelay) els.scoreDelay.value = cfg.delaySeconds ?? 5;
  if (els.scoreTarget) els.scoreTarget.value = cfg.target ?? 30000;
  renderScoreMemberSelectors();
  if (els.scoreMemberGroup) els.scoreMemberGroup.value = cfg.memberGroupId || '';
  renderScoreMemberSelectors();
  if (els.scoreMember) els.scoreMember.value = cfg.memberId || '';
  if (els.scoreContent) els.scoreContent.value = cfg.content || 'Kêu gọi điểm ĐẬU';
  if (els.scoreCreatorName) els.scoreCreatorName.value = cfg.creatorName || 'Creator';
  if (els.scoreCreatorAvatar) els.scoreCreatorAvatar.value = cfg.creatorAvatar || '';
  if (els.scoreTimeColor) els.scoreTimeColor.value = cfg.timeColor || '#ffffff';
  if (els.scoreContentColor) els.scoreContentColor.value = cfg.contentColor || '#f0eef6';
  if (els.scoreOverColor) els.scoreOverColor.value = cfg.overColor || '#ff0000';
  if (els.scoreBarColor1) els.scoreBarColor1.value = cfg.barColor1 || '#b93678';
  if (els.scoreBarColor2) els.scoreBarColor2.value = cfg.barColor2 || '#ff8ed1';
  if (els.scoreWaveColor) els.scoreWaveColor.value = cfg.waveColor || '#ffffff';
  if (els.scoreBigGiftThreshold) els.scoreBigGiftThreshold.value = cfg.bigGiftThreshold ?? 500;
  if (els.scorePrepSeconds) els.scorePrepSeconds.value = cfg.prepSeconds ?? 3;
  if (els.scoreThemePreset) els.scoreThemePreset.value = cfg.themePreset || 'custom';
  if (els.scoreBarStyle) els.scoreBarStyle.value = cfg.barStyle || 'pill';
  if (els.scoreOverlaySize) els.scoreOverlaySize.value = cfg.overlaySize || 'medium';
  if (els.scoreCustomMilestones) els.scoreCustomMilestones.value = cfg.customMilestones || '';
  if (els.scoreShowGiftUser) els.scoreShowGiftUser.checked = cfg.showGiftUser !== false;
  if (els.scoreShowMissing) els.scoreShowMissing.checked = cfg.showMissing !== false;
  if (els.scoreShowTopUsers) els.scoreShowTopUsers.checked = cfg.showTopUsers !== false;
  if (els.scoreShowSpeed) els.scoreShowSpeed.checked = cfg.showSpeed !== false;
  if (els.scoreCompactMode) els.scoreCompactMode.checked = !!cfg.compactMode;
  if (els.scoreHideAvatar) els.scoreHideAvatar.checked = !!cfg.hideAvatar;
  if (els.scoreHideCreator) els.scoreHideCreator.checked = !!cfg.hideCreator;
  if (els.scoreStartSoundLabel) els.scoreStartSoundLabel.value = cfg.startSoundName || '';
  if (els.scoreWarningSoundLabel) els.scoreWarningSoundLabel.value = cfg.warningSoundName || '';
  if (els.scoreGoalSoundLabel) els.scoreGoalSoundLabel.value = cfg.goalSoundName || '';
  if (els.scoreSuccessSoundLabel) els.scoreSuccessSoundLabel.value = cfg.successSoundName || '';
  if (els.scoreFailSoundLabel) els.scoreFailSoundLabel.value = cfg.failSoundName || '';
  scoreState.target = cfg.target || 30000;
  scoreState.durationMs = scoreDurationMs(scoreReadConfig());
  scoreState.delayMs = (cfg.delaySeconds ?? 5) * 1000;
  scoreState.timeText = formatScoreTime(scoreState.durationMs);
  pushScoreState();
}
function persistScoreConfig() {
  const cfg = scoreReadConfig();
  appSettings.scoreVote = { ...appSettings.scoreVote, ...cfg };
  saveAppSettings({ scoreVote: cfg }).catch(() => {});
  scoreState.target = cfg.target;
  pushScoreState();
}

function applyScoreThemePreset() {
  const presets = {
    douyin: ['#b93678', '#ff8ed1', '#ffffff', '#ff0000'],
    vip: ['#b76b00', '#ffd36a', '#fff4c1', '#ffea7a'],
    neon: ['#00a6ff', '#35ffcf', '#e7ffff', '#70fff0'],
    battle: ['#8f101f', '#ff4b4b', '#ffe1e1', '#ff3b3b'],
    luxury: ['#4c2a85', '#c79cff', '#f6edff', '#d7b8ff'],
    minimal: ['#6b7280', '#d1d5db', '#ffffff', '#ffffff'],
  };
  const value = els.scoreThemePreset?.value || 'custom';
  const colors = presets[value];
  if (!colors) return persistScoreConfig();
  if (els.scoreBarColor1) els.scoreBarColor1.value = colors[0];
  if (els.scoreBarColor2) els.scoreBarColor2.value = colors[1];
  if (els.scoreWaveColor) els.scoreWaveColor.value = colors[2];
  if (els.scoreOverColor) els.scoreOverColor.value = colors[3];
  persistScoreConfig();
}
function scoreTick() {
  const now = Date.now();
  if (scoreState.status === 'prestart') {
    const remainingPrep = scoreState.prepEndAt - now;
    const secondsLeft = Math.ceil(remainingPrep / 1000);
    scoreState.timeText = secondsLeft > 0 ? String(secondsLeft) : 'BẮT ĐẦU';
    if (remainingPrep <= -450) scoreBeginRunning(now);
  }
  if (scoreState.status === 'running') {
    const remaining = scoreState.endAt - now;
    scoreState.timeText = formatScoreTime(remaining);
    if (remaining <= 10000 && remaining > 0 && !scoreWarningSoundPlayed) {
      scoreWarningSoundPlayed = true;
      playScoreCue('warning');
    }
    if (remaining <= 0) setScoreStatus(scoreState.delayMs > 0 ? 'grace' : (scoreState.score >= scoreState.target ? 'success' : 'failed'));
  }
  if (scoreState.status === 'grace') {
    const remainingDelay = scoreState.delayEndAt - now;
    scoreState.timeText = 'ĐANG TÍNH ĐIỂM';
    if (remainingDelay <= 0) setScoreStatus(scoreState.score >= scoreState.target ? 'success' : 'failed');
  }
  pushScoreState();
  if (!['prestart', 'running', 'grace'].includes(scoreState.status) && scoreTimer) {
    clearInterval(scoreTimer);
    scoreTimer = null;
  }
}

function scoreBeginRunning(now = Date.now()) {
  const durationMs = scoreState.durationMs || scoreDurationMs(scoreReadConfig());
  scoreState.status = 'running';
  scoreState.runStartedAt = now;
  scoreState.endAt = now + durationMs;
  scoreState.delayEndAt = now + durationMs + (scoreState.delayMs || 0);
  scoreState.timeText = formatScoreTime(durationMs);
  playScoreCue('start');
}
function scoreStart(opts = {}) {
  if (!isConnected) {
    alert('Vui lòng kết nối LIVE để sử dụng tính năng');
    return;
  }
  const cfg = scoreReadConfig();
  appSettings.scoreVote = { ...appSettings.scoreVote, ...cfg };
  saveAppSettings({ scoreVote: cfg }).catch(() => {});
  const now = Date.now();
  const durationMs = scoreDurationMs(cfg);
  const delayMs = cfg.delaySeconds * 1000;
  const prepMs = Math.max(0, Number(cfg.prepSeconds) || 0) * 1000;
  scoreCountedEventKeys.clear();
  if (scoreAutoResetTimer) clearTimeout(scoreAutoResetTimer);
  scoreResultSoundPlayed = false;
  scoreWarningSoundPlayed = false;
  scoreGoalSoundPlayed = false;
  scoreState = {
    ...scoreState,
    status: prepMs > 0 ? 'prestart' : 'running',
    target: cfg.target,
    durationMs,
    delayMs,
    startedAt: now,
    runStartedAt: prepMs > 0 ? 0 : now,
    prepEndAt: now + prepMs,
    endAt: prepMs > 0 ? 0 : now + durationMs,
    delayEndAt: prepMs > 0 ? 0 : now + durationMs + delayMs,
    resultAt: 0,
    lastAdd: 0,
    lastAddUser: '',
    timeText: prepMs > 0 ? String(Math.ceil(prepMs / 1000)) : formatScoreTime(durationMs),
  };
  if (!prepMs) playScoreCue('start');
  if (scoreTimer) clearInterval(scoreTimer);
  scoreTimer = setInterval(scoreTick, 250);
  if (!opts.fromRanking && appSettings.ranking?.activeId) rankingStartVote({ syncScore: false });
  scoreTick();
}
function scoreStop(opts = {}) {
  setScoreStatus('idle');
  if (scoreTimer) clearInterval(scoreTimer);
  if (scoreAutoResetTimer) clearTimeout(scoreAutoResetTimer);
  scoreTimer = null;
  scoreState.timeText = formatScoreTime(scoreDurationMs(scoreReadConfig()));
  if (!opts.fromRanking) rankingStopVote();
  pushScoreState();
}
function scoreReset(opts = {}) {
  if (scoreAutoResetTimer) clearTimeout(scoreAutoResetTimer);
  scoreState.score = 0;
  scoreState.lastAdd = 0;
  scoreState.lastAddUser = '';
  scoreState.runStartedAt = 0;
  scoreState.prepEndAt = 0;
  scoreState.endAt = 0;
  scoreState.delayEndAt = 0;
  setScoreStatus('idle');
  scoreResultSoundPlayed = false;
  scoreWarningSoundPlayed = false;
  scoreGoalSoundPlayed = false;
  scoreGiftLog.length = 0;
  scoreCountedEventKeys.clear();
  scoreUserTotals.clear();
  if (scoreTimer) clearInterval(scoreTimer);
  scoreTimer = null;
  scoreState.timeText = formatScoreTime(scoreDurationMs(scoreReadConfig()));
  scoreState.resultAt = 0;
  if (!opts.silent) pushScoreState();
}
function scoreAdd(points, ev = null) {
  const n = Math.max(0, Math.round(Number(points) || 0));
  if (!n || !['running', 'grace'].includes(scoreState.status)) return;
  scoreState.score += n;
  scoreState.lastAdd = n;
  scoreState.lastAddUser = ev?.user || '';
  if (!scoreGoalSoundPlayed && scoreState.score >= scoreState.target) {
    scoreGoalSoundPlayed = true;
    playScoreCue('goal');
  }
  if (ev) {
    const count = ev.total_count != null ? ev.total_count : ((ev.gift_count || 1) * (ev.combo || 1));
    const user = ev.user || '?';
    const currentUserTotal = scoreUserTotals.get(user) || { user, avatar: resolveAvatarForUser(ev.user, ev.user_avatar_url), points: 0, gifts: 0 };
    currentUserTotal.points += n;
    currentUserTotal.gifts += 1;
    if (!currentUserTotal.avatar) currentUserTotal.avatar = resolveAvatarForUser(ev.user, ev.user_avatar_url);
    scoreUserTotals.set(user, currentUserTotal);
    scoreGiftLog.unshift({
      user,
      avatar: resolveAvatarForUser(ev.user, ev.user_avatar_url),
      gift_name: ev.gift_name || '?',
      gift_icon: ev.gift_icon || ev.gift_icon_url || '',
      count: Math.max(1, count || 1),
      points: n,
      timeText: new Date().toLocaleTimeString(),
    });
    if (scoreGiftLog.length > SCORE_LOG_MAX) scoreGiftLog.length = SCORE_LOG_MAX;
  }
  if (scoreLastAddTimer) clearTimeout(scoreLastAddTimer);
  scoreLastAddTimer = setTimeout(() => { scoreState.lastAdd = 0; scoreState.lastAddUser = ''; pushScoreState(); }, 2400);
  pushScoreState();
}
function scoreHandleGift(ev) {
  if (!ev || ev.type !== 'gift') return;
  const key = scoreEventKey(ev);
  if (scoreCountedEventKeys.has(key)) return;
  scoreCountedEventKeys.add(key);
  if (scoreCountedEventKeys.size > 1200) scoreCountedEventKeys.clear();
  scoreAdd(giftDiamondPointsFromEvent(ev), ev);
}
['scoreHours','scoreMinutes','scoreSeconds','scoreDelay','scoreTarget','scoreMemberGroup','scoreMember','scoreContent','scoreCreatorName','scoreCreatorAvatar','scoreTimeColor','scoreContentColor','scoreOverColor','scoreBarColor1','scoreBarColor2','scoreWaveColor','scoreBigGiftThreshold','scorePrepSeconds','scoreThemePreset','scoreBarStyle','scoreOverlaySize','scoreCustomMilestones','scoreShowGiftUser','scoreShowMissing','scoreShowTopUsers','scoreShowSpeed','scoreCompactMode','scoreHideAvatar','scoreHideCreator'].forEach(id => {
  const el = els[id];
  if (el) el.addEventListener('change', id === 'scoreThemePreset' ? applyScoreThemePreset : persistScoreConfig);
  if (el && ['scoreContent','scoreCreatorName','scoreCreatorAvatar','scoreTimeColor','scoreContentColor','scoreOverColor','scoreBarColor1','scoreBarColor2','scoreWaveColor','scoreCustomMilestones'].includes(id)) el.addEventListener('input', () => { persistScoreConfig(); });
});
if (els.scoreMemberGroup) {
  els.scoreMemberGroup.addEventListener('change', () => {
    renderScoreMemberSelectors();
    persistScoreConfig();
  });
}
if (els.scoreMember) els.scoreMember.addEventListener('change', applyScoreSelectedMember);
function scoreEnsureTestRunning() {
  if (['running', 'grace'].includes(scoreState.status)) return;
  const cfg = scoreReadConfig();
  const now = Date.now();
  scoreResultSoundPlayed = false;
  scoreWarningSoundPlayed = false;
  scoreGoalSoundPlayed = false;
  scoreState = { ...scoreState, status: 'running', target: cfg.target, durationMs: scoreDurationMs(cfg), delayMs: cfg.delaySeconds * 1000, startedAt: now, runStartedAt: now, prepEndAt: 0, endAt: now + scoreDurationMs(cfg), delayEndAt: now + scoreDurationMs(cfg) + cfg.delaySeconds * 1000, resultAt: 0, timeText: formatScoreTime(scoreDurationMs(cfg)) };
  if (scoreTimer) clearInterval(scoreTimer);
  scoreTimer = setInterval(scoreTick, 250);
}
if (els.btnScoreStart) els.btnScoreStart.onclick = scoreStart;
if (els.btnScoreStop) els.btnScoreStop.onclick = scoreStop;
if (els.btnScoreReset) els.btnScoreReset.onclick = scoreReset;
if (els.btnScoreTest) els.btnScoreTest.onclick = () => {
  const n = Math.max(1, parseInt(els.scoreTestPoints?.value, 10) || 100);
  scoreEnsureTestRunning();
  scoreAdd(n, { user: 'MC Test', gift_name: 'Test Đậu', total_count: 1, total_diamond: n });
};
if (els.btnScoreTestBig) els.btnScoreTestBig.onclick = () => {
  const n = Math.max(1, Number(scoreReadConfig().bigGiftThreshold) || 500);
  scoreEnsureTestRunning();
  scoreAdd(n, { user: 'User Quà Lớn', gift_name: 'Quà lớn', total_count: 1, total_diamond: n });
};
if (els.btnScoreTestWarning) els.btnScoreTestWarning.onclick = () => {
  scoreEnsureTestRunning();
  scoreState.endAt = Date.now() + 10000;
  scoreState.delayEndAt = scoreState.endAt + scoreState.delayMs;
  scoreWarningSoundPlayed = false;
  pushScoreState();
};
if (els.btnScoreTestSuccess) els.btnScoreTestSuccess.onclick = () => {
  scoreEnsureTestRunning();
  scoreState.score = Math.max(scoreState.score, scoreReadConfig().target);
  setScoreStatus('success');
  pushScoreState();
};
if (els.btnScoreTestFail) els.btnScoreTestFail.onclick = () => {
  scoreEnsureTestRunning();
  scoreState.score = Math.min(scoreState.score, scoreReadConfig().target - 1);
  setScoreStatus('failed');
  pushScoreState();
};
if (els.btnScorePickStartSound) els.btnScorePickStartSound.onclick = () => pickScoreSound('start');
if (els.btnScoreClearStartSound) els.btnScoreClearStartSound.onclick = () => clearScoreSound('start');
if (els.btnScorePickWarningSound) els.btnScorePickWarningSound.onclick = () => pickScoreSound('warning');
if (els.btnScoreClearWarningSound) els.btnScoreClearWarningSound.onclick = () => clearScoreSound('warning');
if (els.btnScorePickGoalSound) els.btnScorePickGoalSound.onclick = () => pickScoreSound('goal');
if (els.btnScoreClearGoalSound) els.btnScoreClearGoalSound.onclick = () => clearScoreSound('goal');
if (els.btnScorePickSuccessSound) els.btnScorePickSuccessSound.onclick = () => pickScoreSound('success');
if (els.btnScoreClearSuccessSound) els.btnScoreClearSuccessSound.onclick = () => clearScoreSound('success');
if (els.btnScorePickFailSound) els.btnScorePickFailSound.onclick = () => pickScoreSound('fail');
if (els.btnScoreClearFailSound) els.btnScoreClearFailSound.onclick = () => clearScoreSound('fail');
if (els.btnScoreCopyUrl) {
  els.btnScoreCopyUrl.onclick = async () => {
    pushScoreState();
    const r = await window.bigo.scoreCopyUrl().catch(e => ({ ok: false, error: e.message }));
    if (r?.ok) appendLog('[score] đã copy link OBS: ' + r.url);
    else alert(r?.error || 'Không copy được link Tính điểm');
  };
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
  renderGroupMemberPicker(grp);
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
    grp.memberIds = Array.from(document.querySelectorAll('#grpDlgMembers input[type="checkbox"]:checked')).map(input => input.value);
    grp.bgmFile = editingGrpBgmFile;
    grp.bgmFileName = editingGrpBgmName;
    await persistMapping();
    renderGiftTable();
    renderSettingsGroupsList();
    applyActiveBgm();
    renderScoreMemberSelectors();
    renderRankingMemberSelectors();
    renderGiftTable();
  };
}

// =================== Quản lý nhóm trong tab Cài đặt ===================
async function settingsGroupRename(gid) {
  const g = findGroupById(gid);
  if (!g) { alert('Nhóm không tồn tại (gid=' + gid + ')'); return; }
  if (g.isCommon) { alert('Không thể đổi tên NHÓM CHUNG'); return; }
  openGroupEditDialog(g);
}

async function settingsGroupDelete(gid) {
  const g = findGroupById(gid);
  if (!g) return;
  if (g.isCommon) { alert('Không thể xoá NHÓM CHUNG'); return; }
  const itemCount = (g.items || []).length;
  const ok = await appConfirm({
    title: 'Xoá nhóm?',
    message: `Xoá nhóm "${g.name}"?`,
    detail: itemCount > 0 ? `${itemCount} quà bên trong sẽ tự động chuyển về NHÓM CHUNG, không mất cấu hình quà.` : 'Thao tác này không thể hoàn tác.',
    okText: 'Có, xoá nhóm',
    cancelText: 'Không',
    danger: true,
  });
  if (!ok) return;
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
      <span class="count member-count">${getGroupMembers(g).length} thành viên</span>
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
    e.stopPropagation();
    await settingsGroupRename(renameBtn.dataset.gid);
    return;
  }
  // Settings groups list — nút Xoá
  const delBtn = e.target.closest('[data-glsact="del"]');
  if (delBtn) {
    e.preventDefault();
    e.stopPropagation();
    await settingsGroupDelete(delBtn.dataset.gid);
    return;
  }
  // Nút + Tạo nhóm
  if (e.target.closest('#btnCreateGroup')) {
    e.preventDefault();
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
let bgmResumeAt = 0;
function pauseBgmForEffect() {
  if (!els.bgmAudio || !els.bgmAudio.src) return;
  // Chỉ pause nếu đang phát (nếu đã pause thủ công thì không can thiệp)
  if (!els.bgmAudio.paused) {
    bgmResumeAt = els.bgmAudio.currentTime || 0;
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
    // Giữ vị trí cũ nếu browser/audio device reset currentTime khi pause/resume.
    if (bgmResumeAt > 0 && (els.bgmAudio.currentTime || 0) < 0.25) {
      try { els.bgmAudio.currentTime = bgmResumeAt; } catch {}
    }
    els.bgmAudio.play().catch(() => {});
  }
}
function syncBgmAfterQueueChange() {
  const shouldStayPaused = queueItems.some(q => q.status === 'playing' && q.pauseBgm);
  if (!shouldStayPaused) resumeBgmAfterEffect();
}
// Hook IPC overlay:queue-empty từ main process
if (window.bigo.onOverlayQueueEmpty) {
  window.bigo.onOverlayQueueEmpty(() => {
    syncBgmAfterQueueChange();
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
    btn.textContent = '♫';
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
