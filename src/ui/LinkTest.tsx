import { useMemo, useState } from 'react'
import { formatBytes } from './format'
import { recommend, scoreTiers } from './linkScore'
import SenderView from './SenderView'
import { useReceiver } from './useReceiver'

export default function LinkTest({ onBack }: { onBack: () => void }) {
  const [role, setRole] = useState<'menu' | 'send' | 'receive'>('menu')
  const mode = useMemo(() => ({ kind: 'linktest' as const }), [])

  if (role === 'send') return <SenderView mode={mode} onExit={() => setRole('menu')} />
  if (role === 'receive') return <LinkTestReceive onBack={() => setRole('menu')} />

  return (
    <main className="screen">
      <button className="back" onClick={onBack}>
        ← Back
      </button>
      <h1>Link test</h1>
      <p className="muted">
        Takes about 10 seconds. One phone plays test patterns at each speed, the other scores how well it can read
        them, then tells you which speed to use for this pair of phones.
      </p>
      <div className="actions">
        <button className="big send" onClick={() => setRole('send')}>
          This phone shows the patterns
        </button>
        <button className="big receive" onClick={() => setRole('receive')}>
          This phone watches
        </button>
      </div>
    </main>
  )
}

function LinkTestReceive({ onBack }: { onBack: () => void }) {
  const rx = useReceiver()
  const L = rx.live.current
  const rows = scoreTiers(L.tiers)
  const best = recommend(rows)
  const last = L.last
  const locked = !!last?.quad && performance.now() - L.lastLockAt < 1500

  return (
    <main className="screen cam">
      <div className="cam-top">
        <button className="back" onClick={() => { rx.stop(); onBack() }}>
          ← Back
        </button>
      </div>
      <div className={`video-wrap ${locked ? 'locked' : rx.phase === 'running' ? 'searching' : ''}`}
        style={{ aspectRatio: rx.info ? `${rx.info.width} / ${rx.info.height}` : '3 / 4' }}>
        <video ref={rx.videoRef} playsInline muted autoPlay />
        <canvas ref={rx.overlayRef} className="overlay" />
        {rx.phase === 'idle' && (
          <div className="cover">
            <p>Point the back camera at the other phone, which should be running the link test.</p>
            <button className="big receive" onClick={rx.start}>
              Start camera
            </button>
          </div>
        )}
        {rx.phase === 'error' && <div className="cover"><p>{rx.error}</p></div>}
      </div>

      {rx.phase === 'running' && (
        <div className="rx-panel">
          <b>{locked ? 'Reading test patterns...' : 'Looking for the sender...'}</b>
          <table className="lt">
            <thead>
              <tr>
                <th>Speed</th>
                <th>Frames</th>
                <th>Arrived</th>
                <th>Est. speed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.tier} className={best?.tier === r.tier ? 'best' : ''}>
                  <td>{r.name}</td>
                  <td>{r.okFrames}</td>
                  <td>{Math.round(r.packetFraction * 100)}%</td>
                  <td>{formatBytes(Math.round(r.estBytesPerSec))}/s</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length >= 4 && best ? (
            <div className="nudge info">
              Best mode for this pair of phones: <b>{best.name}</b>. Pick it on the sender when you send.
            </div>
          ) : rows.length >= 4 ? (
            <div className="nudge">
              Nothing was read reliably. Try more light, steadier hands, max sender brightness, and True Tone off.
            </div>
          ) : (
            <p className="muted">Keep the camera on the sender until all four speeds have been tried.</p>
          )}
        </div>
      )}
    </main>
  )
}
