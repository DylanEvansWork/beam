import { useEffect, useMemo, useRef, useState } from 'react'
import { Hud, debugFromUrl } from '../debug/Hud'
import { PROFILES } from '../engine/profiles'
import { FrameSource, buildTestFrame, randomSessionId, type PreparedTransfer } from '../engine/session'
import { buildLayout } from '../engine/framing'
import { SenderRunner, type RunnerStats } from '../sender/runner'
import { WakeLock, measureRefresh } from '../sender/scheduler'

export type SenderMode = { kind: 'transfer'; prepared: PreparedTransfer } | { kind: 'linktest' }

const PHASE_MS = 2500

/** Full-viewport sender: lock-on screen first, then the stream. No UI chrome except a tiny Stop. */
export default function SenderView({ mode, onExit }: { mode: SenderMode; onExit: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const runner = useRef<SenderRunner | null>(null)
  const [refresh, setRefresh] = useState<{ intervalMs: number; hz: number } | null>(null)
  const [phase, setPhase] = useState<'lockon' | 'stream'>(mode.kind === 'linktest' ? 'stream' : 'lockon')
  const [stats, setStats] = useState<RunnerStats | null>(null)
  const [debug, setDebug] = useState(debugFromUrl())
  const [autoStart, setAutoStart] = useState(0)
  const [countdown, setCountdown] = useState<number | null>(null)
  const taps = useRef<number[]>([])
  const frames = useRef(0)
  const wake = useMemo(() => new WakeLock(), [])
  const session = useMemo(() => randomSessionId(), [])

  useEffect(() => {
    void wake.start()
    let alive = true
    measureRefresh().then((r) => alive && setRefresh(r))
    return () => {
      alive = false
      void wake.stop()
    }
  }, [wake])

  const source = useMemo(() => (mode.kind === 'transfer' ? new FrameSource(mode.prepared) : null), [mode])

  // (re)start the runner whenever the phase changes
  useEffect(() => {
    if (!refresh || !canvasRef.current) return
    const hz = refresh.hz
    // tier hold times are defined at 60 Hz; keep the same wall-clock time on faster screens
    const scaleHold = (h: number) => Math.max(1, Math.round((h * hz) / 60))
    let provider: ConstructorParameters<typeof SenderRunner>[1]
    if (mode.kind === 'linktest') {
      const t0 = performance.now()
      provider = (counter) => {
        const idx = Math.floor((performance.now() - t0) / PHASE_MS) % PROFILES.length
        const profile = PROFILES[idx]!
        return { cells: buildTestFrame(profile, session, counter), layout: buildLayout(profile), hold: scaleHold(profile.hold) }
      }
    } else if (phase === 'lockon') {
      const profile = mode.prepared.profile
      provider = (counter) => ({ cells: source!.lockon(counter), layout: source!.layout, hold: scaleHold(Math.max(15, profile.hold * 3)) })
    } else {
      const profile = mode.prepared.profile
      provider = (counter) => ({ cells: source!.frame(counter), layout: source!.layout, hold: scaleHold(profile.hold) })
    }
    // the lock-on screen has a hint above and buttons below the code: reserve room so they never cover cells
    const reserve = mode.kind === 'transfer' && phase === 'lockon' ? 340 : 0
    const r = new SenderRunner(canvasRef.current, provider, refresh.intervalMs, () => ({
      w: window.innerWidth, h: Math.max(240, window.innerHeight - reserve), dpr: window.devicePixelRatio || 1,
    }))
    r.onStats = (s) => {
      if (++frames.current % 8 === 0) setStats(s)
    }
    runner.current = r
    r.start()
    return () => r.stop()
  }, [refresh, phase, mode, source, session])

  // optional auto-start from the lock-on screen
  useEffect(() => {
    if (phase !== 'lockon' || !autoStart) {
      setCountdown(null)
      return
    }
    let left = autoStart
    setCountdown(left)
    const id = setInterval(() => {
      left--
      setCountdown(left)
      if (left <= 0) {
        clearInterval(id)
        setPhase('stream')
      }
    }, 1000)
    return () => clearInterval(id)
  }, [phase, autoStart])

  const secretTap = () => {
    const now = Date.now()
    taps.current = [...taps.current.filter((t) => now - t < 800), now]
    if (taps.current.length >= 3) {
      taps.current = []
      setDebug((d) => !d)
    }
  }

  const slow = refresh && refresh.hz < 45
  const prepared = mode.kind === 'transfer' ? mode.prepared : null

  return (
    <div className="sender" onClick={secretTap}>
      <canvas ref={canvasRef} className="sender-canvas" />

      {phase === 'lockon' && prepared && (
        <>
          <div className="sender-top">
            <p>Point the other phone's back camera at this code from about 15 to 25 cm. The code should fill most of its view. Wait for it to lock on, then tap Start.</p>
            {slow && <p className="warn">Your screen is refreshing at ~{Math.round(refresh.hz)} Hz (Low Power Mode?). It will work but slower.</p>}
          </div>
          <div className="sender-bottom">
            <button className="big send" onClick={(e) => { e.stopPropagation(); setPhase('stream') }}>
              {countdown !== null ? `Start (${countdown})` : 'Start'}
            </button>
            <label className="auto" onClick={(e) => e.stopPropagation()}>
              Auto-start
              <select value={autoStart} onChange={(e) => setAutoStart(Number(e.target.value))}>
                <option value={0}>Off</option>
                <option value={3}>3 s</option>
                <option value={5}>5 s</option>
                <option value={10}>10 s</option>
              </select>
            </label>
            <button className="link" onClick={(e) => { e.stopPropagation(); onExit() }}>Cancel</button>
          </div>
        </>
      )}

      {phase === 'stream' && (
        <button className="stop" onClick={(e) => { e.stopPropagation(); onExit() }}>
          Stop
        </button>
      )}
      {mode.kind === 'linktest' && phase === 'stream' && (
        <div className="sender-top dim">Link test running. Tap Stop when the other phone has a result.</div>
      )}

      {debug && (
        <Hud
          title="Sender"
          lines={{
            'refresh Hz': refresh ? refresh.hz.toFixed(1) : '...',
            'interval ms': refresh ? refresh.intervalMs.toFixed(2) : '...',
            phase,
            frame: stats?.counter,
            tier: prepared?.profile.name ?? 'link test (cycling)',
            'hold (refreshes)': stats?.hold,
            'grid cells': stats?.grid,
            'cell px (device)': stats?.cellPx,
            'code px': stats?.gridPx,
            dpr: window.devicePixelRatio,
            K: prepared?.meta.K,
            session,
          }}
        />
      )}
    </div>
  )
}
