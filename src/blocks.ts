/**
 * What happens in the seconds after a share turns out to be a block.
 *
 * This runs perhaps once a year on a small pool, and everything in it has to work the first time.
 * That shapes every decision here: the order of operations puts the irreversible, time-critical step
 * first and the recoverable, durable steps after it, and nothing that could fail is allowed to sit
 * in front of the submission.
 *
 *   1. **Submit the block.** Immediately, before anything is written anywhere. A block is worth
 *      nothing if another pool announces the same height first, and every millisecond spent on
 *      bookkeeping is a millisecond of that race lost. Nothing is awaited before this.
 *   2. **Flush the buffered shares**, so the winning share and everything before it is on disk.
 *   3. **Snapshot the PPLNS window** and record the block with its bounds. The window is a claim
 *      about which shares were outstanding at this moment; recomputed later against a share table
 *      that has since grown or been pruned, it would name a different set of people.
 *
 * **A rejected block is recorded exactly as carefully as an accepted one.** `submitblock` answering
 * with a reason string is the single most important diagnostic this service can ever produce — it is
 * the only evidence that would distinguish a coinbase built wrongly from bad luck, and a pool that
 * logs it and moves on has thrown away the one observation that matters.
 *
 * Payouts do not happen here. See `payouts.ts`: the reward is recorded and the window is snapshotted,
 * and nothing credits anybody.
 */

import { serialiseBlock, witnessSerialisedCoinbase } from './coinbase.ts'
import { hashToDisplay } from './bytes.ts'
import { networkDifficultyOf } from './pow.ts'
import { difficultyUnits, windowUnitsFor } from './pplns.ts'
import { NodeRpcError } from './rpc.ts'
import { latestShareId, pplnsWindow, recordBlock, upsertWorker, type Exec } from './store.ts'
import type { FoundBlock } from './session.ts'
import type { NodeRpc } from './rpc.ts'
import type { PoolChainId, PowAlgorithm } from './chains.ts'

export interface BlockSubmissionDeps {
  readonly sql: Exec
  readonly rpc: NodeRpc
  readonly chain: PoolChainId
  readonly algorithm: PowAlgorithm
  readonly pplnsMultiplier: number
  /** Writes any buffered shares. Awaited before the window is snapshotted, never before the submit. */
  readonly flushShares: () => Promise<void>
  readonly log: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void
}

export interface BlockSubmissionResult {
  readonly hash: string
  readonly height: number
  readonly accepted: boolean
  readonly detail: string | null
}

/**
 * The hex of the complete block, ready for `submitblock`.
 *
 * The coinbase is re-serialised with its witness ONLY when the template carried a witness
 * commitment. A block with the commitment output but no witness stack is rejected by the node, and a
 * block with a witness stack but no commitment output is rejected too — the two are one decision, so
 * they are made in one place from one condition.
 */
export function serialiseFoundBlock(found: FoundBlock): string {
  const template = found.job.template
  const coinbase =
    template.witnessCommitmentHex === null ? found.coinbase : witnessSerialisedCoinbase(found.coinbase)
  return serialiseBlock({
    header: found.header,
    coinbase,
    transactionsHex: template.transactions.map((tx) => tx.data),
  }).toString('hex')
}

export async function submitFoundBlock(
  deps: BlockSubmissionDeps,
  found: FoundBlock,
): Promise<BlockSubmissionResult> {
  const template = found.job.template
  const hash = hashToDisplay(found.headerHash)
  const height = found.job.height

  deps.log('info', 'submitting a block', { chain: deps.chain, height, hash, account: found.account })

  let accepted = false
  let detail: string | null = null
  try {
    // `submitblock` answers null on acceptance and a short reason string on rejection. It is not an
    // RPC error either way, so the reply has to be inspected rather than merely awaited — a caller
    // that only catches exceptions here believes every block it ever submitted was accepted.
    const reply = await deps.rpc.call<string | null>('submitblock', [serialiseFoundBlock(found)], {
      retryable: true,
      deadlineMs: 30_000,
    })
    if (reply === null || reply === undefined || reply === '') {
      accepted = true
    } else if (reply === 'duplicate' || reply === 'duplicate-inconclusive') {
      // The node already has it: a retried submission, or another replica of this service got there
      // first. Not a failure — the block exists.
      accepted = true
      detail = reply
    } else {
      detail = reply
    }
  } catch (err) {
    detail = err instanceof NodeRpcError ? err.message : String(err)
  }

  if (accepted) {
    deps.log('info', 'the node accepted a block', { chain: deps.chain, height, hash, detail })
  } else {
    deps.log('error', 'the node REJECTED a block', { chain: deps.chain, height, hash, detail })
  }

  // Now, and only now, the bookkeeping. Everything below is durable and none of it is a race.
  await deps.flushShares()

  const workerId = await upsertWorker(deps.sql, {
    chain: deps.chain,
    account: found.account,
    worker: found.worker,
  })

  const networkDifficulty = networkDifficultyOf(deps.algorithm, template.blockTarget)
  const endShareId = await latestShareId(deps.sql, deps.chain)
  const window =
    endShareId === null
      ? { firstShareId: null, lastShareId: null }
      : await pplnsWindow(deps.sql, {
          chain: deps.chain,
          endShareId,
          windowUnits: windowUnitsFor(networkDifficulty, deps.pplnsMultiplier),
        })

  await recordBlock(deps.sql, {
    chain: deps.chain,
    height,
    hash,
    foundByWorkerId: workerId,
    networkDifficultyUnits: difficultyUnits(networkDifficulty),
    reward: template.coinbaseValue,
    submitStatus: accepted ? 'accepted' : 'rejected',
    submitDetail: detail,
    windowFirstShareId: window.firstShareId,
    windowLastShareId: window.lastShareId,
  })

  return { hash, height, accepted, detail }
}
