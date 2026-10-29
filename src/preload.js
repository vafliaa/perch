'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('perch', {
  init: () => ipcRenderer.invoke('app:init'),
  onState: (callback) => subscribe('state', callback),
  onConfig: (callback) => subscribe('config', callback),
  onLayout: (callback) => subscribe('layout', callback),
  onOpen: (callback) => subscribe('drawer:open', callback),
  onClosing: (callback) => subscribe('drawer:closing', callback),
  onPin: (callback) => subscribe('pin', callback),
  onStatusline: (callback) => subscribe('statusline', callback),
  open: (pin = false) => ipcRenderer.send('drawer:open', Boolean(pin)),
  close: (force = false) => ipcRenderer.send('drawer:close', Boolean(force)),
  setPinned: (value) => ipcRenderer.send('drawer:pin', Boolean(value)),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  setHeightLive: (pct) => ipcRenderer.send('panel:height-live', pct),
  commitHeight: (pct) => ipcRenderer.invoke('panel:height-commit', pct),
  refreshUsage: () => ipcRenderer.send('usage:refresh'),
  resumeSession: (sessionId) => ipcRenderer.invoke('session:resume', sessionId),
  openFolder: (target) => ipcRenderer.send('shell:open', target),
  dragBegin: () => ipcRenderer.send('window:drag-begin'),
  dragMove: (dx, dy) => ipcRenderer.send('window:drag-move', { dx: Number(dx) || 0, dy: Number(dy) || 0 }),
  dragEnd: () => ipcRenderer.send('window:drag-end'),
  resetPosition: () => ipcRenderer.invoke('window:reset-position'),
});
