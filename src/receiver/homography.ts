/** 3x3 homographies as 9-element row-major arrays, h[8] = 1. Maps code coordinates -> image coordinates. */
export type Mat3 = number[]
export type Pt = [number, number]

export function applyH(h: Mat3, x: number, y: number): Pt {
  const w = h[6]! * x + h[7]! * y + h[8]!
  return [(h[0]! * x + h[1]! * y + h[2]!) / w, (h[3]! * x + h[4]! * y + h[5]!) / w]
}

/** Solve A x = b (n x n) by Gaussian elimination with partial pivoting. Null if singular. */
export function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length
  const M = A.map((r, i) => [...r, b[i]!])
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r
    if (Math.abs(M[p]![c]!) < 1e-12) return null
    ;[M[c], M[p]] = [M[p]!, M[c]!]
    for (let r = c + 1; r < n; r++) {
      const f = M[r]![c]! / M[c]![c]!
      if (f === 0) continue
      for (let k = c; k <= n; k++) M[r]![k] = M[r]![k]! - f * M[c]![k]!
    }
  }
  const x = new Array<number>(n).fill(0)
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r]![n]!
    for (let k = r + 1; k < n; k++) s -= M[r]![k]! * x[k]!
    x[r] = s / M[r]![r]!
  }
  return x
}

function normalise(pts: Pt[]): { T: Mat3; pts: Pt[] } {
  let cx = 0
  let cy = 0
  for (const [x, y] of pts) { cx += x; cy += y }
  cx /= pts.length
  cy /= pts.length
  let d = 0
  for (const [x, y] of pts) d += Math.hypot(x - cx, y - cy)
  d /= pts.length
  const s = d > 1e-9 ? Math.SQRT2 / d : 1
  return { T: [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1], pts: pts.map(([x, y]) => [(x - cx) * s, (y - cy) * s] as Pt) }
}

const mul = (a: Mat3, b: Mat3): Mat3 => {
  const o = new Array<number>(9).fill(0)
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j]! += a[i * 3 + k]! * b[k * 3 + j]!
  return o
}

export const inv3 = (m: Mat3): Mat3 | null => {
  const [a, b, c, d, e, f, g, h, i] = m as [number, number, number, number, number, number, number, number, number]
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C
  if (Math.abs(det) < 1e-14) return null
  const r = 1 / det
  return [A * r, -(b * i - c * h) * r, (b * f - c * e) * r, B * r, (a * i - c * g) * r, -(a * f - c * d) * r, C * r, -(a * h - b * g) * r, (a * e - b * d) * r]
}

/** Least-squares homography (DLT, Hartley-normalised) from >= 4 correspondences. */
export function fitHomography(src: Pt[], dst: Pt[]): Mat3 | null {
  if (src.length < 4 || src.length !== dst.length) return null
  const s = normalise(src)
  const d = normalise(dst)
  const AtA = Array.from({ length: 8 }, () => new Array<number>(8).fill(0))
  const Atb = new Array<number>(8).fill(0)
  const add = (row: number[], rhs: number) => {
    for (let i = 0; i < 8; i++) {
      Atb[i]! += row[i]! * rhs
      for (let j = 0; j < 8; j++) AtA[i]![j]! += row[i]! * row[j]!
    }
  }
  for (let i = 0; i < src.length; i++) {
    const [X, Y] = s.pts[i]!
    const [x, y] = d.pts[i]!
    add([X, Y, 1, 0, 0, 0, -x * X, -x * Y], x)
    add([0, 0, 0, X, Y, 1, -y * X, -y * Y], y)
  }
  const h = solveLinear(AtA, Atb)
  if (!h) return null
  const Hn: Mat3 = [...h, 1]
  const Ti = inv3(d.T)
  if (!Ti) return null
  const H = mul(mul(Ti, Hn), s.T)
  const k = H[8]!
  if (Math.abs(k) < 1e-14) return null
  return H.map((v) => v / k)
}

/** Least-squares affine map (as a Mat3 with h6=h7=0) from >= 3 correspondences. */
export function fitAffine(src: Pt[], dst: Pt[]): Mat3 | null {
  if (src.length < 3) return null
  const AtA = Array.from({ length: 3 }, () => new Array<number>(3).fill(0))
  const bx = [0, 0, 0]
  const by = [0, 0, 0]
  for (let i = 0; i < src.length; i++) {
    const r = [src[i]![0], src[i]![1], 1]
    for (let a = 0; a < 3; a++) {
      bx[a]! += r[a]! * dst[i]![0]
      by[a]! += r[a]! * dst[i]![1]
      for (let b = 0; b < 3; b++) AtA[a]![b]! += r[a]! * r[b]!
    }
  }
  const px = solveLinear(AtA, bx)
  const py = solveLinear(AtA, by)
  if (!px || !py) return null
  return [px[0]!, px[1]!, px[2]!, py[0]!, py[1]!, py[2]!, 0, 0, 1]
}

/** Approx local scale (image px per cell) at a code point. */
export function localScale(h: Mat3, x: number, y: number): number {
  const [x0, y0] = applyH(h, x, y)
  const [x1, y1] = applyH(h, x + 1, y)
  const [x2, y2] = applyH(h, x, y + 1)
  return (Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x0, y2 - y0)) / 2
}
