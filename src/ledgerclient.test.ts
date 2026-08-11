/**
 * The one route this service calls on the ledger, tested at the wire rather than at the interface.
 *
 * ## Why this file exists, when `payouts.test.ts` already exercises a ledger
 *
 * It exercises a *fake* one. `payouts.test.ts` and `rewards.test.ts` both import only the
 * `LedgerClient` INTERFACE and hand the sink a hand-written object, so until 2026-08-11 not one line
 * of `ledgerclient.ts` had ever run in a test — and the lines it does not run include the three the
 * module's own header identifies as the reason it is written the way it is. A fake that receives a
 * `PostEntryRequest` receives it *before* serialisation, which is precisely where the money-safety
 * is.
 *
 * So everything below injects a `fetch` and reads what actually went out.
 *
 * ## The error split is now load-bearing, not decorative
 *
 * `LedgerRefusedError` and `LedgerUnavailableError` were exported, documented at length, and caught
 * by nobody: `rewards.ts` lumped both into "the ledger was unreachable, or the database was" and
 * `payouts.ts` had no catch at all. micro-org#302's flush fix made `flushPending` branch on exactly
 * this distinction — step over a refusal, stop the batch on an outage — so a `translate` that
 * collapsed the two would now silently turn a permanent refusal into a stalled queue, or an outage
 * into a hundred pointless posts. That is a behaviour with a caller, and it gets tests.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  LEDGER_SCOPES,
  LedgerRefusedError,
  LedgerUnavailableError,
  httpLedgerClient,
  type PostEntryRequest,
} from './ledgerclient.ts'

/** What the injected `fetch` saw, so a test can read the bytes rather than the intent. */
interface Seen {
  url: string
  method: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

function clientThatSees(
  seen: Seen[],
  reply: { status: number; body: string } = { status: 200, body: '' },
): ReturnType<typeof httpLedgerClient> {
  const fetchImpl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value
    })
    seen.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    })
    const body =
      reply.body ||
      JSON.stringify({ entry: { id: 'entry-1', kind: 'reward_granted', recordedAt: 'now' }, replayed: false })
    return Promise.resolve(
      new Response(body, { status: reply.status, headers: { 'content-type': 'application/json' } }),
    )
  }
  return httpLedgerClient({
    baseUrl: 'http://ledger.invalid',
    token: () => 'token',
    deadlineMs: 1_000,
    fetch: fetchImpl as unknown as typeof globalThis.fetch,
  })
}

/** An amount that cannot survive an IEEE 754 double — 2^53 + 1 litoshi. */
const BEYOND_DOUBLE = 9_007_199_254_740_993n

function request(amount: bigint = 1_250_000_000n): PostEntryRequest {
  return {
    kind: 'reward_granted',
    actor: 'service:pool',
    correlationId: 'corr-1',
    idempotencyKey: 'pool:payout:ltc:mainnet:abc:7',
    postings: [
      {
        direction: 'debit',
        amount,
        assetCode: 'LTC',
        sequence: 0,
        account: { subject: 'custody', assetCode: 'LTC', purpose: 'available', type: 'asset' },
      },
    ],
  }
}

test('AN AMOUNT GOES OUT AS A DECIMAL STRING, EXACT PAST 2^53', async () => {
  // KILLS THE MUTATION `posting.amount.toString()` -> `Number(posting.amount)`.
  //
  // This is the single expression the module's header exists to justify: "A JSON number is an IEEE
  // 754 double. A litoshi amount above 2^53 does not survive one and it does not fail — it comes
  // back subtly wrong." Every other test in this repository asserts the amount on the
  // `PostEntryRequest`, which is the bigint BEFORE serialisation, so the mutant passes all of them.
  //
  // Deleting `.toString()` outright throws on the bigint, which is loud and survivable. `Number(...)`
  // is the dangerous mutant: it is silent, and it rounds 9007199254740993 to ...992 — one litoshi
  // conjured out of a rounding mode, in a ledger whose LTC reconciliation tolerance is zero.
  const seen: Seen[] = []
  await clientThatSees(seen).postEntry(request(BEYOND_DOUBLE))
  const postings = seen[0]?.body['postings'] as { amount: unknown }[]
  assert.equal(postings[0]?.amount, '9007199254740993')
  assert.equal(typeof postings[0]?.amount, 'string', 'the amount went out as a JSON number')
})

test('the idempotency key travels as a HEADER as well as in the body, which is what makes the POST retriable', async () => {
  // KILLS THE MUTATION that drops `idempotencyKey` from the `HttpClient` request OPTIONS while
  // leaving it in the body — where it still looks present to any reader and to every existing test.
  //
  // `HttpClient` attempts a non-idempotent method exactly once unless a key is present
  // (`retriable = IDEMPOTENT_METHODS.has(method) || options.idempotencyKey !== undefined`). Without
  // the header the body's copy still dedupes at the ledger, so nothing double-pays — but every
  // transient blip becomes a payout abandoned mid-flight instead of retried, which is the failure
  // `flushPending` then has to clean up.
  const seen: Seen[] = []
  await clientThatSees(seen).postEntry(request())
  assert.equal(seen[0]?.headers['idempotency-key'], 'pool:payout:ltc:mainnet:abc:7')
  assert.equal(seen[0]?.body['idempotencyKey'], 'pool:payout:ltc:mainnet:abc:7')
  assert.equal(seen[0]?.method, 'POST')
})

test('every entry is attributed to `pool`, and the caller cannot say otherwise', async () => {
  // KILLS THE MUTATION that makes `originatingService` a field of `PostEntryRequest` instead of a
  // constant. It is not on the request type at all, so it is structurally invisible to a fake — and
  // it is the attribution the ledger records against every entry. A deployment that could rename
  // itself could launder its own entries into another service's.
  const seen: Seen[] = []
  await clientThatSees(seen).postEntry(request())
  assert.equal(seen[0]?.body['originatingService'], 'pool')
  assert.ok(String(seen[0]?.url).endsWith('/entries'))
})

test('the ledger deciding NO is terminal, and carries the code it decided on', async () => {
  // KILLS THE MUTATION that returns `LedgerUnavailableError` for every failure — the collapse the
  // module's header says would turn "a permanent refusal into an infinite retry loop".
  //
  // Load-bearing since micro-org#302: `flushPending` steps over a refusal and stops the batch on an
  // outage. Collapsed into "unavailable", a permanently-refused row would stop the batch on every
  // sweep and strand every row behind it — the exact defect that fix removed, reintroduced one layer
  // down.
  const seen: Seen[] = []
  const client = clientThatSees(seen, {
    status: 422,
    body: JSON.stringify({ error: { code: 'invalid_asset', message: 'LTC is not a ledger asset' } }),
  })
  const err = await client.postEntry(request()).then(
    () => null,
    (caught: unknown) => caught,
  )
  assert.ok(err instanceof LedgerRefusedError, `a 4xx was not terminal: ${String(err)}`)
  assert.equal(err.code, 'invalid_asset')
  assert.equal(err.status, 422)
  assert.match(err.message, /not a ledger asset/)
})

test('a 5xx is NOT terminal, because the caller does not know whether the entry posted', async () => {
  // KILLS THE MUTATION that widens `peerDecided` to any error status. A 5xx means the entry may
  // already be recorded, so the only safe response is to retry with the same key — and `flushPending`
  // reads this class as "stop the batch and come back", not "give up on this row".
  const seen: Seen[] = []
  const client = clientThatSees(seen, { status: 503, body: 'upstream is down' })
  const err = await client.postEntry(request()).then(
    () => null,
    (caught: unknown) => caught,
  )
  assert.ok(err instanceof LedgerUnavailableError, `a 5xx was treated as a decision: ${String(err)}`)
})

test('a refusal whose body is not the estate error envelope still yields a usable code', async () => {
  // KILLS THE MUTATION that lets `parseError` throw on a non-JSON body, or returns the raw body as
  // the code. A gateway answering 413 with HTML is ordinary, and it must not become an exception on
  // the error path — where it would be raised INSTEAD of the refusal the caller needs to classify.
  const seen: Seen[] = []
  const client = clientThatSees(seen, { status: 413, body: '<html>Payload Too Large</html>' })
  const err = await client.postEntry(request()).then(
    () => null,
    (caught: unknown) => caught,
  )
  assert.ok(err instanceof LedgerRefusedError)
  assert.equal(err.code, 'ledger_error')
  assert.match(err.message, /Payload Too Large/)
})

test('the replayed flag is read from the envelope, not from the entry', async () => {
  // KILLS THE MUTATION `body.replayed` -> `body.entry.replayed`, which yields `undefined` rather
  // than throwing — so it is invisible except in a log field. `ledger/src/server.ts` returns
  // `{ entry, replayed }` side by side, and `replayed` is how an operator tells a payment that
  // happened from one that was deduped.
  const seen: Seen[] = []
  const client = clientThatSees(seen, {
    status: 200,
    body: JSON.stringify({ entry: { id: 'e-9', kind: 'reward_granted', recordedAt: 'then' }, replayed: true }),
  })
  const posted = await client.postEntry(request())
  assert.deepEqual(posted, { id: 'e-9', kind: 'reward_granted', recordedAt: 'then', replayed: true })
})

test('the declared scopes are exactly what the one route needs, and no read', () => {
  // KILLS THE MUTATION that adds `ledger:read`. This constant is not documentation: it is the input
  // `deploy/scripts/derive-grants.mjs --write` reads to mint the estate's real service-token grants,
  // so a scope added here is a privilege granted in production. A pool that could read balances would
  // eventually be asked to show one, and a miner's balance is the wallet's to present.
  assert.deepEqual([...LEDGER_SCOPES], ['ledger:post'])
})
