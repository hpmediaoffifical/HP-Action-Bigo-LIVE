const token = new URLSearchParams(location.search).get('token') || '';
const root = document.getElementById('scoreRoot');

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmt(n) {
  return Math.max(0, Math.floor(Number(n) || 0)).toLocaleString('en-US');
}
function scoreStatusText(status, timeText) {
  if (status === 'prestart') return timeText || 'CHUẨN BỊ';
  if (status === 'success') return 'THÀNH CÔNG';
  if (status === 'failed') return 'KHÔNG HOÀN THÀNH';
  return timeText || '03:00';
}
function render(state = {}) {
  const target = Math.max(1, Number(state.target) || 1);
  const score = Math.max(0, Number(state.score) || 0);
  const over = Math.max(0, score - target);
  const missing = Math.max(0, target - score);
  const pct = Math.max(0, Math.min(100, (score / target) * 100));
  const popLeft = Math.max(11, Math.min(88, pct));
  const status = state.status || 'idle';
  const avatar = state.creatorAvatar || '';
  const creator = state.creatorName || 'Creator';
  const content = state.content || 'Kêu gọi điểm ĐẬU';
  const statusText = scoreStatusText(status, state.timeText);
  const activeRunner = ['running', 'grace'].includes(status) && !!state.lastAdd;
  const runnerUser = state.showGiftUser !== false && state.lastAddUser ? `${state.lastAddUser} ` : '';
  const runnerPoints = state.lastAdd ? `+${fmt(state.lastAdd)}` : '';
  const runnerAtStart = pct < 28;
  const remainingMs = status === 'running' ? Math.max(0, Number(state.endAt || 0) - Date.now()) : 0;
  const urgent = ['running', 'grace'].includes(status) && remainingMs <= 10000 && remainingMs > 0;
  const nearGoal = ['running', 'grace'].includes(status) && pct >= 80 && score < target;
  const milestoneValues = Array.isArray(state.customMilestoneValues) ? state.customMilestoneValues : [];
  const milestones = milestoneValues.map(v => `<span class="score-marker ${score >= v ? 'reached' : ''}" style="left:${Math.max(0, Math.min(100, (v / target) * 100))}%"></span>`).join('');
  const topUsers = Array.isArray(state.topUsers) ? state.topUsers : [];
  const topText = topUsers.length ? topUsers.map(u => `${escapeHtml(u.user || '?')} ${fmt(u.points)}`).join(' | ') : '';
  const elapsedMs = state.runStartedAt ? Math.max(0, Date.now() - Number(state.runStartedAt)) : 0;
  const avgPerMin = elapsedMs > 5000 ? Math.round(score / (elapsedMs / 60000)) : 0;
  const projected = avgPerMin && remainingMs ? Math.round(score + avgPerMin * (remainingMs / 60000)) : 0;
  const predictionText = avgPerMin ? (projected >= target ? 'Dự kiến đạt' : 'Cần tăng tốc') : 'Đang tính tốc độ';
  root.className = `score-obs status-${status} theme-${state.themePreset || 'custom'} size-${state.overlaySize || 'medium'} bar-${state.barStyle || 'pill'}${state.compactMode ? ' compact' : ''}${activeRunner ? ' has-add' : ''}${urgent ? ' urgent' : ''}${nearGoal ? ' near-goal' : ''}${state.hidden ? ' hidden' : ''}`;
  root.style.setProperty('--score-time-color', state.timeColor || '#ffffff');
  root.style.setProperty('--score-content-color', state.contentColor || '#f0eef6');
  root.style.setProperty('--score-over-color', state.overColor || '#ff0000');
  root.style.setProperty('--score-bar-color-1', state.barColor1 || '#b93678');
  root.style.setProperty('--score-bar-color-2', state.barColor2 || '#ff8ed1');
  root.style.setProperty('--score-wave-color', state.waveColor || '#ffffff');
  root.innerHTML = `
    <div class="score-time">${escapeHtml(statusText)}</div>
    <div class="score-bar" style="--score-pct:${pct}%">
      <div class="score-fill" style="width:${pct}%"></div>
      <div class="score-flash"></div>
      <div class="score-wave"></div>
      ${milestones}
      ${over > 0 ? `<div class="score-over">+Over: ${fmt(over)}</div>` : ''}
      ${activeRunner ? `<div class="score-pop ${Number(state.lastAdd) >= Number(state.bigGiftThreshold || 500) ? 'big' : ''} ${runnerAtStart ? 'at-start' : ''}" style="left:${runnerAtStart ? 6 : popLeft}${runnerAtStart ? 'px' : '%'}"><span>${escapeHtml(runnerUser)}${runnerPoints}</span><b>🏃</b></div>` : ''}
      <div class="score-flag">⚑</div>
    </div>
    <div class="score-meta">
      ${state.hideAvatar ? '' : `<div class="score-avatar">${avatar ? `<img src="${escapeHtml(avatar)}" />` : '👤'}</div>`}
      ${state.hideCreator ? '' : `<div class="score-creator">${escapeHtml(creator)}</div>`}
      <div class="score-content">${escapeHtml(content)}</div>
      <div class="score-points">Điểm: ${fmt(score)}/${fmt(target)}</div>
    </div>
    ${state.showTopUsers !== false && topText ? `<div class="score-extra">Top: ${topText}</div>` : ''}
    ${state.showSpeed !== false ? `<div class="score-extra">${escapeHtml(predictionText)}</div>` : ''}`;
}

render();
const es = new EventSource(`/score-events?token=${encodeURIComponent(token)}`);
es.addEventListener('score', e => render(JSON.parse(e.data || '{}')));
