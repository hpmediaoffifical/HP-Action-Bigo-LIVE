'use strict';
/**
 * HP KEY - Loi chung (zero-dependency): ky HMAC request + verify token RSA-SHA256.
 * Dung chung cho moi game HP Media. Khong sua file nay.
 */
const https = require('https');
const { URL } = require('url');
const os = require('os');
const crypto = require('crypto');

const cfg = require('./config');
const PUBLIC_KEY_B64 = require('./public-key');
const { getHWID } = require('./hwid');

const b64urlToBuf = (s) =>
  Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/* Canonical JSON khop PHP json_encode(UNESCAPED_UNICODE|UNESCAPED_SLASHES) */
function canonical(body) {
  const o = {};
  Object.keys(body).filter((k) => k !== 'sig').sort().forEach((k) => { o[k] = body[k]; });
  return JSON.stringify(o);
}
function signBody(body) {
  return crypto.createHmac('sha256', cfg.HMAC_SECRET).update(canonical(body)).digest('hex');
}

function apiCall(action, extra) {
  const body = Object.assign(
    { action, p: cfg.PRODUCT, ts: Math.floor(Date.now() / 1000) },
    extra || {}
  );
  body.sig = signBody(body);
  const data = JSON.stringify(body);
  const u = new URL(cfg.API_URL);

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        timeout: 12000,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try { resolve({ net: true, body: JSON.parse(raw) }); }
          catch (_) { resolve({ net: true, body: {} }); }
        });
      }
    );
    req.on('error', () => resolve({ net: false }));
    req.on('timeout', () => { req.destroy(); resolve({ net: false }); });
    req.write(data);
    req.end();
  });
}

function rsaPubKey() {
  return Buffer.from(PUBLIC_KEY_B64, 'base64').toString('utf8');
}

function verifyToken(token, hwid) {
  if (!token || token.indexOf('.') < 0) return null;
  const [msg, sig] = token.split('.');
  let okSig;
  try {
    okSig = crypto.verify('sha256', Buffer.from(msg), rsaPubKey(), b64urlToBuf(sig));
  } catch (_) { return null; }
  if (!okSig) return null;
  let p;
  try { p = JSON.parse(b64urlToBuf(msg).toString('utf8')); } catch (_) { return null; }
  if (p.v !== 1 || p.p !== cfg.PRODUCT || p.h !== hwid) return null;
  const now = Math.floor(Date.now() / 1000);
  return { payload: p, expired: p.exp !== 0 && now > p.exp };
}

/**
 * Kich hoat / xac thuc key. Tra ve:
 *   { ok:true, payload:{ k,p,h,pl,r,iat,exp,off } }
 *   { ok:false, error:<ma>, _offline?:bool }
 */
async function activate(rawKey) {
  const key = String(rawKey || '').trim();
  if (!key) return { ok: false, error: 'empty_key' };
  if (!cfg.HMAC_SECRET || cfg.HMAC_SECRET.indexOf('DAN_') === 0
      || PUBLIC_KEY_B64.indexOf('DAN_') === 0) {
    return { ok: false, error: 'not_configured' };
  }
  const hwid = getHWID();
  const r = await apiCall('activate', { key, hwid, device: os.hostname() });
  if (!r.net) return { ok: false, error: 'no_network', _offline: true };
  if (!r.body || r.body.ok !== true || !r.body.token) {
    return { ok: false, error: (r.body && r.body.error) || 'activate_failed' };
  }
  const v = verifyToken(r.body.token, hwid);
  if (!v) return { ok: false, error: 'bad_token' };
  if (v.expired) return { ok: false, error: 'key_expired' };
  return { ok: true, payload: v.payload };
}

const ERR_VI = {
  empty_key: 'Vui lòng nhập KEY bản quyền.',
  not_configured: 'App chưa cấu hình HP KEY (thiếu HMAC secret / public key) — liên hệ HP Media.',
  no_network: 'Không kết nối được hệ thống bản quyền — kiểm tra mạng và thử lại.',
  invalid_key: 'KEY không tồn tại trong hệ thống.',
  key_blocked: 'KEY đã bị khóa — liên hệ HP Media.',
  key_expired: 'KEY đã hết hạn.',
  device_limit_reached: 'KEY đã đạt giới hạn số máy — liên hệ HP Media để thêm/đổi máy.',
  device_revoked: 'Thiết bị này đã bị thu hồi quyền — liên hệ HP Media.',
  bad_signature: 'Cấu hình bản quyền sai (HMAC secret) — liên hệ HP Media.',
  unknown_product: 'Game chưa được cấu hình trên hệ thống bản quyền — liên hệ HP Media.',
  bad_token: 'Phản hồi kích hoạt không hợp lệ (sai chữ ký) — liên hệ HP Media.',
  activate_failed: 'KEY không hợp lệ.',
};
function errVi(code) { return ERR_VI[code] || ('Lỗi kích hoạt: ' + code); }

/** Check 1 lan (action 'verify' - cung dong vai tro heartbeat). */
async function verifyKey(rawKey) {
  const key = String(rawKey || '').trim();
  if (!key) return { ok: false, error: 'empty_key' };
  if (!cfg.HMAC_SECRET || PUBLIC_KEY_B64.indexOf('DAN_') === 0) {
    return { ok: false, error: 'not_configured' };
  }
  const hwid = getHWID();
  const r = await apiCall('verify', { key, hwid, device: os.hostname() });
  if (!r.net) return { ok: false, error: 'no_network', _offline: true };
  if (!r.body || r.body.ok !== true || !r.body.token) {
    return { ok: false, error: (r.body && r.body.error) || 'revoked' };
  }
  const v = verifyToken(r.body.token, hwid);
  if (!v) return { ok: false, error: 'bad_token' };
  if (v.expired) return { ok: false, error: 'key_expired' };
  return { ok: true, payload: v.payload };
}

/**
 * Watcher real-time: moi RECHECK_SECONDS goi server verify.
 * - Server tu choi ro rang (khoa/thu hoi/het han) -> onRevoked(reason) (de app tu dong).
 * - Mat mang -> BO QUA (con han offline trong token), khong da oan user.
 * getKey: () => string (key dang dung, lay luc chay vi co the kich hoat sau).
 * Tra ve ham stop().
 */
function startWatch(opts) {
  const getKey = opts.getKey;
  const onRevoked = opts.onRevoked;
  const sec = Math.max(15, Number(opts.intervalSec || cfg.RECHECK_SECONDS || 60));
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const key = (typeof getKey === 'function' ? getKey() : getKey) || '';
      if (!key) return;
      const r = await verifyKey(key);
      if (r.ok || r._offline) return;            // con hop le, hoac mat mang -> bo qua
      onRevoked(r.error || 'revoked');           // server tu choi -> kick
    } catch (_) { /* khong lam vo app */ }
    finally { busy = false; }
  }, sec * 1000);
  if (timer.unref) timer.unref();
  return function stop() { clearInterval(timer); };
}

module.exports = { activate, verifyKey, startWatch, errVi };
