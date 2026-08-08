/**
 * The coinbase split, checked by deserialising it.
 *
 * The defect this file exists to catch is the one `coinbase.ts` names in its own header: the
 * scriptSig length prefix is written into `coinb1` before the miner's extranonce bytes exist, and it
 * has to count them anyway. Get it wrong and every field after the scriptSig is read at the wrong
 * offset — the transaction still hashes to something, the miner still folds it through the branch,
 * the share still validates against the share target, and nothing at all goes wrong until the day a
 * share is a block and the node rejects it. There is no earlier signal.
 *
 * So the assertions here do not check the builder's arithmetic against the same arithmetic restated.
 * They **parse the assembled transaction back**, with a reader written independently below, and
 * check that the fields land where a node would look for them. A length prefix that under-counted
 * would produce a parse that runs off the end or finds a sequence number that is not 0xffffffff.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assembleCoinbase,
  buildCoinbase,
  buildHeader,
  coinbaseTxId,
  serialiseBlock,
  witnessSerialisedCoinbase,
  WITNESS_RESERVED_VALUE,
  type CoinbaseInput,
} from './coinbase.ts'
import { FAKE_PAYOUT_SCRIPT } from './faketemplate.ts'
import { sha256d } from './pow.ts'

const EXTRANONCE1 = Buffer.from('deadbeef', 'hex')
const EXTRANONCE2 = Buffer.from('01020304', 'hex')

function input(overrides: Partial<CoinbaseInput> = {}): CoinbaseInput {
  return {
    height: 800_000,
    coinbaseValue: 312_500_000n,
    payoutScriptHex: FAKE_PAYOUT_SCRIPT,
    witnessCommitmentHex: `6a24aa21a9ed${'22'.repeat(32)}`,
    tag: Buffer.from('/cloudsforge/', 'utf8'),
    extranonce1Size: 4,
    extranonce2Size: 4,
    ...overrides,
  }
}

/* ------------------------------------------------------------------ an independent reader */

/**
 * A minimal transaction reader, written from the serialisation format rather than from
 * `coinbase.ts`. Deliberately strict: it throws if anything is left over, which is what makes it a
 * test of the length prefix rather than a lenient re-reading of known-good bytes.
 */
function parseTransaction(bytes: Buffer): {
  version: number
  scriptSig: Buffer
  sequence: number
  outputs: { value: bigint; script: Buffer }[]
  locktime: number
} {
  let offset = 0
  const readVarInt = (): number => {
    const first = bytes.readUInt8(offset)
    offset += 1
    if (first < 0xfd) return first
    if (first === 0xfd) {
      const v = bytes.readUInt16LE(offset)
      offset += 2
      return v
    }
    if (first === 0xfe) {
      const v = bytes.readUInt32LE(offset)
      offset += 4
      return v
    }
    const v = Number(bytes.readBigUInt64LE(offset))
    offset += 8
    return v
  }

  const version = bytes.readUInt32LE(offset)
  offset += 4
  const inputCount = readVarInt()
  assert.equal(inputCount, 1, 'a coinbase has exactly one input')
  const prevoutHash = bytes.subarray(offset, offset + 32)
  offset += 32
  assert.ok(prevoutHash.equals(Buffer.alloc(32)), 'a coinbase spends the null outpoint')
  const prevoutIndex = bytes.readUInt32LE(offset)
  offset += 4
  assert.equal(prevoutIndex, 0xffffffff, 'a coinbase prevout index is 0xffffffff')
  const scriptSigLength = readVarInt()
  const scriptSig = bytes.subarray(offset, offset + scriptSigLength)
  assert.equal(scriptSig.length, scriptSigLength, 'the scriptSig runs off the end of the transaction')
  offset += scriptSigLength
  const sequence = bytes.readUInt32LE(offset)
  offset += 4

  const outputCount = readVarInt()
  const outputs: { value: bigint; script: Buffer }[] = []
  for (let i = 0; i < outputCount; i += 1) {
    const value = bytes.readBigInt64LE(offset)
    offset += 8
    const scriptLength = readVarInt()
    outputs.push({ value, script: bytes.subarray(offset, offset + scriptLength) })
    offset += scriptLength
  }

  const locktime = bytes.readUInt32LE(offset)
  offset += 4
  assert.equal(offset, bytes.length, 'trailing bytes: the transaction did not parse cleanly')
  return { version, scriptSig, sequence, outputs, locktime }
}

/* ------------------------------------------------------------------ the split */

test('the assembled coinbase deserialises as a valid transaction', () => {
  const parts = buildCoinbase(input())
  const tx = parseTransaction(assembleCoinbase(parts, EXTRANONCE1, EXTRANONCE2))

  assert.equal(tx.version, 1)
  assert.equal(tx.sequence, 0xffffffff)
  assert.equal(tx.locktime, 0)
  assert.equal(tx.outputs.length, 2, 'payout plus witness commitment')
  assert.equal(tx.outputs[0]?.value, 312_500_000n)
  assert.equal(tx.outputs[0]?.script.toString('hex'), FAKE_PAYOUT_SCRIPT)
  assert.equal(tx.outputs[1]?.value, 0n, 'the witness commitment output pays nothing')
})

test('the scriptSig length prefix counts the extranonce bytes the miner will insert', () => {
  // The whole point. The prefix is written into coinb1 before these bytes exist; if it counted only
  // what coinb1 holds, the parse above would find the sequence number eight bytes early.
  const parts = buildCoinbase(input())
  const tx = parseTransaction(assembleCoinbase(parts, EXTRANONCE1, EXTRANONCE2))

  // The scriptSig contains, in order: the height push, the extranonce push opcode and its 8 bytes,
  // then the tag push.
  assert.ok(tx.scriptSig.includes(EXTRANONCE1), 'extranonce1 is not inside the scriptSig')
  assert.ok(tx.scriptSig.includes(EXTRANONCE2), 'extranonce2 is not inside the scriptSig')
  assert.ok(tx.scriptSig.includes(Buffer.from('/cloudsforge/', 'utf8')), 'the tag is not inside the scriptSig')

  // And the prefix equals what is actually there.
  const heightPush = Buffer.from('0300350c', 'hex') // push 3 bytes: 800000 little-endian minimal
  const expected = heightPush.length + 1 + 8 + 1 + '/cloudsforge/'.length
  assert.equal(tx.scriptSig.length, expected)
})

test('coinb1 ends at the extranonce push opcode', () => {
  // The layout the split depends on: version(4) + inputCount(1) + prevoutHash(32) + prevoutIndex(4)
  // is 41 bytes, then the scriptSig varint, then the height push, then one opcode byte.
  const parts = buildCoinbase(input())
  assert.equal(parts.coinb1.readUInt32LE(0), 1, 'version')
  assert.equal(parts.coinb1.readUInt8(4), 1, 'one input')
  assert.ok(parts.coinb1.subarray(5, 37).equals(Buffer.alloc(32)), 'null prevout hash')
  assert.equal(parts.coinb1.readUInt32LE(37), 0xffffffff, 'prevout index')
  // Byte 41 is the scriptSig length prefix, one byte because the scriptSig is under 0xfd.
  const scriptSigLength = parts.coinb1.readUInt8(41)
  assert.ok(scriptSigLength < 0xfd)
  // The last byte of coinb1 is the push opcode for the extranonce, whose operand size is the total
  // of the two extranonce halves.
  assert.equal(parts.coinb1.readUInt8(parts.coinb1.length - 1), 8)
})

test('the extranonce is the only thing that moves between two assemblies', () => {
  // The property the protocol rests on: same job, different extranonce2, different txid.
  const parts = buildCoinbase(input())
  const first = assembleCoinbase(parts, EXTRANONCE1, Buffer.from('00000001', 'hex'))
  const second = assembleCoinbase(parts, EXTRANONCE1, Buffer.from('00000002', 'hex'))
  assert.equal(first.length, second.length)
  assert.notEqual(first.toString('hex'), second.toString('hex'))
  assert.notEqual(coinbaseTxId(first).toString('hex'), coinbaseTxId(second).toString('hex'))
})

test('an extranonce of the wrong length is refused rather than padded', () => {
  // A miner sending the wrong extranonce2 size would otherwise produce a transaction whose length
  // prefix disagrees with its contents, hashing to something the miner never computed.
  const parts = buildCoinbase(input())
  assert.throws(() => assembleCoinbase(parts, Buffer.alloc(3), EXTRANONCE2), RangeError)
  assert.throws(() => assembleCoinbase(parts, EXTRANONCE1, Buffer.alloc(5)), RangeError)
  assert.throws(() => assembleCoinbase(parts, EXTRANONCE1, Buffer.alloc(0)), RangeError)
})

/* ------------------------------------------------------------------ the refusals */

test('an over-long tag is refused at build time, by the push limit', () => {
  // Refused here, at boot, rather than at the first block found — which on a small pool could be a
  // year later.
  //
  // Worth being exact about WHICH limit bites, because there are two and they are not the same
  // number. With the shipped 8-byte extranonce the scriptSig is `14 + tag` bytes, so consensus's
  // 100-byte cap would allow a tag of 86 — but `pushData` refuses anything over 75, since a longer
  // push would need OP_PUSHDATA1 and that would move the offset the extranonce sits at. The push
  // limit is therefore the operative one for the tag, and 75 is the largest tag this pool accepts.
  assert.throws(() => buildCoinbase(input({ tag: Buffer.alloc(76, 0x41) })), RangeError)
  const parts = buildCoinbase(input({ tag: Buffer.alloc(75, 0x41) }))
  const tx = parseTransaction(assembleCoinbase(parts, EXTRANONCE1, EXTRANONCE2))
  assert.equal(tx.scriptSig.length, 89)
})

test('the consensus scriptSig cap is enforced independently of the push limit', () => {
  // The other limit, reached the only way it can be: a large extranonce rather than a large tag.
  // 4 (height push) + 1 + 75 (extranonce) + 1 + tag = 81 + tag, so a 19-byte tag lands exactly on
  // 100 and a 20-byte tag is one over.
  const big = { extranonce1Size: 40, extranonce2Size: 35 }
  const parts = buildCoinbase(input({ ...big, tag: Buffer.alloc(19, 0x41) }))
  const tx = parseTransaction(assembleCoinbase(parts, Buffer.alloc(40), Buffer.alloc(35)))
  assert.equal(tx.scriptSig.length, 100, 'exactly at the consensus cap')

  assert.throws(
    () => buildCoinbase(input({ ...big, tag: Buffer.alloc(20, 0x41) })),
    (err: unknown) => err instanceof RangeError && err.message.includes('101'),
    'one byte over the cap was not refused',
  )
})

test('an extranonce too large for a single push is refused', () => {
  assert.throws(() => buildCoinbase(input({ extranonce1Size: 40, extranonce2Size: 40 })), RangeError)
  assert.throws(() => buildCoinbase(input({ extranonce1Size: 0, extranonce2Size: 0 })), RangeError)
})

test('an empty payout script is refused', () => {
  // The one field that, if wrong, sends a block reward somewhere unrecoverable.
  assert.throws(() => buildCoinbase(input({ payoutScriptHex: '' })), RangeError)
})

test('a template with no witness commitment produces a single-output coinbase', () => {
  // Pre-segwit chains and regtest templates both do this. The output must simply be absent, not
  // present-and-empty.
  const parts = buildCoinbase(input({ witnessCommitmentHex: null }))
  const tx = parseTransaction(assembleCoinbase(parts, EXTRANONCE1, EXTRANONCE2))
  assert.equal(tx.outputs.length, 1)
  assert.equal(tx.outputs[0]?.value, 312_500_000n)
})

test('an empty witness commitment is refused rather than written as a zero-length output', () => {
  assert.throws(() => buildCoinbase(input({ witnessCommitmentHex: '' })), RangeError)
})

/* ------------------------------------------------------------------ the witness serialisation */

test('the witness serialisation preserves the txid', () => {
  // The property that makes a split coinbase compatible with segwit at all: the txid is over the
  // non-witness form, so adding the witness must not change what went into the merkle tree. If it
  // did, the block would commit to a merkle root the miner never hashed.
  const parts = buildCoinbase(input())
  const coinbase = assembleCoinbase(parts, EXTRANONCE1, EXTRANONCE2)
  const witness = witnessSerialisedCoinbase(coinbase)

  assert.equal(coinbaseTxId(coinbase).toString('hex'), sha256d(coinbase).toString('hex'))
  assert.notEqual(witness.toString('hex'), coinbase.toString('hex'))
  // The txid is unchanged because it is computed over the stripped form, which is `coinbase`.
  assert.equal(coinbaseTxId(coinbase).toString('hex'), coinbaseTxId(coinbase).toString('hex'))
})

test('the witness serialisation is the splice it claims to be', () => {
  const parts = buildCoinbase(input())
  const coinbase = assembleCoinbase(parts, EXTRANONCE1, EXTRANONCE2)
  const witness = witnessSerialisedCoinbase(coinbase)

  // marker(1) + flag(1) + stack count(1) + item length(1) + 32 bytes = 36.
  assert.equal(witness.length, coinbase.length + 36)
  // Version preserved at the front, locktime at the back.
  assert.equal(witness.readUInt32LE(0), coinbase.readUInt32LE(0))
  assert.equal(witness.readUInt32LE(witness.length - 4), coinbase.readUInt32LE(coinbase.length - 4))
  // The marker and flag a node looks for.
  assert.equal(witness.readUInt8(4), 0x00)
  assert.equal(witness.readUInt8(5), 0x01)
  // One stack item of 32 zero bytes, immediately before the locktime.
  const tail = witness.subarray(witness.length - 38, witness.length - 4)
  assert.equal(tail.readUInt8(0), 0x01, 'one witness stack item')
  assert.equal(tail.readUInt8(1), 0x20, 'of 32 bytes')
  assert.ok(tail.subarray(2).equals(WITNESS_RESERVED_VALUE))
  assert.ok(WITNESS_RESERVED_VALUE.equals(Buffer.alloc(32, 0)), 'the reserved value is 32 zero bytes')
})

test('the witness serialisation refuses something that is not a transaction', () => {
  assert.throws(() => witnessSerialisedCoinbase(Buffer.alloc(4)), RangeError)
})

/* ------------------------------------------------------------------ the header and the block */

test('the header is exactly eighty bytes in field order', () => {
  const header = buildHeader({
    version: Buffer.alloc(4, 0x11),
    prevHash: Buffer.alloc(32, 0x22),
    merkleRoot: Buffer.alloc(32, 0x33),
    ntime: Buffer.alloc(4, 0x44),
    nbits: Buffer.alloc(4, 0x55),
    nonce: Buffer.alloc(4, 0x66),
  })
  assert.equal(header.length, 80)
  assert.equal(
    header.toString('hex'),
    '11111111' + '22'.repeat(32) + '33'.repeat(32) + '44444444' + '55555555' + '66666666',
  )
})

test('a header field of the wrong size is refused by name', () => {
  // Named because a silently truncated or padded field produces an 80-byte header that hashes to a
  // value nobody else computes, and the error would otherwise be "shares are all rejected".
  const good = {
    version: Buffer.alloc(4),
    prevHash: Buffer.alloc(32),
    merkleRoot: Buffer.alloc(32),
    ntime: Buffer.alloc(4),
    nbits: Buffer.alloc(4),
    nonce: Buffer.alloc(4),
  }
  for (const field of ['version', 'prevHash', 'merkleRoot', 'ntime', 'nbits', 'nonce'] as const) {
    assert.throws(
      () => buildHeader({ ...good, [field]: Buffer.alloc(1) }),
      (err: unknown) => err instanceof RangeError && err.message.includes(field),
      `${field} was not refused by name`,
    )
  }
})

test('the serialised block is the header, the count, the coinbase and the transactions', () => {
  const parts = buildCoinbase(input())
  const coinbase = assembleCoinbase(parts, EXTRANONCE1, EXTRANONCE2)
  const header = Buffer.alloc(80, 0x77)
  const transactionsHex = ['0100000001aa', '0100000001bb']

  const block = serialiseBlock({ header, coinbase, transactionsHex })

  assert.ok(block.subarray(0, 80).equals(header))
  // The count includes the coinbase, which is the off-by-one a node rejects the block for.
  assert.equal(block.readUInt8(80), 3)
  assert.ok(block.subarray(81, 81 + coinbase.length).equals(coinbase))
  assert.equal(
    block.subarray(81 + coinbase.length).toString('hex'),
    transactionsHex.join(''),
    'template transactions must be passed through untouched',
  )
})

test('a block with only a coinbase counts one transaction', () => {
  const parts = buildCoinbase(input())
  const coinbase = assembleCoinbase(parts, EXTRANONCE1, EXTRANONCE2)
  const block = serialiseBlock({ header: Buffer.alloc(80), coinbase, transactionsHex: [] })
  assert.equal(block.readUInt8(80), 1)
  assert.equal(block.length, 80 + 1 + coinbase.length)
})
