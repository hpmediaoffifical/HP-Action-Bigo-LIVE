const { ipcRenderer } = require('electron');

const player = document.getElementById('player');
const audio = document.getElementById('audio');

// =================== Config ===================
function hexToRgb(hex) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || '').trim());
  if (!m) return { r: 0, g: 255, b: 0 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

function applyConfig(cfg) {
  if (!cfg) return;
  const { r, g, b } = hexToRgb(cfg.bgColor || '#00FF00');
  const a = cfg.alpha != null ? Math.max(0, Math.min(1, cfg.alpha)) : 1;
  document.body.style.backgroundColor = `rgba(${r}, ${g}, ${b}, ${a})`;
  if (cfg.clickThrough) document.body.classList.add('locked');
  else document.body.classList.remove('locked');
}

// =================== Queue ===================
const queue = [];
let playing = false;

// Stop session — mỗi lần receive 'overlay:stop', tăng nonce. Plays với nonce
// CŨ (in-flight trước stop) sẽ bị reject. Giải quyết triệt để race condition
// khi app gửi N overlay:play sync, user delete giữa chừng → một số IPC vẫn
// đang trên đường tới overlay → chúng arrive sau stop → start play lại.
let stopNonce = 0;
let blockPlaysUntil = 0;

// Tốc độ phát — TÁCH 2 axis độc lập:
//   currentAudioSpeed → audio.playbackRate (mp3/wav/ogg).
//   currentVideoSpeed → player.playbackRate (mp4/webm).
// Giữ giá trị qua các lần playNext (apply lại sau player.load()).
let currentAudioSpeed = 1.0;
let currentVideoSpeed = 1.0;

function isVideo(url) { return /\.(mp4|webm)(\?|$)/i.test(url); }
function isAudio(url) { return /\.(mp3|wav|ogg)(\?|$)/i.test(url); }

// Clear video element triệt để - tránh vệt mờ frame cuối + đảm bảo OBS
// không bắt được frame cũ.
function clearPlayer() {
  try {
    player.pause();
    player.currentTime = 0;
    player.removeAttribute('src');
    player.load(); // flush frame buffer
  } catch {}
  player.style.display = 'none';
  // Defensive: hide via opacity + visibility (OBS Window Capture sometimes
  // captures hidden display:none if rendering thread chưa flush)
  player.style.opacity = '0';
  player.style.visibility = 'hidden';
}
function clearAudio() {
  try {
    audio.pause();
    audio.currentTime = 0;
    audio.removeAttribute('src');
    audio.load();
  } catch {}
}

function playNext() {
  if (queue.length === 0) {
    playing = false;
    clearPlayer();
    try { ipcRenderer.send('overlay:queue-empty'); } catch {}
    return;
  }
  playing = true;
  const url = queue.shift();
  if (isVideo(url)) {
    clearAudio();
    player.src = url;
    player.muted = false;
    player.style.display = 'block';
    player.style.opacity = '1';
    player.style.visibility = 'visible';
    player.playbackRate = currentVideoSpeed;  // VIDEO speed
    player.play().catch(() => setTimeout(playNext, 100));
  } else if (isAudio(url)) {
    clearPlayer();
    audio.src = url;
    audio.playbackRate = currentAudioSpeed;   // AUDIO speed
    audio.play().catch(() => setTimeout(playNext, 100));
  } else {
    player.src = url;
    player.style.display = 'block';
    player.style.opacity = '1';
    player.style.visibility = 'visible';
    player.playbackRate = currentVideoSpeed;
    player.play().catch(() => setTimeout(playNext, 100));
  }
}

player.addEventListener('ended', () => {
  clearPlayer();
  try { ipcRenderer.send('overlay:effect-ended'); } catch {}
  playNext();
});
audio.addEventListener('ended', () => {
  clearAudio();
  try { ipcRenderer.send('overlay:effect-ended'); } catch {}
  playNext();
});
player.addEventListener('error', () => {
  clearPlayer();
  // Sau error, vẫn tiếp tục queue (defensive) — nhưng nếu queue trống thì noop.
  if (queue.length > 0) playNext();
  else { playing = false; try { ipcRenderer.send('overlay:queue-empty'); } catch {} }
});
audio.addEventListener('error', () => {
  clearAudio();
  if (queue.length > 0) playNext();
  else playing = false;
});

ipcRenderer.on('overlay:config', (_e, cfg) => applyConfig(cfg));

// Set tốc độ. Nhận { audioRate, videoRate } object hoặc number (legacy).
// Apply ngay nếu đang play + lưu cho file kế tiếp.
ipcRenderer.on('overlay:set-speed', (_e, opts) => {
  if (typeof opts === 'number') {
    const r = Math.max(0.25, Math.min(3, opts || 1));
    currentAudioSpeed = r;
    currentVideoSpeed = r;
  } else if (opts && typeof opts === 'object') {
    if (opts.audioRate != null) currentAudioSpeed = Math.max(0.25, Math.min(3, parseFloat(opts.audioRate) || 1));
    if (opts.videoRate != null) currentVideoSpeed = Math.max(0.25, Math.min(3, parseFloat(opts.videoRate) || 1));
  }
  try { player.playbackRate = currentVideoSpeed; } catch {}
  try { audio.playbackRate = currentAudioSpeed; } catch {}
});

// QUAN TRỌNG: ignore plays during block window (sau stop) hoặc stale nonce.
ipcRenderer.on('overlay:play', (_e, url) => {
  if (!url) return;
  if (Date.now() < blockPlaysUntil) {
    // Trong block window — ignore play này (in-flight từ trước stop).
    return;
  }
  queue.push(url);
  if (!playing) playNext();
});

// User xoá item playing → stop NGAY + block plays trong 500ms để drain in-flight.
ipcRenderer.on('overlay:stop', () => {
  stopNonce++;
  queue.length = 0;
  playing = false;
  clearPlayer();
  clearAudio();
  // Block window 500ms — đủ thời gian cho mọi IPC in-flight (gốc từ event handler
  // for-loop) đi qua và bị ignore. Sau 500ms, plays mới được accept.
  blockPlaysUntil = Date.now() + 500;
  try { ipcRenderer.send('overlay:queue-empty'); } catch {}
});
