// DeepSeek Harness Tray — Electron main process
// A tray-only companion that launches/monitors the dsh web service,
// hosts a local notify endpoint for the DSH notifier plugin, shows a custom
// bottom-right popup when a task completes, and manages system power:
//   - keep the computer awake (including display/screensaver) while a task is running
//   - (optionally) sleep the computer after tasks complete and the user is away
//
// DSH installation & auto-update:
//   - dsh is installed into an app-owned directory (DSH_CLI_DIR) via pnpm,
//     NOT through `npx` — npm's on-demand install has proven unreliable here
//     (it can hang for minutes before downloading a single tarball), and an
//     unpinned `npx` command would re-resolve/redownload on every start.
//   - on every start the tray compares the installed version against the
//     latest published one (`pnpm view`); when a newer version exists it
//     shows a VISIBLE console window with the install progress, and only
//     starts the service after the update finished. When nothing new is
//     published the service starts hidden, straight from the cached install.
//   - pnpm (not npm) does the installs: its store/cache handling has been
//     reliable on this machine while npm's cache has repeatedly wedged.
'use strict'

const { app, BrowserWindow, Tray, Menu, ipcMain, shell, screen, nativeImage, powerSaveBlocker } = require('electron')
const http = require('http')
const https = require('https')
const { spawn, execFile } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const DSH_URL = 'http://127.0.0.1:3080'
const NOTIFY_PORT = 3489
const APP_NAME = 'DeepSeek Harness Tray'
const SLEEP_GRACE_MS = 10000 // popup time before the machine sleeps

const isSmoke = process.argv.includes('--smoke')
const isAutostart = process.argv.includes('--autostart')

const dataDir = path.join(app.getPath('appData'), 'DSHTray')
const settingsPath = path.join(dataDir, 'settings.json')
const logPath = path.join(dataDir, 'dshtray.log')

const DEFAULTS = {
  autostart: false,        // launch this app at Windows login
  autoLaunchDsh: true,     // start DSH automatically when this app is running and DSH is down
  autoOpenBrowser: true,   // open the browser when we start DSH ourselves
  notify: true,            // show task-complete popups
  notifyDuration: 8,       // seconds the popup stays
  keepAwake: true,         // block system sleep and display sleep while a task is running
  sleepAfterComplete: true,// sleep the computer after tasks finish and the user is away
  sleepIdleMinutes: 5,     // minutes of user inactivity required before auto-sleep
  autoApprovePermissions: false, // automatically allow permission requests
}

const state = {
  dshRunning: false,
  dshManaged: false,       // DSH process is managed by us (spawned or adopted)
  dshAdopted: false,       // managed DSH was started externally and adopted
  dshStarting: false,
  dshPid: null,
  dshCooldownUntil: 0,        // backoff after a failed spawn (respown-storm guard)
  adopting: false,
  openedBrowserFor: false,
  lastNotifyKey: '',
  lastNotifyAt: 0,
  runningSessions: new Set(), // session ids with an active task
  currentTaskTitle: null,     // title of the currently running/active task
  blockerId: null,            // powerSaveBlocker id while awake is forced
  sleepTimer: null,
  sleepPending: false,
}

let settings = null
let tray = null
let settingsWin = null
let notifyWin = null
let notifyTimer = null

const github = {
  loggedIn: false,
  login: null,
  name: null,
  avatarUrl: null,
}

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`
  try { fs.appendFileSync(logPath, line) } catch { /* ignore */ }
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, '')
    return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULTS }
  }
}

function saveSettings(next) {
  settings = { ...settings, ...next }
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
  } catch (err) {
    log('saveSettings error', err.message)
  }
  applyAutostart()
  updateKeepAwake()
  buildTrayMenu()
  broadcastStatus()
  return settings
}

// The portable exe unpacks itself into %TEMP%; PORTABLE_EXECUTABLE_FILE is the
// stable path the user actually runs, so autostart must register that one.
function realExe() {
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath
}

function applyAutostart() {
  if (!app.isPackaged) return
  try {
    app.setLoginItemSettings({ openAtLogin: !!settings.autostart, path: realExe(), args: ['--autostart'] })
    log('autostart =', settings.autostart, '->', realExe())
  } catch (err) {
    log('setLoginItemSettings error', err.message)
  }
}

// ---------- power management ----------

function updateKeepAwake() {
  const active = !!settings.keepAwake && state.runningSessions.size > 0
  if (active && state.blockerId === null) {
    try {
      state.blockerId = powerSaveBlocker.start('prevent-display-sleep')
      log('keep-awake ON (display sleep blocked; task running,', state.runningSessions.size, 'session(s))')
    } catch (err) {
      log('powerSaveBlocker start error', err.message)
    }
  } else if (!active && state.blockerId !== null) {
    try {
      if (powerSaveBlocker.isStarted(state.blockerId)) powerSaveBlocker.stop(state.blockerId)
    } catch { /* ignore */ }
    log('keep-awake OFF')
    state.blockerId = null
  }
}

// Query Windows "last user input" idle seconds via a tiny PowerShell one-liner.
function getIdleSeconds(cb) {
  const ps = "$sig='[DllImport(\"user32.dll\")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO p);'; " +
    "Add-Type -MemberDefinition ($sig + ' [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }') -Name U -Namespace W; " +
    '$l = New-Object W.U+LASTINPUTINFO; $l.cbSize = 8; [void][W.U]::GetLastInputInfo([ref]$l); [Environment]::TickCount - $l.dwTime'
  let done = false
  const finish = (v) => { if (!done) { done = true; cb(v) } }
  let child
  try {
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch (err) {
    finish(-1)
    return
  }
  const t = setTimeout(() => { try { child.kill() } catch { /* ignore */ }; finish(-1) }, 6000)
  let out = ''
  child.stdout.on('data', (c) => { out += c })
  child.on('error', () => { clearTimeout(t); finish(-1) })
  child.on('exit', () => {
    clearTimeout(t)
    const ms = parseInt(String(out).trim(), 10)
    finish(Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 1000) : -1)
  })
}

function maybeScheduleSleep() {
  if (!settings.sleepAfterComplete) {
    log('auto-sleep disabled by settings')
    return
  }
  if (state.runningSessions.size > 0) return
  if (state.sleepTimer) return
  log('tasks completed — checking user idle time for auto-sleep')
  getIdleSeconds((idle) => {
    if (idle < 0) { log('idle query failed; skipping auto-sleep'); return }
    const threshold = Math.max(1, settings.sleepIdleMinutes || 5) * 60
    log('user idle for', idle, 's (threshold', threshold, 's)')
    if (idle < threshold) { log('user is active; no auto-sleep'); return }
    state.sleepPending = true
    broadcastStatus()
    log('user away; scheduling auto-sleep in', SLEEP_GRACE_MS / 1000, 's')
    state.sleepTimer = setTimeout(() => {
      state.sleepTimer = null
      if (state.runningSessions.size > 0) {
        state.sleepPending = false
        log('new task started; auto-sleep cancelled')
        return
      }
      // Second confirmation: the user may have returned during the grace
      // period — re-check idle time right before sleeping.
      getIdleSeconds((idle2) => {
        if (!state.sleepPending) return
        state.sleepPending = false
        broadcastStatus()
        if (idle2 < 0) { log('re-check failed; auto-sleep cancelled'); return }
        log('re-check idle:', idle2, 's')
        if (idle2 < threshold) { log('user activity during grace period; auto-sleep cancelled'); return }
        log('sleeping the computer now (SetSuspendState)')
        try {
          spawn('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0'], { windowsHide: true, stdio: 'ignore' })
        } catch (err) {
          log('rundll32 error', err.message)
        }
      })
    }, SLEEP_GRACE_MS)
  })
}

function cancelPendingSleep() {
  if (state.sleepTimer) { clearTimeout(state.sleepTimer); state.sleepTimer = null }
  if (state.sleepPending) {
    state.sleepPending = false
    log('auto-sleep cancelled: a new task started')
  }
}

// ---------- DSH process management ----------

// dsh lives in an app-owned directory so updates are explicit and the launch
// is a direct `node bin.js` (no npx resolution, no npm on-demand install).
const DSH_CLI_DIR = path.join(app.getPath('appData'), 'DSHTray', 'dsh-cli')
const DSH_PKG_JSON = path.join(DSH_CLI_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
const DSH_BIN = path.join(DSH_CLI_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const DSH_RETRY_COOLDOWN_MS = 30000
const DSH_START_TIMEOUT_MS = 900000 // covers the first-run / update install window

function localDshVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(DSH_PKG_JSON, 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : ''
  } catch { return '' }
}

// Latest published version via pnpm (fast query; offline -> "no update").
function latestDshVersion(cb) {
  execFile('cmd.exe', ['/d', '/c', 'pnpm view @deepseek-ai/dsh version'], {
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  }, (err, stdout) => {
    if (err) { log('dsh version check failed:', err.message); cb('') ; return }
    cb(String(stdout || '').trim())
  })
}

// Show a visible console window with the update progress. pnpm reports the
// full download/extract output there, so the user can see what is happening
// instead of the machine silently churning. The window closes itself.
// The command goes through a temp .bat: Node's spawn quoting mangles inline
// quotes when they are nested inside a `cmd /c "..."` string, and a bat file
// carries them verbatim.
function updateDshVisible(version, done) {
  log('updating dsh to', version, '(visible window)')
  const bat = path.join(dataDir, 'update-dsh.bat')
  try {
    fs.writeFileSync(bat,
      `@echo off\r\n` +
      `title DeepSeek Harness - updating dsh to ${version}\r\n` +
      `pnpm --dir "${DSH_CLI_DIR}" add @deepseek-ai/dsh@${version}\r\n` +
      `echo.\r\n` +
      `echo Update finished. This window closes automatically.\r\n` +
      `timeout /t 5 /nobreak > nul\r\n`)
  } catch (err) {
    log('updateDshVisible write bat error', err.message)
    done(false)
    return
  }
  let child
  try {
    child = spawn('cmd.exe', ['/d', '/c', bat], {
      cwd: os.homedir(),
      windowsHide: false, // visible on purpose: the user asked to see updates
      stdio: 'inherit',
    })
  } catch (err) {
    log('updateDshVisible spawn error', err.message)
    done(false)
    return
  }
  child.on('exit', (code) => {
    log('dsh update child exited, code', code)
    done(code === 0)
  })
  child.on('error', (err) => {
    log('dsh update child error', err.message)
    done(false)
  })
}

function spawnDsh() {
  // Direct spawn of node with an argument array: Node quotes each argument
  // itself, so the (space-containing) bin path is passed correctly. Going
  // through `cmd /c "node \"...\""` corrupted the quotes (Node's escaping
  // clashes with cmd's quoting rules) and every start failed with
  // MODULE_NOT_FOUND. The child's output is captured to a log file so a
  // future failure is visible instead of silent.
  const childLogPath = path.join(dataDir, 'dsh-child.log')
  let childLog
  try {
    fs.appendFileSync(childLogPath, `\n--- ${new Date().toISOString()} start ---\n`)
    childLog = fs.openSync(childLogPath, 'a')
  } catch { childLog = -1 }
  const child = spawn('node', [DSH_BIN, 'web', '--no-open'], {
    cwd: os.homedir(),
    windowsHide: true,
    stdio: ['ignore', childLog >= 0 ? childLog : 'ignore', childLog >= 0 ? childLog : 'ignore'],
  })
  state.dshManaged = true
  state.dshAdopted = false
  state.dshPid = child.pid
  child.on('exit', (code) => {
    try { if (childLog >= 0) fs.closeSync(childLog) } catch { /* ignore */ }
    log('DSH child exited, code', code)
    if (state.dshPid === child.pid) state.dshPid = null
    state.dshManaged = false
    state.dshStarting = false
    state.dshRunning = false
    // A failed spawn must not immediately trigger another one: that is what
    // turned a single startup failure into a respawn storm. Back off briefly.
    if (code !== 0 && code !== null) state.dshCooldownUntil = Date.now() + DSH_RETRY_COOLDOWN_MS
    broadcastStatus()
    refreshTray()
  })
  child.on('error', (err) => {
    log('DSH child error', err.message)
    state.dshStarting = false
    state.dshCooldownUntil = Date.now() + DSH_RETRY_COOLDOWN_MS
  })
}

function startDsh() {
  if (state.dshStarting || state.dshRunning) return
  if (state.dshCooldownUntil && Date.now() < state.dshCooldownUntil) return
  state.dshStarting = true
  state.openedBrowserFor = false
  log('starting DSH (installed:', localDshVersion() || 'none', ')')
  // The update watch is deliberately fire-and-forget within the start: no
  // update check hits the registry synchronously; a slow/offline registry
  // just falls back to the installed version.
  latestDshVersion((latest) => {
    if (!state.dshStarting) return // stop/quit raced us
    const local = localDshVersion()
    if (latest && latest !== local) {
      log('dsh update available:', local || '(none)', '->', latest)
      updateDshVisible(latest, (ok) => {
        if (!ok) {
          log('dsh update failed; falling back to installed version')
        }
        if (state.dshStarting) spawnDsh()
        else state.dshStarting = false
      })
      return
    }
    if (!latest) log('dsh version check unavailable; using installed version')
    if (!local && !latest) {
      // Nothing installed and the registry is unreachable — nothing to run.
      log('dsh is not installed and the registry is unreachable')
      state.dshStarting = false
      state.dshCooldownUntil = Date.now() + DSH_RETRY_COOLDOWN_MS
      broadcastStatus()
      refreshTray()
      return
    }
    spawnDsh()
  })
  setTimeout(() => { if (state.dshStarting) { state.dshStarting = false; state.dshCooldownUntil = Date.now() + DSH_RETRY_COOLDOWN_MS; log('DSH start timed out after ' + DSH_START_TIMEOUT_MS / 1000 + 's (likely a version update in progress)') } }, DSH_START_TIMEOUT_MS)
  broadcastStatus()
  refreshTray()
}

function stopDsh() {
  if (!state.dshManaged || !state.dshPid) return false
  log('stopping DSH tree, pid', state.dshPid)
  try {
    spawn('taskkill', ['/pid', String(state.dshPid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  } catch (err) {
    log('taskkill error', err.message)
  }
  state.dshManaged = false
  state.dshPid = null
  return true
}

function restartDsh() {
  log('restarting DSH on user request')
  stopDsh()
  setTimeout(() => {
    if (!state.dshRunning) startDsh()
  }, 800)
}

// Find the PID of the process listening on the DSH web port (netstat parse).
function findDshPid(cb) {
  let child
  try {
    child = spawn('netstat.exe', ['-ano', '-p', 'tcp'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch (err) {
    cb(null)
    return
  }
  let done = false
  const finish = (v) => { if (!done) { done = true; clearTimeout(t); cb(v) } }
  const t = setTimeout(() => { try { child.kill() } catch { /* ignore */ }; finish(null) }, 8000)
  let out = ''
  child.stdout.on('data', (c) => { out += c })
  child.on('error', () => finish(null))
  child.on('exit', () => {
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/^TCP\s+\S+:3080\s+\S+\s+LISTENING\s+(\d+)/u)
      if (m) { finish(Number(m[1])); return }
    }
    finish(null)
  })
}

// Take over an already-running (externally started) DSH process: track its
// PID so stop/restart work and it follows the tray app's lifecycle.
function adoptRunningDsh() {
  if (state.dshManaged) return
  if (state.adopting) return
  state.adopting = true
  findDshPid((pid) => {
    state.adopting = false
    if (!pid) { log('adoption: no DSH listener found'); return }
    state.dshManaged = true
    state.dshAdopted = true
    state.dshPid = pid
    log('adopted running DSH process, pid', pid)
    broadcastStatus()
    refreshTray()
  })
}

// ---------- DSH health monitor ----------

function checkDsh() {
  const req = http.get(DSH_URL + '/', { timeout: 1500 }, (res) => {
    res.resume()
    const up = res.statusCode < 500
    if (!state.dshRunning && up) {
      log('DSH is up at', DSH_URL)
      adoptRunningDsh()
      if (state.dshManaged && settings.autoOpenBrowser && !state.openedBrowserFor) {
        state.openedBrowserFor = true
        log('opening DSH window')
        openDsh()
      }
    }
    state.dshRunning = up
    state.dshStarting = false
    afterStatusChange()
  })
  req.on('timeout', () => { req.destroy(); markDown() })
  req.on('error', () => markDown())
}

function markDown() {
  const was = state.dshRunning
  state.dshRunning = false
  if (was) log('DSH appears down')
  if (state.dshManaged && state.dshAdopted) {
    state.dshManaged = false
    state.dshPid = null
    state.dshAdopted = false
    log('adopted DSH process is gone')
  }
  afterStatusChange()
}

function afterStatusChange() {
  broadcastStatus()
  refreshTray()
  if (!state.dshRunning && settings && settings.autoLaunchDsh && !state.dshStarting) startDsh()
}

// ---------- notify HTTP endpoint (for the DSH plugin) ----------

function startNotifyServer() {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify(statusObject()))
      return
    }
    if (req.method === 'POST' && req.url === '/notify') {
      let body = ''
      req.on('data', (c) => {
        body += c
        if (body.length > 100000) req.destroy()
      })
      req.on('end', () => {
        let payload
        try { payload = JSON.parse(body) } catch { /* fallthrough */ }
        if (!payload || typeof payload !== 'object') {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end('{"ok":false}')
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"ok":true}')
        handleNotify(payload)
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  server.on('error', (err) => log('notify server error', err.message))
  server.listen(NOTIFY_PORT, '127.0.0.1', () => log('notify endpoint listening on 127.0.0.1:' + NOTIFY_PORT))
}

function forwardTaskTitle(title) {
  const body = JSON.stringify({ title: title || '' })
  try {
    const req = http.request({
      host: '127.0.0.1',
      port: 3490,
      path: '/title',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 800,
    }, (res) => { res.resume() })
    req.on('error', () => { /* ignore */ })
    req.on('timeout', () => req.destroy())
    req.end(body)
  } catch { /* ignore */ }
}

function handleNotify(payload) {
  const type = payload.type || 'task-complete'
  if (type === 'task-start') {
    const sid = payload.sessionId || 'unknown'
    state.runningSessions.add(sid)
    if (payload.title && typeof payload.title === 'string' && payload.title.trim()) {
      state.currentTaskTitle = payload.title.trim()
    }
    cancelPendingSleep()
    updateKeepAwake()
    log('task start:', sid, '|', state.currentTaskTitle || '(no title)')
    forwardTaskTitle(state.currentTaskTitle)
    broadcastStatus()
    refreshTray()
    return
  }
  if (type === 'approval') {
    if (settings.autoApprovePermissions) {
      log('auto-approving permission:', payload.id || '')
      sendPromptAnswer({ type: 'approval', id: payload.id, decision: 'allowed-once', answerPort: payload.answerPort || 3491 })
      return
    }
    log('showing prompt:', type, payload.id || '')
    showPrompt(payload)
    return
  }
  if (type === 'question') {
    log('showing prompt:', type, payload.id || '')
    showPrompt(payload)
    return
  }
  // task-complete (or legacy plain notify payload)
  const key = `${payload.sessionId || ''}|${payload.title || ''}|${payload.message || ''}`
  const now = Date.now()
  const isDup = state.lastNotifyKey === key && now - state.lastNotifyAt < 2000
  if (type === 'task-complete' || type === 'task-done') {
    const sid = payload.sessionId || ''
    if (sid) state.runningSessions.delete(sid)
    if (state.runningSessions.size === 0) {
      state.currentTaskTitle = null
      forwardTaskTitle('')
    }
    updateKeepAwake()
    maybeScheduleSleep()
    broadcastStatus()
    refreshTray()
    log('task complete:', sid || '(unknown)')
  }
  if (isDup) return
  state.lastNotifyKey = key
  state.lastNotifyAt = now
  if (!settings.notify) { log('notification suppressed (disabled):', payload.title || ''); return }
  log('showing notification:', payload.title || '')
  if (isSmoke) return
  showNotification(payload)
}

// ---------- GitHub account ----------

function dshHome() {
  const env = process.env.DSH_HOME
  return env && env.trim() ? env.trim() : path.join(os.homedir(), '.dsh')
}

function loadGithub() {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dataDir, 'github.json'), 'utf8'))
    if (data && typeof data.login === 'string' && data.login) {
      github.loggedIn = true
      github.login = data.login
      github.name = data.name || data.login
      github.avatarUrl = data.avatarUrl || null
      return
    }
  } catch { /* ignore */ }
  github.loggedIn = false
  github.login = null
  github.name = null
  github.avatarUrl = null
}

function githubApiGet(apiPath, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: 'api.github.com',
      path: apiPath,
      method: 'GET',
      headers: {
        'user-agent': 'dshtray',
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
      },
    }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => {
        if (res.statusCode !== 200) {
          let msg = ''
          try { msg = JSON.parse(body).message || '' } catch { /* ignore */ }
          reject(new Error(`GitHub 验证失败（HTTP ${res.statusCode}）${msg ? '：' + msg : ''}`))
          return
        }
        try { resolve(JSON.parse(body)) } catch { reject(new Error('GitHub 响应解析失败')) }
      })
      res.on('error', reject)
    })
    req.setTimeout(20000, () => req.destroy(new Error('GitHub 请求超时')))
    req.on('error', reject)
    req.end()
  })
}

function execAsync(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 30000 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(String(stdout).trim())
    })
  })
}

async function execGet(cmd, args) {
  try { return await execAsync(cmd, args) } catch { return '' }
}

async function saveGithub(token) {
  token = String(token || '').trim()
  if (!/^[A-Za-z0-9_]{20,}$/.test(token)) {
    throw new Error('访问令牌格式不正确（应为 ghp_ 或 github_pat_ 开头的长字符串）')
  }
  const user = await githubApiGet('/user', token)
  const login = user.login
  if (!login) throw new Error('GitHub 未返回账号信息')
  const info = {
    login,
    name: typeof user.name === 'string' && user.name ? user.name : login,
    avatarUrl: user.avatar_url || null,
    savedAt: new Date().toISOString(),
  }
  // 1. tray app record (display only — never stores the token)
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'github.json'), JSON.stringify(info, null, 2))
  // 2. DSH home record — dsh-github-login / dsh-plugin-hub compatible format
  fs.writeFileSync(path.join(dshHome(), 'github-auth.json'), JSON.stringify({ ...info, token }, null, 2))
  // 3. git credential store so DSH tool runs can push/commit directly
  try {
    await execAsync('git', ['config', '--global', 'credential.helper', 'store'])
    const credPath = path.join(os.homedir(), '.git-credentials')
    let cred = ''
    try { cred = fs.readFileSync(credPath, 'utf8') } catch { /* create fresh */ }
    const kept = cred.split(/\r?\n/).filter(Boolean).filter((l) => !/^https?:\/\/[^@\n]*@github\.com\/?$/.test(l))
    kept.push(`https://${login}:${token}@github.com`)
    fs.writeFileSync(credPath, kept.join('\n') + '\n')
    log('git credential store configured for GitHub user', login)
  } catch (err) {
    log('git credential setup skipped:', err && err.message)
  }
  github.loggedIn = true
  github.login = login
  github.name = info.name
  github.avatarUrl = info.avatarUrl
  broadcastStatus()
  log('github account saved:', login)
  return { login, name: info.name, avatarUrl: info.avatarUrl }
}

async function removeGithub() {
  try { fs.unlinkSync(path.join(dataDir, 'github.json')) } catch { /* ignore */ }
  try { fs.unlinkSync(path.join(dshHome(), 'github-auth.json')) } catch { /* ignore */ }
  try {
    const credPath = path.join(os.homedir(), '.git-credentials')
    const cred = fs.readFileSync(credPath, 'utf8')
    const kept = cred.split(/\r?\n/).filter(Boolean).filter((l) => !/^https?:\/\/[^@\n]*@github\.com\/?$/.test(l))
    fs.writeFileSync(credPath, kept.length ? kept.join('\n') + '\n' : '')
  } catch { /* ignore */ }
  github.loggedIn = false
  github.login = null
  github.name = null
  github.avatarUrl = null
  broadcastStatus()
  log('github account removed')
}

// ---------- DSH window application (separate process) ----------
//
// The Harness UI lives in a SEPARATE application (DeepSeek Harness Window)
// with its own process, taskbar entry and icon — not inside this tray app.
// The tray app orchestrates it over a loopback control plane:
//   GET  http://127.0.0.1:3490/ping   alive probe
//   GET  http://127.0.0.1:3490/show   show & focus the window
//   POST http://127.0.0.1:3490/quit   quit the window app

const WINDOW_CTRL = 'http://127.0.0.1:3490'

function windowAppExe() {
  const base = process.env.PORTABLE_EXECUTABLE_FILE || app.getPath('exe')
  return path.join(path.dirname(base), 'DeepSeek Harness Window.exe')
}

function windowAppPing(cb) {
  let done = false
  const finish = (v) => { if (!done) { done = true; cb(v) } }
  const req = http.get(WINDOW_CTRL + '/ping', { timeout: 800 }, (res) => {
    res.resume()
    finish(res.statusCode === 200)
  })
  req.on('timeout', () => { req.destroy(); finish(false) })
  req.on('error', () => finish(false))
}

function windowAppShow() {
  http.get(WINDOW_CTRL + '/show', (res) => { res.resume() }).on('error', () => { /* ignore */ })
}

function openDsh() {
  log('opening DSH window application')
  windowAppPing((alive) => {
    if (alive) {
      log('window app already running; showing it')
      windowAppShow()
      return
    }
    const exe = windowAppExe()
    if (!fs.existsSync(exe)) {
      log('window app executable not found:', exe)
      return
    }
    log('window app not running; spawning', exe)
    try {
      const child = spawn(exe, [], { windowsHide: false, detached: true, stdio: 'ignore' })
      child.on('error', (err) => log('window app spawn error', err.message))
      child.unref()
      // the app takes a moment to boot its control plane; retry /show
      let tries = 0
      const poll = setInterval(() => {
        tries += 1
        if (tries > 20) { clearInterval(poll); log('window app did not come up'); return }
        windowAppPing((up) => {
          if (up) {
            clearInterval(poll)
            log('window app is up; showing it')
            windowAppShow()
          }
        })
      }, 500)
    } catch (err) {
      log('window app spawn error', err.message)
    }
  })
}

function quitWindowApp() {
  try {
    const req = http.request(WINDOW_CTRL + '/quit', { method: 'POST', timeout: 2000 }, (res) => { res.resume() })
    req.on('error', () => { /* ignore */ })
    req.on('timeout', () => req.destroy())
    req.end()
  } catch { /* ignore */ }
}

// ---------- notification popup window ----------

function showNotification(payload) {
  if (notifyWin) notifyWin.destroy()
  const { workArea } = screen.getPrimaryDisplay()
  const W = 408
  const H = 140
  const x = workArea.x + workArea.width - W - 18
  const y = workArea.y + workArea.height - H - 18
  notifyWin = new BrowserWindow({
    width: W,
    height: H,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  attachDiagnostics(notifyWin, 'notify')
  notifyWin.setSkipTaskbar(true) // popups must never clutter the taskbar
  notifyWin.setAlwaysOnTop(true, 'screen-saver')
  notifyWin.loadFile(path.join(__dirname, 'ui', 'notify.html'), {
    query: {
      title: String(payload.title || '任务已完成'),
      message: String(payload.message || ''),
      ts: String(payload.ts || Date.now()),
    },
  })
  notifyWin.once('ready-to-show', () => {
    try { notifyWin.showInactive() } catch { /* ignore */ }
  })
  notifyWin.on('closed', () => { notifyWin = null })
  if (notifyTimer) clearTimeout(notifyTimer)
  const duration = Math.max(3, Number(settings.notifyDuration) || 8)
  notifyTimer = setTimeout(() => closeNotify(), duration * 1000)
}

function closeNotify() {
  if (notifyTimer) { clearTimeout(notifyTimer); notifyTimer = null }
  if (!notifyWin) return
  const w = notifyWin
  try { w.webContents.send('fade-out') } catch { /* ignore */ }
  setTimeout(() => { if (!w.isDestroyed()) w.destroy() }, 280)
}

// ---------- prompt popup (approval / user questions) ----------

let promptWin = null
let currentPrompt = null

function showPrompt(payload) {
  if (promptWin) {
    if (currentPrompt) {
      if (currentPrompt.type === 'approval') {
        sendPromptAnswer({ type: 'approval', id: currentPrompt.id, decision: 'cancelled', answerPort: currentPrompt.answerPort || 3491 })
      } else {
        sendPromptAnswer({ type: 'question', id: currentPrompt.id, cancelled: true, answerPort: currentPrompt.answerPort || 3491 })
      }
    }
    promptWin.destroy()
  }
  currentPrompt = payload
  const { workArea } = screen.getPrimaryDisplay()
  const W = 480
  const H = 340
  const x = workArea.x + workArea.width - W - 18
  const y = workArea.y + workArea.height - H - 18
  promptWin = new BrowserWindow({
    width: W,
    height: H,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  attachDiagnostics(promptWin, 'prompt')
  promptWin.setSkipTaskbar(true)
  promptWin.setAlwaysOnTop(true, 'screen-saver')
  promptWin.loadFile(path.join(__dirname, 'ui', 'prompt.html'), {
    query: { data: encodeURIComponent(JSON.stringify(payload)) },
  })
  promptWin.once('ready-to-show', () => {
    try { promptWin.showInactive() } catch { /* ignore */ }
  })
  promptWin.on('closed', () => {
    promptWin = null
    currentPrompt = null
  })
}

function sendPromptAnswer(answer) {
  const port = Number(answer.answerPort || 3491)
  const body = JSON.stringify(answer)
  const req = http.request({
    host: '127.0.0.1',
    port,
    path: '/answer',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
    timeout: 2000,
  }, (res) => { res.resume() })
  req.on('error', () => { /* ignore */ })
  req.on('timeout', () => req.destroy())
  req.end(body)
}

// ---------- settings window ----------

function showSettings() {
  if (settingsWin) {
    if (settingsWin.isMinimized()) settingsWin.restore()
    settingsWin.show()
    settingsWin.focus()
    return
  }
  settingsWin = new BrowserWindow({
    width: 800,
    height: 880,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: true,
    maximizable: false,
    skipTaskbar: false,
    show: false,
    icon: path.join(__dirname, 'assets', 'icon-256.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  attachDiagnostics(settingsWin, 'settings')
  settingsWin.loadFile(path.join(__dirname, 'ui', 'settings.html'))
  settingsWin.once('ready-to-show', () => settingsWin.show())
  settingsWin.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); settingsWin.hide() }
  })
  settingsWin.on('closed', () => { settingsWin = null })
}

// Renderer-side diagnostics: surface preload failures and JS errors in the
// app log so window issues are diagnosable instead of silently dead.
function attachDiagnostics(win, label) {
  const wc = win.webContents
  wc.on('did-finish-load', () => log(`[${label}] did-finish-load`))
  wc.on('did-fail-load', (_e, code, desc) => log(`[${label}] did-fail-load`, code, desc))
  wc.on('preload-error', (_e, p, error) => log(`[${label}] PRELOAD-ERROR`, p, error && error.message))
  wc.on('render-process-gone', (_e, details) => log(`[${label}] render-process-gone`, details && details.reason))
  wc.on('console-message', (...args) => {
    const ev = args[0]
    const message = (ev && typeof ev === 'object' && 'message' in ev) ? ev.message : args[2]
    const level = (ev && typeof ev === 'object' && 'level' in ev) ? ev.level : args[1]
    log(`[${label}:console]`, String(message))
  })
}

// ---------- tray ----------

function trayImage(kind) {
  const img = nativeImage.createEmpty()
  for (const [i, size] of [16, 32].entries()) {
    const file = path.join(__dirname, 'assets', `tray-${kind}-${size}.png`)
    try {
      const rep = nativeImage.createFromPath(file)
      if (!rep.isEmpty()) img.addRepresentation({ scaleFactor: i + 1, buffer: rep.toPNG() })
    } catch { /* ignore */ }
  }
  return img
}

function refreshTray() {
  if (!tray) return
  const kind = state.dshRunning ? 'run' : state.dshStarting ? 'start' : 'idle'
  tray.setImage(trayImage(kind))
  const busy = state.runningSessions.size > 0 ? ` · 任务进行中${state.blockerId !== null ? '（保持唤醒）' : ''}` : ''
  tray.setToolTip(`DeepSeek Harness · ${state.dshRunning ? '运行中' : state.dshStarting ? '正在启动…' : '未运行'}${busy}`)
}

function buildTrayMenu() {
  if (!tray) return
  const menu = Menu.buildFromTemplate([
    { label: '打开 DeepSeek Harness', click: () => openDsh() },
    { label: '设置', click: () => showSettings() },
    { type: 'separator' },
    {
      label: '任务完成通知',
      type: 'checkbox',
      checked: !!settings.notify,
      click: (item) => saveSettings({ notify: item.checked }),
    },
    {
      label: '任务进行中阻止休眠和熄屏',
      type: 'checkbox',
      checked: !!settings.keepAwake,
      click: (item) => saveSettings({ keepAwake: item.checked }),
    },
    {
      label: '任务完成后自动睡眠',
      type: 'checkbox',
      checked: !!settings.sleepAfterComplete,
      click: (item) => saveSettings({ sleepAfterComplete: item.checked }),
    },
    {
      label: 'Harness 未运行时自动启动',
      type: 'checkbox',
      checked: !!settings.autoLaunchDsh,
      click: (item) => saveSettings({ autoLaunchDsh: item.checked }),
    },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: !!settings.autostart,
      click: (item) => saveSettings({ autostart: item.checked }),
    },
    { type: 'separator' },
    {
      label: state.dshRunning ? 'Harness：运行中 · ' + DSH_URL : 'Harness：未运行',
      enabled: false,
    },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuitting = true; app.quit() } },
  ])
  tray.setContextMenu(menu)
}

function buildTray() {
  tray = new Tray(trayImage('idle'))
  tray.on('click', () => showSettings())
  tray.on('double-click', () => openDsh())
  buildTrayMenu()
  refreshTray()
}

// ---------- IPC ----------

function statusObject() {
  return {
    ok: true,
    dshRunning: state.dshRunning,
    dshManaged: state.dshManaged,
    dshAdopted: state.dshAdopted,
    dshStarting: state.dshStarting,
    url: DSH_URL,
    notifyPort: NOTIFY_PORT,
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    keepAwake: state.blockerId !== null,
    runningTasks: state.runningSessions.size,
    currentTaskTitle: state.currentTaskTitle,
    sleepPending: state.sleepPending,
  }
}

function broadcastStatus() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('status', statusObject())
  }
}

function registerIpc() {
  ipcMain.handle('get-settings', () => ({ ...settings, isPackaged: app.isPackaged }))
  ipcMain.handle('set-settings', (_e, patch) => {
    const p = { ...(patch || {}) }
    delete p.isPackaged
    return saveSettings(p)
  })
  ipcMain.handle('get-status', () => statusObject())
  ipcMain.handle('start-dsh', () => { if (!state.dshRunning) startDsh(); return statusObject() })
  ipcMain.handle('stop-dsh', () => { stopDsh(); return statusObject() })
  ipcMain.handle('open-web', () => { openDsh(); return statusObject() })
  ipcMain.handle('restart-dsh', () => { restartDsh(); return statusObject() })
  ipcMain.handle('min-settings', () => { if (settingsWin) settingsWin.minimize() })
  ipcMain.handle('github-state', () => ({ ...github }))
  ipcMain.handle('github-open-login', () => {
    log('opening GitHub login page')
    shell.openExternal('https://github.com/login')
    return { ...github }
  })
  ipcMain.handle('github-open-token', () => {
    const url = 'https://github.com/settings/tokens/new?scopes=repo,workflow&description=' + encodeURIComponent('DSH Harness Tray')
    log('opening GitHub token page')
    shell.openExternal(url)
    return { ...github }
  })
  ipcMain.handle('github-save', async (_e, token) => {
    try {
      return { ok: true, ...(await saveGithub(token)) }
    } catch (err) {
      log('github-save failed:', err && err.message)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('github-remove', async () => {
    await removeGithub()
    return { ok: true }
  })
  ipcMain.handle('test-notify', () => {
    showNotification({ title: '任务已完成（测试通知）', message: '这是一条来自 DeepSeek Harness Tray 的测试通知。', sessionId: 'test', ts: Date.now() })
  })
  ipcMain.handle('hide-settings', () => { if (settingsWin) settingsWin.hide() })
  ipcMain.handle('quit-app', () => { app.isQuitting = true; app.quit() })
  ipcMain.on('notify-view', () => { openDsh(); closeNotify() })
  ipcMain.on('notify-close', () => closeNotify())
  ipcMain.on('prompt-answer', (_e, answer) => {
    log('prompt answer:', answer && answer.type, answer && answer.id || '')
    if (promptWin) { try { promptWin.destroy() } catch { /* ignore */ } promptWin = null }
    currentPrompt = null
    sendPromptAnswer(answer)
  })
}

// ---------- app lifecycle ----------

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.setAppUserModelId('com.dsh.tray')
  app.on('second-instance', () => showSettings())
  app.on('before-quit', () => { app.isQuitting = true })
  app.on('will-quit', () => {
    if (state.blockerId !== null) {
      try { powerSaveBlocker.stop(state.blockerId) } catch { /* ignore */ }
      state.blockerId = null
    }
    // Managed DSH follows the tray app's lifecycle.
    if (state.dshManaged && state.dshPid) {
      log('quit: stopping managed DSH tree, pid', state.dshPid)
      try {
        const { execFileSync } = require('child_process')
        execFileSync('taskkill', ['/pid', String(state.dshPid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 })
      } catch (err) {
        log('quit: taskkill error', err && err.message)
      }
    }
    quitWindowApp()
  })

  app.whenReady().then(() => {
    settings = loadSettings()
    loadGithub()
    try { fs.mkdirSync(dataDir, { recursive: true }) } catch { /* ignore */ }
    log('===', APP_NAME, 'v' + app.getVersion(), 'starting', isSmoke ? '(smoke mode)' : isAutostart ? '(autostart)' : '(manual)')
    registerIpc()
    startNotifyServer()
    buildTray()
    applyAutostart()
    checkDsh()
    setInterval(checkDsh, 2500)
    // Manual launch: pop the settings window. Autostart / smoke: stay in tray.
    if (!isSmoke && !isAutostart) showSettings()
    if (isSmoke) {
      setTimeout(() => {
        log('smoke check done; exiting')
        app.exit(0)
      }, 15000)
    }
  })

  app.on('window-all-closed', () => {
    // tray app: keep running with no windows
  })
}
