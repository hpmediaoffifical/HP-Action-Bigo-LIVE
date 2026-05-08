const { ipcRenderer } = require('electron');

const player = document.getElementById('player');
const audio = document.getElementById('audio');
const handle = document.getElementById('dragHandle');

let hideTimer = null;

function applyConfig(cfg) {
  if (!cfg) return;
  if (cfg.bgColor) document.body.style.backgroundColor = cfg.bgColor;
  if (cfg.opacity != null) document.body.style.opacity = String(cfg.opacity);
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
    // unknown — try video first
    player.src = url;
    player.play().catch(() => {});
  }
}

ipcRenderer.on('overlay:config', (_e, cfg) => applyConfig(cfg));
ipcRenderer.on('overlay:play', (_e, url) => play(url));

// Auto-hide drag handle after a few seconds
function showHandle() {
  handle.style.opacity = '1';
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { handle.style.opacity = '0'; }, 2500);
}
document.addEventListener('mousemove', showHandle);
showHandle();
