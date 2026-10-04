/** Small deterministic PRNG (xorshift128-style seeded via splitmix32). Same output in Node and browsers. */
export class Rng {
  private a: number
  private b: number
  private c: number
  private d: number

  constructor(seed1: number, seed2 = 0) {
    let s = (Math.imul(seed1 | 0, 0x9e3779b1) ^ Math.imul((seed2 | 0) + 0x7f4a7c15, 0x85ebca6b)) | 0
    const next = () => {
      s = (s + 0x9e3779b9) | 0
      let z = s
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad)
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97)
      return (z ^ (z >>> 15)) | 0
    }
    this.a = next()
    this.b = next()
    this.c = next()
    this.d = next() || 1
  }

  /** Uniform uint32. */
  nextU32(): number {
    const t = this.d
    let s = this.a
    this.d = this.c
    this.c = this.b
    this.b = s
    let tt = t ^ (t << 11)
    tt ^= tt >>> 8
    s = (tt ^ s ^ (s >>> 19)) | 0
    this.a = s
    return s >>> 0
  }

  /** Uniform float in [0, 1). */
  float(): number {
    return this.nextU32() / 4294967296
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.float() * n)
  }

  /** Standard normal (Box-Muller). */
  gauss(): number {
    const u = 1 - this.float()
    const v = this.float()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }
}
