import { Rng } from '../engine/prng'
import type { RasterImage } from '../engine/framing'
import { fitHomography, inv3, type Mat3, type Pt } from '../receiver/homography'

/**
 * Synthetic screen -> camera channel. Seeded, deterministic. Models: perspective + rotation + scale, rolling
 * shutter (rows read at different times, so a display frame change mid-readout tears the image), exposure
 * blend across a transition, Gaussian + motion blur, colour cast / cross-talk / gamma, auto-exposure drift,
 * vignette + glare, sensor noise, and 4:2:0 chroma subsampling (what real video pipelines do to colour).
 */

export interface ChannelParams {
  camW: number
  camH: number
  /** Camera pixels per source pixel (source = rasterised frame). */
  scale: number
  rotationDeg: number
  /** Perspective keystone strengths (0 = fronto-parallel). */
  tiltX: number
  tiltY: number
  /** Offset of the screen centre from the camera centre, in camera pixels. */
  offsetX: number
  offsetY: number
  blurSigma: number
  motionLen: number
  motionAngleDeg: number
  gain: [number, number, number]
  /** Black level added per channel (0..255). */
  offset: [number, number, number]
  /** Tone curve exponent applied to 0..1 values (1 = linear). */
  gamma: number
  /** Off-diagonal colour mixing strength. */
  crosstalk: number
  /** Auto-exposure random-walk step (fraction per frame). */
  exposureWalk: number
  noise: number
  vignette: number
  glare: number
  chroma420: boolean
  background: number
  /** Fraction of the camera frame period spent exposing each row. */
  exposureFrac: number
}

export const CHANNEL_PRESETS = {
  clean: {
    rotationDeg: 0, tiltX: 0, tiltY: 0, offsetX: 0, offsetY: 0, blurSigma: 0, motionLen: 0, motionAngleDeg: 0,
    gain: [1, 1, 1], offset: [0, 0, 0], gamma: 1, crosstalk: 0, exposureWalk: 0, noise: 0, vignette: 0, glare: 0,
    chroma420: false, background: 20, exposureFrac: 0.1,
  },
  easy: {
    rotationDeg: 2, tiltX: 0.02, tiltY: 0.02, offsetX: 8, offsetY: -6, blurSigma: 0.7, motionLen: 0, motionAngleDeg: 0,
    gain: [0.95, 1, 0.92], offset: [4, 3, 4], gamma: 1, crosstalk: 0.05, exposureWalk: 0.02, noise: 2, vignette: 0.1,
    glare: 10, chroma420: true, background: 25, exposureFrac: 0.15,
  },
  moderate: {
    rotationDeg: 5, tiltX: 0.05, tiltY: 0.04, offsetX: 14, offsetY: -10, blurSigma: 1.0, motionLen: 1.5, motionAngleDeg: 30,
    gain: [0.92, 1, 0.85], offset: [8, 6, 8], gamma: 0.92, crosstalk: 0.1, exposureWalk: 0.04, noise: 4, vignette: 0.2,
    glare: 25, chroma420: true, background: 30, exposureFrac: 0.25,
  },
  harsh: {
    rotationDeg: 9, tiltX: 0.09, tiltY: 0.07, offsetX: 24, offsetY: -18, blurSigma: 1.5, motionLen: 3.5, motionAngleDeg: 60,
    gain: [0.85, 1, 0.75], offset: [14, 10, 14], gamma: 0.85, crosstalk: 0.16, exposureWalk: 0.08, noise: 7, vignette: 0.3,
    glare: 50, chroma420: true, background: 40, exposureFrac: 0.4,
  },
} satisfies Record<string, Partial<ChannelParams>>

export type PresetName = keyof typeof CHANNEL_PRESETS

export function makeParams(preset: PresetName, over: Partial<ChannelParams> = {}, srcCellPx = 10, cellCamPx = 8): ChannelParams {
  return { camW: 1280, camH: 720, scale: cellCamPx / srcCellPx, ...CHANNEL_PRESETS[preset], ...over } as ChannelParams
}

export interface RowPlan {
  /** Per camera row: source index A, source index B (or -1), blend fraction toward B. */
  a: Int16Array
  b: Int16Array
  alpha: Float32Array
}

function bilerpRGB(src: RasterImage, x: number, y: number, out: number[]): void {
  const w = src.width
  const h = src.height
  const fx = x - 0.5
  const fy = y - 0.5
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const tx = fx - x0
  const ty = fy - y0
  const xa = Math.min(w - 1, Math.max(0, x0))
  const xb = Math.min(w - 1, Math.max(0, x0 + 1))
  const ya = Math.min(h - 1, Math.max(0, y0))
  const yb = Math.min(h - 1, Math.max(0, y0 + 1))
  const d = src.data
  const i00 = (ya * w + xa) * 4
  const i10 = (ya * w + xb) * 4
  const i01 = (yb * w + xa) * 4
  const i11 = (yb * w + xb) * 4
  for (let c = 0; c < 3; c++) {
    const top = d[i00 + c]! * (1 - tx) + d[i10 + c]! * tx
    const bot = d[i01 + c]! * (1 - tx) + d[i11 + c]! * tx
    out[c] = top * (1 - ty) + bot * ty
  }
}

function gaussBlur(buf: Float32Array, w: number, h: number, sigma: number): void {
  if (sigma < 0.3) return
  const r = Math.ceil(sigma * 3)
  const k = new Float32Array(2 * r + 1)
  let s = 0
  for (let i = -r; i <= r; i++) {
    k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma))
    s += k[i + r]!
  }
  for (let i = 0; i < k.length; i++) k[i] = k[i]! / s
  const tmp = new Float32Array(buf.length)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let a = 0
      let b = 0
      let c = 0
      for (let i = -r; i <= r; i++) {
        const xx = Math.min(w - 1, Math.max(0, x + i))
        const o = (y * w + xx) * 3
        const kv = k[i + r]!
        a += buf[o]! * kv
        b += buf[o + 1]! * kv
        c += buf[o + 2]! * kv
      }
      const o = (y * w + x) * 3
      tmp[o] = a
      tmp[o + 1] = b
      tmp[o + 2] = c
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let a = 0
      let b = 0
      let c = 0
      for (let i = -r; i <= r; i++) {
        const yy = Math.min(h - 1, Math.max(0, y + i))
        const o = (yy * w + x) * 3
        const kv = k[i + r]!
        a += tmp[o]! * kv
        b += tmp[o + 1]! * kv
        c += tmp[o + 2]! * kv
      }
      const o = (y * w + x) * 3
      buf[o] = a
      buf[o + 1] = b
      buf[o + 2] = c
    }
}

function motionBlur(buf: Float32Array, w: number, h: number, len: number, angleDeg: number): void {
  if (len < 0.8) return
  const n = Math.max(2, Math.ceil(len))
  const dx = Math.cos((angleDeg * Math.PI) / 180)
  const dy = Math.sin((angleDeg * Math.PI) / 180)
  const out = new Float32Array(buf.length)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let a = 0
      let b = 0
      let c = 0
      for (let i = 0; i < n; i++) {
        const t = (i / (n - 1) - 0.5) * len
        const xx = Math.min(w - 1, Math.max(0, Math.round(x + dx * t)))
        const yy = Math.min(h - 1, Math.max(0, Math.round(y + dy * t)))
        const o = (yy * w + xx) * 3
        a += buf[o]!
        b += buf[o + 1]!
        c += buf[o + 2]!
      }
      const o = (y * w + x) * 3
      out[o] = a / n
      out[o + 1] = b / n
      out[o + 2] = c / n
    }
  buf.set(out)
}

/** True source-pixel -> camera-pixel homography for a screen image of side S. */
export function screenHomography(S: number, p: ChannelParams): Mat3 {
  const half = (S * p.scale) / 2
  const th = (p.rotationDeg * Math.PI) / 180
  const cosT = Math.cos(th)
  const sinT = Math.sin(th)
  const cx = p.camW / 2 + p.offsetX
  const cy = p.camH / 2 + p.offsetY
  const dst: Pt[] = []
  const srcPts: Pt[] = [[0, 0], [S, 0], [S, S], [0, S]]
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
    const x = sx * half * (1 + p.tiltY * sy)
    const y = sy * half * (1 + p.tiltX * sx)
    dst.push([cx + x * cosT - y * sinT, cy + x * sinT + y * cosT])
  }
  return fitHomography(srcPts, dst)!
}

export class ChannelState {
  exposure = 1
}

/** Render one camera frame. `sources` are the display frames visible during this readout. */
export function renderCamera(
  sources: RasterImage[], plan: RowPlan, p: ChannelParams, rng: Rng, state: ChannelState,
): RasterImage {
  const { camW: W, camH: H } = p
  const S = sources[0]!.width
  const Hinv = inv3(screenHomography(S, p))! as Mat3

  const F = new Float32Array(W * H * 3)
  const bg = p.background
  const tmpA = [0, 0, 0]
  const tmpB = [0, 0, 0]
  const sub = [-0.25, 0.25]
  for (let y = 0; y < H; y++) {
    const A = sources[plan.a[y]!]!
    const B = plan.b[y]! >= 0 ? sources[plan.b[y]!]! : null
    const alpha = plan.alpha[y]!
    for (let x = 0; x < W; x++) {
      let r = 0
      let g = 0
      let b = 0
      for (const oy of sub)
        for (const ox of sub) {
          const px = x + 0.5 + ox
          const py = y + 0.5 + oy
          const wq = Hinv[6]! * px + Hinv[7]! * py + Hinv[8]!
          const sx = (Hinv[0]! * px + Hinv[1]! * py + Hinv[2]!) / wq
          const sy = (Hinv[3]! * px + Hinv[4]! * py + Hinv[5]!) / wq
          if (sx < 0 || sy < 0 || sx >= S || sy >= S) {
            r += bg
            g += bg
            b += bg
          } else {
            bilerpRGB(A, sx, sy, tmpA)
            if (B && alpha > 0.01) {
              bilerpRGB(B, sx, sy, tmpB)
              r += tmpA[0]! * (1 - alpha) + tmpB[0]! * alpha
              g += tmpA[1]! * (1 - alpha) + tmpB[1]! * alpha
              b += tmpA[2]! * (1 - alpha) + tmpB[2]! * alpha
            } else {
              r += tmpA[0]!
              g += tmpA[1]!
              b += tmpA[2]!
            }
          }
        }
      const o = (y * W + x) * 3
      F[o] = r / 4
      F[o + 1] = g / 4
      F[o + 2] = b / 4
    }
  }
  motionBlur(F, W, H, p.motionLen, p.motionAngleDeg)
  gaussBlur(F, W, H, p.blurSigma)

  // auto-exposure drift
  state.exposure = Math.min(1.35, Math.max(0.7, state.exposure * (1 + p.exposureWalk * rng.gauss() + (1 - state.exposure) * 0.1)))
  const ex = state.exposure
  const m = p.crosstalk
  const gx = W * 0.65
  const gy = H * 0.3
  const gr = W * 0.35
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 3
      const r0 = F[o]! / 255
      const g0 = F[o + 1]! / 255
      const b0 = F[o + 2]! / 255
      let r = r0 * (1 - 2 * m) + (g0 + b0) * m
      let g = g0 * (1 - 2 * m) + (r0 + b0) * m
      let b = b0 * (1 - 2 * m) + (r0 + g0) * m
      const dx = (x - W / 2) / (W / 2)
      const dy = (y - H / 2) / (H / 2)
      const vig = 1 - p.vignette * (dx * dx + dy * dy) * 0.5
      const gl = (p.glare / 255) * Math.exp(-((x - gx) ** 2 + (y - gy) ** 2) / (2 * gr * gr))
      r = Math.pow(Math.max(0, Math.min(1, r * p.gain[0] * ex * vig)), p.gamma) + p.offset[0] / 255 + gl
      g = Math.pow(Math.max(0, Math.min(1, g * p.gain[1] * ex * vig)), p.gamma) + p.offset[1] / 255 + gl
      b = Math.pow(Math.max(0, Math.min(1, b * p.gain[2] * ex * vig)), p.gamma) + p.offset[2] / 255 + gl
      const n = p.noise / 255
      F[o] = (r + n * rng.gauss()) * 255
      F[o + 1] = (g + n * rng.gauss()) * 255
      F[o + 2] = (b + n * rng.gauss()) * 255
    }

  if (p.chroma420) {
    for (let y = 0; y + 1 < H; y += 2)
      for (let x = 0; x + 1 < W; x += 2) {
        let cb = 0
        let cr = 0
        const ys: number[] = []
        for (let k = 0; k < 4; k++) {
          const o = ((y + (k >> 1)) * W + x + (k & 1)) * 3
          const r = F[o]!
          const g = F[o + 1]!
          const b = F[o + 2]!
          ys.push(0.299 * r + 0.587 * g + 0.114 * b)
          cb += -0.168736 * r - 0.331264 * g + 0.5 * b
          cr += 0.5 * r - 0.418688 * g - 0.081312 * b
        }
        cb /= 4
        cr /= 4
        for (let k = 0; k < 4; k++) {
          const o = ((y + (k >> 1)) * W + x + (k & 1)) * 3
          const Y = ys[k]!
          F[o] = Y + 1.402 * cr
          F[o + 1] = Y - 0.344136 * cb - 0.714136 * cr
          F[o + 2] = Y + 1.772 * cb
        }
      }
  }

  const out = new Uint8ClampedArray(W * H * 4)
  for (let i = 0, j = 0; i < W * H; i++, j += 4) {
    out[j] = F[i * 3]!
    out[j + 1] = F[i * 3 + 1]!
    out[j + 2] = F[i * 3 + 2]!
    out[j + 3] = 255
  }
  return { width: W, height: H, data: out }
}

export interface SimOptions {
  params: ChannelParams
  /** Display frame period in seconds (hold / refreshHz). */
  framePeriod: number
  camFps: number
  /** Chance a camera frame is dropped entirely. */
  dropProb?: number
  /** Camera frame start time jitter (seconds). */
  jitter?: number
  seed: number
  /** Display counter at t=0. */
  startCounter?: number
}

/**
 * Camera stream over a display stream: yields camera frames whose rows may come from different display
 * frames (tearing) and which are asynchronous to the display clock.
 */
export class CameraSim {
  private k = 0
  private rng: Rng
  private state = new ChannelState()
  private cache = new Map<number, RasterImage>()
  private readonly t0: number
  private readonly opts: SimOptions
  private readonly render: (counter: number) => RasterImage

  constructor(opts: SimOptions, render: (counter: number) => RasterImage) {
    this.opts = opts
    this.render = render
    this.rng = new Rng(opts.seed, 0xca3e)
    this.t0 = this.rng.float() * opts.framePeriod
  }

  private src(counter: number): RasterImage {
    let img = this.cache.get(counter)
    if (!img) {
      img = this.render(counter)
      this.cache.set(counter, img)
      if (this.cache.size > 6) this.cache.delete(this.cache.keys().next().value!)
    }
    return img
  }

  /** Next camera frame (null when the frame was "dropped"). */
  next(): { img: RasterImage; counters: number[]; time: number } | null {
    const { params: p, framePeriod, camFps } = this.opts
    const jitter = (this.rng.float() - 0.5) * (this.opts.jitter ?? 0.004)
    const t = this.k / camFps + this.t0 + jitter
    this.k++
    if (this.rng.float() < (this.opts.dropProb ?? 0)) return null
    const readout = (0.8 / camFps) * 1
    const expo = (p.exposureFrac / camFps)
    const base = this.opts.startCounter ?? 0
    const ids: number[] = []
    const idx = (c: number) => {
      let i = ids.indexOf(c)
      if (i < 0) { ids.push(c); i = ids.length - 1 }
      return i
    }
    const a = new Int16Array(p.camH)
    const b = new Int16Array(p.camH).fill(-1)
    const alpha = new Float32Array(p.camH)
    for (let y = 0; y < p.camH; y++) {
      const tr = t + (y / p.camH) * readout
      const c0 = Math.floor(tr / framePeriod)
      a[y] = idx(base + c0)
      const te = tr + expo
      const c1 = Math.floor(te / framePeriod)
      if (c1 !== c0) {
        b[y] = idx(base + c1)
        alpha[y] = (te - c1 * framePeriod) / expo
      }
    }
    const sources = ids.map((c) => this.src(c))
    const img = renderCamera(sources, { a, b, alpha }, p, this.rng, this.state)
    return { img, counters: ids, time: t }
  }
}
