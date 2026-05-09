const player = document.getElementById('player');
const audio = document.getElementById('audio');
const parts = location.pathname.split('/');
const overlayId = decodeURIComponent(parts[2] || '');
const token = new URLSearchParams(location.search).get('token') || '';
const queue = [];
let playing = false;
let blockPlaysUntil = 0;
let currentAudioSpeed = 1;
let currentVideoSpeed = 1;

function isVideo(url) { return /\.(mp4|webm)(\?|$)/i.test(url); }
function isAudio(url) { return /\.(mp3|wav|ogg)(\?|$)/i.test(url); }

function post(type, extra = {}) {
  fetch(`/api/overlay/${encodeURIComponent(overlayId)}/event?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, ...extra }),
  }).catch(() => {});
}

function clearPlayer() {
  try { player.pause(); player.currentTime = 0; player.removeAttribute('src'); player.load(); } catch {}
  player.style.display = 'none';
  player.style.opacity = '0';
  player.style.visibility = 'hidden';
}
function clearAudio() {
  try { audio.pause(); audio.currentTime = 0; audio.removeAttribute('src'); audio.load(); } catch {}
}

function playNext() {
  if (queue.length === 0) {
    playing = false;
    clearPlayer();
    post('queue-empty');
    return;
  }
  playing = true;
  const item = queue.shift();
  const url = item.mediaUrl;
  if (isVideo(url)) {
    clearAudio();
    player.src = url;
    player.muted = false;
    player.style.display = 'block';
    player.style.opacity = '1';
    player.style.visibility = 'visible';
    player.playbackRate = currentVideoSpeed;
    player.play().catch(() => setTimeout(playNext, 100));
  } else if (isAudio(url)) {
    clearPlayer();
    audio.src = url;
    audio.playbackRate = currentAudioSpeed;
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

function ended() {
  clearPlayer();
  clearAudio();
  post('effect-ended');
  playNext();
}
function errored() {
  clearPlayer();
  clearAudio();
  post('effect-error');
  if (queue.length > 0) playNext();
  else { playing = false; post('queue-empty'); }
}

player.addEventListener('ended', ended);
audio.addEventListener('ended', ended);
player.addEventListener('error', errored);
audio.addEventListener('error', errored);

const events = new EventSource(`/events/${encodeURIComponent(overlayId)}?token=${encodeURIComponent(token)}`);
events.addEventListener('play', (e) => {
  if (Date.now() < blockPlaysUntil) return;
  const data = JSON.parse(e.data || '{}');
  if (!data.mediaUrl) return;
  queue.push(data);
  if (!playing) playNext();
});
events.addEventListener('stop', () => {
  queue.length = 0;
  playing = false;
  clearPlayer();
  clearAudio();
  blockPlaysUntil = Date.now() + 500;
  post('queue-empty');
});
events.addEventListener('set-speed', (e) => {
  const opts = JSON.parse(e.data || '{}');
  if (opts.audioRate != null) currentAudioSpeed = Math.max(0.25, Math.min(3, parseFloat(opts.audioRate) || 1));
  if (opts.videoRate != null) currentVideoSpeed = Math.max(0.25, Math.min(3, parseFloat(opts.videoRate) || 1));
  try { player.playbackRate = currentVideoSpeed; } catch {}
  try { audio.playbackRate = currentAudioSpeed; } catch {}
});
