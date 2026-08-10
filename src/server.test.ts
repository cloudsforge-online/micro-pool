/**
 * The HTTP surface, over a real socket.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS FILE DID NOT EXIST UNTIL NOW, WHICH IS micro-org#283.
 *
 * `src/server.ts` was the one module in this repository with no test beside it — the route table,
 * the 404 envelope, the request-id echo, the parameter clamps and the entire public response shape
 * were all unasserted. It was opened for the endpoint work of micro-org#285 and micro-org#289 and
 * said so itself: "it is not fixed wholesale here". The remainder was closed on 2026-08-09, which
 * is the rest of #283, and the three things it had left undone were the three that a status code
 * cannot see:
 *
 *   1. the `limit` CLAMP, which is invisible from outside — see `recordingSql` below;
 *   2. the per-chain hashrate constant, which is wrong by a factor of 65,536 or not at all;
 *   3. the bodies of `/blocks`, `/workers` and `/shares`, whose `.map()`s had never run because
 *      the stub answered `[]` to everything — so the string-typed amounts, the nullable fields and
 *      the timestamp formatting were described nowhere in this repository at all.
 *
 * Their only other description in the estate is a hand-copy in `pool-web`, checked by a test that
 * reads this repository's source AS TEXT and SKIPS ITSELF when micro-pool is not checked out beside
 * it. A check that cannot fail is not a check, which is the whole of #283.
 *
 * The SQL underneath remains out of scope here; it is tested in `store.test.ts` against a real
 * database, which is where a query belongs.
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

/**
 * The same stub, keeping the interpolated values of every statement it was handed.
 *
 * `limitParam` CLAMPS rather than refuses, and a clamp is invisible from outside by construction: a
 * caller who asks for 100,000 rows and is given 200 sees a 200 with 200 rows in it, which is exactly
 * what a caller who asked for 200 sees. Asserting the status code therefore asserts nothing about
 * the ceiling, and the ceiling is the only thing standing between an endpoint that takes no
 * credential and a request for every share this pool has ever recorded. So the number that reaches
 * `store.ts` is read off the statement instead.
 *
 * The values are searched rather than indexed by position, because their order is a property of the
 * SQL in `store.ts` and not of the clamp — pinning it here would make this test fail for a query
 * that grew a `where` clause, which is a failure about the wrong file.
 */
function recordingSql(rows: readonly unknown[] = []): { readonly values: unknown[][]; readonly sql: Exec } {
  const values: unknown[][] = []
  const sql = ((_strings: TemplateStringsArray, ...bound: unknown[]) => {
    values.push(bound)
    return Promise.resolve(rows)
  }) as unknown as Exec
  return { values, sql }
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
    // No aux chain, which is the estate's own configuration and the default everywhere. The
    // configured-but-not-committed case has its own test below.
    merged: null,
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
    /** Overrides `rows` when a test needs to read what was bound rather than what came back. */
    sql?: Exec
    beforeScrape?: ServerDeps['beforeScrape']
    browserMining?: ServerDeps['browserMining']
    /**
     * What `index.ts` derives from `CUSTODY_BACKING_CLOSED` and the payout configuration.
     *
     * Overridable here and nowhere in production, for the reason `LedgerPayoutSinkDeps` gives about
     * the interlock: the true branch has to be reachable from a test or nothing checks that the two
     * routes read the dependency instead of writing their own answer. Defaults to `false`, which is
     * what the composition root passes on every deployment that exists.
     */
    payoutsImplemented?: boolean
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
    sql: options.sql ?? stubSql(options.rows ?? []),
    payoutsImplemented: options.payoutsImplemented ?? false,
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

test('A CONFIGURED MERGED CHAIN THAT IS NOT COMMITTING SAYS SO, RATHER THAN LOOKING LIKE ONE THAT IS', async () => {
  // The failure this pins is the whole reason the field exists. A dogecoind in initial block
  // download refuses `createauxblock`, the pool carries on mining Litecoin perfectly, and every
  // number in this response — height, difficulty, hashrate, shares — is identical to the merge-
  // mining case. If `merged` were reported as merely "configured", a page would render "mining
  // DOGE" for a pool that has never committed to a Dogecoin block and never will until the node
  // finishes syncing, and the first person to notice would be a miner who was not paid.
  await withServer(
    {
      snapshot: snapshot({
        chains: [
          chainStatus({
            merged: { chain: 'doge', name: 'Dogecoin', committed: false, unavailability: 'syncing', height: null, networkDifficulty: null },
          }),
        ],
      }),
    },
    async (h) => {
      const res = await fetch(`${h.url}/v1/pool`)
      const body = (await res.json()) as { chains: { merged: Record<string, unknown> | null }[] }
      const merged = body.chains[0]?.merged

      assert.equal(merged?.committed, false, 'configured is not committed, and the response must not conflate them')
      assert.equal(merged?.unavailability, 'syncing', 'the reason is the only actionable part of a false')
      // Named, so a consumer can render "Dogecoin" and credit DOGE without a table of its own.
      assert.equal(merged?.chain, 'doge')
      assert.equal(merged?.name, 'Dogecoin')
      assert.equal(merged?.asset, 'DOGE')
    },
  )
})

test('a merged chain that is committing reports the aux height and difficulty', async () => {
  await withServer(
    {
      snapshot: snapshot({
        chains: [
          chainStatus({
            merged: { chain: 'doge', name: 'Dogecoin', committed: true, unavailability: null, height: 5_015_467, networkDifficulty: 12_345_678.5 },
          }),
        ],
      }),
    },
    async (h) => {
      const res = await fetch(`${h.url}/v1/pool`)
      const body = (await res.json()) as { chains: { merged: Record<string, unknown> | null; networkDifficulty: number }[] }
      const chain = body.chains[0]
      assert.equal(chain?.merged?.committed, true)
      assert.equal(chain?.merged?.unavailability, null)
      assert.equal(chain?.merged?.height, 5_015_467)
      // The aux difficulty is its OWN number and not a copy of the parent's — the pair is the
      // comparison a miner reads, and two equal numbers here would mean the wrong one was copied.
      assert.equal(chain?.merged?.networkDifficulty, 12_345_678.5)
      assert.notEqual(chain?.merged?.networkDifficulty, chain?.networkDifficulty)
    },
  )
})

test('a pool with no merged chain reports null, not an object saying nothing is happening', async () => {
  // Null and `{committed: false}` are different claims: the first is "this pool does not merge-mine",
  // the second is "it does, and is currently not". A consumer that saw an object either way would
  // have to inspect a field to tell whether to render the section at all.
  await withServer({}, async (h) => {
    const res = await fetch(`${h.url}/v1/pool`)
    const body = (await res.json()) as { chains: { merged: unknown }[] }
    assert.equal(body.chains[0]?.merged, null)
  })
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
    // Named, not implied. Every sentence on micro-pool-web that says nothing settles branches on
    // this field rather than on its own markup.
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
      // Present even on a pool that merges nothing, holding null. A key that appeared only when
      // merged mining was configured would make its absence and its falsity the same observation
      // to a consumer reading `body.merged?.committed`.
      'merged',
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

test('BOTH ROUTES REPORT WHETHER THIS POOL PAYS, RATHER THAN ASSERTING THAT IT DOES NOT', async () => {
  // micro-org#302 step 4. `payoutsImplemented` was a hard-coded `false` at four sites — these two
  // routes and two boot lines — so the day the interlock opened, four separate edits stood between
  // a pool that pays and a pool that says so. Worse in the other direction: nothing stopped one of
  // the four being changed alone, and the one clients read is the one that would have lied.
  //
  // Flipping the dependency is the only way to observe that the handlers read it. The value is
  // false in production and stays false — `payoutsImplemented()` in `payouts.ts` ANDs
  // `CUSTODY_BACKING_CLOSED`, which is a source constant — so this drives the branch that a
  // deployment cannot yet reach, exactly as `payouts.test.ts` drives the sink's.
  await withServer({ payoutsImplemented: true }, async (h) => {
    const summary = (await (await fetch(`${h.url}/v1/pool`)).json()) as Record<string, unknown>
    assert.equal(summary['payoutsImplemented'], true, '/v1/pool writes its own answer')

    const blocks = (await (await fetch(`${h.url}/v1/pool/blocks`)).json()) as Record<string, unknown>
    assert.equal(blocks['payoutsImplemented'], true, '/v1/pool/blocks writes its own answer')
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
      // The share routes. A pool with no aux configured refuses `doge` here exactly as it refuses
      // a chain that does not exist, which is the state of the estate today.
      const res = await fetch(`${h.url}/v1/pool/shares?account=ltc1qexample&chain=${chain}`)
      assert.equal(res.status, 400, chain)
      const body = (await res.json()) as { error: { message: string } }
      assert.match(body.error.message, /it serves ltc/)

      const blocks = await fetch(`${h.url}/v1/pool/blocks?chain=${chain}`)
      assert.equal(blocks.status, 400, chain)
      // A different verb, because it is a different set: blocks are per MINED chain and shares are
      // per share chain. The wording is what tells a reader which question they asked.
      assert.match(((await blocks.json()) as { error: { message: string } }).error.message, /it mines ltc/)
    }
  })
})

/* ------------------------------------------------------------------ blocks on a merge-mined chain */

test('A MERGE-MINED CHAIN’S BLOCKS ARE READABLE, OR THE POOL WINS DOGE NOBODY CAN SEE', async () => {
  // `pool_blocks` is keyed by the chain the BLOCK is on and `pool_shares` by the chain the SHARE is
  // on; before this the blocks route took the share chain, so a Dogecoin block this pool won was
  // recorded in a table with no route that could read it back. That is not a missing feature — it
  // is a found block, with a reward and a maturity countdown, invisible to the miner who found it.
  const merged = chainStatus({
    merged: {
      chain: 'doge',
      name: 'Dogecoin',
      committed: true,
      unavailability: null,
      height: 5_015_467,
      networkDifficulty: 12_345_678.5,
    },
  })
  await withServer({ snapshot: snapshot({ chains: [merged] }) }, async (h) => {
    const res = await fetch(`${h.url}/v1/pool/blocks?chain=doge`)
    assert.equal(res.status, 200)
    const body = (await res.json()) as { chain: string; asset: string; decimals: number }
    assert.equal(body.chain, 'doge')
    // The asset and the exponent are the AUX chain's, not the parent's. A body that answered `LTC`
    // for a Dogecoin block would put a reader's reward in the wrong currency at the last step.
    assert.equal(body.asset, 'DOGE')
    assert.equal(body.decimals, 8)

    // And the default is still the parent. A reader who asked no question means the chain they
    // point a miner at, and there is exactly one of those however many aux chains hang off it.
    const fallback = await fetch(`${h.url}/v1/pool/blocks`)
    assert.equal(((await fallback.json()) as { chain: string }).chain, 'ltc')
  })
})

test('a merge-mined chain has no shares and no workers of its own, and says so rather than answering empty', async () => {
  // A miner's Litecoin work is what produced the Dogecoin block, so their DOGE share history IS
  // their LTC share history. Answering `chain=doge` with an empty list would tell them their merged
  // work was never recorded — the one reading that would send them to another pool.
  const merged = chainStatus({
    merged: {
      chain: 'doge',
      name: 'Dogecoin',
      committed: true,
      unavailability: null,
      height: 5_015_467,
      networkDifficulty: 12_345_678.5,
    },
  })
  await withServer({ snapshot: snapshot({ chains: [merged] }) }, async (h) => {
    for (const route of ['shares', 'workers']) {
      const res = await fetch(`${h.url}/v1/pool/${route}?account=ltc1qexample&chain=doge`)
      assert.equal(res.status, 400, route)
      assert.match(((await res.json()) as { error: { message: string } }).error.message, /does not serve doge/)
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

test('an account of exactly the maximum length is accepted, and one character more is not', async () => {
  // The boundary itself, because 96 is the width of `pool_workers.account` and of the check in
  // `session.ts` that decides what may be written there. A ceiling asserted only from outside is a
  // ceiling that can move by one in either direction without anything noticing.
  await withServer({}, async (h) => {
    const at = await fetch(`${h.url}/v1/pool/workers?account=${'a'.repeat(96)}`)
    assert.equal(at.status, 200)
    const over = await fetch(`${h.url}/v1/pool/workers?account=${'a'.repeat(97)}`)
    assert.equal(over.status, 400)
  })
})

test('a refusal carries the same envelope and the same request id as everything else', async () => {
  // The 404 envelope is asserted below; this is the 400 one, which is the answer a miner actually
  // meets — a mistyped account or a chain this pool does not serve — and it is the one whose id a
  // support conversation is conducted through.
  await withServer({}, async (h) => {
    const res = await fetch(`${h.url}/v1/pool/shares`, { headers: { 'x-request-id': 'req-support-1' } })
    assert.equal(res.status, 400)
    const body = (await res.json()) as { error: { code: string; message: string; requestId: string } }
    assert.deepEqual(Object.keys(body.error).sort(), ['code', 'message', 'requestId'])
    assert.equal(body.error.code, 'bad_request')
    // Echoed in the header AND repeated in the body, so a reader who can only see what their
    // browser rendered can still quote the thing that joins to the log line.
    assert.equal(res.headers.get('x-request-id'), 'req-support-1')
    assert.equal(body.error.requestId, 'req-support-1')
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

test('THE CEILING IS THE NUMBER THAT REACHES THE DATABASE, NOT THE ONE THE STATUS CODE IMPLIES', async () => {
  // The status code cannot see this and neither can the body: a clamped request and an honest one
  // are the same 200 with the same rows in it. The only observable difference is the number bound
  // into the statement, so that is what is read. micro-org#283 exists because a check that cannot
  // fail is not a check, and "the clamp returns 200" is exactly such a check.
  const blocks = recordingSql()
  await withServer({ sql: blocks.sql }, async (h) => {
    assert.equal((await fetch(`${h.url}/v1/pool/blocks?limit=100000`)).status, 200)
  })
  assert.ok(blocks.values[0]?.includes(200), `blocks did not ask for 200: ${JSON.stringify(blocks.values[0])}`)
  assert.ok(!blocks.values[0]?.includes(100_000), 'the caller-supplied limit reached the database')

  const shares = recordingSql()
  await withServer({ sql: shares.sql }, async (h) => {
    assert.equal((await fetch(`${h.url}/v1/pool/shares?account=ltc1qexample&limit=100000`)).status, 200)
  })
  assert.ok(shares.values[0]?.includes(1_000), `shares did not ask for 1000: ${JSON.stringify(shares.values[0])}`)
  assert.ok(!shares.values[0]?.includes(100_000), 'the caller-supplied limit reached the database')
})

test('a caller who asks for no limit gets the documented default, not the ceiling', async () => {
  // Two different numbers, and the difference is a page's worth of rows. A default that had drifted
  // to the ceiling would be invisible to every other assertion in this file.
  const blocks = recordingSql()
  await withServer({ sql: blocks.sql }, async (h) => {
    await fetch(`${h.url}/v1/pool/blocks`)
  })
  assert.ok(blocks.values[0]?.includes(50), `blocks default is not 50: ${JSON.stringify(blocks.values[0])}`)

  const shares = recordingSql()
  await withServer({ sql: shares.sql }, async (h) => {
    await fetch(`${h.url}/v1/pool/shares?account=ltc1qexample`)
  })
  assert.ok(shares.values[0]?.includes(100), `shares default is not 100: ${JSON.stringify(shares.values[0])}`)
})

/* ------------------------------------------- the three list bodies, which nothing else looks at */

/**
 * Everything below drives raw rows — snake_case, `bigint` columns already `::text` as postgres.js
 * hands them over — through the stub, because the composition between `store.ts` and the wire is
 * the part of `server.ts` that no other test in this estate reaches.
 *
 * The stub in this file answered `[]` for its whole life until 2026-08-09, which meant every
 * `.map()` in `server.ts` ran zero times: the string-typed amounts, the nullable fields and the
 * timestamp formatting were all unasserted, and the only description of them anywhere was a
 * hand-copy in `pool-web` guarded by a grep that skips itself when this repository is not checked
 * out beside it. micro-org#283 and micro-org#287.
 */

test('A REWARD CROSSES THE WIRE AS A STRING, BECAUSE JSON HAS NO INTEGER WIDE ENOUGH FOR MONEY', async () => {
  // 9007199254740993 is 2^53 + 1 — the first whole number a JSON number cannot represent. It is
  // used here rather than a plausible block reward precisely because a `Number()` in the path is
  // invisible for realistic values and silently wrong for large ones, and a subsidy in litoshi on a
  // chain with 8 decimals has room to grow into that range.
  const rows = [
    {
      height: 2_912_004,
      hash: '0000000000000000000abc',
      found_at: new Date('2026-08-09T10:00:00.000Z'),
      reward: '9007199254740993',
      network_difficulty_units: '3451211950000000',
      submit_status: 'accepted',
      submit_detail: null,
      maturity_status: 'pending',
      confirmations: 7,
    },
    {
      height: 2_912_003,
      hash: '0000000000000000000def',
      found_at: new Date('2026-08-09T09:45:30.500Z'),
      reward: '625000000',
      network_difficulty_units: '3451211950000000',
      submit_status: 'rejected',
      submit_detail: 'inconclusive',
      // Migration 4 back-fills every non-accepted block to `orphaned`: the node refused it, so it
      // was never on the chain and there is nothing for the watcher to go and confirm.
      maturity_status: 'orphaned',
      confirmations: null,
    },
  ]
  await withServer({ rows }, async (h) => {
    const res = await fetch(`${h.url}/v1/pool/blocks`)
    assert.equal(res.status, 200)
    const text = await res.text()
    // Read as text first: a `reward` that had been through `Number()` would still round-trip through
    // `JSON.parse` into something that compares equal to itself, and the loss would never show.
    assert.ok(text.includes('"reward":"9007199254740993"'), text)
    const body = JSON.parse(text) as {
      chain: string
      asset: string
      decimals: number
      payoutsImplemented: boolean
      blocks: readonly Record<string, unknown>[]
    }
    assert.deepEqual(Object.keys(body).sort(), ['asset', 'blocks', 'chain', 'decimals', 'payoutsImplemented'])
    assert.equal(body.chain, 'ltc')
    assert.equal(body.asset, 'LTC')
    assert.equal(body.decimals, 8)
    // The second place this reaches a client, and the one a block list makes most tempting to drop
    // — a page showing found blocks is exactly where a reader infers a payment.
    assert.equal(body.payoutsImplemented, false)

    assert.deepEqual(Object.keys(body.blocks[0] ?? {}).sort(), [
      'confirmations',
      'foundAt',
      'hash',
      'height',
      'maturityStatus',
      'networkDifficulty',
      'reward',
      'submitDetail',
      'submitStatus',
    ])
    assert.equal(typeof body.blocks[0]?.reward, 'string')
    // Units on disk, difficulty on the wire: 3451211950000000 / 1e8.
    assert.equal(body.blocks[0]?.networkDifficulty, 34_512_119.5)
    assert.equal(body.blocks[0]?.foundAt, '2026-08-09T10:00:00.000Z')
    // Null means the node said nothing beyond its verdict, NOT that the block was fine.
    assert.equal(body.blocks[0]?.submitDetail, null)
    assert.equal(body.blocks[1]?.submitStatus, 'rejected')
    assert.equal(body.blocks[1]?.submitDetail, 'inconclusive')

    // The submission verdict and the maturity verdict are two different claims and the response
    // carries both. An accepted block is NOT yet a block whose reward exists — micro-org#302 — and a
    // reader that only had `submitStatus` would have no way to tell an accepted-and-buried block
    // from an accepted-then-reorged-away one.
    assert.equal(body.blocks[0]?.submitStatus, 'accepted')
    assert.equal(body.blocks[0]?.maturityStatus, 'pending')
    assert.equal(body.blocks[0]?.confirmations, 7)
    assert.equal(body.blocks[1]?.maturityStatus, 'orphaned')
    assert.equal(body.blocks[1]?.confirmations, null)
  })
})

test('A SHARE ID IS A STRING FOR THE SAME REASON, AND A WORKER THAT NEVER SET A DIFFICULTY IS NULL', async () => {
  const rows = [
    {
      id: '9007199254740993',
      worker: 'rig-1',
      job_id: '0f',
      height: 2_912_004,
      difficulty_units: '6553600000000',
      achieved_units: '9830400000000',
      is_block: false,
      created_at: new Date('2026-08-09T10:00:00.000Z'),
    },
  ]
  await withServer({ rows }, async (h) => {
    const res = await fetch(`${h.url}/v1/pool/shares?account=ltc1qexample`)
    assert.equal(res.status, 200)
    const text = await res.text()
    // `pool_shares.id` is a bigserial. A pool recording a share a second passes 2^53 in about 285
    // million years, so this is not a deadline — it is that the column's type says bigint and the
    // wire ought not to quietly disagree with it.
    assert.ok(text.includes('"id":"9007199254740993"'), text)
    const body = JSON.parse(text) as { chain: string; account: string; shares: readonly Record<string, unknown>[] }
    assert.deepEqual(Object.keys(body).sort(), ['account', 'chain', 'shares'])
    assert.equal(body.account, 'ltc1qexample')
    assert.deepEqual(Object.keys(body.shares[0] ?? {}).sort(), [
      'achievedDifficulty',
      'createdAt',
      'creditedDifficulty',
      'height',
      'id',
      'isBlock',
      'jobId',
      'worker',
    ])
    assert.equal(typeof body.shares[0]?.id, 'string')
    // Credited and achieved are reported separately and both in difficulty, not units, because the
    // point of this route is that a miner can line it up against their own log.
    assert.equal(body.shares[0]?.creditedDifficulty, 65_536)
    assert.equal(body.shares[0]?.achievedDifficulty, 98_304)
    assert.equal(body.shares[0]?.createdAt, '2026-08-09T10:00:00.000Z')
  })
})

test('a worker with no recorded difficulty reports null, which is not the same as zero', async () => {
  // `last_difficulty` is null for a worker this pool has seen but never set a difficulty on — a
  // connection that authorised and then went quiet. Rendering that as 0 would tell its owner their
  // miner is being credited nothing, when the truth is that nothing has been decided yet.
  const rows = [
    {
      id: '1',
      account: 'ltc1qexample',
      // The empty string is a real worker name here: `parseWorkerName` in `session.ts` accepts an
      // account with no `.suffix` and stores the worker as ''. A page that treated a falsy worker as
      // missing would drop the single most common row this route returns.
      worker: '',
      last_seen_at: new Date('2026-08-09T10:00:00.000Z'),
      last_difficulty: null,
      recent_shares: '0',
      recent_units: '0',
    },
    {
      id: '2',
      account: 'ltc1qexample',
      worker: 'rig-2',
      last_seen_at: new Date('2026-08-09T09:59:00.000Z'),
      last_difficulty: '6553600000000',
      recent_shares: '12',
      recent_units: '78643200000000',
    },
  ]
  await withServer({ rows }, async (h) => {
    const res = await fetch(`${h.url}/v1/pool/workers?account=ltc1qexample`)
    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      chain: string
      account: string
      windowSeconds: number
      workers: readonly Record<string, unknown>[]
    }
    assert.deepEqual(Object.keys(body).sort(), ['account', 'chain', 'windowSeconds', 'workers'])
    assert.equal(body.windowSeconds, 600)
    assert.deepEqual(Object.keys(body.workers[0] ?? {}).sort(), [
      'difficulty',
      'hashrateEstimate',
      'lastSeenAt',
      'sharesInWindow',
      'worker',
    ])
    assert.equal(body.workers[0]?.worker, '')
    assert.equal(body.workers[0]?.difficulty, null)
    assert.equal(body.workers[0]?.hashrateEstimate, 0)
    assert.equal(body.workers[0]?.lastSeenAt, '2026-08-09T10:00:00.000Z')
    assert.equal(body.workers[1]?.difficulty, 65_536)
    assert.equal(body.workers[1]?.sharesInWindow, 12)
    // 786,432 difficulty of scrypt work over the 600-second window, at 65537.00001525879 hashes per
    // unit of scrypt difficulty. Composed here rather than restated as a literal, because the thing
    // under test is that the CHAIN'S constant is the one used — see the test below.
    assert.ok(
      Math.abs((body.workers[1]?.hashrateEstimate as number) - (786_432 * 65_537.00001525879) / 600) < 1,
      String(body.workers[1]?.hashrateEstimate),
    )
  })
})

test('A HASHRATE IS COMPOSED WITH THE CHAIN’S OWN CONSTANT, NOT WITH SHA-256D FOR EVERYONE', async () => {
  // The same credited work on scrypt and on sha256d is not the same hashrate; it differs by the
  // ratio of the two chains' difficulty-1 targets. A `hashesPerDifficulty` that had been fixed to
  // one algorithm would report every Litecoin miner 65,536 times off — the exact failure `store.ts`
  // refuses to make by returning units raw, undone one layer higher up.
  //
  // Measured 2026-08-09: sha256d = 4295032833.000015, scrypt = 65537.00001525879, ratio
  // 65536.00000000023. NOT exactly 65536 in IEEE-754, so this is a tolerance and not an equality.
  const both = snapshot({
    chains: [chainStatus(), chainStatus({ chain: 'btc', name: 'Bitcoin', algorithm: 'sha256d', stratumPort: 3333 })],
  })
  // One `chainActivity` row, answered identically for both chains, so the ONLY difference between
  // the two hashrates that come back is the constant `server.ts` chose.
  await withServer({ snapshot: both, rows: [{ shares: '10', units: '6553600000000', workers: '1' }] }, async (h) => {
    const body = (await (await fetch(`${h.url}/v1/pool`)).json()) as {
      chains: readonly { chain: string; hashrateEstimate: number }[]
    }
    const ltc = body.chains.find((c) => c.chain === 'ltc')?.hashrateEstimate ?? 0
    const btc = body.chains.find((c) => c.chain === 'btc')?.hashrateEstimate ?? 0
    assert.ok(ltc > 0 && btc > 0, `${ltc} ${btc}`)
    assert.ok(Math.abs(btc / ltc - 65_536) < 1, `ratio was ${btc / ltc}`)
    // And the scrypt one is right in absolute terms too, so that swapping BOTH constants for one
    // wrong constant still reddens this.
    assert.ok(Math.abs(ltc - (65_536 * 65_537.00001525879) / 600) < 1, String(ltc))
  })
})

test('every reply declares its own length', async () => {
  // `send` writes `content-length` itself rather than letting Node chunk the response. Losing it
  // costs nothing visible in a browser and breaks the plainest possible client — a `curl` behind a
  // proxy that will not buffer — which is what this service's own README tells a reader to use.
  await withServer({}, async (h) => {
    for (const path of ['/livez', '/v1/pool', '/v1/pool/blocks', '/nope']) {
      const res = await fetch(`${h.url}${path}`)
      const length = res.headers.get('content-length')
      assert.ok(length !== null, `${path} declared no length`)
      assert.equal(Number(length), Buffer.byteLength(await res.text()), path)
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
