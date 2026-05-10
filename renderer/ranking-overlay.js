const token = new URLSearchParams(location.search).get('token') || '';
const root = document.getElementById('rankingRoot');

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmt(n) {
  return Math.max(0, Math.round(Number(n) || 0)).toLocaleString('en-US');
}
function rowHtml(row, maxPoints, state) {
  const rankHtml = row.rank === 1 ? '🥇' : (row.rank === 2 ? '🥈' : (row.rank === 3 ? '🥉' : row.rank));
  const loser = !!row.lost;
  const giftSrc = row.giftIconId ? `/gift-icon/${encodeURIComponent(row.giftIconId)}?token=${encodeURIComponent(token)}` : (row.giftIcon || '');
  const gift = giftSrc ? `<img src="${escapeHtml(giftSrc)}" />` : (row.giftName ? '🎁' : '');
  return `<div class="ranking-row ${row.active ? 'active' : ''} ${loser || row.lost ? 'loser' : ''}">
    ${state.showRank === false ? '' : `<div class="ranking-rank rank-${row.rank}">${rankHtml}</div>`}
    ${state.showAvatar === false ? '' : `<div class="ranking-avatar">${row.avatar ? `<img src="${escapeHtml(row.avatar)}" />` : escapeHtml(row.initials || '?')}</div>`}
    <div class="ranking-main">
      <div class="ranking-name">${escapeHtml(row.name || 'Idol')}</div>
      ${row.hideScore || state.hideAllScores ? '' : `<div class="ranking-points">${fmt(row.points)}</div>`}
    </div>
    ${state.showGift === false ? '' : `<div class="ranking-gift">${gift}</div>`}
    ${state.showRound === false ? '' : `<div class="ranking-round">R${fmt(row.round)}</div>`}
  </div>`;
}
function render(state = {}) {
  const rows = Array.isArray(state.rows) ? state.rows : [];
  const maxPoints = rows.length ? Math.max(...rows.map(r => Number(r.points) || 0)) : 0;
  const activeName = state.active ? escapeHtml(state.active.name || 'Idol') : '';
  const activePoints = state.active ? fmt(state.active.points) : '';
  const activeLong = state.active && `${state.active.name || 'Idol'} ${activePoints}`.length > 18;
  const compactClass = `${state.showRank === false ? ' hide-rank' : ''}${state.showAvatar === false ? ' hide-avatar' : ''}${state.showGift === false ? ' hide-gift' : ''}${state.showRound === false ? ' hide-round' : ''}`;
  root.innerHTML = `<div class="ranking-board${compactClass}" style="--ranking-streak-color:${escapeHtml(state.streakColor || '#67e8f9')}">
    <div class="ranking-title">${escapeHtml(state.title || 'Ranking list')}</div>
    <div class="ranking-list">${rows.map(row => rowHtml(row, maxPoints, state)).join('') || '<div class="ranking-empty">Chưa có dữ liệu BXH</div>'}</div>
    ${state.active ? `<div class="ranking-active-name ${activeLong ? 'long' : ''}">
      <div class="ranking-active-avatar">${state.active.avatar ? `<img src="${escapeHtml(state.active.avatar)}" />` : escapeHtml(state.active.initials || '?')}</div>
      <div class="ranking-active-main"><div>${activeName}</div><b>${activePoints}</b></div>
    </div>` : ''}
  </div>`;
}

render();
const es = new EventSource(`/ranking-events?token=${encodeURIComponent(token)}`);
es.addEventListener('ranking', e => render(JSON.parse(e.data || '{}')));
