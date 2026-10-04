/// <reference lib="webworker" />
import { PROFILES } from '../engine/profiles'
import { runTransfer } from './run'
import type { PresetName } from './channel'

export interface LoopbackStart {
  type: 'start'
  text: string
  tier: number
  preset: PresetName
}
export type LoopbackIn = LoopbackStart | { type: 'stop' }
export type LoopbackOut =
  | { type: 'frame'; k: number; seconds: number; status: string; solved: number; K: number; fraction: number; packetsOk: number; preview: { width: number; height: number; buffer: ArrayBuffer } | null; name: string | null }
  | { type: 'done'; ok: boolean; seconds: number; text: string; goodput: number; statuses: Record<string, number> }

let stop = false
const post = (m: LoopbackOut, t: Transferable[] = []) => (self as unknown as Worker).postMessage(m, t)

self.onmessage = async (e: MessageEvent<LoopbackIn>) => {
  if (e.data.type === 'stop') {
    stop = true
    return
  }
  stop = false
  const { text, tier, preset } = e.data
  const bytes = new TextEncoder().encode(text)
  let packetsOk = 0
  const res = await runTransfer({
    profile: PROFILES[tier]!,
    bytes,
    preset,
    seed: Math.floor(Math.random() * 1e6),
    maxSeconds: 120,
    yieldEachFrame: true,
    onFrame: ({ k, img, report, progress, seconds }) => {
      packetsOk += report.packets.length
      let preview: { width: number; height: number; buffer: ArrayBuffer } | null = null
      let transfer: Transferable[] = []
      if (k % 3 === 0) {
        const buffer = img.data.buffer.slice(0) as ArrayBuffer
        preview = { width: img.width, height: img.height, buffer }
        transfer = [buffer]
      }
      post(
        {
          type: 'frame', k, seconds, status: report.status, solved: progress.solved, K: progress.K, fraction: progress.fraction,
          packetsOk, preview, name: progress.meta?.name ?? null,
        },
        transfer,
      )
      return stop
    },
  })
  post({ type: 'done', ok: res.ok, seconds: res.seconds, text: res.ok ? text : '', goodput: res.goodputBps, statuses: res.statuses })
}
