// Build the normal single-folder desktop suite:
//   1. electron-builder --win dir
//   2. rename the Electron binary to the shared runtime name
//   3. compile the tiny C launcher and install the two public entry points
// The output folder contains two <100KB exe launchers, one shared Electron
// runtime, and the usual Electron resource files.
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(import.meta.dirname, '..')
const outDir = process.argv[2] || 'dist-release'
const unpacked = path.join(root, outDir, 'win-unpacked')

process.chdir(root)
fs.rmSync(path.join(root, outDir), { recursive: true, force: true })

console.log(`> packaging into ${outDir}`)
execSync(`npx electron-builder --win dir -c.directories.output=${outDir}`, { stdio: 'inherit' })

const runtimeFrom = path.join(unpacked, 'DeepSeek Harness Tray.exe')
const runtimeTo = path.join(unpacked, 'DeepSeek Harness Runtime.exe')
if (fs.existsSync(runtimeFrom)) {
  fs.renameSync(runtimeFrom, runtimeTo)
}

const launcherDir = path.join(root, 'build-launchers')
fs.mkdirSync(launcherDir, { recursive: true })
const launcherExe = path.join(launcherDir, 'launcher.exe')
console.log('> compiling launcher')
execSync(`gcc -Os -s -o "${launcherExe}" "${path.join(root, 'scripts', 'launcher.c')}" -lshlwapi -mwindows`, { stdio: 'inherit' })

for (const name of ['DeepSeek Harness Tray.exe', 'DeepSeek Harness Window.exe']) {
  fs.copyFileSync(launcherExe, path.join(unpacked, name))
}

console.log('\nDONE')
console.log('  folder:', unpacked)
console.log('  entry : DeepSeek Harness Tray.exe (launcher)')
console.log('  entry : DeepSeek Harness Window.exe (launcher)')
console.log('  runtime: DeepSeek Harness Runtime.exe (shared Electron)')
