const { app, BrowserWindow, ipcMain, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { BigoClient } = require('./bigo-client');
const { BigoWebListener } = require('./web-embed');
const { OverlayManager } = require('./overlay-manager');

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

// Windows: set AppUserModelID để taskbar group đúng và hiện icon
if (process.platform === 'win32') {
  app.setAppUserModelId('com.hp.bigoaction');
}

let win;
let client = null;
let listener = null;
let overlayManager = null;
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

function defaultMapping() {
  return { version: 2, gifts: [], overlays: [defaultOverlay()], groups: [] };
}

function migrateMapping(raw) {
  if (!raw || typeof raw !== 'object') return defaultMapping();
  if (raw.version === 2 && Array.isArray(raw.gifts) && Array.isArray(raw.overlays)) return raw;

  // Migrate v1: { gifts: { key: file, ... }, hearts, msg }
  const overlays = [defaultOverlay()];
  const ovId = overlays[0].id;
  const gifts = [];
  if (raw.gifts && typeof raw.gifts === 'object' && !Array.isArray(raw.gifts)) {
    for (const [key, file] of Object.entries(raw.gifts)) {
      if (!key || !file) continue;
      gifts.push({
        id: uid('g_'),
        matchKeys: [key],
        alias: key,
        group: '',
        mediaFile: file,
        overlayId: ovId,
      });
    }
  }
  return { version: 2, gifts, overlays, groups: [] };
}

function loadMapping() {
  const raw = loadJson(MAPPING_PATH, null);
  const m = migrateMapping(raw);
  if (!raw || raw.version !== 2) saveJson(MAPPING_PATH, m); // upgrade on disk
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
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'BIGO Action',
    icon: APP_ICON || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  // Null out ref khi window closed - tránh gọi method trên destroyed object
  win.on('closed', () => { win = null; });
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
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});

app.whenReady().then(async () => {
  mapping = loadMapping();
  overlayManager = new OverlayManager({
    onBoundsChanged: (overlayId, b) => {
      const ov = mapping.overlays.find(o => o.id === overlayId);
      if (!ov) return;
      ov.bounds = { x: b.x, y: b.y, width: b.width, height: b.height };
      saveJson(MAPPING_PATH, mapping);
    },
  });
  createWindow();
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
  if (listener) listener.stop().catch(() => {});
  if (overlayManager) overlayManager.destroyAll();
  if (process.platform !== 'darwin') app.quit();
});

// =================== Settings & mapping IPC ===================
ipcMain.handle('settings:load', () => loadJson(CONFIG_PATH, {
  env: 'prod', accessToken: '', gameId: '', openid: '', bigoId: '',
}));
ipcMain.handle('settings:save', (_e, data) => { saveJson(CONFIG_PATH, data); return true; });

ipcMain.handle('mapping:load', () => mapping);
ipcMain.handle('mapping:save', (_e, data) => {
  mapping = data;
  saveJson(MAPPING_PATH, mapping);
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

// Mở dialog chọn 1 hoặc nhiều file mp3/mp4/webm/wav rồi copy vào assets/effects.
// Trả về tên file mới (hoặc null nếu user huỷ).
ipcMain.handle('effects:pick-files', async () => {
  if (!win) return { ok: false };
  const res = await dialog.showOpenDialog(win, {
    title: 'Chọn file hiệu ứng (mp3/mp4/webm/wav/ogg)',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Media', extensions: ['mp4', 'webm', 'mp3', 'wav', 'ogg', 'gif'] },
      { name: 'All', extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
  fs.mkdirSync(EFFECTS_DIR, { recursive: true });
  const copied = [];
  const skipped = [];
  for (const src of res.filePaths) {
    const base = path.basename(src);
    const dst = path.join(EFFECTS_DIR, base);
    try {
      if (path.resolve(src) === path.resolve(dst)) {
        skipped.push(base);
        continue;
      }
      fs.copyFileSync(src, dst);
      copied.push(base);
    } catch (e) {
      // ignore individual errors but continue
    }
  }
  return { ok: true, copied, skipped };
});

// Mở folder assets/effects bằng file explorer
ipcMain.handle('effects:open-folder', async () => {
  fs.mkdirSync(EFFECTS_DIR, { recursive: true });
  const { shell } = require('electron');
  await shell.openPath(EFFECTS_DIR);
  return { ok: true };
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

ipcMain.handle('overlay:show', (_e, overlayId) => {
  const cfg = mapping.overlays.find(o => o.id === overlayId);
  if (!cfg) return { ok: false, error: 'overlay không tồn tại' };
  overlayManager.show(cfg);
  return { ok: true };
});
ipcMain.handle('overlay:hide', (_e, overlayId) => {
  overlayManager.hide(overlayId);
  return { ok: true };
});
ipcMain.handle('overlay:apply-config', (_e, cfg) => {
  // cfg đến từ renderer khi user edit overlay → cập nhật mapping & live update window
  const idx = mapping.overlays.findIndex(o => o.id === cfg.id);
  if (idx === -1) return { ok: false };
  mapping.overlays[idx] = { ...mapping.overlays[idx], ...cfg };
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
ipcMain.handle('overlay:play', (_e, { overlayId, file }) => {
  const cfg = mapping.overlays.find(o => o.id === overlayId);
  if (!cfg || !file) return { ok: false };
  const full = path.join(EFFECTS_DIR, file);
  if (!fs.existsSync(full)) return { ok: false, error: 'file không tồn tại' };
  overlayManager.play(cfg, fileUrl(full));
  return { ok: true };
});
