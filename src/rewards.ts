/**
 * Where a matured block becomes a set of claims — the step that turns "this pool is owed a reward"
 * into "this miner is owed this much of it".
 *
 * ## The defect this closes, which the first half of micro-org#302 left open
 *
 * `maturity.ts` decides whether a block reward exists and `payouts.ts` can credit one miner's share
 * of it, and between those two there was nothing: `store.payableBlocks` had no caller, `PayoutClaim`
 * was never constructed, and `pool.flush-payouts` drained a table nothing wrote to. A pool with both
 * halves and no join is exactly the defect the issue opens with — it "records what a miner is owed
 * and can pay nobody". This file is the join.
 *
 * The walk is deliberately dull, because every interesting decision has already been made somewhere
 * that could be tested without a database:
 *
 *   1. `store.blocksAwaitingCredit` — matured, accepted, not offered yet, oldest first.
 *   2. `store.windowShares` — the shares of the window this block recorded when it was found, summed
 *      per worker. Not recomputed from the current configuration; see that function for why.
 *   3. `pplns.allocateReward` — the fee off the top and the rest by largest remainder.
 *   4. `PayoutSink.credit`, once per worker, keyed by `poolPayoutCreditKey` unchanged.
 *   5. `store.markBlockPayoutsCredited`, so the next sweep does not do it all again.
 *
 * ## THE ARITHMETIC LOSES NOTHING AND INVENTS NOTHING
 *
 * `allocateReward` asserts `Σ allocations + fee = reward` on every call and throws rather than
 * returning a set of numbers that do not add up, and this file adds no arithmetic of its own on top
 * — no scaling, no rounding, no "close enough". Two consequences are worth naming because they are
 * decisions rather than accidents:
 *
 *   - **The fee is floored, so its rounding favours the miners.** `fee = reward × bp / 10000` in
 *     integer division, and the fraction of a unit that division discards stays in `net` and is
 *     distributed. The pool is short at most one unit of the smallest denomination per block —
 *     0.00000001 LTC — and the alternative, rounding the fee up, would take a unit from the miners
 *     that nobody chose to take.
 *   - **The remainder of the split goes to the largest fractional parts, one unit each**, which is
 *     `pplns.ts`'s largest-remainder rule and is where the "must not be dropped" requirement is
 *     actually met. Flooring each worker's share and stopping would vanish up to one unit per worker
 *     per block, which is money that was earned, is owed, and appears nowhere.
 *
 * A worker whose allocation is exactly zero — possible when a window holds far more workers than the
 * reward holds units — is skipped rather than claimed. `pool_payout_credits` carries `amount > 0`,
 * so the alternative is a failed insert, and a zero-value ledger entry would be a movement of no
 * money that a miner would nonetheless see in their history.
 *
 * ## A BLOCK THAT WAS CREDITED AND IS LATER FOUND ORPHANED
 *
 * The question has to be answered rather than left to be discovered, so: **it cannot happen through
 * this service's own sweep, and if it happens anyway nothing here reverses the credit.**
 *
 * It cannot happen through the sweep because `blocksAwaitingMaturity` selects only `pending` rows
 * and `setBlockMaturity` only writes rows that are still `pending`. A block reaches `matured` at 100
 * confirmations, is never re-read after that, and `maturity.ts` states that `orphaned` is terminal
 * in the same one-way spirit. The event that would invalidate a matured block is a reorg deeper than
 * `COINBASE_MATURITY`, which also invalidates the coinbase this pool was paid with, and which on
 * either of these chains is an estate-wide incident rather than a case for a background job.
 *
 * If it did happen, the credits stand. That is a decision, and the reasoning is that the opposite
 * one is worse: a service that can silently take a credited balance back is a service that can do it
 * by accident, and the miner has no way to distinguish that from theft. The correction for a payment
 * that should not have been made is a new, opposite entry in the ledger, posted deliberately by
 * somebody who knows why — the ledger is append-only for exactly this reason (04-domain-model §2) —
 * and this service holds no such vocabulary and is not given one here.
 *
 * ## Both gates still stand in front of every line of this file
 *
 * The job that calls this is scheduled only for chains an operator configured a payout minimum for,
 * which on 2026-08-09 is none of them, and every claim it produces is refused by
 * `CUSTODY_BACKING_CLOSED` before the database or the ledger is touched. That refusal stops the
 * sweep rather than being counted per claim: the interlock is a constant, so the second claim would
 * get the same answer as the first, and a log line per worker would bury the one line that matters.
 */

import type { AssetCode, Network } from '@cloudsforge/contracts-chain'
import { allocateReward } from './pplns.ts'
import { poolPayoutCreditKey, PayoutRefusedError, type PayoutSink } from './payouts.ts'
import {
  blocksAwaitingCredit,
  markBlockPayoutsCredited,
  windowShares,
  type Exec,
} from './store.ts'
import type { PoolChainId } from './chains.ts'

export interface RewardCreditDeps {
  readonly sql: Exec
  readonly sink: PayoutSink
  readonly chain: PoolChainId
  readonly network: Network
  readonly asset: AssetCode
  /** `POOL_FEE_BASIS_POINTS`, required with no default. `pplns.ts` says why there is no default. */
  readonly feeBasisPoints: number
  readonly log: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void
  /** Counts each per-claim outcome. Wired to `pool_payout_claim_total` by the job registration. */
  readonly onOutcome?: (outcome: ClaimOutcome) => void
}

/**
 * What became of one worker's share of one block.
 *
 * `skipped_below_minimum` and `skipped_no_account` are outcomes rather than failures: both are the
 * configured, documented behaviour, and both leave the debt derivable from `pool_shares`. They are
 * counted separately because they mean opposite things to an operator — one says the threshold is
 * set too high for this pool's block reward, the other says most of these miners are external and
 * this service cannot pay them at all.
 */
export type ClaimOutcome = 'credited' | 'skipped_zero' | 'skipped_below_minimum' | 'skipped_no_account'

export interface RewardCreditSweep {
  /** Blocks whose allocation was offered in full and which are now marked. */
  readonly blocks: number
  readonly credited: number
  readonly skippedZero: number
  readonly skippedBelowMinimum: number
  readonly skippedNoAccount: number
  /** True when the sweep stopped early. The block it stopped on is left unmarked and retried. */
  readonly stopped: boolean
}

/**
 * How many matured blocks one sweep will allocate.
 *
 * Small, because it is bounded by reality rather than by caution: a block matures 100 confirmations
 * after it is found, which is about four hours on Litecoin and seventeen on Bitcoin, and this runs
 * every ten minutes. A backlog of more than a handful means the job has not run for days, and in
 * that case draining twenty per run and coming back is better than one run that holds a lease while
 * it posts several hundred ledger entries.
 */
const BLOCK_LIMIT = 20

/**
 * Allocate every matured block on one chain that has not been allocated yet, and offer each worker's
 * share to the sink.
 *
 * Stops early rather than continuing on two kinds of trouble, and leaves the block it stopped on
 * unmarked so the next run picks it up from the top. That is safe to do — and only safe because
 * `credit_key` makes re-offering a claim that was already credited a no-op that never reaches the
 * ledger.
 */
export async function creditMaturedBlocks(deps: RewardCreditDeps): Promise<RewardCreditSweep> {
  const blocks = await blocksAwaitingCredit(deps.sql, { chain: deps.chain, limit: BLOCK_LIMIT })
  let credited = 0
  let skippedZero = 0
  let skippedBelowMinimum = 0
  let skippedNoAccount = 0
  let done = 0

  for (const block of blocks) {
    // A block found before any share was on file — the first block of a pool's life, or one found
    // by a miner whose shares had not flushed. There is nobody in the window, so there is nobody to
    // pay, and the whole reward is the pool's. Marked, so it does not come back every ten minutes.
    const entries =
      block.windowFirstShareId === null || block.windowLastShareId === null
        ? []
        : await windowShares(deps.sql, {
            // The block's OWN `share_chain`, not `deps.chain`. They are the same for every solo-mined
            // block and they differ for every merge-mined one, and reading the sweep's chain here
            // would allocate a Dogecoin block against Dogecoin shares — of which this pool writes
            // none, so the window would come back empty and the finder would be paid nothing with no
            // error anywhere. Migration 7 records the whole argument.
            chain: block.shareChain,
            firstShareId: block.windowFirstShareId,
            lastShareId: block.windowLastShareId,
          })

    const allocation = allocateReward({
      reward: block.reward,
      feeBasisPoints: deps.feeBasisPoints,
      entries: entries.map((entry) => ({ workerId: entry.workerId, units: entry.units })),
    })
    const accounts = new Map(entries.map((entry) => [entry.workerId, entry.account]))

    let stoppedOnThisBlock = false
    for (const share of allocation.allocations) {
      if (share.amount === 0n) {
        skippedZero += 1
        deps.onOutcome?.('skipped_zero')
        continue
      }
      const account = accounts.get(share.workerId)
      if (account === undefined) {
        // `allocateReward` returns exactly the entries it was given, so this is unreachable unless
        // that changes. Throwing rather than skipping: a worker id with no account is an allocation
        // that cannot be attributed, and paying the rest of the block as though it were fine would
        // hide it.
        throw new Error(`allocation names worker ${share.workerId}, which is not in the window`)
      }

      try {
        await deps.sink.credit({
          chain: deps.chain,
          network: deps.network,
          blockHash: block.hash,
          blockHeight: block.height,
          workerId: share.workerId,
          account,
          amount: share.amount,
          asset: deps.asset,
          units: share.units,
          creditKey: poolPayoutCreditKey(deps.chain, deps.network, block.hash, share.workerId),
        })
        credited += 1
        deps.onOutcome?.('credited')
      } catch (err) {
        if (err instanceof PayoutRefusedError && err.reason === 'below_minimum') {
          skippedBelowMinimum += 1
          deps.onOutcome?.('skipped_below_minimum')
          continue
        }
        if (err instanceof PayoutRefusedError && err.reason === 'no_estate_account') {
          // The ordinary case, and by a wide margin: most pool accounts are a payout address typed
          // into somebody's own firmware. Counted rather than logged per worker, because on a pool
          // with a hundred external miners the per-worker line would be the whole log.
          skippedNoAccount += 1
          deps.onOutcome?.('skipped_no_account')
          continue
        }
        stoppedOnThisBlock = true
        if (err instanceof PayoutRefusedError) {
          // `custody_backing_not_confirmed`, which is a constant: every remaining claim in every
          // remaining block would be refused for the same reason, so the sweep stops on the first
          // one. Loud, and once per run — an operator who configured payouts in a release that
          // cannot pay has to find that out from the log rather than from a miner asking.
          deps.log('error', 'THE PAYOUT SINK REFUSED EVERY CLAIM; NOTHING IS BEING PAID', {
            chain: deps.chain,
            blockHash: block.hash,
            reason: err.reason,
            detail: err.message,
          })
        } else {
          // The ledger was unreachable, or the database was. Both are transient and both are
          // survivable exactly here: a claim that was recorded and not posted is `flushPending`'s
          // job, and a claim that was not recorded is re-offered when this block comes back.
          deps.log('error', 'a payout claim failed; leaving the rest of this sweep for later', {
            chain: deps.chain,
            blockHash: block.hash,
            workerId: share.workerId,
            err: String(err),
          })
        }
        break
      }
    }

    if (stoppedOnThisBlock) {
      return {
        blocks: done,
        credited,
        skippedZero,
        skippedBelowMinimum,
        skippedNoAccount,
        stopped: true,
      }
    }

    // Every worker in this block has been offered to the sink exactly once, so the block does not
    // need walking again. Not a receipt that everyone was paid — see `markBlockPayoutsCredited`.
    const marked = await markBlockPayoutsCredited(deps.sql, { chain: deps.chain, hash: block.hash })
    done += 1
    if (marked) {
      deps.log('info', 'allocated a matured block', {
        chain: deps.chain,
        height: block.height,
        hash: block.hash,
        reward: block.reward.toString(),
        fee: allocation.fee.toString(),
        workers: allocation.allocations.length,
      })
    }
  }

  return { blocks: done, credited, skippedZero, skippedBelowMinimum, skippedNoAccount, stopped: false }
}
