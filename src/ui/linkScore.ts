import { buildLayout } from '../engine/framing'
import { PROFILES } from '../engine/profiles'
import { bestCaseBytesPerSecond } from '../engine/session'
import type { TierStat } from './useReceiver'

export interface TierRow {
  tier: number
  name: string
  expectedFrames: number
  okFrames: number
  /** Fraction of the packets sent in this tier's phase that arrived intact. */
  packetFraction: number
  /** Best-case speed scaled by what actually arrived (bytes/s). Honest estimate, not a promise. */
  estBytesPerSec: number
}

export function scoreTiers(stats: Record<number, TierStat>): TierRow[] {
  return PROFILES.filter((p) => stats[p.id]).map((p) => {
    const s = stats[p.id]!
    const span = s.maxCounter - s.minCounter
    const expected = span >= 0 && span < 20000 ? span + 1 : s.okFrames
    const possible = Math.max(1, expected * buildLayout(p).packetsPerFrame)
    const fraction = Math.min(1, s.okPackets / possible)
    return {
      tier: p.id,
      name: p.label,
      expectedFrames: expected,
      okFrames: s.okFrames,
      packetFraction: fraction,
      estBytesPerSec: bestCaseBytesPerSecond(p) * fraction,
    }
  })
}

/** Best tier: highest estimated speed among tiers that were seen long enough and mostly arrived. */
export function recommend(rows: TierRow[]): TierRow | null {
  const ok = rows.filter((r) => r.expectedFrames >= 4 && r.packetFraction >= 0.4)
  if (!ok.length) return null
  return ok.reduce((a, b) => (b.estBytesPerSec > a.estBytesPerSec ? b : a))
}
