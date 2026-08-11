/**
 * One chain, wired end to end: node → template → job → stratum listener → share → block.
 *
 * The pieces below are all separately testable and none of them knows about the others. This file
 * is where they are connected, and the connections are the interesting part:
 *
 *   - A **new template** becomes a job, and the job is broadcast. `clean_jobs` is the registry's
 *     decision, not this file's, because only the registry knows whether the parent block changed.
 *   - An **accepted share** is buffered by the stratum server and flushed to the database on a short
 *     timer. `stratum.ts` explains the trade.
 *   - A **found block** is submitted immediately and the bookkeeping follows. `blocks.ts` explains
 *     the ordering, which is the one thing here that must be right the first time.
 *
 * ## Boot distinguishes a wrong answer from no answer, and treats them oppositely
 *
 * `start()` does three things before it will listen on a stratum port: it checks the node is on the
 * network this service was configured for, it asks the node to validate the payout address, and it
 * fetches one template. The stratum port opens only if all three pass, always — a pool that comes up
 * without a validated payout address, or against the wrong network, is a pool that takes real work
 * from miners and mines it towards nothing.
 *
 * What differs is what happens when one of them does not pass, and the split is between the node
 * ANSWERING and the node BEING THERE:
 *
 *   - **The node answered and the answer was wrong** — a testnet node under a mainnet
 *     configuration, an address the node calls invalid. Nothing about that improves by waiting, so
 *     it is fatal for the process. It surfaces at deploy time, where somebody is watching, instead
 *     of at the first block.
 *   - **The node did not answer at all** (`NodeUnavailableError`) — it is starting up beside us, it
 *     is reindexing, the compose network is not up yet. That is not a configuration fault and
 *     killing the process for it turns an ordinary restart-ordering into a crash loop. The chain
 *     retries with backoff, its stratum port stays SHUT, and `/readyz` reports the replica unready
 *     for as long as it takes. The HTTP surface still serves `/livez`, because the process is alive
 *     and that is all `/livez` claims.
 *
 * After boot the posture is the second one throughout: a node that goes away is retried and the
 * chain reports itself unready, because a node restarting for thirty seconds must not be a pool that
 * has to be redeployed.
 */

import { JobRegistry } from './work.ts'
import { NodeRpc, NodeUnavailableError } from './rpc.ts'
import { StratumServer, type Wire } from './stratum.ts'
import { browserInitialDifficulty, browserVardiff, DEFAULT_VARDIFF, type VardiffOptions } from './vardiff.ts'
import { assertNodeNetwork, payoutScriptFor, TemplateSource, type BlockTemplate } from './template.ts'
import { AddressChecker } from './payoutaddress.ts'
import { AuxTemplateSource, type AuxUnavailability } from './auxtemplate.ts'
import { submitFoundAuxBlock, submitFoundBlock } from './blocks.ts'
import { insertShares, upsertWorker, type Exec } from './store.ts'
import {
  algorithmFor,
  auxNameFor,
  browserMiningOf,
  nameFor,
  type AuxChainId,
  type PoolChainId,
} from './chains.ts'
import { hashesPerDifficulty, networkDifficultyOf } from './pow.ts'
import { EXTRANONCE2_BYTES } from './stratum.ts'
import type { AcceptedShare } from './session.ts'
import type { AuxChainConfig } from './env.ts'
// Types only, and that matters: `env.ts` validates eagerly and calls `process.exit(1)` on a bad
// environment, so a value import here would make merely importing this module — from a test, from a
// script — require a complete configuration. The published endpoint is therefore composed by the
// composition root in `index.ts` and handed down, rather than derived here.
import type { ChainConfig, StratumEndpoint } from './env.ts'
import type { Logger, Metrics } from '@cloudsforge/telemetry'
import type { Network } from '@cloudsforge/contracts-chain'

export interface ChainServiceDeps {
  readonly config: ChainConfig
  readonly network: Network
  readonly sql: Exec
  readonly logger: Logger
  readonly metrics: Metrics
  readonly stratumBind: string
  /**
   * What to ADVERTISE, as against `stratumBind`, which is the interface to listen ON, and
   * `config.stratumPort`, which is the port bound behind whatever mapping the deploy applies.
   *
   * Composed by the caller from `POOL_STRATUM_PUBLIC_HOST` and this chain's
   * `POOL_<CHAIN>_STRATUM_PUBLIC_PORT`, and `null` whenever an operator has published neither.
   */
  readonly stratumEndpoint: StratumEndpoint | null
  /**
   * The complete URL a BROWSER dials for this chain, or `null` when nobody has published an origin.
   *
   * Composed by the caller from `POOL_WEBSOCKET_PUBLIC_ORIGIN` and this service's own path, for the
   * same reason `stratumEndpoint` is: this process cannot observe the name it is reached at, and
   * inventing one is the defect micro-org#285 records. Advertised, not used — the transport answers
   * on whatever address actually reaches it, and this string is only what `GET /v1/pool` reports.
   */
  readonly websocketEndpoint: string | null
  /**
   * Spend a browser mining ticket, or `undefined` when this deployment has no identity configured.
   *
   * Its presence is what turns browser mining on for this chain: `StratumServer` builds its `browser`
   * block only when a redeemer exists, `attachWebSocket` refuses without one, and the difficulty band
   * below moves only for connections that arrive through it. Raw TCP never sees any of it.
   */
  readonly redeemTicket?: ((secret: string) => { account: string; worker: string } | null) | undefined
  readonly coinbaseTag: string
  readonly pplnsMultiplier: number
  readonly templatePollMs: number
  readonly vardiffSharesPerMinute: number
  readonly signal: AbortSignal
}

/**
 * The browser half of a chain's answer, as a client reads it.
 *
 * `available` is what a page branches on and `reason` is what it prints; a chain that serves
 * browsers carries `reason: null` rather than omitting the key, because a JSON consumer reading an
 * absent field cannot tell it from an older service that had never heard of it.
 */
export interface BrowserMiningStatus {
  readonly available: boolean
  readonly reason: string | null
}

/**
 * The ticket redeemer a chain's listener may have, which is `undefined` for a chain browsers are
 * refused on however well configured the deployment is.
 *
 * A function rather than an inline ternary because this is the whole enforcement of micro-org#360
 * and an inline ternary is not something a test can hold. With no redeemer, `StratumServer` builds
 * no `browser` block, `servesBrowsers` is false and `attachWebSocket` refuses the upgrade — so a
 * page that ignores `browserMining.available` and dials the WebSocket anyway is turned away by the
 * transport. That is the difference between a refusal and a label.
 */
export function browserRedeemerFor<T>(chain: PoolChainId, redeemTicket: T | undefined): T | undefined {
  return browserMiningOf(chain).served ? redeemTicket : undefined
}

export interface ChainStatus {
  readonly chain: string
  readonly name: string
  readonly algorithm: string
  /**
   * The port the listener BINDS. Reported because it is a true fact about this process and an
   * operator reading `/v1/pool` beside a compose file needs it — but it is the inside of a port
   * mapping, so it is not what a miner dials unless `stratumEndpoint` says the same number.
   */
  readonly stratumPort: number
  /**
   * What to type into mining firmware, or `null` when this deployment has published nothing.
   *
   * Null is the honest answer and, on the estate as it stands, the correct one: the stratum port is
   * bound to loopback by default and the hostname that serves the console cannot carry raw TCP. A
   * consumer renders the absence — "no endpoint has been published, ask an operator" — rather than
   * composing a connection string out of the bind, which is the defect micro-org#285 records.
   */
  readonly stratumEndpoint: StratumEndpoint | null
  /**
   * What to pass to `new WebSocket(...)` to mine this chain in a browser, or `null` when this
   * deployment publishes no origin or serves no browsers. One complete URL with nothing for a
   * consumer to assemble — which is the whole lesson of micro-org#285.
   */
  readonly websocketEndpoint: string | null
  /**
   * Whether a browser may mine this chain at all, and the reason when it may not.
   *
   * Distinct from `websocketEndpoint: null`, and the difference is the whole reason this field
   * exists. A null endpoint says *this deployment has published no browser address* — an operator
   * could change it this afternoon. This says *no deployment ever will, and here is why*, which is
   * a sentence a reader can act on: point hardware at the stratum port, or mine the other chain.
   * A consumer that saw only the null would render "not published yet" for a chain that is never
   * going to be published, which is the surface-claims-too-much defect micro-org#360 is about.
   */
  readonly browserMining: BrowserMiningStatus
  readonly connections: number
  readonly height: number | null
  readonly networkDifficulty: number | null
  readonly templateAgeSeconds: number | null
  readonly ready: boolean
  /**
   * The chain merge-mined underneath this one, or `null` when none is configured.
   *
   * Null and "configured but not currently committed" are different answers and both are reported,
   * because merged mining fails by ABSENCE and by nothing else. A dogecoind in initial block
   * download, one with no peers, a `createauxblock` refused — every one of them leaves this pool
   * mining Litecoin exactly as well as it did before, with no error anywhere a miner or an operator
   * would look. `committed` is the one fact that distinguishes "we are merge-mining Dogecoin" from
   * "we intended to", and it is here so that answering it does not require reading the log.
   */
  readonly merged: MergedChainStatus | null
}

/** What is known about the aux chain right now, for `GET /v1/pool` and for whatever renders it. */
export interface MergedChainStatus {
  readonly chain: AuxChainId
  readonly name: string
  /**
   * **Whether the work being handed out right this moment commits to an aux block.**
   *
   * False is not an error state and is the expected one on a node that is still syncing; it is
   * simply the truth, and a consumer that showed "merge-mining Dogecoin" while this was false would
   * be telling a miner they are earning DOGE when they are not.
   */
  readonly committed: boolean
  /** Why there is no commitment, in one word, or `null` when there is one. `auxtemplate.ts` names them. */
  readonly unavailability: AuxUnavailability | null
  readonly height: number | null
  /**
   * The aux chain's own network difficulty, on the PARENT's algorithm.
   *
   * Dogecoin is scrypt like its parent, so this is comparable to the `networkDifficulty` beside it
   * and the comparison is the interesting one: it is roughly how much rarer an aux block is than a
   * parent block for the same hashing, which is what a miner wants to know about a chain they are
   * being paid in.
   */
  readonly networkDifficulty: number | null
}

/** Domain metrics for the pool. Declared, not inferred from a log line — AD-20. */
export function registerPoolMetrics(metrics: Metrics): Metrics {
  return metrics
    .register({
      name: 'pool_shares_total',
      help: 'Share submissions by outcome',
      kind: 'counter',
      labels: ['chain', 'outcome'],
    })
    .register({
      name: 'pool_blocks_found_total',
      help: 'Blocks this pool found, by whether the node accepted them',
      kind: 'counter',
      labels: ['chain', 'result'],
    })
    .register({
      // Three verdicts, not two, because `unavailable` is the one an operator has to be able to see:
      // it is the count of miners this pool authorised WITHOUT checking their payout address, which
      // is a deliberate fail-open and not a thing that should happen quietly. See `payoutaddress.ts`.
      name: 'pool_address_checks_total',
      help: 'Miner payout addresses put to the node at mining.authorize, by verdict',
      kind: 'counter',
      labels: ['chain', 'verdict'],
    })
    .register({
      // The counter an orphan shows up on. `pool_blocks_found_total` says what the node said at
      // submission and cannot be revised; this one says what became of the block, and the two
      // diverging is the whole of micro-org#302. `pending` is counted as well as the two terminal
      // verdicts, because a sweep that only ever reports `pending` is a sweep whose node stopped
      // answering, and that is invisible if only the transitions are counted.
      name: 'pool_block_maturity_total',
      help: 'Maturity verdicts on blocks this pool found, re-read against the node',
      kind: 'counter',
      labels: ['chain', 'status'],
    })
    .register({
      // Every outcome of `rewards.ts`, including the two skips, because those are the interesting
      // ones: `skipped_no_account` climbing while `credited` stays at zero is a pool whose miners
      // are all external, and `skipped_below_minimum` climbing is a threshold set above what a
      // block is worth to one miner. Registered unconditionally although it only moves on a
      // deployment with payouts configured — a metric that appears when a feature is switched on is
      // a metric no dashboard was built against.
      name: 'pool_payout_claim_total',
      help: 'Per-worker outcomes of allocating a matured block reward',
      kind: 'counter',
      labels: ['chain', 'outcome'],
    })
    .register({ name: 'pool_connections', help: 'Live stratum connections', kind: 'gauge', labels: ['chain'] })
    .register({ name: 'pool_template_height', help: 'Height of the current template', kind: 'gauge', labels: ['chain'] })
    .register({
      name: 'pool_template_age_seconds',
      help: 'Age of the current template',
      kind: 'gauge',
      labels: ['chain'],
    })
}

/**
 * A delay that ends early when the process is shutting down.
 *
 * The timer is unreferenced: a chain sitting in a thirty-second backoff against a node that is not
 * coming back must not be the reason a container takes thirty seconds to exit. `template.ts` holds
 * the same helper for its poll delay and for the same two reasons — it is eight lines and private to
 * each, rather than a shared export that widens one module's surface for a single caller.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    timer.unref?.()
    function onAbort(): void {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export class ChainService {
  readonly #deps: ChainServiceDeps
  readonly #rpc: NodeRpc
  readonly #registry: JobRegistry
  readonly #stratum: StratumServer
  readonly #source: TemplateSource
  readonly #addresses: AddressChecker
  readonly #vardiff: VardiffOptions
  readonly #logger: Logger
  /** The one chain merged into this one's work, or null. `env.ts` caps the list at one entry. */
  readonly #auxConfig: AuxChainConfig | null
  readonly #auxRpc: NodeRpc | null
  readonly #aux: AuxTemplateSource | null
  /**
   * Set false when the aux node ANSWERS and the answer is unusable. Never on unavailability.
   *
   * The parent's equivalent of this condition kills the process; here it must not, and the asymmetry
   * is the single most important thing about merged mining in this file. Litecoin mining does not
   * depend on Dogecoin in any direction, so a dogecoind that is misconfigured, unreachable, syncing
   * or simply absent has to cost exactly the merged half and nothing else. A boot check that took
   * the stratum port down for it would turn a bonus into a dependency.
   */
  #auxUsable = true
  #loop: Promise<void> | null = null

  constructor(deps: ChainServiceDeps) {
    this.#deps = deps
    const chain = deps.config.chain
    this.#logger = deps.logger.child({ chain })
    this.#vardiff = { ...DEFAULT_VARDIFF, targetSharesPerMinute: deps.vardiffSharesPerMinute }

    this.#rpc = new NodeRpc({ chain, url: deps.config.nodeUrl })

    // `[0]` rather than a loop: `loadAuxChains` refuses more than `AUX_CHAIN_MERKLE_SIZE` entries,
    // which is one, so a second element cannot exist. Written as an index into the configured list
    // so that widening the tree later changes this file rather than hiding a silent truncation.
    const auxConfig = deps.config.aux[0] ?? null
    this.#auxConfig = auxConfig
    this.#auxRpc = auxConfig === null ? null : new NodeRpc({ chain: auxConfig.chain, url: auxConfig.nodeUrl })
    this.#aux =
      auxConfig === null || this.#auxRpc === null
        ? null
        : new AuxTemplateSource({
            chain: auxConfig.chain,
            rpc: this.#auxRpc,
            payoutAddress: auxConfig.payoutAddress,
            // Fires on transitions only — `auxtemplate.ts` explains why, and it is what makes this
            // loggable at info on a source polled once per Litecoin template.
            onChange: (block, why) => {
              if (block !== null) {
                this.#logger.info('merging a new aux block', {
                  aux: auxConfig.chain,
                  height: block.height,
                  hash: block.hashHex,
                })
              } else {
                this.#logger.warn('mining without a merged-mining commitment', { aux: auxConfig.chain, why })
              }
            },
          })
    this.#registry = new JobRegistry({
      chain,
      tag: Buffer.from(deps.coinbaseTag, 'utf8'),
      // Four bytes each. Eight bytes of extranonce is the deployed convention and it is what miner
      // firmware assumes when it sizes its own counter; the pool's half is per connection and the
      // miner's half is theirs to roll.
      extranonce1Size: 4,
      extranonce2Size: EXTRANONCE2_BYTES,
    })

    // The browser band, computed once and only when there is a browser to serve. It is a different
    // START and a different FLOOR from the hardware one, not a different algorithm: `vardiff.ts` has
    // the arithmetic, and the short version is that pure-JS scrypt does a few hundred hashes a second
    // where an ASIC does terahashes, so a browser at the hardware floor produces no share at all and
    // is indistinguishable from a miner that is broken.
    //
    // A chain the table refuses browsers on gets no band at all, which is what makes the refusal
    // structural: with no `browser` on the listener, `attachWebSocket` turns the upgrade away, so a
    // page that ignores what `/v1/pool` says and dials anyway is refused by the transport rather
    // than served work it could never be paid for (micro-org#360).
    const redeemTicket = browserRedeemerFor(chain, deps.redeemTicket)
    const perDifficulty = hashesPerDifficulty(algorithmFor(chain))

    // The same node, and the same question, that `#bringUp` already puts about the POOL'S own payout
    // address before it will open the stratum port. micro-org#286: the pool checked its own address
    // and not the miner's, and a miner's stratum username is the only address a payment could ever
    // go to. `payoutaddress.ts` holds the caching and the fail-open reasoning.
    this.#addresses = new AddressChecker({
      rpc: this.#rpc,
      onVerdict: (verdict, address, detail) => {
        deps.metrics.increment('pool_address_checks_total', { chain, verdict })
        if (verdict === 'invalid') {
          this.#logger.info('refused a miner whose payout address the node does not recognise', { address })
        } else if (verdict === 'unavailable') {
          this.#logger.warn('authorising a miner without checking their payout address', { address, detail })
        }
      },
    })

    this.#stratum = new StratumServer({
      chain,
      algorithm: algorithmFor(chain),
      registry: this.#registry,
      host: deps.stratumBind,
      port: deps.config.stratumPort,
      initialDifficulty: deps.config.initialDifficulty,
      vardiff: this.#vardiff,
      checkPayoutAddress: (address) => this.#addresses.check(address),
      browser:
        redeemTicket === undefined
          ? undefined
          : {
              initialDifficulty: browserInitialDifficulty(perDifficulty),
              vardiff: browserVardiff(this.#vardiff, perDifficulty),
              redeemTicket,
            },
      persistShares: (shares) => this.#persistShares(shares),
      onBlock: (block) => {
        this.#deps.metrics.increment('pool_shares_total', { chain, outcome: 'block' })
        // Not awaited: the caller is inside a socket's data handler, and a block submission that
        // held it would stall every other message on that connection. The promise is handled
        // rather than dropped — a rejection here is the loudest line this service can print.
        void submitFoundBlock(
          {
            sql: deps.sql,
            rpc: this.#rpc,
            chain,
            algorithm: algorithmFor(chain),
            pplnsMultiplier: deps.pplnsMultiplier,
            flushShares: () => this.#stratum.flush(),
            log: (level, message, fields) => this.#logger[level](message, fields),
          },
          block,
        )
          .then((result) => {
            deps.metrics.increment('pool_blocks_found_total', {
              chain,
              result: result.accepted ? 'accepted' : 'rejected',
            })
          })
          .catch((err: unknown) => {
            this.#logger.error('a block was found and the bookkeeping failed', { err })
          })
      },
      onAuxBlock: (found) => {
        const auxRpc = this.#auxRpc
        const auxConfig = this.#auxConfig
        if (auxRpc === null || auxConfig === null) {
          // A job carries a commitment only when this service built one, and it builds one only
          // from `#aux`, which exists only when `#auxConfig` does. Reaching here means a share met
          // the target of an aux block that arrived from nowhere — worth a line rather than a
          // throw, because the parent block from the same share has already been handled.
          this.#logger.error('a share won an aux block on a chain that is not configured', {
            aux: found.block.chain,
            hash: found.block.hashHex,
          })
          return
        }
        // Counted on the PARENT's chain label, because that is where the share was: `aux_block` on
        // ltc reads as "an ltc share also won a merged block", which is what happened. Counting it
        // under doge would put it in the same series as doge shares, of which there are never any.
        deps.metrics.increment('pool_shares_total', { chain, outcome: 'aux_block' })
        // Not awaited, for the reason `onBlock` above gives — and independent of it. Both may be in
        // flight at once for one share, against two different nodes, and neither waits on the other.
        void submitFoundAuxBlock(
          {
            sql: deps.sql,
            rpc: auxRpc,
            chain: auxConfig.chain,
            parent: chain,
            algorithm: algorithmFor(chain),
            pplnsMultiplier: deps.pplnsMultiplier,
            flushShares: () => this.#stratum.flush(),
            log: (level, message, fields) => this.#logger[level](message, fields),
          },
          found,
        )
          .then((result) => {
            deps.metrics.increment('pool_blocks_found_total', {
              chain: auxConfig.chain,
              result: result.accepted ? 'accepted' : 'rejected',
            })
            // A refused submission usually means the aux tip moved, and the source is holding a hash
            // that is now `block hash unknown` for every future share. Dropping it costs one RPC on
            // the next template and stops this pool committing to a dead block until then.
            if (!result.accepted) this.#aux?.invalidate('refused')
          })
          .catch((err: unknown) => {
            this.#logger.error('an aux block was found and the bookkeeping failed', { err })
          })
      },
      onAuxSpoiled: (spoiled) => {
        // The share was accepted and paid on the parent; only the merged half is lost. `auxpow.ts`
        // has the arithmetic for why this is not a rejection. The counter is what makes it visible:
        // one of these is a curiosity, a stream of them from one account is a miner stuffing the
        // magic bytes into its extranonce, and the two are indistinguishable from a log line.
        deps.metrics.increment('pool_shares_total', { chain, outcome: 'aux_spoiled' })
        this.#logger.warn('a share met the aux target with an unusable coinbase', {
          aux: spoiled.block.chain,
          hash: spoiled.block.hashHex,
          account: spoiled.account,
          worker: spoiled.worker,
          occurrences: spoiled.occurrences,
        })
      },
      onOutcome: (outcome, code) => {
        if (outcome === 'rejected') {
          // Rejections are counted with their protocol code and never stored. The code is the whole
          // diagnostic: 21 in bulk is a pool losing the race to publish new work, 23 in bulk is a
          // vardiff that has drifted above what the hardware can hit, and the two need opposite
          // responses. A single `rejected` counter would make them indistinguishable.
          deps.metrics.increment('pool_shares_total', { chain, outcome: `rejected_${code ?? 'unknown'}` })
        }
      },
      log: (level, message, fields) => this.#logger[level](message, fields),
    })

    this.#source = new TemplateSource({
      chain,
      rpc: this.#rpc,
      pollIntervalMs: deps.templatePollMs,
      onTemplate: (template) => this.#onTemplate(template),
      onError: (err) => this.#logger.warn('template fetch failed', { err: String(err) }),
      signal: deps.signal,
    })
  }

  get chain(): string {
    return this.#deps.config.chain
  }

  /**
   * The node client this chain templates and submits against.
   *
   * Exposed for exactly one caller — the maturity sweep in `jobs.ts`, which re-reads recorded blocks
   * to decide whether they survived. It is a getter rather than a second `NodeRpc` constructed
   * beside it because the identity is the point: `rpc.ts` explains that there is one endpoint per
   * chain and no failover, since two nodes can disagree about the tip, and a maturity verdict taken
   * from a node other than the one that issued the template and took the submission would be a
   * verdict about a different chain of blocks than the one this pool mined on.
   */
  get node(): NodeRpc {
    return this.#rpc
  }

  /** The chain merge-mined underneath this one, or null when none is configured. */
  get auxChain(): AuxChainId | null {
    return this.#auxConfig?.chain ?? null
  }

  /**
   * The aux chain's node client, or null when there is no aux chain.
   *
   * Exposed for the same one caller and by the same argument as `node` above, and the argument is if
   * anything stronger here: this is the node that answered the `submitauxblock`, and it is the only
   * node in the estate that has ever heard of the Dogecoin hash the block row records. The parent's
   * node would answer `-5` to every `getblock` for one, which `maturity.ts` reads as "not the node
   * that took the submission" and leaves pending — so a maturity sweep pointed at the wrong one of
   * these two would never mature a single merge-mined block and would never say why.
   *
   * Non-null whenever `auxChain` is, and the two are read together for exactly that reason.
   */
  get auxNode(): NodeRpc | null {
    return this.#auxRpc
  }

  /** Whether this chain can currently serve work. Read by `/readyz`. */
  get ready(): boolean {
    return this.#source.current !== null && !this.#source.isStale()
  }

  /**
   * Take a connection that arrived as a WebSocket upgrade on the HTTP port, or refuse it.
   *
   * Delegated rather than exposing the listener, so `wsstratum.ts` depends on a two-line structural
   * interface and not on `StratumServer`. Refused — false — when this chain serves no browsers, is
   * shutting down, or has no fresh template: a browser handed an accepted connection and then no job
   * shows a miner that has started and is doing nothing, which is a worse answer than a refused
   * upgrade the page can retry.
   */
  attachWebSocket(wire: Wire): boolean {
    if (!this.ready) return false
    return this.#stratum.attachWebSocket(wire)
  }

  status(): ChainStatus {
    const chain = this.#deps.config.chain
    const template = this.#source.current
    const browser = browserMiningOf(chain)
    return {
      chain,
      name: nameFor(chain),
      algorithm: algorithmFor(chain),
      stratumPort: this.#deps.config.stratumPort,
      stratumEndpoint: this.#deps.stratumEndpoint,
      // Reported only if a browser dialling it would actually be served. `env.ts` already refuses a
      // published origin with no identity configured, so this second condition should be
      // unreachable — it is here because the failure it prevents is the exact one micro-org#285 is
      // about, and the cost of it being belt and braces is one boolean.
      websocketEndpoint: this.#stratum.servesBrowsers ? this.#deps.websocketEndpoint : null,
      // Read from the table rather than from `servesBrowsers`, and the two are not the same
      // question: the listener also stops serving browsers when this deployment configured no
      // identity, which is a deployment fact with no reason to give a reader. `available` is
      // narrowed by both — a chain the table allows, on a deployment that publishes no endpoint,
      // still cannot be mined in a browser today — while `reason` is only ever the table's.
      browserMining: {
        available: browser.served && this.#stratum.servesBrowsers,
        reason: browser.served ? null : browser.reason,
      },
      connections: this.#stratum.connectionCount,
      height: template?.height ?? null,
      networkDifficulty: template ? networkDifficultyOf(algorithmFor(chain), template.blockTarget) : null,
      templateAgeSeconds: template ? Math.round((Date.now() - template.fetchedAt.getTime()) / 1000) : null,
      ready: this.ready,
      merged: this.#mergedStatus(),
    }
  }

  #mergedStatus(): MergedChainStatus | null {
    const config = this.#auxConfig
    if (config === null) return null
    const block = this.#aux?.current ?? null
    return {
      chain: config.chain,
      name: auxNameFor(config.chain),
      // The job registry's own answer, not the template source's. They differ for exactly one tick
      // — a fresh aux block has arrived and the job carrying it has not been built yet — and the
      // question this field asks is about the work miners hold, so the registry is the authority.
      committed: this.#registry.current?.aux != null,
      // Reported even when a block is present, because the two are not opposites: a source that has
      // a stale block and a node that has since started refusing is a state worth seeing.
      unavailability: this.#aux?.unavailability ?? (this.#auxUsable ? null : 'refused'),
      height: block?.height ?? null,
      // The PARENT's algorithm, deliberately. An aux block is won by the parent's proof of work, so
      // its difficulty is only meaningful in the parent's units — `blocks.ts` passes the same
      // algorithm to `networkDifficultyOf` when it records one.
      networkDifficulty: block ? networkDifficultyOf(algorithmFor(this.#deps.config.chain), block.target) : null,
    }
  }

  /**
   * Bring the chain up, or say why not.
   *
   * Throws whatever `#bringUp` threw when the node ANSWERED and the answer was unusable — the caller
   * (`index.ts`) treats that as fatal, which is the whole point of validating at boot. A node that
   * did not answer at all is not a configuration fault and is retried in the background instead;
   * see the header.
   */
  async start(): Promise<void> {
    try {
      await this.#bringUp()
    } catch (err) {
      if (!(err instanceof NodeUnavailableError)) throw err
      this.#logger.warn('the node did not answer at boot — retrying, with this chain stratum port shut', {
        // Host and port. Never the URL, which carries the RPC credential.
        node: this.#rpc.host,
        err: String(err),
      })
      this.#loop = this.#retryUntilUp()
    }
  }

  /**
   * Retry `#bringUp` until it works or the process shuts down.
   *
   * On success this returns and `#loop` has already been replaced by `#bringUp` with the template
   * polling loop — which is the promise `stop()` then waits on. That reassignment out from under
   * this function is deliberate and is why the two share one field: `stop()` must await whichever of
   * the two is actually running, and there is never more than one.
   *
   * A failure that is NOT an unavailability can still turn up here — the node comes back and then
   * calls the payout address invalid — and it is logged at error and retried rather than escalated.
   * There is no honest way to make it fatal from a background loop, and the visible state is already
   * correct: no stratum port, no work handed out, `/readyz` red, and a line every backoff naming the
   * reason.
   */
  async #retryUntilUp(): Promise<void> {
    const signal = this.#deps.signal
    let waitMs = 1_000
    while (!signal.aborted) {
      await sleep(waitMs, signal)
      if (signal.aborted) return
      try {
        await this.#bringUp()
        return
      } catch (err) {
        this.#logger.error('this chain still cannot start', { node: this.#rpc.host, err: String(err) })
        waitMs = Math.min(waitMs * 2, 30_000)
      }
    }
  }

  async #bringUp(): Promise<void> {
    const chain = this.#deps.config.chain

    // Order matters. The network check comes first because every later answer from this node is
    // meaningless if it is the wrong node — including, and especially, the address validation.
    await assertNodeNetwork(this.#rpc, this.#deps.network)
    const payoutScript = await payoutScriptFor(this.#rpc, this.#deps.config.payoutAddress)
    this.#registry.setPayoutScript(payoutScript)
    this.#logger.info('payout address validated by the node', {
      network: this.#deps.network,
      // The address is loggable; it is a public identifier and an operator needs to be able to
      // check it against the one they configured. The node URL, which is not, never appears.
      address: this.#deps.config.payoutAddress,
    })

    // The aux chain's own boot checks, and every one of them is non-fatal by construction — see
    // `#auxUsable`. They run BEFORE the first template so that the first job this pool ever hands
    // out already carries a commitment, rather than being rebuilt for one a few seconds later.
    await this.#bringUpAux()

    // One template before the port opens, so the first miner to connect gets work rather than
    // silence — and so that a coinbase this configuration cannot build (an over-long tag, an
    // unusable payout script) fails here rather than on the first connection. The job is built by
    // `#onTemplate` through the source's own callback; calling it again here would install a second
    // job for the same template and hand two ids out for one piece of work.
    const template = await this.#source.fetchOnce()
    if (this.#registry.current === null) {
      throw new Error(`the first ${chain} template did not produce a job; refusing to open the stratum port`)
    }

    await this.#stratum.listen()
    this.#logger.info('stratum listening', {
      port: this.#deps.config.stratumPort,
      algorithm: algorithmFor(chain),
      height: template.height,
    })

    // The polling loop runs for the life of the process and ends when the signal aborts. It is
    // held rather than dropped so `stop()` can wait for it.
    this.#loop = this.#source.run()
  }

  /**
   * Validate the aux node, then take one aux block, without ever failing the chain.
   *
   * The parent's `#bringUp` refuses to open the stratum port unless the node is on the right network
   * and the payout address validates. This function asks the same two questions of the aux node and
   * answers them the opposite way, because the consequence is the opposite: a wrong parent
   * configuration mines Litecoin towards an address nobody holds, and a wrong aux configuration
   * produces no aux block at all. `createauxblock` is what refuses a bad Dogecoin address, and it
   * refuses it before dogecoind builds anything — so the failure mode being guarded against here is
   * silence, not loss.
   *
   * What the checks buy is therefore the *diagnostic*, at boot, where somebody is watching: an
   * operator who has swapped `POOL_DOGE_PAYOUT_ADDRESS` for a Litecoin one otherwise sees a pool
   * that mines happily and merges nothing, for ever, with one `refused` in a warning line.
   *
   * `NodeUnavailableError` is deliberately not one of the answers that disables anything. A
   * dogecoind that is starting up beside this process is the ordinary case on a cold estate, and the
   * source retries on every template.
   */
  async #bringUpAux(): Promise<void> {
    const aux = this.#aux
    const config = this.#auxConfig
    const rpc = this.#auxRpc
    if (aux === null || config === null || rpc === null) return

    try {
      await assertNodeNetwork(rpc, this.#deps.network)
      // The scriptPubKey is discarded on purpose: this pool never builds the Dogecoin coinbase, so
      // the answer is worthless and the REFUSAL is the whole point of the call.
      await payoutScriptFor(rpc, config.payoutAddress)
      this.#logger.info('aux payout address validated by the aux node', {
        aux: config.chain,
        network: this.#deps.network,
        address: config.payoutAddress,
      })
    } catch (err) {
      if (err instanceof NodeUnavailableError) {
        this.#logger.warn('the aux node did not answer at boot — merging will start when it does', {
          aux: config.chain,
          node: rpc.host,
          err: String(err),
        })
      } else {
        this.#auxUsable = false
        this.#logger.error(
          'this aux chain is misconfigured and will NOT be merged; the parent chain is unaffected',
          { aux: config.chain, node: rpc.host, err: String(err) },
        )
        return
      }
    }

    await this.#refreshAux()
  }

  /**
   * Ask the aux node for a block, and republish the current job if the commitment has to change.
   *
   * `setAux` is what decides whether anything is republished, and it republishes on a change of the
   * aux chain's TIP rather than of its block hash — `work.ts` has the reasoning, and the short
   * version is that dogecoind keeps every block it built under one tip submittable, so chasing the
   * freshest hash would issue a job every few seconds for no gain.
   *
   * Never throws. `refresh()` does not, and `setAux` only can by way of `buildJob`, which is already
   * a fatal configuration fault the moment the first template arrives.
   */
  async #refreshAux(): Promise<void> {
    const aux = this.#aux
    if (aux === null || !this.#auxUsable) return
    try {
      const block = await aux.refresh()
      const job = this.#registry.setAux(block)
      if (job === null) return
      // `cleanJobs` is the registry's decision here as everywhere, and for an aux rebuild it is
      // false: the Litecoin block has not changed, and telling miners to abandon it to chase a
      // Dogecoin tip would trade a real block for a merged one.
      this.#stratum.broadcast(job, job.cleanJobs)
      this.#logger.info('new job for a changed aux tip', {
        jobId: job.id,
        height: job.height,
        aux: block?.chain,
        auxHeight: block?.height,
        cleanJobs: job.cleanJobs,
      })
    } catch (err) {
      this.#logger.error('could not rebuild a job for the aux commitment', { err: String(err) })
    }
  }

  async stop(): Promise<void> {
    await this.#stratum.close()
    if (this.#loop) await this.#loop.catch(() => {})
    this.#loop = null
  }

  #onTemplate(template: BlockTemplate): void {
    const chain = this.#deps.config.chain
    try {
      const job = this.#registry.push(template)
      this.#stratum.broadcast(job, job.cleanJobs)
      this.#deps.metrics.set('pool_template_height', template.height, { chain })
      this.#logger.info('new job', {
        jobId: job.id,
        height: template.height,
        transactions: template.transactions.length,
        cleanJobs: job.cleanJobs,
      })
    } catch (err) {
      // A template that cannot be turned into a job is a configuration fault, not a transient one —
      // an over-long coinbase tag, a payout script the node returned but this code cannot serialise.
      // Loud, and the chain keeps serving the last good job until the template goes stale, which is
      // what `/readyz` will then report.
      this.#logger.error('could not build a job from a template', { err: String(err), height: template.height })
    }

    // AFTER the Litecoin job has been broadcast, and not awaited. The aux block is a bonus and the
    // parent's job must never wait a dogecoind round-trip for it — `auxtemplate.ts` states the rule
    // and this is the one place it could have been broken. The cost of the ordering is that the job
    // just published may carry the previous commitment; `#refreshAux` republishes if the aux tip
    // moved, and if it did not then the previous commitment is still the right one.
    void this.#refreshAux()
  }

  /**
   * Write a batch of accepted shares.
   *
   * The worker id lookup is cached by the database's own unique constraint rather than in memory:
   * `upsertWorker` is one statement and it is what keeps `last_seen_at` moving. Batching by worker
   * first means a rig with eight cards costs one upsert per flush rather than eight.
   */
  async #persistShares(shares: readonly AcceptedShare[]): Promise<void> {
    if (shares.length === 0) return
    const workerIds = new Map<string, number>()
    for (const share of shares) {
      // NUL joins the two halves of the map key because it is the one byte that cannot occur in
      // either half: `parseWorkerName` in `session.ts` splits a username on '.', and both the
      // account and the worker come out of a line of UTF-8 text that a NUL would have terminated
      // long before it reached here. A friendlier separator is a collision waiting to happen —
      // with ':' or '.', the worker names `a.b`/`c` and `a`/`b.c` produce the same key, and two
      // different miners would then share one `pool_workers` row and one share history.
      //
      // Spelled as the escape `\0`, never as the character itself. `conformance`'s estate-wide
      // ledger-account sweep parses every `.ts` file in every sibling checkout and aborts on the
      // first NUL byte it meets (commit e3f32db, after a static check was silently defeated by
      // `grep` skipping files it decided were binary). One embedded byte in one file takes the
      // whole estate gate down, and editors and diffs render it as nothing at all.
      const key = `${share.account}\0${share.worker}`
      if (workerIds.has(key)) continue
      workerIds.set(
        key,
        await upsertWorker(this.#deps.sql, {
          chain: this.#deps.config.chain,
          account: share.account,
          worker: share.worker,
        }),
      )
    }

    await insertShares(
      this.#deps.sql,
      shares.map((share) => {
        const workerId = workerIds.get(`${share.account}\0${share.worker}`)
        if (workerId === undefined) throw new Error(`no worker id for ${share.account}`)
        return {
          chain: this.#deps.config.chain,
          workerId,
          jobId: share.jobId,
          height: share.height,
          difficultyUnits: share.difficultyUnits,
          achievedUnits: share.achievedUnits,
          isBlock: share.isBlock,
        }
      }),
    )
    this.#deps.metrics.increment('pool_shares_total', { chain: this.#deps.config.chain, outcome: 'accepted' }, shares.length)
  }

  /** Sampled at scrape time rather than on a timer. Rule 8: there is no `setInterval` here. */
  sampleGauges(): void {
    const chain = this.#deps.config.chain
    this.#deps.metrics.set('pool_connections', this.#stratum.connectionCount, { chain })
    const template = this.#source.current
    this.#deps.metrics.set(
      'pool_template_age_seconds',
      template ? Math.round((Date.now() - template.fetchedAt.getTime()) / 1000) : -1,
      { chain },
    )
  }
}
