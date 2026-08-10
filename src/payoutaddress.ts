/**
 * "Is this string an address the chain would actually pay to?" — asked of the node, cached, bounded.
 *
 * ## Why this exists at all (micro-org#286)
 *
 * A raw TCP miner's stratum username IS their payout address. It is the only thing this pool knows
 * about them and the only place a payment could ever be sent. Until now the pool checked that string
 * against `parseWorkerName` in `session.ts` — length, and a character set wide enough for base58 and
 * bech32 — and then took it. `parseWorkerName` is a STORAGE guard: it decides what may go into a
 * column and be rendered on a page. It says nothing at all about whether the value is an address,
 * and it cannot, because "looks like base58" and "is a Litecoin address with a valid checksum on
 * this network" are different questions.
 *
 * The asymmetry that makes this indefensible is inside this same service. `chainservice.ts` will not
 * open the stratum port until the node has run `validateaddress` over the POOL'S OWN payout address,
 * and treats a wrong answer as fatal to the process — see `payoutScriptFor` in `template.ts`. The
 * pool checks its own address before it will accept a single share, and did not check the miner's
 * before crediting them thousands. A miner who fat-fingers one character of a bech32 address, or who
 * pastes a Bitcoin address into a Litecoin pool, mines for as long as they leave it running and the
 * pool records every share against a string that can never be paid.
 *
 * ## It asks the node; it does not parse addresses
 *
 * There is no base58 decoder and no bech32 decoder here, and there must not be one. The set of
 * things `litecoind` will pay to is defined by `litecoind` — it moves with soft forks, with MWEB,
 * with the network the node is actually on — and a second implementation in this repository would be
 * a copy that is right on the day it is written and silently wrong afterwards. It also could not
 * tell mainnet from testnet without being told, which is precisely the class of error that survives
 * a code review and is discovered at the first payout. So the question goes to the node, which is
 * the same call, on the same connection, that the pool already trusts with its own address.
 *
 * ## The cache, and why it is bounded
 *
 * `validateaddress` is a pure function of the string for a given node and network — a verdict does
 * not change while this process lives. Without a cache, a farm of five hundred rigs reconnecting
 * after a pool restart is five hundred RPCs in a second against a node that is also assembling
 * templates, and a reconnect storm is exactly when the node is least able to spare them.
 *
 * The cache is a `Map` with a hard entry ceiling and oldest-first eviction, and NOT an unbounded one:
 * the key is a string a stranger chooses, so an unbounded map is a memory leak whose growth rate is
 * set by whoever is connecting. Insertion order is `Map`'s own, so eviction is one `keys().next()` —
 * the same shape `session.ts` uses for its seen-share set and its job-difficulty stamps, and for the
 * same reason.
 *
 * In-flight lookups are shared, not merely cached after the fact. Five hundred rigs on the same
 * address all arriving inside one RPC round trip would otherwise all miss the cache and all call the
 * node; they instead await one promise.
 *
 * ## The node being unreachable: this pool FAILS OPEN, deliberately
 *
 * The choice is between refusing a miner for something that is not their fault and crediting work
 * against an address nobody checked. Written down because it is not obvious and because the next
 * reader deserves the reasoning rather than the verdict:
 *
 *   - **What failing closed would cost.** The stratum listener stays open while the node is away —
 *     that is deliberate, see `chainservice.ts`: a node restarting for thirty seconds must not be a
 *     pool that has to be redeployed. Refusing authorisation during that window disconnects every
 *     rig that happens to reconnect, each of which then retries, all at once, at the exact moment an
 *     operator is already dealing with a node. It converts a node blip into a farm-wide outage, and
 *     it does it by punishing miners for it.
 *
 *   - **What failing open costs.** A share row credited to an account whose address was not checked
 *     this time. Re-measured 2026-08-10: there IS a payout path in this repository now
 *     (`LedgerPayoutSink`), and it is inert — `payoutsImplemented` is derived by `payouts.ts` from
 *     the `CUSTODY_BACKING_CLOSED` interlock and the payout configuration, and both terms are false
 *     on every deployment, so the wire field is `false` and the sink refuses every claim before it
 *     reads the database. Such a row is therefore not money going anywhere — it is a record that
 *     will be checked against a real address before it can ever be paid. And the verdict
 *     is NOT cached, so the same address is asked about again on the miner's next connection and on
 *     every connection after it; the window is one connection wide, not permanent.
 *
 * That asymmetry is the whole argument: failing closed harms every honest miner for the duration of
 * an operator's problem, and failing open harms nobody today and is self-correcting. The decision is
 * not silent — it logs at `warn` and increments `pool_address_checks_total{verdict="unavailable"}`,
 * so an operator sees unchecked authorisations happening rather than discovering them later.
 *
 * A node that ANSWERS and says the address is not valid is the other case entirely, and that is a
 * refusal. The node answered; the answer is the miner's to fix; and telling them now is the entire
 * point of the exercise.
 */

import { NodeUnavailableError } from './rpc.ts'
import type { NodeRpc } from './rpc.ts'

/**
 * The three answers, and they are three rather than two on purpose.
 *
 * A boolean would force "the node did not answer" to be spelled as either `true` or `false` at the
 * point it is produced, which puts the fail-open decision in this module and hides it from the
 * caller. It is `session.ts` that decides what to do about an unchecked address, and it can only
 * decide if it can tell the case apart.
 */
export type AddressVerdict = 'valid' | 'invalid' | 'unavailable'

/**
 * How many verdicts are kept.
 *
 * A pool with more than this many DISTINCT payout addresses connected at once does not exist on this
 * estate — measured 2026-08-09, the live pool has no real miners at all — so in practice this never
 * evicts. It is a ceiling on a stranger-keyed map rather than a tuning parameter, and the failure
 * mode of it being too small is one extra RPC, which is the cheapest failure mode available.
 */
const CACHE_LIMIT = 4_096

export interface AddressCheckerDeps {
  /** The chain's own node. The same one `template.ts` validates the pool's payout address against. */
  readonly rpc: Pick<NodeRpc, 'call'>
  /**
   * Told about every verdict, for a counter and a log line. Kept as a callback so this module does
   * not depend on `telemetry` and can be tested without registering a metric.
   *
   * The address is passed because it is the miner's own username and the operator needs to know
   * WHICH address was refused to answer a support question about it. It is not a secret — it is a
   * public payout address, it is already in `pool_workers`, and it is already on the `/workers` page.
   */
  readonly onVerdict?: ((verdict: AddressVerdict, address: string, detail: string) => void) | undefined
}

export class AddressChecker {
  readonly #rpc: Pick<NodeRpc, 'call'>
  readonly #onVerdict: AddressCheckerDeps['onVerdict']
  /** Settled verdicts. Only `valid` and `invalid` ever land here — see the header on failing open. */
  readonly #cache = new Map<string, 'valid' | 'invalid'>()
  /** Lookups in flight, so a reconnect storm on one address is one RPC and not one per connection. */
  readonly #inflight = new Map<string, Promise<AddressVerdict>>()

  constructor(deps: AddressCheckerDeps) {
    this.#rpc = deps.rpc
    this.#onVerdict = deps.onVerdict
  }

  /** Test and operational visibility only. */
  get cached(): number {
    return this.#cache.size
  }

  check(address: string): Promise<AddressVerdict> {
    const settled = this.#cache.get(address)
    if (settled !== undefined) return Promise.resolve(settled)
    const running = this.#inflight.get(address)
    if (running !== undefined) return running

    const lookup = this.#ask(address).finally(() => {
      this.#inflight.delete(address)
    })
    this.#inflight.set(address, lookup)
    return lookup
  }

  async #ask(address: string): Promise<AddressVerdict> {
    let reply: unknown
    try {
      reply = await this.#rpc.call<unknown>('validateaddress', [address])
    } catch (err) {
      if (err instanceof NodeUnavailableError) {
        // Not cached and not counted against the miner. See the header: this is the one case where
        // the pool proceeds without an answer, and it proceeds loudly.
        this.#onVerdict?.('unavailable', address, 'the node did not answer')
        return 'unavailable'
      }
      // The node ANSWERED and refused the call. `validateaddress` does not refuse a string — Core
      // returns `{"isvalid": false}` for gibberish rather than an error — so an RPC error here is a
      // node that is not in a state to answer questions (loading the block index, a wrong
      // credential) rather than a verdict about the address. Treated as unavailable for the same
      // reason: it is not the miner's fault and it is not evidence about their address.
      this.#onVerdict?.('unavailable', address, describe(err))
      return 'unavailable'
    }

    const verdict = isValid(reply) ? 'valid' : 'invalid'
    this.#remember(address, verdict)
    this.#onVerdict?.(verdict, address, 'the node answered')
    return verdict
  }

  #remember(address: string, verdict: 'valid' | 'invalid'): void {
    this.#cache.set(address, verdict)
    if (this.#cache.size > CACHE_LIMIT) {
      // Insertion order, oldest first. Not an LRU: an LRU here would need a touch on every hit to
      // buy an eviction policy for a map that, on this estate, never reaches its ceiling.
      const oldest = this.#cache.keys().next()
      if (!oldest.done) this.#cache.delete(oldest.value)
    }
  }
}

/**
 * `isvalid` from a `validateaddress` reply, read defensively.
 *
 * Strictly `=== true`, so a node that answered with a shape this does not understand is read as
 * "not valid" rather than as "valid". `payoutScriptFor` in `template.ts` reads the same field with
 * the same strictness for the pool's own address; the two are the same question asked about two
 * different strings and they must not disagree about what an answer means.
 */
function isValid(reply: unknown): boolean {
  if (typeof reply !== 'object' || reply === null) return false
  return (reply as Record<string, unknown>)['isvalid'] === true
}

/** An error as one short line. Never the node's URL — see the header of `rpc.ts`. */
function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err)
}
