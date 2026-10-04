import { describe, expect, it } from 'vitest'
import { FountainDecoder } from '../src/engine/fountain'
import { PKT_DATA, PKT_META, decodePacket, parseMeta, serializeMeta } from '../src/engine/packets'
import { PROFILES } from '../src/engine/profiles'
import {
  FrameSource, bestCaseBytesPerSecond, estimateSeconds, finishTransfer, prepareTransfer,
} from '../src/engine/session'
import { bitsToHeader, cellsToStream, headerToBits, streamToPackets, tierOf } from '../src/engine/framing'
import { Rng } from '../src/engine/prng'
import type { Meta } from '../src/engine/packets'

describe('meta', () => {
  it('round-trips, clamps long names without splitting characters', () => {
    const sha = new Uint8Array(32).map((_, i) => i)
    const m: Meta = {
      version: 1, tier: 1, session: 9, K: 12, symbolSize: 196, compressed: true,
      originalSize: 2000, streamSize: 1500, sha256: sha, name: 'phóto.jpg', mime: 'image/jpeg',
    }
    expect(parseMeta(9, serializeMeta(m))).toEqual(m)
    const long = serializeMeta({ ...m, name: 'é'.repeat(40) })
    expect(parseMeta(9, long)!.name).toBe('é'.repeat(16))
  })
})

/** Pull every packet out of every clean frame and feed a fountain decoder. */
async function transfer(bytes: Uint8Array, profileId: number, startFrame: number, dropProb: number) {
  const profile = PROFILES[profileId]!
  const prepared = await prepareTransfer({ bytes, name: 'x.bin', mime: 'application/octet-stream' }, profile, 4242)
  const src = new FrameSource(prepared)
  const l = src.layout
  const rng = new Rng(profileId + startFrame)
  let dec: FountainDecoder | null = null
  let meta: Meta | null = null
  let frames = 0
  for (let c = startFrame; c < startFrame + 2000 && !(dec && dec.complete); c++) {
    frames++
    const cells = src.frame(c)
    const header = src.header(c, 0)
    const stream = cellsToStream(l, Array.from(l.dataCells, (i) => cells[i]!), header)
    for (const raw of streamToPackets(l, stream)) {
      if (rng.float() < dropProb) continue
      const pk = decodePacket(l.packet, raw.bytes)
      if (!pk) continue
      if (pk.type === PKT_META) {
        meta = parseMeta(pk.session, pk.payload)
        if (meta && !dec) dec = new FountainDecoder(meta.K, meta.symbolSize, meta.session)
      } else if (pk.type === PKT_DATA && dec) dec.add(pk.index, pk.payload)
    }
  }
  expect(dec?.complete).toBe(true)
  const out = await finishTransfer(meta!, dec!.data())
  return { out, frames }
}

describe('session end-to-end on clean frames', () => {
  it('tiny text completes after ONE frame', async () => {
    const bytes = new TextEncoder().encode('hello from beam')
    const { out, frames } = await transfer(bytes, 1, 0, 0)
    expect(new TextDecoder().decode(out)).toBe('hello from beam')
    expect(frames).toBe(1)
  })

  it('100 KB incompressible file, all tiers, late start + 20% packet loss', async () => {
    const rng = new Rng(3)
    const bytes = Uint8Array.from({ length: 100_000 }, () => rng.int(256))
    for (const id of [0, 1, 2, 3]) {
      const { out } = await transfer(bytes, id, 17 + id, 0.2)
      expect(Buffer.from(out).equals(Buffer.from(bytes))).toBe(true)
    }
  })

  it('compresses compressible data', async () => {
    const bytes = new TextEncoder().encode('abc '.repeat(5000))
    const prepared = await prepareTransfer({ bytes, name: 't.txt', mime: 'text/plain' }, PROFILES[1]!, 1)
    expect(prepared.meta.compressed).toBe(true)
    expect(prepared.meta.streamSize).toBeLessThan(bytes.length / 10)
  })

  it('rejects a corrupted result via the hash', async () => {
    const bytes = new TextEncoder().encode('integrity matters '.repeat(40))
    const prepared = await prepareTransfer({ bytes, name: 't.txt', mime: 'text/plain' }, PROFILES[1]!, 1)
    const stream = new Uint8Array(prepared.meta.K * prepared.meta.symbolSize)
    prepared.symbols.forEach((s, i) => stream.set(s, i * s.length))
    stream[5] = stream[5]! ^ 1
    await expect(finishTransfer(prepared.meta, stream)).rejects.toThrow()
  })

  it('frames are deterministic in (session, counter)', async () => {
    const bytes = new Uint8Array(3000).map((_, i) => (i * 7) & 255)
    const p = await prepareTransfer({ bytes, name: 'a', mime: 'x' }, PROFILES[1]!, 99)
    const a = new FrameSource(p).frame(123)
    const b = new FrameSource(p).frame(123)
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
    expect(tierOf(new FrameSource(p).header(5, 0).tierKind)).toBe(1)
    expect(bitsToHeader(headerToBits(new FrameSource(p).header(65537, 0)))!.counter).toBe(1)
  })

  it('prints best-case speeds', () => {
    const rows = PROFILES.map(
      (p) =>
        `${p.name.padEnd(9)} best-case ${(bestCaseBytesPerSecond(p) / 1024).toFixed(1)} KB/s  (100 KB in ${estimateSeconds(100_000, p).toFixed(0)} s)`,
    )
    console.log(rows.join('\n'))
  })
})
