/**
 * The bytes handed to `submitblock`, which are the only bytes in this repository that get exactly
 * one chance.
 *
 * Everything else a pool does happens thousands of times a day and is corrected by the next
 * attempt. A block is submitted perhaps once a year on a pool this size, and there is no second
 * submission of the same block — so the assertions here are about the *shape of the whole thing*
 * rather than about any one function's arithmetic: the header, the count, the coinbase in whichever
 * of its two serialisations the template implies, the transactions in the order the node gave them,
 * and — on Litecoin — the extension block behind its marker.
 *
 * The block-path assertions in the rest of the suite mine a real share against `REGTEST_BITS` and
 * check the verdict. These check what is sent afterwards, which is the half that a share's verdict
 * cannot tell you anything about.
 *
 * The real proof that a node accepts these bytes is not here and cannot be: it is
 * `regtest.test.ts`, which submits them to a litecoind. This file is what stops the shape drifting
 * between runs of that.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { serialiseFoundBlock } from './blocks.ts'
import { assembleCoinbase, coinbaseScriptSig, witnessSerialisedCoinbase } from './coinbase.ts'
import { commitmentOffset, magicOccurrences, MERGED_MINING_MAGIC, serialiseAuxPow } from './auxpow.ts'
import { sha256d, targetFromCompactBits } from './pow.ts'
import { buildJob, type Job } from './work.ts'
import { parseTemplate } from './template.ts'
import { MWEB_BLOCK_PRESENT } from './mweb.ts'
import {
  fakeTemplateReply,
  FAKE_PAYOUT_SCRIPT,
  REGTEST_HOGEX_DATA,
  REGTEST_MWEB_BLOCK,
  type FakeTemplateOptions,
} from './faketemplate.ts'
import type { AuxBlock } from './auxtemplate.ts'
import type { FoundBlock } from './session.ts'

const EXTRANONCE1 = Buffer.from('deadbeef', 'hex')
const EXTRANONCE2 = Buffer.from('01020304', 'hex')

function jobFor(options: FakeTemplateOptions = {}): Job {
  return buildJob({
    chain: options.mweb === true ? 'ltc' : 'btc',
    template: parseTemplate(fakeTemplateReply(options)),
    payoutScriptHex: FAKE_PAYOUT_SCRIPT,
    tag: Buffer.from('/cloudsforge/', 'utf8'),
    extranonce1Size: EXTRANONCE1.length,
    extranonce2Size: EXTRANONCE2.length,
    id: '1',
    cleanJobs: true,
    aux: null,
    createdAt: new Date(0),
  })
}

function foundFor(job: Job): FoundBlock {
  return {
    job,
    header: Buffer.alloc(80, 0x77),
    coinbase: assembleCoinbase(job.coinbase, EXTRANONCE1, EXTRANONCE2),
    headerHash: Buffer.alloc(32),
    account: 'acct',
    worker: 'w1',
    creditedDifficulty: 1,
  }
}

/* ------------------------------------------------------------------ the common shape */

test('a submitted block is the header, the count, the coinbase and the template transactions', () => {
  const job = jobFor()
  const found = foundFor(job)
  const block = Buffer.from(serialiseFoundBlock(found), 'hex')

  assert.ok(block.subarray(0, 80).equals(found.header))
  // The count includes the coinbase. Three template transactions makes four.
  assert.equal(block.readUInt8(80), 4)
  // The template carried a witness commitment, so the coinbase goes in witness-serialised — the
  // node rejects a block with the commitment output and no witness stack.
  const coinbase = witnessSerialisedCoinbase(found.coinbase)
  assert.ok(block.subarray(81, 81 + coinbase.length).equals(coinbase))
  assert.equal(
    block.subarray(81 + coinbase.length).toString('hex'),
    job.template.transactions.map((tx) => tx.data).join(''),
    'the template transactions must be passed through, in order, untouched',
  )
})

test('a template with no witness commitment submits the coinbase without a witness', () => {
  // The two are one decision: a witness stack with no commitment output is rejected exactly as a
  // commitment output with no witness stack is.
  const found = foundFor(jobFor({ witnessCommitment: null }))
  const block = Buffer.from(serialiseFoundBlock(found), 'hex')
  assert.ok(block.subarray(81, 81 + found.coinbase.length).equals(found.coinbase))
})

/* ------------------------------------------------------------------ MWEB */

test('a litecoin block ends with the extension block behind its presence marker', () => {
  const job = jobFor({ mweb: true })
  const block = Buffer.from(serialiseFoundBlock(foundFor(job)), 'hex')

  const mwebBytes = REGTEST_MWEB_BLOCK.length / 2
  assert.equal(block.readUInt8(block.length - mwebBytes - 1), MWEB_BLOCK_PRESENT)
  assert.equal(block.subarray(block.length - mwebBytes).toString('hex'), REGTEST_MWEB_BLOCK)
})

test('the integrating transaction is the last transaction of a litecoin block', () => {
  // The property the whole MWEB serialisation hangs off: Litecoin reads the extension block off the
  // wire only when the final transaction is the HogEx. This asserts it on the produced bytes rather
  // than on the template, so that anything between the two that reordered the list would be caught.
  const job = jobFor({ mweb: true })
  const block = serialiseFoundBlock(foundFor(job))
  const tail = `${REGTEST_HOGEX_DATA}${MWEB_BLOCK_PRESENT.toString(16).padStart(2, '0')}${REGTEST_MWEB_BLOCK}`
  assert.ok(block.endsWith(tail), 'the block must end with the HogEx, the marker and the extension block')
})

test('a block whose integrating transaction is not last is refused rather than submitted', () => {
  // `parseTemplate` refuses this template outright, so reaching `serialiseFoundBlock` with one takes
  // building the job around the parser. That is the point: the check is here because this is the
  // last moment before the bytes leave the process, and a guard that only exists at the boundary is
  // a guard that anything reordering the list downstream walks straight past.
  const job = jobFor({ mweb: true })
  const reordered: Job = {
    ...job,
    template: {
      ...job.template,
      transactions: [
        job.template.transactions[job.template.transactions.length - 1],
        ...job.template.transactions.slice(0, -1),
      ] as typeof job.template.transactions,
    },
  }
  assert.throws(() => serialiseFoundBlock(foundFor(reordered)), /not the last transaction/)
})

test('a bitcoin block has no marker byte at all, not a zero one', () => {
  // Core reads a marker only behind a final HogEx. On a chain that has none, a zero byte here is
  // trailing garbage rather than "no extension block", and the node rejects the block for it.
  const job = jobFor()
  const block = Buffer.from(serialiseFoundBlock(foundFor(job)), 'hex')
  const transactions = job.template.transactions.map((tx) => tx.data).join('')
  assert.ok(block.toString('hex').endsWith(transactions))
})

/* ------------------------------------------------- the merged-mining proof, which is not a block */

const AUX_HASH = '3c9d1f0a55e2b7648f0e12a3d4c5b6978a9b0c1d2e3f405162738495a6b7c8d9'

function auxBlockFor(hashHex = AUX_HASH): AuxBlock {
  return {
    chain: 'doge',
    hashHex,
    height: 5_100_000,
    bitsHex: '1a0ffff0',
    target: targetFromCompactBits(0x1a0ffff0),
    previousBlockHashHex: 'f'.repeat(64),
    coinbaseValue: 1_000_000_000_000n,
    fetchedAt: new Date(0),
  }
}

function mergedJob(aux: AuxBlock | null = auxBlockFor()): Job {
  return buildJob({
    chain: 'ltc',
    template: parseTemplate(fakeTemplateReply({ mweb: true })),
    payoutScriptHex: FAKE_PAYOUT_SCRIPT,
    tag: Buffer.from('/cloudsforge/', 'utf8'),
    extranonce1Size: EXTRANONCE1.length,
    extranonce2Size: EXTRANONCE2.length,
    id: '1',
    cleanJobs: true,
    aux,
    createdAt: new Date(0),
  })
}

test('the commitment is where CAuxPow::check will look, in the bytes actually submitted', () => {
  // Not in the bytes that were meant to be built. `coinbase.ts` explains why the scriptSig is read
  // back out of the assembled transaction, and this is the assertion that would notice if the two
  // ever stopped agreeing — which is the only occasion either of them matters.
  const job = mergedJob()
  const coinbase = assembleCoinbase(job.coinbase, EXTRANONCE1, EXTRANONCE2)
  const scriptSig = coinbaseScriptSig(coinbase)

  assert.equal(magicOccurrences(scriptSig), 1, 'exactly once in the whole scriptSig, or check refuses it')
  assert.notEqual(commitmentOffset(scriptSig, AUX_HASH), -1)
})

test('the aux root goes in unreversed, which is the opposite of every other hash here', () => {
  // The one place in this repository where 32 bytes of a hash are written in display order.
  // `auxpow.ts` is where the reasoning lives; this is what fails if somebody "fixes" it.
  const scriptSig = coinbaseScriptSig(assembleCoinbase(mergedJob().coinbase, EXTRANONCE1, EXTRANONCE2))
  const at = scriptSig.indexOf(MERGED_MINING_MAGIC) + MERGED_MINING_MAGIC.length
  const root = scriptSig.subarray(at, at + 32)

  assert.equal(root.toString('hex'), AUX_HASH)
  assert.notEqual(root.toString('hex'), Buffer.from(AUX_HASH, 'hex').reverse().toString('hex'))
})

test('a job with no aux chain carries no merged-mining magic at all', () => {
  const scriptSig = coinbaseScriptSig(assembleCoinbase(mergedJob(null).coinbase, EXTRANONCE1, EXTRANONCE2))
  assert.equal(magicOccurrences(scriptSig), 0)
})

test('the serialised proof is the CMerkleTx fields, hashBlock included, then the CAuxPow ones', () => {
  // The composition `serialiseAuxPow` documents, checked field by field from the outside. hashBlock
  // is the one every write-up of merged mining omits, and omitting it does not fail a check — it
  // shifts every later field 32 bytes and Dogecoin reports a malformed submission with no clue
  // which field was wrong.
  const job = mergedJob()
  const coinbase = assembleCoinbase(job.coinbase, EXTRANONCE1, EXTRANONCE2)
  const header = Buffer.alloc(80, 0x77)
  const proof = serialiseAuxPow({ parentCoinbase: coinbase, parentHeader: header, merkleSteps: job.merkleSteps })

  let at = 0
  assert.ok(proof.subarray(at, (at += coinbase.length)).equals(coinbase), 'the coinbase, non-witness')
  assert.ok(proof.subarray(at, (at += 32)).equals(sha256d(header)), 'hashBlock, internal order')
  assert.equal(proof.readUInt8(at), job.merkleSteps.length, 'the merkle branch length')
  at += 1
  for (const step of job.merkleSteps) {
    assert.ok(proof.subarray(at, (at += 32)).equals(step))
  }
  assert.equal(proof.readInt32LE(at), 0, 'nIndex: the coinbase is transaction 0')
  at += 4
  assert.equal(proof.readUInt8(at), 0, 'vChainMerkleBranch is empty at merkle height 0')
  at += 1
  assert.equal(proof.readInt32LE(at), 0, 'nChainIndex is 0 for every nonce at height 0')
  at += 4
  assert.ok(proof.subarray(at, (at += 80)).equals(header), 'the parent header, last')
  assert.equal(at, proof.length, 'and nothing after it')
})

test('the proof carries the coinbase without its witness, because a txid is witness-stripped', () => {
  // The template here has a witness commitment, so `serialiseFoundBlock` sends the witness form and
  // this must not. Dogecoin hashes what it is given and compares it against the merkle branch; the
  // witness form hashes to something that is in no merkle tree.
  const job = mergedJob()
  const coinbase = assembleCoinbase(job.coinbase, EXTRANONCE1, EXTRANONCE2)
  const proof = serialiseAuxPow({
    parentCoinbase: coinbase,
    parentHeader: Buffer.alloc(80, 0x77),
    merkleSteps: job.merkleSteps,
  })

  assert.ok(proof.subarray(0, coinbase.length).equals(coinbase))
  assert.ok(!proof.includes(witnessSerialisedCoinbase(coinbase)), 'the witness form must not be in the proof')
})
