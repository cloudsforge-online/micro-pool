/**
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * **PAYOUTS ARE OFF. THIS FILE NOW CONTAINS A REAL SINK, AND TWO INDEPENDENT GATES REFUSE IT.**
 *
 * Nothing in this estate is credited by this service today. What exists is the accounting that
 * decides what a miner is *owed* — `pplns.ts` allocates a block reward across a window of shares,
 * `maturity.ts` decides whether that reward exists at all, `rewards.ts` walks the matured blocks and
 * offers each worker's share, and `store.ts` records all of it — plus, as of micro-org#302, a
 * `LedgerPayoutSink` at the bottom of this file that would credit micro-ledger if it were reached.
 *
 * It is not reached, for two separate reasons that fail in two separate ways:
 *
 *   1. **Nothing constructs it.** `index.ts` builds a sink only when the payout configuration block
 *      is set — `POOL_<CHAIN>_MINIMUM_PAYOUT` and the ledger's URL and token, all with no defaults —
 *      and none of it is set on the estate. Unset means no sink, no `pool.credit-blocks` job, no
 *      `pool.flush-payouts` job, and `payoutsImplemented` false in every response. `env.ts` explains
 *      at the read site why the block is opt-in rather than required.
 *   2. **`CUSTODY_BACKING_CLOSED` is false**, so even a fully configured deployment refuses every
 *      claim. That constant carries the long version: crediting a miner creates a liability the
 *      estate must back, micro-ledger's reconciliation sweep cannot see the coin behind it, and the
 *      result would be a frozen asset estate-wide rather than a payment.
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
 * ── WHAT IS STILL DELIBERATELY ABSENT ───────────────────────────────────────────────────────────
 *
 *   - There is no DEFAULT implementation of `PayoutSink`, and in particular not a no-op that logs.
 *     A line reading "would credit 0.03 LTC to …" is a line an operator will eventually read as a
 *     payment. The only implementation is the real one, and it refuses.
 *   - There is no on-chain send anywhere in this repository. A miner with no estate account cannot
 *     be paid by this service at all, and the sink says so by name rather than crediting a
 *     liability owed to a string.
 *   - There is no outbox and no `@cloudsforge/contracts-events` dependency. The first event this
 *     service would emit is the payout, and it does not happen.
 *
 * ── WHAT THE IMPLEMENTATION STILL HAS TO DECIDE, WHICH THIS FILE CANNOT ─────────────────────────
 *
 * Open in 36 §7, and none of them is a technical question:
 *
 *   1. What the pool fee actually is (§7.1). `POOL_FEE_BASIS_POINTS` is required with no default so
 *      the estate cannot ship one by accident, and `rewards.ts` now takes it off the top of every
 *      allocation — but the number itself is still a product decision nobody has made. What the
 *      fee IS is answered; what it should BE is not.
 *   2. Which asset a miner is paid in (§7.2) — the coin they mined, or EMBER. The sink credits the
 *      coin, which is the only choice that needs no price.
 *   3. What happens to a balance below the minimum payout. `POOL_<CHAIN>_MINIMUM_PAYOUT` is a
 *      per-claim floor and nothing accumulates across blocks; the claim below it writes nothing at
 *      all, so the debt stays derivable from `pool_shares`. Accrual is a per-worker balance this
 *      service must not keep — 04 §11 — and is open.
 *   4. Whether an external miner — the overwhelming majority, who gave an address and never an
 *      estate account — is paid at all, and by what. `rewards.ts` counts them as
 *      `skipped_no_account` and pays them nothing.
 *
 * ── WHAT IS NO LONGER OPEN ──────────────────────────────────────────────────────────────────────
 *
 * Coinbase maturity, which was item 4 here through four releases. `maturity.ts` re-reads every
 * recorded block against the node and `store.payableBlocks` is the single definition of a reward
 * that exists. Nothing pays on `submit_status` any more, because nothing pays at all — but when it
 * does, the question is answered.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */

import type { AssetCode, Network } from '@cloudsforge/contracts-chain'
import type { Actor } from '@cloudsforge/contracts-money'
import type { PoolChainId } from './chains.ts'
import type { LedgerClient } from './ledgerclient.ts'
import {
  claimPayoutCredit,
  markPayoutCredited,
  pendingPayoutCredits,
  userForAccount,
  type Exec,
} from './store.ts'

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

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE SINK, AND THE INTERLOCK THAT STOPS IT
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * **Is the pool's payout address backed in the way the ledger's reconciliation sweep requires?**
 *
 * `false`, and until it is `true` no claim is credited. This is not a feature flag and it is not
 * configurable — it is a constant in the source, so that turning it on is a code change somebody
 * reviews rather than an environment variable somebody sets at three in the morning.
 *
 * ── WHAT THE PAYOUT PATH IS DEPENDING ON BEING TRUE, AND IS NOT ────────────────────────────────
 *
 * Crediting a miner in the ledger creates a LIABILITY the estate must back with a matching custody
 * ASSET. micro-ledger's reconciliation sweep (`ledger/src/reconcile.ts`, `reconcileAsset`) checks
 * exactly that, every fifteen minutes, by comparing:
 *
 *   - the ledger's own custody total — the sum of balances on accounts with `subject = 'custody'`
 *     and `type = 'asset'`, with **no filter of any kind**; against
 *   - the indexer's observation of the addresses it has been told to watch, via
 *     `GET /v1/custody/:chain/:network/total`.
 *
 * Drift is ledger minus observed. Beyond tolerance it writes `asset_freezes` and **freezes the
 * asset estate-wide**, and only an exactly-clean run deletes that row — so a structural mismatch
 * does not heal, it re-freezes for ever. LTC's tolerance is ZERO (`ledger/src/env.ts` states in
 * terms that a one-satoshi Litecoin drift freezes LTC withdrawals) and `LEDGER_RECONCILE_ASSETS`
 * on the estate is `SHARD,EMBER,LTC`.
 *
 * The pool's coinbase pays into a custody-held address minted under custody purpose `pool`. Read on
 * 2026-08-09, against the running estate and the current source of all three services:
 *
 *   1. **Nothing registers that address with the indexer.** Registration is push-only —
 *      `POST /v1/watch/:chain/:network/:address` with a free-text label — and the only two writers
 *      in the estate are `wallet/src/deposits.ts` (`deposit:<userId>`) and
 *      `settlement/src/treasury.ts` (`treasury:<chain>:<network>`). The pool writes nothing.
 *   2. **Even if it did, the indexer would not count it.** `custodyAddresses` selects by label
 *      prefix from `INDEXER_CUSTODY_LABEL_PREFIXES`, whose value on the estate is
 *      `"deposit:,treasury:"`. No `pool:` prefix exists anywhere.
 *
 * So a payout credit would raise the LEDGER's custody total while the OBSERVED total did not move.
 * Positive drift, zero tolerance, LTC in the reconciled set: **every LTC withdrawal in the estate
 * freezes, and stays frozen.** Worse than the outage, the freeze would read as a custody shortfall
 * — the ledger claiming to hold coin the indexer cannot see — which is the shape of theft rather
 * than of a missing config line.
 *
 * This is micro-org#247/#248 with the sign reversed. On 2026-08-05 settlement registered an EMBER
 * treasury under a label the `treasury:` prefix already matched, so 24.1 EMBER appeared on the
 * OBSERVED side with no ledger account behind it; the resulting drift froze EMBER withdrawals for
 * three days. That was "watched but not booked". This would be "booked but not watched", and the
 * fix settlement landed — making register-and-book one atomic operation — is the shape of the fix
 * this service will need.
 *
 * ── WHAT HAS TO HAPPEN BEFORE THIS BECOMES `true` ──────────────────────────────────────────────
 *
 *   1. The pool payout address is registered with the indexer under a `pool:` label, and its
 *      opening balance is booked into the ledger in the same operation that registers it — the
 *      `treasury.ts` shape, not two steps that can be interrupted between.
 *   2. `INDEXER_CUSTODY_LABEL_PREFIXES` includes `pool:` on the estate.
 *   3. The `pool` service holds `indexer:write` and `ledger:post` grants. As of 2026-08-09 it holds
 *      no service-token grants at all.
 *   4. The registration supplies a history claim the indexer's walked record can actually honour.
 *      This one was added on 2026-08-09 after a second reading, because the first three are
 *      necessary and NOT sufficient on Litecoin, and the miss fails in a different direction than
 *      the drift this whole block is about.
 *
 *      LTC is a `DERIVED_FAMILIES` chain in `indexer/src/custody.ts` — the balance is walked, not
 *      asked for the way `eth_getBalance` is asked. `deriveBalances` requires of EVERY address in
 *      the custody set that its `history_from_height` be at or below the record's lowest walked
 *      height, and when one address cannot satisfy that it throws rather than skipping it. So a
 *      single badly-registered address does not under-report itself, it destroys the observation
 *      for the whole asset — the ledger then records `unavailable`/`failed`, and LTC freezes from
 *      the "no observation" branch instead of the drift branch.
 *
 *      This is not hypothetical for the pool specifically: the payout address accumulates coinbase
 *      from the moment the pool mines, which is BEFORE anybody registers it, so it can never be
 *      registered with `freshlyDerived: true`. It needs a truthful `history_from_height` — the mint
 *      height — and the indexer's LTC record must already reach at or below that height, or a
 *      backfill has to run first. `settlement/src/indexerclient.ts` documents the same constraint
 *      on `watch`'s `freshlyDerived` parameter, citing micro-org#252.
 *
 *      Measured while writing this, so the failure mode is not confused with the current state:
 *      LTC reconciled `clean` with `drift 0` on every fifteen-minute sweep through 2026-08-09,
 *      including at 15:15:52Z. It froze once that day, from 15:00:50Z to 15:15:52Z, and that was
 *      the node outage in micro-org#307, not this.
 *
 * None of that is in this repository's gift alone, which is exactly why the interlock is here
 * rather than in a ticket. Somebody switching payouts on has to read this first.
 */
export const CUSTODY_BACKING_CLOSED = false

/**
 * A claim reached the sink while `CUSTODY_BACKING_CLOSED` is false, or the claim named a miner the
 * ledger has no account for.
 *
 * Thrown rather than logged-and-skipped for the reason `PayoutsNotImplementedError` exists: the two
 * things always reached for instead — returning silently, or logging and continuing — both produce a
 * pool that behaves as though it paid.
 */
export class PayoutRefusedError extends Error {
  readonly reason: string
  constructor(reason: string, detail: string) {
    super(`micro-pool refused to credit a payout (${reason}): ${detail}`)
    this.name = 'PayoutRefusedError'
    this.reason = reason
  }
}

export interface LedgerPayoutSinkDeps {
  readonly sql: Exec
  readonly ledger: LedgerClient
  /**
   * Smallest units a claim must be worth before an entry is posted for it. **No default: it comes
   * from `POOL_<CHAIN>_MINIMUM_PAYOUT`, which has none either**, and the absence of a default is the
   * whole point — see `optionalUnits` in `env.ts`. A sink cannot be constructed without one, which is
   * what makes "payouts are configured" and "somebody chose the threshold" the same statement.
   */
  readonly minimumUnits: bigint
  /**
   * Whether the estate's books can absorb what a credit writes. **`index.ts` passes
   * `CUSTODY_BACKING_CLOSED` and there is nothing else to pass** — it is not read from the
   * environment, and `payouts.test.ts` reads `index.ts` to prove the composition root passes the
   * constant rather than a literal.
   *
   * A parameter rather than a direct read of the constant so the branches BEHIND the interlock are
   * reachable from a test. An untested minimum check and an untested account lookup in a module that
   * moves money would be a worse trade than this, and the trade costs nothing an operator can reach:
   * flipping this in production still means editing a source file somebody reviews.
   */
  readonly custodyBackingConfirmed: boolean
  /** Ties every entry back to the run that caused it. One correlation id per sweep, not per claim. */
  readonly correlationId: () => string
  readonly log: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void
}

/**
 * The `PayoutSink` implementation, against micro-ledger.
 *
 * Modelled directly on `wallet/src/deposits.ts`, which is the estate's established shape for
 * crediting a ledger from an external event, and the correspondence is deliberate down to the
 * ordering: **claim locally, commit, then post.** The wallet argues that ordering at length and the
 * argument transfers unchanged — a crash between the two leaves a row with no ledger entry, which is
 * visible, queryable and retriable, and the retry is safe because the ledger dedupes on the same
 * key. The reverse ordering leaves a ledger entry this service does not know it made, and the next
 * attempt credits it again.
 *
 * `claim.creditKey` — `poolPayoutCreditKey`, unchanged — does BOTH jobs: it is the value behind the
 * unique constraint `pool_payout_credits_key_uniq` and it is the `idempotencyKey` on the wire. That
 * is the whole of the at-most-once guarantee, and an implementation that used two keys would pay
 * twice the first time a response was lost.
 *
 * **Nothing constructs one of these.** `index.ts` builds a sink only when the payout configuration
 * block is set, which it is not on the estate, and `CUSTODY_BACKING_CLOSED` refuses every claim
 * besides. Both gates, because they fail differently: the first is a deployment that has not been
 * configured, and the second is an estate whose books cannot yet absorb what this would write.
 */
export class LedgerPayoutSink implements PayoutSink {
  readonly #deps: LedgerPayoutSinkDeps

  constructor(deps: LedgerPayoutSinkDeps) {
    this.#deps = deps
  }

  async credit(claim: PayoutClaim): Promise<void> {
    if (!this.#deps.custodyBackingConfirmed) {
      throw new PayoutRefusedError(
        'custody_backing_not_confirmed',
        `the pool payout address is not observed by the indexer, so crediting ${claim.amount} ` +
          `${claim.asset} would put the ledger's custody total above what the reconciliation sweep ` +
          'can see and freeze the asset estate-wide. See CUSTODY_BACKING_CLOSED in src/payouts.ts.',
      )
    }

    /*
     * Below the threshold the operator set, so nothing is written — not the ledger entry and not the
     * local row.
     *
     * **Writing nothing is the deliberate part.** A dust claim that got a `pool_payout_credits` row
     * would be marked as handled by the very unique constraint that makes this at-most-once, and it
     * could then never be paid: the key is per block per worker, and there is exactly one of it. By
     * refusing before the claim, the debt stays where it already lives — in `pool_shares` and
     * `pool_blocks` — and is re-derivable in full by whatever eventually accrues across blocks.
     *
     * Which is to say: **accrual is not implemented here.** This is a per-claim floor, not a running
     * balance that pays out when it crosses one. Saying so plainly, because the two are easy to
     * confuse and only the second is what a miner expects from the phrase "minimum payout". The
     * accrual model needs a per-worker balance this service does not keep and must not invent — 04
     * §11, no user balance column outside the ledger — so it is the ledger that will hold it, once
     * `CUSTODY_BACKING_CLOSED` allows anything to be posted at all.
     */
    if (claim.amount < this.#deps.minimumUnits) {
      throw new PayoutRefusedError(
        'below_minimum',
        `${claim.amount} ${claim.asset} is under the configured minimum of ${this.#deps.minimumUnits}; ` +
          'nothing was recorded, so the claim can still be paid by a future accrual',
      )
    }

    // A miner is credited as an ESTATE USER or not at all. Most pool accounts are the payout address
    // somebody typed into their own firmware, and there is no liability account in the ledger for a
    // string; only a browser miner who signed in has a `pool_account_links` row. Crediting an
    // unlinked account to something plausible — `user:<the address>` — would create a liability
    // owed to nobody, which is a balance no withdrawal can ever drain and a reconciliation the
    // estate can never square.
    const userId = await userForAccount(this.#deps.sql, claim.account)
    if (userId === null) {
      throw new PayoutRefusedError(
        'no_estate_account',
        `pool account ${claim.account} is not linked to an estate user; an external miner is paid ` +
          'on chain, which this service does not do',
      )
    }

    const id = await claimPayoutCredit(this.#deps.sql, {
      chain: claim.chain,
      network: claim.network,
      blockHash: claim.blockHash,
      blockHeight: claim.blockHeight,
      workerId: claim.workerId,
      account: claim.account,
      assetCode: claim.asset,
      amount: claim.amount,
      creditKey: claim.creditKey,
    })
    if (id === null) {
      // Already on file. Not an error and not rare — a retried sweep, a second replica, a job re-run
      // after a lost response all arrive here. Whether that earlier claim reached the ledger is
      // `flushPending`'s question, not this one's.
      this.#deps.log('info', 'this payout was already claimed', { creditKey: claim.creditKey })
      return
    }

    await this.#post({
      id,
      chain: claim.chain,
      network: claim.network,
      blockHash: claim.blockHash,
      blockHeight: claim.blockHeight,
      userId,
      asset: claim.asset,
      amount: claim.amount,
      creditKey: claim.creditKey,
    })
  }

  /**
   * Finish the claims whose ledger posting never landed.
   *
   * The safety net the claim-then-post ordering requires, and the only reason that ordering is safe
   * to choose. Scheduled as `pool.flush-payouts` in `jobs.ts`, keyed on the chain and leased for the
   * same reason the maturity sweep is — but only for chains an operator configured a payout minimum
   * for, which on 2026-08-09 is none of them. On a deployment with payouts off nothing constructs
   * this class, so the kind is neither seeded nor registered.
   */
  async flushPending(chain: PoolChainId, limit: number): Promise<number> {
    const pending = await pendingPayoutCredits(this.#deps.sql, { chain, limit })
    let posted = 0
    for (const credit of pending) {
      const userId = await userForAccount(this.#deps.sql, credit.account)
      if (userId === null) {
        // The row was written when the link existed, so this is a link that has since been removed.
        // Left pending and counted rather than deleted: the claim is a real debt and the row is the
        // only record of it.
        this.#deps.log('error', 'a claimed payout names an account with no estate user', {
          creditKey: credit.creditKey,
        })
        continue
      }
      await this.#post({
        id: credit.id,
        chain,
        network: credit.network as Network,
        blockHash: credit.blockHash,
        blockHeight: credit.blockHeight,
        userId,
        asset: credit.assetCode as AssetCode,
        amount: credit.amount,
        creditKey: credit.creditKey,
      })
      posted += 1
    }
    return posted
  }

  /**
   * Post one claimed credit and record the entry it produced.
   *
   * **The double-entry pair 04-domain-model §2 requires**: a debit to the custody asset account —
   * the coinbase paid coin into a custody-held address, so the estate holds more — and a credit to
   * the miner's liability account, because a miner's balance is money the estate owes them. The
   * entry balances because those are the same number.
   *
   * That first posting is precisely the one `CUSTODY_BACKING_CLOSED` is about: it is the number the
   * reconciliation sweep sums, and the sweep has no way to see the coin behind it.
   */
  async #post(credit: {
    id: number
    chain: PoolChainId
    network: Network
    blockHash: string
    blockHeight: number
    userId: string
    asset: AssetCode
    amount: bigint
    creditKey: string
  }): Promise<void> {
    const actor: Actor = 'service:pool'
    const entry = await this.#deps.ledger.postEntry({
      // The closest kind in the ledger's closed vocabulary, and an accurate one: a block reward
      // allocated by PPLNS is a reward granted for work done. There is no `pool_payout` kind and
      // this service does not get to invent one — `@cloudsforge/contracts-money` is exact-pinned so
      // that every service names the same movement the same way.
      kind: 'reward_granted',
      actor,
      correlationId: this.#deps.correlationId(),
      // The same key the local row is deduped on, so the two services cannot disagree about whether
      // this movement has been credited.
      idempotencyKey: credit.creditKey,
      description: `Mining reward for block ${credit.blockHash}`,
      metadata: {
        chain: credit.chain,
        network: credit.network,
        blockHash: credit.blockHash,
        blockHeight: credit.blockHeight,
      },
      postings: [
        {
          direction: 'debit',
          amount: credit.amount,
          assetCode: credit.asset,
          sequence: 0,
          account: { subject: 'custody', assetCode: credit.asset, purpose: 'available', type: 'asset' },
        },
        {
          direction: 'credit',
          amount: credit.amount,
          assetCode: credit.asset,
          sequence: 1,
          account: {
            subject: `user:${credit.userId}`,
            assetCode: credit.asset,
            purpose: 'available',
            type: 'liability',
          },
        },
      ],
    })

    const closed = await markPayoutCredited(this.#deps.sql, {
      chain: credit.chain,
      id: credit.id,
      ledgerEntryId: entry.id,
    })
    if (!closed) {
      // Another replica finished it first. The ledger deduped on the same key, so there is no second
      // entry — there is simply nothing left to record.
      return
    }
    this.#deps.log('info', 'credited a mining payout', {
      chain: credit.chain,
      blockHash: credit.blockHash,
      creditKey: credit.creditKey,
      ledgerEntryId: entry.id,
      replayed: entry.replayed,
    })
  }
}
