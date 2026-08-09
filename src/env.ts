/**
 * Configuration, validated at import.
 *
 * Rule 9 of docs/ecosystem/03 §2 — "a repo declares the variables it needs; the deploy provides
 * exactly those" — is a property of this file. Every variable the service reads is named here and
 * nowhere else, so the deploy manifest can be derived from it and `env_file: .env` fan-out (which
 * hands every container the whole estate's secrets) has nothing to justify it.
 *
 * Two behaviours are estate house style:
 *
 *   1. **A missing variable names itself.** `undefined` propagating into a connection string
 *      surfaces four layers later as an unreadable driver error.
 *   2. **A refusal explains itself.** A chain this pool will not mine is not answered with "unknown
 *      chain" — see `REFUSED_CHAINS` in `chains.ts`, and the DOGE entry in particular. "Unknown"
 *      reads as a typo and invites the reader to add a row to a table; that row would produce a pool
 *      that mines Dogecoin blocks the network rejects.
 *
 * ## Two things this file deliberately does NOT have
 *
 * **No signing secret, and no `@cloudsforge/secrets`.** The template carries `OUTBOX_SIGNING_SECRET`
 * because a service that publishes events must sign them. This one publishes none — there is no
 * outbox, no event and no subscriber, and the first event it will have to emit is the payout, which
 * is not implemented (`payouts.ts`). Declaring a secret it does not use would be a variable the
 * deploy has to provide for nothing, which is what rule 9 exists to stop.
 *
 * **No signing secret and no `@cloudsforge/secrets`, still.** The mining ticket added by
 * micro-org#289 is a random opaque value matched by equality, not a MAC, so there is no key to
 * fetch. Nothing in this service signs anything until payouts exist.
 *
 * ## `IDENTITY_JWKS_URL` arrived, and it did NOT make the read API private
 *
 * This file used to say there was no auth here at all. That is no longer true and the change is
 * narrower than it sounds: **exactly one route verifies a token**, `POST /v1/pool/ticket`, which
 * mints the credential a browser miner presents on the WebSocket transport. Every route that
 * answers a question about work already done is still public, for the reason it always was — 36 §6
 * makes a miner's share history checkable by the miner a product requirement, the only identity a
 * miner has here is the stratum username they typed into their own firmware, and gating that behind
 * an estate login would make it checkable by nobody.
 *
 * And identity is **optional**. Unset is a supported, tested mode: the WebSocket transport is not
 * attached, the ticket route answers 503, no endpoint is advertised, and raw TCP is untouched. A
 * pool run by somebody who has no estate at all is the ordinary case for this software, and making
 * a JWKS mandatory would have made the whole service unstartable for them.
 */

import { hostname } from 'node:os'
import type { Network } from '@cloudsforge/contracts-chain'
import { isPoolChainId, REFUSED_CHAINS, type PoolChainId } from './chains.ts'
import { STRATUM_WS_PATH } from './wsstratum.ts'

/**
 * The service's own name. A constant rather than a variable: it is a property of the repository, not
 * of the deployment, and making it configurable is how two services end up sharing a migration
 * advisory lock.
 */
export const SERVICE = 'pool'

/** Raised by `loadEnv`. Distinct so a caller can tell configuration from every other failure. */
export class EnvError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EnvError'
  }
}

type Source = Readonly<Record<string, string | undefined>>

function required(source: Source, name: string): string {
  const value = source[name]?.trim()
  if (!value) throw new EnvError(`${name} is required — ${SERVICE} refuses to start without it`)
  return value
}

function optional(source: Source, name: string, fallback: string): string {
  const value = source[name]?.trim()
  return value && value.length > 0 ? value : fallback
}

function integer(source: Source, name: string, fallback: number, min: number, max: number): number {
  const raw = source[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new EnvError(`${name} must be a whole number between ${min} and ${max} (got ${raw})`)
  }
  return value
}

/**
 * An optional whole number with no fallback — `null` when unset, never a default.
 *
 * `integer` above supplies one and that is right for every value it is used for. This exists for
 * the PUBLISHED stratum port, where a default would be a guess dressed as configuration. The
 * obvious default — the port the listener binds — is precisely the conflation this function was
 * added to stop: on 2026-08-09 the estate's compose file publishes the stratum listener as
 * `${POOL_STRATUM_HOST_BIND:-127.0.0.1}:${POOL_LTC_STRATUM_PORT:-3334}:3334`, where the CONTAINER
 * side is the literal 3334 and only the HOST side reads the variable — and the service's own
 * environment block does not set `POOL_LTC_STRATUM_PORT` at all. So an operator who moves the
 * published port changes one number and the pool goes on binding, and reporting, the other. A
 * default here would make that divergence invisible instead of absent.
 */
function optionalInteger(source: Source, name: string, min: number, max: number): number | null {
  const raw = source[name]?.trim()
  if (!raw) return null
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new EnvError(`${name} must be a whole number between ${min} and ${max} (got ${raw})`)
  }
  return value
}

/**
 * A required whole number with no fallback. Exists for `POOL_FEE_BASIS_POINTS` alone, and the
 * absence of a default there is the entire point — see `feeBasisPoints` below.
 */
function requiredInteger(source: Source, name: string, min: number, max: number): number {
  const raw = required(source, name)
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new EnvError(`${name} must be a whole number between ${min} and ${max} (got ${raw})`)
  }
  return value
}

function decimal(source: Source, name: string, fallback: number, min: number, max: number): number {
  const raw = source[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new EnvError(`${name} must be a number between ${min} and ${max} (got ${raw})`)
  }
  return value
}

/**
 * An http or https endpoint, checked for shape but never echoed.
 *
 * The check is on the URL's structure only. **The value is not repeated in the error**, because a
 * node RPC URL in this estate carries HTTP Basic userinfo and an error message is the most reliably
 * logged string in any process. `rpc.ts` holds the same line: host and port may be logged, the URL
 * never is. `IDENTITY_JWKS_URL` goes through the same helper — it carries no credential, but a
 * second, laxer URL check would be a second answer to a question this file has already answered.
 */
function httpUrl(source: Source, name: string): string {
  const value = required(source, name)
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new EnvError(`${name} is not a valid URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new EnvError(`${name} must be an http or https URL`)
  }
  return value
}

/**
 * The name a miner outside this deployment dials, or `null` when nobody has published one.
 *
 * Checked for shape, because the two ways to get this wrong are both silent. A value carrying a
 * scheme composes `stratum+tcp://stratum+tcp://…` in every consumer that builds a connection
 * string, and a value carrying a port composes `host:3334:3334` — neither fails here, both fail in
 * a stranger's mining firmware, and a miner whose configuration does not connect blames their own
 * hardware long before they blame this string. Refusing at boot is the only place the person who
 * typed it is still watching.
 *
 * The port test is "exactly one colon". An IPv6 literal has at least two (`2001:db8::1`), so it
 * survives; `pool.example.com:3334` does not, which is the mistake being caught.
 */
function publicHost(source: Source, name: string): string | null {
  const value = source[name]?.trim()
  if (!value) return null
  if (/[\s/@]/.test(value) || value.includes('://')) {
    throw new EnvError(`${name} is the hostname a miner dials, not a URL — no scheme, no path, no credentials`)
  }
  if (value.split(':').length === 2) {
    throw new EnvError(
      `${name} is a hostname on its own; the port a miner dials is POOL_<CHAIN>_STRATUM_PUBLIC_PORT, ` +
        'because a pool serving two chains publishes two ports under one name',
    )
  }
  return value
}

/**
 * The origin a BROWSER dials, or `null` when nobody has published one.
 *
 * The same posture as `publicHost` above and for the same reason (micro-org#285), with one shape
 * difference that is forced by the client rather than chosen: a browser is handed a complete URL,
 * not a host and a port, and the SCHEME is part of what it needs — a page served over https may
 * only open `wss:`, and a developer on localhost needs `ws:`. So this is one variable carrying one
 * absolute origin, which also means there is no half-answer for it to be in.
 *
 * What is checked is that it is an ORIGIN and nothing more. A path is refused rather than accepted
 * and ignored, because the path is this service's own (`STRATUM_WS_PATH`) and an operator who typed
 * one has written down a second, unversioned copy of a contract that this repository changes — the
 * two would diverge and the divergence would be invisible until a miner could not connect. Query,
 * fragment and userinfo are refused for the ordinary reasons: none of them survives being appended
 * to, and a credential in a URL that this service PUBLISHES would be a credential in every log that
 * records the response.
 */
function publicWebsocketOrigin(source: Source, name: string): string | null {
  const value = source[name]?.trim()
  if (!value) return null
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new EnvError(`${name} is not a valid URL — it is the origin a browser dials, such as wss://pool.example.com`)
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new EnvError(`${name} must begin ws:// or wss:// (got ${parsed.protocol}//)`)
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new EnvError(`${name} must not carry credentials; it is published to every caller of GET /v1/pool`)
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new EnvError(`${name} is an origin, not a URL with a query or a fragment`)
  }
  if (parsed.pathname !== '' && parsed.pathname !== '/') {
    throw new EnvError(
      `${name} is an origin and must have no path: the path is ${STRATUM_WS_PATH}/<chain>, which this ` +
        'service owns and appends itself. A path typed here is a second copy of a contract that moves.',
    )
  }
  // Normalised to the origin, so `wss://host/` and `wss://host` compose the same endpoint. `URL`
  // renders `origin` without the trailing slash and with the default port elided.
  return parsed.origin
}

/**
 * Verifying an estate access token needs both halves, so both or neither.
 *
 * A JWKS with no issuer verifies a signature and then accepts a token minted by anybody who can
 * serve that key set; an issuer with no JWKS verifies nothing at all. Neither half is a
 * configuration somebody meant to write.
 */
export interface IdentityConfig {
  readonly jwksUrl: string
  readonly issuer: string
}

export interface ChainConfig {
  readonly chain: PoolChainId
  /** Carries HTTP Basic userinfo. Never logged. */
  readonly nodeUrl: string
  readonly payoutAddress: string
  /**
   * The port this chain's stratum listener BINDS. Not necessarily a port anything can reach: it is
   * the inside of whatever port mapping the deploy wrote. See `stratumPublicPort`.
   */
  readonly stratumPort: number
  /**
   * The port a miner dials for this chain, when the deploy has published one — `null` otherwise.
   *
   * Separate from `stratumPort` because a container port and a published port are different facts
   * and this service can only know the first. It defaults to nothing rather than to the bind; see
   * `optionalInteger`.
   */
  readonly stratumPublicPort: number | null
  readonly initialDifficulty: number
}

/** Where a miner points their hardware. Both halves, or neither. */
export interface StratumEndpoint {
  readonly host: string
  readonly port: number
}

/**
 * The endpoint to advertise for one chain, or `null` when this deployment has not published one.
 *
 * Null is a real answer and the common one. A pool on a LAN, or one whose stratum port is bound to
 * loopback — which is the estate's own default on 2026-08-09 — has no endpoint a stranger could
 * dial, and saying so is correct rather than degraded. What must never happen is a half-answer: a
 * host with no published port, or a port with no name, would compose into a connection string that
 * looks complete and is not, so the pair is all-or-nothing by construction.
 */
export function stratumEndpointOf(host: string | null, chain: ChainConfig): StratumEndpoint | null {
  if (host === null || chain.stratumPublicPort === null) return null
  return { host, port: chain.stratumPublicPort }
}

/**
 * The complete URL a browser passes to `new WebSocket(...)` for one chain, or `null`.
 *
 * Composed here rather than by a consumer, which is the whole lesson of micro-org#285: the last
 * time this service published half of a connection string, micro-pool-web supplied the other half
 * out of `window.location.hostname` and produced an address that could not connect. So the service
 * either publishes an endpoint that works in full or publishes nothing, and `null` is a real answer
 * that a client renders as an absence.
 */
export function websocketEndpointOf(origin: string | null, chain: PoolChainId): string | null {
  if (origin === null) return null
  return `${origin}${STRATUM_WS_PATH}/${chain}`
}

export interface Env {
  readonly port: number
  readonly env: string
  readonly version: string
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error'
  /**
   * Rule 1: one database, named by this service's own variable. The CI check greps for any other
   * connection-string variable, so adding a second one here fails the build rather than review.
   */
  readonly databaseUrl: string
  readonly databasePoolMax: number
  readonly network: Network
  readonly chains: readonly ChainConfig[]
  readonly stratumBind: string
  /**
   * The hostname a miner types into their firmware, or `null` when nobody has published one.
   *
   * **Optional, and unset by default, and the default is not a fallback to anything.** This is the
   * one fact about a stratum endpoint that this service cannot derive and must not guess:
   *
   *   - It is NOT `stratumBind`. That is an interface to listen on — `0.0.0.0` says "every
   *     interface", which is not a name and cannot be dialled.
   *   - It is NOT the `Host` header of whoever asked. The HTTP surface and the stratum listener are
   *     different protocols on different ports, and on this estate they are different reachability
   *     stories as well: the console arrives through a Cloudflare Tunnel and Traefik, and neither
   *     can carry a raw TCP stream, so the hostname that served the page provably does NOT carry
   *     stratum. A consumer deriving one from the other is the defect this variable was added for
   *     (micro-org#285).
   *   - It is NOT a hostname of this container. A pool behind a port mapping, a NAT or a tunnel is
   *     reached by a name only the deploy knows.
   *
   * So it is typed in, or it is null and every consumer says a name has not been published — which
   * is the honest screen. A wrong hostname in a stranger's mining configuration costs them a silent
   * outage they will blame on their own hardware, and that is strictly worse than an absent one.
   */
  readonly stratumPublicHost: string | null
  /**
   * The origin a browser dials for the WebSocket transport, or `null` when none is published.
   *
   * Exactly the posture of `stratumPublicHost` and for the same reason (micro-org#285): it is not
   * the `Host` header of whoever asked, not `stratumBind`, and not a name this container can observe
   * about itself. `websocketEndpointOf` appends the path; nothing else composes it.
   *
   * One variable rather than two because a browser needs one absolute URL, scheme included — a page
   * served over https may open only `wss:`, and a developer on localhost needs `ws:` — so there is
   * no half-published state for this one to be in.
   */
  readonly websocketPublicOrigin: string | null
  /**
   * How to verify an estate access token, or `null` when this pool has no estate behind it.
   *
   * **Optional, and unset is a supported, tested mode**, not a degraded one. Most of what this
   * service does is answer questions about work already done, and none of it needs an identity — see
   * the file header and `server.ts`. Unset means `POST /v1/pool/ticket` answers 503, the WebSocket
   * transport is never attached, no websocket endpoint is advertised, and the stratum port behaves
   * exactly as it always has. Making a JWKS mandatory would have made this service unstartable for
   * anybody running the pool on its own, which is the ordinary case for pool software.
   */
  readonly identity: IdentityConfig | null
  /**
   * Bytes written into every coinbase this pool builds, identifying it on the chain.
   *
   * Capped short. The scriptSig it lives in is capped at 100 bytes by consensus and shares that
   * space with the BIP34 height and the extranonce, so an over-long tag does not truncate — it makes
   * the coinbase invalid. `buildCoinbase` refuses one that does not fit, at boot.
   */
  readonly coinbaseTag: string
  /**
   * The pool's fee, in basis points. **Required, with no default anywhere in this repository.**
   *
   * §7.1 of `docs/ecosystem/36-multi-chain-and-mining-pool.md` records that the pool fee has NOT
   * been chosen. A default of 0 would be choosing "free" and a default of 200 would be choosing
   * "2%", and either one made here would answer an open product question by omission, in the file
   * least likely to be read by whoever eventually answers it. Refusing to start is the honest
   * behaviour: somebody has to type the number.
   */
  readonly feeBasisPoints: number
  readonly pplnsMultiplier: number
  readonly shareRetentionDays: number
  readonly templatePollMs: number
  readonly vardiffSharesPerMinute: number
  readonly instanceId: string
}

const LEVELS = new Set(['debug', 'info', 'warn', 'error'])
const NETWORKS = new Set(['mainnet', 'testnet'])

/** Default stratum ports, one per chain, so two chains on one host cannot collide by accident. */
const DEFAULT_STRATUM_PORT: Readonly<Record<PoolChainId, number>> = Object.freeze({ btc: 3333, ltc: 3334 })

/**
 * Where a connection starts, before vardiff has measured anything.
 *
 * Two orders of magnitude apart because the hardware is: a SHA-256d ASIC does terahashes and would
 * flood the pool at anything low, while a scrypt miner is thousands of times slower in share terms.
 * Both are only a starting point — `vardiff.ts` moves off them within a window or two, in either
 * direction — but a bad start is a miner that sees nothing for ten minutes, or one that submits a
 * thousand shares a second, and either is a miner who leaves before vardiff converges.
 */
const DEFAULT_INITIAL_DIFFICULTY: Readonly<Record<PoolChainId, number>> = Object.freeze({ btc: 65_536, ltc: 512 })

function loadChain(source: Source, chain: PoolChainId): ChainConfig {
  const upper = chain.toUpperCase()
  return {
    chain,
    nodeUrl: httpUrl(source, `POOL_${upper}_NODE_URL`),
    payoutAddress: required(source, `POOL_${upper}_PAYOUT_ADDRESS`),
    stratumPort: integer(source, `POOL_${upper}_STRATUM_PORT`, DEFAULT_STRATUM_PORT[chain], 1, 65_535),
    stratumPublicPort: optionalInteger(source, `POOL_${upper}_STRATUM_PUBLIC_PORT`, 1, 65_535),
    initialDifficulty: decimal(
      source,
      `POOL_${upper}_INITIAL_DIFFICULTY`,
      DEFAULT_INITIAL_DIFFICULTY[chain],
      0.001,
      4_294_967_296,
    ),
  }
}

/** Pure over its source so the failure paths are testable without mutating the process. */
export function loadEnv(source: Source = process.env, host = ''): Env {
  const logLevel = optional(source, 'LOG_LEVEL', 'info')
  if (!LEVELS.has(logLevel)) {
    throw new EnvError(`LOG_LEVEL must be one of debug, info, warn, error (got ${logLevel})`)
  }

  const network = optional(source, 'POOL_NETWORK', 'mainnet')
  if (!NETWORKS.has(network)) {
    throw new EnvError(`POOL_NETWORK must be mainnet or testnet (got ${network})`)
  }

  const names = required(source, 'POOL_CHAINS')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== '')
  if (names.length === 0) throw new EnvError('POOL_CHAINS lists no chains')

  const seen = new Set<string>()
  const chains: ChainConfig[] = []
  for (const name of names) {
    if (seen.has(name)) throw new EnvError(`POOL_CHAINS lists ${name} twice`)
    seen.add(name)
    const refusal = REFUSED_CHAINS[name]
    if (refusal !== undefined) {
      throw new EnvError(`POOL_CHAINS asks for ${name}, which this pool refuses to mine. ${refusal}`)
    }
    if (!isPoolChainId(name)) {
      throw new EnvError(
        `POOL_CHAINS asks for ${name}, which this pool does not implement. It mines btc and ltc; ` +
          'see REFUSED_CHAINS in src/chains.ts for the chains that are refused by name, and why.',
      )
    }
    chains.push(loadChain(source, name))
  }

  const ports = new Set(chains.map((chain) => chain.stratumPort))
  if (ports.size !== chains.length) {
    throw new EnvError('two chains are configured on the same stratum port; each chain needs its own listener')
  }

  /*
   * The published endpoint, refused when it is half-made.
   *
   * Both halves are optional and null is the ordinary answer, so neither absence is an error on its
   * own. A HALF is: each of these two states is a decision somebody started and did not finish, and
   * each produces a pool that silently advertises nothing while its operator believes otherwise.
   *
   *   - A host and no published port anywhere. The variable was typed and does nothing.
   *   - A published port and no host. There is a number and no name to dial it at.
   *
   * Per chain rather than globally, because a pool may legitimately publish one chain and not
   * another — an estate that exposes Litecoin to strangers and keeps Bitcoin on the LAN is a
   * configuration, not a mistake — so a host plus SOME published ports is allowed and quiet.
   */
  const stratumPublicHost = publicHost(source, 'POOL_STRATUM_PUBLIC_HOST')
  const published = chains.filter((chain) => chain.stratumPublicPort !== null)
  if (stratumPublicHost !== null && published.length === 0) {
    throw new EnvError(
      'POOL_STRATUM_PUBLIC_HOST is set and no chain has a POOL_<CHAIN>_STRATUM_PUBLIC_PORT, so no ' +
        'endpoint would be advertised at all. A published port is not defaulted from the bound one: ' +
        'the two differ whenever the deploy maps them, and a port that is usually right is how a ' +
        'miner ends up dialling nothing. State the port a miner reaches this pool on.',
    )
  }
  if (stratumPublicHost === null && published.length > 0) {
    const names = published.map((chain) => `POOL_${chain.chain.toUpperCase()}_STRATUM_PUBLIC_PORT`)
    throw new EnvError(
      `${names.join(', ')} names a published port and POOL_STRATUM_PUBLIC_HOST names nothing to ` +
        'dial it at. A port on its own is not an endpoint.',
    )
  }

  /*
   * Identity, and the browser transport it gates.
   *
   * Three variables, all optional, and two refusals — each of which is a state somebody started and
   * did not finish, and each of which would otherwise produce a pool that quietly serves no browser
   * while its operator believes it does.
   *
   *   - **A JWKS with no issuer, or an issuer with no JWKS.** The first verifies a signature and
   *     then accepts any token minted by whoever can serve that key set; the second verifies
   *     nothing at all. Neither is a configuration anybody meant to write.
   *   - **A published websocket origin with no identity.** The endpoint would be advertised on
   *     `GET /v1/pool`, a browser would dial it, the upgrade would be refused because no transport
   *     is attached, and the page would show a miner that cannot start with nothing to point at.
   *     Publishing an address that cannot work is the defect micro-org#285 is about, arriving by a
   *     different road.
   *
   * Identity WITHOUT an origin is allowed and quiet: the transport is attached and works for anybody
   * who knows the URL, and `GET /v1/pool` reports null because nobody has published one. That is the
   * same all-or-nothing treatment `stratumEndpoint` gets, and null is a real answer there too.
   */
  const jwksUrl = source['IDENTITY_JWKS_URL']?.trim()
  const issuer = source['IDENTITY_ISSUER']?.trim()
  if (jwksUrl && !issuer) {
    throw new EnvError(
      'IDENTITY_JWKS_URL is set and IDENTITY_ISSUER is not. A key set with no issuer verifies a ' +
        'signature and then accepts a token minted by anybody who can serve those keys.',
    )
  }
  if (issuer && !jwksUrl) {
    throw new EnvError('IDENTITY_ISSUER is set and IDENTITY_JWKS_URL is not, so there are no keys to verify against')
  }
  const identity: IdentityConfig | null =
    jwksUrl && issuer ? { jwksUrl: httpUrl(source, 'IDENTITY_JWKS_URL'), issuer } : null

  const websocketPublicOrigin = publicWebsocketOrigin(source, 'POOL_WEBSOCKET_PUBLIC_ORIGIN')
  if (websocketPublicOrigin !== null && identity === null) {
    throw new EnvError(
      'POOL_WEBSOCKET_PUBLIC_ORIGIN publishes a browser mining endpoint and IDENTITY_JWKS_URL is ' +
        'unset, so no browser transport is attached and every upgrade to that address would be ' +
        'refused. Browser mining needs an estate account: see POST /v1/pool/ticket.',
    )
  }

  const coinbaseTag = optional(source, 'POOL_COINBASE_TAG', '/cloudsforge/')
  if (Buffer.byteLength(coinbaseTag, 'utf8') > 32) {
    throw new EnvError('POOL_COINBASE_TAG must be at most 32 bytes — the coinbase scriptSig it shares is capped at 100')
  }

  return {
    port: integer(source, 'PORT', 4146, 1, 65_535),
    env: optional(source, 'NODE_ENV', 'development'),
    version: optional(source, 'CLOUDSFORGE_TAG', 'dev'),
    logLevel: logLevel as Env['logLevel'],
    databaseUrl: required(source, 'POOL_DATABASE_URL'),
    // A pool larger than the database's own connection budget divided by the replica count is a
    // service that exhausts Postgres for everything else the moment it scales.
    databasePoolMax: integer(source, 'POOL_DATABASE_POOL_MAX', 10, 1, 100),
    network: network as Network,
    chains,
    // Stratum is plain TCP and unauthenticated; binding it is a deployment decision, and the
    // default is every interface because that is what a compose network needs.
    stratumBind: optional(source, 'POOL_STRATUM_BIND', '0.0.0.0'),
    // The name to advertise, which is a different question from the interface to listen on and is
    // answered by nothing this process can observe about itself. See the field's own note.
    stratumPublicHost,
    // The browser's endpoint gets exactly the treatment the miner's does, for the reason
    // micro-org#285 gave: a published address is configuration or it is nothing. Never assembled
    // from the request `Host`, never defaulted from `PORT`.
    websocketPublicOrigin,
    identity,
    coinbaseTag,
    feeBasisPoints: requiredInteger(source, 'POOL_FEE_BASIS_POINTS', 0, 10_000),
    pplnsMultiplier: decimal(source, 'POOL_PPLNS_WINDOW_MULTIPLIER', 2, 0.1, 100),
    shareRetentionDays: integer(source, 'POOL_SHARE_RETENTION_DAYS', 30, 1, 3650),
    templatePollMs: integer(source, 'POOL_TEMPLATE_POLL_MS', 10_000, 1_000, 120_000),
    vardiffSharesPerMinute: decimal(source, 'POOL_VARDIFF_SHARES_PER_MINUTE', 12, 0.5, 240),
    // Names this replica in `jobs.locked_by`. Defaults to the hostname, which is the container id
    // under compose and the pod name under Kubernetes — in both cases the thing an operator would
    // search for after finding a stuck lease.
    instanceId: optional(source, 'INSTANCE_ID', host || 'unknown'),
  }
}

/**
 * The checks above run at import, before the logger exists, so an uncaught throw reaches the
 * container as a bare V8 stack: not JSON, no level, no service name. The collector drops it and the
 * only symptom an operator gets is a container that exits instantly.
 *
 * So emit one structured fatal line by hand. It is built from a literal rather than routed through
 * the telemetry package: nothing that can itself fail may sit between a configuration error and the
 * report of it. The message is the one `loadEnv` produced, which by construction never contains a
 * node URL or any other value.
 */
function fatalConfig(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(
    `${JSON.stringify({
      time: new Date().toISOString(),
      level: 'fatal',
      service: SERVICE,
      step: 'env',
      msg: `startup failed at: env — ${message}`,
    })}\n`,
  )
  process.exit(1)
}

export const env: Env = (() => {
  try {
    return loadEnv(process.env, hostname())
  } catch (err) {
    fatalConfig(err)
  }
})()
