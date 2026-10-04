import { useEffect, useRef, useState } from 'react'
import { PROFILES } from '../engine/profiles'
import { CHANNEL_PRESETS, type PresetName } from '../sim/channel'
import type { LoopbackIn, LoopbackOut } from '../sim/loopback.worker'
import { formatBytes } from './format'

/** Whole pipeline on one device: sender frames -> simulated screen-to-camera channel -> decoder, in a worker. */
export default function Loopback({ onBack }: { onBack: () => void }) {
  const [text, setText] = useState('Hello from the loopback demo. No second phone needed.')
  const [tier, setTier] = useState(1)
  const [preset, setPreset] = useState<PresetName>('moderate')
  const [running, setRunning] = useState(false)
  const [info, setInfo] = useState<{ k: number; seconds: number; status: string; solved: number; K: number; fraction: number; name: string | null } | null>(null)
  const [done, setDone] = useState<{ ok: boolean; seconds: number; goodput: number; statuses: Record<string, number> } | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const worker = useRef<Worker | null>(null)

  useEffect(() => () => worker.current?.terminate(), [])

  const start = () => {
    worker.current?.terminate()
    const w = new Worker(new URL('../sim/loopback.worker.ts', import.meta.url), { type: 'module' })
    worker.current = w
    setRunning(true)
    setDone(null)
    setInfo(null)
    w.onmessage = (e: MessageEvent<LoopbackOut>) => {
      const m = e.data
      if (m.type === 'frame') {
        setInfo({ k: m.k, seconds: m.seconds, status: m.status, solved: m.solved, K: m.K, fraction: m.fraction, name: m.name })
        if (m.preview && canvasRef.current) {
          const c = canvasRef.current
          c.width = m.preview.width
          c.height = m.preview.height
          c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(m.preview.buffer), m.preview.width, m.preview.height), 0, 0)
        }
      } else {
        setDone({ ok: m.ok, seconds: m.seconds, goodput: m.goodput, statuses: m.statuses })
        setRunning(false)
        w.terminate()
      }
    }
    w.postMessage({ type: 'start', text, tier, preset } satisfies LoopbackIn)
  }

  return (
    <main className="screen">
      <button className="back" onClick={() => { worker.current?.terminate(); onBack() }}>
        ← Back
      </button>
      <h1>Loopback demo</h1>
      <p className="muted">
        Runs the real encoder, a simulated screen-to-camera channel (blur, tilt, colour cast, tearing, noise) and the real
        decoder on this device. Simulated time, not real time.
      </p>
      <textarea className="input" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="row wrap">
        <label className="auto">
          Speed
          <select value={tier} onChange={(e) => setTier(Number(e.target.value))}>
            {PROFILES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>
        <label className="auto">
          Channel
          <select value={preset} onChange={(e) => setPreset(e.target.value as PresetName)}>
            {Object.keys(CHANNEL_PRESETS).map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </label>
      </div>
      <button className="big send" disabled={running || !text} onClick={start}>
        {running ? 'Running...' : 'Run'}
      </button>
      <canvas ref={canvasRef} className="loop-preview" />
      {info && (
        <p className="muted">
          simulated {info.seconds.toFixed(1)} s · last frame: {info.status} · {info.solved}/{info.K} pieces ({Math.round(info.fraction * 100)}%)
        </p>
      )}
      {done && (
        <div className={`card ${done.ok ? '' : 'warn-card'}`}>
          <b>{done.ok ? 'Transferred and hash-verified' : 'Did not finish'}</b>
          <p className="muted">
            {done.seconds.toFixed(1)} simulated seconds{done.ok ? ` · ${formatBytes(Math.round(done.goodput))}/s effective` : ''}
          </p>
          <p className="muted">frames: {Object.entries(done.statuses).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ')}</p>
        </div>
      )}
    </main>
  )
}
