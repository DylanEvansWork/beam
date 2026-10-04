import { Rng } from './prng'

/**
 * Systematic LT-style fountain code.
 * Each symbol is the XOR of a pseudo-random subset of source symbols, with the subset and degree
 * (robust soliton) derived deterministically from (session, index), so the receiver recomputes
 * neighbours without them being transmitted. For tiny K the first K symbols are the plain sources.
 * Decoder: peeling, plus incremental GF(2) Gaussian elimination when peeling stalls.
 */

export let SOLITON_C = 0.1
export let SOLITON_DELTA = 0.1

/**
 * Up to this K the first K symbols are the plain source symbols (systematic). Above it every symbol is
 * LT-coded: measured, a systematic first pass followed by repair symbols costs ~30% reception overhead
 * under packet loss (repair symbols mostly touch already-known sources), versus ~3-6% for pure LT
 * with Gaussian fallback. See DECISIONS.md.
 */
export const SYSTEMATIC_MAX_K = 40

/** Test/bench hook only. */
export function __setParams(c: number, delta: number): void {
  SOLITON_C = c
  SOLITON_DELTA = delta
  cdfCache.clear()
}

const cdfCache = new Map<number, Float64Array>()

/** Cumulative distribution over degrees 1..K (index d-1) of the robust soliton distribution. */
function robustSolitonCdf(K: number): Float64Array {
  let cdf = cdfCache.get(K)
  if (cdf) return cdf
  const rho = new Float64Array(K + 1)
  rho[1] = 1 / K
  for (let d = 2; d <= K; d++) rho[d] = 1 / (d * (d - 1))
  const R = Math.max(1, SOLITON_C * Math.log(K / SOLITON_DELTA) * Math.sqrt(K))
  const tau = new Float64Array(K + 1)
  const pivot = Math.min(K, Math.max(1, Math.round(K / R)))
  for (let d = 1; d < pivot; d++) tau[d] = R / (d * K)
  tau[pivot] = (R * Math.log(R / SOLITON_DELTA)) / K
  if (!(tau[pivot]! > 0)) tau[pivot] = 0
  let Z = 0
  for (let d = 1; d <= K; d++) Z += rho[d]! + tau[d]!
  cdf = new Float64Array(K)
  let acc = 0
  for (let d = 1; d <= K; d++) {
    acc += (rho[d]! + tau[d]!) / Z
    cdf[d - 1] = acc
  }
  cdf[K - 1] = 1
  cdfCache.set(K, cdf)
  return cdf
}

/** Source indices XORed into symbol `index`. Deterministic in (K, session, index). */
export function neighbors(K: number, session: number, index: number): number[] {
  const systematic = K <= SYSTEMATIC_MAX_K
  if (systematic && index < K) return [index]
  const rng = new Rng(session * 0x10001 + 12345, index)
  const cdf = robustSolitonCdf(K)
  const u = rng.float()
  let lo = 0
  let hi = K - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (cdf[mid]! >= u) hi = mid
    else lo = mid + 1
  }
  const degree = lo + 1
  if (degree >= K) return Array.from({ length: K }, (_, i) => i)
  const chosen = new Set<number>()
  while (chosen.size < degree) chosen.add(rng.int(K))
  return [...chosen].sort((a, b) => a - b)
}

export function xorInto(dst: Uint8Array, src: Uint8Array): void {
  const n = dst.length
  let i = 0
  // 32-bit chunks when both are aligned views
  if (((dst.byteOffset | src.byteOffset) & 3) === 0) {
    const d32 = new Uint32Array(dst.buffer, dst.byteOffset, n >> 2)
    const s32 = new Uint32Array(src.buffer, src.byteOffset, n >> 2)
    for (; i < d32.length; i++) d32[i] = d32[i]! ^ s32[i]!
    i <<= 2
  }
  for (; i < n; i++) dst[i] = dst[i]! ^ src[i]!
}

export function encodeSymbol(sources: Uint8Array[], session: number, index: number): Uint8Array {
  const K = sources.length
  const out = new Uint8Array(sources[0]!.length)
  for (const s of neighbors(K, session, index)) xorInto(out, sources[s]!)
  return out
}

interface Equation {
  nb: number[]
  val: Uint8Array
}

export class FountainDecoder {
  readonly K: number
  readonly symbolSize: number
  readonly session: number
  private solved: (Uint8Array | null)[]
  private nSolved = 0
  private seen = new Set<number>()
  private watchers: Equation[][]
  private live = new Set<Equation>()
  private sinceGauss = 0
  /** Distinct symbols received (including useless ones). */
  received = 0

  constructor(K: number, symbolSize: number, session: number) {
    this.K = K
    this.symbolSize = symbolSize
    this.session = session
    this.solved = new Array(K).fill(null)
    this.watchers = Array.from({ length: K }, () => [])
  }

  get solvedCount(): number {
    return this.nSolved
  }

  get complete(): boolean {
    return this.nSolved === this.K
  }

  /** Reception overhead so far: received/K - 1. */
  get overhead(): number {
    return this.received / this.K - 1
  }

  /** Feed one symbol. Returns true if it was new. Safe to call with duplicates / any order. */
  add(index: number, payload: Uint8Array): boolean {
    if (this.complete || this.seen.has(index) || payload.length !== this.symbolSize) return false
    this.seen.add(index)
    this.received++
    const nbAll = neighbors(this.K, this.session, index)
    const val = Uint8Array.from(payload)
    const nb: number[] = []
    for (const s of nbAll) {
      const sv = this.solved[s]
      if (sv) xorInto(val, sv)
      else nb.push(s)
    }
    this.accept({ nb, val })
    this.sinceGauss++
    if (!this.complete) this.maybeGauss()
    return true
  }

  private accept(eq: Equation): void {
    if (eq.nb.length === 0) return
    if (eq.nb.length === 1) {
      this.solve(eq.nb[0]!, eq.val)
      return
    }
    this.live.add(eq)
    for (const s of eq.nb) this.watchers[s]!.push(eq)
  }

  private solve(start: number, startVal: Uint8Array): void {
    const queue: [number, Uint8Array][] = [[start, startVal]]
    while (queue.length) {
      const [s, v] = queue.pop()!
      if (this.solved[s]) continue
      this.solved[s] = v
      this.nSolved++
      const ws = this.watchers[s]!
      this.watchers[s] = []
      for (const eq of ws) {
        if (!this.live.has(eq)) continue
        const i = eq.nb.indexOf(s)
        if (i < 0) continue
        eq.nb.splice(i, 1)
        xorInto(eq.val, v)
        if (eq.nb.length === 1) {
          this.live.delete(eq)
          queue.push([eq.nb[0]!, eq.val])
        } else if (eq.nb.length === 0) {
          this.live.delete(eq)
        }
      }
    }
  }

  private maybeGauss(): void {
    const unsolved = this.K - this.nSolved
    if (this.live.size < unsolved || this.received < this.K) return
    if (this.sinceGauss < Math.max(1, Math.floor(unsolved / 25))) return
    this.sinceGauss = 0
    this.gauss()
  }

  /** GF(2) elimination over the still-unknown sources. Solves everything iff full rank. */
  private gauss(): void {
    const cols: number[] = []
    const colOf = new Map<number, number>()
    for (let s = 0; s < this.K; s++)
      if (!this.solved[s]) {
        colOf.set(s, cols.length)
        cols.push(s)
      }
    const U = cols.length
    const words = (U + 31) >>> 5
    const rows = [...this.live].filter((eq) => eq.nb.every((s) => colOf.has(s)))
    // pivot[c] = row index whose leading column is c
    const pivRows: { bits: Uint32Array; val: Uint8Array }[] = new Array(U)
    let rank = 0
    for (const eq of rows) {
      const bits = new Uint32Array(words)
      for (const s of eq.nb) {
        const c = colOf.get(s)!
        bits[c >>> 5] = bits[c >>> 5]! | (1 << (c & 31))
      }
      const val = Uint8Array.from(eq.val)
      for (;;) {
        // find leading set bit
        let lead = -1
        for (let w = 0; w < words && lead < 0; w++) {
          const x = bits[w]!
          if (x) lead = (w << 5) + (31 - Math.clz32(x & -x))
        }
        if (lead < 0) break
        const p = pivRows[lead]
        if (!p) {
          pivRows[lead] = { bits, val }
          rank++
          break
        }
        for (let w = 0; w < words; w++) bits[w] = bits[w]! ^ p.bits[w]!
        xorInto(val, p.val)
      }
    }
    if (rank < U) return
    // back substitution from the highest column down (pivot rows only have bits >= lead)
    for (let c = U - 1; c >= 0; c--) {
      const p = pivRows[c]!
      for (let c2 = c + 1; c2 < U; c2++) {
        if (p.bits[c2 >>> 5]! & (1 << (c2 & 31))) xorInto(p.val, pivRows[c2]!.val)
      }
    }
    for (let c = 0; c < U; c++) {
      const s = cols[c]!
      if (!this.solved[s]) {
        this.solved[s] = pivRows[c]!.val
        this.nSolved++
      }
    }
    this.live.clear()
  }

  /** The K source symbols concatenated. Only valid when complete. */
  data(): Uint8Array {
    if (!this.complete) throw new Error('fountain decoder not complete')
    const out = new Uint8Array(this.K * this.symbolSize)
    for (let i = 0; i < this.K; i++) out.set(this.solved[i]!, i * this.symbolSize)
    return out
  }
}
