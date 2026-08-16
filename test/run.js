// Headless test: load main.js with a mocked electron, then exercise the
// notify endpoint, power management and IPC handlers in-process.
'use strict'
const Module = require('module')
const path = require('path')
const fs = require('fs')

process.env.APPDATA = path.join(__dirname, '.testdata')
// CRITICAL: redirect DSH_HOME too, or github-save/remove tests would touch
// the user's real ~/.dsh/github-auth.json and ~/.git-credentials.
process.env.DSH_HOME = path.join(__dirname, '.testdata', 'dsh-home')

// seed settings: power features on
fs.mkdirSync(path.join(process.env.APPDATA, 'DSHTray'), { recursive: true })
fs.writeFileSync(path.join(process.env.APPDATA, 'DSHTray', 'settings.json'), JSON.stringify({
  autostart: false,
  autoLaunchDsh: true,
  autoOpenBrowser: true,
  notify: true,
  notifyDuration: 8,
  keepAwake: true,
  sleepAfterComplete: true,
  sleepIdleMinutes: 5,
}, null, 2))

const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return path.join(__dirname, 'mock-electron.js')
  return origResolve.call(this, request, ...args)
}

require('../main.js')

const http = require('http')
const get = (url) => new Promise((resolve) => {
  http.get(url, (res) => {
    let b = ''
    res.on('data', (c) => { b += c })
    res.on('end', () => resolve({ code: res.statusCode, body: b }))
  }).on('error', (e) => resolve({ err: e.message }))
})
const post = (body) => new Promise((resolve) => {
  const data = JSON.stringify(body)
  const req = http.request({ host: '127.0.0.1', port: 3489, path: '/notify', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
    let b = ''
    res.on('data', (c) => { b += c })
    res.on('end', () => resolve({ code: res.statusCode, body: b }))
  })
  req.on('error', (e) => resolve({ err: e.message }))
  req.end(data)
})
const status = async () => JSON.parse((await get('http://127.0.0.1:3489/status')).body)

setTimeout(async () => {
  let s0 = await status()
  console.log('STATUS-INITIAL:', JSON.stringify({ keepAwake: s0.keepAwake, runningTasks: s0.runningTasks }))
  if (s0.keepAwake !== false || s0.runningTasks !== 0) { console.log('FAIL initial power state'); process.exit(1) }

  await post({ type: 'task-start', sessionId: 't1', ts: Date.now() })
  let s1 = await status()
  console.log('STATUS-TASK-START:', JSON.stringify({ keepAwake: s1.keepAwake, runningTasks: s1.runningTasks }))
  if (s1.keepAwake !== true || s1.runningTasks !== 1) { console.log('FAIL keep-awake did not engage'); process.exit(1) }

  // second task starts while first is running
  await post({ type: 'task-start', sessionId: 't2', ts: Date.now() })
  let s2 = await status()
  console.log('STATUS-TWO-TASKS:', JSON.stringify({ runningTasks: s2.runningTasks }))
  if (s2.runningTasks !== 2) { console.log('FAIL task counting'); process.exit(1) }

  await post({ type: 'task-complete', sessionId: 't1', title: '任务A', message: '完成', ts: Date.now() })
  let s3 = await status()
  console.log('STATUS-ONE-LEFT:', JSON.stringify({ keepAwake: s3.keepAwake, runningTasks: s3.runningTasks }))
  if (s3.keepAwake !== true || s3.runningTasks !== 1) { console.log('FAIL keep-awake released too early'); process.exit(1) }

  await post({ type: 'task-complete', sessionId: 't2', title: '任务B', message: '完成', ts: Date.now() })
  let s4 = await status()
  console.log('STATUS-ALL-DONE:', JSON.stringify({ keepAwake: s4.keepAwake, runningTasks: s4.runningTasks, sleepPending: s4.sleepPending }))
  if (s4.keepAwake !== false || s4.runningTasks !== 0) { console.log('FAIL keep-awake not released'); process.exit(1) }

  // settings IPC roundtrip
  const { ipcMain } = require('./mock-electron.js')
  const st = await ipcMain.handlers['get-settings']()
  console.log('SETTINGS:', JSON.stringify({ keepAwake: st.keepAwake, sleepAfterComplete: st.sleepAfterComplete, sleepIdleMinutes: st.sleepIdleMinutes, isPackaged: st.isPackaged }))
  await ipcMain.handlers['set-settings'](null, { sleepIdleMinutes: 12 })
  const st2 = await ipcMain.handlers['get-settings']()
  console.log('SETTINGS-AFTER:', JSON.stringify({ sleepIdleMinutes: st2.sleepIdleMinutes }))
  await ipcMain.handlers['set-settings'](null, { sleepIdleMinutes: 5 })

  // single DSH web window: repeated opens must reuse the one window
  await ipcMain.handlers['open-web']()
  await ipcMain.handlers['open-web']()
  await ipcMain.handlers['min-settings']() // no-op safety

  // github account flow (no real network: token fails format validation first)
  const g0 = await ipcMain.handlers['github-state']()
  console.log('GITHUB-INITIAL:', JSON.stringify(g0))
  const bad = await ipcMain.handlers['github-save'](null, 'short')
  console.log('GITHUB-BAD-TOKEN:', JSON.stringify(bad))
  await ipcMain.handlers['github-open-login']()
  await ipcMain.handlers['github-open-token']()
  await ipcMain.handlers['github-remove']()
  const g1 = await ipcMain.handlers['github-state']()
  console.log('GITHUB-AFTER-REMOVE:', JSON.stringify(g1))

  await new Promise((r) => setTimeout(r, 500))
  const log = fs.readFileSync(path.join(process.env.APPDATA, 'DSHTray', 'dshtray.log'), 'utf8')
  const createCount = (log.match(/creating DSH web window/g) || []).length
  const focusCount = (log.match(/focusing existing DSH tab/g) || []).length
  console.log('DSH-WINDOW: created=' + createCount + ' tabFocusLogs=' + focusCount + ' (expect 1/0)')
  if (createCount !== 1 || focusCount !== 0) { console.log('TEST FAILED: window reuse logic'); process.exit(1) }
  const lines = log.trim().split('\n')
  const tail = lines.slice(-10)
  console.log('LOG-TAIL:')
  tail.forEach((l) => console.log('  ' + l))
  const checks = {
    'keep-awake ON': log.includes('keep-awake ON'),
    'keep-awake OFF': log.includes('keep-awake OFF'),
    'sleep flow reached': log.includes('checking user idle time'),
    'notification shown': log.includes('showing notification: 任务A') || log.includes('showing notification: 任务B'),
  }
  for (const [k, v] of Object.entries(checks)) console.log(`CHECK ${k}: ${v ? 'PASS' : 'FAIL'}`)
  if (Object.values(checks).some((v) => !v)) { console.log('TEST FAILED'); process.exit(1) }
  console.log('TEST PASS')
  process.exit(0)
}, 1200)

setTimeout(() => { console.log('TEST TIMEOUT'); process.exit(1) }, 12000)
