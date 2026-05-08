// Overlay window cho hiệu ứng — khung BrowserWindow frameless,
// phông xanh chroma key 1080×1920 (default), drag/resize/persistent.
// Hỗ trợ nhiều overlay (1 gift map vào 1 overlay).

const { BrowserWindow, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const RENDERER_PATH = path.join(ROOT, 'renderer', 'overlay.html');
const APP_ICON = fs.existsSync(path.join(ROOT, 'logo-hp.ico'))
  ? path.join(ROOT, 'logo-hp.ico')
  : (fs.existsSync(path.join(ROOT, 'logo-hp.png')) ? path.join(ROOT, 'logo-hp.png') : null);

function clampToScreen(b) {
  const { workArea } = screen.getPrimaryDisplay();
  const w = Math.min(b.width || 540, workArea.width);
  const h = Math.min(b.height || 960, workArea.height);
  let x = b.x;
  let y = b.y;
  if (x == null || x < workArea.x || x + w > workArea.x + workArea.width) {
    x = workArea.x + workArea.width - w - 40;
  }
  if (y == null || y < workArea.y || y + h > workArea.y + workArea.height) {
    y = workArea.y + 40;
  }
  return { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) };
}

class OverlayWindow {
  constructor(cfg) {
    this.cfg = cfg;
    this.win = null;
  }

  create() {
    if (this.win && !this.win.isDestroyed()) return;
    const b = clampToScreen(this.cfg.bounds || {});
    this.win = new BrowserWindow({
      title: `Overlay · ${this.cfg.name || this.cfg.id}`,
      icon: APP_ICON || undefined,
      x: b.x, y: b.y, width: b.width, height: b.height,
      frame: false,
      // transparent: true cho phép body background RGBA alpha=0 thật sự xuyên thấu.
      // OBS Window Capture vẫn bắt được window này dù trong suốt 100%.
      transparent: true,
      hasShadow: false,
      // Không set backgroundColor — để CSS body với RGBA quản lý.
      alwaysOnTop: !!this.cfg.alwaysOnTop,
      resizable: true,
      skipTaskbar: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        backgroundThrottling: false,
      },
    });
    this.win.setMenuBarVisibility(false);
    this.win.loadFile(RENDERER_PATH);
    this.win.webContents.once('did-finish-load', () => this.applyConfig());
    this.win.on('closed', () => { this.win = null; });
    if (this.cfg.alwaysOnTop) this.win.setAlwaysOnTop(true, 'screen-saver');
  }

  applyConfig() {
    if (!this.win || this.win.isDestroyed()) return;
    // Always-on-top
    this.win.setAlwaysOnTop(!!this.cfg.alwaysOnTop, this.cfg.alwaysOnTop ? 'screen-saver' : 'normal');
    // Click-through (OBS mode): không nhận click + ẩn taskbar + KHOÁ resize/move
    const ct = !!this.cfg.clickThrough;
    try {
      this.win.setIgnoreMouseEvents(ct, ct ? { forward: true } : undefined);
      this.win.setSkipTaskbar(ct);
      // Khi khoá (click-through ON): không cho phép resize hoặc move
      this.win.setResizable(!ct);
      this.win.setMovable(!ct);
    } catch {}
    // Khoá tỉ lệ khi resize: giữ aspect ratio hiện tại
    try {
      const lockRatio = this.cfg.lockRatio !== false; // default true
      const b = this.cfg.bounds || {};
      if (lockRatio && b.width && b.height) {
        this.win.setAspectRatio(b.width / b.height);
      } else {
        this.win.setAspectRatio(0); // disable
      }
    } catch {}
    // Send config xuống renderer cho CSS RGBA
    this.win.webContents.send('overlay:config', {
      bgColor: this.cfg.bgColor || '#00FF00',
      alpha: this.cfg.opacity != null ? this.cfg.opacity : 1.0,
      clickThrough: ct,
    });
  }

  play(fileUrl) {
    if (!this.win || this.win.isDestroyed()) this.create();
    const send = () => this.win.webContents.send('overlay:play', fileUrl);
    if (this.win.webContents.isLoading()) {
      this.win.webContents.once('did-finish-load', send);
    } else {
      send();
    }
    // Auto-show NHƯNG không steal focus — quan trọng cho user đang stream:
    // app/OBS đang focus, khi gift về overlay show ngầm để OBS capture nhưng không nhảy lên trước.
    try {
      if (!this.win.isVisible()) this.win.showInactive();
    } catch { try { this.win.show(); } catch {} }
  }

  showAndFocus() {
    if (!this.win || this.win.isDestroyed()) this.create();
    this.win.show();
    this.win.focus();
  }

  hide() {
    if (this.win && !this.win.isDestroyed()) this.win.hide();
  }

  destroy() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }

  getBounds() {
    if (this.win && !this.win.isDestroyed()) return this.win.getBounds();
    return null;
  }
}

class OverlayManager {
  constructor({ onBoundsChanged }) {
    this.onBoundsChanged = onBoundsChanged || (() => {});
    this.overlays = new Map(); // id -> OverlayWindow
  }

  _debounce(fn, ms) {
    let t = null;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  _ensure(cfg) {
    let ov = this.overlays.get(cfg.id);
    if (!ov) {
      ov = new OverlayWindow(cfg);
      const save = this._debounce(() => {
        const b = ov.getBounds();
        if (b) this.onBoundsChanged(cfg.id, b);
      }, 400);
      // attach listeners after create
      const origCreate = ov.create.bind(ov);
      ov.create = function () {
        origCreate();
        if (ov.win) {
          ov.win.on('move', save);
          ov.win.on('resize', save);
        }
      };
      this.overlays.set(cfg.id, ov);
    } else {
      ov.cfg = cfg;
    }
    return ov;
  }

  show(cfg) {
    const ov = this._ensure(cfg);
    if (!ov.win || ov.win.isDestroyed()) ov.create();
    ov.showAndFocus();
    ov.applyConfig();
    return ov;
  }

  hide(id) {
    const ov = this.overlays.get(id);
    if (ov) ov.hide();
  }

  destroy(id) {
    const ov = this.overlays.get(id);
    if (ov) { ov.destroy(); this.overlays.delete(id); }
  }

  destroyAll() {
    for (const ov of this.overlays.values()) ov.destroy();
    this.overlays.clear();
  }

  play(cfg, fileUrl) {
    const ov = this._ensure(cfg);
    if (!ov.win || ov.win.isDestroyed()) ov.create();
    ov.play(fileUrl);
  }

  applyConfig(cfg) {
    const ov = this._ensure(cfg);
    ov.applyConfig();
  }
}

module.exports = { OverlayManager, clampToScreen };
