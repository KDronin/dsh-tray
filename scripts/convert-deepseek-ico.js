// Decode the user's deepseek.ico (a 225x225 PNG), upscale to 256x256 with
// bilinear filtering and re-emit a proper multi-size .ico for electron-builder.
'use strict'
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const SRC = 'C:/Users/KDRNN/Pictures/deepseek.ico'
const OUT = path.join(__dirname, '..', 'window-app', 'deepseek-256.ico')

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  return (c ^ -1) >>> 0
}
function chunk(type, data) {
  const t = Buffer.from(type, 'ascii')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
  return Buffer.concat([len, t, data, crc])
}
function encodePng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
function encodeIco(pngs) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(pngs.length, 4)
  let offset = 6 + 16 * pngs.length
  const dirs = pngs.map((p) => {
    const b = Buffer.alloc(16)
    b[0] = p.size >= 256 ? 0 : p.size
    b[1] = p.size >= 256 ? 0 : p.size
    b.writeUInt16LE(1, 4)
    b.writeUInt16LE(32, 6)
    b.writeUInt32LE(p.buf.length, 8)
    b.writeUInt32LE(offset, 12)
    offset += p.buf.length
    return b
  })
  return Buffer.concat([header, ...dirs, ...pngs.map((p) => p.buf)])
}

// ---- decode PNG ----
function decodePng(buf) {
  const sig = buf.slice(0, 8)
  if (sig.toString('hex') !== '89504e470d0a1a0a') throw new Error('not a PNG')
  let pos = 8
  let width = 0, height = 0, bitDepth = 0, colorType = 0
  const idats = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.slice(pos + 4, pos + 8).toString('ascii')
    const data = buf.slice(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
    } else if (type === 'IDAT') idats.push(data)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  if (colorType !== 6 || bitDepth !== 8) throw new Error(`unsupported PNG: colorType=${colorType} bitDepth=${bitDepth}`)
  const raw = zlib.inflateSync(Buffer.concat(idats))
  const stride = width * 4 + 1
  const out = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    const rowStart = y * stride
    const filter = raw[rowStart]
    for (let x = 0; x < width * 4; x++) {
      const i = rowStart + 1 + x
      const a = x >= 4 ? out[y * width * 4 + x - 4] : 0
      const b = y > 0 ? out[(y - 1) * width * 4 + x] : 0
      const c = y > 0 && x >= 4 ? out[(y - 1) * width * 4 + x - 4] : 0
      let v = raw[i]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += Math.floor((a + b) / 2)
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      out[y * width * 4 + x] = v & 0xff
    }
  }
  return { width, height, rgba: out }
}

// ---- bilinear upscale ----
function upscale(rgba, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4)
  const sx = sw / dw
  const sy = sh / dh
  for (let y = 0; y < dh; y++) {
    const fy = (y + 0.5) * sy - 0.5
    const y0 = Math.max(0, Math.floor(fy))
    const y1 = Math.min(sh - 1, y0 + 1)
    const wy = fy - y0
    for (let x = 0; x < dw; x++) {
      const fx = (x + 0.5) * sx - 0.5
      const x0 = Math.max(0, Math.floor(fx))
      const x1 = Math.min(sw - 1, x0 + 1)
      const wx = fx - x0
      const o = (y * dw + x) * 4
      for (let ch = 0; ch < 4; ch++) {
        const p00 = rgba[(y0 * sw + x0) * 4 + ch]
        const p10 = rgba[(y0 * sw + x1) * 4 + ch]
        const p01 = rgba[(y1 * sw + x0) * 4 + ch]
        const p11 = rgba[(y1 * sw + x1) * 4 + ch]
        const top = p00 + (p10 - p00) * wx
        const bot = p01 + (p11 - p01) * wx
        out[o + ch] = Math.round(top + (bot - top) * wy)
      }
    }
  }
  return out
}

// ---- decode ICO entry (BMP-in-ICO, 32bpp) ----
function decodeIcoBmp(ico, index) {
  const e = 6 + index * 16
  const off = ico.readUInt32LE(e + 12)
  const size = ico.readUInt32LE(e + 8)
  const data = ico.slice(off, off + size)
  const sig = data.slice(0, 8).toString('hex')
  if (sig === '89504e470d0a1a0a') return decodePng(data)
  // BITMAPINFOHEADER
  const biSize = data.readUInt32LE(0)
  const width = data.readUInt32LE(4)
  const heightRaw = data.readInt32LE(8)
  const bitCount = data.readUInt16LE(14)
  const height = Math.abs(heightRaw) / 2 // ICO: height field doubles (XOR + AND mask)
  console.log('BMP: biSize', biSize, 'width', width, 'heightRaw', heightRaw, 'bitCount', bitCount, '-> image', height)
  if (bitCount !== 32) throw new Error(`unsupported ICO bitCount=${bitCount}`)
  const rowStride = Math.ceil((width * bitCount) / 32) * 4 // BMP row padding to 32 bits
  const out = Buffer.alloc(width * height * 4)
  const p = biSize // pixel data start (32bpp: no palette)
  for (let y = 0; y < height; y++) {
    const srcRow = heightRaw > 0 ? height - 1 - y : y // positive height = bottom-up
    const srcStart = p + srcRow * rowStride
    for (let x = 0; x < width; x++) {
      const si = srcStart + x * 4
      const di = (y * width + x) * 4
      out[di] = data[si + 2] // BGR(A) -> RGBA
      out[di + 1] = data[si + 1]
      out[di + 2] = data[si]
      out[di + 3] = data[si + 3]
    }
  }
  return { width, height, rgba: out }
}

;(() => {
  const ico = fs.readFileSync(SRC)
  const { width, height, rgba } = decodeIcoBmp(ico, 0)
  console.log('decoded', width + 'x' + height)
  const big = upscale(rgba, width, height, 256, 256)
  const p256 = encodePng(256, 256, big)
  const small = upscale(rgba, width, height, 48, 48)
  const p48 = encodePng(48, 48, small)
  const tiny = upscale(rgba, width, height, 32, 32)
  const p32 = encodePng(32, 32, tiny)
  fs.writeFileSync(OUT, encodeIco([
    { size: 256, buf: p256 },
    { size: 48, buf: p48 },
    { size: 32, buf: p32 },
  ]))
  console.log('wrote', OUT, fs.statSync(OUT).size, 'bytes')
})()
