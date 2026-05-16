const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const masterPath = path.join(root, 'config', 'gift-master.json');
const vnGiftsPath = path.join(root, 'config', 'vietnam-gifts.json');
const exportsDir = path.join(root, 'exports');
const outPath = path.join(exportsDir, 'bigo-gift-master-google-sheets.csv');

function rateToDiamonds(rate) {
  if (rate == null || rate === '') return '';
  const n = Number(rate);
  return Number.isFinite(n) ? Math.round(n / 100) : '';
}

function csvCell(value) {
  const s = String(value ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const master = JSON.parse(fs.readFileSync(masterPath, 'utf8'));
const vnGifts = fs.existsSync(vnGiftsPath) ? JSON.parse(fs.readFileSync(vnGiftsPath, 'utf8')) : { gifts: [] };
const vnTypeIds = new Set((Array.isArray(vnGifts.gifts) ? vnGifts.gifts : []).map(gift => Number(gift.typeid)).filter(Number.isFinite));
const gifts = Array.isArray(master.gifts) ? master.gifts : [];
const rows = [['ID QUÀ', 'TÊN QUÀ', 'ẢNH QUÀ', 'ĐƠN GIÁ KC', 'KHU VỰC']];

const sortedGifts = [...gifts].sort((a, b) => {
  const aVn = vnTypeIds.has(Number(a.typeid));
  const bVn = vnTypeIds.has(Number(b.typeid));
  return (bVn ? 1 : 0) - (aVn ? 1 : 0) || (Number(a.typeid) || 0) - (Number(b.typeid) || 0);
});

for (const gift of sortedGifts) {
  const isVn = vnTypeIds.has(Number(gift.typeid));
  rows.push([
    gift.typeid || '',
    gift.name || gift.gift_name || '',
    gift.img_url || gift.icon || '',
    rateToDiamonds(gift.vm_exchange_rate),
    isVn ? 'VN' : '',
  ]);
}

fs.mkdirSync(exportsDir, { recursive: true });
fs.writeFileSync(outPath, '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n'), 'utf8');

console.log(`Exported ${gifts.length} gifts (${vnTypeIds.size} VN) to ${outPath}`);
