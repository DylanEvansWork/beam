import { FountainDecoder } from '../engine/fountain'
import { PKT_DATA, PKT_META, PKT_TEST, parseMeta, type Meta, type Packet } from '../engine/packets'
import { finishTransfer } from '../engine/session'

export interface TransferResult {
  meta: Meta
  bytes: Uint8Array
}

export interface AssemblerProgress {
  session: number | null
  meta: Meta | null
  /** Source symbols solved / K (0..1). */
  fraction: number
  solved: number
  K: number
  received: number
  /** Reception overhead so far, received/K - 1. */
  overhead: number
  /** Total payload bytes accepted as new symbols. */
  bytesIn: number
  done: boolean
  error: string | null
}

const MAX_PENDING = 4000

/**
 * Packets -> fountain decoder keyed by session id. A new session id resets everything. Data that arrives
 * before the META packet is held (bounded) and replayed once META shows up. On completion the result is
 * decompressed and SHA-256 verified; on a hash mismatch the decoder restarts and keeps collecting.
 */
export class Assembler {
  private session: number | null = null
  private meta: Meta | null = null
  private dec: FountainDecoder | null = null
  private pending = new Map<number, Uint8Array>()
  private bytesIn = 0
  private done = false
  private error: string | null = null
  private finishing = false
  /** Set when a different session id replaced the previous one. */
  newSessionDetected = false

  progress(): AssemblerProgress {
    const K = this.meta?.K ?? 0
    return {
      session: this.session,
      meta: this.meta,
      fraction: this.done ? 1 : this.dec ? this.dec.solvedCount / this.dec.K : 0,
      solved: this.dec?.solvedCount ?? 0,
      K,
      received: this.dec?.received ?? 0,
      overhead: this.dec && this.dec.received > 0 ? this.dec.overhead : 0,
      bytesIn: this.bytesIn,
      done: this.done,
      error: this.error,
    }
  }

  reset(): void {
    this.session = null
    this.meta = null
    this.dec = null
    this.pending.clear()
    this.bytesIn = 0
    this.done = false
    this.error = null
    this.finishing = false
  }

  /** Call with each frame's header session so a new transfer is noticed even before META arrives. */
  noteSession(session: number): boolean {
    if (this.session === session) return false
    const had = this.session !== null
    this.reset()
    this.session = session
    this.newSessionDetected = had
    return had
  }

  /** Feed packets from one frame. Returns a result promise only on the call that completes the transfer. */
  ingest(packets: Packet[]): Promise<TransferResult> | null {
    if (this.done) return null
    // META first so same-frame data can be used immediately
    const sorted = [...packets].sort((a, b) => (a.type === PKT_META ? -1 : 0) - (b.type === PKT_META ? -1 : 0))
    for (const pk of sorted) {
      if (pk.session !== this.session) continue
      if (pk.type === PKT_META) {
        if (this.meta) continue
        const m = parseMeta(pk.session, pk.payload)
        if (!m) continue
        this.meta = m
        this.dec = new FountainDecoder(m.K, m.symbolSize, m.session)
        for (const [idx, payload] of this.pending) this.accept(idx, payload)
        this.pending.clear()
      } else if (pk.type === PKT_DATA) {
        if (this.dec) this.accept(pk.index, pk.payload)
        else if (this.pending.size < MAX_PENDING) this.pending.set(pk.index, pk.payload)
      } else if (pk.type === PKT_TEST) {
        // link-test packets carry no transfer data
      }
    }
    if (this.dec?.complete && !this.finishing) {
      this.finishing = true
      return this.finish()
    }
    return null
  }

  private accept(index: number, payload: Uint8Array): void {
    if (this.dec!.add(index, payload)) this.bytesIn += payload.length
  }

  private async finish(): Promise<TransferResult> {
    const meta = this.meta!
    try {
      const bytes = await finishTransfer(meta, this.dec!.data())
      this.done = true
      return { meta, bytes }
    } catch (e) {
      // wrong data (should be essentially impossible past RS+CRC16): refuse it and start collecting again
      this.error = e instanceof Error ? e.message : 'verification failed'
      this.dec = new FountainDecoder(meta.K, meta.symbolSize, meta.session)
      this.bytesIn = 0
      this.finishing = false
      throw new Error(this.error)
    }
  }
}
