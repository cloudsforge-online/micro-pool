/**
 * The HTTP surface, over a real socket.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS FILE DID NOT EXIST UNTIL NOW, WHICH IS micro-org#283.
 *
 * `src/server.ts` was the one module in this repository with no test beside it — the route table,
 * the 404 envelope, the request-id echo, the parameter clamps and the entire public response shape
 * were all unasserted. It is not fixed wholesale here. What is covered is the surface the pool's
 * console reads and the route this change touched, plus the envelope and clamping behaviour that
 * every one of those answers depends on; the remaining routes are exercised for shape rather than
 * for their SQL, which lives in `store.test.ts` against a real database.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── The database is a stub here, and that is the boundary this file accepts ────────────────────
 *
 * `Exec` is a tagged template that returns rows. Every query in `store.ts` is tested against a real
 * Postgres in `store.test.ts`, which is where a query belongs; putting one behind this file as well
 * would make the HTTP tests skip on a machine with no database, and the thing they are checking —
 * what JSON reaches a browser — has nothing to do with SQL. So the rows are handed over directly
 * and what is asserted is the composition on top of them.
 *
 * ── What is asserted about `/v1/pool` above everything else ───────────────────────────────────
 *
 * That `stratumEndpoint` is **null** when nothing has been published, and that no other field in
 * the response can be mistaken for one. This response used to carry a port and no name, and the
 * console filled the gap in from `window.location.hostname` — publishing
 * `stratum+tcp://pool.<apex>:3334`, an endpoint that terminates at a Cloudflare Tunnel which cannot
 * forward raw TCP, in front of a listener bound to loopback. It cannot connect, and its reader
 * blames their own hardware. micro-org#285.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { Lifecycle } from '@cloudsforge/lifecycle'
import { Logger, Metrics, registerHttpMetrics } from '@cloudsforge/telemetry'
import { createServer, type PoolSnapshot, type ServerDeps } from './server.ts'
import { TokenError, VerifierUnavailableError, type Principal } from '@cloudsforge/auth'
import { registerPoolMetrics, type ChainStatus } from './chainservice.ts'
import type { Exec } from './store.ts'

/**
 * A `sql` that answers every query with the rows it was given.
 *
 * Deliberately blind to the statement: this file is not testing SQL, and a stub that pattern-matched
 * on query text would be a second, worse copy of `store.ts` that passes when `store.ts` is wrong.
 */
function stubSql(rows: readonly unknown[] = []): Exec {
  return (async () => rows) as unknown as Exec
}

/** A chain reporting no published endpoint — the estate's own configuration on 2026-08-09. */
function chainStatus(over: Partial<ChainStatus> = {}): ChainStatus {
  return {
    chain: 'ltc',
    name: 'Litecoin',
    algorithm: 'scrypt',
    // The BIND. Reported because it is true of this process, and useless as half of a connection
    // string, which is the entire point of the field beside it.
    stratumPort: 3334,
    stratumEndpoint: null,
    // And likewise the browser's endpoint: null unless an operator published an origin.
    websocketEndpoint: null,
    connections: 2,
    height: 2_912_004,
    networkDifficulty: 34_512_119.5,
    templateAgeSeconds: 4,
    ready: true,
    ...over,
  }
}

function snapshot(over: Partial<PoolSnapshot> = {}): PoolSnapshot {
  return {
    network: 'mainnet',
    feeBasisPoints: 100,
    pplnsMultiplier: 2,
    chains: [chainStatus()],
    ...over,
  }
}

interface Harness {
  readonly url: string
  readonly lifecycle: Lifecycle
  readonly metrics: Metrics
  /** Every line the service logged, as text. The ticket tests search it for what must not be there. */
  readonly logs: string[]
}

async function withServer(
  options: {
    snapshot?: PoolSnapshot
    rows?: readonly unknown[]
    beforeScrape?: ServerDeps['beforeScrape']
    browserMining?: ServerDeps['browserMining']
  },
  fn: (h: Harness) => Promise<void>,
): Promise<void> {
  const lifecycle = new Lifecycle({ cacheMs: 0 })
  const metrics = registerPoolMetrics(registerHttpMetrics(new Metrics()))
  // Captured rather than silenced, so a log line that cannot be serialised still throws instead of
  // being swallowed by a null logger — and so a test can assert what a line does NOT contain.
  const logs: string[] = []
  const logger = new Logger({ service: 'pool-test', sink: (line) => logs.push(String(line)) })
  const server: Server = createServer({
    lifecycle,
    logger,
    metrics,
    sql: stubSql(options.rows ?? []),
    snapshot: () => options.snapshot ?? snapshot(),
    ...(options.beforeScrape ? { beforeScrape: options.beforeScrape } : {}),
    ...(options.browserMining ? { browserMining: options.browserMining } : {}),
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  lifecycle.markReady()
  const { port } = server.address() as AddressInfo
  try {
    await fn({ url: `http://127.0.0.1:${port}`, lifecycle, metrics, logs })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

/* ------------------------------------------------ the endpoint, which is the point of this file */

test('AN UNPUBLISHED STRATUM ENDPOINT IS NULL, AND NOTHING ELSE IN THE BODY SUBSTITUTES FOR IT', async () => {
  await withServer({}, async (h) => {
    const res = await fetch(`${h.url}/v1/pool`, { headers: { host: 'pool.cloudsforge.online' } })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { chains: { stratumEndpoint: unknown; stratumPort: number }[] }
    const chain = body.chains[0]

    assert.equal(chain?.stratumEndpoint, null, 'an unconfigured endpoint must be null, not a guess')

    // Not the request's own Host header, under any key. The hostname that served this response is
    // the HTTP front door; on this estate it reaches the pool through a Cloudflare Tunnel and
    // Traefik, neither of which forwards a raw TCP stream, so it is provably NOT the stratum host.
    assert.ok(
      !JSON.stringify(body).includes('pool.cloudsforge.online'),
      'the response reflected the request Host header, which is not where stratum is',
    )
    // The bind is still reported, because an operator reading this beside a compose file needs it.
    // It is simply not an endpoint, and there is nothing here to pair it with.
    assert.equal(chain?.stratumPort, 3334)
  })
})

test('a published endpoint is reported as both halves together', async () => {
  await withServer(
    {
      snapshot: snapshot({
        chains: [chainStatus({ stratumEndpoint: { host: 'stratum.example.com', port: 4334 } })],
      }),
    },
    async (h) => {
      const res = await fetch(`${h.url}/v1/pool`)
      const body = (await res.json()) as { chains: { stratumEndpoint: unknown; stratumPort: number }[] }
      assert.deepEqual(body.chains[0]?.stratumEndpoint, { host: 'stratum.example.com', port: 4334 })
      // The published port differs from the bound one on purpose: a deploy maps them, and this
      // estate's compose file publishes `${POOL_LTC_STRATUM_PORT:-3334}` onto a container port
      // fixed at 3334. Reporting the bind as the endpoint would be reporting the wrong number.
      assert.equal(body.chains[0]?.stratumPort, 3334)
    },
  )
})

test('a pool serving nothing reports no chains rather than failing', async () => {
  // `POOL_CHAINS` is per-deployment and a pool with none is a running service with nothing to mine.
  // The console renders that as a named hole; a 500 here would render it as an outage.
  await withServer({ snapshot: snapshot({ chains: [] }) }, async (h) => {
    const res = await fetch(`${h.url}/v1/pool`)
    assert.equal(res.status, 200)
    const body = (await res.json()) as { chains: unknown[] }
    assert.deepEqual(body.chains, [])
  })
})

/* ------------------------------------------------------------------ the rest of the front page */

test('the pool summary carries the whole shape the console is written against', async () => {
  await withServer({}, async (h) => {
    const res = await fetch(`${h.url}/v1/pool`)
    const body = (await res.json()) as Record<string, unknown>
    assert.deepEqual(Object.keys(body).sort(), [
      'chains',
      'feeBasisPoints',
      'network',
      'payoutsImplemented',
      'pplnsWindowMultiplier',
    ])
    // Named, not implied, and a literal in the handler. Every sentence on micro-pool-web that says
    // nothing settles branches on this field rather than on its own markup.
    assert.equal(body['payoutsImplemented'], false)

    const chain = (body['chains'] as Record<string, unknown>[])[0] as Record<string, unknown>
    assert.deepEqual(Object.keys(chain).sort(), [
      'algorithm',
      'asset',
      'chain',
      'connections',
      'decimals',
      'hashrateEstimate',
      'height',
      'name',
      'networkDifficulty',
      'ready',
      'sharesInWindow',
      'stratumEndpoint',
      'stratumPort',
      'templateAgeSeconds',
      'websocketEndpoint',
      'windowSeconds',
      'workersInWindow',
    ])
    // The window every rate is measured over, stated in the body so a reader is not left to assume
    // one. An empty window reports zero, which is the honest reading of a pool nobody is mining.
    assert.equal(chain['windowSeconds'], 600)
    assert.equal(chain['sharesInWindow'], 0)
    assert.equal(chain['hashrateEstimate'], 0)
  })
})

/* ------------------------------------------------------------------ the chain parameter */

test('a pool serving one chain defaults it; a pool serving two refuses to pick', async () => {
  await withServer({}, async (h) => {
    const one = await fetch(`${h.url}/v1/pool/blocks`)
    assert.equal(one.status, 200)
    assert.equal(((await one.json()) as { chain: string }).chain, 'ltc')
  })

  await withServer(
    { snapshot: snapshot({ chains: [chainStatus(), chainStatus({ chain: 'btc', name: 'Bitcoin' })] }) },
    async (h) => {
      const res = await fetch(`${h.url}/v1/pool/blocks`)
      assert.equal(res.status, 400)
      const body = (await res.json()) as { error: { code: string; message: string } }
      assert.equal(body.error.code, 'bad_request')
      // The message names what this pool DOES serve. "chain is required" on its own sends the
      // reader to look for a list that is not published anywhere.
      assert.match(body.error.message, /ltc/)
      assert.match(body.error.message, /btc/)
    },
  )
})

test('a chain this pool does not serve is refused with the ones it does', async () => {
  await withServer({}, async (h) => {
    for (const chain of ['btc', 'doge', 'not-a-chain']) {
      const res = await fetch(`${h.url}/v1/pool/blocks?chain=${chain}`)
      assert.equal(res.status, 400, chain)
      const body = (await res.json()) as { error: { message: string } }
      assert.match(body.error.message, /it serves ltc/)
    }
  })
})

/* ------------------------------------------------------------------ the account parameter */

test('an account that could never have been stored is a 400, not an empty list', async () => {
  // The two are indistinguishable to a caller otherwise, and "no shares" is the answer a miner
  // reads as "the pool lost my work". `session.ts` accepts this character set and no other, so a
  // string outside it cannot be in the table.
  await withServer({}, async (h) => {
    for (const account of ['', '   ', 'has spaces', 'x'.repeat(97), 'semi;colon']) {
      const res = await fetch(`${h.url}/v1/pool/shares?account=${encodeURIComponent(account)}`)
      assert.equal(res.status, 400, JSON.stringify(account))
    }
    const ok = await fetch(`${h.url}/v1/pool/workers?account=ltc1qexampleaddress.rig1`)
    // The dot is NOT in the accepted set: the account is the half before it, and a caller who sends
    // the whole stratum username is asking for something this route does not answer.
    assert.equal(ok.status, 400)
    const bare = await fetch(`${h.url}/v1/pool/workers?account=ltc1qexampleaddress`)
    assert.equal(bare.status, 200)
  })
})

test('every list is bounded by a clamp rather than by trust', async () => {
  // An unauthenticated caller asking for a million rows is a database load generator. Clamping
  // rather than refusing is deliberate — the caller gets the ceiling, which is what they wanted.
  await withServer({}, async (h) => {
    const clamped = await fetch(`${h.url}/v1/pool/blocks?limit=100000`)
    assert.equal(clamped.status, 200)
    for (const limit of ['0', '-1', '2.5', 'lots']) {
      const res = await fetch(`${h.url}/v1/pool/blocks?limit=${limit}`)
      assert.equal(res.status, 400, limit)
    }
  })
})

/* ------------------------------------------------------------------ the envelope */

test('an unrouted path is a 404 in the same envelope as every other failure', async () => {
  await withServer({}, async (h) => {
    // `/v1/workers/<address>` in particular: it is the route this service's own README described
    // for a while and the one a frontend written from a brief reaches for first. It has never
    // existed, and the answer says so rather than hanging or returning an empty body.
    for (const path of ['/v1/workers/ltc1qexample', '/v1/pool/payouts', '/']) {
      const res = await fetch(`${h.url}${path}`)
      assert.equal(res.status, 404, path)
      const body = (await res.json()) as { error: { code: string; requestId: string } }
      assert.equal(body.error.code, 'not_found')
      // In the BODY as well as the header, which is what makes a support conversation work: a user
      // can read back what their browser showed them and it joins to the log line.
      assert.equal(body.error.requestId, res.headers.get('x-request-id'))
    }
  })
})

test('nothing on this port writes', async () => {
  // The only thing that mutates state in this service is a share arriving on the stratum port, and
  // that path does not pass through this file. A method that matched a path would be a write
  // surface on an endpoint with no authority on it at all.
  await withServer({}, async (h) => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await fetch(`${h.url}/v1/pool`, { method })
      assert.equal(res.status, 404, method)
    }
  })
})

test('a presented request id is echoed only when it is safe to log and to echo', async () => {
  await withServer({}, async (h) => {
    const safe = await fetch(`${h.url}/v1/pool`, { headers: { 'x-request-id': 'req-abc_123' } })
    assert.equal(safe.headers.get('x-request-id'), 'req-abc_123')

    // Replaced rather than refused: the caller does not need a 400 over this. An unvalidated value
    // here is a header-injection and a log-forgery primitive at once, so anything outside the safe
    // set gets a fresh id instead.
    for (const hostile of ['a b', 'x'.repeat(65), 'inject	tab']) {
      const res = await fetch(`${h.url}/v1/pool`, { headers: { 'x-request-id': hostile } })
      const echoed = res.headers.get('x-request-id')
      assert.notEqual(echoed, hostile, hostile)
      assert.match(echoed ?? '', /^[A-Za-z0-9_-]{1,64}$/)
    }
  })
})

test('pool state is never cached, because every field in it is a point-in-time fact', async () => {
  await withServer({}, async (h) => {
    for (const path of ['/v1/pool', '/livez', '/readyz', '/metrics']) {
      const res = await fetch(`${h.url}${path}`)
      assert.equal(res.headers.get('cache-control'), 'no-store', path)
    }
  })
})

/* ------------------------------------------------------------------ the platform surface */

test('livez is static and does not consult a dependency', async () => {
  // Liveness answers one question: should this process be killed and restarted. For a pool the
  // stakes are higher than usual — a restart drops every miner's TCP connection and loses whatever
  // shares are still buffered — so it must not go red because the database blinked.
  await withServer({}, async (h) => {
    const res = await fetch(`${h.url}/livez`)
    assert.equal(res.status, 200)
    assert.equal(((await res.json()) as { ok: boolean }).ok, true)
  })
})

test('readyz reports the probes, and a hard failure is a 503', async () => {
  await withServer({}, async (h) => {
    h.lifecycle.addProbe({
      name: 'template-ltc',
      kind: 'hard',
      check: async () => ({ state: 'fail', detail: 'no fresh ltc template' }),
    })
    const res = await fetch(`${h.url}/readyz`)
    assert.equal(res.status, 503)
    const body = (await res.json()) as { ready: boolean; checks: { name: string; detail?: string }[] }
    assert.equal(body.ready, false)
    assert.equal(body.checks[0]?.name, 'template-ltc')
  })
})

test('the scrape samples the gauges first, and a sampling failure still serves the previous values', async () => {
  // Connection counts and template age must be READ rather than counted, and reading them on a
  // timer would be the one `setInterval` in this repository — the shape rule 8 exists to keep out.
  // A scrape is already periodic, so the scrape is when to sample.
  let sampled = 0
  await withServer({ beforeScrape: async () => void (sampled += 1) }, async (h) => {
    const res = await fetch(`${h.url}/metrics`)
    assert.equal(res.status, 200)
    assert.equal(sampled, 1)
    assert.match(res.headers.get('content-type') ?? '', /text\/plain/)
    assert.match(await res.text(), /http_requests_total/)
  })

  await withServer(
    {
      beforeScrape: async () => {
        throw new Error('the database went away mid-scrape')
      },
    },
    async (h) => {
      // Still 200. A scrape that 500s loses the RED metrics as well as the gauges, which is the
      // opposite of what an operator needs at the moment a dependency is failing.
      const res = await fetch(`${h.url}/metrics`)
      assert.equal(res.status, 200)
      assert.match(await res.text(), /http_requests_total/)
    },
  )
})

test('every answer is counted under its route, and an unmatched path collapses to one label', async () => {
  // Using the raw path would let any caller mint unbounded time series and take the scrape target
  // down with cardinality — on a surface that takes no credential and is reachable by anybody.
  await withServer({}, async (h) => {
    await fetch(`${h.url}/v1/pool`)
    await fetch(`${h.url}/nope-one`)
    await fetch(`${h.url}/nope-two`)
    const rendered = h.metrics.render()
    assert.match(rendered, /route="\/v1\/pool"/)
    assert.match(rendered, /route="unmatched"/)
    assert.ok(!rendered.includes('nope-one'), 'a caller-supplied path became a metric label')
  })
})

/* ------------------------------------------------ the ticket route (micro-org#289) */

const USER: Principal = { kind: 'user', userId: 'user-7', handle: 'someone', roles: ['player'] }

/**
 * A `browserMining` block that verifies one token and mints one predictable ticket.
 *
 * The `Verifier` itself is `@cloudsforge/auth`'s and is tested there against real JWKS; what has to
 * be proved here is which STATUS each of its failures becomes and what reaches the caller with it.
 */
function browserMining(options: { principal?: (token: string) => Promise<Principal>; secret?: string } = {}) {
  const minted: { account: string; worker: string }[] = []
  return {
    minted,
    deps: {
      principal: options.principal ?? (async () => USER),
      mint: (identity: { account: string; worker: string }) => {
        minted.push(identity)
        return {
          secret: options.secret ?? 'the-ticket-value',
          account: identity.account,
          worker: identity.worker,
          expiresAtMs: Date.now() + 60_000,
        }
      },
    },
  }
}

test('a pool with no identity configured answers 503 with a reason, not 404', async () => {
  // The difference matters to the page: 404 says "this pool is old", 503 says "this pool does not do
  // browser mining", and only the second tells a reader to point firmware at the stratum port.
  await withServer({}, async (h) => {
    const res = await fetch(`${h.url}/v1/pool/ticket`, { method: 'POST' })
    assert.equal(res.status, 503)
    const body = (await res.json()) as { error: { code: string; message: string } }
    assert.equal(body.error.code, 'browser_mining_unavailable')
    assert.match(body.error.message, /stratum port/)
  })
})

test('a ticket request with no bearer token is 401 and mints nothing', async () => {
  const browser = browserMining()
  await withServer({ browserMining: browser.deps }, async (h) => {
    const res = await fetch(`${h.url}/v1/pool/ticket`, { method: 'POST' })
    assert.equal(res.status, 401)
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'unauthenticated')
    assert.equal(browser.minted.length, 0)
  })
})

test('a token that does not verify is 401 and the reason is never echoed', async () => {
  // A verification failure's message names key ids, issuers and clock skews. Repeating it to an
  // unauthenticated caller is how a token oracle gets built, so the answer is deliberately flat.
  const browser = browserMining({
    principal: async () => {
      throw new TokenError('no key with kid=abc123 in the issuer key set', 'unknown_kid')
    },
  })
  await withServer({ browserMining: browser.deps }, async (h) => {
    const res = await fetch(`${h.url}/v1/pool/ticket`, {
      method: 'POST',
      headers: { authorization: 'Bearer not-a-real-token' },
    })
    assert.equal(res.status, 401)
    const text = await res.text()
    assert.ok(!text.includes('abc123'), 'the verifier reason reached the caller')
    assert.ok(!text.includes('not-a-real-token'), 'the presented token was reflected')
    assert.equal(browser.minted.length, 0)
  })
})

test('identity being unreachable is 503, never 401', async () => {
  // The distinction `statusFor` exists for. A JWKS that is down is not a caller who is lying, and
  // 401 would tell a signed-in page to sign in again, which cannot possibly help.
  const browser = browserMining({
    principal: async () => {
      throw new VerifierUnavailableError('fetch failed')
    },
  })
  await withServer({ browserMining: browser.deps }, async (h) => {
    const res = await fetch(`${h.url}/v1/pool/ticket`, { method: 'POST', headers: { authorization: 'Bearer t' } })
    assert.equal(res.status, 503)
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'identity_unavailable')
  })
})

test('a service principal is refused with 403, because there is nobody to credit', async () => {
  const browser = browserMining({
    principal: async () => ({ kind: 'service', service: 'hub-web', scopes: ['pool:read'] }),
  })
  await withServer({ browserMining: browser.deps }, async (h) => {
    const res = await fetch(`${h.url}/v1/pool/ticket`, { method: 'POST', headers: { authorization: 'Bearer t' } })
    // 403 and not 401: the credential was perfectly good, and presenting a better one will not help.
    assert.equal(res.status, 403)
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'forbidden')
    assert.equal(browser.minted.length, 0)
  })
})

test('an authenticated user gets a ticket, an account and a worker the SERVER chose', async () => {
  const browser = browserMining()
  await withServer({ browserMining: browser.deps, rows: [{ account: 'cf-00112233445566aa' }] }, async (h) => {
    const res = await fetch(`${h.url}/v1/pool/ticket`, {
      method: 'POST',
      headers: { authorization: 'Bearer t' },
      // A body, deliberately, naming an account that is not theirs. Nothing reads it.
      body: JSON.stringify({ account: 'bc1qsomebodyelse', worker: 'not-mine' }),
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as Record<string, unknown>
    assert.deepEqual(Object.keys(body).sort(), ['account', 'expiresInMs', 'ticket', 'worker'])
    assert.equal(body.ticket, 'the-ticket-value')
    assert.equal(body.account, 'cf-00112233445566aa')
    assert.match(String(body.worker), /^web-[0-9a-f]{6}$/)
    // Elapsed time, not an absolute one: the only clock a browser and this process reliably share.
    assert.ok(typeof body.expiresInMs === 'number' && body.expiresInMs > 0 && body.expiresInMs <= 60_000)
    assert.ok(!JSON.stringify(body).includes('bc1qsomebodyelse'), 'the client named its own account')
  })
})

test('the minted ticket never appears in a log line', async () => {
  // The audit trail for browser mining is the account and the worker. A secret in a log is a secret
  // in the collector, in the retention window and in whatever anybody grep'd it into.
  const browser = browserMining({ secret: 'SECRET-TICKET-VALUE' })
  await withServer({ browserMining: browser.deps, rows: [{ account: 'cf-1122334455667788' }] }, async (h) => {
    const res = await fetch(`${h.url}/v1/pool/ticket`, { method: 'POST', headers: { authorization: 'Bearer t' } })
    assert.equal(res.status, 200)
    const logs = h.logs.join('\n')
    assert.ok(!logs.includes('SECRET-TICKET-VALUE'), 'the ticket was logged')
    // And the token that bought it is not in there either.
    assert.ok(!logs.includes('Bearer'), 'an authorization header reached the log')
    // What IS there: the account, so a browser miner's work can be traced by an operator.
    assert.ok(logs.includes('cf-1122334455667788'), 'the audit trail is missing the account')
  })
})

test('the ticket route is a POST and nothing else', async () => {
  const browser = browserMining()
  await withServer({ browserMining: browser.deps }, async (h) => {
    const res = await fetch(`${h.url}/v1/pool/ticket`, { headers: { authorization: 'Bearer t' } })
    assert.equal(res.status, 404)
    assert.equal(browser.minted.length, 0)
  })
})

/* ------------------------------------------------ the websocket endpoint (micro-org#289) */

test('AN UNPUBLISHED WEBSOCKET ENDPOINT IS NULL, EXACTLY AS THE STRATUM ONE IS', async () => {
  // The same defect micro-org#285 fixed for stratum, refused a second time before it can happen: a
  // published address is configuration or it is nothing. A `wss://` URL assembled from the request
  // Host would be right on this estate by accident and wrong for anybody who runs this pool anywhere
  // else — and wrong in the way that costs a reader an evening blaming their browser.
  await withServer({}, async (h) => {
    const res = await fetch(`${h.url}/v1/pool`, { headers: { host: 'pool.cloudsforge.online' } })
    const body = (await res.json()) as { chains: { websocketEndpoint: unknown }[] }
    assert.equal(body.chains[0]?.websocketEndpoint, null)
    assert.ok(!JSON.stringify(body).includes('wss://'), 'an endpoint was invented from somewhere')
  })
})

test('a published websocket endpoint is reported exactly as configured', async () => {
  await withServer(
    { snapshot: snapshot({ chains: [chainStatus({ websocketEndpoint: 'wss://pool.cloudsforge.online/v1/pool/stratum/ltc' })] }) },
    async (h) => {
      const res = await fetch(`${h.url}/v1/pool`, { headers: { host: 'somewhere.else.example' } })
      const body = (await res.json()) as { chains: { websocketEndpoint: unknown }[] }
      // Byte for byte what the operator configured, with the chain in the path so a page needs to
      // read exactly one field to connect.
      assert.equal(body.chains[0]?.websocketEndpoint, 'wss://pool.cloudsforge.online/v1/pool/stratum/ltc')
    },
  )
})
