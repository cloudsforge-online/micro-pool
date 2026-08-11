/**
 * The template boundary: what the node says, and what this service is willing to believe.
 *
 * `template.ts` argues that the parse is defensive not out of distrust of a node we run ourselves but
 * because a bad field here becomes a `NaN` target three modules downstream, and a pool with a `NaN`
 * target accepts every share or none with nothing in the logs pointing back. These tests are the
 * other half of that argument: each one names a field, breaks it, and asserts the failure happens at
 * the boundary rather than somewhere it cannot be diagnosed.
 *
 * The refusals in the second half are of a different kind. A payout address the node will not confirm
 * and a node on the wrong network are both configuration mistakes whose consequence is a block reward
 * that pays to nobody, and both are refused at boot rather than at the first block — because there is
 * exactly one first block and it is worth more than every share before it put together.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertNodeNetwork,
  DEFAULT_LONG_POLL_TIMEOUT_MS,
  parseTemplate,
  payoutScriptFor,
  TEMPLATE_STALE_AFTER_MS,
  TemplateSource,
  type BlockTemplate,
} from './template.ts'
import { NodeRpcError, NodeUnavailableError, NODE_TIMEOUT_REASON } from './rpc.ts'
import {
  fakeHashHex,
  fakeNode,
  fakeTemplateReply,
  FAKE_PAYOUT_SCRIPT,
  MAINNET_BITS,
  REGTEST_HOGEX_DATA,
  REGTEST_MWEB_BLOCK,
} from './faketemplate.ts'
import { targetFromCompactBits } from './pow.ts'

/* ------------------------------------------------------------------ parsing */

test('a well-formed template parses into the fields a job needs', () => {
  const template = parseTemplate(fakeTemplateReply({ height: 812_345, bitsHex: MAINNET_BITS }))
  assert.equal(template.height, 812_345)
  assert.equal(template.version, 0x20000000)
  assert.equal(template.bitsHex, MAINNET_BITS)
  assert.equal(template.blockTarget, targetFromCompactBits(Number.parseInt(MAINNET_BITS, 16)))
  assert.equal(template.coinbaseValue, 312_500_000n)
  assert.equal(template.transactions.length, 3)
  assert.equal(template.transactions[0]?.txid.length, 32)
})

test('the coinbase value becomes a bigint at the boundary and nowhere later', () => {
  // The estate's convention is that money is a bigint from end to end. This is the one place a JSON
  // number is allowed to be money, and it stops being a number here.
  const template = parseTemplate(fakeTemplateReply({ coinbaseValue: 625_000_000 }))
  assert.equal(typeof template.coinbaseValue, 'bigint')
  assert.equal(template.coinbaseValue, 625_000_000n)
})

test('transaction ids are converted to internal order for the merkle tree', () => {
  // The node reports display order; the tree folds in internal order. A pool that skipped the
  // reversal would compute a merkle root no miner agrees with, which presents as every share being
  // rejected and nothing else.
  const reply = fakeTemplateReply({ transactionCount: 1 })
  const first = (reply['transactions'] as { txid: string }[])[0] as { txid: string }
  const template = parseTemplate(reply)
  assert.equal(Buffer.from(template.transactions[0]?.txid ?? Buffer.alloc(0)).reverse().toString('hex'), first.txid)
})

test('a template with no transactions is legal', () => {
  // An empty mempool is an ordinary state, especially on a private network, and the coinbase alone
  // is a valid block.
  const template = parseTemplate(fakeTemplateReply({ transactionCount: 0 }))
  assert.deepEqual(template.transactions, [])
})

test('mintime falls back to curtime rather than to zero', () => {
  // A floor of zero is no floor at all: `validate.ts` checks the submitted ntime against it, and a
  // template without `mintime` would otherwise accept a header dated 1970.
  const reply = fakeTemplateReply({ curTime: 1_700_000_000 })
  delete reply['mintime']
  assert.equal(parseTemplate(reply).minTime, 1_700_000_000)
})

test('a pre-segwit template falls back from txid to hash', () => {
  // Pre-segwit Core reported only `hash`, and it was the same thing then. The fallback exists for
  // that case and must never fire the other way: reading `hash` on a modern template builds the
  // witness tree instead of the txid tree.
  const reply = fakeTemplateReply({ transactionCount: 1 })
  const transactions = reply['transactions'] as Record<string, unknown>[]
  const entry = transactions[0] as Record<string, unknown>
  const txid = entry['txid'] as string
  delete entry['txid']
  entry['hash'] = txid
  assert.equal(
    Buffer.from(parseTemplate(reply).transactions[0]?.txid ?? Buffer.alloc(0)).reverse().toString('hex'),
    txid,
  )
})

test('txid wins over hash when both are present', () => {
  const reply = fakeTemplateReply({ transactionCount: 1 })
  const entry = (reply['transactions'] as Record<string, unknown>[])[0] as Record<string, unknown>
  const txid = entry['txid'] as string
  entry['hash'] = fakeHashHex('a witness hash that is not the txid')
  assert.equal(
    Buffer.from(parseTemplate(reply).transactions[0]?.txid ?? Buffer.alloc(0)).reverse().toString('hex'),
    txid,
  )
})

test('an absent witness commitment is null, not an empty string', () => {
  // `coinbase.ts` branches on null to decide whether the coinbase carries a witness output at all.
  // An empty string is truthy enough to reach a `Buffer.from('', 'hex')` and produce a zero-length
  // output script, which is a coinbase the node rejects.
  assert.equal(parseTemplate(fakeTemplateReply({ witnessCommitment: null })).witnessCommitmentHex, null)
  const empty = fakeTemplateReply()
  empty['default_witness_commitment'] = ''
  assert.equal(parseTemplate(empty).witnessCommitmentHex, null)
})

/* ------------------------------------------------------------------ MWEB */

test('a bitcoin-shaped template has no extension block and no integrating transaction', () => {
  // The ordinary case, and the one every other test in this file runs in.
  const template = parseTemplate(fakeTemplateReply())
  assert.equal(template.mwebHex, null)
  assert.ok(template.transactions.every((tx) => !tx.isHogEx))
})

test('a litecoin template carries the extension block and marks the integrating transaction', () => {
  const template = parseTemplate(fakeTemplateReply({ mweb: true }))
  assert.equal(template.mwebHex, REGTEST_MWEB_BLOCK)
  // Last, which is where consensus requires it and where the node puts it.
  assert.equal(template.transactions.length, 4)
  assert.equal(template.transactions[3]?.isHogEx, true)
  assert.equal(template.transactions[3]?.data, REGTEST_HOGEX_DATA)
  assert.ok(template.transactions.slice(0, 3).every((tx) => !tx.isHogEx))
})

test('the integrating transaction anywhere but last is refused at the boundary', () => {
  // Not a hypothetical about a node misbehaving so much as a guard on this repository: the moment
  // anything starts reordering or filtering `transactions`, a block stops deserialising and the only
  // evidence is a rejection string on the one block the pool ever finds.
  const reply = fakeTemplateReply({ mweb: true })
  const transactions = reply['transactions'] as unknown[]
  transactions.unshift(transactions.pop())
  assert.throws(() => parseTemplate(reply), /not last/)
})

test('an extension block without an integrating transaction is refused', () => {
  // Core writes the extension block behind a final HogEx and reads it back under the same condition,
  // so these two fields are one fact stated twice. A template where they disagree cannot become a
  // block the node will parse, and mining on it would waste every share until it was found.
  const reply = fakeTemplateReply()
  reply['mweb'] = REGTEST_MWEB_BLOCK
  assert.throws(() => parseTemplate(reply), /no MWEB integrating transaction/)
})

test('an integrating transaction without an extension block is refused', () => {
  const reply = fakeTemplateReply({ mweb: true })
  delete reply['mweb']
  assert.throws(() => parseTemplate(reply), /no mweb extension block/)
})

test('an mweb field that is not hex is refused at the boundary', () => {
  // It is concatenated into the block as bytes. `Buffer.from` would silently truncate at the first
  // character it did not like, which is a block short by an arbitrary number of bytes.
  const reply = fakeTemplateReply({ mweb: true })
  reply['mweb'] = 'not hex at all'
  assert.throws(() => parseTemplate(reply), TypeError)
})

test('an absent longpollid is null, so the loop knows to sleep instead', () => {
  assert.equal(parseTemplate(fakeTemplateReply()).longPollId, null)
  assert.equal(parseTemplate(fakeTemplateReply({ longPollId: 'abc123' })).longPollId, 'abc123')
})

/* ------------------------------------------------------------------ refusals */

test('every malformed field is refused at the boundary, by name', () => {
  // The list is the point. Each of these has a plausible way to arrive — a caller asking for
  // `coinbasetxn`, a proxy re-serialising numbers as strings, a fork with a different field set —
  // and each must fail here rather than three modules downstream.
  const cases: [string, (reply: Record<string, unknown>) => void][] = [
    ['bits missing', (r) => delete r['bits']],
    ['bits too short', (r) => (r['bits'] = '1d00ff')],
    ['bits not hex', (r) => (r['bits'] = 'zzzzzzzz')],
    ['previousblockhash missing', (r) => delete r['previousblockhash']],
    ['previousblockhash truncated', (r) => (r['previousblockhash'] = 'ab'.repeat(16))],
    ['coinbasevalue missing', (r) => delete r['coinbasevalue']],
    ['coinbasevalue negative', (r) => (r['coinbasevalue'] = -1)],
    ['coinbasevalue fractional', (r) => (r['coinbasevalue'] = 1.5)],
    ['coinbasevalue beyond 2^53', (r) => (r['coinbasevalue'] = 2 ** 53)],
    ['coinbasevalue as a string', (r) => (r['coinbasevalue'] = '312500000')],
    ['height missing', (r) => delete r['height']],
    ['height fractional', (r) => (r['height'] = 800_000.5)],
    ['version missing', (r) => delete r['version']],
    ['curtime missing', (r) => delete r['curtime']],
    ['transactions missing', (r) => delete r['transactions']],
    ['transactions not an array', (r) => (r['transactions'] = {})],
    ['a transaction with no data', (r) => delete (r['transactions'] as Record<string, unknown>[])[0]?.['data']],
    ['a transaction with no id at all', (r) => delete (r['transactions'] as Record<string, unknown>[])[0]?.['txid']],
    [
      'a transaction id of the wrong length',
      (r) => ((r['transactions'] as Record<string, unknown>[])[0]!['txid'] = 'ff'.repeat(31)),
    ],
  ]

  for (const [what, break_] of cases) {
    const reply = fakeTemplateReply()
    break_(reply)
    assert.throws(() => parseTemplate(reply), TypeError, `${what} was accepted`)
  }
})

test('the refusal names the field, because a template has forty of them', () => {
  const reply = fakeTemplateReply()
  reply['coinbasevalue'] = 'lots'
  assert.throws(() => parseTemplate(reply), /coinbasevalue/)
  const other = fakeTemplateReply()
  delete other['bits']
  assert.throws(() => parseTemplate(other), /bits/)
})

test('something that is not an object at all is refused', () => {
  for (const value of [null, undefined, 'a template', 42, []]) {
    // The array case is the interesting one: `typeof [] === 'object'`, so it reaches the field
    // reads and fails on the first missing one rather than on being an array. Either refusal is
    // correct; what must not happen is a parse that succeeds.
    assert.throws(() => parseTemplate(value), TypeError, `${JSON.stringify(value)} was accepted`)
  }
})

/* ------------------------------------------------------------------ the source */

function sourceFor(node: ReturnType<typeof fakeNode>, published: BlockTemplate[], nowMs = { value: 1_000_000 }) {
  const controller = new AbortController()
  const source = new TemplateSource({
    chain: 'btc',
    rpc: node.rpc,
    onTemplate: (template) => published.push(template),
    onError: () => {},
    signal: controller.signal,
    now: () => nowMs.value,
    sleep: async () => {},
  })
  return { source, controller, nowMs }
}

test('the first template is published', async () => {
  const node = fakeNode()
  const published: BlockTemplate[] = []
  const { source } = sourceFor(node, published)
  await source.fetchOnce()
  assert.equal(published.length, 1)
  assert.equal(source.current?.height, 800_000)
})

test('an unchanged template is fetched but not republished', async () => {
  // Without longpoll the node is asked every few seconds and almost always answers with the same
  // block. Republishing would push a `mining.notify` to every connected miner every few seconds for
  // no reason, and each one is a discontinuity in their own accounting.
  const node = fakeNode()
  const published: BlockTemplate[] = []
  const { source } = sourceFor(node, published)
  await source.fetchOnce()
  await source.fetchOnce()
  await source.fetchOnce()
  assert.equal(published.length, 1)
  assert.equal(node.calls.filter((c) => c.method === 'getblocktemplate').length, 3)
})

test('a new tip republishes', async () => {
  const node = fakeNode()
  const published: BlockTemplate[] = []
  const { source } = sourceFor(node, published)
  await source.fetchOnce()
  node.setTemplate(fakeTemplateReply({ height: 800_001, previousBlockHashHex: fakeHashHex('the next tip') }))
  await source.fetchOnce()
  assert.equal(published.length, 2)
})

test('a fatter mempool on an unchanged tip republishes', async () => {
  // The case a tip comparison alone misses. The fees moved, the block is worth more, and the miners
  // should be working on the better one — the tip is identical and the height is identical.
  const node = fakeNode()
  const published: BlockTemplate[] = []
  const { source } = sourceFor(node, published)
  await source.fetchOnce()
  node.setTemplate(fakeTemplateReply({ coinbaseValue: 312_600_000 }))
  await source.fetchOnce()
  assert.equal(published.length, 2)
  assert.equal(published[1]?.coinbaseValue, 312_600_000n)
})

test('the request carries the chain rules and the capabilities core insists on', async () => {
  // Core refuses to serve a template to a caller that does not claim to understand the version bits
  // currently signalling. A missing `rules` is a node that answers with an error, not a node that
  // answers with a slightly worse template.
  const node = fakeNode()
  const { source } = sourceFor(node, [])
  await source.fetchOnce()
  const request = node.calls[0]?.params[0] as Record<string, unknown>
  assert.deepEqual(request['rules'], ['segwit'])
  assert.ok(Array.isArray(request['capabilities']))
  assert.equal(request['longpollid'], undefined, 'a first fetch has no longpoll id to send')
})

test('a longpoll id is sent back to the node when there is one', async () => {
  const node = fakeNode()
  const { source } = sourceFor(node, [])
  await source.fetchOnce('lp-42')
  const request = node.calls[0]?.params[0] as Record<string, unknown>
  assert.equal(request['longpollid'], 'lp-42')
})

test('staleness is measured against the fetch, and an unfetched source is stale', async () => {
  // `/readyz` reads this. A pool serving a five-minute-old template looks perfectly healthy from the
  // outside — connections up, shares arriving — and every one of those shares is worthless.
  const node = fakeNode()
  const nowMs = { value: 1_000_000 }
  const { source } = sourceFor(node, [], nowMs)
  assert.ok(source.isStale(), 'a source that has never fetched must not claim to be fresh')
  await source.fetchOnce()
  assert.ok(!source.isStale())
  nowMs.value += TEMPLATE_STALE_AFTER_MS + 1
  assert.ok(source.isStale())
})

test('a node error surfaces as a NodeRpcError rather than a parse failure', async () => {
  const node = fakeNode({ faults: { getblocktemplate: { code: -10, message: 'Bitcoin is downloading blocks...' } } })
  const { source } = sourceFor(node, [])
  await assert.rejects(() => source.fetchOnce(), NodeRpcError)
  assert.equal(source.current, null, 'a failed fetch must not install a template')
})

test('the loop cannot be started twice', async () => {
  // Two loops against one node would double the poll rate and race each other into `#current`.
  const node = fakeNode()
  const controller = new AbortController()
  const source = new TemplateSource({
    chain: 'btc',
    rpc: node.rpc,
    onTemplate: () => controller.abort(),
    onError: () => {},
    signal: controller.signal,
    sleep: async () => {},
  })
  const running = source.run()
  await assert.rejects(() => source.run(), /already running/)
  await running
})

test('the loop stops when the signal aborts and never leaves a timer behind', async () => {
  // The abort is raised from inside `onTemplate`, which is the shutdown path: the loop is mid-cycle
  // when the process is asked to stop.
  const node = fakeNode()
  const controller = new AbortController()
  let fetches = 0
  const source = new TemplateSource({
    chain: 'btc',
    rpc: node.rpc,
    onTemplate: () => {
      fetches += 1
      controller.abort()
    },
    onError: () => {},
    signal: controller.signal,
    sleep: async () => {},
  })
  await source.run()
  assert.equal(fetches, 1)
})

test('a failing node backs off and keeps going rather than ending the chain', async () => {
  // A node restarting for thirty seconds must not be the reason a pool stops serving a chain
  // permanently — and it must not be invisible either, which is what `onError` and `isStale` are
  // between them.
  const node = fakeNode({ faults: { getblocktemplate: { code: -28, message: 'Loading block index...' } } })
  const controller = new AbortController()
  const errors: unknown[] = []
  const delays: number[] = []
  const source = new TemplateSource({
    chain: 'btc',
    rpc: node.rpc,
    pollIntervalMs: 1000,
    onTemplate: () => {},
    onError: (err) => {
      errors.push(err)
      if (errors.length >= 3) controller.abort()
    },
    signal: controller.signal,
    sleep: async (ms) => {
      delays.push(ms)
    },
  })
  await source.run()
  assert.equal(errors.length, 3)
  assert.ok(errors.every((err) => err instanceof NodeRpcError))
  // Doubling, from the poll interval: 1000, 2000, 4000.
  assert.deepEqual(delays.slice(0, 3), [1000, 2000, 4000])
  assert.ok(source.isStale())
})

/* ----------------------------------------- not stranding the node's RPC threads (micro-org#307) */

/**
 * These five are the regression guard for a measured production incident, and the property they
 * defend is not about this service at all.
 *
 * Core serves a longpoll on an RPC worker thread that blocks until the tip changes, and it never
 * notices that the client hung up. A client-side deadline therefore does not cancel a longpoll — it
 * strands a thread. On the estate's litecoind (`rpcthreads=8`, `blocksonly=1`, so the mempool escape
 * never fires) the old loop stranded a new one every 75.7 seconds and starved the node of workers
 * after roughly ten minutes without a block; micro-indexer's deposit observation went down with it,
 * and came back the second a block landed. The pool losing its own template would have been a fair
 * price. Taking deposit observation down on the chain the estate credits money on was not.
 */

/** A source wired to a node whose longpolls time out, driven by hand rather than by wall clock. */
function suspendingSourceFor(node: ReturnType<typeof fakeNode>, stopAfterFetches: number) {
  const controller = new AbortController()
  const errors: unknown[] = []
  const suspensions: boolean[] = []
  const source = new TemplateSource({
    chain: 'btc',
    rpc: node.rpc,
    pollIntervalMs: 1000,
    onTemplate: () => {},
    onError: (err) => errors.push(err),
    onLongPollSuspended: (suspended) => suspensions.push(suspended),
    signal: controller.signal,
    sleep: async () => {
      if (node.calls.filter((call) => call.method === 'getblocktemplate').length >= stopAfterFetches) {
        controller.abort()
      }
    },
  })
  return { source, controller, errors, suspensions }
}

/** The `longpollid` argument of each `getblocktemplate`, in order. `null` where there was none. */
function longPollIdsIn(node: ReturnType<typeof fakeNode>): (string | null)[] {
  return node.calls
    .filter((call) => call.method === 'getblocktemplate')
    .map((call) => {
      const request = (call.params[0] ?? {}) as { longpollid?: unknown }
      return typeof request.longpollid === 'string' ? request.longpollid : null
    })
}

test('a timed-out longpoll is not immediately replaced by another one', async () => {
  // The mutation this catches: reopening a longpoll after the deadline fires. That is the exact
  // behaviour that strands one node thread per cycle, and it looks identical from the outside —
  // same errors, same backoff, a pool that keeps working. Only the node can tell, and only until it
  // runs out of threads.
  const node = fakeNode({ template: fakeTemplateReply({ longPollId: 'lp-1' }), longPollFails: 'timeout' })
  const { source, errors, suspensions } = suspendingSourceFor(node, 6)
  await source.run()

  const ids = longPollIdsIn(node)
  assert.equal(ids[0], null, 'the first fetch has no id to send yet')
  assert.equal(ids[1], 'lp-1', 'the second uses the id the first was given — longpoll is still the default')
  assert.deepEqual(
    ids.slice(2),
    ids.slice(2).map(() => null),
    'after the timeout every later fetch is plain: at most ONE thread may ever be stranded',
  )
  assert.equal(suspensions[0], true)
  assert.equal(source.longPollSuspended, true)
  assert.ok(
    errors.every((err) => err instanceof NodeUnavailableError && err.reason === NODE_TIMEOUT_REASON),
    'and it must be classified as a timeout, not as the node refusing',
  )
})

test('a moved tip is what resumes longpolling, and nothing weaker', async () => {
  // Resuming on a successful plain fetch instead would resume while the node is still holding the
  // stranded request, and start stacking them a second time. Only a new block proves it let go.
  const node = fakeNode({ template: fakeTemplateReply({ longPollId: 'lp-1' }), longPollFails: 'timeout' })
  const { source } = suspendingSourceFor(node, 4)
  await source.run()
  assert.equal(source.longPollSuspended, true)

  // A plain fetch that succeeds against the SAME tip is not evidence of anything: the node answers
  // it from the same worker pool while still holding the abandoned request on another thread.
  // Asserted on its own fetch rather than on where `run` happened to stop, because the loop can end
  // on either side of a timeout and a resume-on-any-fetch bug survives one of the two.
  await source.fetchOnce(null)
  assert.equal(source.longPollSuspended, true, 'plain fetches alone must NOT lift the suspension')

  // Same node, same source, and now the tip moves.
  node.setTemplate(fakeTemplateReply({ longPollId: 'lp-2', previousBlockHashHex: fakeHashHex('tip-2') }))
  await source.fetchOnce(null)
  assert.equal(source.longPollSuspended, false, 'a changed previousblockhash releases the node and resumes')
})

test('a longpoll that times out on a node whose tip never moves strands at most one thread', async () => {
  // The arithmetic that mattered: 8 threads at one per 75.7s is 606s, and the measured starvation
  // came at 599s. Bounding the count at one is what turns a node-wide outage into a pool that polls.
  const node = fakeNode({ template: fakeTemplateReply({ longPollId: 'lp-1' }), longPollFails: 'timeout' })
  const { source } = suspendingSourceFor(node, 12)
  await source.run()
  const longPolls = longPollIdsIn(node).filter((id) => id !== null)
  assert.equal(longPolls.length, 1, `expected exactly one longpoll to have been abandoned, got ${longPolls.length}`)
})

test('a longpoll that never reached the node at all does not put the loop into fallback', async () => {
  // The control for the test above, and the reason `NodeUnavailableError` carries a `reason` rather
  // than being switched on by class. A 502 from something in front of a stopped node is the same
  // class of error off the same call, and it stranded NOTHING — there is no thread on the far side
  // waiting for a block, so giving up longpolling until the tip moves would trade a fault the pool
  // does not have for latency it does not need.
  const node = fakeNode({ template: fakeTemplateReply({ longPollId: 'lp-1' }), longPollFails: 'unreachable' })
  const { source, errors } = suspendingSourceFor(node, 6)
  await source.run()

  assert.ok(
    errors.length > 0 && errors.every((err) => err instanceof NodeUnavailableError && err.reason !== NODE_TIMEOUT_REASON),
    'the fixture must be failing some way OTHER than a deadline or this test proves nothing',
  )
  assert.equal(source.longPollSuspended, false, 'only a deadline strands a thread, so only a deadline suspends')
  assert.ok(
    longPollIdsIn(node).filter((id) => id !== null).length > 1,
    'and longpolling keeps being attempted, because the breaker is what handles a node that is gone',
  )
})

test('the longpoll deadline outlasts a block interval, so a healthy chain never reaches the fallback', async () => {
  // 60_000 was shorter than the 150s Litecoin aims for, which meant the deadline was not an
  // exception path — it was the normal one, firing on almost every block.
  assert.ok(
    DEFAULT_LONG_POLL_TIMEOUT_MS > 150_000,
    'the default must exceed a Litecoin block interval or the fallback becomes the steady state',
  )

  // Driven a fetch at a time rather than through `run()`: a node that answers its longpolls never
  // sleeps and never errs, so the loop has no seam to stop it and would spin until the heap died.
  const node = fakeNode({ template: fakeTemplateReply({ longPollId: 'lp-1' }) })
  const { source } = suspendingSourceFor(node, 0)
  await source.fetchOnce(null)
  await source.fetchOnce(source.current?.longPollId ?? null)
  assert.equal(source.longPollSuspended, false, 'a node that answers must never put the loop into fallback')
  assert.deepEqual(longPollIdsIn(node), [null, 'lp-1'], 'and the id it handed back is the one sent next')
})

/* ------------------------------------------------------------------ the boot refusals */

test('the payout script comes from the node, never from a derivation here', async () => {
  const node = fakeNode()
  assert.equal(await payoutScriptFor(node.rpc, 'bc1qexample'), FAKE_PAYOUT_SCRIPT)
  assert.deepEqual(node.calls[0], { method: 'validateaddress', params: ['bc1qexample'] })
})

test('an address the node will not confirm is refused, with the reason', async () => {
  const node = fakeNode({ addressValid: false })
  await assert.rejects(
    () => payoutScriptFor(node.rpc, 'not-an-address'),
    (err: Error) => {
      assert.match(err.message, /not valid/)
      // The refusal has to say why it is fatal at boot, or the next person raises the obvious
      // objection that the pool could simply have started and warned.
      assert.match(err.message, /nobody can ever spend/)
      return true
    },
  )
})

test('a valid address with no scriptPubKey is still a refusal', async () => {
  // `isvalid: true` with nothing to pay to is a shape no Core version produces, which is exactly why
  // it must not be assumed away: the alternative is `undefined` reaching a coinbase output.
  const node = fakeNode()
  const original = node.rpc.call.bind(node.rpc)
  ;(node.rpc as { call: unknown }).call = async (method: string, params?: readonly unknown[]) =>
    method === 'validateaddress' ? { isvalid: true } : original(method, params ?? [])
  await assert.rejects(() => payoutScriptFor(node.rpc, 'bc1qexample'), /no scriptPubKey/)
})

test('a node on the wrong network is refused before a single job is built', async () => {
  const node = fakeNode({ nodeChain: 'test' })
  await assert.rejects(
    () => assertNodeNetwork(node.rpc, 'mainnet'),
    (err: Error) => {
      assert.match(err.message, /reports chain 'test'/)
      assert.match(err.message, /Refusing to mine/)
      return true
    },
  )
})

test('every test network core names satisfies a testnet pool', async () => {
  for (const chain of ['test', 'testnet4', 'signet', 'regtest']) {
    const node = fakeNode({ nodeChain: chain })
    await assert.doesNotReject(() => assertNodeNetwork(node.rpc, 'testnet'), `${chain} was refused`)
  }
})

test('a mainnet node satisfies a mainnet pool and nothing else does', async () => {
  await assert.doesNotReject(() => assertNodeNetwork(fakeNode({ nodeChain: 'main' }).rpc, 'mainnet'))
  await assert.rejects(() => assertNodeNetwork(fakeNode({ nodeChain: 'regtest' }).rpc, 'mainnet'))
})

/* ------------------------------------------------------------------ the credential */

test('no message from this module ever carries the node credential', async () => {
  // The endpoint URL carries HTTP Basic userinfo in this estate. `rpc.ts` keeps it out of everything
  // it raises; these are the messages built on top, and they name the host on purpose — `host` is
  // the part that is safe and the part an operator needs.
  const messages: string[] = []
  const node = fakeNode({ addressValid: false, nodeChain: 'test' })
  await payoutScriptFor(node.rpc, 'x').catch((err: Error) => messages.push(err.message))
  await assertNodeNetwork(node.rpc, 'mainnet').catch((err: Error) => messages.push(err.message))

  const faulty = fakeNode({ faults: { getblocktemplate: { code: -1, message: 'nope' } } })
  const { source } = sourceFor(faulty, [])
  await source.fetchOnce().catch((err: Error) => messages.push(err.message))

  assert.equal(messages.length, 3)
  for (const message of messages) {
    assert.ok(!message.includes('rpcpassword'), `a message carried the password: ${message}`)
    assert.ok(!message.includes('rpcuser'), `a message carried the username: ${message}`)
    assert.ok(!message.includes('@'), `a message carried userinfo: ${message}`)
  }
  // And the two that name a location name the host, which is the diagnosable part.
  assert.ok(messages.slice(0, 2).every((message) => message.includes('node.invalid:8332')))
})
