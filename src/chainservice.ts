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
import { StratumServer } from './stratum.ts'
import { DEFAULT_VARDIFF, type VardiffOptions } from './vardiff.ts'
import { assertNodeNetwork, payoutScriptFor, TemplateSource, type BlockTemplate } from './template.ts'
import { submitFoundBlock } from './blocks.ts'
import { insertShares, upsertWorker, type Exec } from './store.ts'
import { algorithmFor, nameFor } from './chains.ts'
import { networkDifficultyOf } from './pow.ts'
import { EXTRANONCE2_BYTES } from './stratum.ts'
import type { AcceptedShare } from './session.ts'
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
  readonly coinbaseTag: string
  readonly pplnsMultiplier: number
  readonly templatePollMs: number
  readonly vardiffSharesPerMinute: number
  readonly signal: AbortSignal
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
  readonly connections: number
  readonly height: number | null
  readonly networkDifficulty: number | null
  readonly templateAgeSeconds: number | null
  readonly ready: boolean
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
  readonly #vardiff: VardiffOptions
  readonly #logger: Logger
  #loop: Promise<void> | null = null

  constructor(deps: ChainServiceDeps) {
    this.#deps = deps
    const chain = deps.config.chain
    this.#logger = deps.logger.child({ chain })
    this.#vardiff = { ...DEFAULT_VARDIFF, targetSharesPerMinute: deps.vardiffSharesPerMinute }

    this.#rpc = new NodeRpc({ chain, url: deps.config.nodeUrl })
    this.#registry = new JobRegistry({
      chain,
      tag: Buffer.from(deps.coinbaseTag, 'utf8'),
      // Four bytes each. Eight bytes of extranonce is the deployed convention and it is what miner
      // firmware assumes when it sizes its own counter; the pool's half is per connection and the
      // miner's half is theirs to roll.
      extranonce1Size: 4,
      extranonce2Size: EXTRANONCE2_BYTES,
    })

    this.#stratum = new StratumServer({
      chain,
      algorithm: algorithmFor(chain),
      registry: this.#registry,
      host: deps.stratumBind,
      port: deps.config.stratumPort,
      initialDifficulty: deps.config.initialDifficulty,
      vardiff: this.#vardiff,
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

  /** Whether this chain can currently serve work. Read by `/readyz`. */
  get ready(): boolean {
    return this.#source.current !== null && !this.#source.isStale()
  }

  status(): ChainStatus {
    const chain = this.#deps.config.chain
    const template = this.#source.current
    return {
      chain,
      name: nameFor(chain),
      algorithm: algorithmFor(chain),
      stratumPort: this.#deps.config.stratumPort,
      stratumEndpoint: this.#deps.stratumEndpoint,
      connections: this.#stratum.connectionCount,
      height: template?.height ?? null,
      networkDifficulty: template ? networkDifficultyOf(algorithmFor(chain), template.blockTarget) : null,
      templateAgeSeconds: template ? Math.round((Date.now() - template.fetchedAt.getTime()) / 1000) : null,
      ready: this.ready,
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
