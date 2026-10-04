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

describe('torn and half-corrupted headers', () => {
  it('a camera frame torn between two display frames still yields packets', async () => {
    const profile = PROFILES[1]!
    const bytes = new Uint8Array(6000).map((_, i) => (i * 17 + 3) & 255)
    const prepared = await prepareTransfer({ bytes, name: 'a.bin', mime: 'application/octet-stream' }, profile, 2024)
    const src = new FrameSource(prepared)
    const layout = buildLayout(profile)
    const A = rasterize(layout, src.frame(10), 10)
    const B = rasterize(layout, src.frame(11), 10)
    const a = new Int16Array(720)
    const b = new Int16Array(720).fill(-1)
    const alpha = new Float32Array(720)
    for (let y = 0; y < 720; y++) a[y] = y < 380 ? 0 : 1 // tear partway down the screen
    const cam = renderCamera([A, B], { a, b, alpha }, makeParams('easy', {}, 10, 8), new Rng(3), new ChannelState())
    const dec = new FrameDecoder()
    // establish the session with a clean frame first (a lone valid header is only trusted for a known session)
    const clean = renderCamera([A], { a: new Int16Array(720), b: new Int16Array(720).fill(-1), alpha: new Float32Array(720) }, makeParams('easy', {}, 10, 8), new Rng(4), new ChannelState())
    expect(dec.process(clean).status).toBe('ok')
    const r = dec.process(cam)
    expect(r.status).toBe('tear')
    expect(r.packets.length).toBeGreaterThanOrEqual(1)
    expect(r.packets.length).toBeLessThan(layout.packetsPerFrame + 1)
    console.log('torn frame: packets decoded', r.packets.length, 'of', layout.packetsPerFrame, 'symbol indices', r.packets.map((p) => p.index).join(','), 'fixes', r.packets.map((p) => p.corrected).join(','))
  }, 60_000)
})
