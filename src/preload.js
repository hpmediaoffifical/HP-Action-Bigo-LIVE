const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bigo', {
  settingsLoad: () => ipcRenderer.invoke('settings:load'),
  settingsSave: (d) => ipcRenderer.invoke('settings:save', d),
  mappingLoad: () => ipcRenderer.invoke('mapping:load'),
  mappingSave: (d) => ipcRenderer.invoke('mapping:save', d),
  effectsList: () => ipcRenderer.invoke('effects:list'),

  start: (opts) => ipcRenderer.invoke('bigo:start', opts),
  stop: () => ipcRenderer.invoke('bigo:stop'),
  testEvent: (type) => ipcRenderer.invoke('bigo:test-event', type),
  checkLive: (bigoId) => ipcRenderer.invoke('bigo:check-live', bigoId),

  embedStart: (opts) => ipcRenderer.invoke('embed:start', opts),
  embedStop: () => ipcRenderer.invoke('embed:stop'),
  embedShow: () => ipcRenderer.invoke('embed:show'),

  onEvent: (cb) => ipcRenderer.on('bigo:event', (_e, ev) => cb(ev)),
  onLog: (cb) => ipcRenderer.on('bigo:log', (_e, msg) => cb(msg)),
  onEmbedEvent: (cb) => ipcRenderer.on('embed:event', (_e, ev) => cb(ev)),
});
