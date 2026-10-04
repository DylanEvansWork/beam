import { useEffect, useMemo, useState } from 'react'
import { PROFILES } from '../engine/profiles'
import { MAX_TRANSFER_BYTES, bestCaseBytesPerSecond, estimateSeconds, prepareTransfer, type PreparedTransfer } from '../engine/session'
import { COMPACT_FACTOR, compactPhoto, type CompactResult } from '../sender/compactPhoto'
import { formatBytes, formatSeconds } from './format'
import SenderView, { type SenderMode } from './SenderView'

type Step = 'compose' | 'checklist' | 'show'

const WARNED_KEY = 'beam.photoWarned'
const getWarned = () => {
  try {
    return localStorage.getItem(WARNED_KEY) === '1'
  } catch {
    return false
  }
}

export default function Send({ onBack }: { onBack: () => void }) {
  const [step, setStep] = useState<Step>('compose')
  const [kind, setKind] = useState<'text' | 'file'>('text')
  const [text, setText] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [tier, setTier] = useState(1)
  const [warned, setWarned] = useState(getWarned())
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<SenderMode | null>(null)
  const [compact, setCompact] = useState(true)
  const [packed, setPacked] = useState<CompactResult | null>(null)
  const [packing, setPacking] = useState(false)
  const isPhoto = kind === 'file' && !!file && file.type.startsWith('image/')
  const useCompact = isPhoto && compact

  // photos are re-encoded ~5x smaller (lossy) unless the toggle is off
  useEffect(() => {
    setPacked(null)
    if (!useCompact || !file) return
    let alive = true
    setPacking(true)
    compactPhoto(file)
      .then((r) => alive && setPacked(r))
      .finally(() => alive && setPacking(false))
    return () => {
      alive = false
    }
  }, [useCompact, file])

  const textBytes = useMemo(() => new TextEncoder().encode(text), [text])
  const size = kind === 'text' ? textBytes.length : useCompact && packed ? packed.bytes.length : (file?.size ?? 0)
  const tooBig = size > MAX_TRANSFER_BYTES
  const canContinue = size > 0 && !tooBig && !packing

  const go = async () => {
    setBusy(true)
    setErr('')
    try {
      const usePacked = useCompact && packed
      const bytes = kind === 'text' ? textBytes : usePacked ? packed.bytes : new Uint8Array(await file!.arrayBuffer())
      const prepared: PreparedTransfer = await prepareTransfer(
        {
          bytes,
          name: kind === 'text' ? 'message.txt' : usePacked ? packed.name : file!.name,
          mime: kind === 'text' ? 'text/plain' : usePacked ? packed.mime : file!.type || 'application/octet-stream',
        },
        PROFILES[tier]!,
      )
      setMode({ kind: 'transfer', prepared })
      setStep('show')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (step === 'show' && mode) {
    return (
      <SenderView
        mode={mode}
        onExit={() => {
          setMode(null)
          setStep('compose')
        }}
      />
    )
  }

  if (step === 'checklist') {
    return (
      <main className="screen">
        <button className="back" onClick={() => setStep('compose')}>
          ← Back
        </button>
        <h1>Before you start</h1>
        {!warned && (
          <div className="card warn-card">
            <b>Flashing colours</b>
            <p>
              The sender screen shows rapidly changing coloured patterns. If you are sensitive to flashing
              images, don't use this.
            </p>
          </div>
        )}
        <ul className="checklist">
          <li>Turn screen brightness all the way up</li>
          <li>Turn off True Tone, Night Shift and auto-brightness</li>
          <li>Turn off Low Power Mode</li>
          <li>Hold both phones steady, about 15 to 25 cm apart (closer than you'd think, the code should fill the camera view), in decent light</li>
        </ul>
        {err && <p className="error">{err}</p>}
        <button
          className="big send"
          disabled={busy}
          onClick={() => {
            if (!warned) {
              try {
                localStorage.setItem(WARNED_KEY, '1')
              } catch {
                /* ignore */
              }
              setWarned(true)
            }
            void go()
          }}
        >
          {busy ? 'Preparing...' : warned ? 'Show the code' : 'I understand, show the code'}
        </button>
      </main>
    )
  }

  return (
    <main className="screen">
      <button className="back" onClick={onBack}>
        ← Back
      </button>
      <h1>Send</h1>

      <div className="seg">
        <button className={kind === 'text' ? 'on' : ''} onClick={() => setKind('text')}>
          Text
        </button>
        <button className={kind === 'file' ? 'on' : ''} onClick={() => setKind('file')}>
          File or photo
        </button>
      </div>

      {kind === 'text' ? (
        <textarea
          className="input"
          rows={5}
          placeholder="Type or paste something short"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      ) : (
        <label className="input filepick">
          <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          {file ? `${file.name} (${formatBytes(file.size)})` : 'Choose a file or photo'}
        </label>
      )}
      {isPhoto && (
        <label className="check">
          <input type="checkbox" checked={compact} onChange={(e) => setCompact(e.target.checked)} />
          <span>
            Compact photo (about {COMPACT_FACTOR}x smaller)
            <small>
              {packing
                ? 'Compacting...'
                : compact && packed
                  ? `${formatBytes(file!.size)} → ${formatBytes(packed.bytes.length)} (${packed.width}×${packed.height}, JPEG ${Math.round(packed.quality * 100)}%). Lossy: the copy you save is this smaller one.`
                  : compact
                    ? "This browser couldn't read the photo, so the original will be sent."
                    : 'Off: the original file is sent byte for byte (max 1 MB).'}
            </small>
          </span>
        </label>
      )}
      {tooBig && <p className="error">That's {formatBytes(size)}. The limit is {formatBytes(MAX_TRANSFER_BYTES)}.</p>}

      <h2>Speed</h2>
      <div className="tiers">
        {PROFILES.map((p) => (
          <button key={p.id} className={`tier ${tier === p.id ? 'on' : ''}`} onClick={() => setTier(p.id)}>
            <b>{p.label}</b>
            <span>{p.blurb}</span>
            <span className="est">
              {size > 0 ? `${formatSeconds(estimateSeconds(size, p))} best case` : `up to ${formatBytes(Math.round(bestCaseBytesPerSecond(p)))}/s`}
            </span>
          </button>
        ))}
      </div>
      <p className="muted">
        Best case assumes every frame is read perfectly. Real speed depends on light, steadiness and both cameras.
        Not sure which to pick? Run a Link Test from the home screen.
      </p>

      <button className="big send" disabled={!canContinue} onClick={() => setStep('checklist')}>
        Continue
      </button>
    </main>
  )
}
