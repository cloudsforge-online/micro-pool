/**
 * The test that mines a real block and has a real node accept it.
 *
 * ## Why this exists when `faketemplate.ts` already exists
 *
 * `faketemplate.ts` explains itself honestly: the block branch is unreachable at mainnet difficulty,
 * so the suite needs a template it can win against. That reasoning holds for everything downstream
 * of a template — the coinbase split, the merkle branch, the share verdict — because all of it is
 * arithmetic this repository performs and can therefore check against itself.
 *
 * It does not hold for the question this file answers. **A fixture cannot tell you whether Litecoin
 * accepts your block.** Every unit test around MWEB in this repository asserts that the bytes match
 * what a node was observed to produce on one particular day; not one of them would notice if that
 * observation were wrong, or if it stopped being true. `micro-org#277` was opened because the
 * repository's suite passed in full against a service that could not obtain a template at all.
 *
 * So this file drives the pool's own code — `TemplateSource`, `JobRegistry`, `coinbaseFor`,
 * `merkleRootFromBranch`, `buildHeader`, `powHash`, `serialiseFoundBlock` — against a litecoind, and
 * asserts on what `submitblock` says. Regtest is a faithful reproduction rather than an
 * approximation: MWEB activates there under the same code path, and a node at height 0 with MWEB
 * still in BIP9 `defined` refuses `{"rules":["segwit"]}` with the same `-8`. What regtest changes is
 * difficulty, which is the one thing that has to change for a test to find a block at all.
 *
 * ## Why it skips unless it is pointed at a node
 *
 * `scripts/regtest-mweb.sh` starts a litecoind in Docker, mines it past MWEB activation and exports
 * `POOL_REGTEST_NODE_URL`. Without that variable this file skips, which is what happens in CI: the
 * estate's shared `service-ci.yml` gives every service a Postgres and nothing else, and a bespoke CI
 * job in this repository is exactly what `.github/workflows/ci.yml` says the estate measures itself
 * on not having. The script is the reproduction, and the README says to run it.
 *
 * A skip is not a pass. `blocks.test.ts` and `mweb.test.ts` hold the shape of the bytes between runs
 * of this, and this is what says the shape was ever right.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { buildHeader } from './coinbase.ts'
import { serialiseFoundBlock } from './blocks.ts'
import { hashToDisplay, headerPrevHashFromStratum, swap32Hex, uint32LE } from './bytes.ts'
import { algorithmFor, poolChain } from './chains.ts'
import { coinbaseFor, JobRegistry, type Job } from './work.ts'
import { merkleRootFromBranch } from './merkle.ts'
import { coinbaseTxId } from './coinbase.ts'
import { meetsTarget, powHash, sha256d } from './pow.ts'
import { NodeRpc, NodeRpcError } from './rpc.ts'
import { payoutScriptFor, TemplateSource } from './template.ts'

/**
 * The node this runs against, credential and all, or nothing — in which case every test here skips.
 *
 * Deliberately a variable of its own rather than `POOL_LTC_NODE_URL`: pointing this file at the
 * variable the service itself reads would mean that anybody with a configured mainnet node in their
 * environment ran a block-mining test against it by accident.
 */
const NODE_URL = process.env['POOL_REGTEST_NODE_URL'] ?? ''
const skip = NODE_URL === '' ? 'set POOL_REGTEST_NODE_URL to run this; scripts/regtest-mweb.sh does' : false

/** Where the block reward goes. The script asks the node for one and exports it. */
const PAYOUT_ADDRESS = process.env['POOL_REGTEST_PAYOUT_ADDRESS'] ?? ''

const EXTRANONCE1 = Buffer.from('cf000001', 'hex')
const EXTRANONCE2_SIZE = 4

function rpc(): NodeRpc {
  return new NodeRpc({ chain: 'ltc', url: NODE_URL, deadlineMs: 30_000 })
}

/**
 * One template, through the real `TemplateSource` rather than through a bare RPC call.
 *
 * That matters because `TemplateSource.fetchOnce` is where `templateRules` is read and where
 * `parseTemplate` runs. A test that called `getblocktemplate` itself with a hand-written rules array
 * would prove that Litecoin answers a correct request, which was never in doubt; the question is
 * whether THIS service sends one.
 */
async function currentTemplate(node: NodeRpc, signal: AbortSignal) {
  const source = new TemplateSource({
    chain: 'ltc',
    rpc: node,
    onTemplate: () => {},
    onError: (err) => {
      throw err
    },
    signal,
  })
  return source.fetchOnce()
}

/**
 * Search for a nonce that clears the BLOCK target, the way a miner does.
 *
 * Rolls `extranonce2` in the outer loop and the header nonce in the inner one, which is the real
 * search space and not a shortcut: it means the coinbase changes, the merkle root changes with it,
 * and the block that comes out has been through the same coinbase assembly and merkle fold that a
 * miner's share would.
 *
 * At regtest's `207fffff` roughly every second scrypt hash clears the target, so this returns almost
 * immediately. The bound exists so a failure is a failed assertion rather than a hung test.
 */
function mine(job: Job): { header: Buffer; coinbase: Buffer; headerHash: Buffer } {
  const algorithm = algorithmFor('ltc')
  const version = uint32LE(job.template.version)
  const prevHash = headerPrevHashFromStratum(job.prevHashStratum)
  const ntime = swap32Hex(job.ntimeHex)
  const nbits = swap32Hex(job.bitsHex)

  for (let extranonce2 = 0; extranonce2 < 4096; extranonce2 += 1) {
    const coinbase = coinbaseFor(job, EXTRANONCE1, uint32LE(extranonce2))
    const merkleRoot = merkleRootFromBranch(coinbaseTxId(coinbase), job.merkleSteps)
    for (let nonce = 0; nonce < 4096; nonce += 1) {
      const header = buildHeader({ version, prevHash, merkleRoot, ntime, nbits, nonce: uint32LE(nonce) })
      if (!meetsTarget(powHash(algorithm, header), job.template.blockTarget)) continue
      // The block's identity is SHA-256d of the header even on a scrypt chain: scrypt is the proof
      // of work, and the hash the node indexes the block under is the other one.
      return { header, coinbase, headerHash: sha256d(header) }
    }
  }
  throw new Error('no nonce cleared the regtest target in 2^24 attempts, which cannot happen')
}

/* ------------------------------------------------------------------ the bug, reproduced */

test('litecoind refuses getblocktemplate without the mweb rule set', { skip }, async () => {
  // micro-org#277, reproduced against the node this test is pointed at. The refusal is what makes
  // the fix a fix rather than an optimisation: `chainservice.ts` treats a node that answers wrongly
  // as fatal, so before this the service exited at boot.
  await assert.rejects(
    rpc().call('getblocktemplate', [{ rules: ['segwit'] }]),
    (err: unknown) => {
      assert.ok(err instanceof NodeRpcError, `expected a JSON-RPC error, got ${String(err)}`)
      assert.equal(err.code, -8)
      assert.match(err.message, /mweb/)
      return true
    },
  )
})

test('the rules this service sends are the ones the node asked for', { skip }, async () => {
  const node = rpc()
  const controller = new AbortController()
  try {
    const template = await currentTemplate(node, controller.signal)
    assert.ok(template.height > 0)
    // The two properties micro-org#277 measured, now against a node rather than a fixture: an
    // integrating transaction that is present with an empty mempool, and an extension block to
    // serialise with it.
    assert.notEqual(template.mwebHex, null, 'an MWEB-active node must supply an extension block')
    assert.equal(
      template.transactions[template.transactions.length - 1]?.isHogEx,
      true,
      'the last template transaction must be the MWEB integrating transaction',
    )
    assert.equal(
      template.transactions.filter((tx) => tx.isHogEx).length,
      1,
      'exactly one integrating transaction',
    )
    // The coinbase's witness commitment is present in the same template and is not MWEB's. This is
    // the check micro-org#277 asked for by name rather than an assumption that it is fine.
    assert.notEqual(template.witnessCommitmentHex, null)
    assert.match(template.witnessCommitmentHex ?? '', /^6a24aa21a9ed[0-9a-f]{64}$/)
  } finally {
    controller.abort()
  }
})

/* ------------------------------------------------------------------ the acceptance test */

test('the pool mines a block a real litecoind accepts', { skip }, async () => {
  assert.notEqual(PAYOUT_ADDRESS, '', 'POOL_REGTEST_PAYOUT_ADDRESS must be set alongside the node URL')
  const node = rpc()
  const controller = new AbortController()
  try {
    const before = await node.call<number>('getblockcount')

    const registry = new JobRegistry({
      chain: 'ltc',
      tag: Buffer.from('/cloudsforge-regtest/', 'utf8'),
      extranonce1Size: EXTRANONCE1.length,
      extranonce2Size: EXTRANONCE2_SIZE,
    })
    // The payout script comes from the node, as it does at boot. See `coinbase.ts` on why this
    // repository never encodes an address.
    registry.setPayoutScript(await payoutScriptFor(node, PAYOUT_ADDRESS))

    const template = await currentTemplate(node, controller.signal)
    // The point of `scripts/regtest-mweb.sh` putting transactions in the mempool first: a block of a
    // coinbase and an integrating transaction alone would carry an extension block without ever
    // exercising the merkle tree the integrating transaction has to sit at the end of. The estate's
    // own litecoind runs `blocksonly` — micro-org#268 — so a regtest node is the only place this can
    // be tested at all.
    assert.ok(
      template.transactions.length >= 2,
      'the mempool must hold at least one ordinary transaction beside the integrating one',
    )

    const job = registry.push(template)
    const { header, coinbase, headerHash } = mine(job)
    const hash = hashToDisplay(headerHash)

    const found = {
      job,
      header,
      coinbase,
      headerHash,
      account: 'regtest',
      worker: 'regtest',
      creditedDifficulty: 1,
    }
    const hex = serialiseFoundBlock(found)

    // ── the negative control ──────────────────────────────────────────────────────────────────
    // The same block with the extension block left off, submitted first. Without this the test
    // proves only that the node accepts SOMETHING the pool built, and the interesting claim — that
    // the extension block is load-bearing rather than decoration this pool got away with appending —
    // would be untested.
    //
    // **`submitblock` has two failure shapes and only one of them is the documented one.** A block
    // that decodes and then fails validation comes back as a REPLY STRING naming the rule; a block
    // that cannot be deserialised at all comes back as a JSON-RPC ERROR, `-22 Block decode failed`,
    // which is the one this produces — a final integrating transaction is what tells Core to expect
    // an extension block, and there is nothing there for it to read. Measured 2026-08-09. Both are
    // accepted here because either one is a refusal, and `blocks.ts` already records both as a
    // rejected block with its detail; a test that only allowed the reply-string shape would fail on
    // the more badly broken block, which is backwards.
    //
    // Safe to send before the real one: a block that fails to decode changes no state, so the
    // acceptance below is still the first thing the node hears about this height.
    const withoutMweb = serialiseFoundBlock({
      ...found,
      job: { ...job, template: { ...job.template, mwebHex: null } },
    })
    let refusal: string | null = null
    try {
      refusal = await node.call<string | null>('submitblock', [withoutMweb], { retryable: false })
    } catch (err) {
      assert.ok(err instanceof NodeRpcError, `expected a refusal, got ${String(err)}`)
      refusal = err.message
    }
    assert.notEqual(refusal, null, 'a block with no extension block must NOT be accepted')

    const reply = await node.call<string | null>('submitblock', [hex], { retryable: false })

    // `submitblock` answers null on acceptance and a SHORT REASON STRING on rejection, and neither
    // is an RPC error. This is the assertion the whole file exists for, so it is written as an
    // equality against null with the reply in the message rather than as a truthiness check — a
    // check that treated any falsy reply as success would also pass on the empty string, and one
    // that only caught exceptions would pass on every rejection there is.
    assert.equal(reply, null, `submitblock rejected the block: ${String(reply)}`)

    const after = await node.call<number>('getblockcount')
    assert.equal(after, before + 1, 'the chain must be one block longer than it was')
    assert.equal(
      await node.call<string>('getblockhash', [after]),
      hash,
      'the new tip must be the block this pool built, not one the node found by itself',
    )

    // And the block the node stored is the one that was sent, extension block and all. `getblock`
    // with verbosity 0 returns the serialisation the node round-tripped, so a byte we appended that
    // it silently ignored — or one it filled in for us — shows up here and nowhere else.
    assert.equal(await node.call<string>('getblock', [hash, 0]), hex)

    // Printed because a run of this test is evidence, and evidence that names the block can be
    // checked afterwards by somebody who did not run it.
    console.log(`regtest: mined and accepted block ${hash} at height ${after}`)
  } finally {
    controller.abort()
  }
})
