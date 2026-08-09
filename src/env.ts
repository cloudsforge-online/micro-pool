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
 * ## What this file deliberately does NOT have
 *
 * **No signing secret.** The template carries `OUTBOX_SIGNING_SECRET` because a service that
 * publishes events must sign them. This one publishes none — there is no outbox, no event and no
 * subscriber. The mining ticket added by micro-org#289 is a random opaque value matched by equality,
 * not a MAC, so there is no key to fetch there either. Declaring a secret it does not use would be a
 * variable the deploy has to provide for nothing, which is what rule 9 exists to stop.
 *
 * `@cloudsforge/secrets` is nonetheless a dependency as of micro-org#302, for one narrow job:
 * `assertServiceCredential` checks the shape of `POOL_IDENTITY_CREDENTIAL`. That is validation, not
 * signing — see `requiredCredential` for why the check may not be a local regex.
 *
 * ## Payouts are configuration this file makes OPTIONAL on purpose
 *
 * `env.payouts` is null unless an operator has typed a per-chain minimum, and null is the tested,
 * supported and currently universal state. `optionalUnits` carries the reasoning in full: this file
 * is eager, a required variable is a container that will not boot, and the pool is mining Litecoin
 * on the estate right now with none of these variables set.
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
import { assertServiceCredential, SecretError } from '@cloudsforge/secrets'
import { AUX_CHAIN_MERKLE_SIZE } from './auxpow.ts'
import {
  AUX_CHAIN_IDS,
  AUX_PARENT,
  auxNameFor,
  isAuxChainId,
  isPoolChainId,
  POOL_CHAIN_IDS,
  REFUSED_CHAINS,
  type AuxChainId,
  type PoolChainId,
} from './chains.ts'
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

/**
 * A SERVICE CREDENTIAL that must be present and must be real.
 *
 * Required rather than optional — the inverse of `wallet`'s `optionalCredential` — because the two
 * services are in opposite positions. The wallet must boot without one: it holds user balances, and
 * turning an ungranted credential into `exit(1)` there converts a gap into an outage. Here there is
 * nothing to keep running, because the caller only reaches this function once a minimum payout has
 * been typed, and a pool that has been told to pay miners and cannot authenticate to the ledger has
 * no useful degraded mode — it would accrue credits it can never post.
 *
 * The shape check is `@cloudsforge/secrets`' and not a local rule, deliberately. A credential is
 * `cfsc_` + base64url, which is neither wholly base64 nor wholly hex and which (measured live on
 * 2026-08-09) contains a hyphen on testnet and none on mainnet, so every "obvious" local rule an
 * author would write here refuses one of the estate's two real credentials. `assertServiceCredential`
 * also rejects a JWT pasted in place of the long-lived credential, which is the mistake that
 * otherwise surfaces as a 401 an hour after deploy.
 */
function requiredCredential(source: Source, name: string): string {
  const value = required(source, name)
  try {
    assertServiceCredential(name, value)
  } catch (err) {
    // Re-typed, not re-worded: `fatalConfig` reports whatever message arrives, and a `SecretError`
    // already names the variable and the property it failed. What matters is that a caller can tell
    // configuration from every other failure, which is what `EnvError` is for.
    if (err instanceof SecretError) throw new EnvError(err.message)
    throw err
  }
  return value
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

/**
 * A whole number of SMALLEST UNITS, parsed strictly, with **no default and no fallback**.
 *
 * `null` when unset — never a number. This is the discipline `POOL_FEE_BASIS_POINTS` is read with
 * (`requiredInteger`, and see `feeBasisPoints` for why the absence of a default is the entire
 * point), transposed onto a value that must additionally be optional. `POOL_<CHAIN>_MINIMUM_PAYOUT`
 * is the only caller.
 *
 * ── WHY THIS IS OPTIONAL WHEN `POOL_FEE_BASIS_POINTS` IS REQUIRED ───────────────────────────────
 *
 * The fee had to be required, because a service that ships a default fee has answered an open
 * product question by omission. The same reasoning would make a minimum payout required — and doing
 * that would have taken the estate's pool down.
 *
 * `env.ts` is eager: it runs at import, and `fatalConfig` exits the process on any refusal. So a
 * newly-required variable is a container that will not boot until somebody sets it, and on
 * 2026-08-09 `cloudsforge-estate-pool-1` is healthy, on release 2.5.8, mining LTC against a fully
 * synced litecoind, and its environment — read from the running container, not from a compose file
 * — contains `POOL_CHAINS=ltc`, `POOL_FEE_BASIS_POINTS=100`, a payout address and no payout
 * configuration of any kind. A required variable added here lands as a boot failure on the next
 * deploy, and it takes that deploy's `--wait` down with it. That is not hypothetical: it happened on
 * 2026-08-07 with `pool-migrate` and a missing database.
 *
 * So the shape is: **unset means payouts are off**, and off is a supported, tested state — no sink
 * is constructed, no job is registered, and `payoutsImplemented` stays false. There is no middle
 * ground where a default silently decides what a miner must earn before being paid.
 *
 * ── WHAT "STRICTLY" MEANS, AND WHY A MALFORMED VALUE IS A REFUSAL ───────────────────────────────
 *
 * Digits only. Not `Number()`, which accepts `0x10`, `1e8`, ` 12 `, `Infinity` and `1.5` and turns
 * the last of those into a silent truncation; not a float at any point, because this is money in
 * the smallest unit and the value is compared against `bigint` amounts. `"0.05"` is the mistake an
 * operator will actually make — five hundredths of a Litecoin is what they mean, five million
 * litoshi is what they have to type — and a parser that read it as 0 would set the minimum to
 * "always pay", which is the opposite of what was intended and would be invisible.
 *
 * Refusing rather than falling back, for the reason the whole block exists: a fallback here is a
 * number nobody chose being applied to somebody else's money.
 */
function optionalUnits(source: Source, name: string): bigint | null {
  const raw = source[name]?.trim()
  if (!raw) return null
  if (!/^[0-9]+$/.test(raw)) {
    throw new EnvError(
      `${name} must be a whole number of the smallest unit, digits only (got ${raw}). ` +
        'A Litecoin amount goes here as litoshi: 0.05 LTC is 5000000. There is no default and a ' +
        'value that cannot be read exactly is refused rather than rounded.',
    )
  }
  const value = BigInt(raw)
  if (value <= 0n) {
    throw new EnvError(
      `${name} must be greater than zero (got ${raw}). A minimum of zero is not "no minimum" — ` +
        `leave ${name} unset for that, which turns payouts off entirely.`,
    )
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

/**
 * Everything needed to credit a miner in the ledger, or — far more usually — `null`.
 *
 * All of it or none of it, held as one object rather than as four independent fields, because that
 * is what makes "payouts are off" a state the type checker can see. A caller holding
 * `env.payouts === null` cannot reach a ledger URL, and `index.ts` constructs no sink, registers no
 * job and leaves `payoutsImplemented` false. Four nullable fields would have made every one of those
 * a runtime question asked in four places.
 *
 * See `optionalUnits` for why this whole block is optional on a service whose fee is required, and
 * `CUSTODY_BACKING_CLOSED` in `payouts.ts` for the SECOND, independent gate that refuses the payout
 * path even when this block is fully configured. Setting these variables is necessary to pay a miner
 * and it is not sufficient.
 */
export interface PayoutConfig {
  /** The ledger's base URL. Not this service's database — the ledger owns every balance. */
  readonly ledgerUrl: string
  /**
   * Where the long-lived credential is exchanged for a short service token.
   *
   * `IDENTITY_URL` when set, and `IDENTITY_ISSUER` when it is not — the same fallback wallet uses,
   * and measured against the running estate on 2026-08-09 the fallback is the live path: no
   * container sets `IDENTITY_URL`, and `IDENTITY_ISSUER` is the identity service's own base URL.
   * Kept overridable anyway because an issuer is an identifier and a URL is a route, and a
   * deployment that puts identity behind a different address is entitled to say so.
   */
  readonly identityUrl: string
  /** Long-lived, exchanged for short service tokens. Never logged, never rendered. */
  readonly identityCredential: string
  readonly deadlineMs: number
  /**
   * Smallest units a miner must be owed before this pool posts an entry, per chain.
   *
   * A `Map` of the chains that have one rather than a record over every chain, because a chain with
   * no minimum is not paid at all and that is a supported configuration: an estate that pays
   * Litecoin miners and has not decided what to do about Bitcoin is a decision, not a half-made one.
   * `bigint` because these are compared against amounts that do not fit a double.
   */
  readonly minimums: ReadonlyMap<PoolChainId, bigint>
}

/**
 * One chain merge-mined underneath a parent, and the two facts that take to do it.
 *
 * Deliberately smaller than `ChainConfig`, and the omissions are the point. There is no stratum
 * port because no miner connects to an aux chain; no initial difficulty because a share's difficulty
 * is a property of the parent's algorithm; no template poll because the aux block is refreshed on
 * the parent's tick. An aux chain that grew any of those fields would be a chain this pool mines on
 * its own, which is exactly what `REFUSED_CHAINS.doge` explains it cannot be.
 */
export interface AuxChainConfig {
  readonly chain: AuxChainId
  /** Carries HTTP Basic userinfo. Never logged. */
  readonly nodeUrl: string
  /**
   * The address the AUX node pays this block's reward to — its own chain's address, not the parent's.
   *
   * A Litecoin address here is not a type error anywhere in this service: it is handed straight to
   * `createauxblock`, and dogecoind would refuse it with a message about an invalid address that
   * says nothing about which of the two payout variables was wrong. Named `POOL_DOGE_PAYOUT_ADDRESS`
   * beside `POOL_LTC_PAYOUT_ADDRESS` so the pairing is visible in the deploy manifest rather than in
   * a comment.
   */
  readonly payoutAddress: string
}

export interface ChainConfig {
  readonly chain: PoolChainId
  /** Carries HTTP Basic userinfo. Never logged. */
  readonly nodeUrl: string
  readonly payoutAddress: string
  /**
   * The chains merged into this one's work, in the order configured. Empty for a chain mining alone.
   *
   * A list rather than an option because AuxPoW's commitment carries a merkle root over the aux
   * chains, and one chain is the degenerate case of that tree rather than a different mechanism.
   * `AUX_CHAIN_MERKLE_SIZE` in `auxpow.ts` currently pins the tree to a single slot, so a second
   * entry is refused at load rather than silently mined into a commitment that names only the first.
   */
  readonly aux: readonly AuxChainConfig[]
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
  /**
   * How to pay a miner, or `null` — which is what it is on every deployment that exists today.
   *
   * **Unset is a supported, tested mode and it is the default one**, exactly like `identity` above.
   * Null means no `PayoutSink` is constructed, no payout job is registered, `GET /v1/pool` keeps
   * reporting `payoutsImplemented: false`, and a matured block sits in `pool_blocks` as a record of
   * work done and money not yet moved. See `optionalUnits` for why a required variable here would
   * have taken the estate's running pool down on its next deploy, and `PayoutConfig` for what the
   * fields are.
   */
  readonly payouts: PayoutConfig | null
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

/**
 * The aux chains named for one parent, each loaded in full or refused by name.
 *
 * **Every failure here is a half-configuration**, and each one produces a pool that mines Litecoin
 * perfectly and silently mines no Dogecoin at all — a state whose only symptom is an absence, which
 * nobody notices for as long as no aux block would have been won anyway. So the variable that names
 * an aux chain and the two that configure it are all-or-nothing together, in the same way and for
 * the same reason as the stratum host/port pair above.
 */
function loadAuxChains(source: Source, parent: PoolChainId): readonly AuxChainConfig[] {
  const variable = `POOL_${parent.toUpperCase()}_AUX_CHAINS`
  const names = optional(source, variable, '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== '')
  if (names.length === 0) return Object.freeze([])

  const seen = new Set<string>()
  const aux: AuxChainConfig[] = []
  for (const name of names) {
    if (seen.has(name)) throw new EnvError(`${variable} lists ${name} twice`)
    seen.add(name)
    if (!isAuxChainId(name)) {
      // Named against the aux table rather than against POOL_CHAINS, because the mistake this
      // catches is "I put the parent in the aux list" as often as it is a typo, and answering
      // "unknown chain" for `POOL_LTC_AUX_CHAINS=ltc` sends the reader looking for a spelling error.
      throw new EnvError(
        `${variable} asks for ${name}, which this pool does not merge-mine. It merge-mines ` +
          `${AUX_CHAIN_IDS.join(', ')}; a chain mined on its own belongs in POOL_CHAINS.`,
      )
    }
    const required_parent = AUX_PARENT[name]
    if (required_parent !== parent) {
      throw new EnvError(
        `${variable} merges ${name} into ${parent}, and ${auxNameFor(name)} is merge-mined into ` +
          `${required_parent}. See AUX_PARENT in src/chains.ts: the pairing is tighter than ` +
          'consensus on purpose, because the wrong parent produces no aux blocks and no errors.',
      )
    }
    const upper = name.toUpperCase()
    aux.push({
      chain: name,
      nodeUrl: httpUrl(source, `POOL_${upper}_NODE_URL`),
      payoutAddress: required(source, `POOL_${upper}_PAYOUT_ADDRESS`),
    })
  }

  if (aux.length > AUX_CHAIN_MERKLE_SIZE) {
    // Refused at load rather than at the first job. The commitment carries a merkle root over the
    // aux chains and `auxpow.ts` pins that tree to one slot today, so a second entry would be
    // configured, logged, and then absent from every commitment this pool ever publishes.
    throw new EnvError(
      `${variable} lists ${aux.length} chains and this pool commits to ${AUX_CHAIN_MERKLE_SIZE} ` +
        '(AUX_CHAIN_MERKLE_SIZE in src/auxpow.ts). A second aux chain needs the merkle tree that ' +
        'constant stands in for, not a longer list here.',
    )
  }
  return Object.freeze(aux)
}

function loadChain(source: Source, chain: PoolChainId): ChainConfig {
  const upper = chain.toUpperCase()
  return {
    chain,
    nodeUrl: httpUrl(source, `POOL_${upper}_NODE_URL`),
    payoutAddress: required(source, `POOL_${upper}_PAYOUT_ADDRESS`),
    aux: loadAuxChains(source, chain),
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

  /*
   * Payouts, which are OFF unless somebody has typed a minimum.
   *
   * ── WHY THE MINIMUM IS THE SWITCH ───────────────────────────────────────────────────────────────
   *
   * Because it is the variable nobody can default on an operator's behalf. A ledger URL has an
   * obvious value on this estate and a credential is issued by a process; the number of litoshi a
   * miner must accrue before the pool moves money is a policy decision about somebody else's
   * earnings, and `optionalUnits` records at length why it therefore has no default and why the
   * whole block had to be optional rather than required like `POOL_FEE_BASIS_POINTS`.
   *
   * Per chain, and a chain with no minimum is simply not paid — the same per-chain treatment
   * `stratumPublicPort` gets, and for the same reason: an estate that pays Litecoin miners while it
   * decides what to do about Bitcoin is a configuration rather than a mistake.
   *
   * ── THE THREE REFUSALS ──────────────────────────────────────────────────────────────────────────
   *
   * Each is a state somebody started and did not finish, and each would otherwise produce a pool
   * that pays nobody while its operator believes it pays everybody. Nothing here falls back.
   */
  const minimums = new Map<PoolChainId, bigint>()
  for (const chain of chains) {
    const minimum = optionalUnits(source, `POOL_${chain.chain.toUpperCase()}_MINIMUM_PAYOUT`)
    if (minimum !== null) minimums.set(chain.chain, minimum)
  }
  // A minimum for a chain this pool does not mine is a variable that does nothing, typed by somebody
  // who believes that chain is being paid. Checked against POOL_CHAINS rather than against the two
  // chains this software implements, because the mistake being caught is "I set it for the wrong
  // deployment", not "I invented a chain".
  for (const name of POOL_CHAIN_IDS) {
    const variable = `POOL_${name.toUpperCase()}_MINIMUM_PAYOUT`
    if (source[variable]?.trim() && !seen.has(name)) {
      throw new EnvError(
        `${variable} sets a payout minimum for ${name} and POOL_CHAINS does not list ${name}, so it ` +
          'would pay nobody. Either mine that chain or remove the variable.',
      )
    }
  }
  /*
   * An aux chain's minimum is refused OUTRIGHT for now, and the refusal is temporary by design.
   *
   * Crediting a DOGE block needs a share to say which chain it was counted for — `share_chain`, the
   * migration this branch has not written yet — and the credit and flush jobs key on a chain the
   * handlers still validate with `isPoolChainId`. So a `POOL_DOGE_MINIMUM_PAYOUT` accepted today
   * would be read, stored, logged as configured, and then paid to nobody, which is the one outcome
   * every refusal in this block exists to prevent. **Delete this loop in the commit that wires aux
   * payouts, and widen `minimums` to `MinedChainId` in the same change** — the union type and
   * `MINED_CHAIN_IDS` are already in `chains.ts` waiting for it.
   */
  for (const name of AUX_CHAIN_IDS) {
    const variable = `POOL_${name.toUpperCase()}_MINIMUM_PAYOUT`
    if (source[variable]?.trim()) {
      throw new EnvError(
        `${variable} sets a payout minimum for ${name}, which this pool merge-mines but does not ` +
          'yet pay out: a share does not record which chain it was credited for. Mining Dogecoin ' +
          'works without it — the blocks are won and recorded — but nobody is credited, so setting ' +
          'this now would say otherwise. Remove the variable.',
      )
    }
  }
  /*
   * A node URL or a payout address for an aux chain nobody merged is the other half of the same
   * mistake, and it is the likelier one: a deploy that sets `POOL_DOGE_NODE_URL` and forgets
   * `POOL_LTC_AUX_CHAINS` has a dogecoind running, reachable, configured — and never called. Nothing
   * fails, no log line is written, and the pool mines Litecoin exactly as it did before.
   */
  const merged = new Set<AuxChainId>(chains.flatMap((chain) => chain.aux.map((aux) => aux.chain)))
  for (const name of AUX_CHAIN_IDS) {
    if (merged.has(name)) continue
    for (const suffix of ['NODE_URL', 'PAYOUT_ADDRESS'] as const) {
      const variable = `POOL_${name.toUpperCase()}_${suffix}`
      if (!source[variable]?.trim()) continue
      throw new EnvError(
        `${variable} configures ${name} and no chain merges it. Set ` +
          `POOL_${AUX_PARENT[name].toUpperCase()}_AUX_CHAINS=${name} to mine it, or remove the ` +
          'variable — as it stands this pool would never call that node.',
      )
    }
  }
  const ledgerUrl = source['LEDGER_URL']?.trim()
  const credential = source['POOL_IDENTITY_CREDENTIAL']?.trim()
  if (minimums.size > 0 && !ledgerUrl) {
    throw new EnvError(
      'a POOL_<CHAIN>_MINIMUM_PAYOUT is set and LEDGER_URL is not. A miner is paid by an entry in ' +
        'the ledger, which owns every balance in this platform; this service holds none and cannot ' +
        'credit anybody on its own.',
    )
  }
  if (minimums.size > 0 && !credential) {
    throw new EnvError(
      'a POOL_<CHAIN>_MINIMUM_PAYOUT is set and POOL_IDENTITY_CREDENTIAL is not, so there is no ' +
        'service token to post an entry with and every credit would be refused 401.',
    )
  }
  if (minimums.size > 0 && identity === null) {
    throw new EnvError(
      'a POOL_<CHAIN>_MINIMUM_PAYOUT is set and IDENTITY_ISSUER is not. The credential above is ' +
        'exchanged for a short service token at the identity service, and a pool with no estate ' +
        'behind it has nobody to exchange with — and no linked accounts to pay either.',
    )
  }
  if (minimums.size === 0 && (ledgerUrl || credential)) {
    throw new EnvError(
      'LEDGER_URL or POOL_IDENTITY_CREDENTIAL is set and no chain has a POOL_<CHAIN>_MINIMUM_PAYOUT, ' +
        'so no payout would ever be posted. The minimum is not defaulted: it is the number of ' +
        'smallest units a miner must be owed before this pool moves money, and nobody may choose ' +
        "that on the operator's behalf. State it per chain, in litoshi or satoshi.",
    )
  }
  const payouts: PayoutConfig | null =
    minimums.size > 0 && identity !== null
      ? {
          ledgerUrl: httpUrl(source, 'LEDGER_URL'),
          identityUrl: optional(source, 'IDENTITY_URL', identity.issuer),
          identityCredential: requiredCredential(source, 'POOL_IDENTITY_CREDENTIAL'),
          // A timeout, not a policy, so it defaults — the thing that must not be guessed is the
          // money. Bounded well under the payout job's interval so a hung ledger cannot pile
          // requests up behind a lease.
          deadlineMs: integer(source, 'POOL_LEDGER_DEADLINE_MS', 8_000, 250, 60_000),
          minimums,
        }
      : null

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
    // Null on every deployment that exists on 2026-08-09, and null is the tested path. See the
    // field's note and `optionalUnits`.
    payouts,
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
