// Hidden BrowserWindow load https://www.bigo.tv/<bigoid> rồi inject preload-embed.js
// để DOM-scrape chat/gift đã render. Forward events qua IPC.

const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const APP_ICON = fs.existsSync(path.join(ROOT, 'logo-hp.ico'))
  ? path.join(ROOT, 'logo-hp.ico')
  : (fs.existsSync(path.join(ROOT, 'logo-hp.png')) ? path.join(ROOT, 'logo-hp.png') : null);

class BigoWebListener {
  constructor({ onEvent, onLog }) {
    this.win = null;
    this.bigoId = null;
    this.onEvent = onEvent || (() => {});
    this.onLog = onLog || (() => {});
    this._bound = false;
    this._bindIpc();
  }

  _bindIpc() {
    if (this._bound) return;
    this._bound = true;
    const forward = (kind) => (_e, payload) => this.onEvent({ kind, ...payload });
    ipcMain.on('embed:ready', forward('ready'));
    ipcMain.on('embed:dom-attached', forward('dom-attached'));
    ipcMain.on('embed:parsed', forward('parsed'));
    ipcMain.on('embed:meta', forward('meta'));
    ipcMain.on('embed:scrape-error', forward('scrape-error'));
  }

  async start(bigoId, { visible = false } = {}) {
    if (this.win) await this.stop();
    this.bigoId = bigoId;
    this.onLog(`opening https://www.bigo.tv/${bigoId}`);
    this.win = new BrowserWindow({
      width: 480,
      height: 720,
      show: visible,
      title: `Bigo Listener · ${bigoId}`,
      icon: APP_ICON || undefined,
      webPreferences: {
        preload: path.join(__dirname, 'preload-embed.js'),
        contextIsolation: false,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: true,
        sandbox: false,
        webSecurity: true,
      },
    });
    this.win.setMenuBarVisibility(false);
    this.win.on('closed', () => { this.win = null; });
    // UA Chrome 131 (2025) — bigo có thể serve UI khác cho UA cũ.
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    await this.win.loadURL(`https://www.bigo.tv/${bigoId}`, { userAgent: ua });
    this.onLog('loaded');
  }

  async stop() {
    if (this.win) {
      try { this.win.destroy(); } catch {}
      this.win = null;
      this.onLog('stopped');
    }
  }

  // Bring embed window forward — restore nếu minimized, focus, toggle alwaysOnTop ngắn để pop lên
  showAndFocus() {
    if (!this.win || this.win.isDestroyed()) return false;
    try {
      if (this.win.isMinimized()) this.win.restore();
      this.win.show();
      this.win.setAlwaysOnTop(true);
      this.win.focus();
      this.win.moveTop();
      setTimeout(() => {
        try { if (this.win && !this.win.isDestroyed()) this.win.setAlwaysOnTop(false); } catch {}
      }, 600);
      return true;
    } catch { return false; }
  }
}

module.exports = { BigoWebListener };
