import { encodeSymbol } from './fountain'
import {
  KIND_DATA, KIND_LOCKON, KIND_TEST, buildFrameCells, buildLayout, buildLockonCells, makeTierKind,
  type FrameHeader, type Layout,
} from './framing'
import {
  PKT_DATA, PKT_META, PKT_TEST, clampUtf8, encodePacket, payloadSize, serializeMeta, MAX_NAME_BYTES, type Meta,
} from './packets'
import type { Profile } from './profiles'
import { Rng } from './prng'
import { PROTOCOL_VERSION } from './version'

export const MAX_TRANSFER_BYTES = 1024 * 1024

const subtle = (): SubtleCrypto => {
  const s = globalThis.crypto?.subtle
  if (!s) throw new Error('Web Crypto unavailable (needs HTTPS or localhost)')
  return s
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest('SHA-256', bytes as BufferSource))
}

type Transform = { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }

async function pipeThrough(bytes: Uint8Array, stream: Transform): Promise<Uint8Array> {
  const writer = stream.writable.getWriter()
  void writer.write(bytes as never).then(() => writer.close()).catch(() => {})
  const chunks: Uint8Array[] = []
  const reader = stream.readable.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  const out = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0))
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  return out
}

export const canCompress = (): boolean => typeof CompressionStream !== 'undefined'

export const compress = (bytes: Uint8Array): Promise<Uint8Array> =>
  pipeThrough(bytes, new CompressionStream('deflate-raw') as unknown as Transform)

export const decompress = (bytes: Uint8Array): Promise<Uint8Array> =>
  pipeThrough(bytes, new DecompressionStream('deflate-raw') as unknown as Transform)

export function randomSessionId(): number {
  const b = new Uint16Array(1)
  globalThis.crypto.getRandomValues(b)
  return b[0]!
}

export interface PreparedTransfer {
  meta: Meta
  /** The K source symbols. */
  symbols: Uint8Array[]
  profile: Profile
}

export interface TransferInput {
  bytes: Uint8Array
  name: string
  mime: string
}

/** file -> (compress unless it grows) -> SHA-256 of original -> K symbols. */
export async function prepareTransfer(
  input: TransferInput,
  profile: Profile,
  session = randomSessionId(),
): Promise<PreparedTransfer> {
  if (input.bytes.length === 0) throw new Error('Nothing to send')
  if (input.bytes.length > MAX_TRANSFER_BYTES) throw new Error('Too big: the limit is 1 MB')
  const layout = buildLayout(profile)
  const symbolSize = payloadSize(layout.packet)
  let stream = input.bytes
  let compressed = false
  if (canCompress()) {
    const c = await compress(input.bytes)
    if (c.length < input.bytes.length) {
      stream = c
      compressed = true
    }
  }
  const K = Math.ceil(stream.length / symbolSize)
  const symbols: Uint8Array[] = []
  for (let i = 0; i < K; i++) {
    const s = new Uint8Array(symbolSize)
    s.set(stream.subarray(i * symbolSize, (i + 1) * symbolSize))
    symbols.push(s)
  }
  const meta: Meta = {
    version: PROTOCOL_VERSION,
    tier: profile.id,
    session,
    K,
    symbolSize,
    compressed,
    originalSize: input.bytes.length,
    streamSize: stream.length,
    sha256: await sha256(input.bytes),
    name: new TextDecoder().decode(clampUtf8(input.name, MAX_NAME_BYTES)),
    mime: input.mime,
  }
  return { meta, symbols, profile }
}

/** Rebuild + verify the original bytes from the fountain's concatenated output. Throws on a hash mismatch. */
export async function finishTransfer(meta: Meta, concatenated: Uint8Array): Promise<Uint8Array> {
  let bytes = concatenated.subarray(0, meta.streamSize)
  if (meta.compressed) bytes = await decompress(bytes)
  if (bytes.length !== meta.originalSize) throw new Error('size mismatch')
  const h = await sha256(bytes)
  for (let i = 0; i < 32; i++) if (h[i] !== meta.sha256[i]) throw new Error('hash mismatch')
  return bytes
}

/** Best-case stream time in seconds: every frame decodes, nominal refresh rate. A floor, not a promise. */
export function estimateSeconds(streamBytes: number, profile: Profile, refreshHz = 60): number {
  const layout = buildLayout(profile)
  const perFrame = (layout.packetsPerFrame - 1 / profile.metaEvery) * payloadSize(layout.packet)
  const fps = refreshHz / profile.hold
  return (streamBytes * 1.05) / (perFrame * fps)
}

/** Best-case payload throughput in bytes/second for a tier. */
export function bestCaseBytesPerSecond(profile: Profile, refreshHz = 60): number {
  const layout = buildLayout(profile)
  return ((layout.packetsPerFrame - 1 / profile.metaEvery) * payloadSize(layout.packet) * refreshHz) / profile.hold
}

/**
 * Deterministic frame generator: frame(counter) depends only on (session, counter), so streams are
 * exactly reproducible. Symbol indices run 0,1,2,... forever, so repair symbols never repeat.
 */
export class FrameSource {
  readonly layout: Layout
  readonly prepared: PreparedTransfer
  private readonly metaBytes: Uint8Array

  constructor(prepared: PreparedTransfer) {
    this.prepared = prepared
    this.layout = buildLayout(prepared.profile)
    this.metaBytes = serializeMeta(prepared.meta)
  }

  header(counter: number, kind: number): FrameHeader {
    return {
      version: PROTOCOL_VERSION,
      tierKind: makeTierKind(this.prepared.profile.id, kind),
      session: this.prepared.meta.session,
      counter: counter & 0xffff,
    }
  }

  frame(counter: number): Uint8Array {
    const { profile, meta, symbols } = this.prepared
    const l = this.layout
    const ppf = l.packetsPerFrame
    const metaFrame = counter % profile.metaEvery === 0
    const metaFramesBefore = Math.ceil(counter / profile.metaEvery)
    let sym = counter * ppf - metaFramesBefore
    const packets: Uint8Array[] = []
    for (let s = 0; s < ppf; s++) {
      if (s === 0 && metaFrame) {
        packets.push(encodePacket(l.packet, PKT_META, meta.session, 0, this.metaBytes))
      } else {
        const idx = sym++ & 0xffffff
        packets.push(encodePacket(l.packet, PKT_DATA, meta.session, idx, encodeSymbol(symbols, meta.session, idx)))
      }
    }
    return buildFrameCells(l, this.header(counter, KIND_DATA), packets)
  }

  lockon(counter: number): Uint8Array {
    return buildLockonCells(this.layout, this.header(counter, KIND_LOCKON))
  }
}

/** Known-content packets for Link Test: payload is a pure function of the symbol index. */
export function testPayload(index: number, size: number): Uint8Array {
  const rng = new Rng(index, 0x7e57)
  return Uint8Array.from({ length: size }, () => rng.nextU32() & 0xff)
}

export function buildTestFrame(profile: Profile, session: number, counter: number): Uint8Array {
  const l = buildLayout(profile)
  const N = payloadSize(l.packet)
  const packets: Uint8Array[] = []
  for (let s = 0; s < l.packetsPerFrame; s++) {
    const idx = (counter * l.packetsPerFrame + s) & 0xffffff
    packets.push(encodePacket(l.packet, PKT_TEST, session, idx, testPayload(idx, N)))
  }
  const header: FrameHeader = {
    version: PROTOCOL_VERSION,
    tierKind: makeTierKind(profile.id, KIND_TEST),
    session,
    counter: counter & 0xffff,
  }
  return buildFrameCells(l, header, packets)
}
