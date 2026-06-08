'use strict';
/**
 * HP KEY adapter cho BIGO Action.
 * Thay backend Google Apps Script bang HP KEY (hpvn.media). GIU NGUYEN shape
 * { ok, data:{...} } ma renderer dang doc => khong phai sua renderer.
 * Da thong nhat 1 dang: bo tier/quota -> moi key hop le = full quyen.
 */
const core = require('./core');

async function licenseVerify(key) {
  const r = await core.activate(key);
  if (!r.ok) return { ok: false, error: core.errVi(r.error) };
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
