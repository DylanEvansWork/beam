import { describe, expect, it } from 'vitest'
import { buildLayout, rasterize } from '../src/engine/framing'
import { PROFILES } from '../src/engine/profiles'
import { FrameSource, prepareTransfer } from '../src/engine/session'
import { FrameDecoder } from '../src/receiver/decoder'
import { ChannelState, makeParams, renderCamera, type PresetName } from '../src/sim/channel'
import { Rng } from '../src/engine/prng'

async function oneFrame(profileId: number, preset: PresetName, counter = 5) {
  const profile = PROFILES[profileId]!
  const bytes = new Uint8Array(4000).map((_, i) => (i * 31 + 7) & 255)
  const prepared = await prepareTransfer({ bytes, name: 'a.bin', mime: 'application/octet-stream' }, profile, 1234)
  const src = new FrameSource(prepared)
  const layout = buildLayout(profile)
  const srcCell = 10
  const img = rasterize(layout, src.frame(counter), srcCell)
  const cellCam = Math.min(8, Math.floor((720 * 0.8) / (layout.G + 4)))
  const params = makeParams(preset, {}, srcCell, cellCam)
  const cam = renderCamera([img], { a: new Int16Array(720), b: new Int16Array(720).fill(-1), alpha: new Float32Array(720) }, params, new Rng(1), new ChannelState())
  const dec = new FrameDecoder()
  return dec.process(cam)
}

describe('single frame through the simulated channel', () => {
  for (const preset of ['clean', 'easy'] as const) {
    for (const id of [0, 1, 2]) {
      it(`${PROFILES[id]!.name} / ${preset}`, async () => {
        const r = await oneFrame(id, preset)
        console.log(PROFILES[id]!.name, preset, r.status, 'lock', r.lock && `${r.lock.anchorsFound}/${r.lock.anchorsTotal} cellPx=${r.lock.cellPx.toFixed(1)}`, 'packets ok', r.packets.length, 'failed', r.packetsFailed, JSON.stringify(r.stats), r.ms.toFixed(0) + 'ms')
        expect(r.status).toBe('ok')
        expect(r.packets.length).toBeGreaterThan(0)
      }, 60_000)
    }
  }
})
