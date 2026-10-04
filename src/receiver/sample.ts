import type { Layout } from '../engine/framing'
import { applyH, solveLinear, type Mat3 } from './homography'
import type { Img } from './locate'

const OFFS = [-0.2, 0, 0.2]

/**
 * Mean RGB (0..255) of the inner region of every cell, sampled through the homography.
 * Returns G*G*3 floats. `outside` is the fraction of cells whose centre falls outside the image.
 */
export function sampleCells(img: Img, H: Mat3, layout: Layout): { rgb: Float32Array; outside: number } {
  const { width: w, height: h, data } = img
  const G = layout.G
  const out = new Float32Array(G * G * 3)
  let outside = 0
  for (let y = 0; y < G; y++)
    for (let x = 0; x < G; x++) {
      let r = 0
      let g = 0
      let b = 0
      for (const oy of OFFS)
        for (const ox of OFFS) {
          const [ix, iy] = applyH(H, x + 0.5 + ox, y + 0.5 + oy)
          const px = Math.min(w - 1, Math.max(0, Math.floor(ix)))
          const py = Math.min(h - 1, Math.max(0, Math.floor(iy)))
          const j = (py * w + px) * 4
          r += data[j]!
          g += data[j + 1]!
          b += data[j + 2]!
        }
      const o = (y * G + x) * 3
      out[o] = r / 9
      out[o + 1] = g / 9
      out[o + 2] = b / 9
      const [cx, cy] = applyH(H, x + 0.5, y + 0.5)
      if (cx < 0 || cy < 0 || cx >= w || cy >= h) outside++
    }
  return { rgb: out, outside: outside / (G * G) }
}

/**
 * Per-frame colour model. Known cells (reference blocks + pilots) give observed vs expected colour; we fit
 *   obs_c = sum_f w_cf * phi_f(expected, u, v)
 * with phi = [r g b 1, u*(r g b 1), v*(r g b 1)] (u,v centred): per-channel gain/offset/cross-talk plus a
 * planar illumination change (vignette/glare gradient). Per-colour residual offsets then absorb tone-curve
 * non-linearity. Everything is re-learned every frame, so exposure and white-balance drift don't matter.
 */
export interface ColourModel {
  P: number
  /** For colour code k (0..P+1): 9 floats [base rgb, u-gradient rgb, v-gradient rgb], values 0..1. */
  cent: Float32Array
  /** Fraction of pilot cells that classify to the wrong colour. */
  pilotErr: number
  /** Distance between black and white references, 0..255 scale. */
  refSep: number
  /** Smallest distance between neighbouring palette centroids at the grid centre (0..1 scale). */
  sep: number
  rms: number
}

const phi = (p: number[], u: number, v: number): number[] => [
  p[0]!, p[1]!, p[2]!, 1,
  u * p[0]!, u * p[1]!, u * p[2]!, u,
  v * p[0]!, v * p[1]!, v * p[2]!, v,
]

export function calibrate(layout: Layout, rgb: Float32Array): ColourModel | null {
  const { G, P } = layout
  type Obs = { u: number; v: number; code: number; y: number[] }
  const obs: Obs[] = []
  for (const rb of layout.refBlocks) {
    let r = 0
    let g = 0
    let b = 0
    for (const c of rb.cells) {
      r += rgb[c * 3]!
      g += rgb[c * 3 + 1]!
      b += rgb[c * 3 + 2]!
    }
    obs.push({ u: rb.cx / G - 0.5, v: rb.cy / G - 0.5, code: rb.code, y: [r / 1020, g / 1020, b / 1020] })
  }
  for (let i = 0; i < layout.pilotCells.length; i++) {
    const c = layout.pilotCells[i]!
    obs.push({
      u: ((c % G) + 0.5) / G - 0.5,
      v: (Math.floor(c / G) + 0.5) / G - 0.5,
      code: layout.pilotCodes[i]!,
      y: [rgb[c * 3]! / 255, rgb[c * 3 + 1]! / 255, rgb[c * 3 + 2]! / 255],
    })
  }
  const N = obs.length
  const AtA = Array.from({ length: 12 }, () => new Array<number>(12).fill(0))
  const Atb = [0, 1, 2].map(() => new Array<number>(12).fill(0))
  const feats = obs.map((o) => phi(layout.colors[o.code]!.map((x) => x / 255), o.u, o.v))
  for (let n = 0; n < N; n++) {
    const f = feats[n]!
    for (let i = 0; i < 12; i++) {
      for (let j = 0; j < 12; j++) AtA[i]![j]! += f[i]! * f[j]!
      for (let c = 0; c < 3; c++) Atb[c]![i]! += f[i]! * obs[n]!.y[c]!
    }
  }
  for (let i = 4; i < 12; i++) AtA[i]![i]! += 0.002 * N // ridge on the gradient terms only
  for (let i = 0; i < 4; i++) AtA[i]![i]! += 1e-6
  const W: number[][] = []
  for (let c = 0; c < 3; c++) {
    const w = solveLinear(AtA.map((r) => [...r]), Atb[c]!)
    if (!w) return null
    W.push(w)
  }
  // per-colour residual offsets
  const resSum = Array.from({ length: P + 2 }, () => [0, 0, 0])
  const resN = new Array<number>(P + 2).fill(0)
  let sq = 0
  for (let n = 0; n < N; n++) {
    const o = obs[n]!
    const f = feats[n]!
    for (let c = 0; c < 3; c++) {
      let m = 0
      for (let i = 0; i < 12; i++) m += W[c]![i]! * f[i]!
      const r = o.y[c]! - m
      resSum[o.code]![c]! += r
      sq += r * r
    }
    resN[o.code]!++
  }
  const cent = new Float32Array((P + 2) * 9)
  for (let k = 0; k < P + 2; k++) {
    const p = layout.colors[k]!.map((x) => x / 255)
    for (let c = 0; c < 3; c++) {
      const w = W[c]!
      cent[k * 9 + c] = w[0]! * p[0]! + w[1]! * p[1]! + w[2]! * p[2]! + w[3]! + resSum[k]![c]! / (resN[k]! + 0.5)
      cent[k * 9 + 3 + c] = w[4]! * p[0]! + w[5]! * p[1]! + w[6]! * p[2]! + w[7]!
      cent[k * 9 + 6 + c] = w[8]! * p[0]! + w[9]! * p[1]! + w[10]! * p[2]! + w[11]!
    }
  }
  const model: ColourModel = { P, cent, pilotErr: 0, refSep: 0, sep: 0, rms: Math.sqrt(sq / (N * 3)) }
  // black/white separation + palette spacing at the grid centre
  const dist = (a: number, b: number) => Math.hypot(cent[a * 9]! - cent[b * 9]!, cent[a * 9 + 1]! - cent[b * 9 + 1]!, cent[a * 9 + 2]! - cent[b * 9 + 2]!)
  model.refSep = dist(layout.BLACK, layout.WHITE) * 255
  let sep = Infinity
  for (let a = 0; a < P; a++) for (let b = a + 1; b < P; b++) sep = Math.min(sep, dist(a, b))
  model.sep = sep
  // pilot error rate
  let bad = 0
  for (let i = 0; i < layout.pilotCells.length; i++) {
    const c = layout.pilotCells[i]!
    const u = ((c % G) + 0.5) / G - 0.5
    const v = (Math.floor(c / G) + 0.5) / G - 0.5
    const { k } = classifyOne(model, rgb[c * 3]! / 255, rgb[c * 3 + 1]! / 255, rgb[c * 3 + 2]! / 255, u, v, P)
    if (k !== layout.pilotCodes[i]) bad++
  }
  model.pilotErr = layout.pilotCells.length ? bad / layout.pilotCells.length : 0
  return model
}

/** Nearest palette colour (among codes 0..nCodes-1) and a 0..~1 confidence margin. */
export function classifyOne(
  m: ColourModel, r: number, g: number, b: number, u: number, v: number, nCodes: number, first = 0,
): { k: number; conf: number } {
  const c = m.cent
  let best = Infinity
  let second = Infinity
  let bk = first
  for (let k = first; k < first + nCodes; k++) {
    const o = k * 9
    const dr = r - (c[o]! + u * c[o + 3]! + v * c[o + 6]!)
    const dg = g - (c[o + 1]! + u * c[o + 4]! + v * c[o + 7]!)
    const db = b - (c[o + 2]! + u * c[o + 5]! + v * c[o + 8]!)
    const d = dr * dr + dg * dg + db * db
    if (d < best) {
      second = best
      best = d
      bk = k
    } else if (d < second) second = d
  }
  const conf = m.sep > 0 ? (Math.sqrt(second) - Math.sqrt(best)) / m.sep : 0
  return { k: bk, conf }
}

/** Classify every data cell. */
export function classifyData(layout: Layout, model: ColourModel, rgb: Float32Array): { values: Uint8Array; conf: Float32Array } {
  const { G, P, dataCells } = layout
  const values = new Uint8Array(dataCells.length)
  const conf = new Float32Array(dataCells.length)
  for (let i = 0; i < dataCells.length; i++) {
    const c = dataCells[i]!
    const u = ((c % G) + 0.5) / G - 0.5
    const v = (Math.floor(c / G) + 0.5) / G - 0.5
    const r = classifyOne(model, rgb[c * 3]! / 255, rgb[c * 3 + 1]! / 255, rgb[c * 3 + 2]! / 255, u, v, P)
    values[i] = r.k
    conf[i] = r.conf
  }
  return { values, conf }
}

/** Header bits from 2x2 black/white blocks. */
export function readHeaderBits(layout: Layout, model: ColourModel, rgb: Float32Array, blocks: Int32Array[]): Uint8Array {
  const { G } = layout
  const bits = new Uint8Array(blocks.length)
  blocks.forEach((cells, k) => {
    let r = 0
    let g = 0
    let b = 0
    let u = 0
    let v = 0
    for (const c of cells) {
      r += rgb[c * 3]!
      g += rgb[c * 3 + 1]!
      b += rgb[c * 3 + 2]!
      u += ((c % G) + 0.5) / G - 0.5
      v += (Math.floor(c / G) + 0.5) / G - 0.5
    }
    const res = classifyOne(model, r / 1020, g / 1020, b / 1020, u / 4, v / 4, 2, layout.BLACK)
    bits[k] = res.k === layout.WHITE ? 1 : 0
  })
  return bits
}

/** 1 = razor sharp, 0 = washed out. Looks at the 1-cell black rings of the alignment patterns. */
export function sharpness(layout: Layout, model: ColourModel, rgb: Float32Array): number {
  const { G, BLACK, WHITE } = layout
  const lum = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b
  const lb = lum(model.cent[BLACK * 9]!, model.cent[BLACK * 9 + 1]!, model.cent[BLACK * 9 + 2]!)
  const lw = lum(model.cent[WHITE * 9]!, model.cent[WHITE * 9 + 1]!, model.cent[WHITE * 9 + 2]!)
  if (lw - lb < 0.05) return 0
  let s = 0
  for (const c of layout.sharpCells) {
    const u = ((c % G) + 0.5) / G - 0.5
    const v = (Math.floor(c / G) + 0.5) / G - 0.5
    const exp = lum(
      model.cent[BLACK * 9]! + u * model.cent[BLACK * 9 + 3]! + v * model.cent[BLACK * 9 + 6]!,
      model.cent[BLACK * 9 + 1]! + u * model.cent[BLACK * 9 + 4]! + v * model.cent[BLACK * 9 + 7]!,
      model.cent[BLACK * 9 + 2]! + u * model.cent[BLACK * 9 + 5]! + v * model.cent[BLACK * 9 + 8]!,
    )
    const l = lum(rgb[c * 3]! / 255, rgb[c * 3 + 1]! / 255, rgb[c * 3 + 2]! / 255)
    s += Math.max(0, (l - exp) / (lw - lb))
  }
  const leak = s / layout.sharpCells.length
  return Math.max(0, Math.min(1, 1 - 2.5 * leak))
}
