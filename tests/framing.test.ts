import { describe, expect, it } from 'vitest'
import {
  KIND_DATA, bitsToHeader, buildFrameCells, buildLayout, cellsToStream, headerToBits, makeTierKind,
  streamToPackets, rasterize, rasterSize, NONE,
} from '../src/engine/framing'
import { PROFILES } from '../src/engine/profiles'
import { PKT_DATA, decodePacket, encodePacket, payloadSize } from '../src/engine/packets'
import { Rng } from '../src/engine/prng'
import { PROTOCOL_VERSION } from '../src/engine/version'

describe('layouts', () => {
  it('builds for every tier with sane capacity', () => {
    const rows: string[] = []
    for (const p of PROFILES) {
      const l = buildLayout(p)
      rows.push(
        `${p.name.padEnd(9)} G=${l.G} data cells=${l.dataCells.length} cap=${l.capBytes}B packet n=${l.packet.n} parity=${l.packet.parity} payload=${payloadSize(l.packet)} x${l.packetsPerFrame}`,
      )
      expect(payloadSize(l.packet)).toBeGreaterThanOrEqual(107)
      // disjoint: data cells never overlap static content
      for (const c of l.dataCells) expect(l.staticCode[c]).toBe(NONE)
      expect(l.pilotCells.length).toBeGreaterThan(20)
    }
    console.log(rows.join('\n'))
  })
})

describe('header', () => {
  it('round-trips and rejects corruption', () => {
    const h = { version: PROTOCOL_VERSION, tierKind: makeTierKind(2, KIND_DATA), session: 0xabcd, counter: 0x1234 }
    expect(bitsToHeader(headerToBits(h))).toEqual(h)
    const bits = headerToBits(h)
    bits[20] = bits[20]! ^ 1
    expect(bitsToHeader(bits)).toBeNull()
  })
})

describe('bytes -> frame -> bytes (clean)', () => {
  for (const p of PROFILES) {
    for (const interleave of [true, false]) {
      it(`${p.name} interleave=${interleave}`, () => {
        const l = buildLayout({ ...p, interleave })
        const rng = new Rng(p.id + 5)
        const header = { version: PROTOCOL_VERSION, tierKind: makeTierKind(p.id, KIND_DATA), session: 777, counter: 42 }
        const N = payloadSize(l.packet)
        const payloads = Array.from({ length: l.packetsPerFrame }, () => Uint8Array.from({ length: N }, () => rng.int(256)))
        const packets = payloads.map((pl, i) => encodePacket(l.packet, PKT_DATA, 777, 1000 + i, pl))
        const cells = buildFrameCells(l, header, packets)
        // read data cell values straight from the codes
        const values = Array.from(l.dataCells, (c) => cells[c]!)
        const stream = cellsToStream(l, values, header)
        const back = streamToPackets(l, stream)
        back.forEach((b, i) => {
          const pk = decodePacket(l.packet, b.bytes)
          expect(pk).not.toBeNull()
          expect(pk!.index).toBe(1000 + i)
          expect(Array.from(pk!.payload)).toEqual(Array.from(payloads[i]!))
        })
        const img = rasterize(l, cells, 4)
        expect(img.width).toBe(rasterSize(l, 4))
      })
    }
  }
})
