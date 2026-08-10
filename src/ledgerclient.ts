/**
 * The ledger, as this service uses it — which is one route and no more.
 *
 * **The ledger owns every balance in the platform and this service owns none.** 04-domain-model §11:
 * "No 'user balance' column anywhere outside the ledger's projection." `pool_payout_credits` is not a
 * balance and must never become one: it is a record of movements this service asked the ledger to
 * make, and the number a miner is owed is the ledger's answer, not a total kept here.
 *
 * ## Why this is a trimmed copy of `wallet/src/ledgerclient.ts` rather than a shared package
 *
 * The wallet's client has four methods; this has one. A pool posts a double-entry credit when a
 * block it mined has matured and it never reserves, releases or reads a balance — rule 9, a
 * repository declares what it needs and nothing else. The alternative, extracting the wallet's
 * client into `runtime/packages`, would be a change to the wallet's blast radius made for the
 * convenience of a service whose payout path is not even switched on; that is a refactor to propose
 * once something here actually pays somebody.
 *
 * What IS shared, and deliberately so, is the vocabulary: `EntryKind`, `AccountPurpose`,
 * `AccountType` and `LedgerAssetCode` all come from the exact-pinned `@cloudsforge/contracts-money`.
 * Those are the ledger's closed sets, and a pool that hand-typed `'reward_granted'` as its own
 * string literal would be a second copy of a vocabulary that is pinned precisely so there is one.
 *
 * ## Amounts are strings on the wire, in both directions
 *
 * A JSON number is an IEEE 754 double. A litoshi amount above 2^53 does not survive one and it does
 * not fail — it comes back subtly wrong. `bigint` is what this method takes so the conversion
 * happens once, here.
 *
 * ## The URL and the token never appear in a log line
 *
 * Same rule as `rpc.ts`. `HttpClient` carries the token and this file never renders it; the errors
 * below carry the ledger's own message and its status, and nothing else about the request.
 */

import { HttpClient, HttpError } from '@cloudsforge/http'
import type {
  AccountPurpose,
  AccountType,
  Actor,
  EntryKind,
  EntryMetadata,
  LedgerAssetCode,
} from '@cloudsforge/contracts-money'

/**
 * The scopes this service's token would have to carry, named so a deploy can be derived from this
 * file rather than from somebody's memory.
 *
 * Exactly one, because exactly one route is called. `ledger:read` is deliberately absent: a pool
 * that could read balances would eventually be asked to show one, and the honest answer to "what am
 * I owed" is a question for the wallet, which is where a user's balance is already presented.
 *
 * **The estate now grants it.** Read on 2026-08-10 from the running `identity` container's
 * `IDENTITY_SERVICE_TOKEN_GRANTS` rather than from a compose file, the map contains
 * `"pool":["ledger:post"]` — derived from this very constant by `deploy/scripts/derive-grants.mjs
 * --write`, which is the point of exporting it. An earlier version of this paragraph said the pool
 * held no grants at all; that was true on 2026-08-09 and stopped being true when the derivation was
 * regenerated, which is the hazard of writing a fact about another system down.
 *
 * A grant is still not a payout. `CUSTODY_BACKING_CLOSED` in `payouts.ts` refuses every claim before
 * a token is ever fetched, and it is the gate that has not moved.
 */
export const LEDGER_SCOPES: readonly string[] = Object.freeze(['ledger:post'])

/**
 * The ledger refused on the state of the world rather than on the request.
 *
 * Separate from a transport failure because the two demand opposite responses: this one must not be
 * retried, and a transport failure must be. Collapsing them is how a permanent refusal becomes an
 * infinite retry loop, and how a network blip becomes a payout abandoned.
 */
export class LedgerRefusedError extends Error {
  readonly code: string
  readonly status: number
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'LedgerRefusedError'
    this.code = code
    this.status = status
  }
}

/** The ledger could not be reached, or answered 5xx. The caller does not know whether it posted. */
export class LedgerUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LedgerUnavailableError'
  }
}

export interface AccountRef {
  readonly subject: string
  readonly assetCode: LedgerAssetCode
  readonly purpose: AccountPurpose
  readonly type: AccountType
}

export interface PostingRequest {
  readonly direction: 'debit' | 'credit'
  readonly amount: bigint
  readonly assetCode: LedgerAssetCode
  readonly sequence: number
  /** The ledger creates the account if it does not exist, which is why the type travels with it. */
  readonly account: AccountRef
}

export interface PostEntryRequest {
  readonly kind: EntryKind
  readonly actor: Actor
  readonly correlationId: string
  readonly idempotencyKey: string
  readonly description?: string
  readonly metadata?: EntryMetadata
  readonly postings: readonly PostingRequest[]
}

export interface PostedEntry {
  readonly id: string
  readonly kind: string
  readonly recordedAt: string
  /** True when the ledger answered from a stored response rather than by posting. */
  readonly replayed: boolean
}

export interface LedgerClient {
  postEntry(request: PostEntryRequest): Promise<PostedEntry>
}

export interface LedgerClientOptions {
  readonly baseUrl: string
  readonly token: () => Promise<string | undefined> | string | undefined
  readonly deadlineMs: number
  readonly fetch?: typeof globalThis.fetch
}

export function httpLedgerClient(options: LedgerClientOptions): LedgerClient {
  const client = new HttpClient({
    baseUrl: options.baseUrl,
    name: 'ledger',
    defaultDeadlineMs: options.deadlineMs,
    token: options.token,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })

  return {
    async postEntry(request) {
      let body: { entry: RawEntry; replayed: boolean }
      try {
        // The idempotency key is passed to `HttpClient` as well as sitting in the body, and both
        // matter. In the body it is what the ledger stores and dedupes on; on the request it is
        // what makes the POST retriable at all — `HttpClient` attempts a non-idempotent method
        // exactly once unless a key is present, which is the rule that stops a retried credit
        // paying twice.
        body = await client.request<{ entry: RawEntry; replayed: boolean }>('/entries', {
          method: 'POST',
          idempotencyKey: request.idempotencyKey,
          body: {
            kind: request.kind,
            // Always `pool`. Hard-coded rather than configurable, because it is the attribution the
            // ledger records against every entry and a deployment that could rename itself could
            // launder its own entries into another service's.
            originatingService: 'pool',
            actor: request.actor,
            correlationId: request.correlationId,
            idempotencyKey: request.idempotencyKey,
            ...(request.description !== undefined ? { description: request.description } : {}),
            ...(request.metadata !== undefined ? { metadata: request.metadata } : {}),
            postings: request.postings.map((posting) => ({
              direction: posting.direction,
              amount: posting.amount.toString(),
              assetCode: posting.assetCode,
              sequence: posting.sequence,
              account: posting.account,
            })),
          },
        })
      } catch (err) {
        throw translate(err)
      }
      return {
        id: body.entry.id,
        kind: body.entry.kind,
        recordedAt: body.entry.recordedAt,
        replayed: body.replayed,
      }
    },
  }
}

interface RawEntry {
  readonly id: string
  readonly kind: string
  readonly recordedAt: string
}

/**
 * Turn an HTTP failure into one of the two things a caller can act on.
 *
 * `HttpError.peerDecided` is the discriminator and it is the right one: a 4xx means the ledger
 * looked at the request and said no, which will not change on a retry. Anything else — 5xx, a
 * timeout, an open circuit — means we do not know whether the entry posted, and the only safe
 * response is to retry with the same idempotency key.
 */
function translate(err: unknown): Error {
  if (err instanceof HttpError && err.peerDecided) {
    const parsed = parseError(err.body)
    return new LedgerRefusedError(err.status, parsed.code, parsed.message)
  }
  return new LedgerUnavailableError(err instanceof Error ? err.message : String(err))
}

function parseError(body: string): { code: string; message: string } {
  try {
    const parsed: unknown = JSON.parse(body)
    const error = (parsed as { error?: { code?: unknown; message?: unknown } }).error
    return {
      code: typeof error?.code === 'string' ? error.code : 'ledger_error',
      message: typeof error?.message === 'string' ? error.message : body.slice(0, 500),
    }
  } catch {
    return { code: 'ledger_error', message: body.slice(0, 500) }
  }
}
