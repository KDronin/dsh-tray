// Tiny static file server backing a local "mirror" of electron-builder
// binaries so the builder's Go downloader can fetch them from 127.0.0.1.
'use strict'
const http = require('http')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', 'builder-mirror')
const PORT = 8790

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0])
  const file = path.normalize(path.join(ROOT, rel))
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      console.log('404', rel)
      res.writeHead(404); res.end()
      return
    }
    console.log('200', rel, st.size)
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': st.size,
      'Accept-Ranges': 'bytes',
    })
    fs.createReadStream(file).pipe(res)
  })
})
server.listen(PORT, '127.0.0.1', () => console.log('mirror serving', ROOT, 'on', PORT))
