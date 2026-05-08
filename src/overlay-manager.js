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

// Multi-monitor aware clamp.
// - Nếu bounds có x,y hợp lệ → tìm display gần nhất với CENTER point của window
//   để hỗ trợ kéo overlay sang màn hình phụ mà không bị reset.
// - Nếu bounds completely off-screen mới fallback về primary display.
function clampToScreen(b) {
  let display = null;
  if (b && b.x != null && b.y != null && b.width && b.height) {
    const cx = Math.round(b.x + b.width / 2);
    const cy = Math.round(b.y + b.height / 2);
    try { display = screen.getDisplayNearestPoint({ x: cx, y: cy }); } catch {}
  }
  if (!display) display = screen.getPrimaryDisplay();
  const wa = display.workArea;

  const w = Math.min(b.width || 540, wa.width);
  const h = Math.min(b.height || 960, wa.height);
  let x = b.x;
  let y = b.y;
  // Chỉ reset nếu COMPLETELY ngoài display (không còn 1 phần nào trong vùng nhìn thấy).
  // Cho phép overlay hơi tràn mép — user có thể đặt vị trí flex.
  if (x == null || x + w <= wa.x || x >= wa.x + wa.width) {
    x = wa.x + wa.width - w - 40;
  }
  if (y == null || y + h <= wa.y || y >= wa.y + wa.height) {
    y = wa.y + 40;
  }
  return { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) };
}

class OverlayWindow {
  constructor(cfg, onBoundsSave) {
    this.cfg = cfg;
    this.onBoundsSave = onBoundsSave || (() => {});
    this.win = null;
    this._saveTimer = null;
  }

  // Debounced save — gọi từ move/resize event continuous. Reset timer mỗi 400ms.
  _scheduleSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._flushSave(), 400);
  }

  // Synchronous save NOW — gọi từ moved/resized (one-shot end-of-drag) và quan trọng nhất
  // là từ 'close' event để bắt vị trí cuối cùng TRƯỚC khi window destroy.
  _flushSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    if (!this.win || this.win.isDestroyed()) return;
    try {
      const b = this.win.getBounds();
      if (b && b.width > 0 && b.height > 0) {
        this.onBoundsSave({ x: b.x, y: b.y, width: b.width, height: b.height });
      }
    } catch {}
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

    // ========== Bounds tracking listeners ==========
    // 'move' / 'resize' fire continuously khi user đang drag → debounce 400ms để giảm I/O.
    this.win.on('move', () => this._scheduleSave());
    this.win.on('resize', () => this._scheduleSave());
    // 'moved' (macOS) / 'resized' (Win/Linux) fire MỘT LẦN khi user thả chuột → flush ngay.
    this.win.on('moved', () => this._flushSave());
    this.win.on('resized', () => this._flushSave());
    // 'close' fire TRƯỚC khi window bị destroy. Đây là cơ hội cuối cùng để getBounds().
    // Nếu user kéo rồi đóng nhanh trong <400ms, debounce timer chưa fire → 'close' bắt nốt.
    this.win.on('close', () => this._flushSave());
    // 'closed' fire SAU khi destroy → chỉ dọn reference, KHÔNG getBounds() vì sẽ throw/null.
    this.win.on('closed', () => {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
      this.win = null;
    });

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
    if (this.win && !this.win.isDestroyed()) {
      // Trước khi hide cũng flush bounds — phòng user move rồi click hide nhanh.
      this._flushSave();
      this.win.hide();
    }
  }

  destroy() {
    if (this.win && !this.win.isDestroyed()) {
      this._flushSave();
      this.win.destroy();
    }
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

  _ensure(cfg) {
    let ov = this.overlays.get(cfg.id);
    if (!ov) {
      // Pass save callback at construct time → listeners attach trực tiếp trong create().
      // Không còn monkey-patch fragile.
      ov = new OverlayWindow(cfg, (b) => {
        try { this.onBoundsChanged(cfg.id, b); } catch (e) { console.warn('[overlay bounds save]', e); }
      });
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
