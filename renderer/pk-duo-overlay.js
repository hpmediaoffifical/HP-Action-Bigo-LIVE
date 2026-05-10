const token = new URLSearchParams(location.search).get('token') || '';
const root = document.getElementById('pkDuoRoot');

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmt(n) {
  return Math.max(0, Math.round(Number(n) || 0)).toLocaleString('en-US');
}
function hexToRgb(hex, fallback = '0,0,0') {
  const m = String(hex || '').trim().match(/^#([0-9a-f]{6})$/i);
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}
function giftHtml(gift, size) {
  const src = gift.iconId ? `/gift-icon/${encodeURIComponent(gift.iconId)}?token=${encodeURIComponent(token)}` : (gift.icon || '');
  return `<span class="pkduo-gift-icon" title="${escapeHtml(gift.name || '')}">${src ? `<img src="${escapeHtml(src)}" />` : '🎁'}</span>`;
}
function render(state = {}) {
  const a = state.teamA || { name: 'ĐỘI A', color: '#e0527f', gifts: [] };
  const b = state.teamB || { name: 'ĐỘI B', color: '#5f7cff', gifts: [] };
  const sec = Math.ceil((state.remainingMs || 0) / 1000);
  const status = state.status === 'prestart' ? `${sec}s` : (state.status === 'running' ? `${sec}s` : (state.status === 'finished' ? 'Kết thúc' : (state.content || 'Vui lòng chờ')));
  const aWidth = Math.max(8, Math.min(92, 50 + Number(state.push || 0)));
  const urgent = state.status === 'running' && sec <= 10 && sec > 0;
  root.innerHTML = `<div class="pkduo-board status-${escapeHtml(state.status || 'idle')}${urgent ? ' urgent' : ''}" style="--pk-a:${escapeHtml(a.color || '#d8587c')};--pk-b:${escapeHtml(b.color || '#6380ff')};--pk-bg:${hexToRgb(state.bgColor)};--pk-bg-opacity:${((Number(state.bgOpacity ?? 88)) / 100).toFixed(2)};--pk-gift:${Math.max(28, Math.min(90, parseInt(state.giftSize, 10) || 46))}px;--pk-text:${Math.max(14, Math.min(42, parseInt(state.textSize, 10) || 21))}px;--pk-push:${Number(state.push) || 0}%;--pk-a-width:${aWidth}%">
    <div class="pkduo-head"><b>${escapeHtml(a.name || 'ĐỘI A')}</b><span>${escapeHtml(status)}</span><b>${escapeHtml(b.name || 'ĐỘI B')}</b></div>
    <div class="pkduo-gifts"><div>${(a.gifts || []).map(giftHtml).join('')}</div><i></i><div>${(b.gifts || []).map(giftHtml).join('')}</div></div>
    <div class="pkduo-bar"><strong class="score-a">${fmt(state.scoreA)}</strong><span class="pkduo-team-label a">HP MEDIA</span><em class="${Number(state.scoreB || 0) > Number(state.scoreA || 0) ? 'flip' : ''}"><img src="/pk-duo-boost.svg" alt="" /></em><span class="pkduo-team-label b">HP MEDIA</span><strong class="score-b">${fmt(state.scoreB)}</strong></div>
  </div>`;
}

render();
const es = new EventSource(`/pk-duo-events?token=${encodeURIComponent(token)}`);
es.addEventListener('pkduo', e => render(JSON.parse(e.data || '{}')));
