/**
 * `getblocktemplate`: the node's proposal for the next block, parsed into the few fields a Stratum
 * job actually needs, and polled so that the job is never much staler than the tip.
 *
 * ## Why the parse is defensive about a node we run ourselves
 *
 * Because "we run it" is a deployment fact and this is a boundary between two processes. Every field
 * below is read out of an `unknown` and checked, and the reason is not distrust of Core — it is that
 * a template arriving with `coinbasevalue` absent (which happens when a caller asks for
 * `coinbasetxn` instead) or `bits` as something other than eight hex characters must fail here,
 * loudly, at the moment the template is read. The alternative is `NaN` propagating into a target and
 * a pool that accepts every share or none, with nothing in the logs pointing at the template.
 *
 * ## Polling, longpoll, and why this is not a leased job
 *
 * The estate's rule is that recurring domain work belongs in `@cloudsforge/jobs` with a lease, so
 * that two replicas do not do the same work twice. Template fetching is the case that rule does not
 * describe: **each replica must hold its own current template, because each replica serves its own
 * TCP connections.** A leased template fetch would let replica A win the lease and leave replica B
 * with no work to give the miners connected to it. There is no shared state to protect here and
 * nothing to serialise; the template is process-local by nature, like a cache.
 *
 * It is also not `setInterval`, which the estate's CI rejects outright. It is a self-rescheduling
 * `setTimeout` chain, which differs in the way that matters: a slow or hung fetch delays the next
 * one instead of stacking a second concurrent fetch behind it, and an `AbortSignal` stops the chain
 * at shutdown rather than leaving a timer holding the process open.
 *
 * **Longpoll is used when the node offers it.** `longpollid` makes the node hold the request open
 * until the tip changes or its mempool has moved enough to be worth a new template, which turns
 * "poll every N seconds and usually learn nothing" into "learn within milliseconds of the block that
 * makes every outstanding job worthless". That latency is the whole game: a share submitted against
 * a job built on the previous tip is work the miner did for nothing, and the pool's only lever on
 * how much of that happens is how fast it notices.
 *
 * ## ABANDONING A LONGPOLL COSTS THE NODE A THREAD, AND THAT IS WHAT micro-org#307 WAS
 *
 * Read the paragraph above again and note what it does not say: how the node behaves when the CLIENT
 * gives up first. It keeps waiting. Core serves `getblocktemplate` on an RPC worker thread and, when
 * the request carries a `longpollid`, that thread blocks on a condition variable until the tip
 * changes. Closing the socket does not wake it — Core never checks. So a client-side deadline does
 * not cancel a longpoll; it strands a worker thread on the node until the next block, and issuing a
 * fresh longpoll immediately afterwards strands another.
 *
 * That is not a theoretical concern, it is a measured production incident. On the estate's litecoind,
 * `getrpcinfo` sampled three times twenty seconds apart on 2026-08-11 showed FIVE concurrent
 * `getblocktemplate` calls whose durations only ever grew, a new one appearing every 75.7 seconds
 * (deltas 75.7, 75.8, 75.4, 75.7 — the 60 s deadline below plus one backoff plus a plain re-fetch).
 * litecoind runs `rpcthreads=8`, so eight of those exhaust every worker it has and the node begins
 * refusing everyone. The indexer logged `getblockcount: all 1 provider(s) failed — last: timeout`
 * from 23:25:27 to 23:25:58 and recovered at 23:26:31 — the exact second block 3157732 landed and
 * released the stranded threads. The gap that starved it was 599 s; 8 threads at one per 75.7 s
 * predicts 606 s. micro-org#307's earlier "work queue depth exceeded" storm is the same mechanism
 * against the then-default `rpcthreads=4`, which starves in half the time.
 *
 * The collateral damage is not the pool's. It is every other consumer of that node: deposit
 * observation in micro-indexer and withdrawal broadcast in micro-settlement, on the one chain this
 * estate moves money on.
 *
 * **Why the deadline fires at all**, given Core is documented to return a longpoll within about a
 * minute: that escape is `mempool.GetTransactionsUpdated()` changing, and these nodes run
 * `blocksonly=1`. The mempool is permanently empty — measured, `getmempoolinfo.size` is 0 — so the
 * only thing that can end a longpoll is a new block, and LTC aims for one every 150 s. A 60 s
 * deadline against a 150 s target does not occasionally time out. It nearly always does.
 *
 * **The response, therefore, is to stop asking rather than to ask again.** A longpoll that times out
 * suspends longpolling until the tip actually moves; the loop falls back to plain polling, which
 * answers immediately and holds no thread. At most one stranded thread can exist at a time, instead
 * of one per cycle without limit. The deadline is also raised well past a normal block interval, so
 * that on a healthy chain the longpoll returns on its own and the fallback stays unused.
 */

import { hashFromDisplay } from './bytes.ts'
import { hogExIndexOf } from './mweb.ts'
import { targetFromCompactBits } from './pow.ts'
import { NODE_TIMEOUT_REASON, NodeRpcError, NodeUnavailableError, type NodeRpc } from './rpc.ts'
import { EXPECTED_NODE_CHAIN, poolChain, type PoolChainId } from './chains.ts'
import type { Network } from '@cloudsforge/contracts-chain'

export interface TemplateTransaction {
  /** Consensus serialisation, hex, exactly as the node gave it. Passed through untouched. */
  readonly data: string
  /** Internal byte order, ready for the merkle tree. */
  readonly txid: Buffer
  /**
   * Litecoin's MWEB integrating transaction — the HogEx. See `mweb.ts`.
   *
   * Always false on Bitcoin, and false on Litecoin until MWEB activated. Carried per transaction
   * rather than as "the last one" so that `blocks.ts` can assert the position it depends on instead
   * of assuming it.
   */
  readonly isHogEx: boolean
}

export interface BlockTemplate {
  readonly height: number
  readonly version: number
  /** Display order, as the node reports it. `bytes.ts` converts at each point of use. */
  readonly previousBlockHashHex: string
  readonly curTime: number
  readonly minTime: number
  /** The compact `bits` field, as eight hex characters. */
  readonly bitsHex: string
  /** The block target, decoded from `bitsHex`. The only source of a block target in this service. */
  readonly blockTarget: bigint
  readonly coinbaseValue: bigint
  readonly transactions: readonly TemplateTransaction[]
  readonly witnessCommitmentHex: string | null
  /**
   * Litecoin's MWEB extension block, hex, exactly as the template's top-level `mweb` field gave it,
   * or null on a template that has none — which is every Bitcoin template and every Litecoin
   * template from before MWEB activated.
   *
   * Non-null exactly when the last transaction is the HogEx; `parseTemplate` refuses a template
   * where those two disagree, because Core's block deserialiser ties them together. See `mweb.ts`.
   */
  readonly mwebHex: string | null
  readonly longPollId: string | null
  readonly fetchedAt: Date
}

function objectAt(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new TypeError(`${what} is not an object`)
  return value as Record<string, unknown>
}

function integerAt(source: Record<string, unknown>, key: string): number {
  const value = source[key]
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new TypeError(`getblocktemplate.${key} is not an integer`)
  }
  return value
}

function stringAt(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  if (typeof value !== 'string' || value === '') throw new TypeError(`getblocktemplate.${key} is not a string`)
  return value
}

/**
 * The node's reply, checked and narrowed.
 *
 * `coinbasevalue` is read as a JSON number and converted to bigint through a **safe-integer check
 * that is not theatre**. A block subsidy is well inside 2^53 today, but the value is money in the
 * smallest unit and the estate's convention — `contracts-chain`'s `parseAmount`, the ledger's
 * columns — is that money is a bigint from end to end. The check is the boundary where the JSON
 * number stops being allowed to be approximate.
 */
export function parseTemplate(value: unknown, fetchedAt: Date = new Date()): BlockTemplate {
  const raw = objectAt(value, 'getblocktemplate')

  const bitsHex = stringAt(raw, 'bits')
  if (!/^[0-9a-fA-F]{8}$/.test(bitsHex)) throw new TypeError(`getblocktemplate.bits is not a 4-byte hex value`)

  const previousBlockHashHex = stringAt(raw, 'previousblockhash')
  if (!/^[0-9a-fA-F]{64}$/.test(previousBlockHashHex)) {
    throw new TypeError('getblocktemplate.previousblockhash is not a 32-byte hex hash')
  }

  const coinbaseValueRaw = raw['coinbasevalue']
  if (typeof coinbaseValueRaw !== 'number' || !Number.isSafeInteger(coinbaseValueRaw) || coinbaseValueRaw < 0) {
    throw new TypeError('getblocktemplate.coinbasevalue is not a non-negative safe integer')
  }

  const transactionsRaw = raw['transactions']
  if (!Array.isArray(transactionsRaw)) throw new TypeError('getblocktemplate.transactions is not an array')
  const parsed = transactionsRaw.map((entry, index) => {
    const tx = objectAt(entry, `getblocktemplate.transactions[${index}]`)
    const data = stringAt(tx, 'data')
    if (!/^([0-9a-fA-F]{2})+$/.test(data)) {
      throw new TypeError(`getblocktemplate.transactions[${index}].data is not hex`)
    }
    // `txid` is the non-witness hash and `hash` is the witness one; the merkle tree this pool
    // computes is the txid tree, so a template that omits `txid` — pre-segwit Core did — must fall
    // back to `hash`, which was the same thing then. Reading `hash` on a modern segwit template
    // would build the wrong merkle root for any block containing a segwit transaction, which is
    // every block.
    const txidHex = typeof tx['txid'] === 'string' ? tx['txid'] : stringAt(tx, 'hash')
    if (!/^[0-9a-fA-F]{64}$/.test(txidHex)) {
      throw new TypeError(`getblocktemplate.transactions[${index}].txid is not a 32-byte hex hash`)
    }
    return { data, txid: hashFromDisplay(txidHex), bytes: Buffer.from(data, 'hex') }
  })

  // Which of these, if any, is Litecoin's MWEB integrating transaction — and a refusal if it is not
  // where the block serialisation requires it to be. `mweb.ts` explains why this is read out of the
  // bytes rather than assumed from the position the node happens to use.
  const hogExIndex = hogExIndexOf(parsed.map((tx) => tx.bytes))
  const transactions: TemplateTransaction[] = parsed.map((tx, index) => ({
    data: tx.data,
    txid: tx.txid,
    isHogEx: index === hogExIndex,
  }))

  const witnessCommitment = raw['default_witness_commitment']
  const longPollId = raw['longpollid']

  // The extension block and the HogEx are one fact stated twice, and Core ties them together: it
  // writes the extension block after the transaction vector if and only if the last transaction is
  // the integrating one, and reads it back under the same condition. A template where only one of
  // the two is present is a template no valid block can be built from, so it is refused here rather
  // than turned into a block the node cannot parse.
  const mwebRaw = raw['mweb']
  const mwebHex = typeof mwebRaw === 'string' && mwebRaw !== '' ? mwebRaw : null
  if (mwebHex !== null && !/^([0-9a-fA-F]{2})+$/.test(mwebHex)) {
    throw new TypeError('getblocktemplate.mweb is not hex')
  }
  const hasHogEx = hogExIndex !== -1
  if (mwebHex !== null && !hasHogEx) {
    throw new TypeError(
      'getblocktemplate carries an mweb extension block but no MWEB integrating transaction. Litecoin ' +
        'reads the extension block off the wire only behind a final HogEx, so this template cannot be ' +
        'turned into a block the node will parse.',
    )
  }
  if (hasHogEx && mwebHex === null) {
    throw new TypeError(
      'getblocktemplate carries an MWEB integrating transaction but no mweb extension block. The ' +
        'integrating transaction commits to an extension block that is not here, so submitting this ' +
        'block would mean submitting a commitment to nothing.',
    )
  }

  const curTime = integerAt(raw, 'curtime')

  return {
    height: integerAt(raw, 'height'),
    version: integerAt(raw, 'version'),
    previousBlockHashHex,
    curTime,
    // `mintime` is the median-time-past bound: a header with an `ntime` below it is invalid. Miners
    // roll ntime, so this is the floor `validate.ts` checks against, and a template without it
    // falls back to curtime rather than to zero — a floor of zero is no floor at all.
    minTime: typeof raw['mintime'] === 'number' && Number.isInteger(raw['mintime']) ? raw['mintime'] : curTime,
    bitsHex,
    blockTarget: targetFromCompactBits(Number.parseInt(bitsHex, 16)),
    coinbaseValue: BigInt(coinbaseValueRaw),
    transactions,
    witnessCommitmentHex: typeof witnessCommitment === 'string' && witnessCommitment !== '' ? witnessCommitment : null,
    mwebHex,
    longPollId: typeof longPollId === 'string' && longPollId !== '' ? longPollId : null,
    fetchedAt,
  }
}

/**
 * The `scriptPubKey` the node says this address pays to.
 *
 * See the long note at the top of `coinbase.ts` for why this is asked of the node rather than
 * derived here. What this function adds is that a rejected address is a **boot failure**: the
 * service refuses to serve the chain at all rather than starting and discovering the problem on the
 * one block it finds. There is no safe way to mine towards an address the node will not confirm.
 */
export async function payoutScriptFor(rpc: NodeRpc, address: string): Promise<string> {
  const reply = await rpc.call<unknown>('validateaddress', [address])
  const parsed = objectAt(reply, 'validateaddress')
  if (parsed['isvalid'] !== true) {
    throw new Error(
      `the payout address configured for ${rpc.chain} is not valid on the node at ${rpc.host}. ` +
        'This is refused at boot rather than at the first block, because a block mined to an ' +
        'address the chain will not pay is a reward nobody can ever spend.',
    )
  }
  const script = parsed['scriptPubKey']
  if (typeof script !== 'string' || !/^[0-9a-fA-F]+$/.test(script) || script.length === 0) {
    throw new Error(`validateaddress on the ${rpc.chain} node returned no scriptPubKey for the payout address`)
  }
  return script
}

/**
 * Refuse to serve a chain whose node is on the wrong network.
 *
 * `chains.ts` explains why this is fatal for a pool where it is merely noisy for an indexer: the
 * payout address is network-specific, and a mainnet template mined towards a testnet address pays
 * the reward to nobody.
 */
export async function assertNodeNetwork(rpc: NodeRpc, network: Network): Promise<void> {
  const reply = await rpc.call<unknown>('getblockchaininfo')
  const parsed = objectAt(reply, 'getblockchaininfo')
  const chain = parsed['chain']
  const expected = EXPECTED_NODE_CHAIN[network]
  if (typeof chain !== 'string' || !expected.has(chain)) {
    throw new Error(
      `the ${rpc.chain} node at ${rpc.host} reports chain '${String(chain)}', which is not one of ` +
        `${[...expected].join(', ')} for network '${network}'. Refusing to mine: the payout address ` +
        'belongs to one network and the template to another.',
    )
  }
}

export interface TemplateSourceOptions {
  readonly chain: PoolChainId
  readonly rpc: NodeRpc
  /** How often to ask when longpoll is unavailable, and the ceiling on a longpoll wait. */
  readonly pollIntervalMs?: number
  readonly longPollTimeoutMs?: number
  /**
   * Test seam only. Production leaves this alone and lets `#longPollSuspended` do its work.
   *
   * The suite needs to assert BOTH halves of the strand-avoidance rule — that a timeout suspends
   * longpolling, and that a moved tip resumes it — and asserting the second half means observing the
   * flag rather than inferring it from a call sequence three fetches later.
   */
  readonly onLongPollSuspended?: (suspended: boolean) => void
  readonly onTemplate: (template: BlockTemplate) => void
  readonly onError: (err: unknown) => void
  readonly signal: AbortSignal
  /** Test seams. The suite drives the loop by hand rather than by wall clock. */
  readonly now?: () => number
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}


/**
 * How long THIS chain's template is served before `/readyz` stops claiming the chain is working.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **A STALENESS THRESHOLD SHORTER THAN THE LONGPOLL TIMEOUT CALLS A WORKING POOL BROKEN.**
 *
 * Until 2026-08-11 this was one constant for every chain, `TEMPLATE_STALE_AFTER_MS = 120_000`,
 * sitting above a `DEFAULT_LONG_POLL_TIMEOUT_MS` of 240 s. The
 * loop spends most of its life *inside* a longpoll, and a longpoll returns when the tip moves. So
 * on any chain quiet for longer than 120 s, the template's age passed the threshold while the node
 * was holding a request that had not yet had anything to say — and the pool reported the chain
 * not-ready for the second half of every gap between blocks.
 *
 * Litecoin never showed it. Its mempool churns, and a template rebuilt over a fatter mempool
 * publishes on the changed coinbase value, so LTC re-fetched every 30–60 s regardless of the tip.
 * Bitcoin has no such cover on this estate: the node runs `blocksonly=1`, so it keeps no mempool at
 * all, and the ONLY event that ends a BTC longpoll is a block. Those average 600 s.
 *
 * Measured on mainnet 2026-08-11, minutes after `POOL_CHAINS=ltc,btc` first carried real traffic:
 * `templateAgeSeconds: 246`, `ready: false`, `btc` alone, and the lifecycle flipping
 * `ready → degraded → ready → degraded` on a two-minute cycle while LTC published seven new jobs
 * without a pause. The container went unhealthy with a failing streak of 4. Nothing was wrong with
 * the node, the pool, or the chain: a quiet chain is the ordinary state of a chain between blocks,
 * and this threshold called it an outage.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * So the number is DERIVED, from the two things that actually bound it:
 *
 *   1. **Twice the chain's target block interval.** The question the probe exists to ask is "are we
 *      handing out work from before the last block?", and one interval is the expected wait for the
 *      next one. Twice it is the ordinary tail of a Poisson process — a gap that long happens
 *      several times a day on any chain and is not news. Alerting on the ordinary tail is how a
 *      health signal becomes something an operator mutes.
 *   2. **A longpoll timeout plus a margin.** A template cannot be refreshed while the loop is
 *      waiting for one, so a threshold at or below the timeout is unsatisfiable by construction —
 *      the pool would be marking itself unhealthy for doing exactly what it was written to do. The
 *      margin covers the fetch, parse and publish that follow the longpoll returning.
 *
 * `templateStaleAfterMs` never returns a value the pool cannot honour, and `template.test.ts`
 * asserts that for every chain in the table rather than for the two that exist today.
 *
 * Litecoin: max(300 s, 300 s) = 300 s. Bitcoin: max(1200 s, 300 s) = 1200 s. Both are now longer
 * than the longpoll they sit above, which the single constant never was for either.
 */
export function templateStaleAfterMs(chain: PoolChainId): number {
  const twoBlocks = poolChain(chain).targetBlockSeconds * 2 * 1000
  return Math.max(twoBlocks, DEFAULT_LONG_POLL_TIMEOUT_MS + LONG_POLL_RETURN_MARGIN_MS)
}

/**
 * The room left for a longpoll to return and its answer to be published, on top of the timeout.
 *
 * A minute is generous for a parse and a callback, and generous is the right direction: the cost of
 * being too slow to declare a chain stale is that miners work an extra minute on a template that is
 * still probably current, and the cost of being too quick is the flapping this whole block exists
 * to describe.
 */
const LONG_POLL_RETURN_MARGIN_MS = 60_000

/**
 * The ceiling on how long the node may hold a longpoll before this client gives up on it.
 *
 * Comfortably past a Litecoin block interval (150 s) and a Bitcoin one is longer still, but the
 * number is not chosen to cover every gap — the fallback below handles the ones it does not. It is
 * chosen so that on a chain producing blocks at its target rate the longpoll RETURNS, which is the
 * state in which no thread is ever stranded and the latency the longpoll exists for is actually
 * collected. The previous value was 60 s, which is shorter than the interval it was waiting for.
 */
export const DEFAULT_LONG_POLL_TIMEOUT_MS = 240_000

export class TemplateSource {
  readonly chain: PoolChainId
  #current: BlockTemplate | null = null
  #running = false
  /**
   * Set when a longpoll timed out, cleared when the tip moves. While set, the loop asks plainly.
   *
   * The stranded thread the timeout just cost the node is not recoverable from here — but the SECOND
   * one is, and the eighth is the one that takes the node down for everybody else.
   */
  #longPollSuspended = false
  readonly #options: TemplateSourceOptions
  readonly #pollIntervalMs: number
  readonly #longPollTimeoutMs: number
  readonly #now: () => number
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>

  constructor(options: TemplateSourceOptions) {
    this.chain = options.chain
    this.#options = options
    this.#pollIntervalMs = options.pollIntervalMs ?? 10_000
    this.#longPollTimeoutMs = options.longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS
    this.#now = options.now ?? (() => Date.now())
    this.#sleep = options.sleep ?? defaultSleep
  }

  /** Whether the loop is currently declining to longpoll. Read by the suite and by nothing else. */
  get longPollSuspended(): boolean {
    return this.#longPollSuspended
  }

  #setLongPollSuspended(suspended: boolean): void {
    if (this.#longPollSuspended === suspended) return
    this.#longPollSuspended = suspended
    this.#options.onLongPollSuspended?.(suspended)
  }

  get current(): BlockTemplate | null {
    return this.#current
  }

  isStale(): boolean {
    if (!this.#current) return true
    return this.#now() - this.#current.fetchedAt.getTime() > templateStaleAfterMs(this.chain)
  }

  /** One fetch, parsed and published if it is new. Exposed so the loop is testable a tick at a time. */
  async fetchOnce(longPollId: string | null = null): Promise<BlockTemplate> {
    const rules = poolChain(this.chain).templateRules
    const request: Record<string, unknown> = {
      rules,
      // Core refuses to serve a template to a caller that does not claim to understand the block
      // version bits currently signalling, and `capabilities` is how that claim is made.
      capabilities: ['coinbasetxn', 'workid', 'coinbase/append'],
    }
    if (longPollId !== null) request['longpollid'] = longPollId

    const reply = await this.#options.rpc.call<unknown>('getblocktemplate', [request], {
      // A longpoll deliberately outlives the ordinary deadline: the node is meant to hold it, so
      // the key is omitted rather than set to undefined and the client's own default stands.
      ...(longPollId === null ? {} : { deadlineMs: this.#longPollTimeoutMs }),
      signal: this.#options.signal,
    })
    const template = parseTemplate(reply, new Date(this.#now()))

    // Publish on a changed tip OR a changed height OR a changed coinbase value. The last of those is
    // what catches a template rebuilt over a fatter mempool on an unchanged tip: the fees moved, the
    // block is worth more, and the miners should be working on the better one.
    const previous = this.#current
    this.#current = template

    // A moved tip is the ONE event that releases whatever thread a timed-out longpoll stranded on
    // the node, so it is also the only honest moment to start trusting longpoll again. Resuming on
    // anything weaker — a timer, a successful plain fetch — would resume while the node is still
    // holding the previous request and start stacking them up a second time.
    if (previous && previous.previousBlockHashHex !== template.previousBlockHashHex) {
      this.#setLongPollSuspended(false)
    }

    if (
      !previous ||
      previous.previousBlockHashHex !== template.previousBlockHashHex ||
      previous.height !== template.height ||
      previous.coinbaseValue !== template.coinbaseValue
    ) {
      this.#options.onTemplate(template)
    }
    return template
  }

  /**
   * The polling loop.
   *
   * Self-rescheduling rather than `setInterval`, and the difference is not stylistic: a longpoll can
   * be held open for a minute, and an interval would stack a second, third and fourth request behind
   * it against a node that is doing exactly what it was asked to do.
   *
   * An error backs off and continues rather than throwing. A node restarting for thirty seconds must
   * not be the reason a pool stops serving the chain permanently — but it also must not be invisible,
   * so every failure goes to `onError`, and `isStale()` is what `/readyz` reads. The honest state of
   * "the node is gone" is a service that reports itself not ready, not one that has exited.
   */
  async run(): Promise<void> {
    if (this.#running) throw new Error(`the ${this.chain} template loop is already running`)
    this.#running = true
    const signal = this.#options.signal
    let consecutiveFailures = 0

    while (!signal.aborted) {
      // Suspended means ask plainly, and a plain ask is the whole remedy: it answers at once and
      // occupies no worker thread on the node while it waits, because it does not wait.
      const longPollId = this.#longPollSuspended ? null : (this.#current?.longPollId ?? null)
      try {
        const template = await this.fetchOnce(longPollId)
        consecutiveFailures = 0
        // With longpoll the node has already waited for us, so going straight back is correct: the
        // wait happens inside the call. Without it, sleep the poll interval.
        if (template.longPollId === null || this.#longPollSuspended) {
          await this.#sleep(this.#pollIntervalMs, signal)
        }
      } catch (err) {
        if (signal.aborted) break
        // An aborted longpoll on shutdown is not a failure, and neither is the node answering that
        // the longpoll id it was given has expired — that is the protocol working.
        this.#options.onError(err)
        consecutiveFailures += 1

        // The deadline elapsing on a request the node was ASKED to hold is not the node failing. It
        // is this client walking away from a thread the node is still holding for it, and going
        // straight back for another is what turns one stranded thread into all of them. Stop
        // longpolling until a block proves the node let go.
        if (
          longPollId !== null &&
          err instanceof NodeUnavailableError &&
          err.reason === NODE_TIMEOUT_REASON
        ) {
          this.#setLongPollSuspended(true)
        }

        if (err instanceof NodeRpcError || err instanceof NodeUnavailableError) {
          // Drop the longpoll id: it may be the thing the node is objecting to, and a plain fetch
          // is the way back to a known-good state.
          this.#current = this.#current ? { ...this.#current, longPollId: null } : null
        }
        const backoff = Math.min(this.#pollIntervalMs * 2 ** Math.min(consecutiveFailures - 1, 4), 60_000)
        await this.#sleep(backoff, signal)
      }
    }
    this.#running = false
  }
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    // Unreferenced so a pending poll delay never holds the process open past a clean shutdown.
    timer.unref?.()
    function onAbort(): void {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
