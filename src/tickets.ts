/**
 * Mining tickets: the credential a BROWSER presents on the WebSocket transport, and the stable
 * pool account an estate user's browser work is credited to.
 *
 * ## Why a ticket exists at all, rather than a bearer token
 *
 * The browser `WebSocket` constructor cannot set request headers. That is not an oversight in this
 * design, it is the API — `new WebSocket(url, protocols)` takes a URL and a subprotocol list and
 * nothing else — so an estate access token could only reach this service in the query string or
 * smuggled through `Sec-WebSocket-Protocol`. Both are documented abuses and both are wrong here for
 * the same concrete reason: a URL is written to every access log, every proxy trace and every
 * browser history entry between the tab and this process, and the estate's own access token is good
 * for ten minutes against every service in the estate. Leaking it into a log to open a mining socket
 * would be trading a whole identity for a share.
 *
 * So the token is presented ONCE, over ordinary HTTP with an `Authorization` header, to
 * `POST /v1/pool/ticket`, and what comes back is a value that is worth exactly one thing: the right
 * to mine as one account on one connection, for sixty seconds, once. It is then handed over in the
 * `mining.authorize` PASSWORD field — a field this pool has always accepted, always ignored, and
 * deliberately never read, stored or logged (`session.ts` says so at length). That property is not
 * relaxed by this change; it is the reason this field was chosen. The password remains the one
 * string in the protocol that never reaches a log line.
 *
 * ## Why the store is in memory, and what that costs
 *
 * Three options were weighed and the reasoning is recorded rather than left to be re-derived:
 *
 *   - **A database table.** A short-lived bearer credential at rest, with a sweeper job, a migration
 *     and a retention story, in a service whose schema is otherwise a record of work done. Rejected:
 *     it is more machinery than the thing is worth, and it puts a live credential in the one place
 *     this repository takes backups of.
 *   - **A signed, stateless ticket.** Rejected for two reasons. It needs a signing secret, and
 *     `env.ts` states — twice, deliberately — that this service holds none and that
 *     `@cloudsforge/secrets` is absent because nothing here signs anything until payouts exist. And
 *     a signed ticket cannot be single-use: a value that verifies by arithmetic verifies as many
 *     times as it is presented, which is precisely the property that makes it worth stealing.
 *   - **In memory, bounded, single-use.** Taken.
 *
 * **The cost, stated rather than hidden: this assumes ONE REPLICA.** A ticket minted by replica A is
 * unknown to replica B, so with two replicas behind one name a browser would be refused roughly half
 * the time. The pool is a single-replica service today for a reason that has nothing to do with this
 * file — `env.ts` already notes that a second replica would need its own stratum ports, and a
 * connection-oriented listener with per-connection extranonce state does not fan out behind a load
 * balancer — so this constraint is not new and does not decide anything. If the pool is ever
 * replicated, this store moves to Redis or the ticket is redeemed through the minting replica; the
 * bound to keep is single-use, not in-process.
 *
 * ## The account label is generated, not derived
 *
 * `GET /v1/pool/shares?account=…` is public and unauthenticated, and that is a decision `server.ts`
 * defends: a miner's share history has to be checkable by the miner, and there is no estate identity
 * behind a stratum username to gate it with. It follows immediately that the account label a browser
 * miner is credited under **must not be the estate user id**, or the price of mining in a tab would
 * be publishing a stable estate identifier that anybody could then enumerate work against.
 *
 * So the link table maps a user id to a random opaque label, minted on the user's first ticket and
 * stable thereafter. Random rather than an HMAC of the user id for the same reason the ticket is not
 * signed: there is no key to derive one with, and inventing a place to keep a key for this would
 * contradict a decision this repository has already made twice.
 */

import { randomBytes } from 'node:crypto'
import { findAccountLink, insertAccountLink, type Exec } from './store.ts'

/**
 * How long a ticket is worth anything.
 *
 * Sixty seconds is the time between `fetch('/v1/pool/ticket')` resolving and a `WebSocket` finishing
 * its handshake and sending `mining.authorize` — a page load, a TLS handshake and one round trip, on
 * a connection slow enough to be worth allowing for. It is deliberately far too short to be worth
 * storing anywhere: a ticket that a client could keep is a ticket a client will keep, and then the
 * single-use property is the only thing left protecting the account.
 */
export const TICKET_TTL_MS = 60_000

/**
 * The most live tickets held at once.
 *
 * `POST /v1/pool/ticket` requires a verified estate token, so this is not an anonymous allocation —
 * but a bound on a map that a caller can add to is not optional whatever the caller is. Ten thousand
 * unredeemed tickets is far beyond any real page's behaviour and is a few hundred kilobytes; past it
 * the oldest are dropped, which costs a user one retry and cannot cost the process its memory.
 */
export const MAX_LIVE_TICKETS = 10_000

/** What a caller gets back. The secret is returned exactly once and is never logged anywhere. */
export interface MintedTicket {
  readonly secret: string
  readonly account: string
  readonly worker: string
  readonly expiresAtMs: number
}

/** What redemption yields. Both labels are the SERVER's, never the client's — see `session.ts`. */
export interface RedeemedTicket {
  readonly account: string
  readonly worker: string
}

interface HeldTicket {
  readonly account: string
  readonly worker: string
  readonly expiresAtMs: number
}

/**
 * The live tickets.
 *
 * Swept on mint rather than on a timer. A sweep needs a clock, this class already has one that ticks
 * whenever anything happens, and rule 8 of docs/ecosystem/03 §2 is about not adding another —
 * expired entries that nobody mints past are entries nobody can redeem either, because `redeem`
 * checks the deadline before it checks anything else.
 */
export class TicketStore {
  readonly #tickets = new Map<string, HeldTicket>()
  readonly #now: () => number
  readonly #ttlMs: number
  readonly #max: number

  constructor(options: { now?: () => number; ttlMs?: number; max?: number } = {}) {
    this.#now = options.now ?? (() => Date.now())
    this.#ttlMs = options.ttlMs ?? TICKET_TTL_MS
    this.#max = options.max ?? MAX_LIVE_TICKETS
  }

  /** Live tickets. For a metric and for the test that proves the bound holds. */
  get size(): number {
    return this.#tickets.size
  }

  mint(identity: { account: string; worker: string }): MintedTicket {
    this.#sweep()
    // 32 bytes from the CSPRNG. The value is compared by equality and never derived from, so its
    // only job is to be unguessable within its sixty-second life; 256 bits is not a considered
    // trade-off, it is simply more than enough and costs nothing.
    const secret = randomBytes(32).toString('base64url')
    const expiresAtMs = this.#now() + this.#ttlMs
    this.#tickets.set(secret, { account: identity.account, worker: identity.worker, expiresAtMs })
    if (this.#tickets.size > this.#max) {
      // Map iteration is insertion-ordered, so the first key is the oldest. Dropping it is a user
      // retrying; not dropping it is this process growing without limit.
      const oldest = this.#tickets.keys().next()
      if (!oldest.done) this.#tickets.delete(oldest.value)
    }
    return { secret, account: identity.account, worker: identity.worker, expiresAtMs }
  }

  /**
   * Spend a ticket. Null if it never existed, has expired, or has already been spent.
   *
   * The three are one answer on purpose. Telling a caller which of them happened would let anybody
   * with a candidate value learn whether it was ever a real ticket, and there is nothing an honest
   * client does differently in the three cases: it asks for another ticket.
   */
  redeem(secret: string): RedeemedTicket | null {
    const held = this.#tickets.get(secret)
    if (held === undefined) return null
    // Deleted whether or not it is still valid: an expired ticket presented once is an entry that
    // will never be redeemed again, so holding it is only holding memory.
    this.#tickets.delete(secret)
    if (held.expiresAtMs <= this.#now()) return null
    return { account: held.account, worker: held.worker }
  }

  #sweep(): void {
    const now = this.#now()
    for (const [secret, held] of this.#tickets) {
      if (held.expiresAtMs <= now) this.#tickets.delete(secret)
    }
  }
}

/**
 * The opaque pool account for one estate user, created on first use.
 *
 * `cf-` and sixteen hex characters: inside the account character set `parseWorkerName` enforces,
 * short enough to read back over a support conversation, and carrying nothing about the user. The
 * prefix exists so that an operator looking at `pool_workers` can tell a browser account from a
 * payout address at a glance — every other account in that table is an address a miner typed.
 */
export function newAccountLabel(): string {
  return `cf-${randomBytes(8).toString('hex')}`
}

/**
 * The worker label for one browser connection.
 *
 * Per TICKET, not per user, so two tabs on one account are two rows in `pool_workers` and two lines
 * in the worker list rather than one row whose hashrate is the sum of two machines. `web-` marks the
 * transport, which is the distinction an operator reading a worker list actually wants: a browser
 * doing a few hundred hashes a second and a rig doing terahashes are not the same kind of thing and
 * should not have to be told apart by their numbers.
 */
export function newBrowserWorkerLabel(): string {
  return `web-${randomBytes(3).toString('hex')}`
}

/**
 * Find this user's pool account, creating one the first time.
 *
 * The insert races itself: a page that fires two ticket requests at once — which is what a React
 * effect running twice in development does — reaches here twice with no row yet. The unique
 * constraint on `user_id` settles it, `on conflict do nothing` makes the loser return no row, and
 * the second read finds the winner's label. Both requests then get the SAME account, which is the
 * property that matters: two accounts for one user would split their share history in half with no
 * way to put it back together.
 */
export async function accountForUser(exec: Exec, userId: string): Promise<string> {
  const existing = await findAccountLink(exec, userId)
  if (existing !== null) return existing
  const inserted = await insertAccountLink(exec, { userId, account: newAccountLabel() })
  if (inserted !== null) return inserted
  const raced = await findAccountLink(exec, userId)
  if (raced !== null) return raced
  throw new Error('an account link was neither inserted nor found for this user')
}
