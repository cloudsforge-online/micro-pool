/**
 * The node's verdict on a miner's payout address, cached and bounded. micro-org#286.
 *
 * There is no address in this file that is asserted to be valid or invalid on its own merits, and
 * that is deliberate rather than lazy: the whole point of `payoutaddress.ts` is that this repository
 * does NOT know what a valid Litecoin address looks like and does not want to. What is asserted is
 * that the question reaches the node, that the answer is read the way `template.ts` reads the same
 * field for the pool's own address, that it is asked once rather than once per connection, and that
 * the three outcomes stay three.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { AddressChecker, type AddressVerdict } from './payoutaddress.ts'
import { NodeRpcError, NodeUnavailableError } from './rpc.ts'

/** A node that answers `validateaddress`, counting the calls and remembering what it was asked. */
function fakeRpc(answer: (address: string) => unknown): {
  readonly asked: string[]
  readonly rpc: { call: <T>(method: string, params?: readonly unknown[]) => Promise<T> }
} {
  const asked: string[] = []
  return {
    asked,
    rpc: {
      call: async <T,>(method: string, params: readonly unknown[] = []): Promise<T> => {
        assert.equal(method, 'validateaddress', 'the checker must ask the node, not parse the address')
        const address = String(params[0])
        asked.push(address)
        const reply = answer(address)
        if (reply instanceof Error) throw reply
        return reply as T
      },
    },
  }
}

test('THE QUESTION GOES TO THE NODE AND THE ANSWER IS ITS `isvalid`, NOTHING ELSE', async () => {
  const node = fakeRpc((address) => ({ isvalid: address === 'ltc1qgood', address, scriptPubKey: '76a914' }))
  const checker = new AddressChecker({ rpc: node.rpc })

  assert.equal(await checker.check('ltc1qgood'), 'valid')
  assert.equal(await checker.check('ltc1qtypo'), 'invalid')
  assert.deepEqual(node.asked, ['ltc1qgood', 'ltc1qtypo'])
})

test('an answer that is not exactly `isvalid: true` is not valid', async () => {
  // Read the same way `payoutScriptFor` in `template.ts` reads it for the pool's own address. A node
  // answering a shape this does not understand must not be read as agreement — the two calls are the
  // same question about two different strings and they must not disagree about what an answer means.
  for (const reply of [{}, { isvalid: 'true' }, { isvalid: 1 }, { valid: true }, null, 'yes', []]) {
    const checker = new AddressChecker({ rpc: fakeRpc(() => reply).rpc })
    assert.equal(await checker.check('whatever'), 'invalid', JSON.stringify(reply))
  }
})

test('A NODE THAT DID NOT ANSWER IS `unavailable` AND IS NEVER A REFUSAL', async () => {
  // The distinction the whole design turns on. `session.ts` fails OPEN here, and it can only do that
  // if this module hands it a third answer rather than folding "we do not know" into "no".
  const checker = new AddressChecker({
    rpc: fakeRpc(() => new NodeUnavailableError({ method: 'validateaddress', chain: 'ltc', cause: 'ECONNREFUSED' }))
      .rpc,
  })
  assert.equal(await checker.check('ltc1qgood'), 'unavailable')
})

test('a node that answered with an RPC error is also unavailable, not a refusal', async () => {
  // Core returns `{"isvalid": false}` for gibberish; it does not raise an RPC error about it. So an
  // error here is a node that is not in a state to answer questions — loading the block index, a
  // wrong credential — and it is no more evidence about the miner's address than a dead socket is.
  const checker = new AddressChecker({
    rpc: fakeRpc(() => new NodeRpcError({ code: -28, message: 'Loading block index...', method: 'validateaddress', chain: 'ltc' })).rpc,
  })
  assert.equal(await checker.check('ltc1qgood'), 'unavailable')
})

test('AN UNAVAILABLE VERDICT IS NEVER CACHED, SO THE WINDOW IS ONE CONNECTION WIDE', async () => {
  // This is the load-bearing half of failing open. A cached "we could not check" would mean an
  // address that was never checked and never will be, for the life of the process — which is the
  // version of this behaviour that would be indefensible.
  let up = false
  const node = fakeRpc(() =>
    up ? { isvalid: true } : new NodeUnavailableError({ method: 'validateaddress', chain: 'ltc', cause: 'down' }),
  )
  const checker = new AddressChecker({ rpc: node.rpc })

  assert.equal(await checker.check('ltc1qgood'), 'unavailable')
  assert.equal(checker.cached, 0)
  assert.equal(await checker.check('ltc1qgood'), 'unavailable')
  assert.equal(node.asked.length, 2, 'the second connection must ask again')

  up = true
  assert.equal(await checker.check('ltc1qgood'), 'valid')
  assert.equal(checker.cached, 1)
})

test('a settled verdict is asked once, however many connections use it', async () => {
  // A farm of rigs on one payout address reconnecting after a pool restart is the case this exists
  // for: without the cache it is one RPC per rig against a node that is also building templates, at
  // exactly the moment it can least spare them.
  const node = fakeRpc(() => ({ isvalid: true }))
  const checker = new AddressChecker({ rpc: node.rpc })
  for (let i = 0; i < 50; i += 1) assert.equal(await checker.check('ltc1qgood'), 'valid')
  assert.equal(node.asked.length, 1)

  const bad = fakeRpc(() => ({ isvalid: false }))
  const refuser = new AddressChecker({ rpc: bad.rpc })
  for (let i = 0; i < 50; i += 1) assert.equal(await refuser.check('ltc1qtypo'), 'invalid')
  assert.equal(bad.asked.length, 1, 'an invalid verdict is cached too — a typo does not become valid')
})

test('CONCURRENT LOOKUPS OF ONE ADDRESS ARE ONE CALL, NOT ONE PER CALLER', async () => {
  // The cache alone does not cover this: five hundred rigs arriving inside a single RPC round trip
  // all miss it and all call the node. They have to share the promise, not merely the result.
  // A definite-assignment `let` rather than a nullable one: the executor runs synchronously, so
  // the value is always there by the time anything reads it, and typing it as nullable would only
  // buy an optional call that can never be skipped.
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const asked: string[] = []
  const checker = new AddressChecker({
    rpc: {
      call: async <T,>(_method: string, params: readonly unknown[] = []): Promise<T> => {
        asked.push(String(params[0]))
        await gate
        return { isvalid: true } as T
      },
    },
  })

  const waiting = Array.from({ length: 500 }, () => checker.check('ltc1qgood'))
  assert.equal(asked.length, 1, 'the node was asked more than once for one address')
  release()
  for (const verdict of await Promise.all(waiting)) assert.equal(verdict, 'valid')
})

test('the cache is bounded, because its key is a string a stranger chooses', async () => {
  // An unbounded map here is a memory leak whose growth rate is set by whoever is connecting: every
  // distinct username anybody tries is a permanent entry. The ceiling is 4096; this walks past it.
  const node = fakeRpc(() => ({ isvalid: false }))
  const checker = new AddressChecker({ rpc: node.rpc })
  for (let i = 0; i < 5_000; i += 1) await checker.check(`junk-${i}`)
  assert.ok(checker.cached <= 4_096, `cache grew to ${checker.cached}`)
  // And the eviction is oldest-first, so the entries that survive are the recent ones.
  const before = node.asked.length
  await checker.check('junk-4999')
  assert.equal(node.asked.length, before, 'the most recent verdict was evicted first')
})

test('every verdict is reported once, so an operator can count the unchecked ones', async () => {
  // `unavailable` is the label that matters: it is the count of miners authorised WITHOUT their
  // address being checked, and a fail-open nobody can see is a fail-open nobody will ever fix.
  const seen: { verdict: AddressVerdict; address: string }[] = []
  let up = false
  const checker = new AddressChecker({
    rpc: fakeRpc((address) =>
      up ? { isvalid: address === 'ltc1qgood' } : new NodeUnavailableError({ method: 'validateaddress', chain: 'ltc', cause: 'down' }),
    ).rpc,
    onVerdict: (verdict, address) => seen.push({ verdict, address }),
  })

  await checker.check('ltc1qgood')
  up = true
  await checker.check('ltc1qgood')
  await checker.check('ltc1qtypo')
  // The cached hit reports nothing, because nothing happened — the counter is of node answers.
  await checker.check('ltc1qgood')

  assert.deepEqual(seen, [
    { verdict: 'unavailable', address: 'ltc1qgood' },
    { verdict: 'valid', address: 'ltc1qgood' },
    { verdict: 'invalid', address: 'ltc1qtypo' },
  ])
})
