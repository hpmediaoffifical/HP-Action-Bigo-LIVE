'use strict';
/**
 * HP KEY adapter cho BIGO Action.
 * Thay backend Google Apps Script bang HP KEY (hpvn.media). GIU NGUYEN shape
 * { ok, data:{...} } ma renderer dang doc => khong phai sua renderer.
 * Da thong nhat 1 dang: bo tier/quota -> moi key hop le = full quyen.
 */
const core = require('./core');

async function licenseVerify(key, action = 'verify') {
  const mode = String(action || 'verify').toLowerCase() === 'activate' ? 'activate' : 'verify';
  let r = mode === 'verify'
    ? await core.verifyKey(key)
    : await core.activate(key);
  // If a key is already bound to this machine, some backends reject activate
  // because the seat is full. Verify still confirms whether this HWID is allowed.
  if (!r.ok && mode === 'activate' && r.error === 'device_limit_reached') {
    const verify = await core.verifyKey(key);
    if (verify.ok) r = verify;
  }
  if (!r.ok) return { ok: false, error: core.errVi(r.error), errorCode: r.error, _offline: !!r._offline };
  const p = r.payload;
  return {
    ok: true,
    data: {
      TRANG_THAI: 'ACTIVE',
      TINH_NANG: p.r || 'ADMIN',                 // role ADMIN/VIP/CREATOR (thay cho tier)
      ALLOW_IDS: Array.isArray(p.ids) ? p.ids : [], // VIP: chỉ kết nối các BIGO ID này (rỗng = không giới hạn)
      HAN_SU_DUNG: p.exp ? new Date(p.exp * 1000).toISOString() : '', // '' = vĩnh viễn
      SL_QUA_TOI_DA: '∞',                        // đã bỏ giới hạn quà
      SL_QUA_DA_DUNG: 0,
      TEN_KH: '',
    },
  };
}

module.exports = { licenseVerify };
