const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { BigoClient } = require('./bigo-client');
const { BigoWebListener } = require('./web-embed');
const { OverlayManager } = require('./overlay-manager');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config', 'settings.json');
const MAPPING_PATH = path.join(ROOT, 'config', 'gift-mapping.json');
const EFFECTS_DIR = path.join(ROOT, 'assets', 'effects');

let win;
let client = null;
let listener = null;
let overlayManager = null;

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

// =================== App ===================
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'BIGO Action',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(() => {
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
    return fs.readdirSync(EFFECTS_DIR)
      .filter(f => /\.(mp4|webm|mp3|wav|ogg|gif)$/i.test(f))
      .map(f => ({ file: f, path: path.join(EFFECTS_DIR, f) }));
  } catch { return []; }
});

// =================== Open API (OAuth) ===================
ipcMain.handle('bigo:start', async (_e, opts) => {
  if (client) await client.stop().catch(() => {});
  client = new BigoClient({
    env: opts.env, accessToken: opts.accessToken, gameId: opts.gameId, openid: opts.openid,
    onEvent: (ev) => { if (win) win.webContents.send('bigo:event', ev); },
    onLog: (msg) => { if (win) win.webContents.send('bigo:log', msg); },
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

// =================== Web Embed Listener ===================
ipcMain.handle('embed:start', async (_e, opts) => {
  // Always stop and recreate — đảm bảo đổi ID là restart phiên
  if (listener) {
    try { await listener.stop(); } catch {}
  }
  listener = new BigoWebListener({
    onEvent: (ev) => { if (win) win.webContents.send('embed:event', ev); },
    onLog: (msg) => { if (win) win.webContents.send('bigo:log', `[embed] ${msg}`); },
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
