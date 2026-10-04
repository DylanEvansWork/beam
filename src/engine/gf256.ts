/** GF(2^8) arithmetic with primitive polynomial x^8+x^4+x^3+x^2+1 (0x11d), generator alpha = 2. */
export const EXP = new Uint8Array(512)
export const LOG = new Uint8Array(256)

{
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!
}

export const gfMul = (a: number, b: number): number =>
  a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!

export const gfDiv = (a: number, b: number): number => {
  if (b === 0) throw new Error('GF division by zero')
  return a === 0 ? 0 : EXP[LOG[a]! + 255 - LOG[b]!]!
}

export const gfInv = (a: number): number => {
  if (a === 0) throw new Error('GF inverse of zero')
  return EXP[255 - LOG[a]!]!
}

/** alpha^n for any integer n (negative allowed). */
export const gfPowAlpha = (n: number): number => EXP[((n % 255) + 255) % 255]!
