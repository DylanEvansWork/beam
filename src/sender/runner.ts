import { QUIET_CELLS, rasterSize, rasterize, type Layout, type RasterImage } from '../engine/framing'

export interface FramePlan {
  cells: Uint8Array
  layout: Layout
  /** Hold time in display refreshes. */
  hold: number
}

export interface RunnerStats {
  counter: number
  cellPx: number
  gridPx: number
  hold: number
  grid: number
  intervalMs: number
  hz: number
  shown: number
}

/** Largest integer cell size (in device pixels) that fits the code plus quiet zone in the area. */
export const pickCellPx = (layout: Layout, availW: number, availH: number): number =>
  Math.max(2, Math.floor(Math.min(availW, availH) / (layout.G + 2 * QUIET_CELLS)))

/**
 * Draws a stream of frames onto one canvas at integer pixel scale, no smoothing. Frame n+1 is rasterised
 * right after frame n is presented, so the vsync-aligned present is just a putImageData. A frame is shown for
 * `hold` measured refresh intervals; the counter only advances when a new frame is actually shown.
 */
export class SenderRunner {
  private raf = 0
  private counter = 0
  private lastShown = -1e9
  private pending: { img: RasterImage; id: ImageData; hold: number; layout: Layout; cellPx: number } | null = null
  private bufs = new Map<number, { img: RasterImage; id: ImageData }>()
  private shown = 0
  private holdMs = 100
  private current: { hold: number; layout: Layout; cellPx: number } | null = null
  onStats?: (s: RunnerStats) => void
  private readonly canvas: HTMLCanvasElement
  private readonly provider: (counter: number) => FramePlan
  private readonly intervalMs: number
  private readonly viewport: () => { w: number; h: number; dpr: number }

  constructor(
    canvas: HTMLCanvasElement,
    provider: (counter: number) => FramePlan,
    intervalMs: number,
    viewport: () => { w: number; h: number; dpr: number },
  ) {
    this.canvas = canvas
    this.provider = provider
    this.intervalMs = intervalMs
    this.viewport = viewport
  }

  private prepare(counter: number): void {
    const plan = this.provider(counter)
    const { w, h, dpr } = this.viewport()
    const cellPx = pickCellPx(plan.layout, w * dpr, h * dpr)
    const size = rasterSize(plan.layout, cellPx)
    let buf = this.bufs.get(size)
    if (!buf) {
      const data = new Uint8ClampedArray(new ArrayBuffer(size * size * 4))
      buf = { img: { width: size, height: size, data }, id: new ImageData(data as Uint8ClampedArray<ArrayBuffer>, size, size) }
      this.bufs.clear()
      this.bufs.set(size, buf)
    }
    rasterize(plan.layout, plan.cells, cellPx, buf.img)
    this.pending = { img: buf.img, id: buf.id, hold: plan.hold, layout: plan.layout, cellPx }
  }

  start(): void {
    const ctx = this.canvas.getContext('2d', { alpha: false })!
    ctx.imageSmoothingEnabled = false
    this.prepare(this.counter)
    const tick = (t: number) => {
      this.raf = requestAnimationFrame(tick)
      const due = !this.current || t - this.lastShown >= this.holdMs - this.intervalMs * 0.5
      if (!due || !this.pending) return
      const p = this.pending
      const dpr = this.viewport().dpr
      if (this.canvas.width !== p.img.width) {
        this.canvas.width = p.img.width
        this.canvas.height = p.img.height
        this.canvas.style.width = `${p.img.width / dpr}px`
        this.canvas.style.height = `${p.img.height / dpr}px`
      }
      ctx.putImageData(p.id, 0, 0)
      this.lastShown = t
      this.holdMs = p.hold * this.intervalMs
      this.current = { hold: p.hold, layout: p.layout, cellPx: p.cellPx }
      this.shown++
      this.counter++
      this.prepare(this.counter)
      this.onStats?.({
        counter: this.counter - 1, cellPx: p.cellPx, gridPx: p.img.width, hold: p.hold, grid: p.layout.G,
        intervalMs: this.intervalMs, hz: 1000 / this.intervalMs, shown: this.shown,
      })
    }
    this.raf = requestAnimationFrame(tick)
  }

  stop(): void {
    cancelAnimationFrame(this.raf)
    this.raf = 0
  }
}
