// Overlay thông tin quà kích hoạt hiệu ứng — hiện icon + tên (nền xám mờ) để user biết tặng quà nào.
const token = new URLSearchParams(location.search).get('token') || '';
const list = document.getElementById('list');

function iconUrl(item) {
  if (item.id != null) return `/gift-icon/${encodeURIComponent(item.id)}?token=${encodeURIComponent(token)}`;
  return item.img || '/logo-hp.png';
}

function render(items) {
  const arr = Array.isArray(items) ? items : [];
  list.innerHTML = arr.map(it => {
    const fallback = (it.img || '/logo-hp.png').replace(/"/g, '&quot;');
    // Tương thích payload cũ (name/effect) lẫn mới (lines).
    const lines = Array.isArray(it.lines) ? it.lines : [it.name, it.effect].filter(Boolean);
    const text = lines.map((ln, i) => `<div class="${i === 0 ? 'info-name' : 'info-fx'}">${escapeText(ln)}</div>`).join('');
    return `<div class="info-item">
      <img class="gift" src="${iconUrl(it)}" onerror="this.onerror=null;this.src='${fallback}'" alt="" />
      <div class="info-text">${text}</div>
    </div>`;
  }).join('');
}

function escapeText(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const es = new EventSource(`/jar-events?token=${encodeURIComponent(token)}`);
es.addEventListener('info', event => { try { render(JSON.parse(event.data || '[]')); } catch {} });
es.addEventListener('reload', () => location.reload());
// Tự reload khi app khởi động lại (instanceId đổi), giống overlay hũ.
es.addEventListener('hello', event => {
  const iid = (JSON.parse(event.data || '{}') || {}).iid;
  if (!iid) return;
  const prev = sessionStorage.getItem('jarInfoIid');
  sessionStorage.setItem('jarInfoIid', iid);
  if (prev && prev !== iid) location.reload();
});
