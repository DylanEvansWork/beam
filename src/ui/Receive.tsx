import { useEffect, useState } from 'react'
import { Hud, debugFromUrl, type HudLines } from '../debug/Hud'
import { formatBytes, formatSeconds } from './format'
import { Result } from './Result'
import { nudge, tierName, useReceiver } from './useReceiver'

function Ring({ fraction }: { fraction: number }) {
  const r = 34
  const c = 2 * Math.PI * r
  return (
    <svg className="ring" viewBox="0 0 80 80" aria-label={`${Math.round(fraction * 100)} percent`}>
      <circle cx="40" cy="40" r={r} className="ring-bg" />
      <circle
        cx="40" cy="40" r={r} className="ring-fg"
        strokeDasharray={c} strokeDashoffset={c * (1 - Math.min(1, fraction))}
        transform="rotate(-90 40 40)"
      />
      <text x="40" y="45" textAnchor="middle" className="ring-text">
        {Math.round(fraction * 100)}%
      </text>
    </svg>
  )
}

export default function Receive({ onBack }: { onBack: () => void }) {
  const rx = useReceiver()
  const { live, phase } = rx
  const [debug, setDebug] = useState(debugFromUrl())
  const [torch, setTorch] = useState(false)
  const [startedAt, setStartedAt] = useState(0)

  useEffect(() => {
    if (phase === 'running') setStartedAt(performance.now())
  }, [phase])

  const L = live.current
  const now = performance.now()
  const last = L.last
  const p = last?.progress
  const locked = !!last?.quad && now - L.lastLockAt < 1500
  const hint = phase === 'running' ? nudge(L, now) : null

  if (phase === 'done' && L.result) {
    const t0 = L.firstDataAt ?? startedAt
    return (
      <main className="screen">
        <Result
          meta={L.result.meta}
          bytes={L.result.bytes}
          seconds={((L.doneAt ?? now) - t0) / 1000}
          onAgain={() => rx.reset()}
        />
      </main>
    )
  }

  const hist = L.bytesHist
  const speed = hist.length > 1 ? ((hist[hist.length - 1]!.bytes - hist[0]!.bytes) * 1000) / (hist[hist.length - 1]!.t - hist[0]!.t) : 0
  const good = L.hist.filter((s) => s === 'ok' || s === 'dup' || s === 'lockon').length
  const lines: HudLines = {
    lock: locked ? `${last?.mode} ${last?.anchors}` : 'searching',
    status: last?.status,
    tier: last?.header ? tierName(last.header.tier) : '-',
    'cam claimed': rx.info ? `${rx.info.width}x${rx.info.height} @${rx.info.claimedFps ?? '?'}` : '-',
    'cam delivered fps': rx.loopRef.current ? rx.loopRef.current.stats().deliveredFps.toFixed(1) : '-',
    'worker fps': rx.loopRef.current ? rx.loopRef.current.stats().workerFps.toFixed(1) : '-',
    'sent to worker': rx.loopRef.current ? `${rx.loopRef.current.stats().sentW}x${rx.loopRef.current.stats().sentH}` : '-',
    dropped: rx.loopRef.current?.stats().dropped,
    'decode ms': last?.ms.toFixed(1),
    'capture ms': rx.loopRef.current?.stats().captureMs.toFixed(1),
    cellPx: last?.cellPx?.toFixed(1),
    sharpness: last?.stats.sharpness.toFixed(2),
    'pilot err': last?.stats.pilotErr.toFixed(3),
    'ref sep': last?.stats.refSep.toFixed(0),
    'mean conf': last?.stats.meanConf.toFixed(2),
    'tear/blur/bad': `${L.counts.tear ?? 0}/${L.counts.blur ?? 0}/${L.counts.badheader ?? 0}`,
    'frames ok/dup': `${L.counts.ok ?? 0}/${L.counts.dup ?? 0}`,
    'pkts ok/fail': `${L.packetsOk}/${L.packetsFailed}`,
    'RS fixes': L.rsCorrected,
    'fountain': p ? `${p.solved}/${p.K} (rx ${p.received})` : '-',
    overhead: p ? `${(p.overhead * 100).toFixed(0)}%` : '-',
    throughput: `${formatBytes(Math.round(speed))}/s`,
  }

  return (
    <main className="screen cam">
      <div className="cam-top">
        <button className="back" onClick={() => { rx.stop(); onBack() }}>
          ← Back
        </button>
        <button className="link" onClick={() => setDebug((d) => !d)}>
          {debug ? 'Hide debug' : 'Debug'}
        </button>
      </div>

      <div className={`video-wrap ${locked ? 'locked' : phase === 'running' ? 'searching' : ''}`}
        style={{ aspectRatio: rx.info ? `${rx.info.width} / ${rx.info.height}` : '3 / 4' }}>
        <video ref={rx.videoRef} playsInline muted autoPlay />
        <canvas ref={rx.overlayRef} className="overlay" />
        {phase === 'idle' && (
          <div className="cover">
            <p>Point the back camera at the sender's screen.</p>
            <button className="big receive" onClick={rx.start}>
              Start camera
            </button>
          </div>
        )}
        {phase === 'starting' && <div className="cover">Starting camera...</div>}
        {phase === 'error' && (
          <div className="cover">
            <p>{rx.error}</p>
            <button className="big" onClick={rx.start}>
              Try again
            </button>
          </div>
        )}
      </div>

      {phase === 'running' && (
        <div className="rx-panel">
          <div className="rx-row">
            <Ring fraction={p?.fraction ?? 0} />
            <div className="rx-info">
              {p?.meta ? (
                <>
                  <b>Incoming: {p.meta.name || 'file'}</b>
                  <span className="muted">
                    {formatBytes(p.meta.originalSize)} · {tierName(p.meta.tier)} · {p.solved}/{p.K} pieces
                  </span>
                  <span className="muted">
                    {formatBytes(Math.round(speed))}/s now
                    {speed > 0 && p.K > p.solved
                      ? ` · ~${formatSeconds(((p.K - p.solved) * p.meta.symbolSize) / speed)} left`
                      : ''}
                  </span>
                </>
              ) : (
                <>
                  <b>{locked ? 'Locked on, waiting for data' : 'Looking for the sender...'}</b>
                  <span className="muted">
                    {locked ? 'Ask them to tap Start if the code is only showing a lock-on screen.' : 'Fill most of the view with their screen.'}
                  </span>
                </>
              )}
              <span className="muted">
                {L.hist.length ? `${Math.round((100 * good) / L.hist.length)}% of recent frames usable` : ''}
              </span>
            </div>
          </div>
          {hint && <div className="nudge">{hint}</div>}
          {L.notice && now - L.noticeAt < 5000 && <div className="nudge info">{L.notice}</div>}
          {rx.info?.torch && (
            <button
              className="link"
              onClick={async () => {
                try {
                  await rx.loopRef.current?.setTorch(!torch)
                  setTorch(!torch)
                } catch {
                  /* ignore */
                }
              }}
            >
              {torch ? 'Torch off' : 'Torch on'}
            </button>
          )}
        </div>
      )}

      {debug && (
        <Hud
          title="Receiver"
          lines={lines}
          extra={() => ({
            camera: rx.info,
            counts: L.counts,
            loop: rx.loopRef.current?.stats(),
            lastReport: last && { ...last, progress: undefined },
            progress: p && { ...p, meta: p.meta && { ...p.meta, sha256: undefined } },
          })}
          onSaveFrame={() => rx.loopRef.current?.snapshot() ?? Promise.resolve(null)}
        />
      )}
    </main>
  )
}
