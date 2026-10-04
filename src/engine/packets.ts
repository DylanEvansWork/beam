import { crc16 } from './crc'
import { rsDecode, rsEncode } from './reedSolomon'

export const PKT_DATA = 0
export const PKT_META = 1
export const PKT_TEST = 2

/** Bytes of non-payload packet body: type(1) session(2) symbolIndex(3) crc16(2). */
export const PACKET_OVERHEAD = 8

export interface PacketGeometry {
  /** Total RS codeword bytes per packet (<= 255). */
  n: number
  /** RS parity bytes per packet. */
  parity: number
}

export const payloadSize = (g: PacketGeometry): number => g.n - g.parity - PACKET_OVERHEAD

export interface Packet {
  type: number
  session: number
  index: number
  payload: Uint8Array
  /** RS byte positions corrected (diagnostics). */
  corrected: number
}

/** Serialise + RS-protect one packet. `payload` is zero-padded up to the payload size. */
export function encodePacket(
  g: PacketGeometry,
  type: number,
  session: number,
  index: number,
  payload: Uint8Array,
): Uint8Array {
  const N = payloadSize(g)
  if (payload.length > N) throw new Error(`payload ${payload.length} > ${N}`)
  const body = new Uint8Array(g.n - g.parity)
  body[0] = type
  body[1] = (session >> 8) & 0xff
  body[2] = session & 0xff
  body[3] = (index >> 16) & 0xff
  body[4] = (index >> 8) & 0xff
  body[5] = index & 0xff
  body.set(payload, 6)
  const c = crc16(body.subarray(0, body.length - 2))
  body[body.length - 2] = c >> 8
  body[body.length - 1] = c & 0xff
  return rsEncode(body, g.parity)
}

/** Returns null if RS fails or the CRC doesn't match (an erasure as far as the fountain is concerned). */
export function decodePacket(g: PacketGeometry, bytes: Uint8Array, erasures: number[] = []): Packet | null {
  const r = rsDecode(bytes, g.parity, erasures)
  if (!r.ok) return null
  const body = r.data
  const c = crc16(body.subarray(0, body.length - 2))
  if (body[body.length - 2] !== c >> 8 || body[body.length - 1] !== (c & 0xff)) return null
  const type = body[0]!
  if (type !== PKT_DATA && type !== PKT_META && type !== PKT_TEST) return null
  return {
    type,
    session: (body[1]! << 8) | body[2]!,
    index: (body[3]! << 16) | (body[4]! << 8) | body[5]!,
    payload: Uint8Array.from(body.subarray(6, body.length - 2)),
    corrected: r.corrected,
  }
}

export const MAX_NAME_BYTES = 32
export const MAX_MIME_BYTES = 24
/** Fixed META bytes (everything except name/mime contents): 1+1+4+2+1+4+4+32 + 2 length bytes. */
export const META_FIXED = 51

export interface Meta {
  version: number
  /** Profile id used by the sender. */
  tier: number
  session: number
  /** Number of source symbols. */
  K: number
  symbolSize: number
  compressed: boolean
  originalSize: number
  /** Size of the (possibly compressed) byte stream the fountain carries. */
  streamSize: number
  sha256: Uint8Array
  name: string
  mime: string
}

const enc = new TextEncoder()
const dec = new TextDecoder()

/** Truncate a string to at most `max` UTF-8 bytes without splitting a character. */
export function clampUtf8(s: string, max: number): Uint8Array {
  let bytes = enc.encode(s)
  while (bytes.length > max) {
    s = s.slice(0, -1)
    bytes = enc.encode(s)
  }
  return bytes
}

export function serializeMeta(m: Meta): Uint8Array {
  const name = clampUtf8(m.name, MAX_NAME_BYTES)
  const mime = clampUtf8(m.mime, MAX_MIME_BYTES)
  const out = new Uint8Array(META_FIXED + name.length + mime.length)
  const dv = new DataView(out.buffer)
  let o = 0
  out[o++] = m.version
  out[o++] = m.tier
  dv.setUint32(o, m.K); o += 4
  dv.setUint16(o, m.symbolSize); o += 2
  out[o++] = m.compressed ? 1 : 0
  dv.setUint32(o, m.originalSize); o += 4
  dv.setUint32(o, m.streamSize); o += 4
  out.set(m.sha256, o); o += 32
  out[o++] = name.length
  out.set(name, o); o += name.length
  out[o++] = mime.length
  out.set(mime, o)
  return out
}

export function parseMeta(session: number, b: Uint8Array): Meta | null {
  try {
    if (b.length < META_FIXED) return null
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
    let o = 0
    const version = b[o++]!
    const tier = b[o++]!
    const K = dv.getUint32(o); o += 4
    const symbolSize = dv.getUint16(o); o += 2
    const compressed = b[o++] === 1
    const originalSize = dv.getUint32(o); o += 4
    const streamSize = dv.getUint32(o); o += 4
    const sha256 = Uint8Array.from(b.subarray(o, o + 32)); o += 32
    const nl = b[o++]!
    if (nl > MAX_NAME_BYTES || o + nl + 1 > b.length) return null
    const name = dec.decode(b.subarray(o, o + nl)); o += nl
    const ml = b[o++]!
    if (ml > MAX_MIME_BYTES || o + ml > b.length) return null
    const mime = dec.decode(b.subarray(o, o + ml))
    if (K < 1 || symbolSize < 1 || streamSize > K * symbolSize || streamSize === 0) return null
    return { version, tier, session, K, symbolSize, compressed, originalSize, streamSize, sha256, name, mime }
  } catch {
    return null
  }
}
