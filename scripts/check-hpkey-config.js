'use strict';

const cfg = require('../hpkey/config');
const publicKey = require('../hpkey/public-key');

const hmac = String(cfg.HMAC_SECRET || '');
const publicKeyB64 = String(publicKey || '');

const errors = [];

if (!hmac || hmac.indexOf('DAN_') === 0) {
  errors.push('Missing HPKEY_HMAC / hpkey/secret.local.js HMAC_SECRET.');
}

if (!publicKeyB64 || publicKeyB64.indexOf('DAN_') === 0) {
  errors.push('Missing hpkey/public-key.js PUBLIC_KEY_B64.');
}

if (errors.length) {
  console.error('[hpkey] Build blocked: HP KEY is not configured.');
  for (const error of errors) console.error('[hpkey] ' + error);
  process.exit(1);
}

console.log('[hpkey] Config OK.');
