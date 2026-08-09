/**
 * Whether a block this pool found is still in the chain, and whether its coinbase is spendable yet.
 *
 * ## The defect this file closes
 *
 * `pool_blocks.submit_status` records what the node said at the moment of submission and nothing
 * re-read it afterwards (micro-org#302). That is not a small gap. A coinbase output is unspendable
 * for 100 blocks on both chains this pool mines, a block can be orphaned well inside that window,
 * and `submitblock` answering `null` tells you the node accepted the block onto ITS tip — not that
 * the tip it was accepted onto is the one that survived. So `accepted` is evidence, not a fact
 * about the chain, and a payout written against it pays out money that does not exist.
 *
 * Nothing about the accounting upstream is wrong: the shares are right, the PPLNS allocation is
 * right, and the block row faithfully records what the node said. The defect is entirely that "the
 * node took it" was treated as "it is in the chain".
 *
 * ## The two questions, asked separately, because one of them can lie by omission
 *
 * `getblock` returns a `confirmations` field, and Core sets it to **-1** for a block it knows about
 * that is not on the active chain — which is exactly the orphan case and is the cheapest possible
 * detection. It is not, on its own, enough: a positive `confirmations` says the block is on the
 * active chain of THIS node, and the second call re-asks the same node which block it currently has
 * at that height. They agree in every ordinary case; where they would not is where this pool would
 * otherwise be at its most confident and most wrong.
 *
 * Both go to the SAME node client the templater uses, deliberately. `rpc.ts` explains why there is
 * one endpoint per chain and no failover: two nodes can disagree about the tip, and a maturity
 * verdict taken from a node other than the one that issued the template and took the submission
 * would be a verdict about a different chain of blocks than the one this pool mined on.
 *
 * ## Why 100 is not `chainSpec().confirmations`
 *
 * `contracts-chain` gives LTC `confirmations: 12` and BTC `6`, and reaching for those here would be
 * the obvious move and wrong by an order of magnitude. Those are the estate's DEPOSIT credit depths
 * — how deep an incoming payment must be before the wallet will credit it — and they are a risk
 * judgement the estate makes. Coinbase maturity is not a judgement at all: it is `COINBASE_MATURITY`
 * in Bitcoin Core's `consensus/consensus.h`, inherited unchanged by Litecoin, and a transaction
 * spending a coinbase output before it is refused by every node on the network. The number lives
 * here because it belongs to the consensus rules of the chain rather than to this estate's policy,
 * and `maturity.test.ts` pins it against being "tidied up" into the pinned package later.
 *
 * ## Everything unknown stays PENDING, and that asymmetry is the whole safety property
 *
 * There are exactly two ways out of `pending` and both require the node to have answered a question
 * positively. A node that is unreachable, a node that has never heard of the hash, a height beyond
 * the node's own tip, an RPC that times out — every one of those leaves the row alone. `pending` is
 * not payable, so an unavailable node delays a payment; the opposite arrangement, where silence
 * decays into `orphaned` or into `matured`, would let a network blip either destroy a miner's credit
 * or manufacture one.
 */

import { NodeRpcError, NodeUnavailableError, type NodeRpc } from './rpc.ts'
import { blocksAwaitingMaturity, setBlockMaturity, type Exec } from './store.ts'
import type { PoolChainId } from './chains.ts'

/**
 * How many confirmations a block needs before its coinbase can be spent.
 *
 * 100 on both chains, and the arithmetic of the comparison is worth writing down once because it is
 * the sort of thing that is silently off by one for ever. Core refuses a spend when
 * `spendHeight - coinbaseHeight < COINBASE_MATURITY`, so a coinbase mined at height H is first
 * spendable in the block at height H+100. For that block to be mined the tip must be at H+99, and
 * `getblock` reports `confirmations = tip - height + 1` — which is 100. So `confirmations >= 100` is
 * exactly "spendable in the next block", with no margin either way.
 *
 * There is deliberately no extra safety margin on top. A margin would be this file inventing a
 * second, private confirmation policy beside the consensus rule, and the number it invented would
 * then be the real one while the consensus rule sat beside it looking authoritative.
 */
export const COINBASE_MATURITY: Readonly<Record<PoolChainId, number>> = Object.freeze({
  btc: 100,
  ltc: 100,
})

/**
 * Where a recorded block stands.
 *
 *   - `pending`  — on the chain but not deep enough yet, or the node could not be asked. NOT payable.
 *   - `matured`  — on the active chain, at or past `COINBASE_MATURITY`. The only payable state.
 *   - `orphaned` — the node knows this block and it is not on the active chain. Terminal.
 *
 * `orphaned` is terminal on purpose. A block that lost a reorg can in principle come back if the
 * reorg is itself reorged out, and modelling that would mean a payout could be revoked — which this
 * pool has no mechanism for and should not grow one for an event that has never happened at depth on
 * either of these chains. Terminal means the worst case is a block that was worth something being
 * treated as worthless, which costs the pool and never costs a miner money they were already given.
 */
export type MaturityStatus = 'pending' | 'matured' | 'orphaned'

export interface MaturityVerdict {
  readonly status: MaturityStatus
  /** As the node reports it: negative for a block off the active chain, null when it could not be asked. */
  readonly confirmations: number | null
  /** Why, in words, for the row and for the log. Null only when there is nothing to add. */
  readonly detail: string | null
}

/** Core's `RPC_INVALID_ADDRESS_OR_KEY`, which is what `getblock` answers for a hash it does not hold. */
const RPC_INVALID_ADDRESS_OR_KEY = -5

/** The subset of `getblock` verbosity-1 this file reads. Everything else is ignored. */
interface BlockHeaderReply {
  readonly hash?: string
  readonly confirmations?: number
  readonly height?: number
}

/**
 * Re-read one recorded block against the node and say where it stands.
 *
 * Separated from the database entirely so the interesting cases — a reorg, a node that has never
 * heard of the hash, a height past the tip — are testable against a fake RPC, and so that
 * `regtest.test.ts` can put the same function to a real litecoind after a real `invalidateblock`.
 *
 * `NodeUnavailableError` propagates rather than becoming a verdict. The caller's response to "the
 * node is not answering" is to leave every row alone and come back later, and folding that into a
 * `pending` verdict here would make an outage indistinguishable from a young block — which matters,
 * because one of those is worth an alert and the other is the normal state of every block for four
 * hours after it is found.
 */
export async function inspectBlock(
  rpc: Pick<NodeRpc, 'call'>,
  args: { readonly chain: PoolChainId; readonly hash: string; readonly height: number },
): Promise<MaturityVerdict> {
  const required = COINBASE_MATURITY[args.chain]

  let block: BlockHeaderReply
  try {
    // Verbosity 1: the header fields and nothing else. Verbosity 0 returns the serialised block,
    // which on a busy Bitcoin block is megabytes over the RPC socket to read one integer, and
    // verbosity 2 additionally expands every transaction.
    block = await rpc.call<BlockHeaderReply>('getblock', [args.hash, 1])
  } catch (err) {
    if (err instanceof NodeRpcError && err.code === RPC_INVALID_ADDRESS_OR_KEY) {
      // The node has no record of this hash at all. That is NOT the orphan signal — an orphaned
      // block stays in the block index and reports -1 — so this is a node that is not the one that
      // took the submission, or one that has been reindexed or restored from a snapshot. Guessing
      // `orphaned` here would destroy a real credit on the strength of a node swap.
      return {
        status: 'pending',
        confirmations: null,
        detail: 'the node has no record of this block hash; not treated as orphaned',
      }
    }
    throw err
  }

  const confirmations = typeof block.confirmations === 'number' ? block.confirmations : null
  if (confirmations === null) {
    return { status: 'pending', confirmations: null, detail: 'the node returned no confirmation count' }
  }
  if (confirmations < 0) {
    // Core's own signal, and the primary one: a block it holds that is not on the active chain.
    return {
      status: 'orphaned',
      confirmations,
      detail: `the node reports this block is not on the active chain (confirmations ${confirmations})`,
    }
  }

  // The second question, to the same node. A block can report a positive confirmation count and
  // still not be the block at its own height only if the node is answering inconsistently, which is
  // precisely the state worth refusing to pay on rather than reasoning about.
  let active: string
  try {
    active = await rpc.call<string>('getblockhash', [args.height])
  } catch (err) {
    if (err instanceof NodeRpcError) {
      // `-8 Block height out of range`: the active chain does not reach this height, so this block
      // is certainly not buried in it. Pending rather than orphaned — a node still catching up after
      // a restart answers exactly this.
      return {
        status: 'pending',
        confirmations,
        detail: `the node has no block at height ${args.height} yet (${err.message})`,
      }
    }
    throw err
  }

  if (active.toLowerCase() !== args.hash.toLowerCase()) {
    return {
      status: 'orphaned',
      confirmations,
      detail: `height ${args.height} on the active chain is ${active}, not this block`,
    }
  }

  if (confirmations >= required) {
    return { status: 'matured', confirmations, detail: null }
  }
  return {
    status: 'pending',
    confirmations,
    detail: `${confirmations} of ${required} confirmations`,
  }
}

export interface MaturityDeps {
  readonly sql: Exec
  readonly rpc: Pick<NodeRpc, 'call'>
  readonly chain: PoolChainId
  readonly log: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void
  /** Counts each verdict. Wired to `pool_block_maturity_total` by the job registration. */
  readonly onVerdict?: (status: MaturityStatus) => void
}

export interface MaturitySweep {
  readonly checked: number
  readonly matured: number
  readonly orphaned: number
  readonly pending: number
}

/**
 * How many blocks one sweep will re-read.
 *
 * A pool that has been running for years has a bounded number of blocks in flight — 100
 * confirmations is about four hours on Litecoin and about seventeen on Bitcoin — so this is far
 * above any real backlog and exists only so a database restored with thousands of pending rows
 * cannot turn one job run into thousands of RPC calls against a node that also has miners to serve.
 */
const SWEEP_LIMIT = 500

/**
 * Re-read every pending block on one chain and record where each one stands.
 *
 * A single unavailable node stops the sweep rather than failing each row in turn: every remaining
 * row would get the same answer, and a hundred timeouts at ten seconds each is a job that outlives
 * its own lease. Rows already visited keep the verdicts they were given, so the next run resumes
 * rather than restarting.
 */
export async function sweepMaturity(deps: MaturityDeps): Promise<MaturitySweep> {
  const candidates = await blocksAwaitingMaturity(deps.sql, { chain: deps.chain, limit: SWEEP_LIMIT })
  let matured = 0
  let orphaned = 0
  let pending = 0
  let checked = 0

  for (const block of candidates) {
    let verdict: MaturityVerdict
    try {
      verdict = await inspectBlock(deps.rpc, { chain: deps.chain, hash: block.hash, height: block.height })
    } catch (err) {
      if (err instanceof NodeUnavailableError) {
        deps.log('warn', 'the node did not answer; leaving the rest of the maturity sweep for later', {
          chain: deps.chain,
          checked,
          remaining: candidates.length - checked,
          err: String(err),
        })
        break
      }
      throw err
    }

    checked += 1
    await setBlockMaturity(deps.sql, {
      chain: deps.chain,
      hash: block.hash,
      status: verdict.status,
      confirmations: verdict.confirmations,
      detail: verdict.detail,
    })
    deps.onVerdict?.(verdict.status)

    if (verdict.status === 'matured') {
      matured += 1
      deps.log('info', 'a block matured', {
        chain: deps.chain,
        height: block.height,
        hash: block.hash,
        confirmations: verdict.confirmations,
      })
    } else if (verdict.status === 'orphaned') {
      orphaned += 1
      // The loudest line this sweep can print. An orphaned block is a block reward this pool
      // recorded and does not have, and it is the one event here that an operator must see without
      // going looking for it.
      deps.log('error', 'A BLOCK THIS POOL FOUND WAS ORPHANED', {
        chain: deps.chain,
        height: block.height,
        hash: block.hash,
        confirmations: verdict.confirmations,
        detail: verdict.detail,
      })
    } else {
      pending += 1
    }
  }

  return { checked, matured, orphaned, pending }
}
