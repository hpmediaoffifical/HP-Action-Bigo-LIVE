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
  effectsExists: (mediaFile) => ipcRenderer.invoke('effects:exists', mediaFile),
  pickBgmFile: () => ipcRenderer.invoke('bgm:pick-file'),
  pickPreFxFile: () => ipcRenderer.invoke('preFx:pick-file'),

  // Config Export / Import
  configExport: () => ipcRenderer.invoke('config:export'),
  configImport: () => ipcRenderer.invoke('config:import'),

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
  popupGiftsSnapshot: (items) => ipcRenderer.invoke('popup:gifts-snapshot', items),
  onReceivedGiftsRemove: (cb) => ipcRenderer.on('received-gifts:remove', (_e, id) => cb(id)),
  onReceivedGiftsClearAll: (cb) => ipcRenderer.on('received-gifts:clear-all', () => cb()),
  onReceivedGiftsRequestSnapshot: (cb) => ipcRenderer.on('received-gifts:request-snapshot', () => cb()),

  // Popup queue window
  popupOpenQueue: () => ipcRenderer.invoke('popup:open-queue'),
  popupSendQueue: (item) => ipcRenderer.invoke('popup:queue-item', item),
  popupQueueSnapshot: (items) => ipcRenderer.invoke('popup:queue-snapshot', items),
  popupResetQueue: () => ipcRenderer.invoke('popup:reset-queue'),
  onQueueRemove: (cb) => ipcRenderer.on('queue:remove', (_e, id) => cb(id)),
  onQueueClearAll: (cb) => ipcRenderer.on('queue:clear-all', () => cb()),
  onQueueAction: (cb) => ipcRenderer.on('queue:action', (_e, payload) => cb(payload)),

  // Open external URL in default browser
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),

  // App info
  appGetVersion: () => ipcRenderer.invoke('app:get-version'),
  windowSizeLock: (locked) => ipcRenderer.invoke('app:window-size-lock', locked),

  // Auto-updater
  updaterCheck: () => ipcRenderer.invoke('updater:check'),
  updaterDownload: () => ipcRenderer.invoke('updater:download'),
  updaterState: () => ipcRenderer.invoke('updater:state'),
  onUpdaterStatus: (cb) => ipcRenderer.on('updater:status', (_e, payload) => cb(payload)),

  // Heart Goal overlay (vòng tròn progress)
  heartOverlayShow: () => ipcRenderer.invoke('heart-overlay:show'),
  heartOverlayHide: () => ipcRenderer.invoke('heart-overlay:hide'),
  heartOverlayUpdate: (payload) => ipcRenderer.invoke('heart-overlay:update', payload),

  // License (Google Apps Script)
  licenseMachineId: () => ipcRenderer.invoke('license:machine-id'),
  licenseVerify: (opts) => ipcRenderer.invoke('license:verify', opts),

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
  overlayNudge: (overlayId) => ipcRenderer.invoke('overlay:nudge', overlayId),
  overlayHide: (overlayId) => ipcRenderer.invoke('overlay:hide', overlayId),
  overlayApplyConfig: (cfg) => ipcRenderer.invoke('overlay:apply-config', cfg),
  overlayDelete: (overlayId) => ipcRenderer.invoke('overlay:delete', overlayId),
  overlayPlay: (opts) => ipcRenderer.invoke('overlay:play', opts),
  overlayStopEffect: (overlayId) => ipcRenderer.invoke('overlay:stop-effect', overlayId),
  overlaySetSpeed: (rate) => ipcRenderer.invoke('overlay:set-speed', rate),
  obsOverlayGetUrl: (overlayId) => ipcRenderer.invoke('obs-overlay:get-url', overlayId),
  obsOverlayCopyUrl: (overlayId) => ipcRenderer.invoke('obs-overlay:copy-url', overlayId),
  gameplayCopyUrl: () => ipcRenderer.invoke('gameplay:copy-url'),
  gameplayConfig: (cfg) => ipcRenderer.invoke('gameplay:config', cfg),
  gameplayCounts: (counts) => ipcRenderer.invoke('gameplay:counts', counts),
  gameplayEvent: (ev) => ipcRenderer.invoke('gameplay:event', ev),
  rankingCopyUrl: () => ipcRenderer.invoke('ranking:copy-url'),
  rankingGridCopyUrl: () => ipcRenderer.invoke('ranking:grid-copy-url'),
  rankingUpdate: (state) => ipcRenderer.invoke('ranking:update', state),
  pkDuoCopyUrl: () => ipcRenderer.invoke('pk-duo:copy-url'),
  pkDuoUpdate: (state) => ipcRenderer.invoke('pk-duo:update', state),
  scoreCopyUrl: () => ipcRenderer.invoke('score:copy-url'),
  scoreUpdate: (state) => ipcRenderer.invoke('score:update', state),

  // Popup chats (Tương tác)
  popupOpenChats: () => ipcRenderer.invoke('popup:open-chats'),
  popupChatsEvent: (ev) => ipcRenderer.invoke('popup:chats-event', ev),
  popupChatsReset: () => ipcRenderer.invoke('popup:chats-reset'),
  popupChatsSnapshot: (items) => ipcRenderer.invoke('popup:chats-snapshot', items),
  onChatsRequestSnapshot: (cb) => ipcRenderer.on('chats:request-snapshot', () => cb()),

  // Event subscriptions
  onEvent: (cb) => ipcRenderer.on('bigo:event', (_e, ev) => cb(ev)),
  onLog: (cb) => ipcRenderer.on('bigo:log', (_e, msg) => cb(msg)),
  onEmbedEvent: (cb) => ipcRenderer.on('embed:event', (_e, ev) => cb(ev)),
  onOverlayQueueEmpty: (cb) => ipcRenderer.on('overlay:queue-empty', () => cb()),
  onOverlayEffectEnded: (cb) => ipcRenderer.on('overlay:effect-ended', () => cb()),
  onWarnNoObs: (cb) => ipcRenderer.on('warn:no-obs', (_e, payload) => cb(payload)),
});
