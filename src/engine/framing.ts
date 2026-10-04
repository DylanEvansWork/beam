import { crc8 } from './crc'
import { PACKET_OVERHEAD, type PacketGeometry } from './packets'
import { GRID_SIZES, paletteFor, type Profile } from './profiles'
import { Rng } from './prng'
import { PROTOCOL_VERSION } from './version'

/**
 * Frame geometry. A frame is a G x G grid of cells:
 *  - three 7x7 finders (TL, TR, BL), white on black, QR-style 1:1:3:1:1, each inside a black separator;
 *  - 5x5 alignment patterns (white/black/white, 1:1:1:1:1): one in the BR corner (so all four corners anchor
 *    the homography) plus a lattice in the interior, each inside a black margin;
 *  - header bits as 2x2 black/white blocks, once at the top and once (copy) at the bottom;
 *  - reference blocks (2x2 of every palette colour + black + white) in the left and right side bands;
 *  - pilot cells (known pseudo-random palette colours), one every PILOT_EVERY data cells;
 *  - everything else carries data.
 * Cell codes: 0..P-1 palette colours, P = black, P+1 = white.
 */

export const NONE = 255
export const PILOT_EVERY = 32
export const HEADER_BITS = 48
export const QUIET_CELLS = 2

export const KIND_DATA = 0
export const KIND_LOCKON = 1
export const KIND_TEST = 2

export interface FrameHeader {
  version: number
  /** Low 2 bits: profile id. Next 2 bits: kind (KIND_*). */
  tierKind: number
  session: number
  /** Frame counter, 16 bits, wraps. */
  counter: number
}

export const makeTierKind = (profileId: number, kind: number): number => (kind << 2) | (profileId & 3)
export const tierOf = (tierKind: number): number => tierKind & 3
export const kindOf = (tierKind: number): number => (tierKind >> 2) & 3

export interface Anchor {
  kind: 'finder' | 'align'
  /** Centre in code coordinates (cell units, cell (x,y) spans [x,x+1)). */
  cx: number
  cy: number
}

export interface RefBlock {
  cells: Int32Array
  code: number
  /** Block centre in code coordinates. */
  cx: number
  cy: number
}

export interface Layout {
  profile: Profile
  G: number
  P: number
  bpc: number
  colors: number[][]
  BLACK: number
  WHITE: number
  /** Static colour code per cell, or NONE. */
  staticCode: Uint8Array
  /** Data-carrying cells, in transmission order. */
  dataCells: Int32Array
  pilotCells: Int32Array
  pilotCodes: Uint8Array
  headerTop: Int32Array[]
  headerBottom: Int32Array[]
  refBlocks: RefBlock[]
  anchors: Anchor[]
  /** Black ring cells adjacent to alignment centres, used for the blur metric. */
  sharpCells: Int32Array
  packet: PacketGeometry
  packetsPerFrame: number
  capBytes: number
}

const layoutCache = new Map<string, Layout>()

const cacheKey = (p: Profile): string => `${p.id}:${p.bpc}:${p.grid}:${p.interleave}:${p.parityRatio}:${p.packetsPerFrame}`

/** Drop cached layouts (benchmarks mutate profiles). */
export function clearLayoutCache(): void {
  layoutCache.clear()
}

export function buildLayout(profile: Profile): Layout {
  const cached = layoutCache.get(cacheKey(profile))
  if (cached) return cached
  const G = profile.grid
  const colors = paletteFor(profile.bpc).map((c) => [...c])
  const P = colors.length
  const BLACK = P
  const WHITE = P + 1
  colors.push([0, 0, 0], [255, 255, 255])

  const staticCode = new Uint8Array(G * G).fill(NONE)
  const claimed = new Uint8Array(G * G) // anything not data
  const set = (x: number, y: number, code: number) => {
    if (x < 0 || y < 0 || x >= G || y >= G) return
    staticCode[y * G + x] = code
    claimed[y * G + x] = 1
  }
  const anchors: Anchor[] = []
  const sharp: number[] = []

  // finders with 1-cell black separators (8x8 blocks anchored at the three corners)
  for (const [ox, oy] of [[0, 0], [G - 8, 0], [0, G - 8]] as const) {
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) set(ox + x, oy + y, BLACK)
    const fx = ox === 0 ? 0 : ox + 1
    const fy = oy === 0 ? 0 : oy + 1
    for (let y = 0; y < 7; y++)
      for (let x = 0; x < 7; x++) {
        const d = Math.max(Math.abs(x - 3), Math.abs(y - 3))
        set(fx + x, fy + y, d === 2 ? BLACK : WHITE)
      }
    anchors.push({ kind: 'finder', cx: fx + 3.5, cy: fy + 3.5 })
  }

  const alignAt = (cx: number, cy: number) => {
    for (let y = -3; y <= 3; y++)
      for (let x = -3; x <= 3; x++) {
        const d = Math.max(Math.abs(x), Math.abs(y))
        set(cx + x, cy + y, d === 1 ? BLACK : d === 3 ? BLACK : WHITE)
      }
    anchors.push({ kind: 'align', cx: cx + 0.5, cy: cy + 0.5 })
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) sharp.push((cy + dy) * G + cx + dx)
  }
  // BR corner anchor, then the interior lattice
  alignAt(G - 4, G - 4)
  const m = Math.ceil((G - 7) / 24)
  const pos = (j: number) => Math.round(3 + (j * (G - 7)) / m)
  for (let j = 1; j < m; j++) for (let i = 1; i < m; i++) alignAt(pos(i), pos(j))

  // header blocks (2x2 cells per bit) in the top / bottom bands between the finders
  const nb = Math.floor((G - 16) / 2)
  const rowsNeeded = Math.ceil(HEADER_BITS / nb)
  if (rowsNeeded > 3) throw new Error(`grid ${G} too narrow for the header`)
  const startX = 8 + Math.floor((G - 16 - 2 * nb) / 2)
  const headerTop: Int32Array[] = []
  const headerBottom: Int32Array[] = []
  for (let k = 0; k < HEADER_BITS; k++) {
    const bx = k % nb
    const by = Math.floor(k / nb)
    const x = startX + 2 * bx
    const topCells = new Int32Array(4)
    const botCells = new Int32Array(4)
    for (let q = 0; q < 4; q++) {
      const dx = q & 1
      const dy = q >> 1
      topCells[q] = (2 * by + dy) * G + x + dx
      botCells[q] = (G - 6 + 2 * by + dy) * G + x + dx
    }
    for (const c of topCells) claimed[c] = 1
    for (const c of botCells) claimed[c] = 1
    headerTop.push(topCells)
    headerBottom.push(botCells)
  }

  // reference blocks in the side bands: every palette colour + black + white, three times per side, spread out
  const refBlocks: RefBlock[] = []
  const nRows = Math.floor((G - 16) / 2)
  const total = 3 * nRows
  const nColors = P + 2
  const R = 3 * nColors
  if (R > total) throw new Error('side bands too small for reference blocks')
  for (const side of [0, 1]) {
    const x0 = side === 0 ? 0 : G - 6
    for (let i = 0; i < R; i++) {
      const q = Math.floor((i * total) / R + total / (2 * R))
      const bx = q % 3
      const by = Math.floor(q / 3)
      const cells = new Int32Array(4)
      for (let k = 0; k < 4; k++) cells[k] = (8 + 2 * by + (k >> 1)) * G + x0 + 2 * bx + (k & 1)
      const code = (i + side * 7) % nColors // offset so left/right sides differ in order
      for (const c of cells) {
        claimed[c] = 1
        staticCode[c] = code < P ? code : code === P ? BLACK : WHITE
      }
      refBlocks.push({ cells, code: staticCode[cells[0]!]!, cx: x0 + 2 * bx + 1, cy: 8 + 2 * by + 1 })
    }
  }

  // pilots + data
  const data: number[] = []
  const pilotCells: number[] = []
  let counter = 0
  for (let c = 0; c < G * G; c++) {
    if (claimed[c]) continue
    if (counter % PILOT_EVERY === PILOT_EVERY >> 1) pilotCells.push(c)
    else data.push(c)
    counter++
  }
  const prng = new Rng(0xb1, 7)
  const pilotCodes = Uint8Array.from(pilotCells, () => prng.int(P))
  pilotCells.forEach((c, i) => (staticCode[c] = pilotCodes[i]!))

  const capBytes = Math.floor((data.length * profile.bpc) / 8)
  const n = Math.min(255, Math.floor(capBytes / profile.packetsPerFrame))
  const parity = Math.round(n * profile.parityRatio)
  if (n - parity - PACKET_OVERHEAD < 107) throw new Error(`profile ${profile.name}: packets too small for META`)

  const layout: Layout = {
    profile, G, P, bpc: profile.bpc, colors, BLACK, WHITE, staticCode,
    dataCells: Int32Array.from(data), pilotCells: Int32Array.from(pilotCells), pilotCodes,
    headerTop, headerBottom, refBlocks, anchors, sharpCells: Int32Array.from(sharp),
    packet: { n, parity }, packetsPerFrame: profile.packetsPerFrame, capBytes,
  }
  layoutCache.set(cacheKey(profile), layout)
  return layout
}

/** Snap an estimated grid size to the nearest one we know about; null if nothing is close. */
export function snapGrid(estimate: number): number | null {
  let best: number | null = null
  let bestD = Infinity
  for (const g of GRID_SIZES) {
    const d = Math.abs(g - estimate)
    if (d < bestD) { bestD = d; best = g }
  }
  return bestD <= 7 ? best : null
}

// ---- header ---------------------------------------------------------------------------------------------

export function headerToBits(h: FrameHeader): Uint8Array {
  const bytes = new Uint8Array(6)
  bytes[0] = ((h.version & 15) << 4) | (h.tierKind & 15)
  bytes[1] = (h.session >> 8) & 0xff
  bytes[2] = h.session & 0xff
  bytes[3] = (h.counter >> 8) & 0xff
  bytes[4] = h.counter & 0xff
  bytes[5] = crc8(bytes.subarray(0, 5))
  const bits = new Uint8Array(HEADER_BITS)
  for (let i = 0; i < HEADER_BITS; i++) bits[i] = (bytes[i >> 3]! >> (7 - (i & 7))) & 1
  return bits
}

export function bitsToHeader(bits: ArrayLike<number>): FrameHeader | null {
  const bytes = new Uint8Array(6)
  for (let i = 0; i < HEADER_BITS; i++) if (bits[i]) bytes[i >> 3] = bytes[i >> 3]! | (1 << (7 - (i & 7)))
  if (crc8(bytes.subarray(0, 5)) !== bytes[5]) return null
  const version = bytes[0]! >> 4
  if (version !== PROTOCOL_VERSION) return null
  return {
    version,
    tierKind: bytes[0]! & 15,
    session: (bytes[1]! << 8) | bytes[2]!,
    counter: (bytes[3]! << 8) | bytes[4]!,
  }
}

// ---- bytes <-> cells -------------------------------------------------------------------------------------

/**
 * Whitening stream, so frames never contain long runs of one colour and padding is balanced. Deliberately
 * independent of the frame counter: a camera frame torn between two display frames then still decodes
 * packet by packet (each packet is RS + CRC16 protected on its own).
 */
export function whitening(session: number, _counter: number, len: number): Uint8Array {
  const rng = new Rng((session << 16) ^ 0x5a5a1234, 0)
  const out = new Uint8Array(len)
  for (let i = 0; i < len; i++) out[i] = rng.nextU32() & 0xff
  return out
}

/** Pack packets (each layout.packet.n bytes) into the frame's byte stream (interleaved if the profile says so). */
export function packetsToStream(layout: Layout, packets: Uint8Array[]): Uint8Array {
  const { n } = layout.packet
  const ppf = layout.packetsPerFrame
  const stream = new Uint8Array(layout.capBytes)
  if (layout.profile.interleave) {
    for (let p = 0; p < packets.length; p++) for (let b = 0; b < n; b++) stream[b * ppf + p] = packets[p]![b]!
  } else {
    for (let p = 0; p < packets.length; p++) stream.set(packets[p]!, p * n)
  }
  return stream
}

/** Inverse of packetsToStream. `erasedByte` (optional, per stream byte) is mapped to per-packet erasure lists. */
export function streamToPackets(
  layout: Layout,
  stream: Uint8Array,
  erasedByte?: Uint8Array,
): { bytes: Uint8Array; erasures: number[] }[] {
  const { n } = layout.packet
  const ppf = layout.packetsPerFrame
  const out: { bytes: Uint8Array; erasures: number[] }[] = []
  for (let p = 0; p < ppf; p++) {
    const bytes = new Uint8Array(n)
    const erasures: number[] = []
    for (let b = 0; b < n; b++) {
      const si = layout.profile.interleave ? b * ppf + p : p * n + b
      bytes[b] = stream[si]!
      if (erasedByte && erasedByte[si]) erasures.push(b)
    }
    out.push({ bytes, erasures })
  }
  return out
}

/** Build the cell-code array for a data frame. `packets` must all be layout.packet.n bytes. */
export function buildFrameCells(layout: Layout, header: FrameHeader, packets: Uint8Array[]): Uint8Array {
  const cells = Uint8Array.from(layout.staticCode)
  writeHeader(layout, cells, header)
  const stream = packetsToStream(layout, packets)
  const white = whitening(header.session, header.counter, layout.capBytes)
  for (let i = 0; i < stream.length; i++) stream[i] = stream[i]! ^ white[i]!
  const { dataCells, bpc } = layout
  const filler = new Rng(header.session ^ 0xf11e, header.counter)
  let bitPos = 0
  for (let i = 0; i < dataCells.length; i++) {
    let v = 0
    for (let b = 0; b < bpc; b++) {
      const byteIdx = bitPos >> 3
      const bit = byteIdx < stream.length ? (stream[byteIdx]! >> (7 - (bitPos & 7))) & 1 : filler.nextU32() & 1
      v = (v << 1) | bit
      bitPos++
    }
    cells[dataCells[i]!] = v
  }
  return cells
}

/** Lock-on frame: finders, references, header (kind lockon) and pilots, but no data (data cells black). */
export function buildLockonCells(layout: Layout, header: FrameHeader): Uint8Array {
  const cells = Uint8Array.from(layout.staticCode)
  writeHeader(layout, cells, header)
  for (const c of layout.dataCells) cells[c] = layout.BLACK
  return cells
}

function writeHeader(layout: Layout, cells: Uint8Array, h: FrameHeader): void {
  const bits = headerToBits(h)
  for (let k = 0; k < HEADER_BITS; k++) {
    const code = bits[k] ? layout.WHITE : layout.BLACK
    for (const c of layout.headerTop[k]!) cells[c] = code
    for (const c of layout.headerBottom[k]!) cells[c] = code
  }
}

/** Data-cell values (palette indices, one per layout.dataCells entry) back to the whitened-removed byte stream. */
export function cellsToStream(layout: Layout, values: ArrayLike<number>, header: FrameHeader): Uint8Array {
  const { bpc } = layout
  const stream = new Uint8Array(layout.capBytes)
  let bitPos = 0
  for (let i = 0; i < layout.dataCells.length; i++) {
    const v = values[i]!
    for (let b = bpc - 1; b >= 0; b--) {
      const byteIdx = bitPos >> 3
      if (byteIdx < stream.length && (v >> b) & 1) stream[byteIdx] = stream[byteIdx]! | (0x80 >> (bitPos & 7))
      bitPos++
    }
  }
  const white = whitening(header.session, header.counter, layout.capBytes)
  for (let i = 0; i < stream.length; i++) stream[i] = stream[i]! ^ white[i]!
  return stream
}

// ---- rasteriser -------------------------------------------------------------------------------------------

export interface RasterImage {
  width: number
  height: number
  data: Uint8ClampedArray
}

/** Pixel size of a rendered frame (grid + quiet zone) for a given cell size. */
export const rasterSize = (layout: Layout, cellPx: number): number => (layout.G + 2 * QUIET_CELLS) * cellPx

/** Draw cell codes into an RGBA buffer, integer pixels, no smoothing, black quiet zone around. */
export function rasterize(layout: Layout, cells: Uint8Array, cellPx: number, into?: RasterImage): RasterImage {
  const size = rasterSize(layout, cellPx)
  const img = into ?? { width: size, height: size, data: new Uint8ClampedArray(size * size * 4) }
  if (img.width !== size || img.height !== size) throw new Error('raster buffer size mismatch')
  const px = new Uint32Array(img.data.buffer, img.data.byteOffset, size * size)
  const lut = layout.colors.map((c) => (0xff000000 | (c[2]! << 16) | (c[1]! << 8) | c[0]!) >>> 0)
  const black = lut[layout.BLACK]!
  px.fill(black)
  const { G } = layout
  const q = QUIET_CELLS
  for (let cy = 0; cy < G; cy++) {
    const rowStart = (q + cy) * cellPx * size + q * cellPx
    for (let cx = 0; cx < G; cx++) {
      const v = lut[cells[cy * G + cx]!]!
      const x0 = rowStart + cx * cellPx
      for (let x = 0; x < cellPx; x++) px[x0 + x] = v
    }
    for (let y = 1; y < cellPx; y++) px.copyWithin(rowStart + y * size, rowStart, rowStart + G * cellPx)
  }
  return img
}
