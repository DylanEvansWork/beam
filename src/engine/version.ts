/** v2: whitening no longer depends on the frame counter, so torn frames can still be decoded packet by packet.
 * Wire protocol version, carried in every frame header (4 bits). Bump on any incompatible change. */
export const PROTOCOL_VERSION = 2
