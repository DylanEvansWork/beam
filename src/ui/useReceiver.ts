import { useCallback, useEffect, useRef, useState } from 'react'
import { PROFILES } from '../engine/profiles'
import { CameraLoop, type CameraInfo } from '../receiver/camera'
import type { FrameStatus } from '../receiver/decoder'
import type { ReportMsg, ResultMsg } from '../receiver/worker'

export type Phase = 'idle' | 'starting' | 'running' | 'done' | 'error'

export interface TierStat {
  okFrames: number
  okPackets: number
  failedPackets: number
  minCounter: number
  maxCounter: number
}

export interface Live {
  last: ReportMsg | null
  hist: FrameStatus[]
  counts: Record<string, number>
  packetsOk: number
  packetsFailed: number
  rsCorrected: number
  firstDataAt: number | null
  bytesHist: { t: number; bytes: number }[]
  result: ResultMsg | null
  doneAt: number | null
  notice: string | null
  noticeAt: number
  tiers: Record<number, TierStat>
  lastLockAt: number
}

const fresh = (): Live => ({
  last: null, hist: [], counts: {}, packetsOk: 0, packetsFailed: 0, rsCorrected: 0, firstDataAt: null,
  bytesHist: [], result: null, doneAt: null, notice: null, noticeAt: 0, tiers: {}, lastLockAt: 0,
})

/** Camera + decode worker wiring shared by Receive and Link Test. All per-frame state lives in a ref; the UI polls it. */
export function useReceiver() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const loopRef = useRef<CameraLoop | null>(null)
  const live = useRef<Live>(fresh())
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState('')
  const [info, setInfo] = useState<CameraInfo | null>(null)
  const [, setTick] = useState(0)

  useEffect(() => {
    if (phase !== 'running' && phase !== 'done') return
    const id = setInterval(() => setTick((t) => t + 1), 250)
    return () => clearInterval(id)
  }, [phase])

  const draw = useCallback((r: ReportMsg) => {
    const c = overlayRef.current
    const loop = loopRef.current
    if (!c || !loop) return
    const st = loop.stats()
    const w = c.clientWidth
    const h = c.clientHeight
    if (c.width !== w || c.height !== h) {
      c.width = w
      c.height = h
    }
    const ctx = c.getContext('2d')!
    ctx.clearRect(0, 0, w, h)
    if (!r.quad || !st.sentW) return
    const k = w / st.sentW
    const good = r.status === 'ok' || r.status === 'dup' || r.status === 'lockon'
    ctx.lineWidth = 4
    ctx.strokeStyle = good ? '#34c759' : '#ffcc00'
    ctx.beginPath()
    r.quad.forEach(([x, y], i) => (i ? ctx.lineTo(x * k, y * k) : ctx.moveTo(x * k, y * k)))
    ctx.closePath()
    ctx.stroke()
  }, [])

  const onReport = useCallback(
    (r: ReportMsg) => {
      const L = live.current
      const now = performance.now()
      L.last = r
      L.hist.push(r.status)
      if (L.hist.length > 40) L.hist.shift()
      L.counts[r.status] = (L.counts[r.status] ?? 0) + 1
      L.packetsOk += r.packetsOk
      L.packetsFailed += r.packetsFailed
      L.rsCorrected += r.stats.rsCorrected
      if (r.quad) L.lastLockAt = now
      if (r.newSession) {
        L.notice = 'New transfer detected'
        L.noticeAt = now
        L.firstDataAt = null
        L.bytesHist = []
      }
      if (r.progress.bytesIn > 0 && L.firstDataAt === null) L.firstDataAt = now
      L.bytesHist.push({ t: now, bytes: r.progress.bytesIn })
      while (L.bytesHist.length > 2 && now - L.bytesHist[0]!.t > 4000) L.bytesHist.shift()
      if (r.isTest && r.header && r.status === 'ok') {
        const t = (L.tiers[r.header.tier] ??= { okFrames: 0, okPackets: 0, failedPackets: 0, minCounter: r.header.counter, maxCounter: r.header.counter })
        t.okFrames++
        t.okPackets += r.packetsOk
        t.failedPackets += r.packetsFailed
        t.minCounter = Math.min(t.minCounter, r.header.counter)
        t.maxCounter = Math.max(t.maxCounter, r.header.counter)
      }
      if (r.progress.error && L.notice !== r.progress.error) {
        L.notice = `Rejected a bad result (${r.progress.error}). Still collecting.`
        L.noticeAt = now
      }
      draw(r)
    },
    [draw],
  )

  const start = useCallback(async () => {
    const video = videoRef.current
    if (!video) return
    live.current = fresh()
    setPhase('starting')
    setError('')
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser has no camera access (needs HTTPS).')
      const loop = new CameraLoop()
      loop.onReport = onReport
      loop.onResult = (res) => {
        live.current.result = res
        live.current.doneAt = performance.now()
        loop.stop()
        setPhase('done')
      }
      loop.onError = (m) => {
        live.current.notice = m
        live.current.noticeAt = performance.now()
      }
      loopRef.current = loop
      setInfo(await loop.start(video))
      setPhase('running')
    } catch (e) {
      const name = e instanceof DOMException ? e.name : ''
      setError(
        name === 'NotAllowedError'
          ? 'Camera permission was denied. Allow camera access for this site and try again.'
          : name === 'NotFoundError'
            ? 'No camera found.'
            : e instanceof Error
              ? e.message
              : String(e),
      )
      setPhase('error')
    }
  }, [onReport])

  const stop = useCallback(() => {
    loopRef.current?.stop()
    loopRef.current = null
  }, [])

  const reset = useCallback(() => {
    stop()
    live.current = fresh()
    setPhase('idle')
  }, [stop])

  useEffect(() => stop, [stop])

  return { videoRef, overlayRef, loopRef, live, phase, error, info, start, stop, reset }
}

export const tierName = (id: number): string => PROFILES[id]?.name ?? `tier ${id}`

/** Short user-facing hint from the recent frame history, or null if things look fine. */
export function nudge(L: Live, nowMs: number): string | null {
  const h = L.hist
  const n = h.length
  if (n < 8) return null
  const frac = (s: FrameStatus) => h.filter((x) => x === s).length / n
  const last = L.last
  if (frac('nolock') > 0.8) return "Point at the other phone's screen and fill most of the view"
  if (frac('offscreen') > 0.3) return 'Move back a little so the whole code is in view'
  if (frac('blur') > 0.3) return 'Hold steadier'
  if (frac('badheader') > 0.4) return 'Tilt less, and check brightness. Turn off True Tone / Night Shift on the sender'
  if (last?.cellPx && last.cellPx < 4.5) return 'Move closer'
  if (last && last.stats.refSep > 0 && last.stats.refSep < 140) return 'Too dark. Turn the sender brightness up'
  if (last && last.stats.pilotErr > 0.2) return 'Colours look off. Sender: max brightness, True Tone / Night Shift off'
  if (nowMs - L.lastLockAt > 3000 && L.lastLockAt > 0) return "Lost it. Point at the other phone's screen"
  return null
}
