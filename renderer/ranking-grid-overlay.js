const token = new URLSearchParams(location.search).get('token') || '';
const root = document.getElementById('rankingRoot');

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmt(n) {
  return Math.max(0, Math.round(Number(n) || 0)).toLocaleString('en-US');
}
function nameHtml(name, className) {
  const text = String(name || 'Idol');
  const longClass = text.length > 12 ? ' long' : '';
  return `<div class="${className}${longClass}" title="${escapeHtml(text)}"><span>${escapeHtml(text)}</span></div>`;
}
function hexToRgb(hex, fallback = '42,45,55') {
  const m = String(hex || '').trim().match(/^#([0-9a-f]{6})$/i);
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}
function stateFlag(kind, state) {
  if (kind === 'rank') return state.showRank !== false;
  if (kind === 'avatar') return state.showAvatar !== false;
  if (kind === 'gift') return state.showGift !== false;
  if (kind === 'round') return state.showRound !== false;
  return true;
}
function gridCells(state) {
  const rows = Array.isArray(state.rows) ? state.rows : [];
  const gridRows = Math.max(1, Math.min(20, parseInt(state.gridRows, 10) || 3));
  const gridCols = Math.max(1, Math.min(10, parseInt(state.gridCols, 10) || 3));
  const visible = rows.slice(0, gridRows * gridCols);
  const cells = [];
  for (let r = 0; r < gridRows; r++) {
    for (let c = 0; c < gridCols; c++) {
      const index = state.gridFlow === 'column' ? c * gridRows + r : r * gridCols + c;
      cells.push(visible[index] || null);
    }
  }
  return { cells, gridCols };
}
function cellHtml(row, state) {
  if (!row) return '<div class="ranking-grid-cell empty"></div>';
  const rankHtml = row.rank === 1 ? '🥇' : (row.rank === 2 ? '🥈' : (row.rank === 3 ? '🥉' : row.rank));
  const giftSrc = row.giftIconId ? `/gift-icon/${encodeURIComponent(row.giftIconId)}?token=${encodeURIComponent(token)}` : (row.giftIcon || '');
  const gift = giftSrc ? `<img src="${escapeHtml(giftSrc)}" />` : (row.giftName ? '🎁' : '');
  return `<div class="ranking-grid-cell top-${row.rank <= 3 ? row.rank : 0} ${row.active ? 'active' : ''} ${row.lost ? 'loser' : ''}">
    ${stateFlag('rank', state) ? `<div class="ranking-grid-rank rank-${row.rank}">${rankHtml}</div>` : ''}
    ${stateFlag('avatar', state) ? `<div class="ranking-grid-avatar">${row.avatar ? `<img src="${escapeHtml(row.avatar)}" />` : escapeHtml(row.initials || '?')}</div>` : ''}
    <div class="ranking-grid-main">
      ${nameHtml(row.name || 'Idol', 'ranking-grid-name')}
      ${row.hideScore || state.hideAllScores ? '' : `<div class="ranking-grid-points">${fmt(row.points)}</div>`}
    </div>
    ${stateFlag('gift', state) ? `<div class="ranking-grid-gift">${gift}</div>` : ''}
    ${stateFlag('round', state) ? `<div class="ranking-grid-round">R${fmt(row.round)}</div>` : ''}
  </div>`;
}
function render(state = {}) {
  const { cells, gridCols } = gridCells(state);
  const hasRows = cells.some(Boolean);
  const compactClass = `${state.showRank === false ? ' hide-rank' : ''}${state.showAvatar === false ? ' hide-avatar' : ''}${state.showGift === false ? ' hide-gift' : ''}${state.showRound === false ? ' hide-round' : ''}`;
  root.innerHTML = `<div class="ranking-grid-board${compactClass} name-${state.nameMode === 'marquee' ? 'marquee' : 'two-line'}" style="--ranking-grid-cols:${gridCols};--ranking-card-bg-rgb:${hexToRgb(state.overlayBgColor)};--ranking-card-bg-opacity:${((Number(state.overlayBgOpacity ?? 74)) / 100).toFixed(2)};--ranking-streak-color:${escapeHtml(state.streakColor || '#67e8f9')}">
    <div class="ranking-grid-title">${escapeHtml(state.title || 'Ranking list')}</div>
    <div class="ranking-grid-list">${hasRows ? cells.map(row => cellHtml(row, state)).join('') : '<div class="ranking-empty">Chưa có dữ liệu BXH</div>'}</div>
    ${state.active ? `<div class="ranking-grid-active-name">
      <div class="ranking-grid-active-avatar">${state.active.avatar ? `<img src="${escapeHtml(state.active.avatar)}" />` : escapeHtml(state.active.initials || '?')}</div>
      <div class="ranking-grid-active-main"><div>${escapeHtml(state.active.name || 'Idol')}</div><b>${fmt(state.active.points)}</b></div>
    </div>` : ''}
  </div>`;
}

render();
const es = new EventSource(`/ranking-events?token=${encodeURIComponent(token)}`);
es.addEventListener('ranking', e => render(JSON.parse(e.data || '{}')));
