// Hũ Thủy Tinh — physics thật bằng Matter.js.
// Quà rơi vào hũ, xếp chồng tự nhiên. Khi hũ đầy, quà tràn qua miệng, rơi ra ngoài
// và nằm yên ở mặt sàn dưới đáy overlay OBS (world floor).
const { Engine, Runner, Composite, Bodies, Body, Events } = Matter;

const token = new URLSearchParams(location.search).get('token') || '';
const content = document.getElementById('content');
const canvas = document.getElementById('jarCanvas');
const ctx = canvas.getContext('2d');
const fxCanvas = document.getElementById('fxCanvas');
const fxCtx = fxCanvas.getContext('2d');
const jarBottomEl = document.getElementById('jarBottom');
const jarGlassEl = document.getElementById('jarGlass');
const actorLayer = document.getElementById('actorLayer');

const W = 1080;
const H = 1920;
const JAR_ASPECT = 1024 / 1536;
// Tỉ lệ hình học của hũ (theo PNG jar-glass 1024×1536), dùng để dựng tường va chạm khớp với ảnh.
const SHAPE = {
  bodyLeftX: 0.085, bodyRightX: 0.915,
  bodyBottomY: 0.895,
  neckTopY: 0.195, neckLeftX: 0.10, neckRightX: 0.90,
  shoulderY: 0.235,
};
const THEME_FILES = {
  default: 'jar-glass.png', blue: 'jar-glass_blue.png', green: 'jar-glass_green.png',
  orange: 'jar-glass_cam.png', pink: 'jar-glass_pink.png', purple: 'jar-glass_tim.png', yellow: 'jar-glass_yellow.png',
};

const engine = Engine.create();
const bodies = [];
const images = new Map();
const spawnQueue = [];

let config = defaultConfig();
let jarWalls = [];
let worldWalls = [];
// Gom Đậu tích luỹ mỗi người tặng trong phiên. Key = openid (nếu có) hoặc tên.
// Hũ treo avatar TOP 5 theo tổng Đậu. Giữ avatar tốt nhất đã thấy (event sau
// thiếu avatar vẫn dùng lại avatar cũ → tránh fallback tròn cam).
const gifters = new Map();
let topGifters = [];
let stats = { gifts: 0, diamonds: 0 };
let lastSpawn = 0;
// Trạng thái hiệu ứng tác động hũ (mốc thời gian kết thúc, ms theo performance.now()).
const fx = { gravFlipUntil: 0, magnetUntil: 0 };

// Trần tốc độ mỗi tick — chống tunneling khi OBS chạy 30fps (dt lớn → di chuyển nhiều/tick).
const MAX_BODY_V = 34;
const CULL_BELOW_Y = H + 1600;

function defaultConfig() {
  return { enabled: true, visible: true, xPercent: 81, yPercent: 83, height: 500, dropHeight: 80, minIcon: 66, maxIcon: 124, gravity: 4, bounce: 0.55, friction: 0.11, showAvatar: true, showCount: true, theme: 'yellow' };
}

function clamp(n, low, high) { return Math.max(low, Math.min(high, n)); }

function normalizeConfig(next) {
  const base = { ...defaultConfig(), ...(next || {}) };
  const minIcon = clamp(Number(base.minIcon) || 34, 18, 100);
  return {
    enabled: base.enabled !== false,
    visible: base.visible !== false,
    xPercent: clamp(Number(base.xPercent) || 72, 10, 90),
    yPercent: clamp(Number(base.yPercent) || 72, 15, 90),
    height: clamp(Number(base.height) || 560, 220, 900),
    dropHeight: clamp(Number(base.dropHeight) || 420, 80, 1200),
    minIcon,
    maxIcon: Math.max(minIcon, clamp(Number(base.maxIcon) || 118, 40, 220)),
    gravity: clamp(Number(base.gravity) || 1, 0.4, 4),
    bounce: clamp(Number(base.bounce) || 0, 0, 0.9),
    friction: clamp(Number(base.friction) || 0, 0, 0.4),
    showAvatar: base.showAvatar !== false,
    showCount: base.showCount !== false,
    theme: THEME_FILES[base.theme] ? base.theme : 'default',
  };
}

function jarRect() {
  const h = config.height;
  const w = h * JAR_ASPECT;
  const cx = W * config.xPercent / 100;
  const cy = H * config.yPercent / 100;
  return { x: cx - w / 2, y: cy - h / 2, w, h, cx, cy };
}

function scaleToViewport() {
  content.style.setProperty('--scale', String(Math.min(innerWidth / W, innerHeight / H)));
}

function imageFor(src) {
  if (!src) return null;
  if (images.has(src)) return images.get(src);
  const image = new Image();
  image.src = src;
  images.set(src, image);
  return image;
}

function fallbackLogo() {
  return imageFor('/logo-hp.png');
}

function iconSize(unitDiamonds) {
  const t = clamp(Math.log10(Math.max(1, unitDiamonds)) / 5, 0, 1);
  return Math.round(config.minIcon + (config.maxIcon - config.minIcon) * t);
}

// ===== Tường va chạm =====
function makeWall(x, y, w, h, angle = 0) {
  return Bodies.rectangle(x, y, w, h, { isStatic: true, angle, friction: 0.6, restitution: 0.08 });
}

function buildWorldWalls() {
  if (worldWalls.length) return;
  // Sàn SÁT đáy overlay — mép trên ở y=H → quà tràn rơi xuống nằm yên ngay đáy khung OBS.
  worldWalls.push(makeWall(W / 2, H + 200, W + 400, 400));
  // Tường hông CAO phủ từ trên trần xuống sàn → khi đảo trọng lực quà bay lên cao vẫn không thoát ra ngoài.
  worldWalls.push(makeWall(-120, -600, 240, 6000));
  worldWalls.push(makeWall(W + 120, -600, 240, 6000));
  worldWalls.push(makeWall(W / 2, -2200, W + 400, 200));
  Composite.add(engine.world, worldWalls);
}

function buildJarWalls() {
  if (jarWalls.length) { Composite.remove(engine.world, jarWalls); jarWalls = []; }
  const r = jarRect();
  const T = 14;
  const lx = r.x + r.w * SHAPE.bodyLeftX;
  const rx = r.x + r.w * SHAPE.bodyRightX;
  const by = r.y + r.h * SHAPE.bodyBottomY;
  const sy = r.y + r.h * SHAPE.shoulderY;
  const nlx = r.x + r.w * SHAPE.neckLeftX;
  const nrx = r.x + r.w * SHAPE.neckRightX;
  const nty = r.y + r.h * SHAPE.neckTopY;
  // Đáy hũ dày 80px chống tunneling khi rơi nhanh (30fps).
  const FLOOR_T = 80;
  jarWalls.push(makeWall((lx + rx) / 2, by + FLOOR_T / 2, rx - lx + T, FLOOR_T));
  const bh = by - sy;
  jarWalls.push(makeWall(lx, sy + bh / 2, T, bh));
  jarWalls.push(makeWall(rx, sy + bh / 2, T, bh));
  // Vai hũ nghiêng nối thân → cổ.
  let dx = nlx - lx, dy = sy - nty;
  let len = Math.hypot(dx, dy), ang = Math.atan2(dy, -dx);
  jarWalls.push(makeWall((lx + nlx) / 2, (sy + nty) / 2, len, T, -ang));
  dx = rx - nrx;
  len = Math.hypot(dx, dy); ang = Math.atan2(dy, dx);
  jarWalls.push(makeWall((rx + nrx) / 2, (sy + nty) / 2, len, T, ang));
  // Cổ hũ (miệng mở phía trên → quà đầy sẽ tràn qua đây).
  const nh = sy - nty;
  jarWalls.push(makeWall(nlx, nty + nh / 2, T, nh + 8));
  jarWalls.push(makeWall(nrx, nty + nh / 2, T, nh + 8));
  Composite.add(engine.world, jarWalls);
}

function positionJar() {
  const r = jarRect();
  for (const el of [jarBottomEl, jarGlassEl]) {
    el.style.left = (r.x / W * 100) + '%';
    el.style.top = (r.y / H * 100) + '%';
    el.style.width = (r.w / W * 100) + '%';
    el.style.height = (r.h / H * 100) + '%';
    el.style.opacity = config.visible ? '1' : '0';
  }
  jarBottomEl.src = `/jar-assets/jar-bottom.png?token=${encodeURIComponent(token)}`;
  jarGlassEl.src = `/jar-assets/${THEME_FILES[config.theme]}?token=${encodeURIComponent(token)}`;
  buildJarWalls();
}

// ===== Quà =====
function enqueueGift(gift) {
  if (!config.enabled) return;
  const count = Math.max(1, parseInt(gift.gift_count, 10) || 1);
  const totalDiamonds = Math.max(1, Number(gift.diamonds) || 1);
  const unitDiamonds = Math.max(1, totalDiamonds / count);
  const icon = gift.gift_icon || (gift.gift_id ? `/gift-icon/${encodeURIComponent(gift.gift_id)}?token=${encodeURIComponent(token)}` : '');
  for (let i = 0; i < count; i++) spawnQueue.push({ icon, size: iconSize(unitDiamonds), name: gift.gift_name || 'Quà' });
  stats.gifts += count;
  stats.diamonds += totalDiamonds;
  accumulateGifter(gift, totalDiamonds);
}

// Cộng dồn Đậu cho người tặng và cập nhật danh sách TOP 5.
function accumulateGifter(gift, diamonds) {
  if (!gift.user && !gift.user_openid) return;
  const key = String(gift.user_openid || gift.user || '').trim();
  if (!key) return;
  let g = gifters.get(key);
  if (!g) {
    g = { key, name: String(gift.user || 'Khách'), avatar: '', diamonds: 0, hanger: hangerFor(key) };
    gifters.set(key, g);
  }
  if (gift.user) g.name = String(gift.user);
  // Giữ avatar tốt nhất: chỉ ghi đè khi event có avatar (event thiếu không xoá cái cũ).
  const av = gift.user_avatar_url || '';
  if (av && av !== g.avatar) { g.avatar = av; imageFor(av); }
  g.diamonds += Math.max(0, Number(diamonds) || 0);
  g.lastTs = performance.now();
  recomputeTopGifters();
}

// TOP 5 theo tổng Đậu (đồng hạng → người tặng gần nhất trước).
function recomputeTopGifters() {
  topGifters = [...gifters.values()]
    .sort((a, b) => (b.diamonds - a.diamonds) || ((b.lastTs || 0) - (a.lastTs || 0)))
    .slice(0, 5);
}

function makeGiftBody(g, x, y) {
  const sz = g.size;
  const body = Bodies.circle(x, y, sz / 2, {
    restitution: config.bounce,
    friction: clamp(0.15 + config.friction, 0, 0.9),
    frictionStatic: 0.6,
    density: 0.0016,
  });
  body.gm = { sz, img: imageFor(g.icon), name: g.name };
  Body.setVelocity(body, { x: (Math.random() - 0.5) * 2, y: Math.random() * 2 + 1 });
  Composite.add(engine.world, body);
  bodies.push(body);
  return body;
}

// Đỉnh cao nhất của đống quà quanh cột thả (y nhỏ nhất). Dùng để LUÔN thả từ trên
// cao hơn đống — kể cả khi hũ đã đầy tràn qua miệng.
function pileTopNear(x, spread) {
  let top = Infinity;
  for (const b of bodies) {
    if (Math.abs(b.position.x - x) > spread) continue;
    if (b.position.y < top) top = b.position.y;
  }
  return top;
}

function spawnOne() {
  const g = spawnQueue.shift();
  if (!g) return;
  const r = jarRect();
  const nl = r.x + r.w * SHAPE.neckLeftX + 8;
  const nr = r.x + r.w * SHAPE.neckRightX - 8;
  const mouthTop = r.y + r.h * SHAPE.neckTopY;
  // Phân phối tam giác → quà tập trung giữa miệng, ít đập mép cổ.
  const margin = (nr - nl) * 0.14;
  const innerL = nl + margin, innerR = nr - margin;
  const t = (Math.random() + Math.random()) / 2;
  const x = clamp(innerL + t * (innerR - innerL), g.size, W - g.size);
  // Quà LUÔN rơi từ trên cao: cao hơn miệng hũ VÀ cao hơn đống quà hiện có.
  // Khi hũ đầy, đống dâng qua miệng → quà mới rơi trúng đống (cao hơn hũ),
  // rồi lăn/trượt/nẩy ra ngoài, xuống nằm ở đáy overlay — không đẩy từ trong ra.
  const ref = Math.min(mouthTop, pileTopNear(x, g.size * 2.2));
  const y = ref - g.size - config.dropHeight - Math.random() * 60;
  makeGiftBody(g, x, Math.max(-2050, y)); // dưới trần (-2100) để quà không kẹt trên trần
}

// ===== Avatar treo + pill thống kê (vẽ trên fx-canvas, phía trên kính hũ) =====
function stableHash(value) {
  let hash = 2166136261;
  for (const ch of String(value || 'guest')) { hash ^= ch.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return hash >>> 0;
}

function hangerFor(name) {
  const hash = stableHash(name);
  const t = (hash % 1000) / 1000;
  const phase = ((hash >>> 10) % 628) / 100;
  switch (hash % 3) {
    case 0: return { x: 0.18 + t * 0.64, y: 0.13, phase };
    case 1: return { x: 0.10, y: 0.27 + t * 0.50, phase };
    default: return { x: 0.90, y: 0.27 + t * 0.50, phase };
  }
}

// ===== Hiệu ứng tác động hũ (Phase 1) =====
// Rung hũ: hất tung toàn bộ quà lên + sang ngang một nhịp.
function fxShake() {
  // SSE quà và action tới liền nhau. Tạo ít nhất quà đầu tiên trước khi hất,
  // nếu không shake chạy trên hũ trống và người xem không thấy gì.
  if (!bodies.length && spawnQueue.length) spawnOne();
  for (const el of [jarBottomEl, jarGlassEl]) {
    if (typeof el.animate === 'function') {
      el.animate([
        { transform: 'translateX(0) rotate(0deg)' },
        { transform: 'translateX(-14px) rotate(-2.2deg)' },
        { transform: 'translateX(13px) rotate(2deg)' },
        { transform: 'translateX(-9px) rotate(-1.3deg)' },
        { transform: 'translateX(0) rotate(0deg)' },
      ], { duration: 460, easing: 'ease-in-out' });
    }
  }
  for (const b of bodies) {
    Body.setVelocity(b, { x: (Math.random() - 0.5) * 26, y: -(6 + Math.random() * 16) });
    Body.setAngularVelocity(b, (Math.random() - 0.5) * 0.6);
  }
}

// Đảo trọng lực: quà nổi lên nhẹ rồi rơi lại (~1.6s, lực giảm để không bay khuất khỏi khung).
function fxGravFlip() {
  fx.gravFlipUntil = performance.now() + 1600;
  engine.gravity.y = -Math.abs(config.gravity) * 0.6;
}

// Nam châm: hút toàn bộ quà về tâm hũ trong ~3s (đặt vận tốc hướng tâm mỗi tick — đủ mạnh để thắng trọng lực).
function fxMagnet() {
  fx.magnetUntil = performance.now() + 3000;
}

// Hàm chạy animation theo thời gian (0→1) bằng rAF, trả promise khi xong.
function animate(dur, fn) {
  return new Promise(res => {
    const t0 = performance.now();
    const step = () => {
      const p = Math.min(1, (performance.now() - t0) / dur);
      fn(p);
      if (p < 1) requestAnimationFrame(step); else res();
    };
    requestAnimationFrame(step);
  });
}

// Khoá hũ: các hiệu ứng ĐỘNG VÀO khung hũ (đá hũ, dốc ngược) không được chạy đè lên nhau,
// nhưng vẫn chạy đồng thời với các hiệu ứng khác (rung, nam châm, trộm, đĩa bay, mưa...).
let jarLock = Promise.resolve();
function withJarLock(task) {
  const p = jarLock.then(() => task());
  jarLock = p.catch(() => {});
  return p;
}

// Dốc ngược hũ: hũ bay lên giữa màn hình → LẬT miệng hướng xuống → quà rơi xuống đất →
// hũ bay về chỗ cũ, miệng xoay lại hướng lên như ban đầu.
function fxPourOut() {
 return withJarLock(async () => {
  const r = jarRect();
  const inside = bodies.filter(b => insideJar(b, r));
  const start = inside.map(b => ({ b, rx: b.position.x - r.cx, ry: b.position.y - r.cy }));
  for (const s of start) Body.setStatic(s.b, true);
  if (jarWalls.length) { Composite.remove(engine.world, jarWalls); jarWalls = []; }
  const tx = W * 0.5, ty = H * 0.30, dx = tx - r.cx, dy = ty - r.cy;
  content.classList.add('jar-flying');
  // Pha 1: bay lên giữa + lật 180° (miệng xuống); quà xoay theo quanh tâm hũ.
  await animate(720, p => {
    const ease = 1 - (1 - p) * (1 - p);
    const ox = dx * ease, oy = dy * ease - Math.sin(p * Math.PI) * 90;
    const deg = 180 * ease, ang = deg * Math.PI / 180, cos = Math.cos(ang), sin = Math.sin(ang);
    jarBottomEl.style.transform = `translate(${ox}px, ${oy}px) rotate(${deg}deg)`;
    jarGlassEl.style.transform = `translate(${ox}px, ${oy}px) rotate(${deg}deg)`;
    const cx = r.cx + ox, cy = r.cy + oy;
    for (const s of start) Body.setPosition(s.b, { x: cx + s.rx * cos - s.ry * sin, y: cy + s.rx * sin + s.ry * cos });
  });
  // Miệng đang hướng xuống → thả quà rơi xuống đất.
  for (const s of start) { Body.setStatic(s.b, false); Body.setVelocity(s.b, { x: (Math.random() - 0.5) * 5, y: 3 + Math.random() * 4 }); }
  await waitMs(750);
  // Pha 2: hũ bay về chỗ cũ, xoay 180→360 (miệng lại hướng lên).
  await animate(620, p => {
    const ease = p * p;
    const ox = dx * (1 - ease), oy = dy * (1 - ease);
    const deg = 180 + 180 * ease;
    jarBottomEl.style.transform = `translate(${ox}px, ${oy}px) rotate(${deg}deg)`;
    jarGlassEl.style.transform = `translate(${ox}px, ${oy}px) rotate(${deg}deg)`;
  });
  jarBottomEl.style.transform = ''; jarGlassEl.style.transform = '';
  content.classList.remove('jar-flying');
  buildJarWalls();
 });
}

// ===== Tiện ích nhân vật =====
function removeBody(b) {
  const i = bodies.indexOf(b);
  if (i >= 0) { Composite.remove(engine.world, b); bodies.splice(i, 1); }
}

function spawnBodyAt(icon, sz, x, y, vx, vy) {
  const body = Bodies.circle(x, y, sz / 2, { restitution: config.bounce, friction: clamp(0.15 + config.friction, 0, 0.9), frictionStatic: 0.6, density: 0.0016 });
  body.gm = { sz, img: imageFor(icon), name: 'Quà' };
  Body.setVelocity(body, { x: vx || 0, y: vy || 0 });
  Composite.add(engine.world, body);
  bodies.push(body);
  return body;
}

const waitMs = (ms) => new Promise(res => setTimeout(res, ms));
function bodyIcon(b) { return b.gm?.img?.src || '/logo-hp.png'; }
function insideJar(b, r) { const p = b.position; return p.x > r.x + r.w * SHAPE.bodyLeftX && p.x < r.x + r.w * SHAPE.bodyRightX && p.y > r.y + r.h * SHAPE.neckTopY && p.y < r.y + r.h * SHAPE.bodyBottomY; }
function sample(arr, k) {
  const c = arr.slice();
  for (let i = c.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; const t = c[i]; c[i] = c[j]; c[j] = t; }
  return c.slice(0, Math.min(k, c.length));
}

function actorNode(emoji, label) {
  const el = document.createElement('div');
  el.className = 'actor';
  el.innerHTML = `<div class="emoji">${emoji}</div><div class="label">${label}</div><div class="cargo"></div>`;
  actorLayer.appendChild(el);
  return el;
}
function setCargo(el, icons) {
  const box = el.querySelector('.cargo');
  box.innerHTML = icons.map(src => `<img src="${src}">`).join('');
}
function moveActor(el, x, y) { el.style.left = x + 'px'; el.style.top = y + 'px'; }

// ===== Kẻ trộm: đu dây xuống, lấy quà trong/ngoài hũ, trèo lên biến mất, có thể rơi quà lúc trốn =====
async function fxThief() {
  if (!bodies.length) return;
  // Xuất hiện ở vị trí NGẪU NHIÊN khắp bề ngang; ưu tiên giật quà gần cột dây, không có thì lấy ngẫu nhiên.
  const ropeX = clamp(120 + Math.random() * (W - 240), 120, W - 120);
  const near = bodies.filter(b => Math.abs(b.position.x - ropeX) < 170);
  const targets = sample(near.length ? near : bodies, 1 + (Math.random() * 3 | 0));
  const grabY = clamp(targets.length ? Math.min(...targets.map(t => t.position.y)) - 10 : H * 0.6, 260, H - 180);
  const rope = document.createElement('div'); rope.className = 'rope';
  actorLayer.appendChild(rope);
  const el = actorNode('🥷', 'Trộm!');
  const place = (y) => { moveActor(el, ropeX, y); rope.style.left = ropeX + 'px'; rope.style.top = '-220px'; rope.style.height = (y - (-220) - 40) + 'px'; };
  el.style.transition = 'top .6s cubic-bezier(.3,.7,.4,1), left .5s ease';
  place(-160);
  await waitMs(40);
  place(grabY);              // đu dây xuống chỗ quà
  await waitMs(640);
  const cargo = [];          // giật quà (xoá khỏi hũ, cầm theo)
  for (const t of targets) { if (bodies.indexOf(t) < 0) continue; cargo.push(bodyIcon(t)); removeBody(t); }
  setCargo(el, cargo);
  await waitMs(260);
  el.style.transition = 'top .85s ease-in, left .85s ease-in';
  place(-180);               // trèo lên trốn
  // rơi quà lúc chạy trốn (tỉ lệ THẤP ~18%)
  await waitMs(320);
  if (cargo.length && Math.random() < 0.18) {
    const dropIcon = cargo.pop(); setCargo(el, cargo);
    const dropSz = config.minIcon + Math.random() * (config.maxIcon - config.minIcon) * 0.5;
    spawnBodyAt(dropIcon, dropSz, ropeX, clamp(parseFloat(el.style.top), 40, H - 120), (Math.random() - 0.5) * 5, 2);
  }
  await waitMs(560);
  el.remove(); rope.remove();
}

// ===== Đá hũ: OSIN đi từ trái tới, đá hũ → hũ bay lên giữa vỡ ra → quà rơi xuống đất =====
function fxKickJar() {
 return withJarLock(async () => {
  const r = jarRect();
  const groundY = r.y + r.h * 0.92;
  const el = actorNode('🧍', '😡 OSIN');
  el.classList.add('osin-walk');
  el.style.transition = 'left 1.25s linear';
  el.style.left = -140 + 'px'; el.style.top = groundY + 'px';
  await waitMs(40);
  el.style.left = (r.x - r.w * 0.12) + 'px';   // đi tới cạnh trái hũ
  await waitMs(1250);
  el.classList.remove('osin-walk');
  // Cú đá: cả NGƯỜI lao tới hũ + nghiêng người (giữ nguyên hình người, không đổi thành cái chân).
  el.style.transition = 'transform .16s cubic-bezier(.5,1.7,.5,1), left .16s ease';
  el.style.left = (r.x - r.w * 0.02) + 'px';
  el.style.transform = 'translate(-50%, -50%) rotate(24deg) scale(1.08)';
  await waitMs(200);

  // Hũ + quà bên trong bay parabol lên giữa màn hình rồi vỡ.
  const inside = bodies.filter(b => insideJar(b, r));
  const start = inside.map(b => ({ b, sx: b.position.x, sy: b.position.y }));
  for (const s of start) Body.setStatic(s.b, true);
  if (jarWalls.length) { Composite.remove(engine.world, jarWalls); jarWalls = []; }
  const tx = W * 0.5, ty = H * 0.34;
  const dx = tx - r.cx, dy = ty - r.cy;
  content.classList.add('jar-flying');
  const flyDur = 560, t0 = performance.now();
  await new Promise(res => {
    const anim = () => {
      const p = Math.min(1, (performance.now() - t0) / flyDur);
      const ease = 1 - (1 - p) * (1 - p);
      const ox = dx * ease, oy = dy * ease - Math.sin(p * Math.PI) * 120; // nhấc lên theo cung
      const rot = 200 * ease;
      jarBottomEl.style.transform = `translate(${ox}px, ${oy}px) rotate(${rot}deg)`;
      jarGlassEl.style.transform = `translate(${ox}px, ${oy}px) rotate(${rot}deg)`;
      for (const s of start) Body.setPosition(s.b, { x: s.sx + ox, y: s.sy + oy });
      if (p < 1) requestAnimationFrame(anim); else res();
    };
    requestAnimationFrame(anim);
  });

  // VỠ: ẩn hũ, bắn quà tung toé rơi xuống đất + mảnh vỡ.
  jarBottomEl.style.transition = 'opacity .25s'; jarGlassEl.style.transition = 'opacity .25s';
  jarBottomEl.style.opacity = '0'; jarGlassEl.style.opacity = '0';
  for (const s of start) {
    Body.setStatic(s.b, false);
    Body.setVelocity(s.b, { x: (Math.random() - 0.5) * 20, y: -(3 + Math.random() * 7) });
    Body.setAngularVelocity(s.b, (Math.random() - 0.5) * 0.5);
  }
  spawnShards(tx, ty);
  el.remove();
  await waitMs(1100);

  // Hũ hiện lại tại chỗ cũ, dựng lại tường (quà đã rơi xuống đất giữ nguyên).
  jarBottomEl.style.transform = ''; jarGlassEl.style.transform = '';
  jarBottomEl.style.opacity = config.visible ? '1' : '0'; jarGlassEl.style.opacity = config.visible ? '1' : '0';
  await waitMs(300);
  content.classList.remove('jar-flying');
  jarBottomEl.style.transition = ''; jarGlassEl.style.transition = '';
  buildJarWalls();
 });
}

function spawnShards(x, y) {
  for (let i = 0; i < 14; i++) {
    const s = document.createElement('div');
    s.className = 'actor';
    s.innerHTML = `<div class="emoji" style="font-size:${20 + Math.random() * 26}px">✨</div>`;
    actorLayer.appendChild(s);
    let px = x, py = y, vx = (Math.random() - 0.5) * 26, vy = -4 - Math.random() * 10;
    const t0 = performance.now();
    const anim = () => {
      const dt = (performance.now() - t0) / 16.7;
      vy += 0.9; px += vx; py += vy;
      s.style.left = px + 'px'; s.style.top = py + 'px';
      s.style.opacity = String(Math.max(0, 1 - dt / 55));
      if (dt < 55) requestAnimationFrame(anim); else s.remove();
    };
    requestAnimationFrame(anim);
  }
}

// ===== Đĩa bay: xuất hiện, vệt sáng, hút 5-10 quà NGOÀI hũ, bay tới miệng hũ, thả vào hũ =====
async function fxUFO() {
  const r = jarRect();
  const outside = bodies.filter(b => !insideJar(b, r) && b.position.y > r.y);
  const targets = sample(outside, 5 + (Math.random() * 6 | 0)); // 5-10
  const flyY = H * 0.12;
  const beam = document.createElement('div'); beam.className = 'ufo-beam';
  actorLayer.appendChild(beam);
  const el = actorNode('🛸', 'Đĩa bay');
  el.style.transition = 'left 1s ease, top .8s ease';
  const dir = Math.random() < 0.5 ? 1 : -1;
  const overX = targets.length ? clamp(targets.reduce((s, t) => s + t.position.x, 0) / targets.length, 120, W - 120) : W * 0.5;
  const drawBeam = (x, y, toY) => { beam.style.left = x + 'px'; beam.style.top = (y + 40) + 'px'; beam.style.width = '150px'; beam.style.height = Math.max(0, toY - y - 40) + 'px'; };
  moveActor(el, dir > 0 ? -140 : W + 140, flyY); drawBeam(dir > 0 ? -140 : W + 140, flyY, flyY);
  await waitMs(40);
  moveActor(el, overX, flyY);                 // bay tới trên đám quà ngoài hũ
  await waitMs(1000);
  drawBeam(overX, flyY, H * 0.92);            // bật vệt sáng xuống đất
  await waitMs(250);
  const cargo = [];                            // hút quà lên (xoá khỏi sàn, cầm theo)
  for (const t of targets) { if (bodies.indexOf(t) < 0) continue; cargo.push(bodyIcon(t)); removeBody(t); }
  setCargo(el, cargo);
  await waitMs(300);
  const mouthX = r.cx, mouthY = r.y + r.h * SHAPE.neckTopY - 150;
  drawBeam(mouthX, flyY, flyY);                // tắt vệt sáng khi di chuyển
  moveActor(el, mouthX, flyY);                 // bay tới trên miệng hũ
  await waitMs(1000);
  for (let i = 0; i < cargo.length; i++) {     // thả từng quà xuống VÀO hũ
    const sz = config.minIcon + Math.random() * (config.maxIcon - config.minIcon) * 0.6;
    spawnBodyAt(cargo[i], sz, mouthX + (Math.random() - 0.5) * r.w * 0.4, mouthY + 40, (Math.random() - 0.5) * 2, 3);
    setCargo(el, cargo.slice(i + 1));
    await waitMs(120);
  }
  await waitMs(200);
  moveActor(el, dir > 0 ? W + 160 : -160, flyY * 0.7); // bay đi
  await waitMs(900);
  el.remove(); beam.remove();
}

// Chạy 1 hành động, trả promise hoàn tất (hiệu ứng tức thời chờ 1 nhịp để lượt sau tách rời).
async function runAction(type) {
  switch (type) {
    case 'shake': fxShake(); return waitMs(650);
    case 'gravflip': fxGravFlip(); return waitMs(1800);
    case 'magnet': fxMagnet(); return waitMs(3200);
    case 'pourout': return fxPourOut();
    case 'kick': return fxKickJar();
    case 'thief': return fxThief();
    case 'ufo': return fxUFO();
  }
}

// Hàng chờ hành động RIÊNG cho từng loại hiệu ứng:
// - Các hiệu ứng KHÁC nhau chạy ĐỒNG THỜI (mỗi loại một vòng xử lý riêng).
// - Cùng 1 hiệu ứng lên nhiều lần (combo N) → xếp thành danh sách chạy LẦN LƯỢT đến hết.
const actionQueues = new Map();   // type -> [markers]
const actionRunning = new Map();  // type -> bool
async function processActionQueue(type) {
  if (actionRunning.get(type)) return;
  actionRunning.set(type, true);
  const q = actionQueues.get(type);
  while (q && q.length) {
    q.shift();
    try { await runAction(type); } catch (e) { /* bỏ qua lỗi 1 lượt, chạy tiếp */ }
  }
  actionRunning.set(type, false);
}
function enqueueAction(type, count) {
  if (!type) return;
  const n = Math.max(1, Math.min(50, parseInt(count, 10) || 1)); // trần 50 lượt/lần cho an toàn
  if (!actionQueues.has(type)) actionQueues.set(type, []);
  const q = actionQueues.get(type);
  for (let i = 0; i < n; i++) q.push(1);
  processActionQueue(type);
}

// Cập nhật hiệu ứng theo thời gian — gọi mỗi tick trong afterUpdate.
function updateFx(now) {
  if (fx.gravFlipUntil && now >= fx.gravFlipUntil) { fx.gravFlipUntil = 0; engine.gravity.y = Math.abs(config.gravity); }
  if (fx.magnetUntil) {
    if (now >= fx.magnetUntil) fx.magnetUntil = 0;
    else {
      const r = jarRect();
      const cy = r.y + r.h * 0.55;
      for (const b of bodies) {
        const dx = r.cx - b.position.x, dy = cy - b.position.y;
        const d = Math.hypot(dx, dy) || 1;
        const speed = clamp(d * 0.14, 0, 17); // vận tốc hướng tâm ~ khoảng cách → tụ về giữa rồi dừng, không dao động
        Body.setVelocity(b, { x: (dx / d) * speed, y: (dy / d) * speed });
      }
    }
  }
}

function drawPill(x, y, w, h, text) {
  fxCtx.save();
  fxCtx.fillStyle = 'rgba(9, 13, 23, .82)';
  fxCtx.strokeStyle = 'rgba(255, 209, 102, .62)';
  fxCtx.lineWidth = 2;
  fxCtx.beginPath(); fxCtx.roundRect(x, y, w, h, h / 2); fxCtx.fill(); fxCtx.stroke();
  fxCtx.fillStyle = '#fff'; fxCtx.font = '800 22px Segoe UI, sans-serif'; fxCtx.textAlign = 'center';
  fxCtx.fillText(text, x + w / 2, y + h / 2 + 8);
  fxCtx.restore();
}

function drawStats(rect) {
  if (!config.showCount) return;
  const text = `${stats.diamonds.toLocaleString('vi-VN')} Đậu`;
  fxCtx.font = '800 22px Segoe UI, sans-serif';
  const width = Math.max(220, fxCtx.measureText(text).width + 42);
  drawPill(clamp(rect.cx - width / 2, 12, W - width - 12), clamp(rect.y + rect.h * .9, 12, H - 52), width, 44, text);
}

// Vị trí neo cố định cho TOP 5 quanh miệng hũ (fraction theo jar rect) + tỉ lệ
// kích thước theo hạng. #1 to nhất, ở giữa trên cao; các hạng sau nhỏ dần, xen kẽ.
const AVATAR_SLOTS = [
  { x: 0.50, y: 0.04, scale: 1.00 },
  { x: 0.15, y: 0.17, scale: 0.78 },
  { x: 0.85, y: 0.17, scale: 0.78 },
  { x: 0.30, y: 0.40, scale: 0.64 },
  { x: 0.70, y: 0.40, scale: 0.64 },
];
// Viền theo hạng: vàng / bạc / đồng, còn lại trắng.
const RANK_RING = ['#ffd54a', '#d7dde6', '#e08a4b', 'rgba(255,255,255,.9)', 'rgba(255,255,255,.9)'];

// Vương miện vàng 3 chóp cho TOP 1, ngồi trên đỉnh avatar.
function drawCrown(cx, bottomY, w) {
  const h = w * 0.62;
  const L = cx - w / 2, R = cx + w / 2, B = bottomY;
  fxCtx.save();
  fxCtx.shadowColor = 'rgba(0,0,0,.55)'; fxCtx.shadowBlur = 4;
  fxCtx.beginPath();
  fxCtx.moveTo(L, B);
  fxCtx.lineTo(L, B - h * 0.62);
  fxCtx.lineTo(cx - w * 0.18, B - h * 0.28);
  fxCtx.lineTo(cx, B - h * 1.02);
  fxCtx.lineTo(cx + w * 0.18, B - h * 0.28);
  fxCtx.lineTo(R, B - h * 0.62);
  fxCtx.lineTo(R, B);
  fxCtx.closePath();
  const grad = fxCtx.createLinearGradient(0, B - h, 0, B);
  grad.addColorStop(0, '#ffe98a'); grad.addColorStop(1, '#f5a623');
  fxCtx.fillStyle = grad; fxCtx.fill();
  fxCtx.lineWidth = Math.max(1.5, w * 0.03); fxCtx.strokeStyle = '#b8791b'; fxCtx.stroke();
  // Đế vương miện.
  fxCtx.shadowBlur = 0;
  fxCtx.fillStyle = '#f5a623';
  fxCtx.beginPath(); fxCtx.roundRect(L, B - h * 0.02, w, h * 0.26, h * 0.08); fxCtx.fill(); fxCtx.stroke();
  // Ngọc đỏ ở 3 chóp.
  const gemR = Math.max(2, w * 0.07);
  fxCtx.fillStyle = '#ff5a5a';
  for (const [gx, gy] of [[L, B - h * 0.62], [cx, B - h * 1.02], [R, B - h * 0.62]]) {
    fxCtx.beginPath(); fxCtx.arc(gx, gy, gemR, 0, Math.PI * 2); fxCtx.fill();
  }
  fxCtx.restore();
}

function drawAvatars(rect) {
  if (!config.showAvatar || !topGifters.length) return;
  // Vẽ hạng thấp trước để #1 nằm trên cùng nếu có chồng lấn.
  for (let rank = topGifters.length - 1; rank >= 0; rank--) {
    drawOneAvatar(rect, topGifters[rank], rank);
  }
}

function drawOneAvatar(rect, g, rank) {
  const slot = AVATAR_SLOTS[rank] || AVATAR_SLOTS[AVATAR_SLOTS.length - 1];
  const size = clamp(rect.w * 0.20, 46, 80) * slot.scale;
  const anchorX = rect.x + rect.w * slot.x;
  const anchorY = rect.y + rect.h * slot.y;
  const ropeLength = clamp(rect.h * 0.16, 50, 110) * slot.scale;
  const sway = Math.sin(performance.now() / 430 + (g.hanger?.phase || 0)) * clamp(rect.w * 0.05, 7, 16) * slot.scale;
  const x = clamp(anchorX + sway, size / 2 + 3, W - size / 2 - 3);
  const y = clamp(anchorY + ropeLength, size / 2 + 3, H - size / 2 - 30);
  // Dây treo + điểm neo.
  fxCtx.save();
  fxCtx.strokeStyle = 'rgba(255, 221, 132, .96)';
  fxCtx.lineWidth = 3;
  fxCtx.shadowColor = 'rgba(0,0,0,.78)'; fxCtx.shadowBlur = 4;
  fxCtx.beginPath();
  fxCtx.moveTo(anchorX, anchorY);
  fxCtx.quadraticCurveTo(anchorX + sway * 0.22, anchorY + ropeLength * 0.48, x, y - size / 2);
  fxCtx.stroke();
  fxCtx.fillStyle = '#ffd166';
  fxCtx.beginPath(); fxCtx.arc(anchorX, anchorY, 5, 0, Math.PI * 2); fxCtx.fill();
  fxCtx.shadowBlur = 0;
  // Avatar (bo tròn). Thiếu ảnh → logo HP thay vì tròn cam trơn.
  fxCtx.beginPath(); fxCtx.arc(x, y, size / 2, 0, Math.PI * 2); fxCtx.clip();
  const image = g.avatar ? imageFor(g.avatar) : null;
  if (image?.complete && image.naturalWidth) fxCtx.drawImage(image, x - size / 2, y - size / 2, size, size);
  else {
    const logo = fallbackLogo();
    if (logo?.complete && logo.naturalWidth) fxCtx.drawImage(logo, x - size / 2, y - size / 2, size, size);
    else { fxCtx.fillStyle = '#ff8a3d'; fxCtx.fillRect(x - size / 2, y - size / 2, size, size); }
  }
  fxCtx.restore();
  // Viền theo hạng.
  fxCtx.save();
  fxCtx.strokeStyle = RANK_RING[rank] || 'rgba(255,255,255,.9)';
  fxCtx.lineWidth = rank === 0 ? 5 : 3;
  fxCtx.shadowColor = 'rgba(0,0,0,.6)'; fxCtx.shadowBlur = 4;
  fxCtx.beginPath(); fxCtx.arc(x, y, size / 2, 0, Math.PI * 2); fxCtx.stroke();
  fxCtx.shadowBlur = 0;
  if (rank === 0) {
    // TOP 1 → vương miện trên đỉnh avatar.
    drawCrown(x, y - size / 2 + size * 0.12, size * 0.78);
  } else {
    // Hạng 2..5 → huy hiệu số ở góc trên-trái.
    const badgeR = clamp(size * 0.22, 12, 20);
    const bx = x - size / 2 + badgeR * 0.6, by = y - size / 2 + badgeR * 0.6;
    fxCtx.fillStyle = RANK_RING[rank] || '#fff';
    fxCtx.beginPath(); fxCtx.arc(bx, by, badgeR, 0, Math.PI * 2); fxCtx.fill();
    fxCtx.fillStyle = '#20140a'; fxCtx.font = `800 ${Math.round(badgeR * 1.15)}px Segoe UI, sans-serif`;
    fxCtx.textAlign = 'center'; fxCtx.textBaseline = 'middle';
    fxCtx.fillText(String(rank + 1), bx, by + 1);
    fxCtx.textBaseline = 'alphabetic';
  }
  fxCtx.restore();
}

// ===== Render =====
function render() {
  ctx.clearRect(0, 0, W, H);
  fxCtx.clearRect(0, 0, W, H);
  if (!config.enabled) { requestAnimationFrame(render); return; }

  // Cull quà rơi quá xa (safety net cho tunneling hiếm gặp).
  for (let i = bodies.length - 1; i >= 0; i--) {
    if (bodies[i].position.y > CULL_BELOW_Y) {
      Composite.remove(engine.world, bodies[i]);
      bodies.splice(i, 1);
    }
  }
  for (const b of bodies) {
    const m = b.gm; if (!m) continue;
    ctx.save();
    ctx.translate(b.position.x, b.position.y);
    ctx.rotate(b.angle);
    const img = m.img;
    if (img?.complete && img.naturalWidth) ctx.drawImage(img, -m.sz / 2, -m.sz / 2, m.sz, m.sz);
    else {
      // Quà thiếu icon → hiện logo HP (bo tròn) thay vòng tròn 'G'.
      const logo = fallbackLogo();
      if (logo?.complete && logo.naturalWidth) {
        ctx.save();
        ctx.beginPath(); ctx.arc(0, 0, m.sz / 2, 0, Math.PI * 2); ctx.clip();
        ctx.drawImage(logo, -m.sz / 2, -m.sz / 2, m.sz, m.sz);
        ctx.restore();
      } else {
        ctx.fillStyle = '#ffd166'; ctx.beginPath(); ctx.arc(0, 0, m.sz / 2, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();
  }
  const rect = jarRect();
  drawAvatars(rect);
  drawStats(rect);
  requestAnimationFrame(render);
}

function frame(now) {
  if (config.enabled && spawnQueue.length && now - lastSpawn > 45) {
    for (let i = 0; i < 3 && spawnQueue.length; i++) spawnOne();
    lastSpawn = now;
  }
  requestAnimationFrame(frame);
}

// ===== Init =====
engine.gravity.y = config.gravity;
buildWorldWalls();
positionJar();
scaleToViewport();

// Runner cố định 60fps → vật lý ổn định dù OBS giới hạn FPS.
Runner.run(Runner.create({ isFixed: true, delta: 1000 / 60 }), engine);

// Chặn tốc độ vượt ngưỡng tunneling sau mỗi tick + cập nhật hiệu ứng theo thời gian.
Events.on(engine, 'afterUpdate', () => {
  updateFx(performance.now());
  for (const b of bodies) {
    const v = b.velocity;
    if (Math.abs(v.x) > MAX_BODY_V || Math.abs(v.y) > MAX_BODY_V) {
      Body.setVelocity(b, { x: clamp(v.x, -MAX_BODY_V, MAX_BODY_V), y: clamp(v.y, -MAX_BODY_V, MAX_BODY_V) });
    }
  }
});

addEventListener('resize', scaleToViewport);
requestAnimationFrame(frame);
requestAnimationFrame(render);

const es = new EventSource(`/jar-events?token=${encodeURIComponent(token)}`);
// App khởi động lại → instanceId đổi → tự reload để nạp phiên/overlay mới, khỏi vào OBS bấm Reset.
// sessionStorage sống qua reload nên chỉ reload đúng 1 lần khi instance thật sự đổi (không lặp).
es.addEventListener('hello', event => {
  const iid = (JSON.parse(event.data || '{}') || {}).iid;
  if (!iid) return;
  const prev = sessionStorage.getItem('jarIid');
  sessionStorage.setItem('jarIid', iid);
  if (prev && prev !== iid) location.reload();
});
es.addEventListener('reload', () => location.reload());
es.addEventListener('config', event => {
  const next = normalizeConfig(JSON.parse(event.data || '{}'));
  const moved = next.height !== config.height || next.xPercent !== config.xPercent || next.yPercent !== config.yPercent;
  const themed = next.theme !== config.theme || next.visible !== config.visible;
  config = next;
  engine.gravity.y = config.gravity;
  if (moved || themed) positionJar();
});
es.addEventListener('gift', event => enqueueGift(JSON.parse(event.data || '{}')));
es.addEventListener('action', event => {
  if (!config.enabled) return;
  const data = JSON.parse(event.data || '{}');
  enqueueAction(data.type, data.count);
});
es.addEventListener('clear', () => {
  for (const b of bodies) Composite.remove(engine.world, b);
  bodies.length = 0;
  spawnQueue.length = 0;
  gifters.clear();
  topGifters = [];
  stats = { gifts: 0, diamonds: 0 };
});
