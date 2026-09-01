// DeepSeek Harness Window — the standalone window application.
// A separate executable (own process, own taskbar entry, own icon) hosting
// the DSH web UI with browser-like behaviour:
//   - F5 / Ctrl+R / Ctrl+Shift+R reload
//   - Ctrl+W hides the window (app keeps running, tray re-shows it)
//   - right-click editing menu
//   - auto-paired quotes/brackets in inputs (dsh-preload.js)
//   - links/popups leaving the DSH origin open in the system default browser
// The tray app orchestrates it over a small loopback HTTP control plane:
//   GET /ping  -> { ok: true }             (alive probe)
//   GET /show  -> show & focus the window
//   POST /quit -> app.quit()
'use strict'

const { app, BrowserWindow, Menu, shell, WebContentsView } = require('electron')
const http = require('http')
const path = require('path')

const DSH_URL = 'http://127.0.0.1:3080'
const CTRL_PORT = 3490
const TITLEBAR_HEIGHT = 40

const isSmoke = process.argv.includes('--smoke')

let win = null
let loadFailed = false
let titleView = null
let currentTheme = 'dark'

function log(...args) {
  const line = `[${new Date().toISOString()}] [dsh-window] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`
  try {
    require('fs').appendFileSync(path.join(app.getPath('appData'), 'DSHTray', 'dsh-window.log'), line)
  } catch { /* ignore */ }
}

function isDshUrl(url) {
  if (!url) return false
  return url === 'about:blank' || url.startsWith(DSH_URL)
}

function createWindow() {
  if (win && !win.isDestroyed()) return win
  log('creating window at', DSH_URL)
  win = new BrowserWindow({
    width: 1340,
    height: 880 + TITLEBAR_HEIGHT,
    minWidth: 720,
    minHeight: 480,
    title: 'DeepSeek Harness',
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#151517',
    icon: process.env.DSH_WINDOW_ICON || path.join(__dirname, 'window.ico'),
  })

  // Custom top bar: an extra row above the page; never takes DSH page space.
  titleView = new WebContentsView({ webPreferences: { contextIsolation: false, nodeIntegration: true } })
  win.contentView.addChildView(titleView)

  // DSH page view occupies the remaining area below the titlebar.
  const pageView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'dsh-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  win.contentView.addChildView(pageView)

  const resizeViews = () => {
    if (!win || win.isDestroyed()) return
    const b = win.getContentBounds()
    titleView.setBounds({ x: 0, y: 0, width: b.width, height: TITLEBAR_HEIGHT })
    pageView.setBounds({ x: 0, y: TITLEBAR_HEIGHT, width: b.width, height: Math.max(0, b.height - TITLEBAR_HEIGHT) })
  }
  resizeViews()
  win.on('resize', resizeViews)

  titleView.webContents.loadFile(path.join(__dirname, 'titlebar.html'), { query: { theme: currentTheme } })

  // Attach page-level behaviour to the DSH page view.
  const page = pageView.webContents
  page.on('did-finish-load', () => log('did-finish-load'))
  page.on('did-fail-load', (_e, code, desc) => { loadFailed = true; log('did-fail-load', code, desc) })
  page.on('preload-error', (_e, p, err) => log('PRELOAD-ERROR', p, err && err.message))

  page.on('before-input-event', (event, input) => {
    if (!input || input.type !== 'keyDown') return
    const key = String(input.key || '').toLowerCase()
    if (input.key === 'F5' || (input.control && key === 'r')) {
      event.preventDefault()
      log('reload (F5/Ctrl+R)')
      if (input.shift) page.reloadIgnoringCache()
      else page.reload()
    } else if (input.control && key === 'w') {
      event.preventDefault()
      log('hidden (Ctrl+W)')
      win.hide()
    }
  })

  page.on('context-menu', (_e, params) => {
    const template = []
    if (params.isEditable) {
      template.push(
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      )
    } else if (params.selectionText) {
      template.push({ role: 'copy', label: '复制' })
    }
    template.push({ type: 'separator' }, { role: 'reload', label: '刷新' })
    Menu.buildFromTemplate(template).popup({ window: win })
  })

  page.on('will-navigate', (event, url) => {
    if (isDshUrl(url)) return
    event.preventDefault()
    log('external navigation -> default browser:', url)
    shell.openExternal(url)
  })
  page.setWindowOpenHandler(({ url }) => {
    if (url && !isDshUrl(url)) {
      log('new-window request -> default browser:', url)
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  // Detect DSH theme changes from the page DOM and sync the custom titlebar.
  page.executeJavaScript(`
    (() => {
      const apply = () => {
        const dark = !!(document.body && document.body.hasAttribute('data-ds-dark-theme'))
        console.log('DSH_THEME:' + (dark ? 'dark' : 'light'))
      }
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', apply)
      } else {
        apply()
      }
      if (document.body) {
        const mo = new MutationObserver(apply)
        mo.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
      }
      return true
    })()
  `).catch(() => {})

  // Bridge page console -> main -> titlebar.
  page.on('console-message', (_e, _level, message) => {
    if (message && message.startsWith('DSH_THEME:')) {
      const dark = message.endsWith(':dark')
      applyTitleTheme(dark)
    }
  })

  page.loadURL(DSH_URL)
  win.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault()
      log('window closed -> hidden (kept for reuse)')
      win.hide()
    }
  })
  win.on('closed', () => { win = null; titleView = null })
  return win
}

function applyTitleTheme(dark) {
  currentTheme = dark ? 'dark' : 'light'
  log('titlebar theme ->', currentTheme)
  if (titleView && !titleView.webContents.isDestroyed()) {
    titleView.webContents.executeJavaScript(
      `window.setTitleTheme(${dark ? 'true' : 'false'})`
    ).catch(() => {})
  }
}

function showWindow() {
  const w = createWindow()
  if (loadFailed) {
    loadFailed = false
    log('reloading after previous failure')
    const views = w.contentView.children || []; if (views[1]) views[1].webContents.loadURL(DSH_URL)
  }
  if (w.isMinimized()) w.restore()
  w.show()
  w.focus()
}

function startControlServer() {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end('{"ok":true}')
      return
    }
    if (req.method === 'GET' && req.url === '/show') {
      showWindow()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
      return
    }
    if (req.method === 'POST' && req.url === '/quit') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
      app.isQuitting = true
      app.quit()
      return
    }
    res.writeHead(404)
    res.end()
  })
  server.on('error', (err) => log('control server error', err.message))
  server.listen(CTRL_PORT, '127.0.0.1', () => log('control endpoint listening on 127.0.0.1:' + CTRL_PORT))
}

function setupTitlebarIpc() {
  const { ipcMain } = require('electron')
  ipcMain.on('win-min', () => { if (win && !win.isDestroyed()) win.minimize() })
  ipcMain.on('win-max', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
    }
  })
  ipcMain.on('win-close', () => { if (win && !win.isDestroyed()) win.close() })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.setAppUserModelId('com.dsh.window')
  app.on('second-instance', () => showWindow())
  app.on('before-quit', () => { app.isQuitting = true })

  app.whenReady().then(() => {
    try { require('fs').mkdirSync(path.join(app.getPath('appData'), 'DSHTray'), { recursive: true }) } catch { /* ignore */ }
    log('=== DeepSeek Harness Window v' + app.getVersion(), isSmoke ? '(smoke mode)' : 'starting')
    setupTitlebarIpc()
    startControlServer()
    createWindow()
    if (isSmoke) {
      setTimeout(() => {
        log('smoke check done; exiting')
        app.exit(0)
      }, 9000)
    }
  })

  app.on('window-all-closed', () => {
    // keep running hidden so the tray can re-show the window
  })
}
