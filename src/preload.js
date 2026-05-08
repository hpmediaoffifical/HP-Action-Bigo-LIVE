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
  effectsPickFiles: () => ipcRenderer.invoke('effects:pick-files'),
  effectsOpenFolder: () => ipcRenderer.invoke('effects:open-folder'),
  pickBgmFile: () => ipcRenderer.invoke('bgm:pick-file'),

  // Gift master catalog
  giftsMasterList: () => ipcRenderer.invoke('gifts:master-list'),
  giftsMasterRefresh: () => ipcRenderer.invoke('gifts:master-refresh'),
  giftsLookup: (q) => ipcRenderer.invoke('gifts:lookup', q),
  giftsIconsStatus: () => ipcRenderer.invoke('gifts:icons-status'),
  giftsDownloadIcons: () => ipcRenderer.invoke('gifts:download-icons'),
  giftsOnDownloadProgress: (cb) => ipcRenderer.on('gifts:download-progress', (_e, p) => cb(p)),
  giftsStartDrag: (typeid) => ipcRenderer.send('gifts:start-drag', typeid),

  // Popup gifts window
  popupOpenGifts: () => ipcRenderer.invoke('popup:open-gifts'),
  popupResetGifts: () => ipcRenderer.invoke('popup:reset-gifts'),

  // Popup queue window
  popupOpenQueue: () => ipcRenderer.invoke('popup:open-queue'),
  popupSendQueue: (item) => ipcRenderer.invoke('popup:queue-item', item),
  popupResetQueue: () => ipcRenderer.invoke('popup:reset-queue'),

  // Open external URL in default browser
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),

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
  onOverlayQueueEmpty: (cb) => ipcRenderer.on('overlay:queue-empty', () => cb()),
  onOverlayEffectEnded: (cb) => ipcRenderer.on('overlay:effect-ended', () => cb()),
});
