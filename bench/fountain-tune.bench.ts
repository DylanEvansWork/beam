import { it } from 'vitest'
import * as F from '../src/engine/fountain'
import { Rng } from '../src/engine/prng'

// Scratch tuning bench: repair-only reception (late joiner), measures overhead for soliton params.
it('tune', () => {
  const out: string[] = []
  for (const [c, d] of [[0.05, 0.5], [0.1, 0.5], [0.02, 0.5], [0.1, 0.1], [0.2, 0.5], [0.3, 0.5], [0.5, 0.5]] as const) {
    ;(F as any).__setParams?.(c, d)
    for (const K of [50, 300, 1000]) {
      const ov: number[] = []
      for (let t = 0; t < 12; t++) {
        const rng = new Rng(t + K)
        const src = Array.from({ length: K }, () => Uint8Array.from({ length: 8 }, () => rng.int(256)))
        const dec = new F.FountainDecoder(K, 8, t + 1)
        let i = K + 5
        while (!dec.complete) { dec.add(i, F.encodeSymbol(src, t + 1, i)); i++ }
        ov.push(dec.received / K - 1)
      }
      ov.sort((a, b) => a - b)
      out.push(`c=${c} d=${d} K=${K} mean ${(100 * ov.reduce((a, b) => a + b, 0) / ov.length).toFixed(1)}% max ${(100 * ov[ov.length - 1]!).toFixed(1)}%`)
    }
  }
  console.log(out.join('\n'))
})
