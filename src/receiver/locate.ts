import { snapGrid, type Layout } from '../engine/framing'
import { applyH, fitAffine, fitHomography, localScale, type Mat3, type Pt } from './homography'

export interface Img {
  width: number
  height: number
  /** RGBA, row-major. */
  data: Uint8ClampedArray | Uint8Array
}

export function toGray(img: Img): Uint8Array {
  const { width: w, height: h, data } = img
  const g = new Uint8Array(w * h)
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (data[j]! * 77 + data[j + 1]! * 150 + data[j + 2]! * 29) >> 8
  return g
}

function decimate(g: Uint8Array, w: number, h: number, f: number): { g: Uint8Array; w: number; h: number } {
  if (f <= 1) return { g, w, h }
  const nw = Math.floor(w / f)
  const nh = Math.floor(h / f)
  const out = new Uint8Array(nw * nh)
  const area = f * f
  for (let y = 0; y < nh; y++)
    for (let x = 0; x < nw; x++) {
      let s = 0
      for (let dy = 0; dy < f; dy++) {
        const row = (y * f + dy) * w + x * f
        for (let dx = 0; dx < f; dx++) s += g[row + dx]!
      }
      out[y * nw + x] = (s / area) | 0
    }
  return { g: out, w: nw, h: nh }
}

function percentile(g: Uint8Array, p: number): number {
  const hist = new Uint32Array(256)
  for (let i = 0; i < g.length; i += 3) hist[g[i]!]!++
  const target = (g.length / 3) * p
  let acc = 0
  for (let v = 0; v < 256; v++) {
    acc += hist[v]!
    if (acc >= target) return v
  }
  return 255
}

export const bilerp = (g: Uint8Array, w: number, h: number, x: number, y: number): number => {
  const fx = x - 0.5
  const fy = y - 0.5
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const tx = fx - x0
  const ty = fy - y0
  const cx0 = Math.min(w - 1, Math.max(0, x0))
  const cx1 = Math.min(w - 1, Math.max(0, x0 + 1))
  const cy0 = Math.min(h - 1, Math.max(0, y0))
  const cy1 = Math.min(h - 1, Math.max(0, y0 + 1))
  const a = g[cy0 * w + cx0]! * (1 - tx) + g[cy0 * w + cx1]! * tx
  const b = g[cy1 * w + cx0]! * (1 - tx) + g[cy1 * w + cx1]! * tx
  return a * (1 - ty) + b * ty
}

// ---- finder candidate scan --------------------------------------------------------------------------------

interface Candidate {
  x: number
  y: number
  m: number
  count: number
}

/** Runs [W,B,W,B,W] with ratio 1:1:3:1:1 (white-on-black finder). Returns module size or 0. */
function ratioOk(r: number[], tol: number): number {
  const total = r[0]! + r[1]! + r[2]! + r[3]! + r[4]!
  if (total < 7) return 0
  const m = total / 7
  const t = m * tol
  if (Math.abs(r[0]! - m) > t || Math.abs(r[1]! - m) > t || Math.abs(r[3]! - m) > t || Math.abs(r[4]! - m) > t) return 0
  if (Math.abs(r[2]! - 3 * m) > 3 * t) return 0
  return m
}

/** Measure the five runs through (x0,y0) along (dx,dy), centre pixel assumed white. */
function crossRuns(g: Uint8Array, w: number, h: number, x0: number, y0: number, dx: number, dy: number, T: number) {
  const walk = (sx: number, sy: number): number[] | null => {
    // from the centre outward: white run, black run, white run (all must be non-empty)
    const out = [0, 0, 0]
    let x = x0
    let y = y0
    for (let state = 0; state < 3; state++) {
      const want = state !== 1
      while (x >= 0 && y >= 0 && x < w && y < h && g[y * w + x]! >= T === want) {
        out[state]!++
        x += sx
        y += sy
      }
      if (out[state] === 0) return null
    }
    return out
  }
  const a = walk(-dx, -dy)
  const b = walk(dx, dy)
  if (!a || !b) return null
  const centre = a[0]! + b[0]! - 1
  return { runs: [a[2]!, a[1]!, centre, b[1]!, b[2]!], offset: (b[0]! - a[0]!) / 2 }
}

function scanFinders(g: Uint8Array, w: number, h: number, T: number): Candidate[] {
  const cands: Candidate[] = []
  const runs = [0, 0, 0, 0, 0]
  const push = (x: number, y: number, m: number) => {
    for (const c of cands) {
      if (Math.hypot(c.x - x, c.y - y) < Math.max(m, c.m) * 1.5 && Math.abs(c.m - m) < c.m * 0.5) {
        const n = c.count
        c.x = (c.x * n + x) / (n + 1)
        c.y = (c.y * n + y) / (n + 1)
        c.m = (c.m * n + m) / (n + 1)
        c.count++
        return
      }
    }
    cands.push({ x, y, m, count: 1 })
  }
  for (let y = 0; y < h; y++) {
    const row = y * w
    let runStart = 0
    let cur = g[row]! >= T
    let nruns = 0
    const close = (end: number, wasWhite: boolean) => {
      const len = end - runStart
      runs[0] = runs[1]!
      runs[1] = runs[2]!
      runs[2] = runs[3]!
      runs[3] = runs[4]!
      runs[4] = len
      nruns++
      if (!wasWhite || nruns < 5) return
      const m = ratioOk(runs, 0.55)
      if (!m) return
      const cx = end - runs[4]! - runs[3]! - runs[2]! / 2
      const ix = Math.floor(cx)
      if (ix < 0 || ix >= w || g[row + ix]! < T) return
      const v = crossRuns(g, w, h, ix, y, 0, 1, T)
      if (!v) return
      const mv = ratioOk(v.runs, 0.55)
      if (!mv) return
      const cy = y + v.offset + 0.5
      const iy = Math.floor(cy)
      const hz = crossRuns(g, w, h, ix, iy, 1, 0, T)
      if (!hz) return
      const mh = ratioOk(hz.runs, 0.55)
      if (!mh) return
      push(ix + hz.offset + 0.5, cy, (m + mv + mh) / 3)
    }
    for (let x = 1; x < w; x++) {
      const isW = g[row + x]! >= T
      if (isW !== cur) {
        close(x, cur)
        runStart = x
        cur = isW
      }
    }
    close(w, cur)
  }
  return cands.filter((c) => c.count >= 2).sort((a, b) => b.count - a.count).slice(0, 14)
}

interface Triple {
  tl: Candidate
  tr: Candidate
  bl: Candidate
  G: number
  score: number
}

function bestTriples(cands: Candidate[]): Triple[] {
  const out: Triple[] = []
  for (let i = 0; i < cands.length; i++)
    for (let j = i + 1; j < cands.length; j++)
      for (let k = j + 1; k < cands.length; k++) {
        const set = [cands[i]!, cands[j]!, cands[k]!]
        const ms = set.map((c) => c.m)
        if (Math.max(...ms) / Math.min(...ms) > 1.6) continue
        for (let a = 0; a < 3; a++) {
          const A = set[a]!
          const B = set[(a + 1) % 3]!
          const C = set[(a + 2) % 3]!
          const ab = Math.hypot(B.x - A.x, B.y - A.y)
          const ac = Math.hypot(C.x - A.x, C.y - A.y)
          if (ab < 1 || ac < 1) continue
          const cos = ((B.x - A.x) * (C.x - A.x) + (B.y - A.y) * (C.y - A.y)) / (ab * ac)
          const legDiff = Math.abs(ab - ac) / Math.max(ab, ac)
          if (Math.abs(cos) > 0.4 || legDiff > 0.3) continue
          const m = (ms[0]! + ms[1]! + ms[2]!) / 3
          const G = snapGrid((ab + ac) / 2 / m + 7)
          if (G === null) continue
          const cross = (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x)
          const [tr, bl] = cross > 0 ? [B, C] : [C, B]
          out.push({ tl: A, tr, bl, G, score: legDiff + Math.abs(cos) + (Math.max(...ms) / Math.min(...ms) - 1) - 0.02 * (A.count + B.count + C.count) })
        }
      }
  return out.sort((a, b) => a.score - b.score).slice(0, 4)
}

// ---- anchor template matching ----------------------------------------------------------------------------

interface Anchor {
  kind: 'finder' | 'align'
  cx: number
  cy: number
}

/** Template sample offsets (cell units from the anchor centre) with expected polarity +1 white / -1 black. */
const templates: Record<'finder' | 'align', { dx: number; dy: number; s: number }[]> = { finder: [], align: [] }
{
  const build = (half: number, kind: 'finder' | 'align') => {
    // ring distance d (Chebyshev): finder: d<=1 white, d=2 black, d=3 white, d=4 black; align: d=0 white, 1 black, 2 white, 3 black
    for (let dy = -(half + 1); dy <= half + 1; dy++)
      for (let dx = -(half + 1); dx <= half + 1; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy))
        let s: number
        if (kind === 'finder') s = d <= 1 ? 1 : d === 2 ? -1 : d === 3 ? 1 : -1
        else s = d === 0 ? 1 : d === 1 ? -1 : d === 2 ? 1 : -1
        templates[kind].push({ dx, dy, s })
      }
  }
  build(3, 'finder')
  build(2, 'align')
}

interface Match {
  x: number
  y: number
  contrast: number
}

/** Template-match one anchor around its predicted image position. */
function matchAnchor(g: Uint8Array, w: number, h: number, H: Mat3, a: Anchor, radius: number, step: number): Match | null {
  const [px, py] = applyH(H, a.cx, a.cy)
  const tpl = templates[a.kind]
  const pts = tpl.map((t) => ({ p: applyH(H, a.cx + t.dx, a.cy + t.dy), s: t.s }))
  const score = (ox: number, oy: number): number => {
    let sw = 0
    let nw = 0
    let sb = 0
    let nb = 0
    for (const { p, s } of pts) {
      const x = p[0] + ox
      const y = p[1] + oy
      if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue
      const v = bilerp(g, w, h, x, y)
      if (s > 0) { sw += v; nw++ } else { sb += v; nb++ }
    }
    if (nw < 4 || nb < 4) return -1e9
    return sw / nw - sb / nb
  }
  let best = -1e9
  let bx = 0
  let by = 0
  for (let oy = -radius; oy <= radius; oy += step)
    for (let ox = -radius; ox <= radius; ox += step) {
      const s = score(ox, oy)
      if (s > best) { best = s; bx = ox; by = oy }
    }
  if (best < 0) return null
  // refine at sub-pixel precision
  const fine = Math.max(0.25, step / 4)
  let rx = bx
  let ry = by
  for (let it = 0; it < 2; it++) {
    const span = step / (it + 1)
    let lb = score(rx, ry)
    for (let oy = -span; oy <= span; oy += fine)
      for (let ox = -span; ox <= span; ox += fine) {
        const s = score(rx + ox, ry + oy)
        if (s > lb) { lb = s; bx = rx + ox; by = ry + oy }
      }
    rx = bx
    ry = by
    best = Math.max(best, lb)
  }
  return { x: px + rx, y: py + ry, contrast: best }
}

// ---- locate -----------------------------------------------------------------------------------------------

export interface Lock {
  H: Mat3
  G: number
  /** Outer corners TL, TR, BR, BL in image coordinates. */
  quad: Pt[]
  anchorsFound: number
  anchorsTotal: number
  /** Image px per cell at the grid centre. */
  cellPx: number
  mode: 'scan' | 'track'
}

export type LayoutFor = (grid: number) => Layout | undefined

/** Fit H from matched anchors, dropping outliers; returns null if it can't. */
function fitFrom(pairs: { code: Pt; img: Pt }[], cellPx: number): { H: Mat3; used: number } | null {
  let cur = pairs
  for (let iter = 0; iter < 3; iter++) {
    if (cur.length < 3) return null
    const src = cur.map((p) => p.code)
    const dst = cur.map((p) => p.img)
    const H = cur.length >= 4 ? fitHomography(src, dst) : fitAffine(src, dst)
    if (!H) return null
    if (cur.length <= 4) return { H, used: cur.length }
    const res = cur.map((p) => {
      const [x, y] = applyH(H, p.code[0], p.code[1])
      return Math.hypot(x - p.img[0], y - p.img[1])
    })
    const worst = Math.max(...res)
    if (worst < cellPx * 0.45) return { H, used: cur.length }
    const wi = res.indexOf(worst)
    cur = cur.filter((_, i) => i !== wi)
  }
  return null
}

function lockFrom(H: Mat3, layout: Layout, found: number, mode: 'scan' | 'track', w: number, h: number): Lock | null {
  const G = layout.G
  const quad: Pt[] = [applyH(H, 0, 0), applyH(H, G, 0), applyH(H, G, G), applyH(H, 0, G)]
  const cellPx = localScale(H, G / 2, G / 2)
  if (!(cellPx > 1.5) || quad.some(([x, y]) => !isFinite(x) || !isFinite(y))) return null
  // reject degenerate or wildly out-of-frame quads
  const margin = cellPx * 2
  if (quad.some(([x, y]) => x < -margin || y < -margin || x > w + margin || y > h + margin)) return null
  return { H, G, quad, anchorsFound: found, anchorsTotal: layout.anchors.length, cellPx, mode }
}

/** Refine all anchors of a layout starting from a seed H; returns a lock if enough of them match. */
function refineAll(
  g: Uint8Array, w: number, h: number, layout: Layout, seed: Mat3, searchCells: number, mode: 'scan' | 'track',
  minAnchors: number, range: number,
): Lock | null {
  let H = seed
  const pairs: { code: Pt; img: Pt }[] = []
  const ordered = [...layout.anchors]
  const cellPx0 = localScale(seed, layout.G / 2, layout.G / 2)
  const contrastMin = Math.max(25, range * 0.3)
  // finders first, then BR alignment, then interior (homography improves as we go)
  for (let i = 0; i < ordered.length; i++) {
    const a = ordered[i]!
    const scale = localScale(H, a.cx, a.cy)
    const cells = mode === 'scan' && i === 3 ? Math.max(searchCells, 5) : searchCells
    const radius = Math.max(2, scale * cells)
    const m = matchAnchor(g, w, h, H, a, radius, Math.max(0.75, scale / 4))
    if (!m || m.contrast < contrastMin) continue
    pairs.push({ code: [a.cx, a.cy], img: [m.x, m.y] })
    if (pairs.length >= 4) {
      const f = fitFrom(pairs, cellPx0 * 3)
      if (f) H = f.H
    }
  }
  if (pairs.length < minAnchors) return null
  const f1 = fitFrom(pairs, cellPx0 * 3)
  if (!f1) return null
  // second pass: the homography is now good, so re-match every anchor tightly around its prediction
  H = f1.H
  const pairs2: { code: Pt; img: Pt }[] = []
  for (const a of ordered) {
    const scale = localScale(H, a.cx, a.cy)
    const m = matchAnchor(g, w, h, H, a, Math.max(2, scale * 1.0), Math.max(0.75, scale / 4))
    if (!m || m.contrast < contrastMin) continue
    pairs2.push({ code: [a.cx, a.cy], img: [m.x, m.y] })
  }
  if (pairs2.length < minAnchors) return null
  const f = fitFrom(pairs2, cellPx0)
  if (!f) return null
  return lockFrom(f.H, layout, f.used, mode, w, h)
}

export class Locator {
  private prev: { H: Mat3; layout: Layout; complete: boolean } | null = null
  /** Consecutive frames without a lock. */
  misses = 0
  private readonly layoutFor: LayoutFor

  constructor(layoutFor: LayoutFor) {
    this.layoutFor = layoutFor
  }

  reset(): void {
    this.prev = null
  }

  /** Remember a lock whose header decoded OK so the next frame can track instead of scanning. */
  accept(lock: Lock, layout: Layout): void {
    this.prev = { H: lock.H, layout, complete: lock.anchorsFound >= lock.anchorsTotal }
  }

  forget(): void {
    this.prev = null
  }

  locate(img: Img, gray: Uint8Array): Lock | null {
    const { width: w, height: h } = img
    if (this.prev) {
      const minA = Math.max(3, Math.ceil(this.prev.layout.anchors.length * 0.6))
      const t = refineAll(gray, w, h, this.prev.layout, this.prev.H, this.prev.complete ? 2.0 : 4.0, 'track', minA, percentile(gray, 0.995) - percentile(gray, 0.02))
      if (t) return t
    }
    return this.scan(gray, w, h)
  }

  /** Full-frame search (possibly returns several hypotheses via alternates()). */
  scan(gray: Uint8Array, w: number, h: number): Lock | null {
    return this.scanAll(gray, w, h)[0] ?? null
  }

  scanAll(gray: Uint8Array, w: number, h: number): Lock[] {
    const f = Math.max(1, Math.round(w / 700))
    const d = decimate(gray, w, h, f)
    const lo = percentile(d.g, 0.02)
    const hi = percentile(d.g, 0.995)
    if (hi - lo < 40) return []
    const locks: Lock[] = []
    for (const frac of [0.5, 0.38, 0.62]) {
      const T = lo + (hi - lo) * frac
      const cands = scanFinders(d.g, d.w, d.h, T)
      if (cands.length < 3) continue
      for (const t of bestTriples(cands)) {
        const layout = this.layoutFor(t.G)
        if (!layout) continue
        const s = (p: Candidate): Pt => [p.x * f, p.y * f]
        const code: Pt[] = layout.anchors.slice(0, 3).map((a) => [a.cx, a.cy])
        const seed = fitAffine(code, [s(t.tl), s(t.tr), s(t.bl)])
        if (!seed) continue
        const lock = refineAll(gray, w, h, layout, seed, 1.5, 'scan', Math.max(4, Math.ceil(layout.anchors.length * 0.5)), hi - lo)
        if (lock) locks.push(lock)
      }
      if (locks.length) break
    }
    return locks
  }
}
