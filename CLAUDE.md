# Beam: working notes for Claude

Offline phone-to-phone data transfer: sender's screen shows a stream of colour-grid frames, receiver's camera decodes them. Static web app (Vite + React + strict TS), PWA, deployed on Vercel. No backend, no analytics, no network after load.

## Hard constraints
- 100% client-side. No network requests after load. Say so in the UI.
- One-way, **rateless**: no back-channel. Sender loops forever; receiver finishes when it has enough symbols, whenever it started.
- iPhone Safari is the main target (iPhone 17 Pro Max + iPhone 12 for testing). Camera ~60 fps at best; never trust `getSettings().frameRate`, measure via `requestVideoFrameCallback`. Must degrade to a 30 fps camera.
- Capabilities (exposure, focus, torch, zoom, wake lock) are feature-detected; missing ones are compensated in software, never a hard fail.
- Colours drift (auto-exposure/WB, True Tone). Every frame carries a reference strip + pilot cells; classify against *this frame's* centroids.
- Decoding runs in a Web Worker, drops frames under backpressure. Throughput over latency.
- Engine (`src/engine`) is framework-free TS: no DOM, runs in Node + Worker.
- Minimal deps. Each npm package needs a one-line justification in DECISIONS.md. Reed-Solomon and the fountain code are implemented in-repo.
- Never claim real-phone behaviour you couldn't test. Label it `UNVERIFIED ON DEVICE` and say exactly what Dylan should test/screenshot (debug HUD).
- Never output a corrupted file: SHA-256 of original bytes is verified before presenting.

## Protocol summary
- Frame: square grid of integer-pixel cells. Finder patterns (one distinguishable corner), alignment patterns, reference strip (every palette colour + black + white), pilot cells (~1 in 32), header (1 bit/cell, big cells) repeated top and bottom. Top/bottom header mismatch or CRC fail => discard the whole camera frame (tear/blend).
- Header: magic/version 4b, tier 4b, session 16b, frame counter 16b, CRC8.
- Data area = several independent packets per frame: `[type:1][session:2][symbolIndex:3][payload:N][crc16:2]` + RS over GF(256). Failed packet = erasure. Interleaving is a tunable, benchmarked in the simulator.
- Fountain: LT with robust soliton (systematic only for K <= 40), neighbours derived from `(session, symbolIndex)` via seeded PRNG; peeling decoder + GF(2) Gaussian fallback. ~3-4% overhead for K >= 300.
- META packet (version, session, tier, filename, mime, sizes, compression flag, K, symbol size, SHA-256) every 3rd frame (`metaEvery`).
- Pipeline: bytes -> deflate-raw (skip if it grows) -> SHA-256 of original -> K symbols -> fountain -> packets+RS -> frames.
- Tiers: safe (4 col), balanced (8, default), fast (16), max (experimental). All parametric in `profiles.ts`.

## Process
- Dylan asked for the whole thing built in one go (overrides the original milestone-by-milestone plan). The original milestone list is in the README history; everything up to Link Test and PWA is built. Remaining work is the real-device tuning loop: Dylan sends HUD diagnostics (`?debug=1`, Copy diagnostics, Save a frame) and we tune thresholds/palettes/cell sizes in `profiles.ts`, `decoder.ts` options, `locate.ts`.
- Log every non-obvious design decision in DECISIONS.md.
- Commands: `npm run dev | build | test | lint | typecheck | format | bench` (bench is slow, writes `bench/results.md`).
- Layout: `src/engine` (codec), `src/receiver` (locate/sample/decode/assemble, worker, camera), `src/sender` (renderer, scheduler), `src/sim` (channel simulator + runner + loopback worker), `src/ui`, `src/debug`.
- Tests live in `/tests`, import from `src/`.
