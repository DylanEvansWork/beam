/// <reference lib="webworker" />
import { kindOf, tierOf, KIND_TEST } from '../engine/framing'
import type { Meta } from '../engine/packets'
import { Assembler, type AssemblerProgress } from './assemble'
import { FrameDecoder, type FrameStatus } from './decoder'

export type WorkerIn =
  | { type: 'frame'; id: number; width: number; height: number; buffer: ArrayBuffer }
  | { type: 'reset' }
  | { type: 'options'; minSharpness?: number; maxPilotErr?: number; erasureConf?: number }

export interface ReportMsg {
  type: 'report'
  id: number
  status: FrameStatus
  quad: [number, number][] | null
  grid: number | null
  cellPx: number | null
  anchors: string | null
  mode: 'scan' | 'track' | null
  header: { session: number; counter: number; tier: number; kind: number } | null
  stats: { sharpness: number; pilotErr: number; refSep: number; rms: number; rsCorrected: number; meanConf: number; erasuresUsed: number }
  packetsOk: number
  packetsFailed: number
  isTest: boolean
  ms: number
  progress: AssemblerProgress
  newSession: boolean
}

export interface ResultMsg {
  type: 'result'
  meta: Meta
  bytes: Uint8Array
}

export interface ErrorMsg {
  type: 'error'
  message: string
}

export type WorkerOut = ReportMsg | ResultMsg | ErrorMsg

const decoder = new FrameDecoder()
const asm = new Assembler()
const post = (m: WorkerOut, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer)

self.onmessage = (e: MessageEvent<WorkerIn>) => {
  const m = e.data
  if (m.type === 'reset') {
    asm.reset()
    decoder.resetSeen()
    decoder.locator.reset()
    return
  }
  if (m.type === 'options') {
    if (m.minSharpness !== undefined) decoder.opts.minSharpness = m.minSharpness
    if (m.maxPilotErr !== undefined) decoder.opts.maxPilotErr = m.maxPilotErr
    if (m.erasureConf !== undefined) decoder.opts.erasureConf = m.erasureConf
    return
  }
  const r = decoder.process({ width: m.width, height: m.height, data: new Uint8ClampedArray(m.buffer) })
  let newSession = false
  if (r.header) newSession = asm.noteSession(r.header.session)
  const isTest = !!r.header && kindOf(r.header.tierKind) === KIND_TEST
  if (r.packets.length && !isTest) {
    const p = asm.ingest(r.packets)
    if (p) {
      p.then(
        (res) => post({ type: 'result', meta: res.meta, bytes: res.bytes }, [res.bytes.buffer]),
        (err: unknown) => post({ type: 'error', message: err instanceof Error ? err.message : String(err) }),
      )
    }
  }
  post({
    type: 'report',
    id: m.id,
    status: r.status,
    quad: r.lock ? r.lock.quad : null,
    grid: r.lock ? r.lock.G : null,
    cellPx: r.lock ? r.lock.cellPx : null,
    anchors: r.lock ? `${r.lock.anchorsFound}/${r.lock.anchorsTotal}` : null,
    mode: r.lock ? r.lock.mode : null,
    header: r.header
      ? { session: r.header.session, counter: r.header.counter, tier: tierOf(r.header.tierKind), kind: kindOf(r.header.tierKind) }
      : null,
    stats: r.stats,
    packetsOk: r.packets.length,
    packetsFailed: r.packetsFailed,
    isTest,
    ms: r.ms,
    progress: asm.progress(),
    newSession,
  })
}
