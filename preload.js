'use strict'
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (patch) => ipcRenderer.invoke('set-settings', patch),
  getStatus: () => ipcRenderer.invoke('get-status'),
  startDsh: () => ipcRenderer.invoke('start-dsh'),
  restartDsh: () => ipcRenderer.invoke('restart-dsh'),
  stopDsh: () => ipcRenderer.invoke('stop-dsh'),
  openWeb: () => ipcRenderer.invoke('open-web'),
  minSettings: () => ipcRenderer.invoke('min-settings'),
  githubState: () => ipcRenderer.invoke('github-state'),
  githubOpenLogin: () => ipcRenderer.invoke('github-open-login'),
  githubOpenToken: () => ipcRenderer.invoke('github-open-token'),
  githubSave: (token) => ipcRenderer.invoke('github-save', token),
  githubRemove: () => ipcRenderer.invoke('github-remove'),
  testNotify: () => ipcRenderer.invoke('test-notify'),
  hideSettings: () => ipcRenderer.invoke('hide-settings'),
  quit: () => ipcRenderer.invoke('quit-app'),
  notifyView: () => ipcRenderer.send('notify-view'),
  notifyClose: () => ipcRenderer.send('notify-close'),
  onStatus: (cb) => ipcRenderer.on('status', (_e, s) => cb(s)),
  onFadeOut: (cb) => ipcRenderer.on('fade-out', () => cb()),
})
