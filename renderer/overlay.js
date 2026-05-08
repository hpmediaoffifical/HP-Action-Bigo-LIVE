const { ipcRenderer } = require('electron');

const player = document.getElementById('player');
const audio = document.getElementById('audio');
const handle = document.getElementById('dragHandle');

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
  // RGBA alpha = 0 → trong suốt tuyệt đối (cùng với BrowserWindow transparent:true)
  document.body.style.backgroundColor = `rgba(${r}, ${g}, ${b}, ${a})`;
  // Click-through (OBS mode): ẩn drag handle (window không nhận click anyway)
  if (handle) handle.style.display = cfg.clickThrough ? 'none' : '';
}

function isVideo(url) { return /\.(mp4|webm)(\?|$)/i.test(url); }
function isAudio(url) { return /\.(mp3|wav|ogg)(\?|$)/i.test(url); }

function play(url) {
  if (!url) return;
  if (isVideo(url)) {
    player.src = url;
    player.muted = false;
    player.style.display = 'block';
    audio.style.display = 'none';
    player.play().catch(() => {});
  } else if (isAudio(url)) {
    audio.src = url;
    audio.play().catch(() => {});
  } else {
    player.src = url;
    player.play().catch(() => {});
  }
}

ipcRenderer.on('overlay:config', (_e, cfg) => applyConfig(cfg));
ipcRenderer.on('overlay:play', (_e, url) => play(url));
