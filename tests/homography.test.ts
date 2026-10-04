import { describe, expect, it } from 'vitest'
import { applyH, fitAffine, fitHomography, type Pt } from '../src/receiver/homography'

describe('homography', () => {
  const truth = [1.1, 0.2, 40, -0.1, 0.95, 25, 0.0004, -0.0002, 1]
  const src: Pt[] = [[0, 0], [64, 0], [64, 64], [0, 64], [20, 40], [33, 12]]
  const dst = src.map(([x, y]) => applyH(truth, x, y))

  it('recovers a known homography from exact correspondences', () => {
    const h = fitHomography(src, dst)!
    for (const [x, y] of [[10, 10], [50, 3], [31.5, 60]] as Pt[]) {
      const a = applyH(h, x, y)
      const b = applyH(truth, x, y)
      expect(a[0]).toBeCloseTo(b[0], 5)
      expect(a[1]).toBeCloseTo(b[1], 5)
    }
  })

  it('is stable under small noise', () => {
    const noisy = dst.map(([x, y], i) => [x + Math.sin(i) * 0.3, y + Math.cos(i * 2) * 0.3] as Pt)
    const h = fitHomography(src, noisy)!
    const a = applyH(h, 32, 32)
    const b = applyH(truth, 32, 32)
    expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(1)
  })

  it('fits an affine from three points', () => {
    const aff = [2, 0.3, 10, -0.2, 1.8, 5, 0, 0, 1]
    const s: Pt[] = [[0, 0], [10, 0], [0, 10]]
    const h = fitAffine(s, s.map(([x, y]) => applyH(aff, x, y)))!
    const p = applyH(h, 4, 7)
    const q = applyH(aff, 4, 7)
    expect(p[0]).toBeCloseTo(q[0], 6)
    expect(p[1]).toBeCloseTo(q[1], 6)
  })
})
