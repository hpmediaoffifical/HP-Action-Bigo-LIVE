const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.gif': 'image/gif', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
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
    if (this.server) { try { this.server.close(); } catch {} }
    this.server = null;
  }

  getUrl(overlayId) {
    return `http://127.0.0.1:${this.port}/overlay/${encodeURIComponent(overlayId)}?token=${encodeURIComponent(this.token)}`;
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
    if (req.method === 'GET' && reqUrl.pathname === '/overlay.css') return this._serveFile(path.join(this.root, 'renderer', 'overlay.css'), res);
    if (!this._okToken(reqUrl)) return this._reject(res, 401, 'bad token');

    if (req.method === 'GET' && reqUrl.pathname.startsWith('/overlay/')) return this._serveOverlay(reqUrl, res);
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
