import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * Configuration, including the two refusals that are the point of this file.
 *
 * A pool has more ways to be misconfigured into silently doing nothing useful than most services,
 * because most of its configuration names a chain and every chain-shaped mistake produces work that
 * looks fine and is worth nothing: the wrong network, a payout address nobody holds the key to, two
 * chains fighting over one port, or Dogecoin — which cannot be mined this way at all and whose
 * refusal has to say so rather than reading as a typo.
 *
 * The other thing tested here is a negative: **no error this file raises ever contains a node URL.**
 * The endpoints carry HTTP Basic userinfo in this estate, and an `EnvError` message is the single
 * most reliably logged string in a process that fails to start.
 *
 * The import is itself a test, in the estate's usual way: `env.ts` validates eagerly and calls
 * `process.exit(1)` on a bad configuration, so if `BASE` were insufficient this file would not run.
 * Everything after that goes through `loadEnv`, which is pure over its source.
 */
const BASE: Record<string, string> = {
  POOL_DATABASE_URL: 'postgres://cloudsforge@127.0.0.1:5432/pool',
  POOL_CHAINS: 'btc',
  POOL_BTC_NODE_URL: 'http://rpcuser:rpcpassword@bitcoin:8332/',
  POOL_BTC_PAYOUT_ADDRESS: 'bc1qexampleaddressexampleaddressexampleaddr',
  // No default anywhere in the repository, on purpose. See `Env.feeBasisPoints`.
  POOL_FEE_BASIS_POINTS: '100',
}
for (const [key, value] of Object.entries(BASE)) process.env[key] = value

const { EnvError, SERVICE, env, loadEnv, stratumEndpointOf, websocketEndpointOf } = await import('./env.ts')

const LTC: Record<string, string> = {
  POOL_LTC_NODE_URL: 'http://rpcuser:rpcpassword@litecoin:9332/',
  POOL_LTC_PAYOUT_ADDRESS: 'ltc1qexampleaddressexampleaddressexampleadd',
}

/* ------------------------------------------------------------------ the happy path */

test('a complete environment loads, and importing the module did not exit', () => {
  assert.equal(env.databaseUrl, BASE['POOL_DATABASE_URL'])
  assert.equal(SERVICE, 'pool')
})

test('the HTTP port defaults to this service own', () => {
  // 4146 is derived from this repository's position in the org registry, and `.env.example` restates
  // it. CI compares the two, because a default that drifts from the example is a service that binds
  // a port the compose file does not publish.
  assert.equal(loadEnv(BASE).port, 4146)
  assert.equal(loadEnv({ ...BASE, PORT: '8080' }).port, 8080)
})

test('one chain loads with its own stratum port and starting difficulty', () => {
  const loaded = loadEnv(BASE, 'host-1')
  assert.equal(loaded.chains.length, 1)
  const btc = loaded.chains[0]
  assert.equal(btc?.chain, 'btc')
  assert.equal(btc?.stratumPort, 3333)
  assert.equal(btc?.initialDifficulty, 65_536)
  assert.equal(loaded.instanceId, 'host-1')
  assert.equal(loaded.network, 'mainnet')
})

test('two chains get two ports and two very different starting difficulties', () => {
  // The gap is a fact about the hardware: a SHA-256d ASIC does terahashes and a scrypt miner is
  // thousands of times slower in share terms. A shared default would flood the pool from one and
  // starve the other.
  const loaded = loadEnv({ ...BASE, ...LTC, POOL_CHAINS: 'btc,ltc' })
  assert.deepEqual(
    loaded.chains.map((chain) => [chain.chain, chain.stratumPort]),
    [
      ['btc', 3333],
      ['ltc', 3334],
    ],
  )
  assert.equal(loaded.chains[1]?.initialDifficulty, 512)
})

test('chain names are trimmed and case-folded, because a compose file is typed by hand', () => {
  const loaded = loadEnv({ ...BASE, ...LTC, POOL_CHAINS: ' BTC , Ltc ' })
  assert.deepEqual(
    loaded.chains.map((chain) => chain.chain),
    ['btc', 'ltc'],
  )
})

test('the defaults that have one are the ones a deployment need not think about', () => {
  const loaded = loadEnv(BASE)
  assert.equal(loaded.stratumBind, '0.0.0.0')
  assert.equal(loaded.coinbaseTag, '/cloudsforge/')
  assert.equal(loaded.pplnsMultiplier, 2)
  assert.equal(loaded.shareRetentionDays, 30)
  assert.equal(loaded.templatePollMs, 10_000)
  assert.equal(loaded.vardiffSharesPerMinute, 12)
  assert.equal(loaded.databasePoolMax, 10)
})

/* ------------------------------------------- the endpoint a miner dials, which is not derivable */

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE DEFAULT IS "NOTHING IS PUBLISHED", AND IT IS NULL RATHER THAN A PLAUSIBLE STRING.
 *
 * This is the half of a stratum endpoint the service cannot observe about itself. The bind is an
 * interface, the bound port is the inside of the deploy's port mapping, and the hostname on an HTTP
 * request is a different protocol on a different port that — on this estate, through a Cloudflare
 * Tunnel and Traefik — provably does not carry raw TCP at all.
 *
 * The consequence of guessing was measured: with no such field, micro-pool-web derived the host
 * from `window.location.hostname` and published `stratum+tcp://pool.<apex>:3334` on a page anybody
 * could read. That connects to nothing, and its reader debugs their own hardware. micro-org#285.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
test('NOTHING IS ADVERTISED UNTIL SOMEBODY SAYS SO, AND THE ABSENCE IS NULL', () => {
  const loaded = loadEnv(BASE)
  assert.equal(loaded.stratumPublicHost, null)
  assert.equal(loaded.chains[0]?.stratumPublicPort, null)
  // Not the bind, which is an interface and not a name.
  assert.notEqual(loaded.stratumPublicHost, loaded.stratumBind)
  // And composing them yields nothing rather than half of something.
  assert.equal(stratumEndpointOf(loaded.stratumPublicHost, loaded.chains[0] as never), null)
})

test('a published endpoint is both halves, per chain, and neither half is the bound port', () => {
  const loaded = loadEnv({
    ...BASE,
    ...LTC,
    POOL_CHAINS: 'btc,ltc',
    POOL_STRATUM_PUBLIC_HOST: 'stratum.example.com',
    // Deliberately NOT the bound ports. This is the shape the estate's own compose file produces:
    // it publishes `${POOL_LTC_STRATUM_PORT:-3334}:3334`, so the host side and the container side
    // are separate numbers and only one of them is dialable from outside.
    POOL_BTC_STRATUM_PUBLIC_PORT: '4333',
    POOL_LTC_STRATUM_PUBLIC_PORT: '4334',
  })
  assert.equal(loaded.stratumPublicHost, 'stratum.example.com')
  assert.deepEqual(
    loaded.chains.map((chain) => [chain.stratumPort, chain.stratumPublicPort]),
    [
      [3333, 4333],
      [3334, 4334],
    ],
  )
  assert.deepEqual(stratumEndpointOf(loaded.stratumPublicHost, loaded.chains[0] as never), {
    host: 'stratum.example.com',
    port: 4333,
  })
})

test('one chain may be published while another stays on the LAN', () => {
  // Not an oversight to be corrected into symmetry: an estate that exposes Litecoin to strangers
  // and keeps Bitcoin on its own network is a configuration. The unpublished chain reports null and
  // the console tells its reader to ask, which is the same honest screen as a pool with no endpoint
  // at all.
  const loaded = loadEnv({
    ...BASE,
    ...LTC,
    POOL_CHAINS: 'btc,ltc',
    POOL_STRATUM_PUBLIC_HOST: 'stratum.example.com',
    POOL_LTC_STRATUM_PUBLIC_PORT: '3334',
  })
  assert.equal(stratumEndpointOf(loaded.stratumPublicHost, loaded.chains[0] as never), null)
  assert.deepEqual(stratumEndpointOf(loaded.stratumPublicHost, loaded.chains[1] as never), {
    host: 'stratum.example.com',
    port: 3334,
  })
})

test('HALF AN ENDPOINT IS REFUSED AT BOOT RATHER THAN HALF-ADVERTISED', () => {
  // Both of these are a decision somebody started and did not finish, and both would leave a pool
  // advertising nothing while its operator believed it had published something. Boot is the last
  // moment the person who typed it is still watching.
  assert.throws(
    () => loadEnv({ ...BASE, POOL_STRATUM_PUBLIC_HOST: 'stratum.example.com' }),
    (err: Error) => err instanceof EnvError && /no chain has a POOL_<CHAIN>_STRATUM_PUBLIC_PORT/.test(err.message),
  )
  assert.throws(
    () => loadEnv({ ...BASE, POOL_BTC_STRATUM_PUBLIC_PORT: '3333' }),
    (err: Error) =>
      err instanceof EnvError &&
      err.message.includes('POOL_BTC_STRATUM_PUBLIC_PORT') &&
      err.message.includes('POOL_STRATUM_PUBLIC_HOST'),
  )
})

test('the published port is never defaulted from the bound one', () => {
  // The secondary finding of micro-org#285, pinned. A default that is usually right is how an
  // operator who remaps the port ends up advertising the one nobody can reach — and it would be
  // invisible, because the number rendered would look exactly like the number they configured
  // somewhere else.
  const loaded = loadEnv({ ...BASE, POOL_BTC_STRATUM_PORT: '3333' })
  assert.equal(loaded.chains[0]?.stratumPort, 3333)
  assert.equal(loaded.chains[0]?.stratumPublicPort, null)
})

test('a public host that is really a URL, or carries a port, is refused', () => {
  // Both compose a connection string that looks complete and connects to nothing: `stratum+tcp://`
  // twice over, or `host:3334:3334`. Neither fails here — they fail in a stranger's firmware, which
  // is the one place nobody involved can see them.
  for (const bad of [
    'stratum+tcp://stratum.example.com',
    'http://stratum.example.com',
    'stratum.example.com/pool',
    'user@stratum.example.com',
    'stratum.example.com:3334',
  ]) {
    assert.throws(
      () => loadEnv({ ...BASE, POOL_STRATUM_PUBLIC_HOST: bad, POOL_BTC_STRATUM_PUBLIC_PORT: '3333' }),
      (err: Error) => err instanceof EnvError,
      bad,
    )
  }
})

test('an IPv6 literal is a hostname, not a host:port', () => {
  // The port check is "exactly one colon". An address literal has at least two, so it survives it —
  // and an estate reachable only over IPv6 is a deployment, not a corner case.
  const loaded = loadEnv({
    ...BASE,
    POOL_STRATUM_PUBLIC_HOST: '2001:db8::1',
    POOL_BTC_STRATUM_PUBLIC_PORT: '3333',
  })
  assert.equal(loaded.stratumPublicHost, '2001:db8::1')
})

/* ------------------------------------------------------------------ the named refusals */

test('dogecoin is refused with the reason, not with "unknown chain"', () => {
  // The whole argument of `chains.ts`, reached through the variable an operator would actually set.
  // "Unknown chain" reads as a typo and invites the reader to add a row to a table; that row is a
  // pool mining Dogecoin blocks the network rejects.
  assert.throws(
    () => loadEnv({ ...BASE, POOL_CHAINS: 'btc,doge' }),
    (err: unknown) => {
      assert.ok(err instanceof EnvError)
      assert.match((err as Error).message, /refuses to mine/)
      assert.match((err as Error).message, /AuxPoW/)
      assert.match((err as Error).message, /merge-mined/)
      return true
    },
  )
})

test('a chain that is neither mined nor refused points at where the refusals live', () => {
  assert.throws(
    () => loadEnv({ ...BASE, POOL_CHAINS: 'xmr' }),
    (err: unknown) => {
      assert.ok(err instanceof EnvError)
      assert.match((err as Error).message, /does not implement/)
      assert.match((err as Error).message, /src\/chains\.ts/)
      return true
    },
  )
})

test('the same chain listed twice is refused rather than deduplicated', () => {
  // Deduplicating would start one listener and leave an operator convinced they had configured two.
  assert.throws(() => loadEnv({ ...BASE, POOL_CHAINS: 'btc,btc' }), /lists btc twice/)
})

test('two chains on one stratum port is refused, with the reason', () => {
  // Each chain needs its own listener: the port is how a miner says which chain it is mining, since
  // Stratum v1 carries no chain identifier anywhere in the protocol.
  assert.throws(
    () => loadEnv({ ...BASE, ...LTC, POOL_CHAINS: 'btc,ltc', POOL_LTC_STRATUM_PORT: '3333' }),
    /same stratum port/,
  )
})

test('a fee with no value configured refuses to start', () => {
  // §7.1 records that the pool fee has not been chosen. A default of 0 would choose "free" and 200
  // would choose "2%", either of them answering an open product question by omission in the file
  // least likely to be read by whoever eventually answers it.
  const { POOL_FEE_BASIS_POINTS: _omitted, ...withoutFee } = BASE
  assert.throws(() => loadEnv(withoutFee), /POOL_FEE_BASIS_POINTS is required/)
  assert.throws(() => loadEnv({ ...BASE, POOL_FEE_BASIS_POINTS: '10001' }), /between 0 and 10000/)
  assert.throws(() => loadEnv({ ...BASE, POOL_FEE_BASIS_POINTS: '1.5' }), /whole number/)
  // Zero is a legal answer — it is just not an answer this file is willing to give on anyone's
  // behalf.
  assert.equal(loadEnv({ ...BASE, POOL_FEE_BASIS_POINTS: '0' }).feeBasisPoints, 0)
})

test('every per-chain variable is required for every configured chain', () => {
  for (const name of ['POOL_LTC_NODE_URL', 'POOL_LTC_PAYOUT_ADDRESS']) {
    const source: Record<string, string> = { ...BASE, ...LTC, POOL_CHAINS: 'btc,ltc' }
    delete source[name]
    assert.throws(() => loadEnv(source), new RegExp(`${name} is required`), `${name} was optional`)
  }
})

test('an over-long coinbase tag is refused at boot rather than at the first block', () => {
  // The scriptSig it lives in is capped at 100 bytes by consensus and shares that space with the
  // BIP34 height and the extranonce. An over-long tag does not truncate; it makes the coinbase
  // invalid, which is a block the network throws away.
  assert.throws(() => loadEnv({ ...BASE, POOL_COINBASE_TAG: 'x'.repeat(33) }), /at most 32 bytes/)
  assert.equal(loadEnv({ ...BASE, POOL_COINBASE_TAG: 'x'.repeat(32) }).coinbaseTag, 'x'.repeat(32))
  // Measured in BYTES, not characters: a tag of emoji is four bytes each on the chain.
  assert.throws(() => loadEnv({ ...BASE, POOL_COINBASE_TAG: '⛏'.repeat(11) }), /at most 32 bytes/)
})

test('the network is one of two names and nothing else', () => {
  assert.equal(loadEnv({ ...BASE, POOL_NETWORK: 'testnet' }).network, 'testnet')
  assert.throws(() => loadEnv({ ...BASE, POOL_NETWORK: 'regtest' }), /mainnet or testnet/)
})

test('an empty POOL_CHAINS is refused', () => {
  assert.throws(() => loadEnv({ ...BASE, POOL_CHAINS: '' }), /POOL_CHAINS is required/)
  assert.throws(() => loadEnv({ ...BASE, POOL_CHAINS: ' , , ' }), /POOL_CHAINS/)
})

test('the numeric ranges are enforced at both ends', () => {
  assert.throws(() => loadEnv({ ...BASE, POOL_BTC_STRATUM_PORT: '0' }), /between 1 and 65535/)
  assert.throws(() => loadEnv({ ...BASE, POOL_BTC_STRATUM_PORT: '70000' }), /between 1 and 65535/)
  assert.throws(() => loadEnv({ ...BASE, POOL_BTC_INITIAL_DIFFICULTY: '0' }), /between 0.001 and/)
  assert.throws(() => loadEnv({ ...BASE, POOL_DATABASE_POOL_MAX: '500' }), /between 1 and 100/)
  assert.throws(() => loadEnv({ ...BASE, POOL_TEMPLATE_POLL_MS: '100' }), /between 1000 and 120000/)
  assert.throws(() => loadEnv({ ...BASE, POOL_SHARE_RETENTION_DAYS: '0' }), /between 1 and 3650/)
  assert.throws(() => loadEnv({ ...BASE, LOG_LEVEL: 'verbose' }), /debug, info, warn, error/)
})

/* ------------------------------------------------------------------ the credential */

test('a bad node URL is refused without the URL appearing in the message', () => {
  // The one assertion in this file that is about secrecy rather than correctness. A node RPC URL
  // carries HTTP Basic userinfo, and the error raised when it is malformed is the string most
  // certain to end up in a log aggregator.
  const secret = 'http://alice:s3cr3t-in-the-url@bitcoin:8332 with a space'
  assert.throws(
    () => loadEnv({ ...BASE, POOL_BTC_NODE_URL: secret }),
    (err: unknown) => {
      const message = (err as Error).message
      assert.match(message, /POOL_BTC_NODE_URL is not a valid URL/)
      assert.ok(!message.includes('s3cr3t-in-the-url'), `the password was echoed: ${message}`)
      assert.ok(!message.includes('alice'), `the username was echoed: ${message}`)
      return true
    },
  )
})

test('a node URL on the wrong scheme is refused, also without echoing it', () => {
  assert.throws(
    () => loadEnv({ ...BASE, POOL_BTC_NODE_URL: 'ftp://bob:hunter2@bitcoin:8332/' }),
    (err: unknown) => {
      const message = (err as Error).message
      assert.match(message, /must be an http or https URL/)
      assert.ok(!message.includes('hunter2'))
      return true
    },
  )
})

test('no refusal anywhere in this file echoes a configured value that could be a credential', () => {
  // Swept rather than spot-checked. Every failure path reachable from a source built out of BASE is
  // driven, and the password planted in the node URL must appear in none of the messages.
  const poisoned = { ...BASE, POOL_BTC_NODE_URL: 'http://alice:s3cr3t@bitcoin:8332/' }
  const breakages: Record<string, string>[] = [
    { POOL_CHAINS: 'doge' },
    { POOL_CHAINS: 'xmr' },
    { POOL_CHAINS: 'btc,btc' },
    { POOL_NETWORK: 'regtest' },
    { LOG_LEVEL: 'verbose' },
    { POOL_COINBASE_TAG: 'x'.repeat(64) },
    { POOL_FEE_BASIS_POINTS: '99999' },
    { POOL_BTC_STRATUM_PORT: '0' },
    { POOL_BTC_INITIAL_DIFFICULTY: 'nope' },
    { POOL_BTC_NODE_URL: 'not a url at all' },
    { POOL_BTC_NODE_URL: 'ftp://alice:s3cr3t@bitcoin:8332/' },
    { POOL_STRATUM_PUBLIC_HOST: 'stratum.example.com' },
    { POOL_BTC_STRATUM_PUBLIC_PORT: '3333' },
    { POOL_STRATUM_PUBLIC_HOST: 'http://alice:s3cr3t@stratum.example.com' },
    { POOL_STRATUM_PUBLIC_HOST: 'stratum.example.com', POOL_BTC_STRATUM_PUBLIC_PORT: '70000' },
    // micro-org#289's own paths into this sweep. `IDENTITY_JWKS_URL` carries no credential today,
    // but it goes through the same URL helper as the node endpoints and the day somebody puts Basic
    // auth in front of a key set is not the day to discover that the refusal prints it.
    { IDENTITY_JWKS_URL: 'https://alice:s3cr3t@identity.example.com/jwks' },
    { IDENTITY_ISSUER: 'https://identity.example.com' },
    { IDENTITY_JWKS_URL: 'ftp://alice:s3cr3t@identity.example.com/jwks', IDENTITY_ISSUER: 'https://id.example' },
    { POOL_WEBSOCKET_PUBLIC_ORIGIN: 'wss://alice:s3cr3t@pool.example.com' },
    { POOL_WEBSOCKET_PUBLIC_ORIGIN: 'https://pool.example.com' },
    { POOL_WEBSOCKET_PUBLIC_ORIGIN: 'wss://pool.example.com' },
  ]
  let raised = 0
  for (const breakage of breakages) {
    try {
      loadEnv({ ...poisoned, ...breakage })
      assert.fail(`${JSON.stringify(breakage)} did not raise`)
    } catch (err) {
      assert.ok(err instanceof EnvError, `${JSON.stringify(breakage)} raised something else`)
      raised += 1
      assert.ok(!(err as Error).message.includes('s3cr3t'), `a credential leaked: ${(err as Error).message}`)
    }
  }
  assert.equal(raised, breakages.length)
})

/* ------------------------------------------------ browser mining (micro-org#289) */

const IDENTITY: Record<string, string> = {
  IDENTITY_JWKS_URL: 'https://identity.cloudsforge.online/.well-known/jwks.json',
  IDENTITY_ISSUER: 'https://identity.cloudsforge.online',
}

test('identity is optional, and its absence is a supported mode rather than a degraded one', () => {
  // The estate's own pool ran with no identity at all from 2.5.7 until this change, and anybody who
  // runs this pool outside an estate has no identity to configure. Unset must therefore load, serve
  // and mine over raw TCP exactly as before — not warn, not fail, not half-enable anything.
  const loaded = loadEnv(BASE)
  assert.equal(loaded.identity, null)
  assert.equal(loaded.websocketPublicOrigin, null)
})

test('identity is both halves or neither', () => {
  // A key set with no issuer verifies a signature and then accepts a token minted by anybody who can
  // serve that key set. An issuer with no key set verifies nothing at all. Neither is a
  // configuration somebody meant to write, so neither is inferred from the other.
  assert.throws(() => loadEnv({ ...BASE, IDENTITY_JWKS_URL: IDENTITY['IDENTITY_JWKS_URL'] as string }), EnvError)
  assert.throws(() => loadEnv({ ...BASE, IDENTITY_ISSUER: IDENTITY['IDENTITY_ISSUER'] as string }), EnvError)
  const loaded = loadEnv({ ...BASE, ...IDENTITY })
  assert.deepEqual(loaded.identity, {
    jwksUrl: IDENTITY['IDENTITY_JWKS_URL'],
    issuer: IDENTITY['IDENTITY_ISSUER'],
  })
})

test('a published websocket origin with no identity is refused rather than advertised', () => {
  // The failure it prevents is the worst-reading one available: `GET /v1/pool` advertises an
  // endpoint, a page connects to it, the upgrade succeeds, and then every `mining.authorize` is
  // refused because no ticket can be minted. Refusing at boot is one line in a log an operator is
  // already watching.
  assert.throws(
    () => loadEnv({ ...BASE, POOL_WEBSOCKET_PUBLIC_ORIGIN: 'wss://pool.example.com' }),
    (err: unknown) => {
      assert.ok(err instanceof EnvError)
      assert.match((err as Error).message, /IDENTITY_JWKS_URL/)
      return true
    },
  )
})

test('the published origin is an origin, and a path typed into it is refused', () => {
  // Refused rather than accepted-and-ignored. The path is `STRATUM_WS_PATH`, which this repository
  // owns and changes; an operator who typed one has written a second copy of a contract that moves,
  // and the two would diverge invisibly until a browser could not connect.
  for (const bad of [
    'wss://pool.example.com/v1/pool/stratum',
    'wss://pool.example.com/anything',
    'https://pool.example.com',
    'pool.example.com',
    'wss://pool.example.com?x=1',
    'wss://pool.example.com#frag',
    'wss://alice:hunter2@pool.example.com',
    'not a url',
  ]) {
    assert.throws(
      () => loadEnv({ ...BASE, ...IDENTITY, POOL_WEBSOCKET_PUBLIC_ORIGIN: bad }),
      (err: unknown) => {
        assert.ok(err instanceof EnvError, `${bad} raised something else`)
        assert.ok(!(err as Error).message.includes('hunter2'), 'a credential leaked')
        return true
      },
      `${bad} was accepted`,
    )
  }
})

test('a valid origin is normalised, so a trailing slash cannot produce a doubled one', () => {
  const withSlash = loadEnv({ ...BASE, ...IDENTITY, POOL_WEBSOCKET_PUBLIC_ORIGIN: 'wss://pool.example.com/' })
  const without = loadEnv({ ...BASE, ...IDENTITY, POOL_WEBSOCKET_PUBLIC_ORIGIN: 'wss://pool.example.com' })
  assert.equal(withSlash.websocketPublicOrigin, 'wss://pool.example.com')
  assert.equal(without.websocketPublicOrigin, 'wss://pool.example.com')
  // A non-default port survives, because a pool reached on one is the ordinary case off an estate.
  assert.equal(
    loadEnv({ ...BASE, ...IDENTITY, POOL_WEBSOCKET_PUBLIC_ORIGIN: 'ws://127.0.0.1:4146' }).websocketPublicOrigin,
    'ws://127.0.0.1:4146',
  )
})

test('websocketEndpointOf publishes a whole URL or nothing at all', () => {
  // The lesson of micro-org#285, applied before the same mistake can be made a second time. Half an
  // address is worse than none: the last time this service published one, the console filled the
  // rest in from `window.location.hostname` and produced something that could not connect.
  assert.equal(websocketEndpointOf(null, 'ltc'), null)
  assert.equal(websocketEndpointOf('wss://pool.example.com', 'ltc'), 'wss://pool.example.com/v1/pool/stratum/ltc')
  // The chain is IN the path, so a page reads one field and connects — it never assembles anything.
  assert.equal(websocketEndpointOf('wss://pool.example.com', 'btc'), 'wss://pool.example.com/v1/pool/stratum/btc')
})

/* ------------------------------------------------ payouts, which are OFF unless asked for (#302) */

/**
 * A credential of the shape identity actually mints, hyphen included.
 *
 * The hyphen is deliberate and is not decoration: `assertServiceCredential` records that the estate's
 * mainnet credential is alphanumeric while the TESTNET one contains a hyphen, and that a "no
 * hyphens" rule — which reads as obviously right in review — passes mainnet and kills testnet. A
 * fixture without one would let that regression through here too.
 */
const CREDENTIAL = 'cfsc_' + 'qN8xKvR2mT7bY4wL9pF3hJ6dS1gZ5cA0eU8i-2nQ7rV'

const PAYOUTS: Record<string, string> = {
  ...IDENTITY,
  LEDGER_URL: 'http://ledger:4000',
  POOL_IDENTITY_CREDENTIAL: CREDENTIAL,
  POOL_BTC_MINIMUM_PAYOUT: '5000000',
}

test('PAYOUTS ARE OFF WHEN NO MINIMUM IS SET, AND OFF IS THE MODE THE ESTATE RUNS IN', () => {
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // The constraint the whole block was designed around. `env.ts` is eager and exits the process on
  // a refusal, so a newly-REQUIRED variable is a container that will not boot — and on 2026-08-09
  // `cloudsforge-estate-pool-1` is healthy on release 2.5.8, mining LTC, with none of these
  // variables set. Requiring one would have failed the next deploy at boot and taken its `--wait`
  // down with it, which is not hypothetical: that happened on 2026-08-07 with `pool-migrate` and a
  // missing database.
  //
  // So unset is a supported, TESTED mode, and this is the test.
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  assert.equal(loadEnv(BASE).payouts, null)
  // Including with identity fully configured — browser mining and payouts are unrelated decisions.
  assert.equal(loadEnv({ ...BASE, ...IDENTITY }).payouts, null)
})

test('THE MINIMUM HAS NO DEFAULT, AND A VALUE THAT CANNOT BE READ EXACTLY IS A REFUSAL', () => {
  // The discipline `POOL_FEE_BASIS_POINTS` uses, transposed onto a value that must also be optional.
  // Digits only, and emphatically not `Number()`: `"0.05"` is the mistake an operator will actually
  // make — five hundredths of a Litecoin is what they mean, five million litoshi is what they have
  // to type — and a parser that read it as 0 would set the minimum to "always pay", invisibly.
  for (const bad of ['0.05', '1e8', '0x10', ' ', '-1', 'lots', '1_000', '5000000.0', 'Infinity']) {
    assert.throws(
      () => loadEnv({ ...BASE, ...PAYOUTS, POOL_BTC_MINIMUM_PAYOUT: bad }),
      EnvError,
      `${bad} was accepted as a payout minimum`,
    )
  }
  // Zero is refused separately, and the message must not read as "no minimum": zero would mean
  // paying every dust claim, which is the opposite of what somebody typing 0 intends.
  assert.throws(() => loadEnv({ ...BASE, ...PAYOUTS, POOL_BTC_MINIMUM_PAYOUT: '0' }), /greater than zero/)

  const loaded = loadEnv({ ...BASE, ...PAYOUTS })
  assert.equal(loaded.payouts?.minimums.get('btc'), 5_000_000n)
})

test('the minimum is a bigint, because a litoshi amount does not survive a double', () => {
  // 2^53 is 9007199254740992. A minimum above it read through `Number` comes back subtly wrong and
  // does not fail, which is the whole reason money is not a double anywhere in this estate.
  const huge = '9007199254740993'
  const loaded = loadEnv({ ...BASE, ...PAYOUTS, POOL_BTC_MINIMUM_PAYOUT: huge })
  assert.equal(loaded.payouts?.minimums.get('btc'), BigInt(huge))
  assert.equal(loaded.payouts?.minimums.get('btc')?.toString(), huge)
})

test('THE PAYOUT BLOCK IS ALL OF IT OR NONE OF IT', () => {
  // Each of these is a state somebody started and did not finish, and each produces a pool that pays
  // nobody while its operator believes it pays everybody. The same all-or-nothing treatment the
  // stratum endpoint and the identity trio already get.
  const halves: Array<[string, RegExp]> = [
    ['LEDGER_URL', /LEDGER_URL is not/],
    ['POOL_IDENTITY_CREDENTIAL', /POOL_IDENTITY_CREDENTIAL is not/],
    ['IDENTITY_ISSUER', /IDENTITY_ISSUER is not/],
  ]
  for (const [name, message] of halves) {
    const source: Record<string, string> = { ...BASE, ...PAYOUTS }
    delete source[name]
    assert.throws(() => loadEnv(source), message, `${name} was optional inside the payout block`)
  }
  // And the other direction: a ledger configured with no minimum would post nothing for ever.
  const { POOL_BTC_MINIMUM_PAYOUT: _omitted, ...withoutMinimum } = PAYOUTS
  assert.throws(() => loadEnv({ ...BASE, ...withoutMinimum }), /no chain has a POOL_<CHAIN>_MINIMUM_PAYOUT/)
})

test('a minimum for a chain this pool does not mine is refused, not ignored', () => {
  // A variable that does nothing, typed by somebody who believes that chain is being paid. Checked
  // against POOL_CHAINS rather than against the two chains this software implements, because the
  // mistake being caught is "I set it for the wrong deployment".
  assert.throws(
    () => loadEnv({ ...BASE, ...PAYOUTS, POOL_LTC_MINIMUM_PAYOUT: '5000000' }),
    /POOL_CHAINS does not list ltc/,
  )
})

test('one chain may be paid while another is not', () => {
  // An estate that pays Litecoin miners while it decides what to do about Bitcoin is a
  // configuration, not a half-made decision — the same per-chain treatment `stratumPublicPort` gets.
  const loaded = loadEnv({
    ...BASE,
    ...LTC,
    ...PAYOUTS,
    POOL_CHAINS: 'btc,ltc',
    POOL_LTC_MINIMUM_PAYOUT: '2500000',
  })
  assert.deepEqual([...(loaded.payouts?.minimums.entries() ?? [])], [
    ['btc', 5_000_000n],
    ['ltc', 2_500_000n],
  ])
})

test('a credential that is really a token is refused at boot, not an hour later', () => {
  // micro-org#197/#222: a JWT pasted where the long-lived credential belongs works for exactly ten
  // minutes and then fails in a way that reads as "identity rejected pool". The shape check is
  // `@cloudsforge/secrets`' rather than a local regex — see `requiredCredential` for why every
  // obvious local rule refuses one of the estate's two real credentials.
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwb29sIn0.c2lnbmF0dXJl'
  assert.throws(() => loadEnv({ ...BASE, ...PAYOUTS, POOL_IDENTITY_CREDENTIAL: jwt }), EnvError)
  assert.throws(() => loadEnv({ ...BASE, ...PAYOUTS, POOL_IDENTITY_CREDENTIAL: 'changeme' }), EnvError)
  assert.throws(
    () => loadEnv({ ...BASE, ...PAYOUTS, POOL_IDENTITY_CREDENTIAL: 'cfsc_' + 'a'.repeat(43) }),
    EnvError,
  )
})

test('the identity URL falls back to the issuer, which is the live path on this estate', () => {
  // Measured 2026-08-09 against the running containers: no service sets `IDENTITY_URL`, and
  // `IDENTITY_ISSUER` is the identity service's own base URL. Kept overridable anyway, because an
  // issuer is an identifier and a URL is a route.
  assert.equal(loadEnv({ ...BASE, ...PAYOUTS }).payouts?.identityUrl, IDENTITY['IDENTITY_ISSUER'])
  assert.equal(
    loadEnv({ ...BASE, ...PAYOUTS, IDENTITY_URL: 'http://identity:4000' }).payouts?.identityUrl,
    'http://identity:4000',
  )
})

test('no payout refusal ever prints the credential', () => {
  // An `EnvError` message is the single most reliably logged string in a process that fails to
  // start, and this one is reached with a credential in hand.
  for (const source of [
    { ...BASE, ...PAYOUTS, POOL_BTC_MINIMUM_PAYOUT: 'nonsense' },
    { ...BASE, ...PAYOUTS, LEDGER_URL: 'not a url' },
    { ...BASE, ...PAYOUTS, POOL_IDENTITY_CREDENTIAL: CREDENTIAL.slice(0, 12) },
  ]) {
    assert.throws(
      () => loadEnv(source),
      (err: unknown) => {
        assert.ok(err instanceof EnvError)
        assert.ok(!(err as Error).message.includes(CREDENTIAL.slice(5, 20)), 'a credential leaked')
        return true
      },
    )
  }
})
