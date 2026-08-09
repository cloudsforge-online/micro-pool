/**
 * Recognising Litecoin's MWEB integrating transaction, and refusing a template that puts it anywhere
 * but last.
 *
 * The first test in this file is the only one that is evidence rather than argument: it walks a
 * HogEx a real node actually emitted. Everything after it is synthetic, and synthetic transactions
 * are useful here for exactly one reason — a node will not produce the shapes that would break this,
 * so they have to be written by hand. A HogEx carrying a witness stack, an ordinary transaction with
 * a MimbleWimble part hanging off it, a HogEx in the middle of a list: none of those come out of
 * `getblocktemplate` today, and every one of them is a way for the parse to be quietly wrong.
 *
 * The `hogExIndexOf` half is about a refusal rather than a computation. `chains.ts` argues at length
 * that a named refusal beats a silent misconfiguration; this is the same argument one level down. A
 * template whose HogEx is not last cannot become a valid block, and the choice is between refusing
 * it — which shows up as a stale template and an unready chain — and reordering it, which would
 * invalidate the witness commitment the node computed over the order it sent.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { hogExIndexOf, isHogEx, MWEB_BLOCK_PRESENT } from './mweb.ts'
import { REGTEST_HOGEX_DATA } from './faketemplate.ts'

const HOGEX = Buffer.from(REGTEST_HOGEX_DATA, 'hex')

/** One input: a 32-byte prevout, an index, an empty scriptSig, a sequence. */
const INPUT = `${'11'.repeat(32)}00000000` + '00' + 'ffffffff'
/** One output: eight bytes of value and a two-byte script. */
const OUTPUT = `${'0000000000000000'}02${'6a00'}`

/**
 * A transaction with whatever marker, flags and trailing MWEB byte the case needs.
 *
 * Written as string concatenation rather than through a builder because the point of each case is
 * the exact byte in the exact position, and a builder would put a layer between the test and the
 * thing it is asserting about.
 */
function transaction(args: { flags: number | null; witness?: string; mwebByte?: string }): Buffer {
  const head =
    args.flags === null
      ? `01000000` + `01${INPUT}` + `01${OUTPUT}`
      : `01000000` + `00${args.flags.toString(16).padStart(2, '0')}` + `01${INPUT}` + `01${OUTPUT}`
  return Buffer.from(`${head}${args.witness ?? ''}${args.mwebByte ?? ''}00000000`, 'hex')
}

/* ------------------------------------------------------------------ the real thing */

test('a HogEx captured from a real litecoind template is recognised', () => {
  // Litecoin Core 0.21.5.6, regtest, 2026-08-09. The fixture is bytes the node emitted, so this
  // asserts agreement with an implementation rather than with this repository's reading of a spec.
  assert.ok(isHogEx(HOGEX))
})

test('the real HogEx has the layout mweb.ts documents', () => {
  // Field by field, because the parse is a sequence of offsets and an off-by-one in any of them
  // would still answer `true` on this one input by luck.
  assert.equal(HOGEX.readUInt32LE(0), 2, 'version')
  assert.equal(HOGEX.readUInt8(4), 0x00, 'the empty-input-vector marker')
  assert.equal(HOGEX.readUInt8(5), 0x08, 'flags: MWEB set, witness clear')
  // The commitment to the extension block: witness version 8, a 32-byte program. This is where
  // MWEB's commitment lives, and it is why the coinbase needs no MWEB output.
  assert.ok(HOGEX.includes(Buffer.from('5820', 'hex')), 'the OP_8 <32-byte> commitment output')
  // Present-and-empty MWEB field, then the locktime. The `00` five bytes from the end is the byte
  // that makes this a HogEx rather than an ordinary MWEB transaction.
  assert.equal(HOGEX.readUInt8(HOGEX.length - 5), 0x00, 'the empty MWEB field')
  assert.equal(HOGEX.readUInt32LE(HOGEX.length - 4), 0, 'locktime')
})

/* ------------------------------------------------------------------ what is not a HogEx */

test('a pre-segwit transaction is not a HogEx and is not parsed past its input count', () => {
  // No marker means no flags byte, which means there is no MWEB field to look for. The answer has
  // to come from the shape rather than from a search of the bytes for a zero.
  assert.equal(isHogEx(transaction({ flags: null })), false)
})

test('a segwit transaction with no MWEB field is not a HogEx', () => {
  assert.equal(isHogEx(transaction({ flags: 1, witness: '0100' })), false)
})

test('a transaction carrying a MimbleWimble part of its own is not a HogEx', () => {
  // `flags & 8` with the MWEB field PRESENT — marker 0x01 — is an ordinary Litecoin transaction with
  // a MimbleWimble transaction attached. It goes in the block in template order like any other, and
  // reading `flags & 8` alone as "this is the HogEx" would put the extension block behind the wrong
  // transaction.
  assert.equal(isHogEx(transaction({ flags: 8, mwebByte: `01${'ab'.repeat(8)}` })), false)
})

test('a HogEx is still recognised behind a witness stack that has to be skipped', () => {
  // No node emits this today: the HogEx's single input is a previous HogEx output with no witness.
  // It is here because the witness-skipping branch is otherwise never taken, and an unexercised
  // skip is a skip that is wrong the first time something needs it.
  const witnessed = transaction({ flags: 9, witness: '02' + '02aabb' + '00', mwebByte: '00' })
  assert.ok(isHogEx(witnessed))
})

test('the witness skip walks every input, not just the first', () => {
  const twoInputs = Buffer.from(
    `01000000` +
      `0009` +
      `02${INPUT}${INPUT}` +
      `01${OUTPUT}` +
      // One stack per input. A skip that read only the first would land inside the second and read
      // its length byte as the MWEB marker.
      `01${'20'}${'cc'.repeat(32)}` +
      `01${'20'}${'dd'.repeat(32)}` +
      `00` +
      `00000000`,
    'hex',
  )
  assert.ok(isHogEx(twoInputs))
})

/* ------------------------------------------------------------------ malformed input */

test('a transaction that cannot be walked throws rather than answering false', () => {
  // These bytes are going into a block unchanged. "Not a HogEx" would be a guess dressed as an
  // answer, and the consequence of guessing wrong is an extension block in the wrong place.
  assert.throws(() => isHogEx(Buffer.from('0100000000', 'hex')), RangeError)
  assert.throws(() => isHogEx(Buffer.from('01000000000801', 'hex')), RangeError)
})

/* ------------------------------------------------------------------ position */

test('a list with no HogEx reports no index', () => {
  assert.equal(hogExIndexOf([transaction({ flags: null }), transaction({ flags: 1, witness: '0100' })]), -1)
  assert.equal(hogExIndexOf([]), -1)
})

test('a HogEx at the end is the position consensus requires', () => {
  assert.equal(hogExIndexOf([transaction({ flags: null }), HOGEX]), 1)
  assert.equal(hogExIndexOf([HOGEX]), 0)
})

test('a HogEx anywhere but last is refused, and the refusal says why reordering is not the fix', () => {
  assert.throws(
    () => hogExIndexOf([HOGEX, transaction({ flags: null })]),
    (err: unknown) =>
      err instanceof Error && /not last/.test(err.message) && /witness commitment/.test(err.message),
  )
})

test('two integrating transactions are refused rather than the last one winning', () => {
  // A block has exactly one. Silently taking the last would produce a block whose first HogEx is an
  // ordinary transaction spending the previous block's MWEB output, which is not a thing.
  assert.throws(() => hogExIndexOf([HOGEX, HOGEX]), /two MWEB integrating transactions/)
})

/* ------------------------------------------------------------------ the marker byte */

test('the extension block presence marker is the byte litecoind writes', () => {
  // Checked against a node-mined regtest block on 2026-08-09: its tail is 0x01 followed by exactly
  // the bytes the template's `mweb` field held. The template does not include this byte, so it is
  // this repository's to write, and getting it wrong is a block the node cannot deserialise.
  assert.equal(MWEB_BLOCK_PRESENT, 0x01)
})
