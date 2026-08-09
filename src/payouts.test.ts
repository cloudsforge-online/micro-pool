/**
 * The payout seam — which implements nothing, and is tested for exactly that.
 *
 * Payout crediting is out of scope for this pass. What is in scope is that the shape it will occupy
 * cannot be filled in wrongly later, and the part of that shape which actually constrains a future
 * implementation is the idempotency key. `wallet/src/deposits.ts` established `credit_key` in this
 * estate as one string used BOTH as a local unique constraint and as the ledger's `idempotencyKey`;
 * the value of that convention is entirely in there being one of it. A second scheme invented here
 * would mean a block credited twice under two different keys, and nothing downstream could tell.
 *
 * So these tests are about the key's algebra: what it distinguishes, what it does not, and that it
 * contains nothing that varies between two computations of the same claim. A key with a timestamp in
 * it is not an idempotency key, it is a nonce with an idempotency key's name.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { poolPayoutCreditKey, PayoutsNotImplementedError } from './payouts.ts'

const BLOCK = '00000000000000000002a7c4c1e48d76c5a37902165a270156b7a8d72728a054'

test('the credit key follows the estate shape', () => {
  assert.equal(
    poolPayoutCreditKey('btc', 'mainnet', BLOCK, 42),
    `pool:payout:btc:mainnet:${BLOCK}:42`,
  )
})

test('the key is namespaced so it cannot collide with another service', () => {
  // `wallet` issues deposit credit keys against the same ledger. Two services minting keys into one
  // namespace is the collision that makes idempotency meaningless.
  assert.ok(poolPayoutCreditKey('ltc', 'testnet', BLOCK, 1).startsWith('pool:payout:'))
})

test('every field that identifies a claim changes the key', () => {
  const base = poolPayoutCreditKey('btc', 'mainnet', BLOCK, 42)
  const other = '00000000000000000001111111111111111111111111111111111111111111ff'
  assert.notEqual(base, poolPayoutCreditKey('ltc', 'mainnet', BLOCK, 42), 'chain')
  assert.notEqual(base, poolPayoutCreditKey('btc', 'testnet', BLOCK, 42), 'network')
  assert.notEqual(base, poolPayoutCreditKey('btc', 'mainnet', other, 42), 'block')
  assert.notEqual(base, poolPayoutCreditKey('btc', 'mainnet', BLOCK, 43), 'worker')
})

test('a chain and its testnet never share a key', () => {
  // The failure this prevents is not theoretical: the same block hash cannot occur on both networks,
  // but a bug that pointed a mainnet pool at a testnet node could produce a claim that looked
  // already-credited and was silently skipped.
  assert.notEqual(
    poolPayoutCreditKey('btc', 'mainnet', BLOCK, 7),
    poolPayoutCreditKey('btc', 'testnet', BLOCK, 7),
  )
})

test('the key is stable across case, because a block hash is not case-sensitive', () => {
  // Core answers lower-case; an operator pasting from an explorer may not. Two spellings of one
  // block must not be two claims.
  assert.equal(
    poolPayoutCreditKey('btc', 'mainnet', BLOCK.toUpperCase(), 42),
    poolPayoutCreditKey('btc', 'mainnet', BLOCK, 42),
  )
})

test('the key is a pure function of the claim', () => {
  // No time, no counter, no randomness. Computed twice, seconds apart, it must be identical — that
  // is the entire property an idempotency key has.
  const first = poolPayoutCreditKey('btc', 'mainnet', BLOCK, 42)
  const second = poolPayoutCreditKey('btc', 'mainnet', BLOCK, 42)
  assert.equal(first, second)
  // And it contains nothing that looks like a timestamp: no 10- or 13-digit run outside the hash.
  const withoutHash = first.replace(BLOCK, '')
  assert.ok(!/\d{10,}/.test(withoutHash), `the key carries something clock-shaped: ${withoutHash}`)
})

test('the not-implemented error says plainly what does and does not happen', () => {
  // It exists so a future partial implementation has something honest to throw, rather than
  // returning silently or logging and continuing — both of which produce a pool that says it paid.
  const err = new PayoutsNotImplementedError('crediting a block reward')
  assert.ok(err instanceof Error)
  assert.equal(err.name, 'PayoutsNotImplementedError')
  assert.match(err.message, /payouts are not implemented/)
  assert.match(err.message, /crediting a block reward/)
  // It must name what DOES work, or an operator reading it cannot tell whether shares were lost too.
  assert.match(err.message, /[Ss]hares are recorded/)
  assert.match(err.message, /src\/payouts\.ts/)
})

test('this repository contains no payout implementation to be mistaken for one', async () => {
  // The brief's instruction was "do not stub anything that would look like it works". A `credit`
  // that resolved would be exactly that, so the module exports an interface and no implementation
  // of it. Asserted by inspection of the module's own exports.
  const module: Record<string, unknown> = await import('./payouts.ts')
  const runtimeExports = Object.keys(module).filter((name) => typeof module[name] === 'function')
  assert.deepEqual(
    runtimeExports.sort(),
    ['PayoutsNotImplementedError', 'poolPayoutCreditKey'],
    'payouts.ts gained a runtime export: if it credits anything, the README and PR must stop saying it does not',
  )
})
