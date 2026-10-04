# Decisions

## Dependencies (one-line justification each)
- `react`, `react-dom`: UI framework requested in the spec.
- `vite`, `@vitejs/plugin-react`: build tooling.
- `typescript`: strict TS everywhere (`strict` + `noUncheckedIndexedAccess`, the codec is all typed-array indexing).
- `vitest`: unit tests for the engine and receiver (run in Node).
- `vite-plugin-pwa`: generates the service worker + manifest so the app works offline after first load. Supports Vite 8.
- `prettier`, `oxlint`: formatting and lint.
- No `fflate`: `CompressionStream('deflate-raw')` exists in Safari 16.4+/Chrome/Firefox. On a browser without it we send uncompressed (flag in META), which is fine.
- No QR library: the optional QR handshake wasn't built (see "Not built").
- Reed-Solomon, fountain code, CRC, PRNG, homography fitting are all in-repo and tested.

## Protocol decisions (and where they differ from the spec)
- **Non-systematic LT above K=40.** The spec asked for a systematic code. Measured: a systematic first pass followed by repair symbols costs ~30% reception overhead under packet loss (repair symbols mostly touch sources the receiver already has). Pure LT with GF(2) Gaussian fallback needs ~3-4% overhead for K >= 300 (see `tests/fountain.test.ts` output). For K <= 40 the first K symbols are still plain source symbols, so tiny messages decode from one clean frame. Soliton parameters (c=0.1, delta=0.1) tuned in `bench/fountain-tune.bench.ts`.
- **Max transfer 1 MB** (spec said 10 MB): Gaussian elimination doesn't scale to ~50k symbols and 10 MB at realistic speeds would take 30+ minutes.
- **META every 3rd frame, not every frame** (`metaEvery`, per profile). A META packet in every frame costs 1/4 of balanced throughput. Every 3rd frame is still about 0.2 s of delay for a late joiner. Data packets that arrive before META are buffered and replayed.
- **Reference blocks live in the left and right side bands** (2x2 blocks, each palette colour + black + white, three times per side, spread out), not in a single row. The header only needs three block rows, so the bands are free, and having both sides lets the colour model fit a horizontal gradient.
- **Finders are white-on-black.** The quiet zone and separators are black, so a normal dark-ring QR finder would merge with the background. Three finders (TL/TR/BL) plus a 5x5 alignment pattern in the BR corner and an interior lattice. Orientation comes from the right-angle corner; the BR anchor gives the fourth point for the homography.
- **Header: 48 bits as 2x2 black/white blocks, top and bottom copy.** Both must pass CRC8 and match exactly or the whole camera frame is rejected (tear/blend). Tier id + kind (data / lock-on / link test) share one nibble.
- **Whitening.** The byte stream is XORed with a PRNG stream seeded by (session, counter) so frames never contain long single-colour runs and padding is balanced.
- **Grid size is fixed per tier** (48/64/80/96), so the receiver snaps its estimate from the finder spacing to a known tier.
- **Colour model:** per frame, least-squares fit of observed vs expected colour over reference blocks and pilots with features [r g b 1] x [1, u, v] (gain, offset, cross-talk, plus a planar illumination gradient), then per-colour residual offsets for tone-curve non-linearity. Classification is nearest centroid against this frame's predicted centroids. Low-confidence cells become RS erasures when a plain decode fails.
- **Default RS parity ~20% (safe 28%)**, interleaving on. See the benchmark for the comparison.
- **Receiver geometry:** coarse run-length finder scan on a decimated copy, then per-anchor template matching (a sampled 7x7 / 5x5 pattern correlated over a small search window), then a two-pass homography fit with outlier rejection. Tracking reuses the previous homography to predict every anchor and only falls back to a full scan if too few anchors match.
- **Decoding frame size capped at 1280 px long side** (`?res=1920` to raise). Frames are grabbed on the main thread (`drawImage` + `getImageData`) and transferred to the worker, not `ImageBitmap`/`OffscreenCanvas`: one code path that works on every Safari. Frames are only grabbed when the worker is idle.

- **Photo compaction (lossy, ~5x, default on for images).** `src/sender/compactPhoto.ts` re-encodes via canvas to JPEG, keeping the highest resolution it can at quality >= 0.6 (binary search on quality, shrinking pixels in 0.85x steps only when needed), capped at 1 MB. Toggle off for byte-exact sends. Falls back to the original if the browser can't decode the image. "Save to camera roll" uses the Web Share sheet (Save Image), because web apps can't write to Photos directly.
- **Emoji / any Unicode text** is plain UTF-8 end to end (tested with flags and ZWJ sequences).

- **Protocol v2: torn frames are decoded, not discarded** (from the first real-phone diagnostics: 19 of 21 data frames were being rejected as "tear" at a 30 fps iPhone camera). Whitening no longer depends on the frame counter, interleaving is off by default (packets are contiguous row bands, so a tear costs one packet, not all of them), and a frame is accepted when both header copies agree, when both are valid but differ within the same session (a true tear), or when exactly one passes CRC *and* matches the last cleanly-seen session. Every packet still carries its own RS + CRC16, so a torn or damaged frame can never produce wrong data, only fewer packets. Version nibble bumped to 2, so old and new builds ignore each other cleanly.

## Not built
- **QR handshake on the lock-on screen**, **DeviceMotion prediction**, **manual exposure/focus controls beyond continuous autofocus + torch**: all marked optional in the spec. Exposure/white-balance drift is handled in software by the per-frame colour model.
- **Playwright e2e with Chrome fake camera**: optional in the spec. The simulator end-to-end tests plus the real-browser worker check cover the pipeline; the actual camera grab loop (`src/receiver/camera.ts`) is only verified by type-checking until it's run on real phones.

## Hosting
- Static build; `BEAM_BASE` selects the base path (`/beam/` for GitHub Pages, `/` for Vercel or any root). Manifest uses relative `start_url`/`scope`.
