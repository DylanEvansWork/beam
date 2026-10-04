import { describe, expect, it } from 'vitest'
import { KIND_TEST, buildLayout, kindOf, rasterize, tierOf } from '../src/engine/framing'
import { PKT_TEST } from '../src/engine/packets'
import { PROFILES } from '../src/engine/profiles'
import { buildTestFrame, testPayload } from '../src/engine/session'
import { FrameDecoder } from '../src/receiver/decoder'
import { ChannelState, makeParams, renderCamera } from '../src/sim/channel'
import { Rng } from '../src/engine/prng'
import { recommend, scoreTiers } from '../src/ui/linkScore'

describe('link test', () => {
  it('test frames decode with the right tier/kind and known payloads', () => {
    for (const p of PROFILES.slice(0, 3)) {
      const layout = buildLayout(p)
      const img = rasterize(layout, buildTestFrame(p, 55, 9), 10)
      const cam = renderCamera(
        [img], { a: new Int16Array(720), b: new Int16Array(720).fill(-1), alpha: new Float32Array(720) },
        makeParams('easy', {}, 10, Math.min(8, Math.floor((720 * 0.8) / (layout.G + 4)))), new Rng(2), new ChannelState(),
      )
      const r = new FrameDecoder().process(cam)
      expect(r.status).toBe('ok')
      expect(tierOf(r.header!.tierKind)).toBe(p.id)
      expect(kindOf(r.header!.tierKind)).toBe(KIND_TEST)
      expect(r.packets.length).toBe(layout.packetsPerFrame)
      for (const pk of r.packets) {
        expect(pk.type).toBe(PKT_TEST)
        expect(Array.from(pk.payload)).toEqual(Array.from(testPayload(pk.index, pk.payload.length)))
      }
    }
  }, 60_000)

  it('recommends the fastest tier that mostly arrives', () => {
    const rows = scoreTiers({
      0: { okFrames: 24, okPackets: 48, failedPackets: 0, minCounter: 0, maxCounter: 23 },
      1: { okFrames: 30, okPackets: 118, failedPackets: 2, minCounter: 24, maxCounter: 53 },
      2: { okFrames: 20, okPackets: 150, failedPackets: 30, minCounter: 54, maxCounter: 93 },
      3: { okFrames: 3, okPackets: 4, failedPackets: 100, minCounter: 94, maxCounter: 150 },
    })
    expect(rows.length).toBe(4)
    expect(rows[3]!.packetFraction).toBeLessThan(0.1)
    const best = recommend(rows)!
    expect(best.name).toBe('Fast') // 150 of 40*9 packets = 42% but at far higher raw speed beats Balanced
  })
})
