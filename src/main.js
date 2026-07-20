const { app, BrowserWindow, ipcMain, nativeImage, dialog, shell, clipboard, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { BigoClient } = require('./bigo-client');
const { BigoWebListener } = require('./web-embed');
const { OverlayManager } = require('./overlay-manager');
const { ObsOverlayServer } = require('./obs-overlay-server');
const { ObsWebSocketClient } = require('./obs-websocket-client');
const autoUpdater = require('./auto-updater');

const ROOT = path.join(__dirname, '..');

// Khi packaged, app.asar là read-only file (không phải directory) — không thể write
// config/settings.json vào trong đó. Chuyển sang userData (Windows convention).
// Dev mode: vẫn dùng folder config/ trong repo để dev sửa trực tiếp dễ hơn.
const USER_DATA_DIR = app.getPath('userData');
const CONFIG_DIR = app.isPackaged
  ? path.join(USER_DATA_DIR, 'config')
  : path.join(ROOT, 'config');
const USER_ASSETS_DIR = app.isPackaged
  ? path.join(USER_DATA_DIR, 'assets')
  : path.join(ROOT, 'assets');
const SHIPPED_ASSETS_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'assets')
  : path.join(ROOT, 'assets');
const SHIPPED_CONFIG_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar.unpacked', 'config')
  : path.join(ROOT, 'config');

const CONFIG_PATH = path.join(CONFIG_DIR, 'settings.json');
const MAPPING_PATH = path.join(CONFIG_DIR, 'gift-mapping.json');
const GIFT_MASTER_PATH = path.join(CONFIG_DIR, 'gift-master.json');
const VN_GIFTS_PATH = path.join(CONFIG_DIR, 'vietnam-gifts.json');
// Shipped fallback nếu user chưa override file VN gifts
const SHIPPED_VN_GIFTS_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar.unpacked', 'config', 'vietnam-gifts.json')
  : path.join(ROOT, 'config', 'vietnam-gifts.json');
// Ghi chú/NOTE cho từng quà (vd "NPC", "VN, NPC") — map theo ID quà. User nạp từ cột E của Google Sheet.
const GIFT_NOTES_PATH = path.join(CONFIG_DIR, 'gift-notes.json');
const EFFECTS_DIR = path.join(SHIPPED_ASSETS_DIR, 'effects');
const GIFT_ICONS_DIR = path.join(USER_ASSETS_DIR, 'gift-icons');
const GIFT_MASTER_TTL = 24 * 3600 * 1000; // 24h

function bootstrapUserDirs() {
  try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); } catch {}
  try { fs.mkdirSync(GIFT_ICONS_DIR, { recursive: true }); } catch {}
  if (app.isPackaged) {
    for (const f of ['gift-mapping.json', 'gift-master.json', 'vietnam-gifts.json', 'sheet-known-gift-ids.json', 'gift-notes.json']) {
      const dst = path.join(CONFIG_DIR, f);
      const src = path.join(SHIPPED_CONFIG_DIR, f);
      if (!fs.existsSync(dst) && fs.existsSync(src)) {
        try { fs.copyFileSync(src, dst); } catch {}
      }
    }
  }
}
bootstrapUserDirs();

// =================== VN gifts (override giá KC theo khu vực Việt Nam) ===================
// File: config/vietnam-gifts.json — bundled trong installer, user có thể replace bằng IPC import.
// Khi 1 gift typeid match → ưu tiên giá KC từ file VN, để hiển thị đúng giá khu vực.
let vnGifts = { byTypeId: new Map(), gifts: [], source: null, fetchedAt: 0 };
function loadVnGifts() {
  let raw = loadJson(VN_GIFTS_PATH, null);
  if (!raw || !Array.isArray(raw.gifts) || raw.gifts.length === 0) {
    raw = loadJson(SHIPPED_VN_GIFTS_PATH, null);
  }
  if (!raw || !Array.isArray(raw.gifts)) {
    vnGifts = { byTypeId: new Map(), gifts: [], source: null, fetchedAt: 0 };
    return;
  }
  const m = new Map();
  for (const g of raw.gifts) {
    if (g.typeid != null) m.set(Number(g.typeid), g);
  }
  vnGifts = {
    byTypeId: m,
    gifts: raw.gifts,
    source: raw.source || 'vietnam-gifts.json',
    fetchedAt: raw.fetchedAt || 0,
  };
}

// =================== Gift NOTES (cột E "KHU VỰC/NOTE": NPC, sự kiện, …) ===================
// File: config/gift-notes.json → { notes: { "<typeid>": "VN, NPC", … } }. User nạp từ Google Sheet.
// Note là chuỗi tự do, có thể gộp nhiều giá trị ngăn cách bằng dấu phẩy. App tách thành tags để hiện badge.
let giftNotes = new Map(); // typeid(Number) → noteString
function parseNoteTags(noteStr) {
  if (!noteStr) return [];
  return String(noteStr).split(/[,\/;|]+/).map(s => s.trim()).filter(Boolean);
}
function loadGiftNotes() {
  const raw = loadJson(GIFT_NOTES_PATH, null);
  const obj = raw && raw.notes && typeof raw.notes === 'object' ? raw.notes : {};
  const m = new Map();
  for (const [k, v] of Object.entries(obj)) {
    const id = Number(k);
    const note = v == null ? '' : String(v).trim();
    if (Number.isFinite(id) && note) m.set(id, note);
  }
  giftNotes = m;
  return m;
}
function saveGiftNotes(obj) {
  saveJson(GIFT_NOTES_PATH, {
    note: 'Ghi chú/NOTE cho từng quà (vd "NPC", "VN, NPC") — map theo ID quà → chuỗi note. Hiện badge trong danh sách.',
    updatedAt: Date.now(),
    notes: obj,
  });
}

// App icon — Windows ưu tiên .ico, fallback .png. Khi packaged đọc từ resources.
const ICO_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar.unpacked', 'logo-hp.ico')
  : path.join(ROOT, 'logo-hp.ico');
const PNG_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar.unpacked', 'logo-hp.png')
  : path.join(ROOT, 'logo-hp.png');
const APP_ICON = fs.existsSync(ICO_PATH) ? ICO_PATH : (fs.existsSync(PNG_PATH) ? PNG_PATH : null);
// Không gọi setName — Electron tự dùng productName từ package.json,
// đảm bảo userData path đồng bộ với tên hiển thị.
process.title = 'HP Action - BIGO LIVE';

// Windows: set AppUserModelID để taskbar group đúng và hiện icon
if (process.platform === 'win32') {
  app.setAppUserModelId('com.hp.bigoaction');
}

let win;
const MAIN_DEFAULT_SIZE = { width: 1040, height: 700 };
const MAIN_MIN_SIZE = { width: 900, height: 600 };
const MAIN_MAX_INITIAL_SIZE = { width: 1240, height: 840 };
// Preset kích thước cửa sổ (gọn / vừa / rộng) — dùng cho nút đổi nhanh trên sidebar
const MAIN_SIZE_PRESETS = {
  compact: { width: 1040, height: 700, label: 'Gọn' },
  medium: { width: 1180, height: 780, label: 'Vừa' },
  wide: { width: 1360, height: 860, label: 'Rộng' },
};
let client = null;
let listener = null;
let parsedEventSeq = 0;
let overlayManager = null;
let obsOverlayServer = null;
let obsBrowserRefreshPromise = null;
let lastObsBrowserRefreshAt = 0;
let currentOverlaySpeed = { audioRate: 1, videoRate: 1 };
let hotkeySendChain = Promise.resolve();
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

const HOTKEY_VK = {
  CTRL: 0x11, CONTROL: 0x11,
  SHIFT: 0x10,
  ALT: 0x12, OPTION: 0x12,
  WIN: 0x5B, WINDOWS: 0x5B, META: 0x5B, CMD: 0x5B, COMMAND: 0x5B,
  SPACE: 0x20, ENTER: 0x0D, RETURN: 0x0D, ESC: 0x1B, ESCAPE: 0x1B, TAB: 0x09,
  BACKSPACE: 0x08, DELETE: 0x2E, DEL: 0x2E, INSERT: 0x2D, INS: 0x2D,
  HOME: 0x24, END: 0x23, PAGEUP: 0x21, PAGEDOWN: 0x22, PGUP: 0x21, PGDN: 0x22,
  UP: 0x26, DOWN: 0x28, LEFT: 0x25, RIGHT: 0x27,
  PLUS: 0xBB, '+': 0xBB, MINUS: 0xBD, '-': 0xBD,
  COMMA: 0xBC, ',': 0xBC, PERIOD: 0xBE, '.': 0xBE, SLASH: 0xBF, '/': 0xBF,
  SEMICOLON: 0xBA, ';': 0xBA, QUOTE: 0xDE, "'": 0xDE, BACKQUOTE: 0xC0, '`': 0xC0,
  LBRACKET: 0xDB, '[': 0xDB, RBRACKET: 0xDD, ']': 0xDD, BACKSLASH: 0xDC, '\\': 0xDC,
};
for (let i = 1; i <= 24; i++) HOTKEY_VK[`F${i}`] = 0x70 + i - 1;
for (let i = 0; i <= 9; i++) {
  HOTKEY_VK[String(i)] = 0x30 + i;
  HOTKEY_VK[`NUMPAD${i}`] = 0x60 + i;
}
for (let i = 0; i < 26; i++) HOTKEY_VK[String.fromCharCode(65 + i)] = 0x41 + i;

function parseHotkeyKeys(hotkey) {
  const parts = String(hotkey || '')
    .split(/[+\s]+/)
    .map(s => s.trim().toUpperCase())
    .filter(Boolean);
  const keys = [];
  for (const part of parts) {
    const vk = HOTKEY_VK[part];
    if (!vk) return null;
    if (!keys.includes(vk)) keys.push(vk);
  }
  return keys.length ? keys : null;
}

function sendGlobalHotkey(hotkey) {
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, error: 'Chỉ hỗ trợ Windows' });
  const keys = parseHotkeyKeys(hotkey);
  if (!keys) return Promise.resolve({ ok: false, error: 'Phím tắt không hợp lệ' });
  const nums = keys.map(n => parseInt(n, 10)).filter(n => Number.isInteger(n) && n > 0 && n <= 255);
  if (!nums.length) return Promise.resolve({ ok: false, error: 'Phím tắt không hợp lệ' });
  const ps = `$ErrorActionPreference='Stop'; Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);' -Name Keyboard -Namespace Win32; $keys=@(${nums.join(',')}); foreach($k in $keys){[Win32.Keyboard]::keybd_event([byte]$k,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 12}; Start-Sleep -Milliseconds 90; [array]::Reverse($keys); foreach($k in $keys){[Win32.Keyboard]::keybd_event([byte]$k,0,2,[UIntPtr]::Zero); Start-Sleep -Milliseconds 12}; Start-Sleep -Milliseconds 35`;
  const encoded = Buffer.from(ps, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, timeout: 5000 }, (err) => {
      if (err) resolve({ ok: false, error: err.message || String(err) });
      else resolve({ ok: true });
    });
  });
}

function enqueueGlobalHotkey(hotkey) {
  const run = () => sendGlobalHotkey(hotkey);
  hotkeySendChain = hotkeySendChain.catch(() => {}).then(run);
  return hotkeySendChain;
}

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

function clonePlain(obj) {
  return obj == null ? obj : JSON.parse(JSON.stringify(obj));
}

function normalizeExportInclude(include) {
  return {
    mapping: include?.mapping !== false,
    settings: !!include?.settings,
    overlays: include?.overlays !== false,
  };
}

function pickSettingsForExport(settings, include) {
  if (!include?.settings) return null;
  return clonePlain(settings || {});
}

function mergeSettings(current, incoming) {
  if (!incoming || typeof incoming !== 'object') return current || {};
  return { ...(current || {}), ...clonePlain(incoming) };
}

function mergeMapping(current, incoming) {
  const dst = migrateMapping(clonePlain(current || defaultMapping()));
  const src = migrateMapping(clonePlain(incoming || {}));
  ensureCommonGroup(dst);
  if (!Array.isArray(dst.groups)) dst.groups = [];
  if (!Array.isArray(dst.overlays)) dst.overlays = [];

  const overlayIdMap = new Map();
  for (const srcOv of (src.overlays || [])) {
    if (!srcOv || !srcOv.id) continue;
    const sameId = dst.overlays.find(o => o.id === srcOv.id);
    const sameName = sameId ? null : dst.overlays.find(o => String(o.name || '').trim().toLowerCase() === String(srcOv.name || '').trim().toLowerCase());
    const target = sameId || sameName;
    if (target) {
      const oldId = srcOv.id;
      Object.assign(target, clonePlain(srcOv), { id: target.id });
      overlayIdMap.set(oldId, target.id);
    } else {
      dst.overlays.push(clonePlain(srcOv));
      overlayIdMap.set(srcOv.id, srcOv.id);
    }
  }

  const remapGroup = (group) => {
    const next = clonePlain(group);
    next.items = (next.items || []).map(item => ({
      ...item,
      overlayId: item.overlayId && overlayIdMap.has(item.overlayId) ? overlayIdMap.get(item.overlayId) : item.overlayId,
    }));
    return next;
  };

  for (const srcGroup of (src.groups || [])) {
    if (!srcGroup || !srcGroup.id) continue;
    const incomingGroup = remapGroup(srcGroup);
    const sameId = dst.groups.find(g => g.id === incomingGroup.id);
    const sameName = sameId ? null : dst.groups.find(g => String(g.name || '').trim().toLowerCase() === String(incomingGroup.name || '').trim().toLowerCase());
    const target = sameId || sameName;
    if (target) {
      Object.assign(target, incomingGroup, { id: target.id, isCommon: target.isCommon || incomingGroup.isCommon });
    } else {
      dst.groups.push(incomingGroup);
    }
  }

  ensureCommonGroup(dst);
  return dst;
}

function mediaBasename(mediaFile) {
  let s = String(mediaFile || '').trim();
  if (!s) return '';
  if (/^file:\/\//i.test(s)) {
    try { s = decodeURIComponent(new URL(s).pathname).replace(/^\/(?=[A-Za-z]:)/, ''); } catch {}
  }
  return path.basename(s.replace(/\\/g, path.sep));
}

function migrateMissingMediaToBundledEffects(m) {
  let changed = false;
  const resolveExisting = (mediaFile) => {
    if (!mediaFile) return '';
    let p = String(mediaFile);
    if (/^file:\/\//i.test(p)) {
      try { p = decodeURIComponent(new URL(p).pathname).replace(/^\/(?=[A-Za-z]:)/, ''); } catch {}
    } else if (!path.isAbsolute(p)) {
      p = path.join(EFFECTS_DIR, p);
    }
    try { if (fs.existsSync(p)) return mediaFile; } catch {}
    const base = mediaBasename(mediaFile);
    if (base && fs.existsSync(path.join(EFFECTS_DIR, base))) {
      changed = true;
      return base;
    }
    return mediaFile;
  };
  for (const group of (m.groups || [])) {
    for (const item of (group.items || [])) {
      const files = Array.isArray(item.mediaFiles) ? item.mediaFiles.map(resolveExisting) : [];
      const primary = resolveExisting(item.mediaFile || files[0] || '');
      if (files.length) item.mediaFiles = files;
      if (primary) item.mediaFile = primary;
    }
  }
  return changed;
}

function loadMapping() {
  const raw = loadJson(MAPPING_PATH, null);
  const m = migrateMapping(raw);
  ensureCommonGroup(m);  // Đảm bảo NHÓM CHUNG luôn ở đầu
  const mediaMigrated = migrateMissingMediaToBundledEffects(m);
  if (!raw || raw.version !== 3 || !raw.groups?.some?.(g => g.isCommon) || mediaMigrated) {
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

function normalizeGiftEventFields(ev) {
  if (!ev || (ev.type !== 'gift' && ev.type !== 'gift_overlay')) return ev;
  if (ev.gift_id == null) {
    ev.gift_id = ev.giftId ?? ev.gift_type_id ?? ev.giftTypeId ?? ev.typeid ?? ev.type_id ?? ev.gift?.typeid ?? ev.gift?.id ?? ev.gift?.gift_id ?? ev.gift_id;
  }
  if (!ev.gift_name) {
    ev.gift_name = ev.giftName || ev.gift?.name || ev.gift?.gift_name || ev.name || '';
  }
  if (!ev.gift_icon) {
    ev.gift_icon = ev.gift_icon_url || ev.gift_url || ev.iconUrl || ev.icon || ev.gift?.img_url || ev.gift?.icon || '';
  }
  if (ev.gift_count == null && ev.count != null) ev.gift_count = ev.count;
  return ev;
}

function enrichGiftEvent(ev) {
  if (!ev || (ev.type !== 'gift' && ev.type !== 'gift_overlay')) return ev;
  normalizeGiftEventFields(ev);
  let meta = null;
  const iconUrl = ev.gift_icon || ev.gift_icon_url || ev.gift_url || ev.iconUrl || ev.icon;
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
  // VN override: nếu typeid có trong vietnam-gifts.json → ưu tiên giá KC khu vực VN.
  // Giữ vm_exchange_rate global trong meta, chỉ override gift_value xuống dòng dưới.
  const giftTypeId = Number(ev.gift_id);
  if (Number.isFinite(giftTypeId) && vnGifts.byTypeId && vnGifts.byTypeId.has(giftTypeId)) {
    const vn = vnGifts.byTypeId.get(giftTypeId);
    ev.vn_match = true;
    if (vn.diamonds != null) ev.gift_value = vn.diamonds;
    if (vn.name) ev.gift_name_vn = vn.name;
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
  if (!s.obsOverlay.webSocketPort) s.obsOverlay.webSocketPort = 4456;
  if (s.obsOverlay.webSocketPassword == null) s.obsOverlay.webSocketPassword = '';
  if (s.obsOverlay.autoRefreshBrowserSources == null) s.obsOverlay.autoRefreshBrowserSources = true;
  saveSettings(s);
  return s.obsOverlay;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function refreshObsBrowserSources(reason, { cooldownMs = 10000 } = {}) {
  const obsCfg = ensureObsOverlaySettings();
  if (!obsCfg.autoRefreshBrowserSources) return { ok: false, skipped: 'disabled' };
  if (obsBrowserRefreshPromise) return obsBrowserRefreshPromise;
  if (Date.now() - lastObsBrowserRefreshAt < cooldownMs) return { ok: false, skipped: 'cooldown' };

  lastObsBrowserRefreshAt = Date.now();
  const client = new ObsWebSocketClient({
    port: obsCfg.webSocketPort,
    password: obsCfg.webSocketPassword,
    overlayPort: obsCfg.port,
  });
  obsBrowserRefreshPromise = client.refreshAppBrowserSources()
    .then((result) => {
      const detail = result.matched
        ? `đã làm mới ${result.refreshed}/${result.matched} Browser Source HP Action`
        : 'không tìm thấy Browser Source HP Action nào';
      if (win && !win.isDestroyed()) {
        try { win.webContents.send('bigo:log', `[obs-websocket] ${reason}: ${detail}`); } catch {}
      }
      return result;
    })
    .catch((e) => {
      const error = e?.message || String(e);
      if (win && !win.isDestroyed()) {
        try { win.webContents.send('bigo:log', `[obs-websocket] ${reason}: không kết nối được OBS tại 127.0.0.1:${obsCfg.webSocketPort} (${error})`); } catch {}
      }
      return { ok: false, error };
    })
    .finally(() => { obsBrowserRefreshPromise = null; });
  return obsBrowserRefreshPromise;
}

async function waitForObsOverlayClient(overlayId, timeoutMs = 1200) {
  const endAt = Date.now() + timeoutMs;
  while (Date.now() < endAt) {
    if (obsOverlayServer?.hasClients(overlayId)) return true;
    await wait(100);
  }
  return obsOverlayServer?.hasClients(overlayId) || false;
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
function getInitialMainBounds() {
  const saved = getSavedBounds('main', MAIN_DEFAULT_SIZE) || MAIN_DEFAULT_SIZE;
  const width0 = Math.max(saved.width || MAIN_DEFAULT_SIZE.width, MAIN_MIN_SIZE.width);
  const height0 = Math.max(saved.height || MAIN_DEFAULT_SIZE.height, MAIN_MIN_SIZE.height);
  const display = screen.getDisplayMatching({ x: saved.x || 0, y: saved.y || 0, width: width0, height: height0 });
  const area = display?.workArea || screen.getPrimaryDisplay().workArea;
  const width = Math.min(width0, area.width);
  const height = Math.min(height0, area.height);
  const maxX = area.x + Math.max(0, area.width - width);
  const maxY = area.y + Math.max(0, area.height - height);
  const hasPos = Number.isFinite(saved.x) && Number.isFinite(saved.y);
  return {
    ...saved,
    width,
    height,
    x: hasPos ? Math.min(Math.max(saved.x, area.x), maxX) : saved.x,
    y: hasPos ? Math.min(Math.max(saved.y, area.y), maxY) : saved.y,
  };
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
  const saved = getInitialMainBounds();
  win = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    minWidth: MAIN_MIN_SIZE.width,
    minHeight: MAIN_MIN_SIZE.height,
    resizable: true,
    maximizable: true,
    x: saved.x, y: saved.y,
    title: 'Action - Bigo LIVE',
    icon: APP_ICON || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMinimumSize(MAIN_MIN_SIZE.width, MAIN_MIN_SIZE.height);
  win.setMenuBarVisibility(false);
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !input.control || input.alt || input.shift || String(input.key).toLowerCase() !== 'r') return;
    // Prevent Chromium's normal reload and refresh only HP Action effect overlays in OBS.
    event.preventDefault();
    refreshObsBrowserSources('làm mới thủ công (Ctrl+R)', { cooldownMs: 0 }).catch(() => {});
  });
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
      title: 'Action - BIGO LIVE',
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

ipcMain.handle('app:window-size-lock', (_e, locked) => {
  if (!win || win.isDestroyed()) return { ok: false, error: 'Main window not ready' };
  const shouldLock = locked !== false;
  try { saveWindowBounds('main', win.getBounds()); } catch {}
  win.setMinimumSize(MAIN_MIN_SIZE.width, MAIN_MIN_SIZE.height);
  win.setResizable(!shouldLock);
  win.setMaximizable(!shouldLock);
  return { ok: true, locked: shouldLock };
});

// Đổi nhanh kích thước cửa sổ theo preset (gọn / vừa / rộng) — canh giữa màn hình đang chứa cửa sổ.
ipcMain.handle('app:window-set-preset', (_e, preset) => {
  if (!win || win.isDestroyed()) return { ok: false, error: 'Main window not ready' };
  const size = MAIN_SIZE_PRESETS[preset] || MAIN_SIZE_PRESETS.compact;
  try {
    // Mở khoá resize tạm nếu đang khoá, để setBounds có hiệu lực
    win.setResizable(true);
    win.setMaximizable(true);
    if (win.isMaximized()) win.unmaximize();
    const cur = win.getBounds();
    const display = screen.getDisplayMatching(cur);
    const wa = display.workArea;
    const w = Math.min(size.width, wa.width);
    const h = Math.min(size.height, wa.height);
    const x = Math.round(wa.x + (wa.width - w) / 2);
    const y = Math.round(wa.y + (wa.height - h) / 2);
    win.setBounds({ x, y, width: w, height: h });
    saveWindowBounds('main', win.getBounds());
  } catch (err) {
    return { ok: false, error: String(err) };
  }
  return { ok: true, preset, size };
});

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
  loadVnGifts();
  loadGiftNotes();
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
    onWindowReady: (_overlayId, ov) => {
      if (ov?.win && !ov.win.isDestroyed()) {
        try { ov.win.webContents.send('overlay:set-speed', currentOverlaySpeed); } catch {}
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
        try { win.webContents.send('overlay:effect-ended', { overlayId }); } catch {}
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
  // Auto-update: chỉ chạy ở bản đã đóng gói. Dev mode (npm start) bỏ qua.
  try { autoUpdater.init(win); } catch (e) { console.warn('auto-updater init failed:', e); }
  setTimeout(() => {
    for (const ov of (mapping.overlays || [])) {
      if (ov.autoOpen) {
        try { overlayManager.show(ov); } catch (e) { console.warn('autoOpen overlay failed:', e); }
      }
    }
    focusMainWindow();
  }, 1200);
  // OBS Browser Source can retain a dead SSE connection after OBS or this app restarts.
  // Refresh only HP Action sources after the local overlay server is ready.
  setTimeout(() => { refreshObsBrowserSources('khởi động ứng dụng').catch(() => {}); }, 1800);
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

// =================== Auto-updater IPC ===================
ipcMain.handle('updater:check', async () => {
  return await autoUpdater.checkManually();
});
ipcMain.handle('updater:download', () => {
  autoUpdater.startDownload();
  return { ok: true };
});
ipcMain.handle('updater:state', () => autoUpdater.getState());

// =================== License (HP KEY - hpvn.media) ===================
// Backend cu (Google Apps Script) da thay bang HP KEY. Cau hinh: hpkey/config.js
// + hpkey/public-key.js. Giu nguyen IPC interface => renderer khong phai sua.

// Generate machine ID bằng đúng HWID mà HP KEY gửi lên server.
ipcMain.handle('license:machine-id', () => {
  return require('../hpkey/hwid').getHWID();
});

// Xac thuc qua HP KEY (hpvn.media). Tra ve { ok:true, data:{TRANG_THAI,...} }
// hoac { ok:false, error } - dung shape renderer dang doc.
let _hpkeyCurrentKey = '';
let _hpkeyWatching = false;
ipcMain.handle('license:verify', async (_e, { key, action }) => {
  const normalizedKey = require('../hpkey/core').normalizeKey(key);
  const res = await require('../hpkey/validate').licenseVerify(normalizedKey, action);
  if (res && res.ok) {
    _hpkeyCurrentKey = normalizedKey;
    if (!_hpkeyWatching) {
      _hpkeyWatching = true;
      // Check key real-time: cam key tren admin -> dong app trong <= RECHECK_SECONDS
      try {
        const RECHECK = require('../hpkey/config').RECHECK_SECONDS || 60;
        // Chống văng oan: server chỉ trả ok:false 1 lần (lỗi 500/timeout/mạng chập chờn)
        // KHÔNG đóng app ngay. Chỉ đóng khi bị từ chối 2 lần LIÊN TIẾP (admin thật sự
        // khóa/thu hồi/hết hạn). Mất mạng đã được core bỏ qua (_offline) từ trước.
        let _revokeStrikes = 0;
        let _lastRevokeAt = 0;
        require('../hpkey/core').startWatch({
          getKey: () => _hpkeyCurrentKey,
          onRevoked: (reason) => {
            const now = Date.now();
            // Nếu lần từ chối trước cách quá lâu → đã có lần verify OK xen giữa → reset streak.
            if (now - _lastRevokeAt > RECHECK * 1000 * 2.5) _revokeStrikes = 0;
            _lastRevokeAt = now;
            _revokeStrikes++;
            if (_revokeStrikes < 2) {
              console.warn('[hpkey] revoke strike', _revokeStrikes, '- bỏ qua tạm:', reason);
              return;
            }
            try {
              dialog.showErrorBox('Bản quyền bị thu hồi',
                'KEY của bạn đã bị khóa/thu hồi hoặc hết hạn (' + reason + ').\n' +
                'Ứng dụng sẽ đóng. Liên hệ HP Media để được hỗ trợ.');
            } catch (_) {}
            app.quit();
            setTimeout(() => { try { app.exit(0); } catch (_) {} }, 1500);
          },
        });
      } catch (e) { console.warn('[hpkey] watch init failed:', e && e.message); }
    }
  }
  return res;
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
function normalizeMediaRef(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  const q = s.indexOf('?');
  if (q >= 0) s = s.slice(0, q);
  const h = s.indexOf('#');
  if (h >= 0) s = s.slice(0, h);
  if (/^file:\/\//i.test(s)) {
    try {
      s = new URL(s).pathname;
    } catch {
      return '';
    }
    s = s.replace(/^\/(?=[A-Za-z]:)/, '');
  }
  try { s = decodeURIComponent(s); } catch {}
  return s;
}
function mediaCandidatePaths(raw) {
  const cleaned = normalizeMediaRef(raw);
  if (!cleaned) return [];
  const set = new Set();
  const add = (p) => {
    if (!p) return;
    const s = String(p);
    set.add(s);
    set.add(s.replace(/\\/g, '/'));
  };
  const isAbs = path.isAbsolute(cleaned) || /^[A-Za-z]:[\\/]/.test(cleaned);
  if (isAbs) {
    add(cleaned);
  } else {
    add(path.join(EFFECTS_DIR, cleaned));
    if (cleaned.includes('/') || cleaned.includes('\\')) {
      add(cleaned);
    }
  }
  const base = path.basename(cleaned);
  if (base && base !== cleaned) {
    add(path.join(EFFECTS_DIR, base));
  }
  return Array.from(set);
}

ipcMain.handle('effects:exists', (_e, mediaFile) => {
  if (!mediaFile || typeof mediaFile !== 'string') return false;
  for (const p of mediaCandidatePaths(mediaFile)) {
    try {
      if (fs.existsSync(p)) return true;
    } catch {}
  }
  return false;
});

ipcMain.handle('effects:resolve-url', (_e, mediaFile) => {
  if (!mediaFile || typeof mediaFile !== 'string') return { ok: false, error: 'thiếu file' };
  for (const p of mediaCandidatePaths(mediaFile)) {
    try {
      if (fs.existsSync(p)) return { ok: true, url: fileUrl(p) };
    } catch {}
  }
  return { ok: false, error: 'file không tồn tại' };
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
ipcMain.handle('config:export', async (_e, opts = {}) => {
  if (!win) return { ok: false };
  const include = normalizeExportInclude(opts.include || {});
  const exportMode = opts.mode === 'group' ? 'group' : 'all';
  const sourceMapping = mapping || loadMapping();
  let exportMapping = null;
  if (include.mapping) {
    const groups = exportMode === 'group'
      ? (sourceMapping.groups || []).filter(g => g.id === opts.groupId)
      : (sourceMapping.groups || []);
    if (exportMode === 'group' && groups.length === 0) return { ok: false, error: 'Chưa chọn nhóm để xuất' };
    const overlayIds = new Set();
    for (const g of groups) for (const item of (g.items || [])) if (item.overlayId) overlayIds.add(item.overlayId);
    exportMapping = {
      version: 3,
      groups: clonePlain(groups),
      overlays: include.overlays ? clonePlain((sourceMapping.overlays || []).filter(o => exportMode === 'all' || overlayIds.has(o.id))) : [],
    };
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const res = await dialog.showSaveDialog(win, {
    title: 'Xuất cài đặt BIGO Action',
    defaultPath: exportMode === 'group' ? `bigo-action-group-${ts}.json` : `bigo-action-config-${ts}.json`,
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
    exportMode,
    include,
    settings: pickSettingsForExport(loadJson(CONFIG_PATH, {}), include),
    mapping: exportMapping,
  };
  try {
    fs.writeFileSync(res.filePath, JSON.stringify(bundle, null, 2), 'utf8');
    return { ok: true, filePath: res.filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Nhập bundle - merge settings + mapping, không xoá nhóm/overlay khác trên máy hiện tại.
ipcMain.handle('config:import', async (_e, opts = {}) => {
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
  if (bundle.mapping && (!Array.isArray(bundle.mapping.groups) || !Array.isArray(bundle.mapping.overlays))) {
    return { ok: false, error: 'Bundle mapping không hợp lệ (thiếu groups hoặc overlays)' };
  }
  const include = normalizeExportInclude({ ...(bundle.include || {}), ...(opts.include || {}) });
  const before = mapping || loadMapping();
  try {
    if (include.settings && bundle.settings && typeof bundle.settings === 'object') {
      saveJson(CONFIG_PATH, mergeSettings(loadJson(CONFIG_PATH, {}), bundle.settings));
    }
    if (include.mapping && bundle.mapping) {
      const incoming = clonePlain(bundle.mapping);
      if (!include.overlays) incoming.overlays = [];
      mapping = mergeMapping(before, incoming);
    } else {
      mapping = before;
    }
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
        importedGroups: bundle.mapping?.groups?.length || 0,
        importedOverlays: include.overlays ? (bundle.mapping?.overlays?.length || 0) : 0,
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
    onEvent: (ev) => {
      normalizeGiftEventFields(ev);
      enrichGiftEvent(ev);
      if (win && !win.isDestroyed()) win.webContents.send('bigo:event', ev);
    },
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

// =================== Translate IPC (Dịch chat) ===================
// Dịch text qua Google Translate endpoint free (client=gtx). Chạy ở MAIN process
// để né CORS — renderer fetch thẳng sẽ bị chặn. Trả { ok, text, detected }.
const translateCache = new Map();
const TRANSLATE_CACHE_TTL_MS = 10 * 60 * 1000;
const TRANSLATE_CACHE_MAX = 500;
const TRANSLATE_CHUNK_MAX = 900;

function translateCacheKey(text, sl, tl) {
  return `${sl}|${tl}|${crypto.createHash('sha1').update(text).digest('hex')}`;
}

function getTranslateCache(key) {
  const hit = translateCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > TRANSLATE_CACHE_TTL_MS) {
    translateCache.delete(key);
    return null;
  }
  return hit.value;
}

function setTranslateCache(key, value) {
  translateCache.set(key, { value, ts: Date.now() });
  if (translateCache.size > TRANSLATE_CACHE_MAX) {
    const first = translateCache.keys().next().value;
    if (first) translateCache.delete(first);
  }
}

function splitTranslateText(text, max = TRANSLATE_CHUNK_MAX) {
  if (text.length <= max) return [text];
  const parts = [];
  let pos = 0;
  while (pos < text.length) {
    let end = Math.min(pos + max, text.length);
    if (end < text.length) {
      const slice = text.slice(pos, end);
      const punct = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '), slice.lastIndexOf(', '));
      const space = slice.lastIndexOf(' ');
      const cut = punct > max * 0.45 ? punct + 1 : (space > max * 0.55 ? space : -1);
      if (cut > 0) end = pos + cut;
    }
    const part = text.slice(pos, end).trim();
    if (part) parts.push(part);
    pos = end;
  }
  return parts;
}

async function fetchTranslateChunk(text, sl, tl) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx`
        + `&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&dt=t`
        + `&q=${encodeURIComponent(text)}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const translated = Array.isArray(data && data[0])
        ? data[0].map(seg => (seg && seg[0]) || '').join('')
        : '';
      return { text: translated, detected: (data && data[2]) || sl };
    } catch (e) {
      lastError = e;
      if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw lastError || new Error('translate failed');
}

ipcMain.handle('translate:text', async (_e, opts = {}) => {
  const text = String(opts.text || '').trim();
  const tl = String(opts.to || 'vi');
  const sl = String(opts.from || 'auto');
  if (!text) return { ok: false, error: 'empty' };
  const cacheKey = translateCacheKey(text, sl, tl);
  const cached = getTranslateCache(cacheKey);
  if (cached) return cached;
  try {
    const chunks = splitTranslateText(text);
    const translatedParts = [];
    let detected = sl;
    for (const chunk of chunks) {
      const r = await fetchTranslateChunk(chunk, sl, tl);
      translatedParts.push(r.text);
      if (!detected || detected === 'auto' || detected === sl) detected = r.detected || detected;
    }
    const result = { ok: true, text: translatedParts.join(' ').replace(/\s+/g, ' ').trim(), detected };
    setTranslateCache(cacheKey, result);
    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Đọc chat bằng Google Translate TTS — trả MP3 giọng tự nhiên (vd vi-VN) mà
// KHÔNG cần cài giọng Windows. Renderer đã chia đoạn; main vẫn cap phòng thủ.
// Trả data URL base64 để renderer phát qua <audio>.
ipcMain.handle('tts:google', async (_e, opts = {}) => {
  const text = String(opts.text || '').trim().slice(0, 200);
  const tl = String(opts.lang || 'vi');
  if (!text) return { ok: false, error: 'empty' };
  try {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob`
      + `&tl=${encodeURIComponent(tl)}&q=${encodeURIComponent(text)}`;
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://translate.google.com/',
    };
    let res = null;
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        res = await fetch(url, { headers });
        if (res.ok) break;
        lastError = new Error(`HTTP ${res.status}`);
      } catch (e) {
        lastError = e;
      }
      if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!res) throw lastError || new Error('TTS fetch failed');
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: true, dataUrl: `data:audio/mpeg;base64,${buf.toString('base64')}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// =================== Từ cấm đồng bộ Google Sheet ===================
// Tab COMMENT, cột A của spreadsheet công khai. Lấy qua endpoint gviz CSV
// (không cần API key), cache xuống file để dùng offline.
const FORBIDDEN_SHEET_ID = '1Fv9Jdno_pPMTx_-tnwSfRObm1r1wKds_gaMBnfCDm4M';
const FORBIDDEN_SHEET_TAB = 'COMMENT';
const FORBIDDEN_CACHE_PATH = path.join(CONFIG_DIR, 'forbidden-words.json');

// Parse cột A từ CSV gviz (giá trị có thể được bọc trong dấu ").
function parseCsvFirstColumn(csv) {
  const out = [];
  for (const rawLine of String(csv).split(/\r?\n/)) {
    if (!rawLine) continue;
    let val;
    if (rawLine[0] === '"') {
      let j = 1, s = '';
      while (j < rawLine.length) {
        if (rawLine[j] === '"') {
          if (rawLine[j + 1] === '"') { s += '"'; j += 2; continue; }
          break;
        }
        s += rawLine[j]; j++;
      }
      val = s;
    } else {
      const c = rawLine.indexOf(',');
      val = c >= 0 ? rawLine.slice(0, c) : rawLine;
    }
    val = val.trim();
    if (val) out.push(val);
  }
  return out;
}

ipcMain.handle('forbidden:sync', async () => {
  try {
    // headers=0: ép gviz KHÔNG coi dòng 1 là header (nếu không nó gộp cả cột A
    // thành 1 blob). Khi đó cột A = đúng danh sách từ cấm từng dòng.
    const url = `https://docs.google.com/spreadsheets/d/${FORBIDDEN_SHEET_ID}`
      + `/gviz/tq?tqx=out:csv&headers=0&sheet=${encodeURIComponent(FORBIDDEN_SHEET_TAB)}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const csv = await res.text();
    let words = parseCsvFirstColumn(csv);
    // Bỏ ô tiêu đề "TỪ KHÓA CẤM".
    if (words[0] && /TỪ\s*KHÓA\s*CẤM/i.test(words[0])) words = words.slice(1);
    words = [...new Set(words.map(w => w.toLowerCase()).filter(Boolean))];
    saveJson(FORBIDDEN_CACHE_PATH, { words, fetchedAt: Date.now() });
    return { ok: true, words, count: words.length, source: 'sheet' };
  } catch (e) {
    const cached = loadJson(FORBIDDEN_CACHE_PATH, { words: [] });
    const words = Array.isArray(cached.words) ? cached.words : [];
    return { ok: false, error: e.message, words, count: words.length, source: 'cache' };
  }
});

// Trả cache hiện có ngay (không gọi mạng) — dùng lúc khởi động.
ipcMain.handle('forbidden:cached', () => {
  const cached = loadJson(FORBIDDEN_CACHE_PATH, { words: [] });
  const words = Array.isArray(cached.words) ? cached.words : [];
  return { words, count: words.length, fetchedAt: cached.fetchedAt || 0 };
});

// =================== Gift master IPC ===================
function decorateGift(g) {
  const typeid = Number(g.typeid);
  const vn = vnGifts.byTypeId && Number.isFinite(typeid) ? vnGifts.byTypeId.get(typeid) : null;
  // Tags hiển thị badge: gộp note thủ công (gift-notes.json) + tự thêm "VN" nếu quà có trong danh mục VN.
  const noteStr = giftNotes.has(typeid) ? giftNotes.get(typeid) : '';
  const tags = parseNoteTags(noteStr);
  if (vn && !tags.some(t => t.toUpperCase() === 'VN')) tags.unshift('VN');
  return {
    ...g,
    diamonds: vn?.diamonds != null ? vn.diamonds : rateToDiamonds(g.vm_exchange_rate),
    diamondsGlobal: rateToDiamonds(g.vm_exchange_rate),
    localIcon: localIconUrl(g.typeid),
    vn_match: !!vn,
    vn_name: vn?.name || null,
    vn_diamonds: vn?.diamonds ?? null,
    note: noteStr,
    tags,
  };
}

ipcMain.handle('gifts:master-list', () => (giftMaster.gifts || []).map(decorateGift));

// =================== VN gifts IPC ===================
ipcMain.handle('vn-gifts:status', () => ({
  count: vnGifts.gifts.length,
  source: vnGifts.source,
  fetchedAt: vnGifts.fetchedAt,
}));
ipcMain.handle('vn-gifts:list', () => vnGifts.gifts.slice());
ipcMain.handle('vn-gifts:has', (_e, typeid) => {
  const id = Number(typeid);
  return !!(vnGifts.byTypeId && vnGifts.byTypeId.has(id));
});
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

// =================== Quét quà mới cho Google Sheet ===================
// Dò quà BIGO chưa có trong Sheet (so với snapshot ID đã lưu) rồi xuất TSV để dán.
const SHEET_KNOWN_IDS_PATH = path.join(CONFIG_DIR, 'sheet-known-gift-ids.json');
function loadKnownGiftIds() {
  const data = loadJson(SHEET_KNOWN_IDS_PATH, null);
  const arr = (data && Array.isArray(data.ids)) ? data.ids : [];
  return new Set(arr.map(Number).filter(Number.isFinite));
}
function saveKnownGiftIds(set) {
  const ids = [...set].filter(Number.isFinite).sort((a, b) => a - b);
  saveJson(SHEET_KNOWN_IDS_PATH, {
    note: 'ID quà đã có trong Google Sheet (baseline để dò quà mới).',
    updatedAt: Date.now(),
    ids,
  });
  return ids.length;
}
// ĐƠN GIÁ KC: ưu tiên giá khu vực VN nếu có, ngược lại vm_exchange_rate / 100.
function giftPriceKC(g) {
  const id = Number(g.typeid);
  if (vnGifts.byTypeId && vnGifts.byTypeId.has(id)) {
    const vn = vnGifts.byTypeId.get(id);
    if (vn && vn.diamonds != null) return vn.diamonds;
  }
  return rateToDiamonds(g.vm_exchange_rate);
}

// Quét quà mới: fetch master mới nhất rồi lọc ra ID chưa có trong snapshot.
ipcMain.handle('gifts:scan-new', async () => {
  const r = await ensureGiftMaster(true);
  if (!r.ok) return { ok: false, error: r.error || 'Không tải được danh sách quà BIGO — kiểm tra mạng.' };
  const known = loadKnownGiftIds();
  const fresh = [];
  const seen = new Set(); // dedupe: mỗi ID quà chỉ lấy 1 lần (BIGO đôi khi trả trùng typeid)
  for (const g of (giftMaster.gifts || [])) {
    const id = Number(g.typeid);
    if (!Number.isFinite(id) || known.has(id) || seen.has(id)) continue;
    seen.add(id);
    fresh.push({ id, name: g.name || '', img_url: g.img_url || '', priceKC: giftPriceKC(g), region: giftNotes.get(id) || 'VN' });
  }
  fresh.sort((a, b) => a.id - b.id);
  return {
    ok: true,
    total: (giftMaster.gifts || []).length,
    knownCount: known.size,
    newCount: fresh.length,
    gifts: fresh,
    fallback: !!r.fallback,
  };
});

// Đánh dấu đã thêm vào Sheet: merge ID vào snapshot để lần sau không hiện lại.
ipcMain.handle('gifts:known-add', (_e, ids) => {
  const known = loadKnownGiftIds();
  let added = 0;
  for (const x of (Array.isArray(ids) ? ids : [])) {
    const id = Number(x);
    if (Number.isFinite(id) && !known.has(id)) { known.add(id); added++; }
  }
  const knownCount = saveKnownGiftIds(known);
  return { ok: true, added, knownCount };
});

// Nạp NOTE từ Google Sheet: merge { id → note } vào gift-notes.json. Note rỗng = xoá note của quà đó.
// entries: [{ id, note }] — renderer parse từ clipboard (cột ID QUÀ + cột KHU VỰC/NOTE).
ipcMain.handle('gifts:notes-import', (_e, entries) => {
  const raw = loadJson(GIFT_NOTES_PATH, null);
  const map = raw && raw.notes && typeof raw.notes === 'object' ? { ...raw.notes } : {};
  let updated = 0, cleared = 0;
  for (const ent of (Array.isArray(entries) ? entries : [])) {
    const id = Number(ent && ent.id);
    if (!Number.isFinite(id)) continue;
    const note = String((ent && ent.note) ?? '').trim();
    const key = String(id);
    if (note) {
      if (map[key] !== note) updated++;
      map[key] = note;
    } else if (map[key] != null) {
      delete map[key];
      cleared++;
    }
  }
  saveGiftNotes(map);
  loadGiftNotes();
  return { ok: true, updated, cleared, total: Object.keys(map).length };
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
  // Đẩy cùng state ra OBS browser-source overlay (/heart) qua SSE.
  if (obsOverlayServer) { try { obsOverlayServer.sendHeartState(payload || {}); } catch {} }
  return { ok: true };
});
ipcMain.handle('heart:copy-url', () => {
  if (!obsOverlayServer) return { ok: false, error: 'OBS overlay server chưa sẵn sàng' };
  const url = obsOverlayServer.getHeartUrl();
  clipboard.writeText(url);
  return { ok: true, url };
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
      if (ev && ev.kind === 'parsed') {
        ev.ts = ev.ts || Date.now();
        ev.event_id = ev.event_id || `${ev.ts}_${++parsedEventSeq}`;
      }
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
  return normalizeMediaRef(url);
}
function resolveEffectPath({ file, fileUrl: rawUrl }) {
  if (rawUrl) {
    const parsed = pathFromFileUrl(rawUrl);
    if (parsed) return parsed;
  }
  const cleaned = normalizeMediaRef(file);
  if (!cleaned) return null;
  if (path.isAbsolute(cleaned) || /^[A-Za-z]:[\\/]/.test(cleaned)) return cleaned;
  return path.join(EFFECTS_DIR, cleaned);
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
ipcMain.on('overlay:effect-ended', (e) => {
  let overlayId = null;
  try {
    for (const [id, ov] of overlayManager.overlays.entries()) {
      if (ov.win && !ov.win.isDestroyed() && ov.win.webContents === e.sender) { overlayId = id; break; }
    }
  } catch {}
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('overlay:effect-ended', { overlayId }); } catch {}
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
  currentOverlaySpeed = { ...currentOverlaySpeed, ...payload };
  if (overlayManager) {
    for (const ov of overlayManager.overlays.values()) {
      if (ov.win && !ov.win.isDestroyed()) {
        try { ov.win.webContents.send('overlay:set-speed', currentOverlaySpeed); } catch {}
      }
    }
  }
  if (obsOverlayServer) obsOverlayServer.setSpeed(currentOverlaySpeed);
  return { ok: true, ...currentOverlaySpeed };
});

ipcMain.handle('hotkey:send', (_e, { hotkey } = {}) => enqueueGlobalHotkey(hotkey));

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

ipcMain.handle('overlay:play', async (_e, { overlayId, file, fileUrl: rawUrl }) => {
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
    let sentToObs = obsOverlayServer ? obsOverlayServer.play(overlayId, fullPath) : false;
    if (!sentToObs) {
      const refreshed = await refreshObsBrowserSources('phục hồi Browser Source khi có quà');
      if (refreshed.ok && refreshed.matched > 0 && await waitForObsOverlayClient(overlayId)) {
        sentToObs = obsOverlayServer ? obsOverlayServer.play(overlayId, fullPath) : false;
      }
    }
    if (!sentToObs && win && !win.isDestroyed()) {
      try { win.webContents.send('bigo:log', `[obs-overlay] ${cfg.name || overlayId}: chưa có OBS Browser Source kết nối, bỏ qua 1 hiệu ứng`); } catch {}
      // Toast cảnh báo dễ thấy hơn log panel. Renderer tự throttle để không spam.
      try { win.webContents.send('warn:no-obs', { overlayId, overlayName: cfg.name || overlayId }); } catch {}
      setTimeout(() => { try { win.webContents.send('overlay:effect-ended', { overlayId }); } catch {} }, 50);
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
ipcMain.handle('pk-duo:copy-url', () => {
  if (!obsOverlayServer) return { ok: false, error: 'OBS overlay server chưa sẵn sàng' };
  const url = obsOverlayServer.getPkDuoUrl();
  clipboard.writeText(url);
  return { ok: true, url };
});
ipcMain.handle('pk-duo:update', (_e, state) => {
  if (obsOverlayServer) obsOverlayServer.sendPkDuoState(state || {});
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
