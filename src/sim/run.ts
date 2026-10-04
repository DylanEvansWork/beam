import { buildLayout, rasterize } from '../engine/framing'
import type { Profile } from '../engine/profiles'
import { FrameSource, prepareTransfer } from '../engine/session'
import { Assembler, type AssemblerProgress } from '../receiver/assemble'
import { FrameDecoder, type DecoderOptions, type FrameReport, type FrameStatus } from '../receiver/decoder'
import { CameraSim, makeParams, type ChannelParams, type PresetName } from './channel'

export interface RunConfig {
  profile: Profile
  bytes: Uint8Array
  preset: PresetName
  paramOverrides?: Partial<ChannelParams>
  camFps?: number
  refreshHz?: number
  seed?: number
  /** Give up after this many simulated seconds. */
  maxSeconds?: number
  /** Sender counter the camera starts watching at (late start). */
  startCounter?: number
  dropProb?: number
  decoderOptions?: Partial<DecoderOptions>
  srcCellPx?: number
  /** Called after each processed camera frame. Return true to stop early. */
  onFrame?: (info: { k: number; img: { width: number; height: number; data: Uint8ClampedArray }; report: FrameReport; progress: AssemblerProgress; seconds: number }) => boolean | void
  /** Yield to the event loop after every frame (so a worker can receive a stop message). */
  yieldEachFrame?: boolean
}

export interface RunResult {
  ok: boolean
  /** Simulated seconds until the transfer completed (or maxSeconds). */
  seconds: number
  camFrames: number
  goodputBps: number
  statuses: Record<FrameStatus | 'dropped', number>
  packetsOk: number
  packetsFailed: number
  rsCorrected: number
  overhead: number
  hashOk: boolean
}

export async function runTransfer(cfg: RunConfig): Promise<RunResult> {
  const { profile, bytes } = cfg
  const camFps = cfg.camFps ?? 60
  const refreshHz = cfg.refreshHz ?? 60
  const seed = cfg.seed ?? 1
  const srcCell = cfg.srcCellPx ?? 10
  const layout = buildLayout(profile)
  const prepared = await prepareTransfer({ bytes, name: 'file.bin', mime: 'application/octet-stream' }, profile, 1000 + seed)
  const source = new FrameSource(prepared)
  const cellCam = Math.min(8, Math.floor((720 * 0.8) / (layout.G + 4)))
  const params = makeParams(cfg.preset, cfg.paramOverrides, srcCell, cellCam)
  const sim = new CameraSim(
    { params, framePeriod: profile.hold / refreshHz, camFps, dropProb: cfg.dropProb, seed, startCounter: cfg.startCounter },
    (c) => rasterize(layout, source.frame(c), srcCell),
  )
  const decoder = new FrameDecoder(cfg.decoderOptions)
  const asm = new Assembler()
  const statuses = { nolock: 0, offscreen: 0, badheader: 0, tear: 0, dup: 0, blur: 0, lockon: 0, ok: 0, dropped: 0 }
  let packetsOk = 0
  let packetsFailed = 0
  let rsCorrected = 0
  const maxFrames = Math.ceil((cfg.maxSeconds ?? 120) * camFps)
  let result: Awaited<NonNullable<ReturnType<Assembler['ingest']>>> | null = null
  let k = 0
  for (; k < maxFrames && !result; k++) {
    const f = sim.next()
    if (!f) { statuses.dropped++; continue }
    const r = decoder.process(f.img)
    statuses[r.status]++
    if (r.header) asm.noteSession(r.header.session)
    packetsOk += r.packets.length
    packetsFailed += r.status === 'ok' ? r.packetsFailed : 0
    rsCorrected += r.stats.rsCorrected
    if (r.packets.length) {
      const p = asm.ingest(r.packets)
      if (p) result = await p
    }
    if (cfg.onFrame?.({ k, img: f.img, report: r, progress: asm.progress(), seconds: (k + 1) / camFps })) {
      k++
      break
    }
    if (cfg.yieldEachFrame) await new Promise((res) => setTimeout(res, 0))
  }
  const seconds = k / camFps
  const hashOk = !!result && result.bytes.length === bytes.length && result.bytes.every((v, i) => v === bytes[i])
  return {
    ok: hashOk, seconds, camFrames: k, goodputBps: hashOk ? bytes.length / seconds : 0, statuses,
    packetsOk, packetsFailed, rsCorrected, overhead: asm.progress().overhead, hashOk,
  }
}
