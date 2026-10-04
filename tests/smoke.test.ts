import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '../src/engine/version'

describe('scaffold', () => {
  it('protocol version fits the 4-bit header field', () => {
    expect(PROTOCOL_VERSION).toBeGreaterThan(0)
    expect(PROTOCOL_VERSION).toBeLessThan(16)
  })
})
