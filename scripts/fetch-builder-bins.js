// Download electron-builder tool binaries from the official GitHub release
// CDN into the electron-builder cache. Node's https client (with retries and
// redirect following) works here even though app-builder's Go downloader
// timed out.
'use strict'
const https = require('https')
const fs = require('fs')
const path = require('path')
const os = require('os')

const cache = process.env.ELECTRON_BUILDER_CACHE || path.join(os.homedir(), 'AppData', 'Local', 'electron-builder', 'Cache')
const BASE = 'https://github.com/electron-userland/electron-builder-binaries/releases/download/'

const targets = [
  ['winCodeSign', 'winCodeSign-2.6.0', 'winCodeSign-2.6.0.7z'],
  ['nsis', 'nsis-3.0.4.1', 'nsis-3.0.4.1.7z'],
  ['nsis-resources', 'nsis-resources-3.4.1', 'nsis-resources-3.4.1.7z'],
]

function fetchUrl(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'dshtray-builder' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 8) {
        res.resume()
        resolve(fetchUrl(new URL(res.headers.location, url).href, redirects + 1))
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`HTTP ${res.statusCode} for ${url}`))
        return
      }
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.setTimeout(60000, () => req.destroy(new Error('timeout')))
    req.on('error', reject)
  })
}

async function withRetry(fn, tries = 8) {
  let lastErr
  for (let i = 0; i < tries; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      console.log(`  attempt ${i + 1} failed: ${err.message}`)
      await new Promise((r) => setTimeout(r, 3000))
    }
  }
  throw lastErr
}

;(async () => {
  for (const [name, version, file] of targets) {
    const dir = path.join(cache, name)
    fs.mkdirSync(dir, { recursive: true })
    const dest = path.join(dir, file)
    if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) {
      console.log(`SKIP ${file} (already cached, ${fs.statSync(dest).size} bytes)`)
      continue
    }
    const url = BASE + version + '/' + file
    try {
      const buf = await withRetry(() => fetchUrl(url))
      fs.writeFileSync(dest, buf)
      console.log(`OK  ${file}  ${buf.length} bytes -> ${dest}`)
    } catch (err) {
      console.log(`FAIL ${file}: ${err.message}`)
    }
  }
  console.log('done')
})()
