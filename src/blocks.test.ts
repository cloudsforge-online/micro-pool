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
import { assembleCoinbase, witnessSerialisedCoinbase } from './coinbase.ts'
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
