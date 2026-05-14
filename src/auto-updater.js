// =================== Auto-updater ===================
// Flow theo yêu cầu:
//   1) Kiểm tra cập nhật khi app khởi động (delay vài giây cho UI ổn định).
//   2) Nếu có version mới trên GitHub Releases → hỏi dialog Có / Không.
//   3) Bấm Có → tải file Setup mới, hiển thị tiến trình ở main window.
//   4) Tải xong → hỏi "Cài ngay?" → quitAndInstall() → NSIS chạy → app relaunch.
//   5) App khởi động lại → checkForUpdates() chạy tiếp → không còn version mới thì im lặng.
//
// Provider: GitHub Releases (hpmediaoffifical/bigo-action). Cần upload kèm
// `latest.yml` + file Setup-*.exe khi release (electron-builder --publish always lo việc này).
//
// Dev mode (electron .) sẽ KHÔNG check vì app.isPackaged = false — đó là hành vi mong muốn,
// chỉ build NSIS mới có updater hoạt động thật.

const { app, dialog, BrowserWindow, ipcMain } = require('electron');

let autoUpdater = null;
let mainWinRef = null;
let isCheckingManually = false;
let downloadInProgress = false;
let pendingUpdateInfo = null;

// Custom modal dialog: gửi IPC tới renderer hiển thị HTML modal đồng bộ theme app.
// Fallback về native dialog nếu renderer chưa sẵn sàng (lúc startup sớm).
let dialogIdCounter = 0;
const pendingDialogs = new Map();
let dialogIpcRegistered = false;
function ensureDialogIpc() {
  if (dialogIpcRegistered) return;
  dialogIpcRegistered = true;
  ipcMain.on('updater:dialog-response', (_e, payload) => {
    if (!payload) return;
    const { id, response } = payload;
    const resolve = pendingDialogs.get(id);
    if (resolve) {
      pendingDialogs.delete(id);
      resolve({ response });
    }
  });
}
function showAppDialog(opts) {
  return new Promise((resolve) => {
    const w = mainWinRef;
    if (!w || w.isDestroyed() || !w.webContents) {
      dialog.showMessageBox(undefined, opts).then(resolve).catch(() => resolve({ response: opts.cancelId ?? 0 }));
      return;
    }
    const id = `dlg_${++dialogIdCounter}`;
    pendingDialogs.set(id, resolve);
    // Timeout phòng renderer crash hoặc chưa load — fallback sau 30s
    setTimeout(() => {
      if (pendingDialogs.has(id)) {
        pendingDialogs.delete(id);
        resolve({ response: opts.cancelId ?? 0 });
      }
    }, 30000);
    try {
      w.webContents.send('updater:dialog', { id, ...opts });
    } catch {
      pendingDialogs.delete(id);
      dialog.showMessageBox(w, opts).then(resolve).catch(() => resolve({ response: opts.cancelId ?? 0 }));
    }
  });
}

function log(msg) {
  try { console.log('[updater]', msg); } catch {}
  const w = mainWinRef;
  if (w && !w.isDestroyed()) {
    try { w.webContents.send('bigo:log', `[updater] ${msg}`); } catch {}
  }
}

function sendStatus(payload) {
  const w = mainWinRef;
  if (w && !w.isDestroyed()) {
    try { w.webContents.send('updater:status', payload); } catch {}
  }
}

function tryRequireUpdater() {
  if (autoUpdater) return autoUpdater;
  try {
    autoUpdater = require('electron-updater').autoUpdater;
    // Chúng ta tự kiểm soát download + install (để hỏi user trước).
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowDowngrade = false;
    return autoUpdater;
  } catch (e) {
    log(`Không nạp được electron-updater: ${e.message}. Chạy "npm install" để cài.`);
    return null;
  }
}

function bindEvents(au) {
  au.on('error', (err) => {
    log(`Lỗi: ${err?.message || err}`);
    sendStatus({ state: 'error', message: err?.message || String(err) });
    if (isCheckingManually) {
      isCheckingManually = false;
      showAppDialog({
        type: 'error',
        title: 'Kiểm tra cập nhật',
        message: 'Không kiểm tra được cập nhật',
        detail: err?.message || String(err),
        buttons: ['Đóng'],
      }).catch(() => {});
    }
  });

  au.on('checking-for-update', () => {
    log('Đang kiểm tra...');
    sendStatus({ state: 'checking' });
  });

  au.on('update-not-available', (info) => {
    log(`Không có bản mới (đang chạy v${app.getVersion()}).`);
    sendStatus({ state: 'not-available', version: info?.version });
    if (isCheckingManually) {
      isCheckingManually = false;
      showAppDialog({
        type: 'info',
        title: 'Kiểm tra cập nhật',
        message: 'Bạn đang dùng bản mới nhất',
        detail: `Phiên bản hiện tại: v${app.getVersion()}`,
        buttons: ['OK'],
      }).catch(() => {});
    }
  });

  au.on('update-available', async (info) => {
    log(`Có bản mới v${info?.version}.`);
    pendingUpdateInfo = info;
    sendStatus({ state: 'available', version: info?.version, notes: info?.releaseNotes });
    if (downloadInProgress) return;
    const wasManual = isCheckingManually;
    isCheckingManually = false;
    const choice = await showAppDialog({
      type: 'update-available',
      title: 'Có bản cập nhật mới',
      message: `Phiên bản v${info?.version} đã sẵn sàng`,
      detail: [
        `Phiên bản hiện tại: v${app.getVersion()}`,
        `Phiên bản mới: v${info?.version}`,
        '',
        'Tải về và cập nhật ngay?',
        'Sau khi tải xong app sẽ tự cài và khởi động lại.',
      ].join('\n'),
      buttons: ['🚀 Cập nhật ngay', 'Để sau'],
      defaultId: 0,
      cancelId: 1,
    }).catch(() => ({ response: 1 }));
    if (choice.response === 0) {
      startDownload();
    } else {
      log('User chọn để sau.');
      void wasManual;
    }
  });

  au.on('download-progress', (p) => {
    const pct = Math.round(p.percent || 0);
    const speedKB = Math.round((p.bytesPerSecond || 0) / 1024);
    log(`Tải: ${pct}% (${speedKB} KB/s)`);
    sendStatus({
      state: 'downloading',
      percent: pct,
      bytesPerSecond: p.bytesPerSecond,
      transferred: p.transferred,
      total: p.total,
    });
  });

  au.on('update-downloaded', async (info) => {
    downloadInProgress = false;
    log(`Đã tải xong v${info?.version}.`);
    sendStatus({ state: 'downloaded', version: info?.version });
    const choice = await showAppDialog({
      type: 'update-ready',
      title: 'Sẵn sàng cài đặt',
      message: `Bản v${info?.version} đã tải xong`,
      detail: 'App sẽ đóng lại để cài đặt rồi tự khởi động lại. Tiếp tục?',
      buttons: ['✓ Cài đặt và khởi động lại', 'Để sau (cài khi thoát app)'],
      defaultId: 0,
      cancelId: 1,
    }).catch(() => ({ response: 0 }));
    if (choice.response === 0) {
      log('quitAndInstall()');
      setImmediate(() => {
        try {
          au.quitAndInstall(true, true);
        } catch (e) {
          log(`quitAndInstall lỗi: ${e.message}`);
        }
      });
    } else {
      // Cài khi user thoát app
      au.autoInstallOnAppQuit = true;
      log('Sẽ cài khi user thoát app.');
    }
  });
}

function startDownload() {
  const au = tryRequireUpdater();
  if (!au) return;
  if (downloadInProgress) return;
  downloadInProgress = true;
  sendStatus({ state: 'downloading', percent: 0 });
  log('Bắt đầu tải...');
  au.downloadUpdate().catch((e) => {
    downloadInProgress = false;
    log(`Tải lỗi: ${e?.message || e}`);
    sendStatus({ state: 'error', message: e?.message || String(e) });
    showAppDialog({
      type: 'error',
      title: 'Lỗi tải cập nhật',
      message: 'Không tải được bản cập nhật',
      detail: e?.message || String(e),
      buttons: ['Đóng'],
    }).catch(() => {});
  });
}

/**
 * Khởi tạo updater, bind events. Gọi 1 lần trong app.whenReady().
 *
 * @param {BrowserWindow} mainWindow - cửa sổ chính để gửi IPC/log/dialog parent.
 */
function init(mainWindow) {
  mainWinRef = mainWindow;
  ensureDialogIpc();
  if (!app.isPackaged) {
    log('Bỏ qua updater: app chưa được đóng gói (dev mode).');
    return;
  }
  const au = tryRequireUpdater();
  if (!au) return;
  bindEvents(au);
  // Delay nhẹ cho main window load xong rồi mới check
  setTimeout(() => {
    log('Auto-check khi khởi động...');
    au.checkForUpdates().catch((e) => log(`checkForUpdates lỗi: ${e?.message || e}`));
  }, 4000);
}

/**
 * Trigger thủ công từ nút "Kiểm tra cập nhật" trong UI.
 * Khi không có update sẽ show dialog "đã là bản mới nhất".
 */
async function checkManually() {
  if (!app.isPackaged) {
    await showAppDialog({
      type: 'info',
      title: 'Kiểm tra cập nhật',
      message: 'Tính năng cập nhật chỉ chạy trên bản đã cài đặt',
      detail: `Bạn đang chạy chế độ dev (npm start). Hãy build setup .exe để dùng auto-update.\nPhiên bản hiện tại: v${app.getVersion()}`,
      buttons: ['OK'],
    }).catch(() => {});
    return { ok: false, dev: true };
  }
  const au = tryRequireUpdater();
  if (!au) return { ok: false, error: 'electron-updater chưa được cài' };
  if (downloadInProgress) return { ok: true, busy: true };
  isCheckingManually = true;
  try {
    await au.checkForUpdates();
    return { ok: true };
  } catch (e) {
    isCheckingManually = false;
    return { ok: false, error: e?.message || String(e) };
  }
}

function getState() {
  return {
    isPackaged: app.isPackaged,
    version: app.getVersion(),
    downloadInProgress,
    pendingVersion: pendingUpdateInfo?.version || null,
  };
}

module.exports = { init, checkManually, startDownload, getState };
