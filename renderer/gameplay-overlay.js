const token = new URLSearchParams(location.search).get('token') || '';
const wrap = document.getElementById('wrap');
let cfg = { items: [], orientation: 'horizontal', labelPosition: 'bottom' };
const state = new Map();
let activeIds = new Set();
const nodes = new Map();

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
function normalizeIconUrl(icon) {
  return String(icon || '').replace(/\\/g, '/').replace(/[?#].*$/, '').trim().toLowerCase();
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
function orderedSlotsForDisplay() {
  const slots = Array.isArray(cfg.slots) ? [...cfg.slots] : [];
  if (!slots.length) return orderedItemsForDisplay();
  return slots;
}
function nameClass(name) {
  const mode = cfg.nameMode || 'marquee';
  if (mode === 'wrap') return ' wrap';
  if (mode === 'marquee' && String(name || '').length > 9) return ' marquee';
  return '';
}
function applyLayoutStyles() {
  wrap.className = cfg.orientation === 'vertical' ? 'vertical' : '';
  wrap.classList.toggle('gray-inactive', !!cfg.grayInactive);
  wrap.classList.toggle('grid-mode', Array.isArray(cfg.slots) && cfg.slots.length > 0);
  wrap.style.setProperty('--grid-cols', parseInt(cfg.gridCols, 10) || 10);
  const activeScale = (parseInt(cfg.activeScale, 10) || 140) / 100;
  wrap.style.setProperty('--active-scale', String(activeScale));
  const bg = hexToRgb(cfg.cardBg || '#8d8d8d');
  wrap.style.setProperty('--card-bg-rgb', `${bg.r}, ${bg.g}, ${bg.b}`);
  wrap.style.setProperty('--card-opacity', String((parseInt(cfg.cardOpacity, 10) || 86) / 100));
  wrap.style.setProperty('--text-color', cfg.textColor || '#ffffff');
  wrap.style.setProperty('--slot-number-color', cfg.slotNumberColor || '#ffffff');
  wrap.style.setProperty('--count-color', cfg.countColor || '#ffffff');
  wrap.style.setProperty('--count-size', `${Math.max(9, Math.min(28, parseInt(cfg.countSize, 10) || 12))}px`);
  wrap.style.setProperty('--text-font', `'${String(cfg.textFont || 'Segoe UI').replace(/'/g, '')}', sans-serif`);
  const iconSize = Math.max(28, Math.min(120, parseInt(cfg.iconSize, 10) || 54));
  const parsedItemGap = parseInt(cfg.itemGap, 10);
  const itemGap = Math.max(0, Math.min(60, Number.isFinite(parsedItemGap) ? parsedItemGap : 10));
  wrap.style.setProperty('--icon-size', `${iconSize}px`);
  wrap.style.setProperty('--icon-lift', `${Math.round(iconSize / 2)}px`);
  wrap.style.setProperty('--item-gap', `${itemGap}px`);
  wrap.style.setProperty('--top-safe', `${12 + (cfg.enlargeActive ? Math.ceil(iconSize * Math.max(0, activeScale - 1)) : 0)}px`);
  wrap.classList.toggle('uppercase', !!cfg.uppercase);
  wrap.classList.toggle('hide-name', cfg.showName === false);
}
function nodeKey(item, idx) {
  if (Array.isArray(cfg.slots) && cfg.slots.length) return `slot:${item.index ?? idx}`;
  return `item:${item.itemId || item.id || idx}`;
}
function ensureChild(parent, selector, className, tagName = 'div') {
  let el = parent.querySelector(selector);
  if (!el) {
    el = document.createElement(tagName);
    if (className) el.className = className;
  }
  return el;
}
function updateGiftNode(el, item, idx) {
  const itemId = item.itemId || item.id || '';
  const empty = item.visible === false || !itemId;
  el.dataset.slot = String(item.index ?? idx);
  if (empty) {
    el.className = 'gift empty';
    el.removeAttribute('data-id');
    el.replaceChildren();
    return;
  }
  const st = state.get(itemId) || { count: 0 };
  const icon = iconSrc(item);
  const labelPosition = ['top', 'bottom', 'left', 'right'].includes(cfg.labelPosition) ? cfg.labelPosition : 'bottom';
  const name = item.name || '';
  const slotNumber = String(item.number || '').trim();
  const isActive = activeIds.has(itemId);
  el.className = [
    'gift',
    `label-${labelPosition}`,
    isActive ? 'active' : '',
    cfg.enlargeActive && isActive ? 'enlarged' : '',
  ].filter(Boolean).join(' ');
  el.dataset.id = itemId;

  const iconWrap = ensureChild(el, ':scope > .icon-wrap', 'icon-wrap');
  let img = iconWrap.querySelector(':scope > img');
  let placeholder = iconWrap.querySelector(':scope > .icon-placeholder');
  if (icon) {
    if (!img) {
      img = document.createElement('img');
      iconWrap.prepend(img);
    }
    if (img.getAttribute('src') !== icon) img.setAttribute('src', icon);
    if (placeholder) placeholder.remove();
  } else {
    if (img) img.remove();
    if (!placeholder) {
      placeholder = document.createElement('div');
      placeholder.className = 'icon-placeholder';
      placeholder.style.cssText = 'width:50px;height:50px';
      iconWrap.prepend(placeholder);
    }
  }

  let count = iconWrap.querySelector(':scope > .count');
  if (st.count && cfg.showCount !== false) {
    if (!count) {
      count = document.createElement('div');
      count.className = 'count';
      iconWrap.append(count);
    }
    count.textContent = Number(st.count).toLocaleString('en-US');
  } else if (count) {
    count.remove();
  }

  let slot = el.querySelector(':scope > .slot-number');
  if (slotNumber) {
    if (!slot) slot = document.createElement('div');
    slot.className = 'slot-number';
    slot.textContent = slotNumber;
    el.append(slot);
  } else if (slot) {
    slot.remove();
  }

  let nameEl = el.querySelector(':scope > .name');
  if (cfg.showName !== false) {
    if (!nameEl) {
      nameEl = document.createElement('div');
      nameEl.append(document.createElement('span'));
    }
    nameEl.className = `name${nameClass(name)}`;
    nameEl.querySelector('span').textContent = name;
    el.append(nameEl);
  } else if (nameEl) {
    nameEl.remove();
  }

  el.prepend(iconWrap);
}
function render() {
  applyLayoutStyles();
  const used = new Set();
  orderedSlotsForDisplay().forEach((item, idx) => {
    const key = nodeKey(item, idx);
    used.add(key);
    let el = nodes.get(key);
    if (!el) {
      el = document.createElement('div');
      nodes.set(key, el);
    }
    updateGiftNode(el, item, idx);
    wrap.append(el);
  });
  for (const [key, el] of nodes) {
    if (!used.has(key)) {
      el.remove();
      nodes.delete(key);
    }
  }
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
    const sameIcon = !!ev.gift_icon && !!item.icon && normalizeIconUrl(ev.gift_icon) === normalizeIconUrl(item.icon);
    if (!keys.includes(evKey) && !keys.includes(evNameKey) && !sameIcon) continue;
    const st = state.get(item.id) || { count: 0 };
    st.count += Math.max(1, total || 1);
    state.set(item.id, st);
  }
  render();
});
