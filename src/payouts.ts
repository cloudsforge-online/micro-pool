/**
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * **PAYOUTS ARE NOT IMPLEMENTED. THIS FILE IMPLEMENTS NOTHING. IT RESERVES A SHAPE.**
 *
 * Nothing in this repository credits a ledger, moves an asset, or pays a miner. What exists today
 * is the accounting that decides what a miner is *owed*: `pplns.ts` allocates a block reward across
 * a window of shares, and `store.ts` records the shares and the blocks. The step from "owed" to
 * "paid" — a ledger entry, a wallet balance, an on-chain send — is a separate change and it has not
 * been made.
 *
 * This is stated at the top of the README as well, and in the pull request that introduced this
 * service, because a mining pool that appears to pay and does not is the worst possible thing for
 * this estate to ship. §6 of `docs/ecosystem/36-multi-chain-and-mining-pool.md`: "A pool holds other
 * people's expected revenue."
 *
 * ── WHY THIS FILE EXISTS AT ALL, IF IT DOES NOTHING ─────────────────────────────────────────────
 *
 * To fix the idempotency key before somebody invents a second one.
 *
 * `wallet/src/deposits.ts` established the estate's shape for crediting a ledger from an external
 * event, and the whole of its safety comes from ONE key doing two jobs: it is the unique constraint
 * on the local row AND the `idempotencyKey` sent to the ledger, "so the two services cannot
 * disagree about whether this movement has been credited". A payout implementation that dedupes
 * locally on one key and calls the ledger with another is a payout implementation that pays twice
 * the first time a response is lost — and a lost response on a call that actually succeeded is the
 * ordinary case, not an exotic one.
 *
 * So `poolPayoutCreditKey` is written now, tested now, and is the only key the eventual
 * implementation may use.
 *
 * ── WHAT IS DELIBERATELY ABSENT ─────────────────────────────────────────────────────────────────
 *
 *   - There is no `pool_payout_credits` table. `migrations.ts` says why: an empty table with a
 *     unique constraint on `credit_key` would read as a feature that exists and is not firing.
 *   - There is no default implementation of `PayoutSink`, not even one that logs. A no-op that logs
 *     "would credit 0.03 LTC to …" is a line an operator will eventually read as a payment.
 *   - Nothing constructs a `PayoutSink`. `index.ts` does not hold one and no route returns one.
 *
 * ── WHAT THE IMPLEMENTATION WILL HAVE TO DECIDE, WHICH THIS FILE CANNOT ─────────────────────────
 *
 * All four are open in 36 §7 and none of them is a technical question:
 *
 *   1. The pool fee (§7.1). Already surfaced: `POOL_FEE_BASIS_POINTS` is required with no default,
 *      so the estate cannot ship a fee by accident.
 *   2. Which asset a miner is paid in (§7.2) — the coin they mined, or EMBER.
 *   3. The minimum payout, and what happens to a balance below it.
 *   4. Coinbase maturity. A block reward is unspendable for 100 blocks on both chains, and a block
 *      can be orphaned in that time. `pool_blocks.submit_status` records what the node said at
 *      submission; **nothing yet re-checks whether the block survived**, and paying a reward that
 *      was later orphaned is paying money that does not exist.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */

import type { AssetCode, Network } from '@cloudsforge/contracts-chain'
import type { PoolChainId } from './chains.ts'

/**
 * The identity of one payout credit: `(chain, network, blockHash, workerId)`.
 *
 * Shaped exactly like `depositCreditKey` in `wallet/src/deposits.ts` — a `service:kind:` prefix and
 * then the tuple that makes the movement unique — so that the two are recognisably the same
 * mechanism when read side by side in a ledger's `idempotency_keys` table.
 *
 * The tuple is what it is for a reason on each field:
 *
 *   - **The block hash, not the block height.** Two blocks can share a height; only one of them
 *     survives, and a key built on height would collide across a reorg and suppress the credit for
 *     the block that actually won.
 *   - **The worker id, not the account.** A block reward is split across every worker in the PPLNS
 *     window, and each split is its own movement with its own credit.
 *   - **Lowercased hash**, as `depositCreditKey` lowercases its transaction hash, because a hash
 *     that arrives from two sources in two cases must not become two keys.
 *
 * There is deliberately no timestamp, no attempt counter and no random component. Every one of those
 * would make the key unique per call rather than per movement, which is the exact failure it exists
 * to prevent.
 */
export function poolPayoutCreditKey(
  chain: PoolChainId,
  network: Network,
  blockHash: string,
  workerId: number,
): string {
  return `pool:payout:${chain}:${network}:${blockHash.toLowerCase()}:${workerId}`
}

/** One miner's share of one block, as the accounting computed it. Not a payment. */
export interface PayoutClaim {
  readonly chain: PoolChainId
  readonly network: Network
  readonly blockHash: string
  readonly blockHeight: number
  readonly workerId: number
  readonly account: string
  /** What the miner is owed for this block, in the smallest unit of `asset`. */
  readonly amount: bigint
  readonly asset: AssetCode
  /** The PPLNS weight this claim was derived from, for the miner to check the arithmetic against. */
  readonly units: bigint
  readonly creditKey: string
}

/**
 * The seam.
 *
 * When payouts are implemented, the thing that credits the ledger implements this interface and
 * nothing else in this repository changes shape. It is one method because there is one operation,
 * and it takes the claim whole because a caller that could pass an amount without the key it was
 * derived from is a caller that can pass a mismatched pair.
 */
export interface PayoutSink {
  /**
   * Credit one claim, at most once, ever.
   *
   * The implementation MUST use `claim.creditKey` both as its local unique constraint and as the
   * `idempotencyKey` it sends to the ledger. Returning normally must mean the credit is durable —
   * an implementation that returns before the ledger has answered has moved the at-most-once
   * guarantee somewhere nobody can see it.
   */
  credit(claim: PayoutClaim): Promise<void>
}

/**
 * Raised if anything ever reaches a payout path. Nothing does today.
 *
 * It exists so that a future partial implementation has something honest to throw from a branch it
 * has not finished, rather than the two alternatives that are always reached for instead: returning
 * silently, or logging and continuing. Both of those produce a pool that says it paid.
 */
export class PayoutsNotImplementedError extends Error {
  constructor(detail: string) {
    super(
      `payouts are not implemented in micro-pool: ${detail}. ` +
        'Shares are recorded and PPLNS allocation is computed, but nothing credits a ledger. ' +
        'See src/payouts.ts.',
    )
    this.name = 'PayoutsNotImplementedError'
  }
}
