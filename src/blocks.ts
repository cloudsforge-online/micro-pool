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
 *
 * ## Two chains can win from one share
 *
 * `submitFoundAuxBlock` at the bottom is the merged-mining counterpart, and it is a second function
 * rather than a branch inside the first because almost nothing is shared: a different proof format,
 * a different node, a different reward asset, and a window whose shares belong to a chain the block
 * is not on. What it does keep is the order — submit, then flush, then snapshot — because that order
 * is about racing the rest of the network and merged mining does not change the race.
 *
 * The two run independently and both may run for the same share. A Litecoin block that also meets
 * Dogecoin's target is one submission to each node, neither waiting on the other, and either can be
 * accepted while the other is refused.
 */

import { coinbaseScriptSig, serialiseBlock, witnessSerialisedCoinbase } from './coinbase.ts'
import { commitmentOffset, magicOccurrences, parentBlockHashOf, serialiseAuxPow } from './auxpow.ts'
import { hashToDisplay } from './bytes.ts'
import { networkDifficultyOf } from './pow.ts'
import { difficultyUnits, windowUnitsFor } from './pplns.ts'
import { NodeRpcError } from './rpc.ts'
import { latestShareId, pplnsWindow, recordBlock, upsertWorker, type Exec } from './store.ts'
import type { FoundAuxBlock, FoundBlock } from './session.ts'
import type { NodeRpc } from './rpc.ts'
import type { AuxChainId, PoolChainId, PowAlgorithm } from './chains.ts'

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
 *
 * **MWEB changes nothing about the coinbase**, which was checked rather than assumed: a regtest
 * block mined by Litecoin Core 0.21.5.6 on 2026-08-09 carries a coinbase whose only witness-related
 * bytes are the same `default_witness_commitment` output and the same 32 zero bytes of witness
 * reserved value as a Bitcoin block, with no MWEB flag on the transaction at all. MWEB's own
 * commitment — the extension block header's hash — lives in the HogEx's witness-version-8 output,
 * which arrives inside transaction data this function passes through untouched.
 *
 * What MWEB does change is the tail: the extension block goes after the transactions, and only
 * behind a HogEx. The order is asserted here rather than trusted, because `template.transactions` is
 * "as the node gave them" and a silently reordered list would produce a block whose extension block
 * the node never even looks for.
 */
export function serialiseFoundBlock(found: FoundBlock): string {
  const template = found.job.template
  const coinbase =
    template.witnessCommitmentHex === null ? found.coinbase : witnessSerialisedCoinbase(found.coinbase)
  if (template.mwebHex !== null && template.transactions[template.transactions.length - 1]?.isHogEx !== true) {
    throw new Error(
      'the MWEB integrating transaction is not the last transaction of this block. Litecoin reads the ' +
        'extension block off the wire only behind a final HogEx, so this block would not deserialise.',
    )
  }
  return serialiseBlock({
    header: found.header,
    coinbase,
    transactionsHex: template.transactions.map((tx) => tx.data),
    mwebHex: template.mwebHex,
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
    // A solo-mined block's work is its own chain's. `submitFoundAuxBlock` is the other case.
    shareChain: deps.chain,
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

export interface AuxBlockSubmissionDeps {
  readonly sql: Exec
  /**
   * The **aux** chain's node — dogecoind. Not the node that issued the parent template.
   *
   * `submitauxblock` only exists on the aux chain, and the hash it takes is one that chain's own
   * `createauxblock` handed out. Passing the parent's rpc here would produce a method-not-found on
   * Litecoin, which is at least loud; passing the parent's rpc to a *second* Litecoin-family node
   * that happened to implement it would not be, so the field is named for the chain and not for
   * "the rpc".
   */
  readonly rpc: NodeRpc
  readonly chain: AuxChainId
  /** The chain the work was done on, whose shares pay for this block. */
  readonly parent: PoolChainId
  /**
   * The **parent's** algorithm. Both chains here are scrypt and both take difficulty 1 from the same
   * `0x1e0ffff0`, so the two readings coincide today; the parent's is the one named because the
   * quantity being converted is how much of the miners' work this block represents, and the miners
   * were hashing the parent's header.
   */
  readonly algorithm: PowAlgorithm
  readonly pplnsMultiplier: number
  readonly flushShares: () => Promise<void>
  readonly log: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void
}

export interface AuxBlockSubmissionResult {
  readonly hash: string
  readonly height: number
  readonly accepted: boolean
  readonly detail: string | null
}

/**
 * `RPC_INVALID_PARAMETER`. Dogecoin 1.14.9's `AuxMiningSubmitBlock` throws it with the message
 * `block hash unknown` when the hash is not in `mapNewBlock` — which is the ordinary outcome of the
 * aux tip moving between the job being built and the share landing, not a fault.
 *
 * Read from `src/rpc/auxpow_miner.cpp` at tag v1.14.9 rather than measured: the estate's dogecoind is
 * still in initial block download (`blocks 5015467 / headers 5900907` on 2026-08-09), and in that
 * state `submitauxblock` answers -10 `Dogecoin is downloading blocks...` to *every* call before it
 * ever looks the hash up — which is what a probe with a made-up hash returned on that date. So the
 * -8 branch below is unexercised against a live node until the node finishes syncing, and the -10
 * branch is the one that has been seen.
 */
const RPC_INVALID_PARAMETER = -8

/**
 * A Dogecoin block, found by a Litecoin share, submitted to Dogecoin.
 *
 * The shape follows `submitFoundBlock` deliberately — submit first, bookkeep after — because the
 * reasoning at the top of this file is about a race with the rest of the network and merged mining
 * does not change it. What differs is only what the two chains are:
 *
 *   - the proof is a `CAuxPow` rather than a block, because Dogecoin already holds the block it
 *     built and is being handed the evidence that somebody solved it;
 *   - the window is over the **parent's** shares, at the **aux** chain's difficulty;
 *   - the worker row is the parent's, because that is the row the shares in the window point at.
 *
 * ## The commitment is re-derived here, and a disagreement does NOT stop the submission
 *
 * `auxpow.ts` asks for a pre-submission check that reads the offset back out of the bytes actually
 * being submitted, and this is it. What it is for is naming the fault *before* the node answers:
 * `submitauxblock` returns a bare `false` on rejection — the help text on the running node
 * (2026-08-09) says "whether the submitted block was correct" and that is the entire diagnostic — so
 * without this check a lost block leaves nothing behind but a boolean.
 *
 * It does not abort. A check that could veto a submission is a check that can throw away a real
 * block whenever it is the check that is wrong, and Dogecoin is the authority on its own consensus
 * rule; the cost of asking it anyway is one RPC call. So the finding is logged, carried into
 * `submit_detail` beside the node's own verdict, and the block is offered regardless.
 */
export async function submitFoundAuxBlock(
  deps: AuxBlockSubmissionDeps,
  found: FoundAuxBlock,
): Promise<AuxBlockSubmissionResult> {
  const block = found.block
  const hash = block.hashHex
  const height = block.height
  const parentHash = parentBlockHashOf(found.header)

  deps.log('info', 'submitting a merge-mined block', {
    chain: deps.chain,
    parent: deps.parent,
    height,
    hash,
    parentHash,
    account: found.account,
  })

  let complaint: string | null = null
  try {
    const scriptSig = coinbaseScriptSig(found.coinbase)
    const occurrences = magicOccurrences(scriptSig)
    const offset = commitmentOffset(scriptSig, hash)
    if (occurrences !== 1 || offset === -1) {
      complaint =
        `the coinbase being submitted carries the merged-mining magic ${occurrences} times and ` +
        `${offset === -1 ? 'does not carry' : `carries at byte ${offset}`} the commitment to ${hash}`
      deps.log('error', 'the merged-mining proof disagrees with the coinbase it was built from', {
        chain: deps.chain,
        height,
        hash,
        occurrences,
        offset,
      })
    }
  } catch (err) {
    // `coinbaseScriptSig` refuses bytes it cannot read. That is a fact worth recording and still not
    // a reason to withhold the proof, for the reason above.
    complaint = `the coinbase could not be parsed to check the commitment: ${String(err)}`
    deps.log('error', 'the coinbase of a merge-mined block could not be parsed', { chain: deps.chain, hash })
  }

  const auxpow = serialiseAuxPow({
    parentCoinbase: found.coinbase,
    parentHeader: found.header,
    merkleSteps: found.job.merkleSteps,
  }).toString('hex')

  let accepted = false
  let detail: string | null = complaint
  try {
    // Answers a bare boolean, per the running node's own help text on 2026-08-09: "whether the
    // submitted block was correct". Unlike `submitblock` there is no reason string to inspect, so a
    // `false` here is the whole of what the node will ever say about it.
    const reply = await deps.rpc.call<boolean>('submitauxblock', [hash, auxpow], {
      retryable: true,
      deadlineMs: 30_000,
    })
    accepted = reply === true
    if (!accepted) detail = join(detail, `the node answered ${JSON.stringify(reply)}`)
  } catch (err) {
    if (err instanceof NodeRpcError && err.code === RPC_INVALID_PARAMETER) {
      // The aux tip moved. `mapNewBlock` was cleared and this hash is no longer submittable — the
      // block was never ours to lose, and the parent share it came with was credited regardless.
      detail = join(detail, err.message)
      deps.log('warn', 'the aux node no longer holds this block; its tip moved first', {
        chain: deps.chain,
        height,
        hash,
        detail,
      })
    } else {
      detail = join(detail, err instanceof NodeRpcError ? err.message : String(err))
    }
  }

  if (accepted) {
    deps.log('info', 'the aux node accepted a merge-mined block', {
      chain: deps.chain,
      height,
      hash,
      parentHash,
      detail,
    })
  } else {
    deps.log('error', 'the aux node REJECTED a merge-mined block', {
      chain: deps.chain,
      height,
      hash,
      parentHash,
      detail,
    })
  }

  await deps.flushShares()

  // The parent's worker row, on purpose. The shares in the window below are the parent's shares and
  // they reference this row; an aux-chain worker row would be a second identity for the same person,
  // pointed at by nothing, and `windowShares` would join the block to none of its own miners.
  const workerId = await upsertWorker(deps.sql, {
    chain: deps.parent,
    account: found.account,
    worker: found.worker,
  })

  // The aux chain's difficulty over the parent chain's shares. That pairing looks wrong at a glance
  // and is the only correct one: the window has to be as long as the work the block took, the work
  // the block took is what the *aux* target demanded, and the shares that did it are all on the
  // parent. Sizing the window by the parent's difficulty instead would pay out a Dogecoin block over
  // a Litecoin-sized window, which is a different set of miners whenever the two chains' difficulties
  // are not in step — and they never are.
  const networkDifficulty = networkDifficultyOf(deps.algorithm, block.target)
  const endShareId = await latestShareId(deps.sql, deps.parent)
  const window =
    endShareId === null
      ? { firstShareId: null, lastShareId: null }
      : await pplnsWindow(deps.sql, {
          chain: deps.parent,
          endShareId,
          windowUnits: windowUnitsFor(networkDifficulty, deps.pplnsMultiplier),
        })

  await recordBlock(deps.sql, {
    chain: deps.chain,
    shareChain: deps.parent,
    height,
    hash,
    foundByWorkerId: workerId,
    networkDifficultyUnits: difficultyUnits(networkDifficulty),
    reward: block.coinbaseValue,
    submitStatus: accepted ? 'accepted' : 'rejected',
    submitDetail: detail,
    windowFirstShareId: window.firstShareId,
    windowLastShareId: window.lastShareId,
  })

  return { hash, height, accepted, detail }
}

/** Both halves of a rejection, when there are two: what we noticed, and what the node said. */
function join(first: string | null, second: string): string {
  return first === null ? second : `${first}; ${second}`
}
