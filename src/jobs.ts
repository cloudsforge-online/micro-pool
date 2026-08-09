/**
 * Background work that is genuinely shared between replicas, and therefore leased.
 *
 * Rule 8 of docs/ecosystem/03 §2: every background timer is a leased job. This service has exactly
 * one piece of work that qualifies, and the line between it and the two loops that are NOT here is
 * the interesting part of this file.
 *
 *   | Work                  | Leased? | Why                                                        |
 *   |-----------------------|---------|------------------------------------------------------------|
 *   | `pool.prune-shares`   | yes     | One shared table. Two replicas deleting the same rows is    |
 *   |                       |         | two transactions competing for the same locks to do one job.|
 *   | `pool.check-maturity` | yes     | One shared table again, and the RPC calls are the cost: N   |
 *   |                       |         | replicas would put N × `getblock` to a node that also has   |
 *   |                       |         | miners to serve, to reach the same verdict.                 |
 *   | `pool.credit-blocks`  | yes     | It reads a matured block's PPLNS window and offers every    |
 *   |                       |         | worker's share to the sink. Two replicas would compute the  |
 *   |                       |         | same allocation and race on the same credit keys. Scheduled |
 *   |                       |         | ONLY for chains that have a payout sink.                    |
 *   | `pool.flush-payouts`  | yes     | It posts MONEY to another service. Two replicas draining    |
 *   |                       |         | the same rows would be two credits racing on one key — safe |
 *   |                       |         | only because the ledger dedupes, which is not a reason to   |
 *   |                       |         | do it. Scheduled ONLY for chains that have a payout sink,   |
 *   |                       |         | which on this estate is none of them; see `env.ts`.         |
 *   | template polling      | no      | `template.ts`: each replica must hold its own template,     |
 *   |                       |         | because each replica serves its own TCP connections. A lease|
 *   |                       |         | here would leave the losing replica with no work to give.   |
 *   | share flushing        | no      | `stratum.ts`: the buffer is per process and holds only the  |
 *   |                       |         | shares that arrived on this process's sockets. Nobody else  |
 *   |                       |         | can flush it.                                               |
 *
 * **The lease key names the contended resource, not the row.** Here the contended resource is one
 * chain's share table, so the key is `chain:<chain>`. Keying on a share id would let two replicas
 * prune overlapping ranges of the same chain concurrently; keying on a single constant would make
 * the Bitcoin prune wait behind the Litecoin one for no reason.
 */

import { JobRunner, type JobQueue, type RunnerEvent } from '@cloudsforge/jobs'
import type { Logger, Metrics } from '@cloudsforge/telemetry'
import type { Network } from '@cloudsforge/contracts-chain'
import { pruneShares, type Exec } from './store.ts'
import { sweepMaturity } from './maturity.ts'
import { creditMaturedBlocks } from './rewards.ts'
import { isMinedChainId, isPoolChainId, minedAssetFor, type AuxChainId, type MinedChainId, type PoolChainId } from './chains.ts'
import type { PayoutSink } from './payouts.ts'
import type { NodeRpc } from './rpc.ts'

export const PRUNE_KIND = 'pool.prune-shares'

/**
 * The watcher micro-org#302 is about. Re-reads every block this pool recorded and still cannot
 * account for, and marks it matured or orphaned. `maturity.ts` holds the reasoning; this is only
 * where it is scheduled.
 */
export const MATURITY_KIND = 'pool.check-maturity'

/**
 * Drains payout credits this service claimed locally and never got a ledger entry for.
 *
 * The safety net that makes `LedgerPayoutSink`'s claim-then-post ordering safe to choose, and the
 * reason that ordering is the estate's shape rather than a shortcut. It is scheduled per chain and
 * **only for chains an operator configured a payout minimum for** — see `recurringFor`. With payouts
 * off, which is every deployment on 2026-08-09, this kind is never seeded and never registered.
 */
export const PAYOUT_FLUSH_KIND = 'pool.flush-payouts'

/**
 * Turns matured blocks into claims — the producer, without which the flush above drains a table
 * nothing writes to.
 *
 * Scheduled on exactly the same terms as the flush: per chain, and only for chains an operator
 * configured a payout minimum for. `rewards.ts` holds the reasoning and every decision; this is only
 * where it is scheduled.
 */
export const CREDIT_KIND = 'pool.credit-blocks'

/**
 * How often the prune runs, and how much it deletes per run.
 *
 * Hourly, and capped at 50,000 rows: a prune that tried to delete a month of backlog in one
 * statement would hold locks on `pool_shares` for as long as it took, and `pool_shares` is the table
 * every accepted share is inserted into. A capped delete that runs again in an hour catches up over
 * a day and never blocks a miner's share from landing.
 */
const PRUNE_EVERY_MS = 60 * 60_000
const PRUNE_BATCH = 50_000

/**
 * How often the maturity sweep runs.
 *
 * Ten minutes, which is far more often than it needs to be and is chosen for the orphan case rather
 * than the maturity one. Maturity is slow by construction — 100 confirmations is about four hours on
 * Litecoin and about seventeen on Bitcoin — so nothing is gained by checking a young block often. An
 * ORPHAN, though, is a block reward this pool has recorded and does not have, and the interval is
 * the delay between that becoming true and an operator being able to see it. Ten minutes of sweeping
 * an empty candidate set costs one indexed query per chain.
 */
const MATURITY_EVERY_MS = 10 * 60_000

/**
 * How often the payout flush runs, and how many rows it drains per run.
 *
 * Five minutes, because what it drains is a claim with no ledger entry — money a miner is owed that
 * the ledger has not been told about — and the interval is the worst-case delay between a lost
 * response and the credit landing. Capped at 100 because each row is one HTTP round trip to the
 * ledger under a lease, and a run that tried to post a thousand would hold the lease past its
 * renewal while a miner waits on the first.
 */
const PAYOUT_FLUSH_EVERY_MS = 5 * 60_000
const PAYOUT_FLUSH_BATCH = 100

/**
 * How often matured blocks are allocated.
 *
 * Ten minutes, the same as the maturity sweep, and the two intervals compose rather than compete: a
 * block becomes spendable at some moment, the maturity sweep notices within ten minutes, and this
 * one allocates it within ten more. Twenty minutes of worst-case delay against the hundred
 * confirmations — about four hours on Litecoin — that had to pass first is not a number worth
 * optimising, and a shorter interval would only run the same empty query more often.
 */
const CREDIT_EVERY_MS = 10 * 60_000

export interface JobDeps {
  readonly sql: Exec
  readonly logger: Logger
  readonly metrics: Metrics
  /*
   * There is deliberately no chain LIST here. Which chains have work is `recurringFor`'s question,
   * asked once at boot when the queue is seeded; a handler is given the chain in its own payload and
   * validates it there. A second list on this interface would be a second answer to the same
   * question, and the failure it invites is the quiet one — a chain seeded and not handled, or
   * handled and not seeded, with nothing in either log to say so.
   */
  readonly retentionDays: number
  /**
   * The node client for one chain, or null when that chain has none configured.
   *
   * A resolver rather than a map so the caller hands over what it already has — `index.ts` reads it
   * off the `ChainService` — and so the maturity sweep provably asks the SAME node that issued the
   * template and took the submission. `rpc.ts` explains why that identity matters: two nodes can
   * disagree about the tip, and a verdict from a different node is a verdict about a different chain
   * of blocks than the one this pool mined on.
   */
  readonly rpcFor: (chain: MinedChainId) => NodeRpc | null
  /**
   * Which network this pool mines. Part of every credit key, so it cannot be defaulted or guessed:
   * a testnet credit under a mainnet key would be the same movement to the ledger.
   */
  readonly network: Network
  /** `POOL_FEE_BASIS_POINTS`. Required with no default; `pplns.ts` says why. */
  readonly feeBasisPoints: number
  /**
   * The payout sink for one chain, or null — and null on every deployment that exists today.
   *
   * Optional on `JobDeps` rather than required, so that a caller which has not configured payouts
   * writes nothing at all rather than writing `() => null` to satisfy a type. Absence and "no sink
   * for this chain" are the same answer here and both mean neither payout handler is registered.
   */
  readonly payoutSinkFor?: (chain: MinedChainId) => JobPayoutSink | null
}

/**
 * What the two payout jobs need of a sink: the producer credits, the flush retries.
 *
 * Declared here rather than imported whole from `payouts.ts` so a test can supply one of each
 * without a database or a ledger, and so this module keeps depending on the seam rather than on
 * `LedgerPayoutSink`.
 */
export interface JobPayoutSink extends PayoutSink {
  flushPending(chain: MinedChainId, limit: number): Promise<number>
}

/**
 * The recurring set for a given chain list. One row per chain per kind, seeded at boot.
 *
 * `payoutChains` is a SUBSET of `chains ∪ aux` and defaults to none, which is what keeps
 * `pool.flush-payouts` out of the queue entirely on a deployment with payouts off. It is a separate
 * argument rather than a flag on each chain because the caller that knows the answer is `index.ts`,
 * which reads `env.payouts`, and this module deliberately imports nothing from `env.ts`.
 *
 * ## Why an aux chain gets two of the four kinds and not four
 *
 * `aux` is the merge-mined chains — Dogecoin under Litecoin — and they are listed separately rather
 * than folded into `chains` because the four kinds do not divide the same way:
 *
 *   - **The prune is per SHARE chain, so an aux chain never gets one.** `pool_shares` has no
 *     Dogecoin rows and never will; the shares that won a Dogecoin block are Litecoin's, and they
 *     are pruned by Litecoin's row. A `pool.prune-shares` keyed `chain:doge` would run for ever,
 *     delete nothing, log `pruned 0` every hour, and read as a prune that has quietly stopped
 *     working.
 *   - **Maturity and credit are per BLOCK chain, so an aux chain gets both.** A Dogecoin block is in
 *     Dogecoin's chain, matures on Dogecoin's schedule and pays in DOGE. `maturity.ts` sets out why
 *     the two chains' fates are independent, and there is no sense in which Litecoin's sweep could
 *     answer for it.
 */
export function recurringFor(
  chains: readonly PoolChainId[],
  payoutChains: readonly MinedChainId[] = [],
  aux: readonly AuxChainId[] = [],
): ReadonlyArray<{ kind: string; key: string; everyMs: number }> {
  const paid = new Set<string>(payoutChains)
  const credit = (chain: MinedChainId) =>
    paid.has(chain)
      ? [
          { kind: CREDIT_KIND, key: `chain:${chain}`, everyMs: CREDIT_EVERY_MS },
          { kind: PAYOUT_FLUSH_KIND, key: `chain:${chain}`, everyMs: PAYOUT_FLUSH_EVERY_MS },
        ]
      : []
  return [
    ...chains.flatMap((chain) => [
      { kind: PRUNE_KIND, key: `chain:${chain}`, everyMs: PRUNE_EVERY_MS },
      { kind: MATURITY_KIND, key: `chain:${chain}`, everyMs: MATURITY_EVERY_MS },
      ...credit(chain),
    ]),
    ...aux.flatMap((chain) => [
      { kind: MATURITY_KIND, key: `chain:${chain}`, everyMs: MATURITY_EVERY_MS },
      ...credit(chain),
    ]),
  ]
}

/** Enqueue the recurring set at boot. `keep` means N replicas booting together produce one row. */
export async function seedRecurring(
  queue: JobQueue,
  chains: readonly PoolChainId[],
  payoutChains: readonly MinedChainId[] = [],
  aux: readonly AuxChainId[] = [],
): Promise<void> {
  for (const job of recurringFor(chains, payoutChains, aux)) {
    await queue.enqueue({ kind: job.kind, key: job.key, payload: { chain: job.key.slice('chain:'.length) }, onConflict: 'keep' })
  }
}

/**
 * Re-arm a recurring job once it has finished.
 *
 * It cannot re-arm itself from inside its own handler: the runner deletes the row on success
 * *after* the handler returns, so a self-enqueue would be deleted a moment later and the schedule
 * would stop. Doing it from the completion event is the only point at which the row is gone.
 *
 * A dead-lettered recurring job is deliberately **not** re-armed. The row stays, `jobs_dead_total`
 * increments and `jobs_overdue` climbs, which is how an operator finds out. Silently rescheduling a
 * job that has failed its full attempt budget hides a permanent fault behind a busy loop.
 */
export function rescheduleRecurring(
  queue: JobQueue,
  logger: Logger,
  chains: readonly PoolChainId[],
  payoutChains: readonly MinedChainId[] = [],
  aux: readonly AuxChainId[] = [],
): (event: RunnerEvent) => void {
  // Keyed on kind and key together, joined by NUL: the runner's events carry both, and a job kind
  // is only unique per key. The separator is spelled as the escape `\0` rather than as the byte —
  // see the note in `chainservice.ts`; a literal NUL in the source aborts the estate-wide
  // `conformance` sweep, which reads every `.ts` file in every checkout as UTF-8 text.
  const byKey = new Map(recurringFor(chains, payoutChains, aux).map((r) => [`${r.kind}\0${r.key}`, r]))
  return (event) => {
    if (event.type !== 'completed') return
    const recurring = event.kind && event.key ? byKey.get(`${event.kind}\0${event.key}`) : undefined
    if (!recurring) return
    void queue
      .enqueue({
        kind: recurring.kind,
        key: recurring.key,
        payload: { chain: recurring.key.slice('chain:'.length) },
        runAt: new Date(Date.now() + recurring.everyMs),
        onConflict: 'earliest',
      })
      .catch((err: unknown) => logger.error('failed to re-arm recurring job', { kind: recurring.kind, err }))
  }
}

export function registerHandlers(runner: JobRunner, deps: JobDeps): JobRunner {
  runner.register<{ chain?: string }>(PRUNE_KIND, async (job, ctx) => {
    const chain = job.payload.chain
    if (typeof chain !== 'string' || !isPoolChainId(chain)) {
      // A payload that cannot be acted on is a permanent fault. Throwing burns the attempt budget
      // and dead-letters it, which is correct — retrying will not make the payload valid.
      throw new Error(`${PRUNE_KIND} requires a payload naming a chain this pool serves`)
    }
    if (ctx.signal.aborted) return
    const pruned = await pruneShares(deps.sql, {
      chain,
      retentionDays: deps.retentionDays,
      limit: PRUNE_BATCH,
    })
    // Logged even at zero. A prune that has quietly stopped deleting anything is indistinguishable
    // from one that has nothing to delete unless the run itself is visible.
    deps.logger.info('pruned shares', { chain, pruned, retentionDays: deps.retentionDays })
  })

  runner.register<{ chain?: string }>(MATURITY_KIND, async (job, ctx) => {
    const chain = job.payload.chain
    // `isMinedChainId`, not `isPoolChainId`: a block can be won on a merge-mined chain and it is
    // asked about on that chain's own node. The prune above stays narrow for the opposite reason —
    // `recurringFor` sets out which kinds divide by block chain and which by share chain.
    if (typeof chain !== 'string' || !isMinedChainId(chain)) {
      throw new Error(`${MATURITY_KIND} requires a payload naming a chain this pool mines`)
    }
    if (ctx.signal.aborted) return
    const rpc = deps.rpcFor(chain)
    if (rpc === null) {
      // A recurring row survives a configuration change that drops a chain from `POOL_CHAINS`.
      // Throwing would dead-letter it and put a permanent red mark on a service that is behaving
      // correctly; there is simply nothing to ask.
      deps.logger.warn('no node client for this chain; skipping the maturity sweep', { chain })
      return
    }
    const sweep = await sweepMaturity({
      sql: deps.sql,
      rpc,
      chain,
      log: (level, message, fields) => deps.logger[level](message, fields),
      onVerdict: (status) => deps.metrics.increment('pool_block_maturity_total', { chain, status }),
    })
    // Logged even when it did nothing, for the same reason the prune is: a sweep that has quietly
    // stopped looking at anything is indistinguishable from one with nothing to look at unless the
    // run itself is visible.
    deps.logger.info('checked block maturity', { chain, ...sweep })
  })

  /*
   * The producer and its retry, registered only when a sink resolver was supplied, which is only
   * when an operator configured a payout minimum. On a deployment with payouts off neither kind is
   * seeded and neither is registered, so a row that somehow existed would sit unclaimed rather than
   * dead-letter — and that is the right way round: a queue row is not a reason for a pool that has
   * been told not to pay anybody to pay them.
   */
  const sinkFor = deps.payoutSinkFor
  if (sinkFor) {
    runner.register<{ chain?: string }>(CREDIT_KIND, async (job, ctx) => {
      const chain = job.payload.chain
      if (typeof chain !== 'string' || !isMinedChainId(chain)) {
        throw new Error(`${CREDIT_KIND} requires a payload naming a chain this pool mines`)
      }
      if (ctx.signal.aborted) return
      const sink = sinkFor(chain)
      if (sink === null) {
        deps.logger.warn('no payout sink for this chain; skipping the block credit sweep', { chain })
        return
      }
      const sweep = await creditMaturedBlocks({
        sql: deps.sql,
        sink,
        chain,
        network: deps.network,
        // Read from the chain table rather than passed in, for the reason `chains.ts` gives about
        // every number that exists in `contracts-chain`: a second copy of "ltc means LTC" is a
        // second thing that can be wrong, and this one would credit a miner in the wrong asset.
        // The BLOCK's chain, which for a merge-mined block is the aux one — a miner who found a
        // Dogecoin block is owed DOGE, whatever the shares that won it were hashed for.
        asset: minedAssetFor(chain),
        feeBasisPoints: deps.feeBasisPoints,
        log: (level, message, fields) => deps.logger[level](message, fields),
        onOutcome: (outcome) => deps.metrics.increment('pool_payout_claim_total', { chain, outcome }),
      })
      // Logged even when it did nothing, like the two sweeps above, and for the same reason: a job
      // that has quietly stopped allocating is indistinguishable from one with nothing to allocate
      // unless the run itself is visible.
      deps.logger.info('credited matured blocks', { chain, ...sweep })
    })

    runner.register<{ chain?: string }>(PAYOUT_FLUSH_KIND, async (job, ctx) => {
      const chain = job.payload.chain
      if (typeof chain !== 'string' || !isMinedChainId(chain)) {
        throw new Error(`${PAYOUT_FLUSH_KIND} requires a payload naming a chain this pool mines`)
      }
      if (ctx.signal.aborted) return
      const sink = sinkFor(chain)
      if (sink === null) {
        // Same shape as the maturity sweep's null-rpc branch: a recurring row survives a
        // configuration change that turns payouts off for this chain, and dead-lettering it would
        // put a permanent red mark on a service doing exactly what it was told.
        deps.logger.warn('no payout sink for this chain; skipping the flush', { chain })
        return
      }
      const posted = await sink.flushPending(chain, PAYOUT_FLUSH_BATCH)
      // Logged even at zero, and zero is the expected number: a claim reaches this job only when the
      // ledger posting that should have followed it never landed. A run that has quietly stopped
      // draining is indistinguishable from one with nothing to drain unless the run is visible.
      deps.logger.info('flushed pending payouts', { chain, posted })
    })
  }

  return runner
}
