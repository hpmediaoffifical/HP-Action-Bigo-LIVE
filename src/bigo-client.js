// Bigo Open API client — polling-based danmu/gift listener.
// Doc: https://github.com/yothen/Bigo-Open-Api/blob/main/danmu_data_api_cn.md
//
// Bigo KHÔNG có WebSocket/Webhook push — phải poll /broom/pull_data mỗi 2-5s
// và /broom/ping mỗi 30s để giữ session sống.

const crypto = require('crypto');

const HOSTS = {
  test: 'livelbs-test-pro.bigo.sg:1009',
  gray: 'gray-oauth.bigolive.tv',
  prod: 'oauth.bigolive.tv',
};

function nowMs() { return Date.now(); }
function nowSec() { return Math.floor(Date.now() / 1000); }
function newSeqid() { return crypto.randomUUID().replace(/-/g, ''); }

function compactJson(body) { return JSON.stringify(body || {}); }

class BigoClient {
  constructor(opts) {
    this.host = HOSTS[opts.env || 'prod'];
    this.accessToken = opts.accessToken;
    this.clientId = opts.clientId || '';
    this.privateKey = opts.privateKey || '';
    this.clientVersion = opts.clientVersion || '';
    this.gameId = opts.gameId;
    this.gameSess = opts.gameSess || newSeqid();
    this.openids = Array.isArray(opts.openids) ? opts.openids : [opts.openid].filter(Boolean);
    this.batch = opts.batch || 200;
    this.gameDuration = opts.gameDuration || 3600;
    this.startTime = nowMs();
    this.context = '';
    this.lastTs = nowMs();
    this.seenSeq = new Set();
    this.giftList = new Map();
    this.onEvent = opts.onEvent || (() => {});
    this.onLog = opts.onLog || (() => {});
    this._pollTimer = null;
    this._pingTimer = null;
    this._stopped = true;
  }

  baseUrl(path) { return `https://${this.host}${path}`; }

  _signHeaders(path, body) {
    if (!this.clientId || !this.privateKey) return null;
    const timestamp = nowSec();
    const payload = compactJson(body);
    const msg = `${payload}${path}${timestamp}`;
    const signature = crypto.createSign('RSA-SHA256').update(msg).end().sign(this.privateKey, 'base64');
    const headers = {
      'Content-Type': 'application/json',
      'bigo-client-id': this.clientId,
      'bigo-timestamp': String(timestamp),
      'bigo-oauth-signature': signature,
    };
    if (this.clientVersion) headers['bigo-client-version'] = this.clientVersion;
    return headers;
  }

  async _post(path, body) {
    const url = this.baseUrl(path);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${path}: ${text.slice(0, 200)}`);
    }
    return json;
  }

  async _postSigned(path, body) {
    const headers = this._signHeaders(path, body);
    if (!headers) throw new Error('Thiếu client_id hoặc RSA private key cho signed API');
    const res = await fetch(this.baseUrl(path), {
      method: 'POST',
      headers,
      body: compactJson(body),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${path}: ${text.slice(0, 200)}`);
    return json;
  }

  async enableDanmu(durationSeconds = 3600) {
    return this._post('/broom/enable_danmu', {
      seqid: newSeqid(),
      game_id: this.gameId,
      game_sess: this.gameSess,
      danmu_type: 0,
      game_users: this.openids,
      timestamp: nowMs(),
      game_duration: durationSeconds,
    });
  }

  async getGiftList() {
    const res = await this._post('/gift/get_list', {
      seqid: newSeqid(),
      game_id: this.gameId,
      timestamp: nowMs(),
    });
    const list = Array.isArray(res.list) ? res.list : [];
    this.giftList.clear();
    for (const g of list) {
      if (g.giftid != null) this.giftList.set(String(g.giftid), g);
    }
    this.onLog(`gift/get_list: ${list.length} gifts`);
    return res;
  }

  async disableDanmu(reason = 0) {
    return this._post('/broom/disable_danmu', {
      seqid: newSeqid(),
      game_id: this.gameId,
      game_sess: this.gameSess,
      timestamp: nowMs(),
      reason,
    });
  }

  async pullData() {
    const body = {
      seqid: newSeqid(),
      game_id: this.gameId,
      game_sess: this.gameSess,
      game_users: this.openids,
      timestamp: this.lastTs,
      batch: this.batch,
    };
    if (this.context) body.context = this.context;
    const res = await this._post('/broom/pull_data', body);
    if (res.context) this.context = res.context;
    if (Array.isArray(res.danmu_data)) {
      for (const room of res.danmu_data) {
        const datas = Array.isArray(room.datas) ? room.datas : [];
        for (const d of datas) {
          const ts = Number(d.ts || 0);
          if (ts > this.lastTs) this.lastTs = ts;
          if (d.data_seq) {
            if (this.seenSeq.has(d.data_seq)) continue;
            this.seenSeq.add(d.data_seq);
            if (this.seenSeq.size > 5000) this.seenSeq.clear();
          }
          this.onEvent(this.normalizeEvent(d, room.openid));
        }
      }
    }
    return res;
  }

  async ping() {
    return this._postSigned('/broom/ping', {
      seqid: newSeqid(),
      timestamp: nowMs(),
      game_users: this.openids,
      game_id: this.gameId,
      game_sess: this.gameSess,
      danmu_type: 0,
      game_duration: this.gameDuration,
      start_time: this.startTime,
    });
  }

  normalizeEvent(d, roomOpenid) {
    const ev = { ...d, _source: 'official-openapi', _room_openid: roomOpenid };
    if (ev.type === 'msg') ev.type = 'chat';
    ev.user_openid = d.user || '';
    ev.user = d.nick_name || d.user || 'BIGO user';
    ev.user_avatar_url = d.user_img || '';
    if (ev.type === 'gift') {
      const meta = this.giftList.get(String(d.gift_id));
      ev.gift_id = d.gift_id;
      ev.gift_name = d.gift_name || meta?.gift_name || String(d.gift_id || 'Gift');
      ev.gift_icon = d.gift_url || meta?.icon || '';
      ev.gift_icon_url = ev.gift_icon;
      ev.gift_value = d.gift_value ?? meta?.value ?? null;
      ev.gift_count = parseInt(d.gift_count, 10) || 1;
      ev.combo = 1;
      ev.total_count = ev.gift_count;
      if (ev.gift_value != null) ev.total_diamond = ev.gift_count * ev.gift_value;
    }
    if (ev.type === 'heart') ev.count = parseInt(d.count, 10) || 1;
    return ev;
  }

  async start() {
    if (!this.accessToken) throw new Error('Thiếu access_token');
    if (!this.gameId) throw new Error('Thiếu game_id');
    if (this.openids.length === 0) throw new Error('Thiếu openid streamer');
    this._stopped = false;
    this.onLog(`enable_danmu game_sess=${this.gameSess}`);
    await this.getGiftList().catch(e => this.onLog(`gift/get_list error: ${e.message}`));
    await this.enableDanmu(this.gameDuration);
    this._loop();
    if (this.clientId && this.privateKey) {
      this.ping().catch(e => this.onLog(`ping error: ${e.message}`));
      this._pingTimer = setInterval(() => {
        this.ping().catch(e => this.onLog(`ping error: ${e.message}`));
      }, 30_000);
    } else {
      this.onLog('ping disabled: thiếu client_id/RSA private key, session OpenAPI có thể hết hạn sau ~2 phút');
    }
  }

  async _loop() {
    while (!this._stopped) {
      try {
        await this.pullData();
      } catch (e) {
        this.onLog(`pull_data error: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  async stop() {
    this._stopped = true;
    if (this._pingTimer) clearInterval(this._pingTimer);
    try { await this.disableDanmu(); } catch (e) { this.onLog(`disable_danmu error: ${e.message}`); }
  }
}

module.exports = { BigoClient, HOSTS };
