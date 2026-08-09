/**
 * The four byte orders, and the serialisation primitives.
 *
 * `bytes.ts` says of the stratum `prevhash` order that "`bytes.test.ts` asserts the round trip both
 * ways rather than trusting this paragraph". This is that assertion. It matters more than it looks:
 * a wrong prevhash order does not produce an error, it produces a miner assembling headers around a
 * previous block that is not the tip, and every share failing with `low difficulty share` and no
 * explanation anywhere.
 *
 * The `prevhash` case is checked against an independently derived expectation — the composition of
 * the two operations the original Python implementation actually performed — rather than against a
 * second copy of the same loop. A test written as the implementation restated proves only that it
 * was copied correctly.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  hashFromDisplay,
  hashToDisplay,
  headerPrevHashFromStratum,
  int64LE,
  isHex,
  pushData,
  readVarInt,
  scriptNum,
  stratumPrevHash,
  swap32Hex,
  toStratumScalar,
  uint32LE,
  varInt,
} from './bytes.ts'

/** A hash with every byte distinct, so any transposition shows up rather than cancelling out. */
const DISTINCT = Array.from({ length: 32 }, (_unused, index) => index.toString(16).padStart(2, '0')).join('')
const TIP = '00000000000000000002a7c4c1e48d76c5a37902165a270156b7a8d72728a054'

/* ------------------------------------------------------------------ hashes */

test('display and internal order are exact inverses', () => {
  assert.equal(hashToDisplay(hashFromDisplay(TIP)), TIP)
  assert.equal(hashFromDisplay(TIP).toString('hex'), Buffer.from(TIP, 'hex').reverse().toString('hex'))
})

test('a hash of the wrong length is refused at the boundary', () => {
  assert.throws(() => hashFromDisplay('00'), RangeError)
  assert.throws(() => hashToDisplay(Buffer.alloc(31)), RangeError)
  assert.throws(() => stratumPrevHash('00'), RangeError)
  assert.throws(() => headerPrevHashFromStratum('00'), RangeError)
})

test('hashFromDisplay does not mutate its input', () => {
  // `Buffer.prototype.reverse` is in place, and a helper that reversed a caller's buffer would
  // corrupt a template's transaction list on the second read of it.
  const hex = TIP
  const first = hashFromDisplay(hex).toString('hex')
  const second = hashFromDisplay(hex).toString('hex')
  assert.equal(first, second)
})

test('hashToDisplay does not mutate its input', () => {
  const internal = hashFromDisplay(TIP)
  const before = internal.toString('hex')
  hashToDisplay(internal)
  assert.equal(internal.toString('hex'), before)
})

test('the stratum prevhash order is the display hash with its words reversed', () => {
  // Derived independently: take the display hash in 4-byte words and emit them last-first, each
  // word's own bytes untouched. If `stratumPrevHash` were "reverse the whole buffer" or "swap each
  // word", this would disagree.
  const display = Buffer.from(DISTINCT, 'hex')
  const words: string[] = []
  for (let word = 0; word < 8; word += 1) words.push(display.subarray(word * 4, word * 4 + 4).toString('hex'))
  assert.equal(stratumPrevHash(DISTINCT), words.reverse().join(''))
})

test('the stratum prevhash round trips to the header field and back', () => {
  for (const hash of [TIP, DISTINCT, '0'.repeat(64), 'f'.repeat(64)]) {
    // The composition that matters: what the miner is sent, converted back, must be the field the
    // header carries — which is the display hash in internal order.
    assert.equal(
      headerPrevHashFromStratum(stratumPrevHash(hash)).toString('hex'),
      hashFromDisplay(hash).toString('hex'),
    )
  }
})

test('the stratum prevhash is neither of the two obvious orders', () => {
  // Stated as a negative because both obvious answers are wrong and both look right.
  assert.notEqual(stratumPrevHash(DISTINCT), DISTINCT)
  assert.notEqual(stratumPrevHash(DISTINCT), hashFromDisplay(DISTINCT).toString('hex'))
})

/* ------------------------------------------------------------------ scalars */

test('a stratum scalar is big-endian on the wire and little-endian in the header', () => {
  assert.equal(swap32Hex('01020304').toString('hex'), '04030201')
  // A real one: ntime 0x686f1c40 lands in the header as 40 1c 6f 68.
  assert.equal(swap32Hex('686f1c40').toString('hex'), '401c6f68')
  assert.throws(() => swap32Hex('0102'), RangeError)
})

test('toStratumScalar is the inverse of reading a uint32', () => {
  assert.equal(toStratumScalar(0), '00000000')
  assert.equal(toStratumScalar(1), '00000001')
  assert.equal(toStratumScalar(0x20000000), '20000000')
  assert.equal(toStratumScalar(0xffffffff), 'ffffffff')
  assert.throws(() => toStratumScalar(-1), RangeError)
  assert.throws(() => toStratumScalar(0x100000000), RangeError)
  assert.throws(() => toStratumScalar(1.5), RangeError)
})

test('uint32LE writes a version with the top bit set as unsigned', () => {
  // Every post-BIP9 template has one. A signed write would throw here.
  assert.equal(uint32LE(0x20000000).toString('hex'), '00000020')
  assert.equal(uint32LE(0xffffffff).toString('hex'), 'ffffffff')
})

test('int64LE writes the coinbase value', () => {
  assert.equal(int64LE(0n).toString('hex'), '0000000000000000')
  // 3.125 BTC, the subsidy after the 2024 halving: 312_500_000 = 0x12a05f20.
  assert.equal(int64LE(312_500_000n).toString('hex'), '205fa01200000000')
  // 50 LTC, which is larger than 2^32 satoshi and so exercises the high word. A 32-bit write would
  // silently truncate this to zero and pay the miner nothing.
  assert.equal(int64LE(5_000_000_000n).toString('hex'), '00f2052a01000000')
  // Signed, matching Bitcoin's `CAmount`, which is an int64 in the serialisation even though a
  // negative output value is consensus-invalid. Not asserted as a refusal, because refusing here
  // would be this file inventing a rule the format does not have.
  assert.equal(int64LE(-1n).toString('hex'), 'ffffffffffffffff')
  // A value that does not fit is a thrown error rather than a truncation.
  assert.throws(() => int64LE(2n ** 63n), RangeError)
})

/* ------------------------------------------------------------------ compact size */

test('varInt covers all four widths at their boundaries', () => {
  assert.equal(varInt(0).toString('hex'), '00')
  assert.equal(varInt(0xfc).toString('hex'), 'fc')
  assert.equal(varInt(0xfd).toString('hex'), 'fdfd00')
  assert.equal(varInt(0xffff).toString('hex'), 'fdffff')
  assert.equal(varInt(0x10000).toString('hex'), 'fe00000100')
  assert.equal(varInt(0xffffffff).toString('hex'), 'feffffffff')
  assert.equal(varInt(0x100000000).toString('hex'), 'ff0000000001000000')
  assert.throws(() => varInt(-1), RangeError)
})

test('readVarInt is the inverse of varInt at every width', () => {
  // Round-tripped rather than spelled out again, because two hand-written tables agreeing proves
  // only that the same person wrote both.
  for (const value of [0, 1, 0xfc, 0xfd, 0xffff, 0x10000, 0xffffffff]) {
    const encoded = varInt(value)
    assert.deepEqual(readVarInt(encoded, 0), { value, size: encoded.length }, `varInt(${value})`)
  }
})

test('readVarInt reads at an offset, which is the only way it is ever used', () => {
  const buffer = Buffer.concat([Buffer.from('deadbeef', 'hex'), varInt(0x10000)])
  assert.deepEqual(readVarInt(buffer, 4), { value: 0x10000, size: 5 })
})

test('a non-minimal compact size integer is refused', () => {
  // `fd0100` is three bytes spelling the number one. Core rejects it, so a reader that accepted it
  // would disagree with the node about where the next field starts — and disagreeing about an offset
  // is how a transaction gets walked into the wrong byte and answers the wrong question.
  assert.throws(() => readVarInt(Buffer.from('fd0100', 'hex'), 0), RangeError)
  assert.throws(() => readVarInt(Buffer.from('feffff0000', 'hex'), 0), RangeError)
  assert.throws(() => readVarInt(Buffer.from('ff0100000000000000', 'hex'), 0), RangeError)
})

test('a compact size integer that runs past the end is refused rather than read short', () => {
  assert.throws(() => readVarInt(Buffer.alloc(0), 0), RangeError)
  assert.throws(() => readVarInt(Buffer.from('fd01', 'hex'), 0), RangeError)
  assert.throws(() => readVarInt(Buffer.from('fe010203', 'hex'), 0), RangeError)
  assert.throws(() => readVarInt(Buffer.from('ff01020304', 'hex'), 0), RangeError)
})

test('a length no field could have is refused rather than becoming an approximate offset', () => {
  // Above 2^32 a compact size integer stops fitting a JS number exactly. Nothing inside a
  // transaction is that long, so this is a refusal and not a limitation.
  assert.throws(() => readVarInt(Buffer.from('ff0000000000000001', 'hex'), 0), RangeError)
})

/* ------------------------------------------------------------------ script */

test('pushData refuses a push that would need OP_PUSHDATA', () => {
  assert.equal(pushData(Buffer.alloc(1, 0xab)).toString('hex'), '01ab')
  assert.equal(pushData(Buffer.alloc(75)).length, 76)
  // Refused rather than silently switching to a two-byte opcode: that would move the offset the
  // extranonce sits at without changing anything the caller can see.
  assert.throws(() => pushData(Buffer.alloc(76)), RangeError)
})

test('scriptNum encodes a height the way BIP34 requires', () => {
  assert.equal(scriptNum(0).toString('hex'), '')
  assert.equal(scriptNum(1).toString('hex'), '01')
  assert.equal(scriptNum(127).toString('hex'), '7f')
  // 128 needs a padding byte or its high bit would read as a sign. This is the minimality rule, and
  // a block whose height push is non-minimal is a block the network rejects.
  assert.equal(scriptNum(128).toString('hex'), '8000')
  assert.equal(scriptNum(255).toString('hex'), 'ff00')
  assert.equal(scriptNum(256).toString('hex'), '0001')
  // Block 227836, the height BIP34 was enforced from.
  assert.equal(scriptNum(227836).toString('hex'), 'fc7903')
  assert.equal(scriptNum(800_000).toString('hex'), '00350c')
  assert.throws(() => scriptNum(1.5), RangeError)
})

test('scriptNum keeps the sign it is given', () => {
  // Heights are positive so this branch never fires on real input. It is asserted because a
  // sign-magnitude encoder that drops the sign is the kind of thing that gets copied somewhere it
  // does matter.
  assert.equal(scriptNum(-1).toString('hex'), '81')
  assert.equal(scriptNum(-127).toString('hex'), 'ff')
  assert.equal(scriptNum(-128).toString('hex'), '8080')
})

/* ------------------------------------------------------------------ the boundary guard */

test('isHex is the check at every protocol boundary', () => {
  assert.ok(isHex('', undefined))
  assert.ok(isHex('deadBEEF', 4))
  assert.ok(!isHex('deadbee', 4)) // odd length
  assert.ok(!isHex('deadbeef', 3)) // wrong length
  assert.ok(!isHex('deadbeeg', 4)) // not hex
  assert.ok(!isHex(0xdeadbeef, 4))
  assert.ok(!isHex(null))
  assert.ok(!isHex(undefined))
})
