const { app, BrowserWindow, ipcMain, nativeImage, dialog, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { BigoClient } = require('./bigo-client');
const { BigoWebListener } = require('./web-embed');
const { OverlayManager } = require('./overlay-manager');
const { ObsOverlayServer } = require('./obs-overlay-server');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config', 'settings.json');
const MAPPING_PATH = path.join(ROOT, 'config', 'gift-mapping.json');
const GIFT_MASTER_PATH = path.join(ROOT, 'config', 'gift-master.json');
const EFFECTS_DIR = path.join(ROOT, 'assets', 'effects');
const GIFT_ICONS_DIR = path.join(ROOT, 'assets', 'gift-icons');
const GIFT_MASTER_TTL = 24 * 3600 * 1000; // 24h

// App icon — Windows ưu tiên .ico, fallback .png
const ICO_PATH = path.join(ROOT, 'logo-hp.ico');
const PNG_PATH = path.join(ROOT, 'logo-hp.png');
const APP_ICON = fs.existsSync(ICO_PATH) ? ICO_PATH : (fs.existsSync(PNG_PATH) ? PNG_PATH : null);
app.setName('HP Action - Bigo LIVE');
process.title = 'HP Action - Bigo LIVE';

// Windows: set AppUserModelID để taskbar group đúng và hiện icon
if (process.platform === 'win32') {
  app.setAppUserModelId('com.hp.bigoaction');
}

let win;
let client = null;
let listener = null;
let overlayManager = null;
let obsOverlayServer = null;
let queuePopup = null;
let heartOverlay = null;
let chatsPopup = null;
let giftsPopup = null;
let isQuitting = false;
let giftMaster = { fetchedAt: 0, gifts: [], byImgUrl: null, byName: null, byTypeId: null };

// =================== Helpers ===================
function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function saveJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}
function uid(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// =================== Mapping schema v2 ===================
function defaultOverlay(name = 'Overlay 1') {
  return {
    id: uid('ov_'),
    name,
    bgColor: '#00FF00',
    opacity: 1.0,
    bounds: { x: null, y: null, width: 540, height: 960 }, // half of 1080×1920 — user resize tự
    alwaysOnTop: true,
  };
}

function defaultGroup(name = 'Mặc định', type = 'gift') {
  return {
    id: uid('g_'), name, type,
    enabled: true, collapsed: false,
    bigoId: '', // Optional: BIGO ID auto-load khi nhóm này active
    items: [],
  };
}

// NHÓM CHUNG luôn tồn tại trên cùng. ID cố định 'g_common' để dễ track.
function defaultCommonGroup() {
  return {
    id: 'g_common', name: 'NHÓM CHUNG', type: 'gift',
    enabled: true, collapsed: false, bigoId: '', items: [], isCommon: true,
  };
}
function ensureCommonGroup(m) {
  if (!m || !Array.isArray(m.groups)) return;
  let common = m.groups.find(g => g.isCommon || g.id === 'g_common');
  if (!common) {
    common = defaultCommonGroup();
    m.groups.unshift(common);
  } else {
    common.isCommon = true;
    common.enabled = true; // luôn bật
    // Move common to top
    m.groups = m.groups.filter(g => g.id !== common.id);
    m.groups.unshift(common);
  }
}

function defaultMapping() {
  return {
    version: 3,
    groups: [defaultCommonGroup(), defaultGroup('Mặc định', 'gift')],
    overlays: [defaultOverlay()],
  };
}

function migrateMapping(raw) {
  if (!raw || typeof raw !== 'object') return defaultMapping();
  // v3 = current
  if (raw.version === 3 && Array.isArray(raw.groups) && Array.isArray(raw.overlays)) return raw;

  // Convert v2 (flat gifts array) → v3 (single group)
  if (raw.version === 2 && Array.isArray(raw.gifts)) {
    const items = raw.gifts.map(g => ({
      id: g.id || uid('i_'),
      matchKeys: g.matchKeys || [],
      alias: g.alias || '',
      mediaFile: g.mediaFile || '',
      overlayId: g.overlayId || '',
      pauseBgm: !!g.pauseBgm,
    }));
    return {
      version: 3,
      groups: [{ ...defaultGroup('Mặc định', 'gift'), items }],
      overlays: raw.overlays || [defaultOverlay()],
    };
  }

  // Convert v1 (legacy {gifts:{key:file}}) → v3
  if (raw.gifts && typeof raw.gifts === 'object' && !Array.isArray(raw.gifts)) {
    const overlays = [defaultOverlay()];
    const ovId = overlays[0].id;
    const items = [];
    for (const [key, file] of Object.entries(raw.gifts)) {
      if (!key || !file) continue;
      items.push({
        id: uid('i_'), matchKeys: [key], alias: key,
        mediaFile: file, overlayId: ovId, pauseBgm: false,
      });
    }
    return {
      version: 3,
      groups: [{ ...defaultGroup('Mặc định', 'gift'), items }],
      overlays,
    };
  }

  return defaultMapping();
}

function loadMapping() {
  const raw = loadJson(MAPPING_PATH, null);
  const m = migrateMapping(raw);
  ensureCommonGroup(m);  // Đảm bảo NHÓM CHUNG luôn ở đầu
  if (!raw || raw.version !== 3 || !raw.groups?.some?.(g => g.isCommon)) {
    saveJson(MAPPING_PATH, m);
  }
  return m;
}

let mapping = null; // cached, hydrated on app ready

// =================== Gift Master (Bigo public gift catalog) ===================
async function fetchGiftMasterRemote() {
  const res = await fetch('https://ta.bigo.tv/official_website/live/giftconfig/getOnlineGifts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
    body: '{}',
  });
  const json = await res.json();
  if (json.code !== 0 || !Array.isArray(json.data)) {
    throw new Error('getOnlineGifts trả lỗi: ' + (json.msg || 'unknown'));
  }
  return { fetchedAt: Date.now(), gifts: json.data };
}

function buildGiftMasterIndex(payload) {
  const byImgUrl = new Map();
  const byName = new Map();
  const byTypeId = new Map();
  for (const g of payload.gifts || []) {
    if (g.img_url) byImgUrl.set(g.img_url, g);
    if (g.typeid) byTypeId.set(g.typeid, g);
    const n = String(g.name || '').toLowerCase().trim();
    if (n) {
      const arr = byName.get(n);
      if (arr) arr.push(g); else byName.set(n, [g]);
    }
  }
  return { fetchedAt: payload.fetchedAt, gifts: payload.gifts, byImgUrl, byName, byTypeId };
}

async function ensureGiftMaster(force = false) {
  const cached = loadJson(GIFT_MASTER_PATH, null);
  const fresh = cached && (Date.now() - (cached.fetchedAt || 0) < GIFT_MASTER_TTL);
  if (cached && fresh && !force) {
    giftMaster = buildGiftMasterIndex(cached);
    return { ok: true, cached: true, count: giftMaster.gifts.length };
  }
  try {
    const data = await fetchGiftMasterRemote();
    saveJson(GIFT_MASTER_PATH, data);
    giftMaster = buildGiftMasterIndex(data);
    return { ok: true, cached: false, count: giftMaster.gifts.length };
  } catch (e) {
    if (cached) {
      giftMaster = buildGiftMasterIndex(cached);
      return { ok: true, cached: true, fallback: true, error: e.message, count: giftMaster.gifts.length };
    }
    return { ok: false, error: e.message };
  }
}

// vm_exchange_rate / 100 = số đậu (verified: Bunny DINO 100→1, Roses 100→1, Roadster 300000→3000)
function rateToDiamonds(rate) {
  if (rate == null) return null;
  return Math.round(rate / 100);
}

function getLocalIconPath(typeid) {
  if (!typeid) return null;
  const p = path.join(GIFT_ICONS_DIR, `${typeid}.png`);
  return fs.existsSync(p) ? p : null;
}
function localIconUrl(typeid) {
  const p = getLocalIconPath(typeid);
  return p ? 'file:///' + p.replace(/\\/g, '/') : null;
}

function enrichGiftEvent(ev) {
  if (!ev || (ev.type !== 'gift' && ev.type !== 'gift_overlay')) return ev;
  let meta = null;
  const iconUrl = ev.gift_icon_url || ev.icon;
  if (iconUrl && giftMaster.byImgUrl) meta = giftMaster.byImgUrl.get(iconUrl);
  if (!meta && ev.gift_name && giftMaster.byName) {
    const arr = giftMaster.byName.get(String(ev.gift_name).toLowerCase().trim());
    if (arr && arr.length) {
      meta = arr[0];
      if (arr.length > 1) ev.gift_ambiguous = arr.length;
    }
  }
  if (meta) {
    ev.gift_id = meta.typeid;
    ev.gift_value = rateToDiamonds(meta.vm_exchange_rate); // ĐÚNG: chia 100
    if (!ev.gift_icon) ev.gift_icon = localIconUrl(meta.typeid) || meta.img_url;
  }
  // Tổng = (count × combo) × giá 1 quà.  combo 1 nếu không có.
  const totalCount = (ev.gift_count || 1) * (ev.combo || 1);
  ev.total_count = totalCount;
  if (ev.gift_value != null) ev.total_diamond = totalCount * ev.gift_value;
  return ev;
}

// =================== App ===================
function loadSettings() { return loadJson(CONFIG_PATH, { env: 'prod', accessToken: '', gameId: '', openid: '', bigoId: '', windowBounds: {} }); }
function saveSettings(s) { saveJson(CONFIG_PATH, s); }
function ensureObsOverlaySettings() {
  const s = loadSettings();
  if (!s.obsOverlay) s.obsOverlay = {};
  if (!s.obsOverlay.port) s.obsOverlay.port = 18181;
  if (!s.obsOverlay.token) s.obsOverlay.token = crypto.randomBytes(18).toString('hex');
  saveSettings(s);
  return s.obsOverlay;
}
function saveWindowBounds(key, bounds) {
  const s = loadSettings();
  if (!s.windowBounds) s.windowBounds = {};
  s.windowBounds[key] = bounds;
  saveSettings(s);
}
function getSavedBounds(key, fallback) {
  const s = loadSettings();
  return (s.windowBounds && s.windowBounds[key]) || fallback;
}
function trackWindowBounds(window, key) {
  if (!window) return;
  const save = () => {
    if (window.isDestroyed()) return;
    try { saveWindowBounds(key, window.getBounds()); } catch {}
  };
  let timer = null;
  const debouncedSave = () => { clearTimeout(timer); timer = setTimeout(save, 400); };
  window.on('move', debouncedSave);
  window.on('resize', debouncedSave);
  window.on('close', save);
}

function cleanupAuxWindows() {
  if (listener) {
    try { listener.stop().catch(() => {}); } catch {}
    listener = null;
  }
  if (client) {
    try { client.stop().catch(() => {}); } catch {}
    client = null;
  }
  for (const key of ['queuePopup', 'heartOverlay', 'chatsPopup', 'giftsPopup']) {
    const w = { queuePopup, heartOverlay, chatsPopup, giftsPopup }[key];
    if (w && !w.isDestroyed()) {
      try { w.destroy(); } catch {}
    }
  }
  queuePopup = null;
  heartOverlay = null;
  chatsPopup = null;
  giftsPopup = null;
  if (overlayManager) {
    try { overlayManager.destroyAll(); } catch {}
  }
  if (obsOverlayServer) {
    try { obsOverlayServer.stop(); } catch {}
  }
}

function focusMainWindow() {
  if (!win || win.isDestroyed()) return;
  try {
    if (win.isMinimized()) win.restore();
    win.show();
    // Overlay windows can be always-on-top; briefly lift main above them so
    // launching the app visibly opens HP Action, not only the green overlay.
    win.setAlwaysOnTop(true, 'screen-saver');
    win.focus();
    win.moveTop();
    setTimeout(() => {
      try { if (win && !win.isDestroyed()) win.setAlwaysOnTop(false); } catch {}
    }, 700);
  } catch {}
}

function hardExitApp() {
  isQuitting = true;
  cleanupAuxWindows();
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      try { if (!w.isDestroyed()) w.destroy(); } catch {}
    }
  } catch {}
  setTimeout(() => app.exit(0), 50);
}

function createWindow() {
  const saved = getSavedBounds('main', { width: 1280, height: 860 });
  win = new BrowserWindow({
    width: saved.width || 1280,
    height: saved.height || 860,
    x: saved.x, y: saved.y,
    title: 'HP Action - Bigo LIVE',
    icon: APP_ICON || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  win.webContents.once('did-finish-load', () => focusMainWindow());
  // Confirm khi đóng app — tránh user bấm nhầm X làm mất session
  win.on('close', (e) => {
    if (isQuitting || win._allowClose) return;
    e.preventDefault();
    const { dialog } = require('electron');
    const r = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Hủy', 'Thoát'],
      defaultId: 0,
      cancelId: 0,
      title: 'HP Action - BIGO LIVE',
      message: 'Thoát ứng dụng?',
      detail: 'Mọi session/queue/chat đang chạy sẽ bị mất. Bạn chắc chắn muốn thoát?',
    });
    if (r === 1) {
      if (win) win._allowClose = true;
      hardExitApp();
    }
  });
  win.on('closed', () => { win = null; });
  trackWindowBounds(win, 'main');
  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
}

// Single-instance lock: nếu đã có instance đang chạy, focus vào nó và quit instance mới.
// Tránh conflict trên user-data cache + tránh nhiều cửa sổ trùng lặp.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', () => {
  focusMainWindow();
});

app.whenReady().then(async () => {
  mapping = loadMapping();
  overlayManager = new OverlayManager({
    onBoundsChanged: (overlayId, b) => {
      const ov = mapping.overlays.find(o => o.id === overlayId);
      if (!ov) return;
      ov.bounds = { x: b.x, y: b.y, width: b.width, height: b.height };
      saveJson(MAPPING_PATH, mapping);
      // Debug log để verify bounds được lưu khi user move/resize/close overlay.
      // Thấy log này trong DevTools (Ctrl+Shift+I tab Console) = đã hoạt động.
      if (win && !win.isDestroyed()) {
        try { win.webContents.send('bigo:log', `[overlay-bounds] ${ov.name || overlayId}: x=${b.x} y=${b.y} w=${b.width} h=${b.height}`); } catch {}
      }
    },
  });
  const obsCfg = ensureObsOverlaySettings();
  obsOverlayServer = new ObsOverlayServer({
    root: ROOT,
    port: obsCfg.port || 18181,
    token: obsCfg.token,
    onEffectEnded: ({ overlayId }) => {
      const cfg = mapping?.overlays?.find(o => o.id === overlayId);
      const target = cfg?.target || 'native';
      if (target === 'obs' && win && !win.isDestroyed()) {
        try { win.webContents.send('overlay:effect-ended'); } catch {}
      }
    },
    onQueueEmpty: ({ overlayId }) => {
      const cfg = mapping?.overlays?.find(o => o.id === overlayId);
      const target = cfg?.target || 'native';
      if (target === 'obs' && win && !win.isDestroyed()) {
        try { win.webContents.send('overlay:queue-empty'); } catch {}
      }
    },
    onLog: (msg) => { if (win && !win.isDestroyed()) { try { win.webContents.send('bigo:log', msg); } catch {} } },
  });
  obsOverlayServer.start().catch(e => {
    if (win && !win.isDestroyed()) win.webContents.send('bigo:log', `[obs-overlay] ${e.message}`);
  });
  createWindow();
  // Auto-open overlays với cfg.autoOpen = true sau khi app sẵn sàng
  setTimeout(() => {
    for (const ov of (mapping.overlays || [])) {
      if (ov.autoOpen) {
        try { overlayManager.show(ov); } catch (e) { console.warn('autoOpen overlay failed:', e); }
      }
    }
    focusMainWindow();
  }, 1200);
  // Background: load master → auto-download icons nếu thiếu
  (async () => {
    const r = await ensureGiftMaster().catch(e => ({ ok: false, error: e.message }));
    if (win && !win.isDestroyed()) win.webContents.send('bigo:log', `[gift-master] ${r.cached ? 'cache' : 'fetch'} ${r.count || 0} quà`);
    if (!r.ok || !giftMaster.gifts) return;
    fs.mkdirSync(GIFT_ICONS_DIR, { recursive: true });
    const have = fs.readdirSync(GIFT_ICONS_DIR).filter(f => /\.png$/i.test(f)).length;
    const total = giftMaster.gifts.length;
    if (have >= total) return; // đủ rồi
    if (win && !win.isDestroyed()) win.webContents.send('bigo:log', `[icons] auto-tải ${total - have} icons còn thiếu...`);
    setTimeout(async () => {
      const dl = await downloadAllIcons((p) => {
        if (win && !win.isDestroyed()) win.webContents.send('gifts:download-progress', p);
      });
      if (win && !win.isDestroyed()) win.webContents.send('bigo:log', `[icons] auto xong: +${dl.ok} mới, ${dl.skip} sẵn, ${dl.fail} lỗi`);
    }, 1500);
  })().catch(() => {});
});
app.on('window-all-closed', () => {
  cleanupAuxWindows();
  if (process.platform !== 'darwin') app.exit(0);
});
app.on('before-quit', () => {
  isQuitting = true;
  cleanupAuxWindows();
});
app.on('will-quit', () => {
  isQuitting = true;
  cleanupAuxWindows();
});

// =================== Settings & mapping IPC ===================
ipcMain.handle('settings:load', () => loadJson(CONFIG_PATH, {
  env: 'prod', accessToken: '', gameId: '', openid: '', bigoId: '',
}));
ipcMain.handle('settings:save', (_e, data) => { saveJson(CONFIG_PATH, data); return true; });

ipcMain.handle('shell:open-external', (_e, url) => shell.openExternal(url));

// App info — version từ package.json
ipcMain.handle('app:get-version', () => {
  try { return require(path.join(ROOT, 'package.json')).version || '0.0.0'; } catch { return '0.0.0'; }
});

// =================== License (Google Apps Script) ===================
const LICENSE_ENDPOINT = 'https://script.google.com/macros/s/AKfycbwOuL0jR7HL9oMwNkebX1JRKI8lf5-RafKZsqsIQmuHpuME5fGlsXsuqDv_r3VhP_Anuw/exec';

// Generate machine ID — hash hardware để bind 1 key vào 1 máy.
ipcMain.handle('license:machine-id', () => {
  const os = require('os');
  const crypto = require('crypto');
  const parts = [os.hostname(), os.platform(), os.arch(), os.cpus()[0]?.model || ''];
  const ifaces = os.networkInterfaces();
  // Lấy MAC đầu tiên non-virtual
  for (const name of Object.keys(ifaces)) {
    for (const i of (ifaces[name] || [])) {
      if (!i.internal && i.mac && i.mac !== '00:00:00:00:00:00') {
        parts.push(i.mac);
        break;
      }
    }
  }
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
});

// Call Apps Script endpoint với key + machineId + action.
// Response expect: { ok, data: { status, tinh_nang, han_su_dung, sl_qua_toi_da, ... } }
ipcMain.handle('license:verify', async (_e, { key, machineId, action }) => {
  if (!key) return { ok: false, error: 'Thiếu mã key' };
  try {
    const params = new URLSearchParams({
      action: action || 'verify',
      key: String(key).trim(),
      machineId: String(machineId || ''),
    });
    const url = `${LICENSE_ENDPOINT}?${params.toString()}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    let res;
    try {
      res = await fetch(url, { method: 'GET', redirect: 'follow', signal: ctrl.signal });
    } finally { clearTimeout(timer); }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, status: res.status };
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    if (!json) {
      // Apps Script trả HTML khi script lỗi hoặc deploy cấu hình sai
      return { ok: false, error: 'Phản hồi không phải JSON. Có thể script chưa deploy đúng hoặc cần access "Anyone".', raw: text.slice(0, 300) };
    }
    return { ok: true, data: json };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

ipcMain.handle('mapping:load', () => mapping);
ipcMain.handle('mapping:save', (_e, data) => {
  // Preserve overlay bounds từ mapping hiện tại (đã được track qua move/resize events).
  // Renderer's mapping có thể stale - không nên cho phép overwrite bounds latest.
  if (data && Array.isArray(data.overlays) && mapping && Array.isArray(mapping.overlays)) {
    for (const newOv of data.overlays) {
      const existing = mapping.overlays.find(o => o.id === newOv.id);
      if (existing && existing.bounds) {
        // Giữ bounds.x, y (vị trí). Width/height có thể đến từ user nhập trong dialog.
        const newB = newOv.bounds || {};
        newOv.bounds = {
          x: existing.bounds.x != null ? existing.bounds.x : newB.x,
          y: existing.bounds.y != null ? existing.bounds.y : newB.y,
          width: newB.width != null ? newB.width : existing.bounds.width,
          height: newB.height != null ? newB.height : existing.bounds.height,
        };
      }
    }
  }
  // Đảm bảo NHÓM CHUNG luôn tồn tại
  ensureCommonGroup(data);
  mapping = data;
  saveJson(MAPPING_PATH, mapping);
  // Sync OverlayWindow.cfg references về object MỚI trong mapping.overlays.
  // Tránh OverlayWindow giữ reference cũ → applyConfig đọc sai cfg sau khi user save dialog.
  if (overlayManager && Array.isArray(mapping.overlays)) {
    for (const ov of mapping.overlays) {
      const w = overlayManager.overlays.get(ov.id);
      if (w) w.cfg = ov;
    }
  }
  return true;
});

ipcMain.handle('effects:list', () => {
  try {
    fs.mkdirSync(EFFECTS_DIR, { recursive: true });
    return fs.readdirSync(EFFECTS_DIR)
      .filter(f => /\.(mp4|webm|mp3|wav|ogg|gif)$/i.test(f))
      .map(f => ({ file: f, path: path.join(EFFECTS_DIR, f) }));
  } catch { return []; }
});

// Kiểm tra file effect tồn tại — nhận basename (assets/effects) hoặc file:// URL hoặc absolute path.
ipcMain.handle('effects:exists', (_e, mediaFile) => {
  if (!mediaFile || typeof mediaFile !== 'string') return false;
  let p = mediaFile;
  if (/^file:\/\//i.test(p)) {
    try { p = decodeURIComponent(p.replace(/^file:\/\/\/?/i, '')).replace(/\//g, path.sep); } catch { return false; }
  } else if (!path.isAbsolute(p)) {
    p = path.join(EFFECTS_DIR, p);
  }
  try { return fs.existsSync(p); } catch { return false; }
});

// Pick BGM file - giữ nguyên ở vị trí gốc, trả về file:// URL
ipcMain.handle('bgm:pick-file', async () => {
  if (!win) return { ok: false };
  const res = await dialog.showOpenDialog(win, {
    title: 'Chọn nhạc nền (mp3/wav/ogg/m4a)',
    properties: ['openFile'],
    filters: [
      { name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'flac'] },
      { name: 'All', extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
  const filePath = res.filePaths[0];
  const fileUrl = 'file:///' + filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  return { ok: true, filePath, fileUrl, fileName: path.basename(filePath) };
});

// Pick pre-effect media file (mp3/mp4/wav/webm) — phát trước hiệu ứng quà.
ipcMain.handle('preFx:pick-file', async () => {
  if (!win) return { ok: false };
  const res = await dialog.showOpenDialog(win, {
    title: 'Chọn âm thanh/video phát trước hiệu ứng',
    properties: ['openFile'],
    filters: [
      { name: 'Media', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'mp4', 'webm'] },
      { name: 'All', extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
  const filePath = res.filePaths[0];
  const fileUrl = 'file:///' + filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  return { ok: true, filePath, fileUrl, fileName: path.basename(filePath) };
});

// Mở dialog chọn file hiệu ứng. KHÔNG copy vào assets/effects để tránh phình app folder.
// Trả về list { filePath, fileUrl, fileName } — gift item lưu fileUrl trực tiếp,
// chạy ở vị trí gốc trên ổ đĩa.
ipcMain.handle('effects:pick-files', async () => {
  if (!win) return { ok: false };
  const res = await dialog.showOpenDialog(win, {
    title: 'Chọn file hiệu ứng (mp3/mp4/webm/wav/ogg/gif)',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Media', extensions: ['mp4', 'webm', 'mp3', 'wav', 'ogg', 'gif'] },
      { name: 'All', extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
  const files = res.filePaths.map(filePath => ({
    filePath,
    fileUrl: 'file:///' + filePath.replace(/\\/g, '/').replace(/^\/+/, ''),
    fileName: path.basename(filePath),
  }));
  return { ok: true, files };
});

// Mở folder assets/effects bằng file explorer
ipcMain.handle('effects:open-folder', async () => {
  fs.mkdirSync(EFFECTS_DIR, { recursive: true });
  const { shell } = require('electron');
  await shell.openPath(EFFECTS_DIR);
  return { ok: true };
});

// =================== Config Export / Import ===================
// Xuất bundle settings + mapping ra 1 JSON file để chuyển sang máy khác.
ipcMain.handle('config:export', async () => {
  if (!win) return { ok: false };
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const res = await dialog.showSaveDialog(win, {
    title: 'Xuất cài đặt BIGO Action',
    defaultPath: `bigo-action-config-${ts}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }, { name: 'All', extensions: ['*'] }],
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  // Lấy version từ package.json (best-effort)
  let appVersion = '0.1.0';
  try { appVersion = require(path.join(ROOT, 'package.json')).version || appVersion; } catch {}
  const bundle = {
    type: 'bigo-action-config',
    appVersion,
    exportedAt: new Date().toISOString(),
    settings: loadJson(CONFIG_PATH, {}),
    mapping: mapping || loadMapping(),
  };
  try {
    fs.writeFileSync(res.filePath, JSON.stringify(bundle, null, 2), 'utf8');
    return { ok: true, filePath: res.filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Nhập bundle - thay thế settings + mapping. Yêu cầu xác nhận từ renderer trước.
ipcMain.handle('config:import', async () => {
  if (!win) return { ok: false };
  const res = await dialog.showOpenDialog(win, {
    title: 'Chọn file cấu hình BIGO Action (.json)',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }, { name: 'All', extensions: ['*'] }],
  });
  if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
  const filePath = res.filePaths[0];
  let bundle;
  try {
    bundle = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return { ok: false, error: 'File JSON không hợp lệ: ' + e.message };
  }
  if (!bundle || bundle.type !== 'bigo-action-config') {
    return { ok: false, error: 'File không phải bundle BIGO Action' };
  }
  if (!bundle.mapping || !Array.isArray(bundle.mapping.groups) || !Array.isArray(bundle.mapping.overlays)) {
    return { ok: false, error: 'Bundle mapping không hợp lệ (thiếu groups hoặc overlays)' };
  }
  // Apply
  try {
    if (bundle.settings && typeof bundle.settings === 'object') {
      saveJson(CONFIG_PATH, bundle.settings);
    }
    ensureCommonGroup(bundle.mapping);
    mapping = bundle.mapping;
    saveJson(MAPPING_PATH, mapping);
    // Sync OverlayWindow.cfg references
    if (overlayManager && Array.isArray(mapping.overlays)) {
      for (const ov of mapping.overlays) {
        const w = overlayManager.overlays.get(ov.id);
        if (w) w.cfg = ov;
      }
    }
    return {
      ok: true,
      stats: {
        groups: mapping.groups.length,
        overlays: mapping.overlays.length,
        items: mapping.groups.reduce((s, g) => s + (g.items?.length || 0), 0),
        exportedAt: bundle.exportedAt || null,
        appVersion: bundle.appVersion || null,
      },
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// =================== Open API (OAuth) ===================
ipcMain.handle('bigo:start', async (_e, opts) => {
  if (client) await client.stop().catch(() => {});
  client = new BigoClient({
    env: opts.env, accessToken: opts.accessToken, gameId: opts.gameId, openid: opts.openid,
    onEvent: (ev) => { if (win && !win.isDestroyed()) win.webContents.send('bigo:event', ev); },
    onLog: (msg) => { if (win && !win.isDestroyed()) win.webContents.send('bigo:log', msg); },
  });
  try { await client.start(); return { ok: true, gameSess: client.gameSess }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('bigo:stop', async () => {
  if (!client) return { ok: true };
  await client.stop(); client = null;
  return { ok: true };
});
ipcMain.handle('bigo:test-event', (_e, type) => {
  if (!win) return;
  const samples = {
    gift: { type: 'gift', gift_id: 1234, gift_name: 'Test Rose', gift_count: 5, user: 'test_user', nick_name: 'Tester', ts: Date.now() },
    heart: { type: 'heart', count: 10, user: 'test_user', nick_name: 'Tester', ts: Date.now() },
    msg: { type: 'msg', content: 'xin chào streamer', user: 'test_user', nick_name: 'Tester', ts: Date.now() },
  };
  win.webContents.send('bigo:event', samples[type] || samples.gift);
});

// =================== Public web check ===================
ipcMain.handle('bigo:check-live', async (_e, bigoId) => {
  try {
    const res = await fetch('https://ta.bigo.tv/official_website/studio/getInternalStudioInfo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded',
                 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      body: `siteId=${encodeURIComponent(bigoId)}`,
    });
    return { ok: true, data: await res.json() };
  } catch (e) { return { ok: false, error: e.message }; }
});

// =================== Gift master IPC ===================
function decorateGift(g) {
  return {
    ...g,
    diamonds: rateToDiamonds(g.vm_exchange_rate),
    localIcon: localIconUrl(g.typeid),
  };
}

ipcMain.handle('gifts:master-list', () => (giftMaster.gifts || []).map(decorateGift));
ipcMain.handle('gifts:master-refresh', async () => ensureGiftMaster(true));
ipcMain.handle('gifts:lookup', (_e, query) => {
  if (!query) return [];
  const q = String(query).toLowerCase().trim();
  if (!giftMaster.gifts) return [];
  const id = parseInt(q, 10);
  if (!isNaN(id) && giftMaster.byTypeId && giftMaster.byTypeId.has(id)) {
    return [decorateGift(giftMaster.byTypeId.get(id))];
  }
  const out = [];
  for (const g of giftMaster.gifts) {
    if (out.length >= 50) break;
    const n = String(g.name || '').toLowerCase();
    if (n.includes(q)) out.push(decorateGift(g));
  }
  return out;
});

// =================== Gift Icons (download + drag) ===================
ipcMain.handle('gifts:icons-status', () => {
  let count = 0;
  if (fs.existsSync(GIFT_ICONS_DIR)) {
    count = fs.readdirSync(GIFT_ICONS_DIR).filter(f => /\.png$/i.test(f)).length;
  }
  return {
    dir: GIFT_ICONS_DIR,
    count,
    total: giftMaster.gifts?.length || 0,
  };
});

async function downloadAllIcons(progressCb) {
  if (!giftMaster.gifts || !giftMaster.gifts.length) await ensureGiftMaster();
  fs.mkdirSync(GIFT_ICONS_DIR, { recursive: true });
  const list = giftMaster.gifts || [];
  const total = list.length;
  let done = 0, ok = 0, skip = 0, fail = 0;
  const concurrency = 6;
  let idx = 0;

  const emit = () => { try { progressCb && progressCb({ done, total, ok, skip, fail }); } catch {} };

  async function worker() {
    while (idx < list.length) {
      const g = list[idx++];
      if (!g.typeid || !g.img_url) { done++; continue; }
      const filePath = path.join(GIFT_ICONS_DIR, `${g.typeid}.png`);
      try {
        if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
          skip++;
        } else {
          const res = await fetch(g.img_url);
          if (!res.ok) throw new Error('http ' + res.status);
          const buf = Buffer.from(await res.arrayBuffer());
          fs.writeFileSync(filePath, buf);
          ok++;
        }
      } catch (err) { fail++; }
      done++;
      if (done % 10 === 0 || done === total) emit();
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  emit();
  return { total, ok, skip, fail };
}

ipcMain.handle('gifts:download-icons', async (e) => {
  return downloadAllIcons((p) => {
    try { e.sender.send('gifts:download-progress', p); } catch {}
  });
});

// Native drag — phải dùng ipcRenderer.send để khớp event loop của renderer dragstart
ipcMain.on('gifts:start-drag', (event, typeid) => {
  if (!typeid) return;
  const filePath = path.join(GIFT_ICONS_DIR, `${typeid}.png`);
  if (!fs.existsSync(filePath)) return;
  try {
    const icon = nativeImage.createFromPath(filePath);
    const sized = icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 64, height: 64 });
    event.sender.startDrag({ file: filePath, icon: sized });
  } catch (err) {
    if (win && !win.isDestroyed()) win.webContents.send('bigo:log', `[drag err] ${err.message}`);
  }
});

// =================== Popup window (Hàng đợi hiệu ứng) ===================
function ensureQueuePopup() {
  if (queuePopup && !queuePopup.isDestroyed()) return queuePopup;
  const saved = getSavedBounds('popupQueue', { width: 420, height: 760 });
  queuePopup = new BrowserWindow({
    width: saved.width || 420, height: saved.height || 760,
    x: saved.x, y: saved.y,
    title: '📋 HÀNH ĐỘNG — HP Action - BIGO LIVE',
    icon: APP_ICON || undefined,
    parent: win,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  queuePopup.setMenuBarVisibility(false);
  queuePopup.loadFile(path.join(ROOT, 'renderer', 'popup-queue.html'));
  queuePopup.on('closed', () => { queuePopup = null; });
  trackWindowBounds(queuePopup, 'popupQueue');
  return queuePopup;
}
ipcMain.handle('popup:open-queue', () => {
  const w = ensureQueuePopup();
  w.show(); w.focus();
  return { ok: true };
});
ipcMain.handle('popup:queue-item', (_e, item) => {
  if (queuePopup && !queuePopup.isDestroyed()) {
    try { queuePopup.webContents.send('popup-queue:item', item); } catch {}
  }
  return { ok: true };
});
ipcMain.handle('popup:reset-queue', () => {
  if (queuePopup && !queuePopup.isDestroyed()) {
    try { queuePopup.webContents.send('popup-queue:reset'); } catch {}
  }
  return { ok: true };
});

// Popup gửi full snapshot xuống popup window. Đồng bộ thứ tự queue chuẩn xác.
ipcMain.handle('popup:queue-snapshot', (_e, items) => {
  if (queuePopup && !queuePopup.isDestroyed()) {
    try { queuePopup.webContents.send('popup-queue:snapshot', items || []); } catch {}
  }
  return { ok: true };
});

// Popup user bấm X → forward về main app renderer để remove khỏi queueItems.
ipcMain.on('popup-queue:remove', (_e, id) => {
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('queue:remove', id); } catch {}
  }
});

// Popup user bấm "Xoá tất cả" → forward về main app renderer.
ipcMain.on('popup-queue:clear-all', () => {
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('queue:clear-all'); } catch {}
  }
});
// Popup right-click action (top / up / down) → forward về app.
ipcMain.on('popup-queue:action', (_e, payload) => {
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('queue:action', payload); } catch {}
  }
});

// =================== Heart Goal Overlay window ===================
// Cửa sổ riêng hiển thị vòng tròn progress cho TÁP TIM. OBS-friendly:
// frameless + transparent, drag/resize, persist bounds.
function ensureHeartOverlay() {
  if (heartOverlay && !heartOverlay.isDestroyed()) return heartOverlay;
  const saved = getSavedBounds('heartOverlay', { width: 320, height: 320, x: null, y: null });
  heartOverlay = new BrowserWindow({
    width: saved.width || 320, height: saved.height || 320,
    x: saved.x, y: saved.y,
    title: 'Heart Goal — HP Action',
    icon: APP_ICON || undefined,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false },
  });
  heartOverlay.setMenuBarVisibility(false);
  heartOverlay.loadFile(path.join(ROOT, 'renderer', 'heart-overlay.html'));
  heartOverlay.setAlwaysOnTop(true, 'screen-saver');
  heartOverlay.on('closed', () => { heartOverlay = null; });
  trackWindowBounds(heartOverlay, 'heartOverlay');
  return heartOverlay;
}
ipcMain.handle('heart-overlay:show', () => {
  const w = ensureHeartOverlay();
  w.show(); w.focus();
  return { ok: true };
});
ipcMain.handle('heart-overlay:hide', () => {
  if (heartOverlay && !heartOverlay.isDestroyed()) heartOverlay.hide();
  return { ok: true };
});
ipcMain.handle('heart-overlay:update', (_e, payload) => {
  if (heartOverlay && !heartOverlay.isDestroyed()) {
    try { heartOverlay.webContents.send('heart-overlay:update', payload || {}); } catch {}
  }
  return { ok: true };
});

// =================== Popup window (Tương tác - chats) ===================
function ensureChatsPopup() {
  if (chatsPopup && !chatsPopup.isDestroyed()) return chatsPopup;
  const saved = getSavedBounds('popupChats', { width: 400, height: 720 });
  chatsPopup = new BrowserWindow({
    width: saved.width || 400, height: saved.height || 720,
    x: saved.x, y: saved.y,
    title: '💬 TƯƠNG TÁC — HP Action - BIGO LIVE',
    icon: APP_ICON || undefined,
    parent: win,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  chatsPopup.setMenuBarVisibility(false);
  chatsPopup.loadFile(path.join(ROOT, 'renderer', 'popup-chats.html'));
  chatsPopup.on('closed', () => { chatsPopup = null; });
  trackWindowBounds(chatsPopup, 'popupChats');
  return chatsPopup;
}
ipcMain.handle('popup:open-chats', () => {
  const w = ensureChatsPopup();
  w.show(); w.focus();
  return { ok: true };
});
ipcMain.handle('popup:chats-event', (_e, ev) => {
  if (chatsPopup && !chatsPopup.isDestroyed()) {
    try { chatsPopup.webContents.send('popup-chats:event', ev); } catch {}
  }
  return { ok: true };
});
ipcMain.handle('popup:chats-reset', () => {
  if (chatsPopup && !chatsPopup.isDestroyed()) {
    try { chatsPopup.webContents.send('popup-chats:reset'); } catch {}
  }
  return { ok: true };
});
// Snapshot từ app gửi xuống popup khi popup vừa mở (lấy full history).
ipcMain.handle('popup:chats-snapshot', (_e, items) => {
  if (chatsPopup && !chatsPopup.isDestroyed()) {
    try { chatsPopup.webContents.send('popup-chats:snapshot', items || []); } catch {}
  }
  return { ok: true };
});
// Popup request snapshot từ app (khi vừa load) → forward về renderer.
ipcMain.on('popup-chats:request-snapshot', () => {
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('chats:request-snapshot'); } catch {}
  }
});

// =================== Popup window (ĐÃ NHẬN) ===================
function ensureGiftsPopup() {
  if (giftsPopup && !giftsPopup.isDestroyed()) return giftsPopup;
  const saved = getSavedBounds('popupGifts', { width: 380, height: 720 });
  giftsPopup = new BrowserWindow({
    width: saved.width || 380,
    height: saved.height || 720,
    x: saved.x, y: saved.y,
    title: '🎁 ĐÃ NHẬN — HP Action - BIGO LIVE',
    icon: APP_ICON || undefined,
    parent: win,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  giftsPopup.setMenuBarVisibility(false);
  giftsPopup.loadFile(path.join(ROOT, 'renderer', 'popup-gifts.html'));
  giftsPopup.on('closed', () => { giftsPopup = null; });
  trackWindowBounds(giftsPopup, 'popupGifts');
  return giftsPopup;
}

ipcMain.handle('popup:open-gifts', () => {
  const w = ensureGiftsPopup();
  w.show();
  w.focus();
  return { ok: true };
});
ipcMain.handle('popup:reset-gifts', () => {
  if (giftsPopup && !giftsPopup.isDestroyed()) {
    giftsPopup.webContents.send('popup:reset');
  }
  return { ok: true };
});

// Gửi full receivedGifts snapshot xuống popup-gifts → đồng bộ với main page chính xác.
ipcMain.handle('popup:gifts-snapshot', (_e, items) => {
  if (giftsPopup && !giftsPopup.isDestroyed()) {
    try { giftsPopup.webContents.send('popup:gifts-snapshot', items || []); } catch {}
  }
  return { ok: true };
});

// Popup user bấm X → forward về main app renderer.
ipcMain.on('popup-gifts:remove', (_e, id) => {
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('received-gifts:remove', id); } catch {}
  }
});
ipcMain.on('popup-gifts:clear-all', () => {
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('received-gifts:clear-all'); } catch {}
  }
});
// Popup mới mở → request snapshot từ main app
ipcMain.on('popup-gifts:request-snapshot', () => {
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('received-gifts:request-snapshot'); } catch {}
  }
});

function forwardToGiftsPopup(ev) {
  if (giftsPopup && !giftsPopup.isDestroyed()) {
    try { giftsPopup.webContents.send('popup:event', ev); } catch {}
  }
}

// =================== Web Embed Listener ===================
ipcMain.handle('embed:start', async (_e, opts) => {
  // Always stop and recreate — đảm bảo đổi ID là restart phiên
  if (listener) {
    try { await listener.stop(); } catch {}
  }
  listener = new BigoWebListener({
    onEvent: (ev) => {
      // Enrich gift events in-place using master catalog
      if (ev && ev.kind === 'parsed') enrichGiftEvent(ev);
      if (win && !win.isDestroyed()) win.webContents.send('embed:event', ev);
      // Forward gift events to popup window if open
      if (ev && ev.kind === 'parsed' && (ev.type === 'gift' || ev.type === 'gift_overlay')) {
        forwardToGiftsPopup(ev);
      }
    },
    onLog: (msg) => { if (win && !win.isDestroyed()) win.webContents.send('bigo:log', `[embed] ${msg}`); },
  });
  try {
    await listener.start(opts.bigoId, { visible: !!opts.visible });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('embed:stop', async () => {
  if (listener) { await listener.stop(); listener = null; }
  return { ok: true };
});
ipcMain.handle('embed:show', () => {
  if (!listener) return { ok: false, error: 'chưa kết nối' };
  return { ok: !!listener.showAndFocus() };
});

// =================== Overlay ===================
function fileUrl(absPath) {
  return 'file:///' + absPath.replace(/\\/g, '/').replace(/^\/+/, '');
}
function pathFromFileUrl(url) {
  const s = String(url || '');
  if (!s.startsWith('file://')) return s;
  try { return decodeURIComponent(new URL(s).pathname).replace(/^\/(?=[A-Za-z]:)/, ''); } catch { return s.replace(/^file:\/\//, ''); }
}
function resolveEffectPath({ file, fileUrl: rawUrl }) {
  if (rawUrl) return pathFromFileUrl(rawUrl);
  if (file) return path.join(EFFECTS_DIR, file);
  return null;
}

ipcMain.handle('overlay:show', (_e, overlayId) => {
  const cfg = mapping.overlays.find(o => o.id === overlayId);
  if (!cfg) return { ok: false, error: 'overlay không tồn tại' };
  overlayManager.show(cfg);
  return { ok: true };
});

// Auto-focus (showInactive) cho overlay autoFocus khi có gift/chat event
ipcMain.handle('overlay:nudge', (_e, overlayId) => {
  const cfg = mapping.overlays.find(o => o.id === overlayId);
  if (!cfg || !cfg.autoFocus) return { ok: false };
  const ov = overlayManager.overlays.get(overlayId);
  if (!ov || !ov.win || ov.win.isDestroyed()) {
    overlayManager.show(cfg);
  } else if (!ov.win.isVisible()) {
    try { ov.win.showInactive(); } catch {}
  }
  return { ok: true };
});
ipcMain.handle('overlay:hide', (_e, overlayId) => {
  overlayManager.hide(overlayId);
  return { ok: true };
});
ipcMain.handle('overlay:apply-config', (_e, cfg) => {
  // cfg từ renderer khi user edit overlay (color, opacity, W/H, alwaysOnTop, ...).
  // QUAN TRỌNG: Renderer's `mapping` có thể STALE — onBoundsChanged tracking chỉ
  // update mapping ở main process, không broadcast về renderer. Vì user dialog chỉ
  // edit W/H (không có ô X/Y), x/y trong cfg.bounds (nếu có) là stale từ lúc renderer
  // load mapping lần đầu — KHÔNG được tin tưởng.
  // Quy tắc: x/y → ưu tiên existing.bounds (main process tracked, mới nhất).
  //          width/height → ưu tiên cfg.bounds (user vừa nhập trong dialog).
  const idx = mapping.overlays.findIndex(o => o.id === cfg.id);
  if (idx === -1) return { ok: false };
  const existing = mapping.overlays[idx];
  const merged = { ...existing, ...cfg };
  if (cfg.bounds || existing.bounds) {
    const ex = existing.bounds || {};
    const incoming = cfg.bounds || {};
    merged.bounds = {
      x: ex.x != null ? ex.x : (incoming.x != null ? incoming.x : null),
      y: ex.y != null ? ex.y : (incoming.y != null ? incoming.y : null),
      width: incoming.width != null ? incoming.width : ex.width,
      height: incoming.height != null ? incoming.height : ex.height,
    };
  }
  mapping.overlays[idx] = merged;
  saveJson(MAPPING_PATH, mapping);
  overlayManager.applyConfig(mapping.overlays[idx]);
  return { ok: true };
});
ipcMain.handle('overlay:delete', (_e, overlayId) => {
  overlayManager.destroy(overlayId);
  mapping.overlays = mapping.overlays.filter(o => o.id !== overlayId);
  saveJson(MAPPING_PATH, mapping);
  return { ok: true };
});
// overlay:effect-ended — fire mỗi khi 1 video/audio kết thúc trong overlay window.
// Forward về renderer chính để advance UI queue (chính xác theo playback thực tế).
ipcMain.on('overlay:effect-ended', (_e) => {
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('overlay:effect-ended'); } catch {}
  }
});

// overlay queue-empty: từ overlay window khi đã play hết → hide nếu autoHide bật
// + forward sang main window để renderer resume BGM
ipcMain.on('overlay:queue-empty', (e) => {
  // Forward to main window (renderer chính resume BGM)
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('overlay:queue-empty'); } catch {}
  }
  for (const [id, ov] of overlayManager.overlays.entries()) {
    if (ov.win && !ov.win.isDestroyed() && ov.win.webContents === e.sender) {
      if (ov.cfg && ov.cfg.autoHide) {
        // Delay 1.5s phòng trường hợp gift kế tiếp đến ngay
        setTimeout(() => {
          if (ov.win && !ov.win.isDestroyed()) {
            try { ov.win.hide(); } catch {}
          }
        }, 1500);
      }
      break;
    }
  }
});

// Set tốc độ phát hiệu ứng. Có thể nhận:
// - number (legacy): apply cho cả audio + video.
// - { audioRate, videoRate }: tách 2 axis độc lập (UNDEFINED → giữ nguyên).
ipcMain.handle('overlay:set-speed', (_e, opts) => {
  let payload;
  if (typeof opts === 'number') {
    const r = Math.max(0.25, Math.min(3, opts || 1));
    payload = { audioRate: r, videoRate: r };
  } else if (opts && typeof opts === 'object') {
    payload = {};
    if (opts.audioRate != null) payload.audioRate = Math.max(0.25, Math.min(3, parseFloat(opts.audioRate) || 1));
    if (opts.videoRate != null) payload.videoRate = Math.max(0.25, Math.min(3, parseFloat(opts.videoRate) || 1));
  } else {
    return { ok: false, error: 'invalid opts' };
  }
  if (overlayManager) {
    for (const ov of overlayManager.overlays.values()) {
      if (ov.win && !ov.win.isDestroyed()) {
        try { ov.win.webContents.send('overlay:set-speed', payload); } catch {}
      }
    }
  }
  if (obsOverlayServer) obsOverlayServer.setSpeed(payload);
  return { ok: true, ...payload };
});

// Stop hiệu ứng đang playing trên overlay (user xoá item khỏi DSHT)
ipcMain.handle('overlay:stop-effect', (_e, overlayId) => {
  const cfg = mapping?.overlays?.find(o => o.id === overlayId);
  const target = cfg?.target || 'native';
  if (obsOverlayServer && (target === 'obs' || target === 'both')) obsOverlayServer.stopOverlay(overlayId);
  const ov = overlayManager?.overlays?.get(overlayId);
  if ((target === 'native' || target === 'both') && ov && ov.win && !ov.win.isDestroyed()) {
    try { ov.win.webContents.send('overlay:stop'); } catch {}
  }
  return { ok: true };
});

ipcMain.handle('overlay:play', (_e, { overlayId, file, fileUrl: rawUrl }) => {
  const cfg = mapping.overlays.find(o => o.id === overlayId);
  if (!cfg) return { ok: false };
  // 2 modes:
  // - file (basename trong assets/effects) → resolve qua EFFECTS_DIR
  // - fileUrl (raw file:// URL) → dùng thẳng (cho pre-effect sound user pick từ ổ đĩa)
  const fullPath = resolveEffectPath({ file, fileUrl: rawUrl });
  if (!fullPath) {
    return { ok: false, error: 'thiếu file' };
  }
  if (!fs.existsSync(fullPath)) return { ok: false, error: 'file không tồn tại' };
  const target = cfg.target || 'native';
  if (target === 'native') {
    overlayManager.play(cfg, fileUrl(fullPath));
  } else if (target === 'obs') {
    const sentToObs = obsOverlayServer ? obsOverlayServer.play(overlayId, fullPath) : false;
    if (!sentToObs && win && !win.isDestroyed()) {
      try { win.webContents.send('bigo:log', `[obs-overlay] ${cfg.name || overlayId}: chưa có OBS Browser Source kết nối, bỏ qua 1 hiệu ứng`); } catch {}
      setTimeout(() => { try { win.webContents.send('overlay:effect-ended'); } catch {} }, 50);
    }
  } else if (target === 'both') {
    overlayManager.play(cfg, fileUrl(fullPath));
    if (obsOverlayServer) obsOverlayServer.play(overlayId, fullPath);
  }
  return { ok: true };
});

ipcMain.handle('obs-overlay:get-url', (_e, overlayId) => {
  if (!obsOverlayServer) return { ok: false, error: 'OBS overlay server chưa sẵn sàng' };
  return { ok: true, url: obsOverlayServer.getUrl(overlayId), connected: obsOverlayServer.hasClients(overlayId) };
});
ipcMain.handle('obs-overlay:copy-url', (_e, overlayId) => {
  if (!obsOverlayServer) return { ok: false, error: 'OBS overlay server chưa sẵn sàng' };
  const url = obsOverlayServer.getUrl(overlayId);
  clipboard.writeText(url);
  return { ok: true, url, connected: obsOverlayServer.hasClients(overlayId) };
});
ipcMain.handle('gameplay:copy-url', () => {
  if (!obsOverlayServer) return { ok: false, error: 'OBS overlay server chưa sẵn sàng' };
  const url = obsOverlayServer.getGameplayUrl();
  clipboard.writeText(url);
  return { ok: true, url };
});
ipcMain.handle('gameplay:config', (_e, cfg) => {
  if (obsOverlayServer) obsOverlayServer.setGameplayConfig(cfg);
  return { ok: true };
});
ipcMain.handle('gameplay:counts', (_e, counts) => {
  if (obsOverlayServer) obsOverlayServer.sendGameplayCounts(counts);
  return { ok: true };
});
ipcMain.handle('gameplay:event', (_e, ev) => {
  if (obsOverlayServer) obsOverlayServer.sendGameplayEvent(ev);
  return { ok: true };
});
ipcMain.handle('ranking:copy-url', () => {
  if (!obsOverlayServer) return { ok: false, error: 'OBS overlay server chưa sẵn sàng' };
  const url = obsOverlayServer.getRankingUrl();
  clipboard.writeText(url);
  return { ok: true, url };
});
ipcMain.handle('ranking:grid-copy-url', () => {
  if (!obsOverlayServer) return { ok: false, error: 'OBS overlay server chưa sẵn sàng' };
  const url = obsOverlayServer.getRankingGridUrl();
  clipboard.writeText(url);
  return { ok: true, url };
});
ipcMain.handle('ranking:update', (_e, state) => {
  if (obsOverlayServer) obsOverlayServer.sendRankingState(state || {});
  return { ok: true };
});
ipcMain.handle('score:copy-url', () => {
  if (!obsOverlayServer) return { ok: false, error: 'OBS overlay server chưa sẵn sàng' };
  const url = obsOverlayServer.getScoreUrl();
  clipboard.writeText(url);
  return { ok: true, url };
});
ipcMain.handle('score:update', (_e, state) => {
  if (obsOverlayServer) obsOverlayServer.sendScoreState(state || {});
  return { ok: true };
});
