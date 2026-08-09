/**
 * Serialisation primitives, and the four byte orders a Stratum pool has to keep straight.
 *
 * There is very little logic in this file and a great deal of opportunity to be wrong. Almost every
 * defect a hand-written pool has is in here somewhere, and none of them announce themselves: a
 * reversed field produces a header that hashes to something uniform and random, which fails the
 * target comparison exactly as an honest losing nonce does. The pool rejects every share, the
 * miners leave, and the logs say `low difficulty share` throughout.
 *
 * ## The four orders, named once
 *
 *   1. **Internal order.** What consensus hashes and what goes in the 80-byte header. Hashes are
 *      little-endian here.
 *   2. **Display order.** What `getblocktemplate` returns for `previousblockhash` and each
 *      transaction's `txid`, and what an explorer shows. The reverse of internal order.
 *   3. **Stratum `prevhash` order.** Neither of the above — see `stratumPrevHash`.
 *   4. **Stratum scalar order.** `version`, `nbits`, `ntime` and `nonce` travel as big-endian hex
 *      strings and are written into the header as little-endian uint32. See `swap32Hex`.
 *
 * Every conversion between them is a named function here, used everywhere, and tested. The
 * alternative — a `.reverse()` at each call site — is how two of them end up disagreeing.
 */

/** A 32-byte hash from display order (an explorer, a node's RPC reply) into internal order. */
export function hashFromDisplay(hex: string): Buffer {
  const buffer = Buffer.from(hex, 'hex')
  if (buffer.length !== 32) throw new RangeError(`a 32-byte hash was expected, got ${buffer.length}`)
  return buffer.reverse()
}

/** A 32-byte hash from internal order back into display order, for a log line or a page. */
export function hashToDisplay(hash: Buffer): string {
  if (hash.length !== 32) throw new RangeError(`a 32-byte hash was expected, got ${hash.length}`)
  return Buffer.from(hash).reverse().toString('hex')
}

/**
 * The `prevhash` field of `mining.notify`, which is in neither of the obvious orders.
 *
 * **It is the display-order hash with its eight 4-byte words in reverse order, each word's own
 * bytes left alone.** That is not a description anybody would invent; it is an artefact of the
 * original Python implementation, which byte-swapped each 32-bit word and then reversed the whole
 * buffer — two operations that compose into exactly one word-order reversal. Every mining firmware
 * in the field expects it, so it is the protocol whatever its provenance.
 *
 * It is written here as the single operation it actually is rather than as the two it came from,
 * because the two-step version invites a reader to "simplify" it by removing one step, and the
 * result of removing either step is a header the miner assembles around a prevhash that is not the
 * chain's tip. Every share then fails, and nothing says why.
 */
export function stratumPrevHash(displayHex: string): string {
  const display = Buffer.from(displayHex, 'hex')
  if (display.length !== 32) throw new RangeError(`a 32-byte hash was expected, got ${display.length}`)
  const out = Buffer.alloc(32)
  for (let word = 0; word < 8; word += 1) {
    display.copy(out, (7 - word) * 4, word * 4, word * 4 + 4)
  }
  return out.toString('hex')
}

/**
 * The header's `hashPrevBlock` field, from the wire form above.
 *
 * The inverse of the composition described in `stratumPrevHash`: reversing the word ORDER and then
 * reversing the bytes WITHIN each word gives internal order. `bytes.test.ts` asserts the round trip
 * both ways rather than trusting this paragraph.
 */
export function headerPrevHashFromStratum(stratumHex: string): Buffer {
  const wire = Buffer.from(stratumHex, 'hex')
  if (wire.length !== 32) throw new RangeError(`a 32-byte hash was expected, got ${wire.length}`)
  const out = Buffer.alloc(32)
  for (let word = 0; word < 8; word += 1) {
    for (let byte = 0; byte < 4; byte += 1) {
      out[word * 4 + byte] = wire[word * 4 + (3 - byte)] as number
    }
  }
  return out
}

/**
 * An 8-character big-endian hex scalar — `ntime`, `nonce`, `version`, `nbits` — as the four
 * little-endian bytes the header carries.
 *
 * Stratum sends these big-endian and the header stores them little-endian. A miner that submits
 * `ntime` as `686f1c40` means the uint32 0x686f1c40, and bytes 68..72 of the header it hashed hold
 * `40 1c 6f 68`.
 */
export function swap32Hex(hex: string): Buffer {
  const buffer = Buffer.from(hex, 'hex')
  if (buffer.length !== 4) throw new RangeError(`a 4-byte scalar was expected, got ${buffer.length}`)
  return buffer.reverse()
}

/** A uint32 as the 8-character big-endian hex Stratum puts on the wire. */
export function toStratumScalar(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`a uint32 was expected, got ${value}`)
  }
  return value.toString(16).padStart(8, '0')
}

export function uint32LE(value: number): Buffer {
  const buffer = Buffer.alloc(4)
  // `>>> 0` so a version field with the top bit set — which every post-BIP9 template has — is
  // written as the unsigned value it is rather than throwing on a negative signed int.
  buffer.writeUInt32LE(value >>> 0, 0)
  return buffer
}

export function int64LE(value: bigint): Buffer {
  const buffer = Buffer.alloc(8)
  buffer.writeBigInt64LE(value, 0)
  return buffer
}

/** Bitcoin's compact size integer, as it prefixes every vector in a serialised transaction. */
export function varInt(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`varInt needs a non-negative integer, got ${value}`)
  if (value < 0xfd) return Buffer.from([value])
  if (value <= 0xffff) {
    const buffer = Buffer.alloc(3)
    buffer[0] = 0xfd
    buffer.writeUInt16LE(value, 1)
    return buffer
  }
  if (value <= 0xffffffff) {
    const buffer = Buffer.alloc(5)
    buffer[0] = 0xfe
    buffer.writeUInt32LE(value, 1)
    return buffer
  }
  const buffer = Buffer.alloc(9)
  buffer[0] = 0xff
  buffer.writeBigUInt64LE(BigInt(value), 1)
  return buffer
}

/**
 * The inverse of `varInt`, for the one place this repository has to READ a serialised transaction
 * rather than write one.
 *
 * That place is `mweb.ts`, which has to walk a transaction handed to it by the node far enough to
 * discover whether it is Litecoin's MWEB integrating transaction. Nothing else here parses; the
 * transactions in a template are opaque hex passed through untouched, and that is still the rule.
 *
 * **Non-minimal encodings are refused.** Bitcoin's compact size integer has exactly one legal
 * encoding per value, and `0xfd 0x01 0x00` — three bytes spelling the number one — is not it. Core
 * rejects it, so a reader here that accepted it would disagree with the node about where the next
 * field starts, which is the same class of defect as reading the wrong byte order: no error, just a
 * different answer to a question both sides thought they agreed on.
 */
export function readVarInt(buffer: Buffer, offset: number): { value: number; size: number } {
  if (offset >= buffer.length) throw new RangeError(`a compact size integer was expected at ${offset}`)
  const first = buffer.readUInt8(offset)
  if (first < 0xfd) return { value: first, size: 1 }
  if (first === 0xfd) {
    if (offset + 3 > buffer.length) throw new RangeError(`a 3-byte compact size integer runs past the end`)
    const value = buffer.readUInt16LE(offset + 1)
    if (value < 0xfd) throw new RangeError(`the compact size integer ${value} is not minimally encoded`)
    return { value, size: 3 }
  }
  if (first === 0xfe) {
    if (offset + 5 > buffer.length) throw new RangeError(`a 5-byte compact size integer runs past the end`)
    const value = buffer.readUInt32LE(offset + 1)
    if (value <= 0xffff) throw new RangeError(`the compact size integer ${value} is not minimally encoded`)
    return { value, size: 5 }
  }
  if (offset + 9 > buffer.length) throw new RangeError(`a 9-byte compact size integer runs past the end`)
  const wide = buffer.readBigUInt64LE(offset + 1)
  if (wide <= 0xffffffffn) throw new RangeError(`the compact size integer ${wide} is not minimally encoded`)
  // Nothing inside a transaction can legally be this long, and a length that does not fit a JS
  // number would become an approximate offset, which is worse than a refusal.
  throw new RangeError(`the compact size integer ${wide} is longer than any field in a transaction`)
}

/**
 * A script data push of up to 75 bytes, which is every push this repository makes.
 *
 * Deliberately refuses above 75 rather than emitting OP_PUSHDATA1. Everything pushed into a
 * coinbase scriptSig here — the BIP34 height, the extranonce, the pool's tag — is small by
 * construction, the whole scriptSig is capped at 100 bytes by consensus anyway, and a silent
 * switch to a two-byte opcode would change the offset at which the extranonce sits without
 * changing anything the caller can see.
 */
export function pushData(data: Buffer): Buffer {
  if (data.length > 75) throw new RangeError(`a push of ${data.length} bytes needs OP_PUSHDATA, which this pool does not emit`)
  return Buffer.concat([Buffer.from([data.length]), data])
}

/**
 * A script number, as BIP34 requires the block height to be encoded.
 *
 * Minimal, little-endian, sign-magnitude: the high bit of the last byte is the sign, so a value
 * whose top byte would otherwise set it gets a zero byte appended. Heights are positive so the
 * negative branch never fires on real input; it is written out because a sign-magnitude encoder
 * that silently drops the sign is the kind of thing that gets copied somewhere it matters.
 *
 * BIP34 requires this push to be the FIRST item of the coinbase scriptSig and to be minimally
 * encoded. A non-minimal encoding is a block the network rejects, which is a failure a pool
 * discovers exactly once, on the one block it ever finds.
 */
export function scriptNum(value: number): Buffer {
  if (!Number.isInteger(value)) throw new RangeError(`scriptNum needs an integer, got ${value}`)
  if (value === 0) return Buffer.alloc(0)
  const negative = value < 0
  let remaining = Math.abs(value)
  const bytes: number[] = []
  while (remaining > 0) {
    bytes.push(remaining & 0xff)
    remaining = Math.floor(remaining / 256)
  }
  const top = bytes[bytes.length - 1] as number
  if ((top & 0x80) !== 0) {
    bytes.push(negative ? 0x80 : 0x00)
  } else if (negative) {
    bytes[bytes.length - 1] = top | 0x80
  }
  return Buffer.from(bytes)
}

/** Is this a hex string of exactly `bytes` bytes? Used at every protocol boundary. */
export function isHex(value: unknown, bytes?: number): value is string {
  if (typeof value !== 'string') return false
  if (!/^[0-9a-fA-F]*$/.test(value)) return false
  if (value.length % 2 !== 0) return false
  return bytes === undefined || value.length === bytes * 2
}
