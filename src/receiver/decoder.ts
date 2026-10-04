import {
  KIND_LOCKON, bitsToHeader, buildLayout, cellsToStream, kindOf, streamToPackets, tierOf,
  type FrameHeader, type Layout,
} from '../engine/framing'
import { decodePacket, type Packet } from '../engine/packets'
import { PROFILES } from '../engine/profiles'
import { Locator, toGray, type Img, type Lock } from './locate'
import { calibrate, classifyData, readHeaderBits, sampleCells, sharpness } from './sample'

export type FrameStatus = 'nolock' | 'offscreen' | 'badheader' | 'tear' | 'dup' | 'blur' | 'lockon' | 'ok'

export interface FrameReport {
  status: FrameStatus
  lock: Lock | null
  header: FrameHeader | null
  packets: Packet[]
  packetsFailed: number
  stats: {
    sharpness: number
    pilotErr: number
    refSep: number
    rms: number
    rsCorrected: number
    meanConf: number
    erasuresUsed: number
  }
  ms: number
}

export interface DecoderOptions {
  /** Skip frames blurrier than this (0..1). */
  minSharpness: number
  /** Skip frames whose pilot error rate is worse than this. */
  maxPilotErr: number
  /** Cells below this confidence become RS erasures when a plain decode fails. */
  erasureConf: number
}

export const DEFAULT_OPTIONS: DecoderOptions = { minSharpness: 0.15, maxPilotErr: 0.35, erasureConf: 0.25 }

const layoutByGrid = new Map<number, Layout>()

/** Rebuild the grid -> layout table from PROFILES (call after mutating a profile in benchmarks). */
export function refreshLayouts(): void {
  layoutByGrid.clear()
  for (const p of PROFILES) layoutByGrid.set(p.grid, buildLayout(p))
}
refreshLayouts()

const emptyStats = () => ({ sharpness: 0, pilotErr: 0, refSep: 0, rms: 0, rsCorrected: 0, meanConf: 0, erasuresUsed: 0 })

export class FrameDecoder {
  readonly locator = new Locator((g) => layoutByGrid.get(g))
  opts: DecoderOptions
  private done = new Set<string>()
  private doneOrder: string[] = []
  private headerMisses = 0
  private lastSession = -1

  constructor(opts: Partial<DecoderOptions> = {}) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts }
  }

  /** Forget which frames were fully decoded (e.g. when the session changes). */
  resetSeen(): void {
    this.lastSession = -1
    this.done.clear()
    this.doneOrder = []
  }

  private markDone(key: string): void {
    this.done.add(key)
    this.doneOrder.push(key)
    if (this.doneOrder.length > 512) this.done.delete(this.doneOrder.shift()!)
  }

  process(img: Img): FrameReport {
    const t0 = performance.now()
    const report: FrameReport = {
      status: 'nolock', lock: null, header: null, packets: [], packetsFailed: 0, stats: emptyStats(), ms: 0,
    }
    const finish = (status: FrameStatus): FrameReport => {
      report.status = status
      report.ms = performance.now() - t0
      return report
    }

    const gray = toGray(img)
    const lock = this.locator.locate(img, gray)
    if (!lock) {
      this.headerMisses = 0
      return finish('nolock')
    }
    report.lock = lock
    const layout = layoutByGrid.get(lock.G)!

    const { rgb, outside } = sampleCells(img, lock.H, layout)
    if (outside > 0.02) return finish('offscreen')
    const model = calibrate(layout, rgb)
    if (!model) return finish('badheader')
    report.stats.pilotErr = model.pilotErr
    report.stats.refSep = model.refSep
    report.stats.rms = model.rms

    // Header: both copies agreeing is the clean case. Otherwise the camera caught a tear (two valid headers
    // from consecutive display frames) or a header bit got corrupted (only one copy passes CRC). Both are
    // still decodable: packets carry their own RS + CRC16 and the whitening doesn't depend on the counter.
    // A lone valid header is trusted only if it matches the session we last saw cleanly, since an 8-bit CRC
    // alone would let random garbage reset a transfer.
    const top = bitsToHeader(readHeaderBits(layout, model, rgb, layout.headerTop))
    const bot = bitsToHeader(readHeaderBits(layout, model, rgb, layout.headerBottom))
    let header: FrameHeader | null = null
    let torn = false
    if (top && bot && top.counter === bot.counter && top.session === bot.session && top.tierKind === bot.tierKind) {
      header = top
      this.lastSession = top.session
    } else if (top && bot) {
      if (top.session === bot.session && top.tierKind === bot.tierKind) {
        header = top
        torn = true
      }
    } else if (top || bot) {
      const h = (top ?? bot)!
      if (h.session === this.lastSession) {
        header = h
        torn = true
      }
    }
    if (!header) {
      if (++this.headerMisses >= 2) this.locator.forget()
      return finish('badheader')
    }
    this.headerMisses = 0
    report.header = header
    this.locator.accept(lock, layout)
    if (tierOf(header.tierKind) !== PROFILES.find((p) => p.grid === lock.G)?.id) return finish('badheader')
    if (kindOf(header.tierKind) === KIND_LOCKON) return finish('lockon')

    const key = `${header.session}:${header.counter}`
    if (!torn && this.done.has(key)) return finish('dup')

    const sharp = sharpness(layout, model, rgb)
    report.stats.sharpness = sharp
    if (sharp < this.opts.minSharpness || model.pilotErr > this.opts.maxPilotErr) return finish('blur')

    const { values, conf } = classifyData(layout, model, rgb)
    let cs = 0
    for (let i = 0; i < conf.length; i++) cs += Math.min(conf[i]!, 2)
    report.stats.meanConf = cs / conf.length

    const stream = cellsToStream(layout, values, header)
    const raw = streamToPackets(layout, stream)
    // per-stream-byte confidence (min over the cells that touch the byte), for erasure marking
    let byteConf: Float32Array | null = null
    const ppf = layout.packetsPerFrame
    const { n, parity } = layout.packet
    let ok = 0
    for (let p = 0; p < ppf; p++) {
      let pk = decodePacket(layout.packet, raw[p]!.bytes)
      if (!pk && this.opts.erasureConf > 0) {
        if (!byteConf) {
          byteConf = new Float32Array(layout.capBytes).fill(9)
          const bpc = layout.bpc
          for (let i = 0; i < conf.length; i++) {
            const b0 = (i * bpc) >> 3
            const b1 = ((i + 1) * bpc - 1) >> 3
            for (let b = b0; b <= b1 && b < byteConf.length; b++) if (conf[i]! < byteConf[b]!) byteConf[b] = conf[i]!
          }
        }
        const cand: { b: number; c: number }[] = []
        for (let b = 0; b < n; b++) {
          const si = layout.profile.interleave ? b * ppf + p : p * n + b
          if (byteConf[si]! < this.opts.erasureConf) cand.push({ b, c: byteConf[si]! })
        }
        cand.sort((a, b) => a.c - b.c)
        const er = cand.slice(0, Math.floor(parity * 0.6)).map((x) => x.b)
        if (er.length) {
          pk = decodePacket(layout.packet, raw[p]!.bytes, er)
          if (pk) report.stats.erasuresUsed += er.length
        }
      }
      if (pk && pk.session === header.session) {
        report.packets.push(pk)
        report.stats.rsCorrected += pk.corrected
        ok++
      } else report.packetsFailed++
    }
    if (!torn && ok === ppf) this.markDone(key)
    return finish(torn ? 'tear' : 'ok')
  }
}
