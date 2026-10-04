import { describe, expect, it } from 'vitest'
import { FountainDecoder, encodeSymbol, neighbors } from '../src/engine/fountain'
import { Rng } from '../src/engine/prng'

const makeSources = (K: number, size: number, seed: number) => {
  const rng = new Rng(seed)
  return Array.from({ length: K }, () => Uint8Array.from({ length: size }, () => rng.int(256)))
}
const concat = (s: Uint8Array[]) => {
  const o = new Uint8Array(s.length * s[0]!.length)
  s.forEach((x, i) => o.set(x, i * x.length))
  return o
}

/** Feeds symbols (with the given loss pattern) until complete; returns symbols received. */
function run(K: number, size: number, seed: number, loss: number, order: 'seq' | 'shuffled') {
  const sources = makeSources(K, size, seed)
  const session = (seed * 7919) & 0xffff
  const dec = new FountainDecoder(K, size, session)
  const rng = new Rng(seed + 99)
  let idx = 0
  const pool: number[] = []
  let sent = 0
  while (!dec.complete && sent < K * 4 + 200) {
    let i: number
    if (order === 'seq') i = idx++
    else {
      if (pool.length === 0) for (let j = 0; j < 64; j++) pool.push(idx++)
      i = pool.splice(rng.int(pool.length), 1)[0]!
    }
    sent++
    if (rng.float() < loss) continue
    dec.add(i, encodeSymbol(sources, session, i))
  }
  expect(dec.complete).toBe(true)
  expect(Array.from(dec.data())).toEqual(Array.from(concat(sources)))
  return dec.received
}

describe('fountain', () => {
  it('neighbors are deterministic and in range', () => {
    const a = neighbors(100, 5, 250)
    expect(neighbors(100, 5, 250)).toEqual(a)
    expect(a.every((x) => x >= 0 && x < 100)).toBe(true)
    expect(new Set(a).size).toBe(a.length)
    expect(neighbors(30, 5, 7)).toEqual([7]) // systematic for small K
  })

  it('tiny K works (K=1,2,3)', () => {
    for (const K of [1, 2, 3, 5]) run(K, 16, K, 0, 'seq')
    for (const K of [1, 2, 3, 5]) run(K, 16, K + 10, 0.4, 'seq')
  })

  it('round-trips with loss, reordering, duplicates', () => {
    for (const K of [10, 50, 200]) {
      for (const loss of [0, 0.2, 0.5]) {
        run(K, 32, K + 3, loss, 'seq')
        run(K, 32, K + 5, loss, 'shuffled')
      }
    }
  })

  it('ignores duplicate and wrong-size symbols', () => {
    const sources = makeSources(5, 8, 1)
    const d = new FountainDecoder(5, 8, 9)
    expect(d.add(0, encodeSymbol(sources, 9, 0))).toBe(true)
    expect(d.add(0, encodeSymbol(sources, 9, 0))).toBe(false)
    expect(d.add(1, new Uint8Array(3))).toBe(false)
  })

  it('reports measured reception overhead (printed, loosely bounded)', () => {
    const rows: string[] = []
    for (const K of [20, 100, 300, 1000]) {
      const trials = K >= 1000 ? 5 : 20
      const ov: number[] = []
      for (let t = 0; t < trials; t++) ov.push(run(K, 16, 1000 + t * 13 + K, 0.3, 'shuffled') / K - 1)
      ov.sort((a, b) => a - b)
      rows.push(
        `K=${String(K).padStart(5)}  mean ${(100 * ov.reduce((a, b) => a + b, 0) / ov.length).toFixed(1)}%  p50 ${(100 * ov[ov.length >> 1]!).toFixed(1)}%  max ${(100 * ov[ov.length - 1]!).toFixed(1)}%`,
      )
    }
    console.log('fountain reception overhead (30% random loss, shuffled)\n' + rows.join('\n'))
  })
})
