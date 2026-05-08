const { ipcRenderer } = require('electron');

const player = document.getElementById('player');
const audio = document.getElementById('audio');

function applyConfig(cfg) {
  if (!cfg) return;
  if (cfg.bgColor) document.body.style.backgroundColor = cfg.bgColor;
  // KHÔNG set body opacity nữa — opacity đã handle ở window level (BrowserWindow.setOpacity)
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
