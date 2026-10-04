// Generates the PWA icons: a dark tile with a grid of palette-coloured cells (the thing Beam actually sends).
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'

const PALETTE = [
  [0, 0, 0], [255, 59, 48], [52, 199, 89], [255, 204, 0],
  [10, 132, 255], [191, 90, 242], [90, 220, 250], [255, 255, 255],
]
const BG = [11, 11, 15]

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

function png(size, { maskable }) {
  const grid = 6
  const inner = size * (maskable ? 0.5 : 0.68) // maskable keeps content inside the safe zone
  const cell = Math.floor(inner / grid)
  const gap = Math.max(1, Math.floor(cell * 0.12))
  const origin = Math.floor((size - cell * grid) / 2)
  const raw = Buffer.alloc((size * 3 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0
    for (let x = 0; x < size; x++) {
      let px = BG
      const gx = x - origin
      const gy = y - origin
      if (gx >= 0 && gy >= 0 && gx < cell * grid && gy < cell * grid) {
        const cx = Math.floor(gx / cell)
        const cy = Math.floor(gy / cell)
        if (gx % cell >= gap && gy % cell >= gap) px = PALETTE[(cx * 3 + cy * 5 + ((cx * cy) % 3)) % 8]
      }
      const i = y * (size * 3 + 1) + 1 + x * 3
      raw[i] = px[0]; raw[i + 1] = px[1]; raw[i + 2] = px[2]
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ])
}

mkdirSync('public', { recursive: true })
writeFileSync('public/icon-192.png', png(192, { maskable: false }))
writeFileSync('public/icon-512.png', png(512, { maskable: false }))
writeFileSync('public/icon-maskable-512.png', png(512, { maskable: true }))
writeFileSync('public/apple-touch-icon.png', png(180, { maskable: false }))
console.log('icons written')
