const $ = (id) => document.getElementById(id);
const els = {
  status: $('status'), log: $('log'),
  // Open API tab
  env: $('env'), bigoId: $('bigoId'), openid: $('openid'),
  gameId: $('gameId'), accessToken: $('accessToken'),
  btnSave: $('btnSave'), btnStart: $('btnStart'), btnStop: $('btnStop'),
  events: $('events'),
  // Effects tab
  fxVideo: $('fxVideo'), fxAudio: $('fxAudio'), stageEmpty: $('stageEmpty'),
  mappingList: $('mappingList'), mapGiftId: $('mapGiftId'), mapFile: $('mapFile'),
  btnAddMap: $('btnAddMap'), btnReloadFx: $('btnReloadFx'),
  btnTestGift: $('btnTestGift'), btnTestHeart: $('btnTestHeart'), btnTestMsg: $('btnTestMsg'),
  // Embed tab
  embedBigoId: $('embedBigoId'), btnCheckLive: $('btnCheckLive'), liveInfo: $('liveInfo'),
  btnEmbedStart: $('btnEmbedStart'), btnEmbedStop: $('btnEmbedStop'),
  btnEmbedShow: $('btnEmbedShow'),
  metaPanel: $('metaPanel'), metaInfo: $('metaInfo'),
  liveChats: $('liveChats'), liveGifts: $('liveGifts'),
};

let mapping = { gifts: {}, hearts: null, msg: null };
let effects = [];

// ---- Tabs ----
document.querySelectorAll('.tab').forEach(t => {
  t.onclick = () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    document.querySelector(`.tab-panel[data-tab="${t.dataset.tab}"]`).classList.add('active');
  };
});

// ---- Init ----
async function init() {
  const s = await window.bigo.settingsLoad();
  els.env.value = s.env || 'prod';
  els.bigoId.value = s.bigoId || '';
  els.embedBigoId.value = s.bigoId || '';
  els.openid.value = s.openid || '';
  els.gameId.value = s.gameId || '';
  els.accessToken.value = s.accessToken || '';
  mapping = await window.bigo.mappingLoad();
  await reloadEffects();
  renderMapping();
}

async function reloadEffects() {
  effects = await window.bigo.effectsList();
  els.mapFile.innerHTML = effects.length
    ? effects.map(e => `<option value="${e.file}">${e.file}</option>`).join('')
    : '<option value="">(chưa có file trong assets/effects)</option>';
}

function renderMapping() {
  const rows = Object.entries(mapping.gifts || {}).map(([gid, file]) =>
    `<div class="map-row"><span>${escapeHtml(gid)} → ${escapeHtml(file)}</span><button data-gid="${escapeHtml(gid)}">xoá</button></div>`
  );
  els.mappingList.innerHTML = rows.join('') || '<div style="color:#555;padding:8px">chưa có mapping</div>';
  els.mappingList.querySelectorAll('button').forEach(b => {
    b.onclick = async () => {
      delete mapping.gifts[b.dataset.gid];
      await window.bigo.mappingSave(mapping);
      renderMapping();
    };
  });
}

function appendLog(msg) {
  const t = new Date().toLocaleTimeString();
  els.log.textContent = `[${t}] ${msg}\n` + els.log.textContent;
  if (els.log.textContent.length > 12000) els.log.textContent = els.log.textContent.slice(0, 12000);
}

function appendOpenApiEvent(ev) {
  const div = document.createElement('div');
  div.className = `event ${ev.type || 'msg'}`;
  let line = '';
  if (ev.type === 'gift') line = `🎁 [${ev.nick_name || ev.user}] ${ev.gift_name || ev.gift_id} ×${ev.gift_count || 1}`;
  else if (ev.type === 'heart') line = `❤ [${ev.nick_name || ev.user}] +${ev.count || 1}`;
  else if (ev.type === 'msg') line = `💬 [${ev.nick_name || ev.user}] ${ev.content || ''}`;
  else line = JSON.stringify(ev);
  div.textContent = `${new Date().toLocaleTimeString()} ${line}`;
  els.events.prepend(div);
  while (els.events.children.length > 200) els.events.lastChild.remove();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function playEffect(file) {
  if (!file) return;
  const path = `../assets/effects/${file}`;
  els.stageEmpty.style.display = 'none';
  if (/\.(mp4|webm)$/i.test(file)) { els.fxVideo.src = path; els.fxVideo.muted = false; els.fxVideo.play().catch(() => {}); }
  else if (/\.(mp3|wav|ogg)$/i.test(file)) { els.fxAudio.src = path; els.fxAudio.play().catch(() => {}); }
}

function handleOpenApiEvent(ev) {
  appendOpenApiEvent(ev);
  let file = null;
  if (ev.type === 'gift') file = mapping.gifts?.[String(ev.gift_id)] || mapping.gifts?.[ev.gift_name];
  else if (ev.type === 'heart') file = mapping.hearts;
  else if (ev.type === 'msg') file = mapping.msg;
  if (file) playEffect(file);
}

// ---- Embed parsed events ----
function renderParsed(ev) {
  if (ev.type === 'chat') {
    const div = document.createElement('div');
    div.className = 'chat-row';
    div.innerHTML = `<span class="lvl">Lv.${ev.level}</span><span class="who">${escapeHtml(ev.user)}</span><span class="what">${escapeHtml(ev.content)}</span>`;
    els.liveChats.prepend(div);
    while (els.liveChats.children.length > 200) els.liveChats.lastChild.remove();
    return;
  }
  if (ev.type === 'gift') {
    const div = document.createElement('div');
    div.className = 'gift-row';
    div.innerHTML = `<span class="lvl">Lv.${ev.level}</span><span class="who">${escapeHtml(ev.user)}</span><span>tặng</span><span class="what">${escapeHtml(ev.gift_name)}</span><span class="cnt">×${ev.gift_count}</span>`;
    els.liveGifts.prepend(div);
    while (els.liveGifts.children.length > 200) els.liveGifts.lastChild.remove();
    const file = mapping.gifts?.[ev.gift_name];
    if (file) playEffect(file);
    return;
  }
  if (ev.type === 'gift_overlay') {
    const div = document.createElement('div');
    div.className = 'gift-row';
    const iconHtml = ev.icon ? `<img class="icon" src="${ev.icon}" />` : '';
    div.innerHTML = `${iconHtml}<span class="who">${escapeHtml(ev.user)}</span><span>combo</span><span class="cnt">×${ev.gift_count} · ${ev.combo}</span>`;
    els.liveGifts.prepend(div);
    while (els.liveGifts.children.length > 200) els.liveGifts.lastChild.remove();
    return;
  }
}

function renderEmbedEvent(ev) {
  if (ev.kind === 'parsed') { renderParsed(ev); return; }
  if (ev.kind === 'meta') {
    els.metaPanel.style.display = 'block';
    const parts = [];
    if (ev.bigoId) parts.push(`<span><b>BIGO ID</b>: ${escapeHtml(ev.bigoId)}</span>`);
    if (ev.title) parts.push(`<span><b>Title</b>: ${escapeHtml(ev.title)}</span>`);
    els.metaInfo.innerHTML = parts.join('');
    return;
  }
  if (ev.kind === 'dom-attached' || ev.kind === 'ready') {
    appendLog(`embed ${ev.kind}: ${ev._frame || ev.url || ''}`);
    return;
  }
  if (ev.kind === 'scrape-error') appendLog(`scrape error: ${ev.msg}`);
}

// ---- Open API actions ----
els.btnSave.onclick = async () => {
  await window.bigo.settingsSave({
    env: els.env.value, bigoId: els.bigoId.value.trim(),
    openid: els.openid.value.trim(), gameId: els.gameId.value.trim(),
    accessToken: els.accessToken.value.trim(),
  });
  appendLog('settings saved');
};

els.btnStart.onclick = async () => {
  await els.btnSave.onclick();
  els.btnStart.disabled = true;
  els.status.textContent = 'connecting...';
  const res = await window.bigo.start({
    env: els.env.value, accessToken: els.accessToken.value.trim(),
    gameId: els.gameId.value.trim(), openid: els.openid.value.trim(),
  });
  if (res.ok) {
    els.status.textContent = `OAuth connected · sess=${res.gameSess.slice(0, 8)}`;
    els.status.classList.add('on');
    els.btnStop.disabled = false;
  } else {
    els.status.textContent = 'error';
    els.btnStart.disabled = false;
    appendLog(`start failed: ${res.error}`);
    alert(`Không kết nối được: ${res.error}`);
  }
};

els.btnStop.onclick = async () => {
  await window.bigo.stop();
  els.status.textContent = 'disconnected';
  els.status.classList.remove('on');
  els.btnStop.disabled = true;
  els.btnStart.disabled = false;
};

// ---- Effects test buttons ----
els.btnTestGift.onclick = () => window.bigo.testEvent('gift');
els.btnTestHeart.onclick = () => window.bigo.testEvent('heart');
els.btnTestMsg.onclick = () => window.bigo.testEvent('msg');
els.btnReloadFx.onclick = reloadEffects;

els.btnAddMap.onclick = async () => {
  const gid = els.mapGiftId.value.trim();
  const file = els.mapFile.value;
  if (!gid || !file) { alert('Nhập gift_name/gift_id và chọn file'); return; }
  mapping.gifts[gid] = file;
  await window.bigo.mappingSave(mapping);
  els.mapGiftId.value = '';
  renderMapping();
};

// ---- Embed actions ----
els.btnCheckLive.onclick = async () => {
  const id = els.embedBigoId.value.trim();
  if (!id) return;
  els.liveInfo.textContent = 'checking...';
  els.liveInfo.className = 'live-info';
  const res = await window.bigo.checkLive(id);
  if (!res.ok) {
    els.liveInfo.textContent = `Lỗi: ${res.error}`;
    els.liveInfo.classList.add('dead');
    return;
  }
  const d = res.data?.data || {};
  if (d.alive === 1) {
    els.liveInfo.classList.add('live');
    els.liveInfo.textContent = `🟢 LIVE — ${d.nick_name} · roomId=${d.roomId} · uid=${d.uid} · "${d.roomTopic || ''}"`;
  } else {
    els.liveInfo.classList.add('dead');
    els.liveInfo.textContent = `🔴 OFFLINE — ${d.nick_name || 'không tìm thấy'}`;
  }
};

els.btnEmbedStart.onclick = async () => {
  const id = els.embedBigoId.value.trim();
  if (!id) { alert('Nhập BIGO ID'); return; }
  const s = await window.bigo.settingsLoad();
  s.bigoId = id;
  await window.bigo.settingsSave(s);
  els.btnEmbedStart.disabled = true;
  els.status.textContent = 'embed connecting...';
  const res = await window.bigo.embedStart({ bigoId: id, visible: false });
  if (res.ok) {
    els.status.textContent = `listening · ${id}`;
    els.status.classList.add('on');
    els.btnEmbedStop.disabled = false;
    appendLog(`embed started for ${id}`);
  } else {
    els.btnEmbedStart.disabled = false;
    appendLog(`embed failed: ${res.error}`);
    alert(`Lỗi: ${res.error}`);
  }
};

els.btnEmbedStop.onclick = async () => {
  await window.bigo.embedStop();
  els.status.textContent = 'disconnected';
  els.status.classList.remove('on');
  els.btnEmbedStop.disabled = true;
  els.btnEmbedStart.disabled = false;
};

els.btnEmbedShow.onclick = () => window.bigo.embedShow();

window.bigo.onEvent(handleOpenApiEvent);
window.bigo.onLog(appendLog);
window.bigo.onEmbedEvent(renderEmbedEvent);

init();
