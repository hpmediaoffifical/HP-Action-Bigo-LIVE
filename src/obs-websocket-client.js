const { OBSWebSocket } = require('obs-websocket-js');

class ObsWebSocketClient {
  constructor({ host = '127.0.0.1', port = 4456, password = '', overlayPort }) {
    this.host = host;
    this.port = port;
    this.password = password;
    this.overlayPort = Number(overlayPort);
  }

  _isAppOverlayUrl(rawUrl) {
    try {
      const url = new URL(String(rawUrl || ''));
      const isLocalhost = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
      // Only effect overlays are safe to reset manually. Review, ranking and score
      // Browser Sources retain independent on-screen state and must not be touched.
      return isLocalhost && Number(url.port || 80) === this.overlayPort && url.pathname.startsWith('/overlay/');
    } catch {
      return false;
    }
  }

  async refreshAppBrowserSources() {
    const obs = new OBSWebSocket();
    const endpoint = `ws://${this.host}:${this.port}`;
    let connected = false;
    try {
      await obs.connect(endpoint, this.password || undefined);
      connected = true;
      const { inputs = [] } = await obs.call('GetInputList');
      let matched = 0;
      let refreshed = 0;

      for (const input of inputs) {
        if (input.inputKind !== 'browser_source') continue;
        const { inputSettings = {} } = await obs.call('GetInputSettings', { inputUuid: input.inputUuid });
        if (!this._isAppOverlayUrl(inputSettings.url)) continue;
        matched++;

        // This is the WebSocket equivalent of OBS's "Refresh cache of current page" button.
        await obs.call('PressInputPropertiesButton', {
          inputUuid: input.inputUuid,
          propertyName: 'refreshnocache',
        });
        refreshed++;
      }

      return { ok: true, matched, refreshed };
    } finally {
      if (connected) {
        try { await obs.disconnect(); } catch {}
      }
    }
  }
}

module.exports = { ObsWebSocketClient };
