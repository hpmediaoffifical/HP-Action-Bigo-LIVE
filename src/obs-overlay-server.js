const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.gif': 'image/gif', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
};

class ObsOverlayServer {
  constructor({ root, port = 18181, token, onEffectEnded, onQueueEmpty, onLog }) {
    this.root = root;
    this.port = port;
    this.token = token || crypto.randomBytes(18).toString('hex');
    this.onEffectEnded = onEffectEnded || (() => {});
    this.onQueueEmpty = onQueueEmpty || (() => {});
    this.onLog = onLog || (() => {});
    this.server = null;
    this.clients = new Map(); // overlayId -> Set(res)
    this.gameplayClients = new Set();
    this.rankingClients = new Set();
    this.scoreClients = new Set();
    this.pkDuoClients = new Set();
    this.gameplayConfig = { items: [], orientation: 'horizontal', labelPosition: 'bottom', nameMode: 'marquee', cardBg: '#8d8d8d', cardOpacity: 86, textFont: 'Segoe UI', textColor: '#ffffff', uppercase: false, enlargeActive: false, activeScale: 140, centerLargest: false, grayInactive: false, keepScore: false, gridCols: 5, gridRows: 1, slots: [] };
    this.gameplayCounts = {};
    this.rankingState = {};
    this.scoreState = {};
    this.pkDuoState = {};
    this.media = new Map();   // mediaId -> absolute file path
  }

  async start() {
    if (this.server) return;
    this.server = http.createServer((req, res) => this._handle(req, res));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, '127.0.0.1', resolve);
    });
    this.onLog(`OBS overlay server: http://127.0.0.1:${this.port}`);
  }

  stop() {
    for (const set of this.clients.values()) {
      for (const res of set) { try { res.end(); } catch {} }
    }
    this.clients.clear();
    for (const res of this.gameplayClients) { try { res.end(); } catch {} }
    this.gameplayClients.clear();
    for (const res of this.rankingClients) { try { res.end(); } catch {} }
    this.rankingClients.clear();
    for (const res of this.scoreClients) { try { res.end(); } catch {} }
    this.scoreClients.clear();
    for (const res of this.pkDuoClients) { try { res.end(); } catch {} }
    this.pkDuoClients.clear();
    if (this.server) { try { this.server.close(); } catch {} }
    this.server = null;
  }

  getUrl(overlayId) {
    return `http://127.0.0.1:${this.port}/overlay/${encodeURIComponent(overlayId)}?token=${encodeURIComponent(this.token)}`;
  }

  getGameplayUrl() {
    return `http://127.0.0.1:${this.port}/gameplay?token=${encodeURIComponent(this.token)}`;
  }

  getScoreUrl() {
    return `http://127.0.0.1:${this.port}/score?token=${encodeURIComponent(this.token)}`;
  }

  getRankingUrl() {
    return `http://127.0.0.1:${this.port}/ranking?token=${encodeURIComponent(this.token)}`;
  }

  getRankingGridUrl() {
    return `http://127.0.0.1:${this.port}/ranking-grid?token=${encodeURIComponent(this.token)}`;
  }

  getPkDuoUrl() {
    return `http://127.0.0.1:${this.port}/pk-duo?token=${encodeURIComponent(this.token)}`;
  }

  setGameplayConfig(cfg) {
    this.gameplayConfig = cfg || { items: [], orientation: 'horizontal', labelPosition: 'bottom', nameMode: 'marquee', cardBg: '#8d8d8d', cardOpacity: 86, textFont: 'Segoe UI', textColor: '#ffffff', uppercase: false, enlargeActive: false, activeScale: 140, centerLargest: false, grayInactive: false, keepScore: false, gridCols: 5, gridRows: 1, slots: [] };
    this._sendGameplay('config', this.gameplayConfig);
  }

  sendGameplayEvent(ev) {
    this._sendGameplay('gift', ev || {});
  }

  sendGameplayCounts(counts) {
    this.gameplayCounts = counts || {};
    this._sendGameplay('counts', counts || {});
  }

  sendScoreState(state) {
    this.scoreState = state || {};
    this._sendScore('score', this.scoreState);
  }

  sendRankingState(state) {
    this.rankingState = state || {};
    this._sendRanking('ranking', this.rankingState);
  }

  sendPkDuoState(state) {
    this.pkDuoState = state || {};
    this._sendPkDuo('pkduo', this.pkDuoState);
  }

  hasClients(overlayId) {
    return (this.clients.get(overlayId)?.size || 0) > 0;
  }

  play(overlayId, absPath) {
    if (!this.hasClients(overlayId)) return false;
    const mediaId = crypto.randomBytes(12).toString('hex');
    this.media.set(mediaId, absPath);
    this._send(overlayId, 'play', {
      mediaId,
      mediaUrl: `/media/${mediaId}?token=${encodeURIComponent(this.token)}`,
      issuedAt: Date.now(),
    });
    return true;
  }

  stopOverlay(overlayId) {
    this._send(overlayId, 'stop', { issuedAt: Date.now() });
  }

  setSpeed(payload) {
    for (const overlayId of this.clients.keys()) this._send(overlayId, 'set-speed', payload);
  }

  _send(overlayId, event, data) {
    const set = this.clients.get(overlayId);
    if (!set || set.size === 0) return;
    const body = `event: ${event}\ndata: ${JSON.stringify({ overlayId, ...data })}\n\n`;
    for (const res of set) { try { res.write(body); } catch {} }
  }

  _sendGameplay(event, data) {
    const body = `event: ${event}\ndata: ${JSON.stringify(data || {})}\n\n`;
    for (const res of this.gameplayClients) { try { res.write(body); } catch {} }
  }

  _sendScore(event, data) {
    const body = `event: ${event}\ndata: ${JSON.stringify(data || {})}\n\n`;
    for (const res of this.scoreClients) { try { res.write(body); } catch {} }
  }

  _sendRanking(event, data) {
    const body = `event: ${event}\ndata: ${JSON.stringify(data || {})}\n\n`;
    for (const res of this.rankingClients) { try { res.write(body); } catch {} }
  }

  _sendPkDuo(event, data) {
    const body = `event: ${event}\ndata: ${JSON.stringify(data || {})}\n\n`;
    for (const res of this.pkDuoClients) { try { res.write(body); } catch {} }
  }

  _okToken(reqUrl) {
    return reqUrl.searchParams.get('token') === this.token;
  }

  _reject(res, code, msg) {
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(msg || String(code));
  }

  _handle(req, res) {
    const reqUrl = new URL(req.url, `http://127.0.0.1:${this.port}`);
    const remote = req.socket.remoteAddress || '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return this._reject(res, 403, 'localhost only');
    if (req.method === 'GET' && reqUrl.pathname === '/obs-overlay.js') return this._serveFile(path.join(this.root, 'renderer', 'obs-overlay.js'), res);
    if (req.method === 'GET' && reqUrl.pathname === '/gameplay-overlay.js') return this._serveFile(path.join(this.root, 'renderer', 'gameplay-overlay.js'), res);
    if (req.method === 'GET' && reqUrl.pathname === '/ranking-overlay.js') return this._serveFile(path.join(this.root, 'renderer', 'ranking-overlay.js'), res);
    if (req.method === 'GET' && reqUrl.pathname === '/ranking-overlay.css') return this._serveFile(path.join(this.root, 'renderer', 'ranking-overlay.css'), res);
    if (req.method === 'GET' && reqUrl.pathname === '/ranking-grid-overlay.js') return this._serveFile(path.join(this.root, 'renderer', 'ranking-grid-overlay.js'), res);
    if (req.method === 'GET' && reqUrl.pathname === '/ranking-grid-overlay.css') return this._serveFile(path.join(this.root, 'renderer', 'ranking-grid-overlay.css'), res);
    if (req.method === 'GET' && reqUrl.pathname === '/pk-duo-overlay.js') return this._serveFile(path.join(this.root, 'renderer', 'pk-duo-overlay.js'), res);
    if (req.method === 'GET' && reqUrl.pathname === '/pk-duo-overlay.css') return this._serveFile(path.join(this.root, 'renderer', 'pk-duo-overlay.css'), res);
    if (req.method === 'GET' && reqUrl.pathname === '/pk-duo-arrow.svg') return this._serveFile(path.join(this.root, 'renderer', 'pk-duo-arrow.svg'), res);
    if (req.method === 'GET' && reqUrl.pathname === '/pk-duo-boost.svg') return this._serveFile(path.join(this.root, 'renderer', 'pk-duo-boost.svg'), res);
    if (req.method === 'GET' && reqUrl.pathname === '/pk-duo-neutral.svg') return this._serveFile(path.join(this.root, 'renderer', 'pk-duo-neutral.svg'), res);
    if (req.method === 'GET' && reqUrl.pathname === '/score-overlay.js') return this._serveFile(path.join(this.root, 'renderer', 'score-overlay.js'), res);
    if (req.method === 'GET' && reqUrl.pathname === '/score-overlay.css') return this._serveFile(path.join(this.root, 'renderer', 'score-overlay.css'), res);
    if (req.method === 'GET' && reqUrl.pathname === '/logo-hp.png') return this._serveFile(path.join(this.root, 'logo-hp.png'), res);
    if (req.method === 'GET' && reqUrl.pathname === '/favicon.ico') return this._serveFile(path.join(this.root, 'logo-hp.ico'), res);
    if (req.method === 'GET' && reqUrl.pathname === '/overlay.css') return this._serveFile(path.join(this.root, 'renderer', 'overlay.css'), res);
    if (!this._okToken(reqUrl)) return this._reject(res, 401, 'bad token');

    if (req.method === 'GET' && reqUrl.pathname.startsWith('/overlay/')) return this._serveOverlay(reqUrl, res);
    if (req.method === 'GET' && reqUrl.pathname === '/gameplay') return this._serveFile(path.join(this.root, 'renderer', 'gameplay-overlay.html'), res);
    if (req.method === 'GET' && reqUrl.pathname === '/gameplay-events') return this._serveGameplayEvents(req, res);
    if (req.method === 'GET' && reqUrl.pathname === '/ranking') return this._serveFile(path.join(this.root, 'renderer', 'ranking-overlay.html'), res);
    if (req.method === 'GET' && reqUrl.pathname === '/ranking-grid') return this._serveFile(path.join(this.root, 'renderer', 'ranking-grid-overlay.html'), res);
    if (req.method === 'GET' && reqUrl.pathname === '/ranking-events') return this._serveRankingEvents(req, res);
    if (req.method === 'GET' && reqUrl.pathname === '/pk-duo') return this._serveFile(path.join(this.root, 'renderer', 'pk-duo-overlay.html'), res);
    if (req.method === 'GET' && reqUrl.pathname === '/pk-duo-events') return this._servePkDuoEvents(req, res);
    if (req.method === 'GET' && reqUrl.pathname === '/score') return this._serveFile(path.join(this.root, 'renderer', 'score-overlay.html'), res);
    if (req.method === 'GET' && reqUrl.pathname === '/score-events') return this._serveScoreEvents(req, res);
    if (req.method === 'GET' && reqUrl.pathname.startsWith('/gift-icon/')) return this._serveGiftIcon(reqUrl, res);
    if (req.method === 'GET' && reqUrl.pathname.startsWith('/events/')) return this._serveEvents(reqUrl, req, res);
    if (req.method === 'GET' && reqUrl.pathname.startsWith('/media/')) return this._serveMedia(reqUrl, req, res);
    if (req.method === 'POST' && reqUrl.pathname.startsWith('/api/overlay/')) return this._handleEvent(reqUrl, req, res);
    return this._reject(res, 404, 'not found');
  }

  _serveOverlay(reqUrl, res) {
    this._serveFile(path.join(this.root, 'renderer', 'obs-overlay.html'), res);
  }

  _serveEvents(reqUrl, req, res) {
    const overlayId = decodeURIComponent(reqUrl.pathname.split('/')[2] || '');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: ready\ndata: ${JSON.stringify({ overlayId, ts: Date.now() })}\n\n`);
    if (!this.clients.has(overlayId)) this.clients.set(overlayId, new Set());
    this.clients.get(overlayId).add(res);
    req.on('close', () => this.clients.get(overlayId)?.delete(res));
  }

  _serveGameplayEvents(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: config\ndata: ${JSON.stringify(this.gameplayConfig)}\n\n`);
    res.write(`event: counts\ndata: ${JSON.stringify(this.gameplayCounts || {})}\n\n`);
    this.gameplayClients.add(res);
    req.on('close', () => this.gameplayClients.delete(res));
  }

  _serveScoreEvents(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: score\ndata: ${JSON.stringify(this.scoreState || {})}\n\n`);
    this.scoreClients.add(res);
    req.on('close', () => this.scoreClients.delete(res));
  }

  _serveRankingEvents(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: ranking\ndata: ${JSON.stringify(this.rankingState || {})}\n\n`);
    this.rankingClients.add(res);
    req.on('close', () => this.rankingClients.delete(res));
  }

  _servePkDuoEvents(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: pkduo\ndata: ${JSON.stringify(this.pkDuoState || {})}\n\n`);
    this.pkDuoClients.add(res);
    req.on('close', () => this.pkDuoClients.delete(res));
  }

  _serveFile(filePath, res) {
    if (!fs.existsSync(filePath)) return this._reject(res, 404, 'file not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(filePath).pipe(res);
  }

  _serveMedia(reqUrl, req, res) {
    const mediaId = decodeURIComponent(reqUrl.pathname.split('/')[2] || '');
    const filePath = this.media.get(mediaId);
    if (!filePath || !fs.existsSync(filePath)) return this._reject(res, 404, 'media not found');
    const stat = fs.statSync(filePath);
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      const start = m && m[1] ? parseInt(m[1], 10) : 0;
      const end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
      res.writeHead(206, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Cache-Control': 'no-store' });
      return fs.createReadStream(filePath, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': stat.size, 'Cache-Control': 'no-store' });
    fs.createReadStream(filePath).pipe(res);
  }

  _serveGiftIcon(reqUrl, res) {
    const typeid = decodeURIComponent(reqUrl.pathname.split('/')[2] || '');
    if (!/^\d+$/.test(typeid)) return this._reject(res, 404, 'icon not found');
    const filePath = path.join(this.root, 'assets', 'gift-icons', `${typeid}.png`);
    if (!fs.existsSync(filePath)) return this._reject(res, 404, 'icon not found');
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400, immutable', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(filePath).pipe(res);
  }

  _handleEvent(reqUrl, req, res) {
    const overlayId = decodeURIComponent(reqUrl.pathname.split('/')[3] || '');
    let raw = '';
    req.on('data', chunk => { raw += chunk; if (raw.length > 4096) req.destroy(); });
    req.on('end', () => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch {}
      if (body.type === 'effect-ended' || body.type === 'effect-error') this.onEffectEnded({ overlayId, ...body });
      if (body.type === 'queue-empty') this.onQueueEmpty({ overlayId, ...body });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end('{"ok":true}');
    });
  }
}

module.exports = { ObsOverlayServer };
