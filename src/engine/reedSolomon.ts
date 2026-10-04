import { EXP, gfDiv, gfMul, gfPowAlpha } from './gf256'

/**
 * Systematic Reed-Solomon over GF(256), roots alpha^0..alpha^(nsym-1), codeword length n <= 255.
 * Layout: [message bytes..., parity bytes...]; byte i has polynomial degree n-1-i.
 */

const genCache = new Map<number, Uint8Array>()

function generator(nsym: number): Uint8Array {
  let g = genCache.get(nsym)
  if (g) return g
  // lowest-degree-first coefficients of prod (x - alpha^i)
  let poly = [1]
  for (let i = 0; i < nsym; i++) {
    const r = gfPowAlpha(i)
    const next = new Array<number>(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j++) {
      next[j + 1] = next[j + 1]! ^ poly[j]!
      next[j] = next[j]! ^ gfMul(poly[j]!, r)
    }
    poly = next
  }
  g = Uint8Array.from(poly)
  genCache.set(nsym, g)
  return g
}

/** Returns n = msg.length + nsym bytes. */
export function rsEncode(msg: Uint8Array, nsym: number): Uint8Array {
  if (msg.length + nsym > 255) throw new Error('RS codeword too long')
  const g = generator(nsym) // g[nsym] == 1
  const out = new Uint8Array(msg.length + nsym)
  out.set(msg)
  // polynomial long division, highest degree first
  for (let i = 0; i < msg.length; i++) {
    const coef = out[i]!
    if (coef === 0) continue
    for (let j = 1; j <= nsym; j++) out[i + j] = out[i + j]! ^ gfMul(g[nsym - j]!, coef)
  }
  out.set(msg) // long division clobbered the message part
  return out
}

function syndromes(cw: Uint8Array, nsym: number): number[] {
  const s = new Array<number>(nsym).fill(0)
  let any = false
  for (let i = 0; i < nsym; i++) {
    const x = EXP[i]!
    let acc = 0
    for (let j = 0; j < cw.length; j++) acc = gfMul(acc, x) ^ cw[j]!
    s[i] = acc
    if (acc) any = true
  }
  return any ? s : []
}

function polyEval(p: number[], x: number): number {
  // lowest-degree-first
  let acc = 0
  for (let i = p.length - 1; i >= 0; i--) acc = gfMul(acc, x) ^ p[i]!
  return acc
}

function polyMul(a: number[], b: number[]): number[] {
  const out = new Array<number>(a.length + b.length - 1).fill(0)
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < b.length; j++) out[i + j] = out[i + j]! ^ gfMul(a[i]!, b[j]!)
  return out
}

function berlekampMassey(s: number[]): number[] {
  let C = [1]
  let B = [1]
  let L = 0
  let m = 1
  let b = 1
  for (let n = 0; n < s.length; n++) {
    let d = s[n]!
    for (let i = 1; i <= L; i++) d ^= gfMul(C[i] ?? 0, s[n - i]!)
    if (d === 0) {
      m++
    } else {
      const coef = gfDiv(d, b)
      const T = C.slice()
      const need = B.length + m
      while (C.length < need) C.push(0)
      for (let i = 0; i < B.length; i++) C[i + m] = C[i + m]! ^ gfMul(coef, B[i]!)
      if (2 * L <= n) {
        L = n + 1 - L
        B = T
        b = d
        m = 1
      } else {
        m++
      }
    }
  }
  C.length = L + 1
  for (let i = 0; i <= L; i++) C[i] = C[i] ?? 0
  return C
}

export interface RsResult {
  ok: boolean
  /** Corrected message bytes (without parity). Only meaningful when ok. */
  data: Uint8Array
  /** Number of byte positions corrected (errors + erasures that were actually wrong). */
  corrected: number
}

/**
 * Decode with optional erasure positions (indices into the codeword array).
 * Succeeds only if the corrected word has all-zero syndromes; otherwise reports failure
 * rather than returning a mis-correction. Capacity: 2*errors + erasures <= nsym.
 */
export function rsDecode(received: Uint8Array, nsym: number, erasures: number[] = []): RsResult {
  const n = received.length
  const kLen = n - nsym
  const cw = Uint8Array.from(received)
  const fail: RsResult = { ok: false, data: cw.subarray(0, kLen), corrected: 0 }
  const S = syndromes(cw, nsym)
  if (S.length === 0) return { ok: true, data: cw.subarray(0, kLen), corrected: 0 }
  if (erasures.length > nsym) return fail

  // erasure locator Gamma(x) = prod (1 - X_j x), X_j = alpha^(n-1-pos)
  let gamma = [1]
  for (const pos of erasures) gamma = polyMul(gamma, [1, gfPowAlpha(n - 1 - pos)])
  const e = erasures.length

  // modified (Forney) syndromes
  const T = polyMul(S, gamma).slice(0, nsym)
  while (T.length < nsym) T.push(0)
  const lambdaErr = berlekampMassey(T.slice(e))
  const psi = polyMul(lambdaErr, gamma)
  const degPsi = psi.length - 1 - (psi.slice().reverse().findIndex((c) => c !== 0))
  const deg = Math.max(0, degPsi)
  if (2 * (lambdaErr.length - 1) + e > nsym) return fail

  // Chien search over all codeword positions
  const positions: number[] = []
  for (let pos = 0; pos < n; pos++) {
    const xinv = gfPowAlpha(-(n - 1 - pos))
    if (polyEval(psi, xinv) === 0) positions.push(pos)
  }
  if (positions.length !== deg) return fail

  // error evaluator Omega = S * Psi mod x^nsym
  const omega = polyMul(S, psi).slice(0, nsym)
  // formal derivative of Psi
  const dpsi: number[] = []
  for (let i = 1; i < psi.length; i += 2) {
    dpsi[i - 1] = psi[i]!
    if (i - 1 > 0 && dpsi[i - 2] === undefined) dpsi[i - 2] = 0
  }
  for (let i = 0; i < dpsi.length; i++) dpsi[i] = dpsi[i] ?? 0

  let corrected = 0
  for (const pos of positions) {
    const X = gfPowAlpha(n - 1 - pos)
    const Xinv = gfPowAlpha(-(n - 1 - pos))
    const denom = polyEval(dpsi, Xinv)
    if (denom === 0) return fail
    const mag = gfMul(X, gfDiv(polyEval(omega, Xinv), denom))
    if (mag !== 0) corrected++
    cw[pos] = cw[pos]! ^ mag
  }
  if (syndromes(cw, nsym).length !== 0) return fail
  return { ok: true, data: cw.subarray(0, kLen), corrected }
}
