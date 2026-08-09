/**
 * Which chains this pool mines, and — the part that matters more — which it refuses by name.
 *
 * A refusal that exists only as an absence is not a refusal. If `doge` were simply missing from the
 * chain table, the failure mode of someone setting `POOL_CHAINS=btc,ltc,doge` would be an unhelpful
 * "unknown chain", and the natural next move would be to add the row — because from the outside
 * Dogecoin looks exactly like Litecoin with different constants. It is not: Dogecoin is merge-mined
 * under AuxPoW, its blocks are won by a Litecoin header carrying a commitment to them, and mining it
 * through the `getblocktemplate` path would take real work from miners and submit blocks consensus
 * rejects. The refusal has to carry that reason with it, at the point of refusal, which is what these
 * tests check.
 *
 * Since merged mining landed, that refusal has a second job and it is the more important one. The
 * pool now DOES mine Dogecoin — as an auxiliary chain of Litecoin, through `POOL_LTC_AUX_CHAINS`.
 * A reader who finds `auxpow.ts` and then finds `doge` refused could very reasonably conclude that
 * adding the row is how you turn the new machinery on. It is not; the row would take the primary
 * path, which is the one that produces rejected blocks. So the refusal has to name the setting that
 * works, and a test here holds it to that.
 *
 * The other half of this file is that `@cloudsforge/contracts-chain` is the source of decimals and
 * names, never this repository. Restating a chain parameter is how two services come to disagree
 * about what an amount means.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { CHAINS } from '@cloudsforge/contracts-chain'
import {
  algorithmFor,
  assetFor,
  decimalsFor,
  EXPECTED_NODE_CHAIN,
  isPoolChainId,
  nameFor,
  poolChain,
  POOL_CHAIN_IDS,
  REFUSED_CHAINS,
  AUX_CHAIN_IDS,
  AUX_PARENT,
  auxAssetFor,
  auxNameFor,
  isAuxChainId,
} from './chains.ts'

/* ------------------------------------------------------------------ what is mined */

test('the pool mines exactly bitcoin and litecoin in this pass', () => {
  assert.deepEqual([...POOL_CHAIN_IDS], ['btc', 'ltc'])
  assert.ok(isPoolChainId('btc'))
  assert.ok(isPoolChainId('ltc'))
})

test('the proof-of-work function is dispatched per chain', () => {
  // The brief's sharpest technical requirement: a pool using the wrong function silently rejects
  // every share, because a wrong hash is not an error, it is a number that never clears a target.
  assert.equal(algorithmFor('btc'), 'sha256d')
  assert.equal(algorithmFor('ltc'), 'scrypt')
})

/* ------------------------------------------------------------------ the template rules */

test('litecoin asks for mweb as well as segwit, because the node refuses the call otherwise', () => {
  // Measured against Litecoin Core 0.21.5.6 on 2026-08-09, mainnet and regtest alike:
  //   error code: -8
  //   getblocktemplate must be called with the segwit & mweb rule sets
  //   (call with {"rules": ["mweb", "segwit"]})
  // That is a refusal of the call, not a degraded template, and `chainservice.ts` treats a node that
  // answers wrongly as fatal — so this single line is the difference between a service that boots
  // and one that exits. Asserted as a set membership rather than as an array so a future rule can be
  // added without this test dictating the order Core does not care about.
  const rules = poolChain('ltc').templateRules
  assert.ok(rules.includes('mweb'), 'litecoin must claim the mweb rule set')
  assert.ok(rules.includes('segwit'), 'litecoin must claim the segwit rule set')
})

test('bitcoin does not ask for mweb, and that is not an omission to be tidied up', () => {
  // Bitcoin has no MWEB. A rule name bitcoind does not know is a rule it refuses the call for, in
  // the same way and with the same consequence, so copying Litecoin's list here would break the
  // chain this list was correct for.
  assert.deepEqual([...poolChain('btc').templateRules], ['segwit'])
})

/* ------------------------------------------------------------------ what is refused */

test('dogecoin is a named refusal, not an omission', () => {
  assert.ok(!isPoolChainId('doge'), 'doge must not be minable as a primary chain')
  const reason = REFUSED_CHAINS['doge']
  assert.ok(typeof reason === 'string' && reason.length > 0, 'doge must be refused with a reason')
  // The reason must name the actual mechanism, or the next reader will "fix" it by adding a row.
  assert.match(reason, /AuxPoW/)
  assert.match(reason, /merge-mined/)
  assert.match(reason, /Litecoin/)
})

test('the refusal redirects rather than saying the work is unimplemented', () => {
  // This assertion changed when merged mining landed, and the change is the point. The refusal used
  // to mean "nobody has built this"; it now means "this is built, and it is not configured here".
  // A doge row in POOL_CHAINS is MORE dangerous than it was, because a reader who saw the aux
  // machinery could reasonably believe the row would use it — it would not. So the reason has to
  // carry the setting that does work, spelled exactly as an operator would type it.
  const reason = REFUSED_CHAINS['doge'] as string
  assert.match(reason, /POOL_LTC_AUX_CHAINS=doge/)
  assert.match(reason, /DOES mine Dogecoin/)
  // And it must still say why the primary path cannot exist, so the redirect is not mistaken for a
  // temporary limitation someone could lift by finding the right RPC.
  assert.match(reason, /getblocktemplate/)
})

test('doge is an aux chain, and the parent it may be merged into is litecoin', () => {
  assert.ok(isAuxChainId('doge'))
  assert.ok(!isAuxChainId('ltc'), 'a chain this pool mines directly is not an aux chain')
  assert.deepEqual([...AUX_CHAIN_IDS], ['doge'])
  assert.equal(AUX_PARENT['doge'], 'ltc')
  // Tighter than consensus on purpose: Dogecoin's own `fStrictChainId` is false for the parent, so
  // it would accept a Bitcoin parent too. This pool commits to one pairing so that a share arriving
  // on the BTC port can never be checked against a Dogecoin target it was never built for.
  assert.equal(Object.keys(AUX_PARENT).length, 1)
})

test('an aux chain carries the same asset vocabulary as a mined one', () => {
  // `auxAssetFor` goes through `chainSpec`, so a DOGE reward is denominated by the same decimals
  // table as every other balance in the estate rather than by a constant in this service.
  assert.equal(auxAssetFor('doge'), 'DOGE')
  assert.ok(auxNameFor('doge').length > 0)
})

test('ethereum classic is refused as a different shape of chain entirely', () => {
  const reason = REFUSED_CHAINS['etc']
  assert.ok(typeof reason === 'string')
  assert.match(reason as string, /getblocktemplate/)
})

test('EMBER is recorded as an open decision rather than a technical refusal', () => {
  // §7.4 of the multi-chain document leaves this to a person. The distinction matters: the other two
  // entries say "this cannot work", and this one says "this has not been decided".
  const reason = REFUSED_CHAINS['ember']
  assert.ok(typeof reason === 'string')
  assert.match(reason as string, /open decision/)
  assert.match(reason as string, /browser miner/)
})

test('every refusal carries a reason long enough to be one', () => {
  // A one-word reason is an absence with extra steps.
  for (const [chain, reason] of Object.entries(REFUSED_CHAINS)) {
    assert.ok(reason.length > 120, `the refusal for ${chain} is too short to explain anything`)
  }
})

test('nothing is both mined and refused', () => {
  for (const chain of POOL_CHAIN_IDS) {
    assert.ok(!(chain in REFUSED_CHAINS), `${chain} is both mined and refused`)
  }
})

test('the refusal table cannot be edited at runtime', () => {
  assert.ok(Object.isFrozen(REFUSED_CHAINS))
  assert.ok(Object.isFrozen(POOL_CHAIN_IDS))
})

/* ------------------------------------------------------------------ contracts-chain is the source */

test('decimals and names come from contracts-chain, not from this repository', () => {
  // Asserted against the imported table directly, so that a value restated here would show up as a
  // disagreement rather than as two copies that happen to match today.
  for (const chain of POOL_CHAIN_IDS) {
    const asset = assetFor(chain)
    const spec = CHAINS[asset]
    assert.ok(spec, `contracts-chain has no entry for ${asset}`)
    assert.equal(decimalsFor(chain), spec.decimals)
    assert.equal(nameFor(chain), spec.name)
  }
})

test('the assets are the ones contracts-chain knows', () => {
  assert.equal(assetFor('btc'), 'BTC')
  assert.equal(assetFor('ltc'), 'LTC')
  // Both are eight-decimal chains, which is a fact about them and not an assumption of this pool —
  // it is read above, and asserted here only so a change in contracts-chain is noticed here too.
  assert.equal(decimalsFor('btc'), 8)
  assert.equal(decimalsFor('ltc'), 8)
})

/* ------------------------------------------------------------------ the network guard */

test('the expected node network covers every name core reports', () => {
  // Bitcoin has four distinct test networks and Core reports each by its own name, while the
  // estate's Network type has one value for all of them.
  assert.ok(EXPECTED_NODE_CHAIN.mainnet.has('main'))
  assert.equal(EXPECTED_NODE_CHAIN.mainnet.size, 1, 'exactly one name means mainnet')
  for (const name of ['test', 'testnet4', 'signet', 'regtest']) {
    assert.ok(EXPECTED_NODE_CHAIN.testnet.has(name), `${name} is not recognised as a test network`)
  }
})

test('a mainnet pool does not accept a test node, or the reverse', () => {
  // The check that stops a pool handing miners mainnet templates against a testnet payout address.
  // The first time that combination finds a block, the reward pays to an address on a chain where
  // nobody holds the key.
  assert.ok(!EXPECTED_NODE_CHAIN.mainnet.has('test'))
  assert.ok(!EXPECTED_NODE_CHAIN.mainnet.has('regtest'))
  assert.ok(!EXPECTED_NODE_CHAIN.testnet.has('main'))
})
