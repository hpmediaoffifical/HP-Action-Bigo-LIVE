const token = new URLSearchParams(location.search).get('token') || '';
const wrap = document.getElementById('wrap');
let cfg = { items: [], orientation: 'horizontal', labelPosition: 'bottom' };
const state = new Map();
let activeIds = new Set();

function keyForGift(ev) {
  if (ev.gift_id != null) return 'id:' + String(ev.gift_id);
  return 'name:' + String(ev.gift_name || '').toLowerCase().trim();
}
function normalizeGiftKey(s) {
  return String(s || '')
    .replace(/[​-‏‪-‮⁠-⁯﻿]/g, '')
    .replace(/[︀-️]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
function itemKeys(item) {
  const keys = [];
  for (const k of item.matchKeys || []) {
    const s = String(k).trim();
    if (!s) continue;
    if (/^\d+$/.test(s)) keys.push('id:' + s);
    keys.push('name:' + normalizeGiftKey(s));
  }
  if (item.name) keys.push('name:' + normalizeGiftKey(item.name));
  return keys;
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return { r: 141, g: 141, b: 141 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function iconSrc(item) {
  if (item.iconId) return `/gift-icon/${encodeURIComponent(item.iconId)}?token=${encodeURIComponent(token)}`;
  if (item.icon) return item.icon;
  return '';
}
function orderedItemsForDisplay() {
  const items = [...(cfg.items || [])];
  if (!cfg.centerLargest || items.length < 3) return items;
  let maxIdx = -1;
  let maxCount = 0;
  items.forEach((item, idx) => {
    const count = state.get(item.id)?.count || 0;
    if (count > maxCount) { maxCount = count; maxIdx = idx; }
  });
  if (maxIdx < 0 || maxCount <= 0) return items;
  const [top] = items.splice(maxIdx, 1);
  items.splice(Math.floor(items.length / 2), 0, top);
  return items;
}
function nameClass(name) {
  const mode = cfg.nameMode || 'marquee';
  if (mode === 'wrap') return ' wrap';
  if (mode === 'marquee' && String(name || '').length > 9) return ' marquee';
  return '';
}
function render() {
  wrap.className = cfg.orientation === 'vertical' ? 'vertical' : '';
  wrap.classList.toggle('gray-inactive', !!cfg.grayInactive);
  wrap.style.setProperty('--active-scale', String((parseInt(cfg.activeScale, 10) || 140) / 100));
  const bg = hexToRgb(cfg.cardBg || '#8d8d8d');
  wrap.style.setProperty('--card-bg-rgb', `${bg.r}, ${bg.g}, ${bg.b}`);
  wrap.style.setProperty('--card-opacity', String((parseInt(cfg.cardOpacity, 10) || 86) / 100));
  wrap.style.setProperty('--text-color', cfg.textColor || '#ffffff');
  wrap.style.setProperty('--text-font', `'${String(cfg.textFont || 'Segoe UI').replace(/'/g, '')}', sans-serif`);
  wrap.classList.toggle('uppercase', !!cfg.uppercase);
  wrap.innerHTML = orderedItemsForDisplay().map(item => {
    const st = state.get(item.id) || { count: 0 };
    const icon = iconSrc(item);
    const labelPosition = ['top', 'bottom', 'left', 'right'].includes(cfg.labelPosition) ? cfg.labelPosition : 'bottom';
    const name = item.name || '';
    const isActive = activeIds.has(item.id);
    const classes = [
      'gift',
      `label-${labelPosition}`,
      isActive ? 'active' : '',
      cfg.enlargeActive && isActive ? 'enlarged' : '',
    ].filter(Boolean).join(' ');
    return `<div class="${classes}" data-id="${escapeHtml(item.id)}">
      <div class="icon-wrap">
        ${icon ? `<img src="${escapeHtml(icon)}" />` : '<div style="width:50px;height:50px"></div>'}
        ${st.count ? `<div class="count">${Number(st.count).toLocaleString('en-US')}</div>` : ''}
      </div>
      <div class="name${nameClass(name)}"><span>${escapeHtml(name)}</span></div>
    </div>`;
  }).join('');
}
const es = new EventSource(`/gameplay-events?token=${encodeURIComponent(token)}`);
es.addEventListener('config', e => {
  cfg = JSON.parse(e.data || '{}');
  state.clear();
  activeIds = new Set();
  render();
});
es.addEventListener('counts', e => {
  const payload = JSON.parse(e.data || '{}');
  const counts = payload.counts || payload;
  activeIds = new Set(payload.activeIds || []);
  state.clear();
  for (const [id, count] of Object.entries(counts || {})) {
    const n = parseInt(count, 10) || 0;
    if (n > 0) state.set(id, { count: n });
  }
  render();
});
es.addEventListener('gift', e => {
  const ev = JSON.parse(e.data || '{}');
  const evKey = keyForGift(ev);
  const evNameKey = 'name:' + normalizeGiftKey(ev.gift_name);
  const total = parseInt(ev.total_count, 10) || ((parseInt(ev.gift_count, 10) || 1) * (parseInt(ev.combo, 10) || 1));
  for (const item of cfg.items || []) {
    const keys = itemKeys(item);
    const sameIcon = !!ev.gift_icon && !!item.icon && ev.gift_icon === item.icon;
    if (!keys.includes(evKey) && !keys.includes(evNameKey) && !sameIcon) continue;
    const st = state.get(item.id) || { count: 0 };
    st.count += Math.max(1, total || 1);
    state.set(item.id, st);
  }
  render();
});
