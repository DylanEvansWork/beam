import { useState } from 'react'

export type HudLines = Record<string, string | number | boolean | null | undefined>

export const debugFromUrl = (): boolean => new URLSearchParams(location.search).has('debug')

/** Compact JSON summary of a screen's debug state, for pasting back for tuning. */
export function buildDiagnostics(title: string, lines: HudLines, extra?: () => Record<string, unknown>): string {
  return JSON.stringify(
    {
      app: 'beam',
      build: __BUILD_ID__,
      screen: title,
      time: new Date().toISOString(),
      ua: navigator.userAgent,
      dpr: window.devicePixelRatio,
      viewport: [window.innerWidth, window.innerHeight],
      lines,
      ...(extra ? extra() : {}),
    },
    (_k, v) => (v instanceof Uint8Array ? `[${v.length} bytes]` : v),
    2,
  )
}

interface Props {
  title: string
  lines: HudLines
  /** Extra data included in the copied diagnostics but not shown. */
  extra?: () => Record<string, unknown>
  onSaveFrame?: () => Promise<Blob | null>
}

/** Debug overlay: live numbers plus "Copy diagnostics" and (receiver) "Save a frame". */
export function Hud({ title, lines, extra, onSaveFrame }: Props) {
  const [note, setNote] = useState('')

  const diagnostics = () => buildDiagnostics(title, lines, extra)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(diagnostics())
      setNote('Copied')
    } catch {
      setNote('Clipboard blocked: long-press the text below to copy')
      console.log(diagnostics())
    }
    setTimeout(() => setNote(''), 2500)
  }

  const save = async () => {
    const blob = await onSaveFrame?.()
    if (!blob) return setNote('No frame yet')
    const file = new File([blob], `beam-frame-${Date.now()}.png`, { type: 'image/png' })
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean }
    if (nav.canShare?.({ files: [file] })) {
      try {
        await nav.share({ files: [file] })
        return
      } catch {
        /* fall through to download */
      }
    }
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = file.name
    a.click()
  }

  return (
    <div className="hud" onClick={(e) => e.stopPropagation()}>
      <div className="hud-title">{title} debug</div>
      <div className="hud-grid">
        {Object.entries(lines).map(([k, v]) => (
          <div key={k} className="hud-row">
            <span>{k}</span>
            <b>{String(v ?? '-')}</b>
          </div>
        ))}
      </div>
      <div className="hud-actions">
        <button onClick={copy}>Copy diagnostics</button>
        {onSaveFrame && <button onClick={save}>Save a frame</button>}
        {note && <span>{note}</span>}
      </div>
    </div>
  )
}
