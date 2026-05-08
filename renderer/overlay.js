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

function isVideo(url) { return /\.(mp4|webm)(\?|$)/i.test(url); }
function isAudio(url) { return /\.(mp3|wav|ogg)(\?|$)/i.test(url); }

// Clear video element triệt để - tránh vệt mờ frame cuối
function clearPlayer() {
  try {
    player.pause();
    player.removeAttribute('src');
    player.load(); // flush frame buffer
  } catch {}
  player.style.display = 'none';
}
function clearAudio() {
  try {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  } catch {}
}

function playNext() {
  if (queue.length === 0) {
    playing = false;
    clearPlayer();
    // Báo main biết queue rỗng → main có thể auto-hide window nếu config bật
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
    player.play().catch(() => {
      // Nếu play fail (vd file lỗi) thì tiếp tới quà sau
      setTimeout(playNext, 100);
    });
  } else if (isAudio(url)) {
    clearPlayer();
    audio.src = url;
    audio.play().catch(() => setTimeout(playNext, 100));
  } else {
    // Unknown - thử video trước
    player.src = url;
    player.play().catch(() => setTimeout(playNext, 100));
  }
}

player.addEventListener('ended', () => {
  clearPlayer();
  // Báo main để renderer chính advance UI queue
  try { ipcRenderer.send('overlay:effect-ended'); } catch {}
  playNext();
});
audio.addEventListener('ended', () => {
  clearAudio();
  try { ipcRenderer.send('overlay:effect-ended'); } catch {}
  playNext();
});
// Defensive: nếu lỗi cũng tiếp tục queue
player.addEventListener('error', () => {
  clearPlayer();
  playNext();
});
audio.addEventListener('error', () => {
  clearAudio();
  playNext();
});

ipcRenderer.on('overlay:config', (_e, cfg) => applyConfig(cfg));
ipcRenderer.on('overlay:play', (_e, url) => {
  if (!url) return;
  queue.push(url);
  if (!playing) playNext();
});
