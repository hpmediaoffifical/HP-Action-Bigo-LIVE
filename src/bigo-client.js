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
function newSeqid() { return crypto.randomUUID().replace(/-/g, ''); }

class BigoClient {
  constructor(opts) {
    this.host = HOSTS[opts.env || 'prod'];
    this.accessToken = opts.accessToken;
    this.gameId = opts.gameId;
    this.gameSess = opts.gameSess || newSeqid();
    this.openids = Array.isArray(opts.openids) ? opts.openids : [opts.openid].filter(Boolean);
    this.batch = opts.batch || 200;
    this.context = '';
    this.lastTs = nowMs();
    this.onEvent = opts.onEvent || (() => {});
    this.onLog = opts.onLog || (() => {});
    this._pollTimer = null;
    this._pingTimer = null;
    this._stopped = true;
  }

  baseUrl(path) { return `https://${this.host}${path}`; }

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
          this.onEvent({ ...d, _room_openid: room.openid });
        }
      }
    }
    return res;
  }

  async ping() {
    // /broom/ping yêu cầu signature header — nếu app chỉ dùng Bearer thì
    // có thể skip; phía backend Bigo sẽ reset session sau ~2 phút không ping.
    // TODO: triển khai ký HMAC nếu user cấp clientId + secret.
    return null;
  }

  async start() {
    if (!this.accessToken) throw new Error('Thiếu access_token');
    if (!this.gameId) throw new Error('Thiếu game_id');
    if (this.openids.length === 0) throw new Error('Thiếu openid streamer');
    this._stopped = false;
    this.onLog(`enable_danmu game_sess=${this.gameSess}`);
    await this.enableDanmu();
    this._loop();
    this._pingTimer = setInterval(() => {
      this.ping().catch(e => this.onLog(`ping error: ${e.message}`));
    }, 30_000);
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
