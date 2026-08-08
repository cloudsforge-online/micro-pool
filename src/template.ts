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
 */

import { hashFromDisplay } from './bytes.ts'
import { targetFromCompactBits } from './pow.ts'
import { NodeRpcError, NodeUnavailableError, type NodeRpc } from './rpc.ts'
import { EXPECTED_NODE_CHAIN, poolChain, type PoolChainId } from './chains.ts'
import type { Network } from '@cloudsforge/contracts-chain'

export interface TemplateTransaction {
  /** Consensus serialisation, hex, exactly as the node gave it. Passed through untouched. */
  readonly data: string
  /** Internal byte order, ready for the merkle tree. */
  readonly txid: Buffer
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
  const transactions: TemplateTransaction[] = transactionsRaw.map((entry, index) => {
    const tx = objectAt(entry, `getblocktemplate.transactions[${index}]`)
    const data = stringAt(tx, 'data')
    // `txid` is the non-witness hash and `hash` is the witness one; the merkle tree this pool
    // computes is the txid tree, so a template that omits `txid` — pre-segwit Core did — must fall
    // back to `hash`, which was the same thing then. Reading `hash` on a modern segwit template
    // would build the wrong merkle root for any block containing a segwit transaction, which is
    // every block.
    const txidHex = typeof tx['txid'] === 'string' ? tx['txid'] : stringAt(tx, 'hash')
    if (!/^[0-9a-fA-F]{64}$/.test(txidHex)) {
      throw new TypeError(`getblocktemplate.transactions[${index}].txid is not a 32-byte hex hash`)
    }
    return { data, txid: hashFromDisplay(txidHex) }
  })

  const witnessCommitment = raw['default_witness_commitment']
  const longPollId = raw['longpollid']

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
  readonly onTemplate: (template: BlockTemplate) => void
  readonly onError: (err: unknown) => void
  readonly signal: AbortSignal
  /** Test seams. The suite drives the loop by hand rather than by wall clock. */
  readonly now?: () => number
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

/**
 * How long a template is served before it is considered too old to mine on.
 *
 * Not a poll interval: it is the staleness at which `/readyz` stops claiming this chain is working.
 * A pool that keeps handing out a five-minute-old template is a pool whose miners are burning
 * electricity on a block that has already been found by somebody else, and it looks perfectly
 * healthy from the outside — the connections are up, shares are arriving, and every one of them is
 * worthless.
 */
export const TEMPLATE_STALE_AFTER_MS = 120_000

export class TemplateSource {
  readonly chain: PoolChainId
  #current: BlockTemplate | null = null
  #running = false
  readonly #options: TemplateSourceOptions
  readonly #pollIntervalMs: number
  readonly #longPollTimeoutMs: number
  readonly #now: () => number
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>

  constructor(options: TemplateSourceOptions) {
    this.chain = options.chain
    this.#options = options
    this.#pollIntervalMs = options.pollIntervalMs ?? 10_000
    this.#longPollTimeoutMs = options.longPollTimeoutMs ?? 60_000
    this.#now = options.now ?? (() => Date.now())
    this.#sleep = options.sleep ?? defaultSleep
  }

  get current(): BlockTemplate | null {
    return this.#current
  }

  isStale(): boolean {
    if (!this.#current) return true
    return this.#now() - this.#current.fetchedAt.getTime() > TEMPLATE_STALE_AFTER_MS
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
      try {
        const before = this.#current
        const template = await this.fetchOnce(before?.longPollId ?? null)
        consecutiveFailures = 0
        // With longpoll the node has already waited for us, so going straight back is correct: the
        // wait happens inside the call. Without it, sleep the poll interval.
        if (template.longPollId === null) await this.#sleep(this.#pollIntervalMs, signal)
      } catch (err) {
        if (signal.aborted) break
        // An aborted longpoll on shutdown is not a failure, and neither is the node answering that
        // the longpoll id it was given has expired — that is the protocol working.
        this.#options.onError(err)
        consecutiveFailures += 1
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
