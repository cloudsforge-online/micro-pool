/**
 * The auxiliary block: what `createauxblock` hands back, and how long it stays worth committing to.
 *
 * This is the merged-mining counterpart of `template.ts`, and the shape of the two is deliberately
 * different because the responsibilities are. For Litecoin this pool ASSEMBLES a block — it picks
 * the transactions the node offered, builds the coinbase, computes the merkle root. For Dogecoin it
 * assembles nothing: `createauxblock` makes dogecoind build a complete block, keep it, and return
 * only its hash. The pool's entire contribution is to commit to that hash in Litecoin's coinbase and
 * to hand back a proof afterwards.
 *
 * ## THE LIFETIME, WHICH IS THE WHOLE DIFFICULTY OF MERGED MINING
 *
 * Read out of `AuxMiningCreateBlock` and `AuxMiningSubmitBlock` in `src/rpc/mining.cpp` of Dogecoin
 * 1.14.9, at tag `v1.14.9` on 2026-08-09 — not inferred:
 *
 *     if (pindexPrev != chainActive.Tip())
 *     {
 *         // Clear old blocks since they're obsolete now.
 *         mapNewBlock.clear();
 *         ...
 *     }
 *
 * and, on the way back in:
 *
 *     const std::map<uint256, CBlock*>::iterator mit = mapNewBlock.find(hash);
 *     if (mit == mapNewBlock.end())
 *         throw JSONRPCError(RPC_INVALID_PARAMETER, "block hash unknown");
 *
 * So **an aux block hash is submittable for exactly as long as Dogecoin's tip does not move**, and
 * not one second longer. It is not a timeout, there is no grace, and the node keeps no history: the
 * moment DOGE finds a block anywhere in the world, every hash this pool is committed to becomes
 * `block hash unknown`. Within one DOGE tip the opposite holds and is worth knowing — `mapNewBlock`
 * is only cleared on a tip change, so the several blocks dogecoind builds as its mempool turns over
 * all stay submittable, and there is no need to chase the freshest one.
 *
 * That collides with Litecoin's job lifetime. DOGE aims at 60-second blocks and LTC at 150, so a
 * Litecoin job outlives the Dogecoin block it commits to more often than not. The commitment sits in
 * `coinb1`, so changing it means a new job — and the job is republished with **`cleanJobs = false`**,
 * because nothing about the Litecoin block has changed and telling miners to throw away in-flight
 * Litecoin work to chase a Dogecoin tip would trade a real block for a merged one.
 *
 * The consequence is stated plainly rather than engineered away: **shares found against a superseded
 * aux commitment still win Litecoin blocks and cannot win Dogecoin ones.** Merged mining is a bonus
 * on work that was going to happen anyway, and no part of this file is allowed to make Litecoin worse
 * in order to catch more of it.
 *
 * ## Absence is normal and is not an error
 *
 * `AuxMiningCheck` throws before it will build anything when dogecoind has no peers or is in initial
 * block download — which, on the estate on 2026-08-09, it is, at 0.36 of the chain. Every one of
 * those is a reason to mine Litecoin WITHOUT a commitment, not a reason to stop. So this source
 * publishes `null` and says so once per transition, and `work.ts` builds an ordinary coinbase.
 */

import { NodeRpcError, NodeUnavailableError, type NodeRpc } from './rpc.ts'
import { targetFromCompactBits } from './pow.ts'
import { isHex } from './bytes.ts'
import type { AuxChainId } from './chains.ts'

/**
 * JSON-RPC error codes from Bitcoin's `protocol.h`, which Dogecoin inherits unchanged.
 *
 * Named because the two that matter are indistinguishable from a typo by their message alone, and
 * because the response to them is the opposite of the response to a genuine refusal: these mean
 * "ask again later", and treating them as configuration faults would take the pool down for a node
 * that is merely still catching up.
 */
export const RPC_CLIENT_NOT_CONNECTED = -9
export const RPC_CLIENT_IN_INITIAL_DOWNLOAD = -10

/** Why there is no aux block, in the words an operator needs. */
export type AuxUnavailability = 'syncing' | 'no-peers' | 'refused' | 'unreachable'

export interface AuxBlock {
  readonly chain: AuxChainId
  /**
   * The block hash, display order, EXACTLY as the RPC returned it.
   *
   * Not converted, not normalised beyond lower-casing, and deliberately kept as a string rather than
   * as a Buffer: it is the key `submitauxblock` looks this block up by in dogecoind's own map, and
   * it is the 32 bytes that go into the commitment unreversed. Both uses want the RPC's own form,
   * and a `Buffer` field here would invite exactly the `hashFromDisplay` that `auxpow.ts` exists to
   * warn against.
   */
  readonly hashHex: string
  readonly height: number
  readonly bitsHex: string
  /**
   * The target a share must meet to win this Dogecoin block, decoded from `bitsHex`.
   *
   * **Decoded here rather than read from the RPC's own `target` field**, which is returned as
   * `HexStr(BEGIN(target), END(target))` over an `arith_uint256` — that is the raw little-endian
   * bytes, i.e. INTERNAL order, where every other hash-like string in that same reply is display
   * order. Reading it would mean carrying one field with the opposite convention to its neighbours
   * for no gain, since `bits` is right there and `targetFromCompactBits` is the one decoder this
   * service has. A target read backwards is not an error; it is a pool that thinks every share wins
   * a Dogecoin block, or none of them do.
   */
  readonly target: bigint
  readonly previousBlockHashHex: string
  readonly coinbaseValue: bigint
  readonly fetchedAt: Date
}

export interface AuxTemplateSourceOptions {
  readonly chain: AuxChainId
  readonly rpc: NodeRpc
  /** The address dogecoind pays this block's reward to. Its own, not Litecoin's. */
  readonly payoutAddress: string
  readonly onChange: (block: AuxBlock | null, why: AuxUnavailability | null) => void
  readonly now?: () => number
}

/**
 * The current aux block, refreshed on demand.
 *
 * There is no polling loop in here. The refresh is driven by whoever needs a fresh commitment — in
 * practice `chainservice.ts`, on the same tick that fetches a Litecoin template — because the two
 * have to be consistent at the moment a job is built, and a source that refreshed on its own timer
 * would change the commitment between the coinbase being built and the job being published. Rule 8
 * of the estate's service conventions says the same thing for the same reason: no `setInterval`.
 */
export class AuxTemplateSource {
  readonly chain: AuxChainId
  #current: AuxBlock | null = null
  #why: AuxUnavailability | null = null
  readonly #options: AuxTemplateSourceOptions
  readonly #now: () => number

  constructor(options: AuxTemplateSourceOptions) {
    this.chain = options.chain
    this.#options = options
    this.#now = options.now ?? (() => Date.now())
  }

  /** The block a commitment should name, or null when this chain is not currently mineable. */
  get current(): AuxBlock | null {
    return this.#current
  }

  /** Why `current` is null, or null when it is not. */
  get unavailability(): AuxUnavailability | null {
    return this.#why
  }

  /**
   * Ask dogecoind for a block to merge, and publish the answer.
   *
   * Never throws. Every failure here is a reason to mine Litecoin without a commitment, and a throw
   * would have to be caught by a caller whose only sensible response is the one this method already
   * takes. The `onChange` callback fires only on a TRANSITION — a hash that is the same as last
   * time, or an unavailability for the same reason, is not news, and a pool that logged every poll
   * would print a line every few seconds for the entire time Dogecoin spends in initial block
   * download.
   */
  async refresh(): Promise<AuxBlock | null> {
    let next: AuxBlock | null = null
    let why: AuxUnavailability | null = null
    try {
      next = parseAuxBlock(
        this.chain,
        await this.#options.rpc.call<unknown>('createauxblock', [this.#options.payoutAddress], {
          retryable: true,
        }),
        new Date(this.#now()),
      )
    } catch (err) {
      why = unavailabilityOf(err)
    }

    const changed =
      next === null ? this.#current !== null || this.#why !== why : this.#current?.hashHex !== next.hashHex
    this.#current = next
    this.#why = why
    if (changed) this.#options.onChange(next, why)
    return next
  }

  /** Forget the current block without asking the node. Used when a submission proves it is gone. */
  invalidate(why: AuxUnavailability): void {
    if (this.#current === null && this.#why === why) return
    this.#current = null
    this.#why = why
    this.#options.onChange(null, why)
  }
}

/** Which of the four reasons this failure is. Unrecognised refusals are `refused`, never swallowed. */
export function unavailabilityOf(err: unknown): AuxUnavailability {
  if (err instanceof NodeUnavailableError) return 'unreachable'
  if (err instanceof NodeRpcError) {
    if (err.code === RPC_CLIENT_IN_INITIAL_DOWNLOAD) return 'syncing'
    if (err.code === RPC_CLIENT_NOT_CONNECTED) return 'no-peers'
    return 'refused'
  }
  return 'refused'
}

/**
 * `createauxblock`'s reply, checked field by field.
 *
 * Every field is validated even though dogecoind wrote them, for the reason `template.ts` gives
 * about `getblocktemplate`: the cost of a wrong field is a block, and the cost of checking is a
 * comparison. The hash especially — it is going into consensus bytes unreversed, so a reply that is
 * not 32 bytes of hex has to fail here rather than 44 bytes later.
 */
export function parseAuxBlock(chain: AuxChainId, reply: unknown, fetchedAt: Date): AuxBlock {
  if (typeof reply !== 'object' || reply === null) throw new TypeError('createauxblock did not return an object')
  const source = reply as Record<string, unknown>

  const hashHex = String(source['hash'] ?? '').toLowerCase()
  if (!isHex(hashHex, 32)) throw new TypeError('createauxblock.hash is not 32 bytes of hex')

  const bitsHex = String(source['bits'] ?? '').toLowerCase()
  if (!isHex(bitsHex, 4)) throw new TypeError('createauxblock.bits is not 4 bytes of hex')

  const height = source['height']
  if (typeof height !== 'number' || !Number.isInteger(height) || height < 0) {
    throw new TypeError('createauxblock.height is not a height')
  }

  const previousBlockHashHex = String(source['previousblockhash'] ?? '').toLowerCase()
  if (!isHex(previousBlockHashHex, 32)) {
    throw new TypeError('createauxblock.previousblockhash is not 32 bytes of hex')
  }

  const coinbaseValue = source['coinbasevalue']
  if (typeof coinbaseValue !== 'number' || !Number.isInteger(coinbaseValue) || coinbaseValue < 0) {
    throw new TypeError('createauxblock.coinbasevalue is not an integer number of koinu')
  }

  const target = targetFromCompactBits(Number.parseInt(bitsHex, 16))
  if (target <= 0n) throw new TypeError(`createauxblock.bits ${bitsHex} decodes to a target of ${target}`)

  return {
    chain,
    hashHex,
    height,
    bitsHex,
    target,
    previousBlockHashHex,
    coinbaseValue: BigInt(coinbaseValue),
    fetchedAt,
  }
}
