// Preload chạy trong main frame VÀ sub-frames (do nodeIntegrationInSubFrames=true).
// DOM scraper: Bigo player đã render chat/gift ra HTML — ta dùng MutationObserver-style
// polling + pattern matching để tách event đã decode sẵn (không cần parse protobuf).

const { ipcRenderer } = require('electron');

const FRAME_URL = (() => { try { return location.href; } catch { return '<unknown>'; } })();
const IS_MAIN = (() => { try { return window.top === window; } catch { return false; } })();

function send(channel, payload) {
  try { ipcRenderer.send(channel, { ...payload, _frame: FRAME_URL, _main: IS_MAIN }); } catch {}
}

const seenChats = new Map();
const seenGifts = new Map();

const CHAT_PATTERNS = [
  /^\s*Lv\.?\s*(\d+)\s+([^:：\n]{1,80}?)\s*[:：]\s*(.{1,500})\s*$/u,
  /^\s*\[Lv\.?(\d+)\]\s*([^:：\n]{1,80}?)\s*[:：]\s*(.{1,500})\s*$/u,
];

function tryMatchChat(text) {
  for (const re of CHAT_PATTERNS) {
    const m = text.match(re);
    if (m) return { level: +m[1], user: m[2].trim(), content: m[3].trim() };
  }
  return null;
}

function pruneMap(map, max = 2000, recentMs = 60_000) {
  if (map.size <= max) return;
  const cutoff = Date.now() - recentMs;
  for (const [k, ts] of map) if (ts < cutoff) map.delete(k);
}

// Walk all elements including shadow DOM
function* walkAllElements(root) {
  if (!root) return;
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    yield node;
    if (node.children) for (const c of node.children) stack.push(c);
    if (node.shadowRoot) stack.push(node.shadowRoot);
  }
}

// Extract icon URL của quà từ DOM element (img có src chứa giftpic / pgc-live-manage)
function findGiftIconUrl(el) {
  if (!el) return '';
  const imgs = el.querySelectorAll('img');
  for (const img of imgs) {
    const src = img.src || img.getAttribute('data-src') || '';
    if (/giftpic|pgc-live-manage|gift\//i.test(src)) return src;
  }
  return '';
}

function findAvatarUrl(el) {
  if (!el) return '';
  const imgs = el.querySelectorAll('img');
  for (const img of imgs) {
    const src = img.src || img.getAttribute('data-src') || '';
    // Bigo avatar thường: esx.bigo.sg, avatar, user_pic, live_pic, bigocdn,
    // hoặc bất kỳ URL có /head/ , /avatar/, hoặc giàu pattern.
    if (/avatar|user_pic|live_pic|bigocdn|head\/|profile/i.test(src)) return src;
  }
  // Fallback: lấy img đầu tiên không phải gift icon
  for (const img of imgs) {
    const src = img.src || img.getAttribute('data-src') || '';
    if (!src) continue;
    if (/giftpic|pgc-live-manage|gift\//i.test(src)) continue;
    if (/^data:|\.svg/.test(src)) continue;
    return src;
  }
  return '';
}

// Normalize stronger: strip zero-width chars + variation selectors + collapse whitespace
function normalize(s) {
  return String(s || '')
    .replace(/[​-‏‪-‮⁠-⁯﻿]/g, '') // zero-width + invisible directional
    .replace(/[︀-️]/g, '')                                  // variation selectors (emoji modifiers)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// WeakSet đánh dấu element đã scan để tránh scan lại trong cùng tick (cũng tránh
// parent + child cùng match khi text concat của parent vẫn nằm trong giới hạn).
const elementsScanned = new WeakSet();

function scanChatsAndGifts() {
  const chats = [];
  const gifts = [];
  if (!document.body) return { chats, gifts };

  for (const el of walkAllElements(document.body)) {
    if (el.nodeType !== 1) continue;
    if (elementsScanned.has(el)) continue;
    const text = (el.textContent || '').trim();
    if (text.length < 5 || text.length > 300) continue;

    // Filter "shared this LIVE" enter notification — không phải chat thật
    if (/shared\s+this\s+(live|LIVE)\s*$/i.test(text)) {
      elementsScanned.add(el);
      continue;
    }
    // Filter joined messages
    if (/has\s+joined|joined\s+the\s+room/i.test(text)) {
      elementsScanned.add(el);
      continue;
    }

    const m = tryMatchChat(text);
    if (!m) continue;

    elementsScanned.add(el);

    // Hash với normalize whitespace để bắt duplicate có khoảng trắng khác
    const hash = `${m.level}|${normalize(m.user)}|${normalize(m.content)}`;
    if (seenChats.has(hash)) continue;
    seenChats.set(hash, Date.now());

    const avatarUrl = findAvatarUrl(el);
    const giftIconUrl = findGiftIconUrl(el);

    const giftM = m.content.match(/sent\s+(?:a\s+)?(.+?)\s*[×xX](\d+)\s*$/);
    if (giftM) {
      gifts.push({
        type: 'gift', level: m.level, user: m.user,
        gift_name: giftM[1].trim(), gift_count: +giftM[2],
        gift_icon_url: giftIconUrl, user_avatar_url: avatarUrl, raw: text,
      });
    } else if (/^sent\s+/i.test(m.content)) {
      gifts.push({
        type: 'gift', level: m.level, user: m.user,
        gift_name: m.content.replace(/^sent\s+/i, '').trim(), gift_count: 1,
        gift_icon_url: giftIconUrl, user_avatar_url: avatarUrl, raw: text,
      });
    } else {
      chats.push({ type: 'chat', level: m.level, user: m.user, content: m.content, user_avatar_url: avatarUrl, raw: text });
    }
  }

  pruneMap(seenChats);
  return { chats, gifts };
}

function scanGiftOverlay() {
  const out = [];
  if (!document.body) return out;
  for (const el of walkAllElements(document.body)) {
    if (el.nodeType !== 1) continue;
    const text = (el.textContent || '').trim();
    if (text.length < 4 || text.length > 100) continue;
    // Anchor ^ + non-greedy + giới hạn 30 chars cho sender (tên user)
    const m = text.match(/^\s*([^\n]{1,30}?)\s*Send\b[\s\S]{0,40}?[xX×](\d+)\s*combo\s*(\d+)/i);
    if (!m) continue;
    const sender = m[1].trim();
    // Sanity: sender không được chứa keyword overlay (loại element cha)
    if (!sender || /\b(send|combo)\b/i.test(sender) || /[xX×]\d/.test(sender)) continue;
    const count = +m[2], combo = +m[3];
    const giftIconUrl = findGiftIconUrl(el);
    const avatarUrl = findAvatarUrl(el);
    const hash = `${sender}|${count}|${combo}|${giftIconUrl}`;
    if (seenGifts.has(hash)) continue;
    seenGifts.set(hash, Date.now());
    out.push({
      type: 'gift_overlay', user: sender, gift_count: count, combo,
      gift_icon_url: giftIconUrl, user_avatar_url: avatarUrl, raw: text.slice(0, 100),
    });
  }
  pruneMap(seenGifts);
  return out;
}

function scanRoomMeta() {
  const meta = {};
  if (!document.body) return meta;
  for (const el of walkAllElements(document.body)) {
    if (el.nodeType !== 1) continue;
    const t = (el.textContent || '').trim();
    if (t.length > 200) continue;
    const m = t.match(/^BIGO\s*ID\s*[:：]\s*(\S+)/i);
    if (m && !meta.bigoId) meta.bigoId = m[1];
  }
  if (document.title) meta.title = document.title;
  return meta;
}

function attach() {
  if (!document.body) return setTimeout(attach, 200);
  // Quan trọng: nếu preload đang chạy trong sub-frame (iframe của Bigo),
  // SKIP scraping để tránh duplicate. Main frame đã quét toàn bộ DOM (kể cả iframe same-origin).
  if (!IS_MAIN) {
    send('embed:dom-attached', { url: location.href, isMain: false, skipped: true, ts: Date.now() });
    return;
  }
  send('embed:dom-attached', { url: location.href, isMain: true, ts: Date.now() });

  let lastMeta = '';
  const tick = () => {
    try {
      const { chats, gifts } = scanChatsAndGifts();
      for (const ev of chats) send('embed:parsed', { ...ev, ts: Date.now() });
      for (const ev of gifts) send('embed:parsed', { ...ev, ts: Date.now() });
      for (const ev of scanGiftOverlay()) send('embed:parsed', { ...ev, ts: Date.now() });
      const meta = scanRoomMeta();
      const j = JSON.stringify(meta);
      if (j !== lastMeta) { lastMeta = j; send('embed:meta', { ...meta, ts: Date.now() }); }
    } catch (e) {
      send('embed:scrape-error', { msg: e.message });
    }
  };
  setTimeout(tick, 4000);
  setInterval(tick, 800);
}

attach();
send('embed:ready', { url: FRAME_URL, isMain: IS_MAIN, ts: Date.now() });
