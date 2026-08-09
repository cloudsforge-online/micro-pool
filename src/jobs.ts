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
import { pruneShares, type Exec } from './store.ts'
import { sweepMaturity } from './maturity.ts'
import { isPoolChainId, type PoolChainId } from './chains.ts'
import type { NodeRpc } from './rpc.ts'

export const PRUNE_KIND = 'pool.prune-shares'

/**
 * The watcher micro-org#302 is about. Re-reads every block this pool recorded and still cannot
 * account for, and marks it matured or orphaned. `maturity.ts` holds the reasoning; this is only
 * where it is scheduled.
 */
export const MATURITY_KIND = 'pool.check-maturity'

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

export interface JobDeps {
  readonly sql: Exec
  readonly logger: Logger
  readonly metrics: Metrics
  readonly chains: readonly PoolChainId[]
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
  readonly rpcFor: (chain: PoolChainId) => NodeRpc | null
}

/** The recurring set for a given chain list. One row per chain per kind, seeded at boot. */
export function recurringFor(chains: readonly PoolChainId[]): ReadonlyArray<{ kind: string; key: string; everyMs: number }> {
  return chains.flatMap((chain) => [
    { kind: PRUNE_KIND, key: `chain:${chain}`, everyMs: PRUNE_EVERY_MS },
    { kind: MATURITY_KIND, key: `chain:${chain}`, everyMs: MATURITY_EVERY_MS },
  ])
}

/** Enqueue the recurring set at boot. `keep` means N replicas booting together produce one row. */
export async function seedRecurring(queue: JobQueue, chains: readonly PoolChainId[]): Promise<void> {
  for (const job of recurringFor(chains)) {
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
): (event: RunnerEvent) => void {
  // Keyed on kind and key together, joined by NUL: the runner's events carry both, and a job kind
  // is only unique per key. The separator is spelled as the escape `\0` rather than as the byte —
  // see the note in `chainservice.ts`; a literal NUL in the source aborts the estate-wide
  // `conformance` sweep, which reads every `.ts` file in every checkout as UTF-8 text.
  const byKey = new Map(recurringFor(chains).map((r) => [`${r.kind}\0${r.key}`, r]))
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
    if (typeof chain !== 'string' || !isPoolChainId(chain)) {
      throw new Error(`${MATURITY_KIND} requires a payload naming a chain this pool serves`)
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

  return runner
}
