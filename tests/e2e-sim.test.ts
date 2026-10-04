import { describe, expect, it } from 'vitest'
import { PROFILES } from '../src/engine/profiles'
import { runTransfer } from '../src/sim/run'
import { Rng } from '../src/engine/prng'

const rand = (n: number, seed: number) => {
  const r = new Rng(seed)
  return Uint8Array.from({ length: n }, () => r.int(256))
}

describe('end to end through the simulated camera', () => {
  it('200-byte text on balanced, moderate channel, finishes within a few seconds', async () => {
    const bytes = new TextEncoder().encode('The quick brown fox jumps over the lazy dog. '.repeat(4))
    const r = await runTransfer({ profile: PROFILES[1]!, bytes, preset: 'moderate', seed: 3, maxSeconds: 20 })
    console.log('text', JSON.stringify(r))
    expect(r.ok).toBe(true)
    expect(r.seconds).toBeLessThan(5)
  }, 120_000)

  it('late start (mid-stream) still completes, 6 KB, easy channel', async () => {
    const r = await runTransfer({ profile: PROFILES[1]!, bytes: rand(6_000, 5), preset: 'easy', seed: 4, startCounter: 37, maxSeconds: 60 })
    console.log('late', JSON.stringify(r))
    expect(r.ok).toBe(true)
  }, 300_000)
})
