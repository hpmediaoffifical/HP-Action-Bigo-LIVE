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

// First-match wins. Tat ca pattern cho phep username "ID:394471037" qua alternation.
// \b word boundary sau level de xu ly textContent thieu space giua badge va name.
const CHAT_PATTERNS = [
  /^\s*Lv\.?\s*(\d+)\b\s*(ID:\d+|[^:：\n]{1,80}?)\s*[:：]\s*(.{1,500})\s*$/u,
  /^\s*\[Lv\.?(\d+)\]\s*(ID:\d+|[^:：\n]{1,80}?)\s*[:：]\s*(.{1,500})\s*$/u,
  /^\s*(\d{1,3})\b\s*(ID:\d+|[^:：\n]{1,80}?)\s*[:：]\s*(.{1,500})\s*$/u,
  // Fallback khong co level — yeu cau space quanh ":" giam false positive.
  /^\s*(ID:\d+|[^:：\n\d][^:：\n]{0,79}?)\s+[:：]\s+(.{1,500})\s*$/u,
];

function tryMatchChat(text) {
  for (let i = 0; i < CHAT_PATTERNS.length; i++) {
    const m = text.match(CHAT_PATTERNS[i]);
    if (!m) continue;
    if (i === 3) return { level: 0, user: m[1].trim(), content: m[2].trim() };
    return { level: +m[1], user: m[2].trim(), content: m[3].trim() };
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
  // Pass 1: URL pattern explicitly chỉ avatar
  for (const img of imgs) {
    const src = img.src || img.getAttribute('data-src') || '';
    // Bigo CDN domains + path patterns commonly used for avatars
    if (/avatar|user_pic|live_pic|bigocdn|head[\/_]|profile|portrait|userhead|user_head|esx\.bigo|pic-th|pic-tw|pic-sg|userprofile|cover\/|user\//i.test(src)) {
      return src;
    }
  }
  // Pass 2: skip known non-avatar (level/badge/gift/emoji) → take first remaining
  for (const img of imgs) {
    const src = img.src || img.getAttribute('data-src') || '';
    if (!src) continue;
    // Skip gift icon, level badge, emoji, fan badge, medal, decoration, family icon...
    if (/giftpic|pgc-live-manage|gift\/|noble_emoji|emoji_|level_icon|level\/|badge\/|medal\/|family\/|svip|frame\/|deco\//i.test(src)) continue;
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

// 3-LAYER DEDUP cho chat/gift detection:
//
// Layer A — WeakMap elementContent (per-element):
//   Skip nếu cùng element + cùng text. Khác text → process (virtualized recycle).
//
// Layer B — Map recentTextHashes (cross-element time window):
//   React re-render → NEW element + SAME text. Window 300ms catch re-render
//   (1-200ms) nhưng KHÔNG drop legit gift sends (Bigo UI 500ms+ apart typical).
//
// Layer C — Map recentRemovedText (DOM remove → add detection):
//   PRECISE detection cho React re-render: nếu element bị REMOVED rồi
//   element MỚI added với SAME text trong 500ms → đó là re-render. Skip.
//   Layer C ưu tiên hơn Layer B vì có evidence (remove event) thay vì
//   guess time-based.
const elementContent = new WeakMap();
const recentTextHashes = new Map();
const recentRemovedText = new Map();
const TEXT_DEDUP_WINDOW_MS = 300;
const REMOVE_RERENDER_WINDOW_MS = 500;

// Counter diagnostic — track tổng gifts captured cumulative.
let _totalGiftsCaptured = 0;
let _totalChatsCaptured = 0;
let _totalHeartsCaptured = 0;

// Process 1 element (+ descendants nếu có) → return { chats, gifts } captured.
// Dùng cả từ tick scan VÀ MutationObserver (real-time).
function processElement(rootEl) {
  const chats = [];
  const gifts = [];
  if (!rootEl) return { chats, gifts };
  for (const el of walkAllElements(rootEl)) {
    if (el.nodeType !== 1) continue;
    const text = (el.textContent || '').trim();
    if (text.length < 5 || text.length > 300) continue;
    // Layer A: same element + same text → skip.
    if (elementContent.get(el) === text) continue;

    // Filter "shared this LIVE" enter notification — không phải chat thật
    if (/shared\s+this\s+(live|LIVE)\s*$/i.test(text)) {
      elementContent.set(el, text);
      continue;
    }
    // Filter joined messages
    if (/has\s+joined|joined\s+the\s+room/i.test(text)) {
      elementContent.set(el, text);
      continue;
    }

    const m = tryMatchChat(text);
    if (!m) continue;

    const nowMs = Date.now();
    // Layer C: nếu text vừa bị REMOVED khỏi DOM trong 500ms qua → đây là React
    // re-render (remove old + add new same-text). Skip.
    const removedTime = recentRemovedText.get(text);
    if (removedTime && nowMs - removedTime < REMOVE_RERENDER_WINDOW_MS) {
      elementContent.set(el, text);
      continue;
    }
    // Layer B: cross-element text dedup time-based fallback (300ms).
    const lastTextSeen = recentTextHashes.get(text);
    if (lastTextSeen && nowMs - lastTextSeen < TEXT_DEDUP_WINDOW_MS) {
      elementContent.set(el, text);
      continue;
    }
    recentTextHashes.set(text, nowMs);

    // Đánh dấu text đã process (Layer A persist).
    elementContent.set(el, text);

    const avatarUrl = findAvatarUrl(el);
    const giftIconUrl = findGiftIconUrl(el);

    const giftM = m.content.match(/sent\s+(?:a\s+)?(.+?)\s*[×xX](\d+)\s*$/);
    const isGift = !!giftM || /^sent\s+/i.test(m.content);

    if (isGift) {
      // KHÔNG hash-dedup cho gifts — tin tưởng WeakMap elementContent đã handle
      // per-element dedup (skip nếu cùng element + cùng text). 2 chat rows khác
      // (kể cả cùng content) là 2 elements khác → cả 2 fire. Virtualized list
      // recycle element với text mới → cũng fire (text khác lần trước).
      if (giftM) {
        const ev = {
          type: 'gift', level: m.level, user: m.user,
          gift_name: giftM[1].trim(), gift_count: +giftM[2],
          gift_icon_url: giftIconUrl, user_avatar_url: avatarUrl, raw: text,
        };
        gifts.push(ev);
        send('embed:scrape-error', { msg: `[gift parse] ${m.user} | ${ev.gift_name} ×${ev.gift_count} | raw: "${text.slice(0, 80)}"` });
      } else {
        const ev = {
          type: 'gift', level: m.level, user: m.user,
          gift_name: m.content.replace(/^sent\s+(?:an?\s+)?/i, '').trim(), gift_count: 1,
          gift_icon_url: giftIconUrl, user_avatar_url: avatarUrl, raw: text,
        };
        gifts.push(ev);
        send('embed:scrape-error', { msg: `[gift parse-fallback] ${m.user} | ${ev.gift_name} ×1 | raw: "${text.slice(0, 80)}"` });
      }
    } else {
      // CHECK HEART: trước khi xử lý như chat thường, detect message "gửi N lượt thích".
      const heartN = detectHeartFromChat(m.content);
      if (heartN > 0) {
        const heartHash = `h|${normalize(m.user)}|${heartN}`;
        const last = seenGifts.get(heartHash);
        if (last && Date.now() - last < 500) continue;
        seenGifts.set(heartHash, Date.now());
        // Emit như gift event với type='heart' → app's renderEmbedEvent xử lý
        // bumpHeartCount(count). KHÔNG add vào chats[] để tránh hiển thị trong
        // panel TƯƠNG TÁC như chat thường.
        gifts.push({
          type: 'heart', level: m.level, user: m.user, count: heartN,
          user_avatar_url: avatarUrl, raw: text,
        });
        continue;
      }
      // CHAT DEDUP DÀI — chats lặp lại trong 60s thường là DOM re-scan, không
      // phải user spam thật (Bigo cap ~3s/msg). Hash dài để giảm noise.
      const chatHash = `c|${m.level}|${normalize(m.user)}|${normalize(m.content)}`;
      if (seenChats.has(chatHash)) continue;
      seenChats.set(chatHash, Date.now());
      // Detect VIP/SVIP/Top/Family badges từ FULL text (badges thường nằm
      // ngoài m.content — trước colon).
      const badges = detectBadges(text);
      chats.push({
        type: 'chat', level: m.level, user: m.user, content: m.content,
        user_avatar_url: avatarUrl, raw: text, badges,
      });
    }
  }

  return { chats, gifts };
}

// Wrapper backward-compat: scan toàn bộ document.body.
function scanChatsAndGifts() {
  if (!document.body) return { chats: [], gifts: [] };
  const r = processElement(document.body);
  pruneMap(seenChats, 2000, 60_000);
  pruneMap(seenGifts, 500, 1500);
  pruneMap(recentTextHashes, 500, 5_000); // text dedup giữ 5s
  pruneMap(recentRemovedText, 500, 3_000); // removed text giữ 3s (đủ catch re-render)
  return r;
}

// MutationObserver: bắt new chat row REAL-TIME khi Bigo render vào DOM.
// Tránh miss gifts khi chat row tồn tại < 1 tick interval (300-800ms).
// Mỗi addedNode → process ngay → emit events tức thời.
let _moAttached = false;
function attachMutationObserver() {
  if (_moAttached || !document.body) return;
  _moAttached = true;
  const observer = new MutationObserver((mutations) => {
    // PASS 1: Track removed nodes' text → recentRemovedText. Layer C dùng để
    // skip new elements với text giống nhau (React re-render pattern).
    const nowMs = Date.now();
    for (const m of mutations) {
      if (m.type !== 'childList') continue;
      for (const node of m.removedNodes) {
        if (!node || node.nodeType !== 1) continue;
        const text = (node.textContent || '').trim();
        if (text.length >= 5 && text.length <= 300) {
          recentRemovedText.set(text, nowMs);
        }
      }
    }
    // PASS 2: Process added nodes. processElement tự check Layer C.
    const collected = { chats: [], gifts: [] };
    for (const m of mutations) {
      if (m.type !== 'childList') continue;
      for (const node of m.addedNodes) {
        if (!node || node.nodeType !== 1) continue;
        const r = processElement(node);
        collected.chats.push(...r.chats);
        collected.gifts.push(...r.gifts);
      }
    }
    if (collected.chats.length || collected.gifts.length) {
      _totalChatsCaptured += collected.chats.length;
      _totalGiftsCaptured += collected.gifts.filter(g => g.type === 'gift').length;
      _totalHeartsCaptured += collected.gifts.filter(g => g.type === 'heart').length;
      for (const ev of collected.chats) send('embed:parsed', { ...ev, ts: Date.now() });
      for (const ev of collected.gifts) send('embed:parsed', { ...ev, ts: Date.now() });
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  send('embed:scrape-error', { msg: '[mutation-observer] attached realtime DOM watcher' });
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

// VIP/SVIP/Top/Family badges — extract từ chat row text để NPC nhận biết
// user quan trọng. Dựa trên screenshot user (WEEK Top1, SASHA♥, SVIP5, etc.).
// Patterns conservative để tránh false positive.
const BADGE_PATTERNS = {
  svip:   /SVIP\s*(\d+)/i,
  vip:    /(?:^|[^S])VIP\s*(\d+)/i,
  top:    /(WEEK|DAY|MONTH|TUẦN|NGÀY|THÁNG)\s+Top\s*(\d+)/iu,
  family: /(\d+)\s+([A-Za-z][A-Za-z0-9_]{2,15})\s*♥/u,
};

function detectBadges(text) {
  const badges = [];
  if (!text) return badges;
  let m;
  if ((m = BADGE_PATTERNS.svip.exec(text))) {
    badges.push({ type: 'svip', tier: parseInt(m[1], 10) || 0 });
  }
  if ((m = BADGE_PATTERNS.vip.exec(text)) && !/SVIP/i.test(text)) {
    badges.push({ type: 'vip', tier: parseInt(m[1], 10) || 0 });
  }
  if ((m = BADGE_PATTERNS.top.exec(text))) {
    badges.push({
      type: 'top',
      period: m[1].toUpperCase().replace('TUẦN', 'WEEK').replace('NGÀY', 'DAY').replace('THÁNG', 'MONTH'),
      rank: parseInt(m[2], 10) || 0,
    });
  }
  if ((m = BADGE_PATTERNS.family.exec(text))) {
    badges.push({ type: 'family', level: parseInt(m[1], 10) || 0, name: m[2] });
  }
  return badges;
}

// CHAT-BASED heart detection (cách BIGO LIVE thật sự dùng).
// Khi viewer tap màn hình gửi like cho idol, BIGO emit chat message dạng:
//   "<USER> gửi <N> lượt thích cho Idol ❤"  (Vietnamese)
//   "<USER> sent <N> likes to Idol"           (English)
//   "<USER> 给 Idol 发送 <N> 个赞"             (Chinese)
//
// Match patterns trong content của chat row (sau khi tryMatchChat đã extract user/content).
const HEART_CHAT_PATTERNS = [
  /g[uưử]+i\s+(\d+)\s+l[uượ]+t?\s+th[ií]ch/iu,           // VN: "gửi N lượt thích"
  /sent\s+(\d+)\s+(?:hearts?|likes?|loves?)/i,             // EN: "sent N hearts/likes"
  /发送\s*(\d+)\s*个?\s*[赞喜]/u,                          // CN: "发送N赞"
  /(\d+)\s+(?:hearts?|likes?)\s+(?:to|cho)/i,              // EN/VN mix: "100 likes to"
];

function detectHeartFromChat(content) {
  if (!content) return 0;
  for (const re of HEART_CHAT_PATTERNS) {
    const m = String(content).match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > 0 && n < 100000) return n; // sanity bound
    }
  }
  return 0;
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

  // Attach MutationObserver NGAY → bắt new chat rows realtime.
  // Đây là PRIMARY path. Tick scan là SAFETY NET cho elements existed pre-attach.
  attachMutationObserver();

  let lastMeta = '';
  let tickCount = 0;
  const tick = () => {
    try {
      tickCount++;
      // Diagnostic mỗi 30 ticks (~9s với 300ms interval).
      if (tickCount === 5 || tickCount % 30 === 0) {
        let count = 0;
        for (const _ of walkAllElements(document.body)) count++;
        send('embed:scrape-error', {
          msg: `[diag tick=${tickCount}] DOM=${count} elements | TOTAL captured: ${_totalChatsCaptured} chats, ${_totalGiftsCaptured} gifts, ${_totalHeartsCaptured} hearts`,
        });
      }
      const { chats, gifts } = scanChatsAndGifts();
      // Track via global counters (cùng processElement với MutationObserver).
      _totalChatsCaptured += chats.length;
      _totalGiftsCaptured += gifts.filter(g => g.type === 'gift').length;
      _totalHeartsCaptured += gifts.filter(g => g.type === 'heart').length;
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
  setTimeout(tick, 3000);
  // Tick interval 300ms (giảm từ 800ms) cho safety net — MutationObserver đã catch
  // hầu hết events realtime, tick này backup nếu observer miss (rare).
  setInterval(tick, 300);
}

attach();
send('embed:ready', { url: FRAME_URL, isMain: IS_MAIN, ts: Date.now() });
