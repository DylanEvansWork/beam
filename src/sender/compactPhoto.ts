import { MAX_TRANSFER_BYTES } from '../engine/session'

export interface CompactResult {
  bytes: Uint8Array
  name: string
  mime: string
  width: number
  height: number
  quality: number
  /** Resolution scale relative to the original (1 = same pixels). */
  scale: number
}

export const COMPACT_FACTOR = 5
const MIN_QUALITY = 0.6
const MAX_QUALITY = 0.92

const toBlob = (c: HTMLCanvasElement, q: number): Promise<Blob | null> =>
  new Promise((res) => c.toBlob(res, 'image/jpeg', q))

/**
 * Re-encode a photo as JPEG so it's about `COMPACT_FACTOR` times smaller (never above the 1 MB transfer limit).
 * Lossy. Keeps the highest resolution it can at quality >= 0.6, shrinking pixels only when quality alone
 * can't hit the target. Returns null if the browser can't decode the image (then send the original).
 */
export async function compactPhoto(file: File): Promise<CompactResult | null> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    return null
  }
  const target = Math.min(file.size / COMPACT_FACTOR, MAX_TRANSFER_BYTES * 0.97)
  const canvas = document.createElement('canvas')
  let best: { blob: Blob; q: number; s: number; w: number; h: number } | null = null

  for (let s = 1; s > 0.12; s *= 0.85) {
    const w = Math.max(1, Math.round(bitmap.width * s))
    const h = Math.max(1, Math.round(bitmap.height * s))
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')!
    ctx.imageSmoothingQuality = 'high'
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(bitmap, 0, 0, w, h)
    // largest quality that fits the target at this size (binary search)
    const floor = await toBlob(canvas, MIN_QUALITY)
    if (!floor) return null
    if (floor.size > target) {
      best = { blob: floor, q: MIN_QUALITY, s, w, h } // keep as fallback, shrink more
      continue
    }
    let lo = MIN_QUALITY
    let hi = MAX_QUALITY
    let fit = { blob: floor, q: MIN_QUALITY }
    for (let i = 0; i < 6; i++) {
      const mid = (lo + hi) / 2
      const b = await toBlob(canvas, mid)
      if (b && b.size <= target) {
        fit = { blob: b, q: mid }
        lo = mid
      } else hi = mid
    }
    best = { ...fit, s, w, h }
    break
  }
  bitmap.close()
  if (!best) return null
  const base = file.name.replace(/\.[^.]+$/, '') || 'photo'
  return {
    bytes: new Uint8Array(await best.blob.arrayBuffer()),
    name: `${base}.jpg`,
    mime: 'image/jpeg',
    width: best.w,
    height: best.h,
    quality: best.q,
    scale: best.s,
  }
}
