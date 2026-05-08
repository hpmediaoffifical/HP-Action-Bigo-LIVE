const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { BigoClient } = require('./bigo-client');
const { BigoWebListener } = require('./web-embed');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config', 'settings.json');
const MAPPING_PATH = path.join(ROOT, 'config', 'gift-mapping.json');

let win;
let client = null;
let listener = null;

function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function saveJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 820,
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

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (listener) listener.stop().catch(() => {});
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('settings:load', () => loadJson(CONFIG_PATH, {
  env: 'prod', accessToken: '', gameId: '', openid: '', bigoId: '',
}));
ipcMain.handle('settings:save', (_e, data) => { saveJson(CONFIG_PATH, data); return true; });

ipcMain.handle('mapping:load', () => loadJson(MAPPING_PATH, { gifts: {}, hearts: null, msg: null }));
ipcMain.handle('mapping:save', (_e, data) => { saveJson(MAPPING_PATH, data); return true; });

ipcMain.handle('effects:list', () => {
  const dir = path.join(ROOT, 'assets', 'effects');
  try {
    return fs.readdirSync(dir)
      .filter(f => /\.(mp4|webm|mp3|wav|ogg|gif)$/i.test(f))
      .map(f => ({ file: f, path: path.join(dir, f) }));
  } catch { return []; }
});

// ---- Bigo Open API (polling, cần OAuth) ----
ipcMain.handle('bigo:start', async (_e, opts) => {
  if (client) await client.stop().catch(() => {});
  client = new BigoClient({
    env: opts.env,
    accessToken: opts.accessToken,
    gameId: opts.gameId,
    openid: opts.openid,
    onEvent: (ev) => { if (win) win.webContents.send('bigo:event', ev); },
    onLog: (msg) => { if (win) win.webContents.send('bigo:log', msg); },
  });
  try {
    await client.start();
    return { ok: true, gameSess: client.gameSess };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('bigo:stop', async () => {
  if (!client) return { ok: true };
  await client.stop();
  client = null;
  return { ok: true };
});

ipcMain.handle('bigo:test-event', (_e, type) => {
  if (!win) return;
  const samples = {
    gift: { type: 'gift', gift_id: 1234, gift_name: 'Test Rose', gift_count: 5, gift_value: 10, user: 'test_user', nick_name: 'Tester', ts: Date.now() },
    heart: { type: 'heart', count: 10, user: 'test_user', nick_name: 'Tester', ts: Date.now() },
    msg: { type: 'msg', content: 'xin chào streamer', user: 'test_user', nick_name: 'Tester', ts: Date.now() },
  };
  win.webContents.send('bigo:event', samples[type] || samples.gift);
});

// ---- Public web check (HLS / live status) ----
ipcMain.handle('bigo:check-live', async (_e, bigoId) => {
  try {
    const res = await fetch('https://ta.bigo.tv/official_website/studio/getInternalStudioInfo', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      body: `siteId=${encodeURIComponent(bigoId)}`,
    });
    const json = await res.json();
    return { ok: true, data: json };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---- Web Embed Listener (Phương án A) ----
ipcMain.handle('embed:start', async (_e, opts) => {
  if (!listener) {
    listener = new BigoWebListener({
      onEvent: (ev) => { if (win) win.webContents.send('embed:event', ev); },
      onLog: (msg) => { if (win) win.webContents.send('bigo:log', `[embed] ${msg}`); },
    });
  }
  try {
    await listener.start(opts.bigoId, { visible: !!opts.visible });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('embed:stop', async () => {
  if (listener) await listener.stop();
  return { ok: true };
});

ipcMain.handle('embed:show', () => { if (listener) listener.show(); return true; });
