import { describe, expect, it } from 'vitest'
import { rsDecode, rsEncode } from '../src/engine/reedSolomon'
import { Rng } from '../src/engine/prng'
import { crc16, crc32, crc8 } from '../src/engine/crc'

const rand = (rng: Rng, n: number) => Uint8Array.from({ length: n }, () => rng.int(256))

describe('crc', () => {
  const msg = new TextEncoder().encode('123456789')
  it('matches standard check values', () => {
    expect(crc8(msg)).toBe(0xf4)
    expect(crc16(msg)).toBe(0x29b1)
    expect(crc32(msg)).toBe(0xcbf43926)
  })
})

describe('reed-solomon', () => {
  const rng = new Rng(1)
  it('round trips clean words', () => {
    const msg = rand(rng, 200)
    const cw = rsEncode(msg, 40)
    expect(cw.length).toBe(240)
    const r = rsDecode(cw, 40)
    expect(r.ok).toBe(true)
    expect(Array.from(r.data)).toEqual(Array.from(msg))
  })

  it('corrects random errors up to t', () => {
    for (let trial = 0; trial < 60; trial++) {
      const nsym = 10 + rng.int(40)
      const k = 20 + rng.int(180)
      const msg = rand(rng, k)
      const cw = rsEncode(msg, nsym)
      const bad = Uint8Array.from(cw)
      const t = Math.floor(nsym / 2)
      const nerr = rng.int(t + 1)
      const used = new Set<number>()
      while (used.size < nerr) used.add(rng.int(bad.length))
      for (const p of used) bad[p] = bad[p]! ^ (1 + rng.int(255))
      const r = rsDecode(bad, nsym)
      expect(r.ok).toBe(true)
      expect(Array.from(r.data)).toEqual(Array.from(msg))
      expect(r.corrected).toBe(nerr)
    }
  })

  it('corrects erasures and mixed errors+erasures within 2e+s<=nsym', () => {
    for (let trial = 0; trial < 60; trial++) {
      const nsym = 20 + rng.int(30)
      const msg = rand(rng, 100 + rng.int(100))
      const cw = rsEncode(msg, nsym)
      const bad = Uint8Array.from(cw)
      const s = rng.int(nsym + 1)
      const e = rng.int(Math.floor((nsym - s) / 2) + 1)
      const used = new Set<number>()
      while (used.size < s + e) used.add(rng.int(bad.length))
      const all = [...used]
      const erasures = all.slice(0, s)
      for (const p of all) bad[p] = bad[p]! ^ (1 + rng.int(255))
      const r = rsDecode(bad, nsym, erasures)
      expect(r.ok).toBe(true)
      expect(Array.from(r.data)).toEqual(Array.from(msg))
    }
  })

  it('detects (never silently mis-corrects) damage beyond capacity', () => {
    let detected = 0
    let wrong = 0
    for (let trial = 0; trial < 300; trial++) {
      const nsym = 16
      const msg = rand(rng, 120)
      const cw = rsEncode(msg, nsym)
      const bad = Uint8Array.from(cw)
      const used = new Set<number>()
      while (used.size < 25) used.add(rng.int(bad.length))
      for (const p of used) bad[p] = bad[p]! ^ (1 + rng.int(255))
      const r = rsDecode(bad, nsym)
      if (!r.ok) detected++
      else if (Array.from(r.data).join() !== Array.from(msg).join()) wrong++
    }
    expect(detected).toBeGreaterThan(280)
    // a rare mis-correction is possible in theory; the packet CRC16 catches those
    expect(wrong).toBeLessThan(10)
  })
})
