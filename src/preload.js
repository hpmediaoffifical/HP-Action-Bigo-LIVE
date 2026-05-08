const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bigo', {
  // Settings
  settingsLoad: () => ipcRenderer.invoke('settings:load'),
  settingsSave: (d) => ipcRenderer.invoke('settings:save', d),

  // Mapping (v2 schema)
  mappingLoad: () => ipcRenderer.invoke('mapping:load'),
  mappingSave: (d) => ipcRenderer.invoke('mapping:save', d),

  // Effects directory
  effectsList: () => ipcRenderer.invoke('effects:list'),

  // Gift master catalog
  giftsMasterList: () => ipcRenderer.invoke('gifts:master-list'),
  giftsMasterRefresh: () => ipcRenderer.invoke('gifts:master-refresh'),
  giftsLookup: (q) => ipcRenderer.invoke('gifts:lookup', q),

  // Open API mode
  start: (opts) => ipcRenderer.invoke('bigo:start', opts),
  stop: () => ipcRenderer.invoke('bigo:stop'),
  testEvent: (type) => ipcRenderer.invoke('bigo:test-event', type),
  checkLive: (bigoId) => ipcRenderer.invoke('bigo:check-live', bigoId),

  // Web Embed listener
  embedStart: (opts) => ipcRenderer.invoke('embed:start', opts),
  embedStop: () => ipcRenderer.invoke('embed:stop'),
  embedShow: () => ipcRenderer.invoke('embed:show'),

  // Overlays
  overlayShow: (overlayId) => ipcRenderer.invoke('overlay:show', overlayId),
  overlayHide: (overlayId) => ipcRenderer.invoke('overlay:hide', overlayId),
  overlayApplyConfig: (cfg) => ipcRenderer.invoke('overlay:apply-config', cfg),
  overlayDelete: (overlayId) => ipcRenderer.invoke('overlay:delete', overlayId),
  overlayPlay: (opts) => ipcRenderer.invoke('overlay:play', opts),

  // Event subscriptions
  onEvent: (cb) => ipcRenderer.on('bigo:event', (_e, ev) => cb(ev)),
  onLog: (cb) => ipcRenderer.on('bigo:log', (_e, msg) => cb(msg)),
  onEmbedEvent: (cb) => ipcRenderer.on('embed:event', (_e, ev) => cb(ev)),
});
