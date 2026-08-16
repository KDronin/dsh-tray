// Pure-Node icon generator: renders the DSHTray logo (rounded square,
// diagonal indigo gradient, cyan->violet rim, white lightning glyph) into
// PNG files for the app + tray, and wraps them into a Windows .ico.
import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(__dirname, '..', 'assets')
fs.mkdirSync(outDir, { recursive: true })

// ---------------- PNG encoder ----------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
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

// ---------------- scene primitives ----------------
const lerp = (a, b, t) => a + (b - a) * t
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
const vlerp = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]

function hex(c) {
  return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]
}
const C = {
  bgTop: hex('#26246e'),
  bgBottom: hex('#0c0e26'),
  cyan: hex('#22d3ee'),
  violet: hex('#a78bfa'),
  white: hex('#f2f4ff'),
  lightCyan: hex('#a5f3fc'),
  dark: hex('#0b0d1a'),
}

// rounded-rect signed distance (negative inside)
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r)
  const qy = Math.abs(py - cy) - (hh - r)
  const ax = Math.max(qx, 0)
  const ay = Math.max(qy, 0)
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r
}

// lightning bolt polygon (unit coords), point-in-polygon
const BOLT = [
  [0.700, 0.155], [0.405, 0.545], [0.545, 0.545],
  [0.300, 0.845], [0.605, 0.445], [0.465, 0.445],
]
function inBolt(x, y) {
  let inside = false
  for (let i = 0, j = BOLT.length - 1; i < BOLT.length; j = i++) {
    const [xi, yi] = BOLT[i]
    const [xj, yj] = BOLT[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

// render one icon at `size` px. opts: { dot: color | null, dotSize, margin }
function renderIcon(size, opts = {}) {
  const SS = 4 // supersampling
  const out = Buffer.alloc(size * size * 4)
  const s = size / 256
  const dot = opts.dot ? hex(opts.dot) : null
  const dotR = opts.dotSize ?? 13
  const dotCx = 256 - 30
  const dotCy = 256 - 30
  const rimW = Math.max(1.2, 3.4 * s)
  const { margin = 0 } = opts

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = (x + (sx + 0.5) / SS) / s
          const py = (y + (sy + 0.5) / SS) / s
          // background rounded square (256-unit scene)
          const half = 124 - margin * 4
          const d = sdRoundRect(px, py, 128, 128, half, half, 54)
          if (d <= 0) {
            // diagonal gradient
            const t = clamp01((px + py) / 512)
            let cr = lerp(C.bgTop[0], C.bgBottom[0], t)
            let cg = lerp(C.bgTop[1], C.bgBottom[1], t)
            let cb = lerp(C.bgTop[2], C.bgBottom[2], t)
            // rim stroke
            if (d > -rimW) {
              const ang = Math.atan2(py - 128, px - 128)
              const rt = (ang + Math.PI) / (2 * Math.PI)
              const rim = vlerp(C.cyan, C.violet, rt)
              const k = clamp01(1 - Math.abs(d + rimW / 2) / (rimW / 2))
              cr = lerp(cr, rim[0], k)
              cg = lerp(cg, rim[1], k)
              cb = lerp(cb, rim[2], k)
            }
            // bolt glyph (unit coords)
            if (inBolt(px / 256, py / 256)) {
              const bt = clamp01((py - 40) / 176)
              cr = lerp(C.white[0], C.lightCyan[0], bt)
              cg = lerp(C.white[1], C.lightCyan[1], bt)
              cb = lerp(C.white[2], C.lightCyan[2], bt)
            }
            r += cr; g += cg; b += cb; a += 255
          } else if (dot) {
            // status dot drawn near the bottom-right corner
            const dd = Math.hypot(px - dotCx, py - dotCy)
            if (dd <= dotR + 2.4) {
              let col = dot
              if (dd > dotR) {
                // outline ring
                const ringT = clamp01(1 - (dd - dotR) / 2.4)
                col = vlerp(C.dark, dot, ringT * 0.85)
              }
              r += col[0]; g += col[1]; b += col[2]; a += 255
            }
          }
        }
      }
      const n = SS * SS
      const o = (y * size + x) * 4
      out[o] = Math.round(r / n)
      out[o + 1] = Math.round(g / n)
      out[o + 2] = Math.round(b / n)
      out[o + 3] = Math.round(a / n)
    }
  }
  return out
}

function savePng(name, size, opts) {
  const buf = encodePng(size, size, renderIcon(size, opts))
  fs.writeFileSync(path.join(outDir, name), buf)
  console.log('wrote', name, size + 'x' + size, buf.length, 'bytes')
  return buf
}

// app icon sizes + ico
const p256 = savePng('icon-256.png', 256, { margin: 6 })
const p48 = savePng('icon-48.png', 48, { margin: 4 })
const p32 = savePng('icon-32.png', 32, { margin: 3 })
const p16 = savePng('icon-16.png', 16, { margin: 3 })
const ico = encodeIco([
  { size: 256, buf: p256 },
  { size: 48, buf: p48 },
  { size: 32, buf: p32 },
  { size: 16, buf: p16 },
])
fs.writeFileSync(path.join(outDir, 'icon.ico'), ico)
console.log('wrote icon.ico', ico.length, 'bytes')

// tray variants with status dots (16px for 100% DPI, 32px for HiDPI)
for (const [name, color] of [['run', '#34d399'], ['start', '#fbbf24'], ['idle', '#64748b']]) {
  savePng(`tray-${name}-16.png`, 16, { dot: color, dotSize: 13 })
  savePng(`tray-${name}-32.png`, 32, { dot: color, dotSize: 22 })
}
console.log('done')
