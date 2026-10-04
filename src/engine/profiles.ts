/** Tier definitions. Everything downstream is parametric in these. */

export interface Profile {
  id: number
  name: 'safe' | 'balanced' | 'fast' | 'max'
  label: string
  blurb: string
  /** Bits per cell (palette has 2^bpc colours). */
  bpc: number
  /** Grid size in cells (square), including finders/headers. */
  grid: number
  /** Display refreshes each frame is held for (integer multiples of the measured refresh interval). */
  hold: number
  /** RS packets per frame. */
  packetsPerFrame: number
  /** RS parity as a fraction of the codeword. */
  parityRatio: number
  /** Byte-interleave packets across the frame so localised damage spreads over all packets. */
  interleave: boolean
  /** A META packet rides in every Nth frame (counter % metaEvery === 0). */
  metaEvery: number
}

export const PROFILES: Profile[] = [
  {
    id: 0, name: 'safe', label: 'Safe', blurb: 'Bad cameras, shaky hands, dim rooms',
    bpc: 2, grid: 48, hold: 6, packetsPerFrame: 2, parityRatio: 0.28, interleave: true, metaEvery: 3,
  },
  {
    id: 1, name: 'balanced', label: 'Balanced', blurb: 'Good default',
    bpc: 3, grid: 64, hold: 4, packetsPerFrame: 4, parityRatio: 0.2, interleave: true, metaEvery: 3,
  },
  {
    id: 2, name: 'fast', label: 'Fast', blurb: 'Good light, steady hands, decent camera',
    bpc: 4, grid: 80, hold: 3, packetsPerFrame: 9, parityRatio: 0.2, interleave: true, metaEvery: 3,
  },
  {
    id: 3, name: 'max', label: 'Max', blurb: 'Experimental, best case only',
    bpc: 4, grid: 96, hold: 2, packetsPerFrame: 14, parityRatio: 0.2, interleave: true, metaEvery: 3,
  },
]

export const profileById = (id: number): Profile | undefined => PROFILES.find((p) => p.id === id)

/** Candidate grid sizes, used by the receiver to snap an estimated grid size. */
export const GRID_SIZES = [...new Set(PROFILES.map((p) => p.grid))].sort((a, b) => a - b)

type RGB = [number, number, number]

const paletteCache = new Map<number, RGB[]>()

/**
 * Palette for a given bits-per-cell. Colours are RGB 0..255. 4 colours: a tetrahedron of cube corners
 * (all pairwise distances equal); 8: the cube corners; 16: corners plus greedily-chosen far points from a
 * 3-level lattice. The receiver re-learns where each lands every frame, so these only need to be far apart.
 */
export function paletteFor(bpc: number): RGB[] {
  let p = paletteCache.get(bpc)
  if (p) return p
  if (bpc === 1) p = [[0, 0, 0], [255, 255, 255]]
  else if (bpc === 2) p = [[0, 0, 0], [0, 255, 255], [255, 0, 255], [255, 255, 0]]
  else if (bpc === 3) {
    p = []
    for (let i = 0; i < 8; i++) p.push([i & 1 ? 255 : 0, i & 2 ? 255 : 0, i & 4 ? 255 : 0])
  } else {
    const corners: RGB[] = []
    for (let i = 0; i < 8; i++) corners.push([i & 1 ? 255 : 0, i & 2 ? 255 : 0, i & 4 ? 255 : 0])
    const lattice: RGB[] = []
    for (const r of [0, 128, 255]) for (const g of [0, 128, 255]) for (const b of [0, 128, 255]) lattice.push([r, g, b])
    p = corners.slice()
    const dist = (a: RGB, b: RGB) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2
    while (p.length < 1 << bpc) {
      let best: RGB | null = null
      let bestD = -1
      for (const c of lattice) {
        if (p.some((q) => q[0] === c[0] && q[1] === c[1] && q[2] === c[2])) continue
        const d = Math.min(...p.map((q) => dist(c, q)))
        if (d > bestD) { bestD = d; best = c }
      }
      p.push(best!)
    }
  }
  paletteCache.set(bpc, p)
  return p
}
