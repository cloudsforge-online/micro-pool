/**
 * The aux block boundary: what dogecoind says, and what this pool is willing to commit to.
 *
 * Two things are being defended here and they are not the same thing.
 *
 * The first is the parse, for the reason `template.test.ts` gives: a bad field becomes a wrong number
 * three modules later with nothing in the logs pointing back. The aux hash is a sharper case than any
 * field in `getblocktemplate`, because it goes into consensus bytes *unreversed* — a hash that is not
 * 32 bytes has to be refused at the RPC boundary or it becomes a 44-byte commitment that is silently
 * the wrong length and a Litecoin block that mines nothing.
 *
 * The second is the classification of failure. dogecoind refuses to build an aux block while it is in
 * initial block download, and on this estate that is its ordinary state — as of 2026-08-09 it is
 * 0.36 of the way through. If that refusal were treated the way a wrong password is treated, adding
 * merged mining would take the Litecoin pool down. So there is a test per reason, and each asserts
 * the same thing: the source publishes no block, names why, and does not throw.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { HttpError, type HttpClient, type RequestOptions } from '@cloudsforge/http'
import { NodeRpc, NodeRpcError, NodeUnavailableError } from './rpc.ts'
import {
  AuxTemplateSource,
  parseAuxBlock,
  unavailabilityOf,
  RPC_CLIENT_IN_INITIAL_DOWNLOAD,
  RPC_CLIENT_NOT_CONNECTED,
  type AuxBlock,
  type AuxUnavailability,
} from './auxtemplate.ts'
import { auxCommitment } from './auxpow.ts'
import { targetFromCompactBits } from './pow.ts'

const DOGE_PAYOUT = 'DFundmzHzgFXvJmzGDCLpTP2Kf4TXGCFAv'
const DOGE_BITS = '1a01cd8f'

function auxReply(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hash: '3a1b2c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809',
    chainid: 98,
    previousblockhash: '00000000000000000f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778',
    coinbasevalue: 1_000_000_000_000,
    bits: DOGE_BITS,
    height: 5_412_009,
    target: 'ffffffffffffffffffffffffffffffffffffffffffff8fcd010000000000',
    ...overrides,
  }
}

/**
 * A dogecoind that answers `createauxblock` from a queue.
 *
 * Built through the real `NodeRpc` for the reason `faketemplate.ts` gives — the envelope, the error
 * unwrapping and the id counter stay on the path — but kept local to this file rather than folded
 * into `faketemplate.ts`, because everything in there is shaped like a chain this pool mines ON and
 * an aux chain deliberately is not.
 */
function fakeDogecoind(replies: readonly (Record<string, unknown> | { code: number; message: string })[]) {
  const calls: { method: string; params: readonly unknown[] }[] = []
  let at = 0
  const client: Pick<HttpClient, 'request'> = {
    async request<T>(_path: string, options?: RequestOptions): Promise<T> {
      const body = (options?.body ?? {}) as { method?: string; params?: unknown[] }
      calls.push({ method: body.method ?? '', params: body.params ?? [] })
      const reply = replies[Math.min(at, replies.length - 1)] ?? {}
      at += 1
      if ('code' in reply && 'message' in reply) {
        throw new HttpError({
          status: 500,
          method: 'POST',
          url: 'http://node.invalid:22555/',
          body: JSON.stringify({ result: null, error: reply, id: 1 }),
        })
      }
      return { result: reply, error: null } as T
    },
  }
  return {
    calls,
    rpc: new NodeRpc({ chain: 'doge', url: 'http://user:pass@node.invalid:22555/', client }),
  }
}

function sourceOver(replies: readonly (Record<string, unknown> | { code: number; message: string })[]) {
  const changes: { block: AuxBlock | null; why: AuxUnavailability | null }[] = []
  const node = fakeDogecoind(replies)
  const source = new AuxTemplateSource({
    chain: 'doge',
    rpc: node.rpc,
    payoutAddress: DOGE_PAYOUT,
    onChange: (block, why) => changes.push({ block, why }),
    now: () => 1_780_000_000_000,
  })
  return { source, changes, calls: node.calls }
}

/* ------------------------------------------------------------------ parsing */

test('a well-formed createauxblock reply parses into the fields a commitment needs', () => {
  const block = parseAuxBlock('doge', auxReply(), new Date(0))
  assert.equal(block.chain, 'doge')
  assert.equal(block.hashHex, auxReply()['hash'])
  assert.equal(block.height, 5_412_009)
  assert.equal(block.bitsHex, DOGE_BITS)
  assert.equal(block.coinbaseValue, 1_000_000_000_000n)
  assert.equal(typeof block.coinbaseValue, 'bigint')
})

test('the target is decoded from bits and is not the reply own target field', () => {
  // The RPC's `target` is `HexStr(BEGIN(target), END(target))` over an arith_uint256 — internal
  // order, the reverse of every other hash-shaped string in the same reply. Reading it would give a
  // number with no relation to the real target, and the failure mode is not an exception: it is a
  // pool that thinks every share wins a Dogecoin block, or that none of them ever do.
  const block = parseAuxBlock('doge', auxReply(), new Date(0))
  assert.equal(block.target, targetFromCompactBits(Number.parseInt(DOGE_BITS, 16)))
  assert.notEqual(block.target, BigInt(`0x${String(auxReply()['target'])}`))
})

test('the hash is kept in the RPC own display order, ready to be committed unreversed', () => {
  // The one rule in this repository that runs the other way. `CAuxPow::check` reverses a uint256's
  // internal bytes before searching the coinbase for them, so display order is what goes in — and
  // this asserts the value survives the parse untouched rather than that the parse is careful.
  const block = parseAuxBlock('doge', auxReply(), new Date(0))
  const committed = auxCommitment(block.hashHex)
  assert.equal(committed.subarray(5, 37).toString('hex'), auxReply()['hash'])
})

test('a hash that is not 32 bytes is refused at the boundary, not 44 bytes later', () => {
  assert.throws(() => parseAuxBlock('doge', auxReply({ hash: 'abcd' }), new Date(0)), /hash is not 32 bytes/)
  assert.throws(() => parseAuxBlock('doge', auxReply({ hash: undefined }), new Date(0)), /hash is not 32 bytes/)
  // Not hex at all, and the right length in characters. `Buffer.from` would have taken this and
  // returned fewer bytes without complaining, which is exactly the silent path being closed.
  const notHex = 'z'.repeat(64)
  assert.throws(() => parseAuxBlock('doge', auxReply({ hash: notHex }), new Date(0)), /hash is not 32 bytes/)
})

test('every other field is checked too, because a wrong one costs a block and a check costs nothing', () => {
  assert.throws(() => parseAuxBlock('doge', auxReply({ bits: '1a01' }), new Date(0)), /bits is not 4 bytes/)
  assert.throws(() => parseAuxBlock('doge', auxReply({ height: -1 }), new Date(0)), /height is not a height/)
  assert.throws(() => parseAuxBlock('doge', auxReply({ height: 1.5 }), new Date(0)), /height is not a height/)
  assert.throws(() => parseAuxBlock('doge', auxReply({ previousblockhash: '00' }), new Date(0)), /previousblockhash/)
  assert.throws(() => parseAuxBlock('doge', auxReply({ coinbasevalue: '10' }), new Date(0)), /coinbasevalue/)
  assert.throws(() => parseAuxBlock('doge', null, new Date(0)), /did not return an object/)
})

/* ------------------------------------------------------- refusal, classified */

test('the four reasons are told apart by the JSON-RPC code, and an unknown one is refused', () => {
  // `AuxMiningCheck` throws RPC_CLIENT_IN_INITIAL_DOWNLOAD before it will build anything, which is
  // the estate's current state and must not read as a fault. An error carrying the same `code`
  // property without being a `NodeRpcError` is NOT a refusal from the node — it is something in
  // this process — so it classifies as `refused` and gets looked at rather than waited out.
  const rpcError = (code: number) =>
    new NodeRpcError({ code, message: 'Dogecoin is downloading blocks...', method: 'createauxblock', chain: 'doge' })
  assert.equal(unavailabilityOf(rpcError(RPC_CLIENT_IN_INITIAL_DOWNLOAD)), 'syncing')
  assert.equal(unavailabilityOf(rpcError(RPC_CLIENT_NOT_CONNECTED)), 'no-peers')
  assert.equal(unavailabilityOf(rpcError(-5)), 'refused')
  assert.equal(unavailabilityOf(new NodeUnavailableError({ method: 'createauxblock', chain: 'doge', cause: 'timeout' })), 'unreachable')
  assert.equal(unavailabilityOf(Object.assign(new Error(''), { code: RPC_CLIENT_IN_INITIAL_DOWNLOAD })), 'refused')
  assert.equal(unavailabilityOf(new TypeError('nonsense')), 'refused')
})

test('a syncing node publishes no block, names the reason, and does not throw', async () => {
  const { source, changes } = sourceOver([
    { code: RPC_CLIENT_IN_INITIAL_DOWNLOAD, message: 'Dogecoin is downloading blocks...' },
  ])
  assert.equal(await source.refresh(), null)
  assert.equal(source.current, null)
  assert.equal(source.unavailability, 'syncing')
  assert.deepEqual(changes, [{ block: null, why: 'syncing' }])
})

test('a node with no peers is distinguished from one that is syncing', async () => {
  const { source } = sourceOver([{ code: RPC_CLIENT_NOT_CONNECTED, message: 'Dogecoin is not connected!' }])
  await source.refresh()
  assert.equal(source.unavailability, 'no-peers')
})

test('an unrecognised refusal is refused rather than swallowed', async () => {
  const { source } = sourceOver([{ code: -5, message: 'Invalid coinbase payout address' }])
  await source.refresh()
  assert.equal(source.unavailability, 'refused')
})

test('a refusal after a good block clears the block, because a stale commitment mines nothing', async () => {
  const { source, changes } = sourceOver([auxReply(), { code: -10, message: 'downloading' }])
  await source.refresh()
  assert.equal(source.current?.height, 5_412_009)
  await source.refresh()
  assert.equal(source.current, null)
  assert.equal(changes.length, 2)
})

/* --------------------------------------------------------- change detection */

test('the callback fires once per hash, not once per poll', async () => {
  // A poll every few seconds against a chain with 60-second blocks means the same hash comes back
  // dozens of times. Rebuilding the job each time would republish work miners already have, and
  // logging each time would bury everything else.
  const { source, changes } = sourceOver([auxReply()])
  await source.refresh()
  await source.refresh()
  await source.refresh()
  assert.equal(changes.length, 1)
  assert.equal(changes[0]?.block?.hashHex, auxReply()['hash'])
})

test('a new hash is a change even at the same height, because the tip did not have to move', async () => {
  // dogecoind rebuilds its aux block as its mempool turns over, so a second hash at the same height
  // is ordinary. Both remain submittable — `mapNewBlock` is cleared on a tip change and nothing
  // else — but the pool commits to the one it was told about last.
  const second = auxReply({ hash: 'ff'.repeat(32) })
  const { source, changes } = sourceOver([auxReply(), second])
  await source.refresh()
  await source.refresh()
  assert.equal(changes.length, 2)
  assert.equal(changes[1]?.block?.hashHex, 'ff'.repeat(32))
})

test('the payout address goes to dogecoin, and is the only parameter', async () => {
  const { source, calls } = sourceOver([auxReply()])
  await source.refresh()
  assert.deepEqual(calls, [{ method: 'createauxblock', params: [DOGE_PAYOUT] }])
})

test('invalidate drops the block without asking the node, for when a submission proves it gone', async () => {
  // `submitauxblock` answering `block hash unknown` is proof that Dogecoin's tip moved. Asking the
  // node again would be the right next step, but continuing to commit to the dead hash in the
  // meantime would not, so the drop is immediate and the refresh happens on its own schedule.
  const { source, changes, calls } = sourceOver([auxReply()])
  await source.refresh()
  source.invalidate('refused')
  assert.equal(source.current, null)
  assert.equal(source.unavailability, 'refused')
  assert.equal(calls.length, 1)
  assert.deepEqual(changes[1], { block: null, why: 'refused' })
})
