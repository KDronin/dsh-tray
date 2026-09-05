'use strict'

// Combined launcher for the DeepSeek Harness desktop suite.
// The same Electron runtime/app package is used by two executables:
//   DeepSeek Harness Tray.exe   -> tray/notifier/power manager
//   DeepSeek Harness Window.exe -> standalone DSH window
// The executable name selects which entry point runs.

const path = require('path')
const { app } = require('electron')

const exeName = path.basename(process.execPath || '')
const envMode = process.env.DSH_APP_MODE || ''
const isWindow = envMode === 'window' || /deepseek harness window/i.test(exeName)

// Keep single-instance locks and per-app storage separate.
app.setPath('userData', path.join(app.getPath('appData'), isWindow ? 'DeepSeek Harness Window' : 'DeepSeek Harness Tray'))

if (isWindow) {
  require('./window-main')
} else {
  require('./tray-main')
}
