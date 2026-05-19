'use strict';
/**
 * HP KEY - Sinh van tay may (HWID), zero-dependency. Ket qua: sha256 hex 64 ky tu,
 * co dinh tren cung 1 may (bat buoc 64 hex - server yeu cau).
 */
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');

function run(cmd) {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 })
      .toString().trim();
  } catch (_) { return ''; }
}

function hwParts() {
  const parts = [];
  if (process.platform === 'win32') {
    const ps = (q) => run(`powershell -NoProfile -NonInteractive -Command "${q}"`);
    parts.push(ps('(Get-CimInstance Win32_ComputerSystemProduct).UUID'));
    parts.push(ps('(Get-CimInstance Win32_Processor | Select-Object -First 1).ProcessorId'));
    parts.push(ps('(Get-CimInstance Win32_BaseBoard | Select-Object -First 1).SerialNumber'));
  } else if (process.platform === 'darwin') {
    parts.push(run("ioreg -rd1 -c IOPlatformExpertDevice | awk -F'\"' '/IOPlatformUUID/{print $4}'"));
  } else {
    parts.push(run('cat /etc/machine-id 2>/dev/null'));
    parts.push(run('cat /sys/class/dmi/id/product_uuid 2>/dev/null'));
  }
  const macs = [];
  const ni = os.networkInterfaces();
  for (const name of Object.keys(ni)) {
    for (const a of ni[name] || []) {
      if (!a.internal && a.mac && a.mac !== '00:00:00:00:00:00') macs.push(a.mac);
    }
  }
  macs.sort();
  parts.push(macs[0] || '');
  parts.push(os.hostname());
  return parts.filter(Boolean).join('|');
}

let cached = null;
function getHWID() {
  if (cached) return cached;
  const raw = hwParts() || ('fallback|' + os.hostname() + '|' + os.arch());
  cached = crypto.createHash('sha256').update(raw).digest('hex');
  return cached;
}

module.exports = { getHWID };
