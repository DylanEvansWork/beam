import { it } from 'vitest'
import { appendFileSync, writeFileSync } from 'node:fs'
import { clearLayoutCache } from '../src/engine/framing'
import { PROFILES } from '../src/engine/profiles'
import { Rng } from '../src/engine/prng'
import { refreshLayouts } from '../src/receiver/decoder'
import { bestCaseBytesPerSecond } from '../src/engine/session'
import { runTransfer } from '../src/sim/run'
import type { PresetName } from '../src/sim/channel'

/**
 * Tier benchmark through the channel simulator. `BEAM_BENCH=quick` for a fast pass.
 * Writes a markdown table to bench/results.md.
 */
const quick = process.env.BEAM_BENCH === 'quick'
const SIZE = quick ? 12_000 : 30_000
/** Payload sized so a perfect transfer takes ~6 s of simulated time (keeps the slow tiers benchable). */
const sizeFor = (p: (typeof PROFILES)[number]) => Math.max(3000, Math.min(SIZE, Math.round(bestCaseBytesPerSecond(p) * 6)))
const OUT = 'bench/results.md'

function rand(n: number, seed: number) {
  const r = new Rng(seed)
  return Uint8Array.from({ length: n }, () => r.int(256))
}

it('tier benchmark', async () => {
  const presets: PresetName[] = quick ? ['moderate'] : ['easy', 'moderate', 'harsh']
  const trials = 1
  writeFileSync(OUT, `# Simulator benchmark\n\n~6 s of best-case stream per run (payload size varies by tier, shown in the table), 60 Hz display, simulated camera. Goodput = payload bytes / simulated seconds until hash-verified. \`ok\` = successful trials / trials.\n\n| tier | payload | channel | cam fps | ok | goodput KB/s (mean) | seconds (mean) | RS fixes | rejected frames (tear/blur/bad) |\n|---|---|---|---|---|---|---|---|---|\n`)
  for (const profile of PROFILES) {
    for (const preset of presets) {
      for (const fps of preset === 'easy' ? [60] : [60, 30]) {
        if (quick && fps === 30) continue
        let okN = 0
        let gp = 0
        let secs = 0
        let rs = 0
        let rej = 0
        let total = 0
        for (let t = 0; t < trials; t++) {
          const r = await runTransfer({ profile, bytes: rand(sizeFor(profile), 10 + t), preset, camFps: fps, seed: 20 + t, startCounter: t * 7, maxSeconds: 90 })
          if (r.ok) okN++
          gp += r.goodputBps
          secs += r.seconds
          rs += r.rsCorrected
          rej += r.statuses.tear + r.statuses.blur + r.statuses.badheader
          total += r.camFrames
        }
        const line = `| ${profile.name} | ${(sizeFor(profile) / 1000).toFixed(0)} KB | ${preset} | ${fps} | ${okN}/${trials} | ${(gp / trials / 1024).toFixed(2)} | ${(secs / trials).toFixed(1)} | ${Math.round(rs / trials)} | ${Math.round((100 * rej) / total)}% |\n`
        appendFileSync(OUT, line)
        console.log(line.trim())
      }
    }
  }
}, 3_600_000)

it('interleave / erasure comparison (balanced, harsh)', async () => {
  const p = PROFILES[1]!
  const lines: string[] = []
  for (const interleave of [true, false]) {
    for (const erasureConf of [0, 0.25]) {
      p.interleave = interleave
      clearLayoutCache()
      refreshLayouts()
      let secs = 0
      let okN = 0
      const trials = quick ? 1 : 3
      for (let t = 0; t < trials; t++) {
        const r = await runTransfer({ profile: p, bytes: rand(SIZE, 50 + t), preset: 'harsh', seed: 70 + t, maxSeconds: 90, decoderOptions: { erasureConf } })
        secs += r.seconds
        if (r.ok) okN++
      }
      lines.push(`| interleave=${interleave} erasureConf=${erasureConf} | ${okN}/${trials} | ${(secs / trials).toFixed(1)} s |`)
      console.log(lines[lines.length - 1])
    }
  }
  p.interleave = true
  clearLayoutCache()
  refreshLayouts()
  appendFileSync(OUT, `\n## Interleave / erasure decoding (balanced, harsh channel)\n\n| setting | ok | mean seconds |\n|---|---|---|\n${lines.join('\n')}\n`)
}, 3_600_000)
