// Minimal electron mock so main.js can run headless under plain Node.
'use strict'
const { EventEmitter } = require('events')
const fs = require('fs')

const app = new EventEmitter()
app.getPath = (name) => (name === 'appData' ? (process.env.APPDATA || 'C:/Users/KDRNN/AppData/Roaming') : 'C:/none')
app.requestSingleInstanceLock = () => true
app.setAppUserModelId = () => {}
app.getVersion = () => '1.0.0-test'
app.isPackaged = false
app.setLoginItemSettings = () => {}
app.quit = () => { app.isQuitting = true }
app.exit = (c) => process.exit(c)
app.whenReady = () => Promise.resolve()

const ipcMain = { handlers: {}, handle(name, fn) { this.handlers[name] = fn }, on() {} }

class BrowserWindow {
  constructor() {
    this.webContents = { send: () => {}, on: () => {}, getURL: () => 'http://127.0.0.1:3080/', reload: () => {}, reloadIgnoringCache: () => {}, setWindowOpenHandler: () => {} }
    this.isMinimizedState = false
    this.hidden = false
    this.destroyed = false
  }
  loadFile() {}
  loadURL() {}
  once() {}
  on() {}
  hide() { this.hidden = true }
  show() { this.hidden = false }
  focus() {}
  minimize() { this.isMinimizedState = true }
  isMinimized() { return this.isMinimizedState }
  restore() { this.isMinimizedState = false }
  isDestroyed() { return this.destroyed }
  destroy() { this.destroyed = true }
  setAlwaysOnTop() {}
  setSkipTaskbar() {}
}

class Tray {
  constructor() {}
  setImage() {}
  setToolTip() {}
  setContextMenu() {}
  on() {}
}

const Menu = { buildFromTemplate: (t) => ({ items: t }) }
const shell = { openExternal: () => Promise.resolve() }
const screen = { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }) }
const nativeImage = {
  createFromPath: (p) => ({ isEmpty: () => !fs.existsSync(p), toPNG: () => Buffer.alloc(0) }),
  createEmpty: () => ({ isEmpty: () => true, addRepresentation: () => {}, toPNG: () => Buffer.alloc(0) }),
}

const powerSaveBlocker = {
  nextId: 1,
  started: new Set(),
  start() { const id = this.nextId++; this.started.add(id); return id },
  stop(id) { this.started.delete(id) },
  isStarted(id) { return this.started.has(id) },
}

module.exports = { app, BrowserWindow, Tray, Menu, ipcMain, shell, screen, nativeImage, powerSaveBlocker }
