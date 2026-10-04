import type { ReportMsg, WorkerIn, WorkerOut, ResultMsg } from './worker'

export interface CameraInfo {
  label: string
  width: number
  height: number
  /** Frame rate the browser claims; do not trust, see measured fps. */
  claimedFps: number | null
  capabilities: Record<string, unknown>
  settings: Record<string, unknown>
  torch: boolean
}

export interface LoopStats {
  /** Frames per second actually delivered by the camera (from requestVideoFrameCallback timing). */
  deliveredFps: number
  /** Frames per second the worker finished. */
  workerFps: number
  dropped: number
  grabbed: number
  decodeMs: number
  captureMs: number
  videoW: number
  videoH: number
  sentW: number
  sentH: number
}

type VideoWithRvfc = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: { presentedFrames?: number }) => void) => number
  cancelVideoFrameCallback?: (id: number) => void
}

const DEFAULT_LONG_SIDE = 1280

/** Long-side pixel budget for frames sent to the decoder. `?res=1920` raises it for sharper cells at more CPU. */
const maxLongSide = (): number => {
  const v = Number(new URLSearchParams(location.search).get('res'))
  return v >= 640 && v <= 2560 ? v : DEFAULT_LONG_SIDE
}

/** Rear camera + a frame loop that feeds the decode worker, dropping frames while the worker is busy. */
export class CameraLoop {
  private stream: MediaStream | null = null
  private worker: Worker | null = null
  private video: VideoWithRvfc | null = null
  private canvas = document.createElement('canvas')
  private ctx: CanvasRenderingContext2D | null = null
  private busy = false
  private id = 0
  private running = false
  private cbHandle = 0
  private delivered: number[] = []
  private finished: number[] = []
  private dropped = 0
  private grabbed = 0
  private decodeMs = 0
  private captureMs = 0
  private sentW = 0
  private sentH = 0
  private lastFrame: { data: Uint8ClampedArray; w: number; h: number; id: number; quad: [number, number][] | null } | null = null
  info: CameraInfo | null = null
  onReport?: (r: ReportMsg) => void
  onResult?: (r: ResultMsg) => void
  onError?: (message: string) => void

  async start(video: HTMLVideoElement): Promise<CameraInfo> {
    this.video = video as VideoWithRvfc
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 60 },
      },
    })
    this.stream = stream
    video.srcObject = stream
    video.muted = true
    video.playsInline = true
    await video.play()
    const track = stream.getVideoTracks()[0]!
    const caps = (track.getCapabilities?.() ?? {}) as Record<string, unknown>
    // best effort: continuous autofocus; everything else left to the browser (unsupported on iOS Safari)
    try {
      const modes = caps.focusMode as string[] | undefined
      if (modes?.includes('continuous')) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' } as never] })
    } catch {
      /* ignore */
    }
    const s = track.getSettings()
    this.info = {
      label: track.label,
      width: s.width ?? video.videoWidth,
      height: s.height ?? video.videoHeight,
      claimedFps: s.frameRate ?? null,
      capabilities: caps,
      settings: s as Record<string, unknown>,
      torch: 'torch' in caps,
    }
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (e: MessageEvent<WorkerOut>) => this.onWorker(e.data)
    this.running = true
    this.loop()
    return this.info
  }

  async setTorch(on: boolean): Promise<void> {
    const track = this.stream?.getVideoTracks()[0]
    if (track) await track.applyConstraints({ advanced: [{ torch: on } as never] })
  }

  send(m: WorkerIn): void {
    this.worker?.postMessage(m)
  }

  private onWorker(m: WorkerOut): void {
    if (m.type === 'report') {
      this.busy = false
      this.finished.push(performance.now())
      this.decodeMs = this.decodeMs * 0.9 + m.ms * 0.1
      if (this.lastFrame && this.lastFrame.id === m.id) this.lastFrame.quad = m.quad
      this.onReport?.(m)
    } else if (m.type === 'result') this.onResult?.(m)
    else this.onError?.(m.message)
  }

  private loop(): void {
    const v = this.video!
    const step = (now: number) => {
      if (!this.running) return
      this.delivered.push(now)
      this.grab()
      this.schedule(step)
    }
    this.schedule = (cb) => {
      if (v.requestVideoFrameCallback) this.cbHandle = v.requestVideoFrameCallback((n) => cb(n))
      else this.cbHandle = requestAnimationFrame((n) => cb(n))
    }
    this.schedule(step)
  }

  private schedule: (cb: (now: number) => void) => void = () => {}

  private grab(): void {
    const v = this.video!
    if (this.busy) {
      this.dropped++
      return
    }
    if (v.videoWidth === 0) return
    const t0 = performance.now()
    const scale = Math.min(1, maxLongSide() / Math.max(v.videoWidth, v.videoHeight))
    const w = Math.round(v.videoWidth * scale)
    const h = Math.round(v.videoHeight * scale)
    if (!this.ctx || this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })
    }
    this.ctx!.drawImage(v, 0, 0, w, h)
    const img = this.ctx!.getImageData(0, 0, w, h)
    this.captureMs = this.captureMs * 0.9 + (performance.now() - t0) * 0.1
    this.sentW = w
    this.sentH = h
    this.grabbed++
    this.busy = true
    // keep a copy for "Save a frame" only occasionally; the live buffer is transferred, not copied
    if (this.grabbed % 12 === 1) this.lastFrame = { data: new Uint8ClampedArray(img.data), w, h, id: this.id + 1, quad: null }
    this.worker!.postMessage(
      { type: 'frame', id: ++this.id, width: w, height: h, buffer: img.data.buffer } satisfies WorkerIn,
      [img.data.buffer],
    )
  }

  /** Last stats before stop(), so diagnostics taken after a finished transfer aren't all zeros. */
  private frozen: LoopStats | null = null

  stats(): LoopStats {
    if (this.frozen) return this.frozen
    const now = performance.now()
    const rate = (a: number[]) => {
      while (a.length && now - a[0]! > 2000) a.shift()
      return a.length > 1 ? ((a.length - 1) * 1000) / (a[a.length - 1]! - a[0]!) : 0
    }
    return {
      deliveredFps: rate(this.delivered),
      workerFps: rate(this.finished),
      dropped: this.dropped,
      grabbed: this.grabbed,
      decodeMs: this.decodeMs,
      captureMs: this.captureMs,
      videoW: this.video?.videoWidth ?? 0,
      videoH: this.video?.videoHeight ?? 0,
      sentW: this.sentW,
      sentH: this.sentH,
    }
  }

  /** PNG of the last frame sent to the worker, with the detected quad drawn on it. */
  async snapshot(): Promise<Blob | null> {
    const f = this.lastFrame
    if (!f) return null
    const quad = f.quad
    const c = document.createElement('canvas')
    c.width = f.w
    c.height = f.h
    const ctx = c.getContext('2d')!
    ctx.putImageData(new ImageData(f.data as Uint8ClampedArray<ArrayBuffer>, f.w, f.h), 0, 0)
    if (quad) {
      ctx.strokeStyle = '#34c759'
      ctx.lineWidth = 3
      ctx.beginPath()
      quad.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
      ctx.closePath()
      ctx.stroke()
    }
    return new Promise((res) => c.toBlob(res, 'image/png'))
  }

  stop(): void {
    if (this.running) this.frozen = this.stats()
    this.running = false
    const v = this.video
    if (v?.cancelVideoFrameCallback) v.cancelVideoFrameCallback(this.cbHandle)
    else cancelAnimationFrame(this.cbHandle)
    this.stream?.getTracks().forEach((t) => t.stop())
    this.worker?.terminate()
    this.worker = null
    this.stream = null
    if (v) v.srcObject = null
  }
}
