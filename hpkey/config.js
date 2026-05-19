'use strict';
/**
 * HP KEY - Cau hinh client cho game BIGO.
 * HMAC secret KHONG hardcode o day (tranh lo khi push public repo).
 * No nam o hpkey/secret.local.js (da .gitignore) - tao file do tren may build.
 */
let local = {};
try { local = require('./secret.local'); } catch (_) {}

module.exports = {
  API_URL: 'https://hpvn.media/hpkey/api.php',
  PRODUCT: 'hp-bigo-live',
  HMAC_SECRET: local.HMAC_SECRET || process.env.HPKEY_HMAC || '',
  HEARTBEAT_HOURS: 24,
  // Chu ky check key real-time (giay). Cam key tren admin -> user bi dong app trong <= so nay.
  RECHECK_SECONDS: 60,
};
