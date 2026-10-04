import { useEffect, useMemo, useState } from 'react'
import type { Meta } from '../engine/packets'
import { formatBytes, formatSeconds, isTextLike } from './format'

interface Props {
  meta: Meta
  bytes: Uint8Array
  seconds: number
  onAgain: () => void
}

export function Result({ meta, bytes, seconds, onAgain }: Props) {
  const mime = meta.mime || 'application/octet-stream'
  const blob = useMemo(() => new Blob([bytes as BlobPart], { type: mime }), [bytes, mime])
  const [url, setUrl] = useState('')
  const [copied, setCopied] = useState(false)
  const text = useMemo(() => (isTextLike(mime, meta.name) ? new TextDecoder().decode(bytes) : null), [bytes, mime, meta.name])

  useEffect(() => {
    const u = URL.createObjectURL(blob)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [blob])

  const share = async () => {
    const file = new File([blob], meta.name || 'beam-file', { type: mime })
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean }
    if (nav.canShare?.({ files: [file] })) {
      try {
        await nav.share({ files: [file] })
        return
      } catch {
        /* user cancelled or failed: fall back to the download link */
      }
    }
    const a = document.createElement('a')
    a.href = url
    a.download = meta.name || 'beam-file'
    a.click()
  }

  const copy = async () => {
    if (text === null) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* ignore */
    }
  }

  const speed = seconds > 0 ? bytes.length / seconds : 0

  return (
    <div className="result">
      <div className="tick" aria-hidden>
        ✓
      </div>
      <h2>Got it</h2>
      <p className="muted">
        {meta.name || 'File'} · {formatBytes(bytes.length)} · verified (SHA-256 match)
      </p>
      {text !== null ? (
        <pre className="textbox">{text}</pre>
      ) : mime.startsWith('image/') && url ? (
        <img className="preview" src={url} alt={meta.name} />
      ) : null}
      <p className="muted">
        {formatSeconds(seconds)} · {formatBytes(Math.round(speed))}/s effective
      </p>
      <div className="stack">
        {text !== null && (
          <button className="big send" onClick={copy}>
            {copied ? 'Copied' : 'Copy text'}
          </button>
        )}
        <button className="big" onClick={share}>
          {mime.startsWith('image/') ? 'Save / Share' : 'Save file'}
        </button>
        {url && (
          <a className="link center" href={url} download={meta.name || 'beam-file'}>
            Download link
          </a>
        )}
        <button className="big receive" onClick={onAgain}>
          Receive another
        </button>
      </div>
    </div>
  )
}
