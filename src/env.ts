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
 * **No `IDENTITY_JWKS_URL` and no auth.** The read API is public, because the only identity a miner
 * has here is the stratum username they chose and there is no estate account behind it. A miner must
 * be able to check their own share history — 36 §6 makes that a product requirement — and gating it
 * behind an estate login would exclude every miner who does not have one, which is all of them.
 */

import { hostname } from 'node:os'
import type { Network } from '@cloudsforge/contracts-chain'
import { isPoolChainId, REFUSED_CHAINS, type PoolChainId } from './chains.ts'

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
 * An RPC endpoint, checked for shape but never echoed.
 *
 * The check is on the URL's structure only. **The value is not repeated in the error**, because a
 * node RPC URL in this estate carries HTTP Basic userinfo and an error message is the most reliably
 * logged string in any process. `rpc.ts` holds the same line: host and port may be logged, the URL
 * never is.
 */
function nodeUrl(source: Source, name: string): string {
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

export interface ChainConfig {
  readonly chain: PoolChainId
  /** Carries HTTP Basic userinfo. Never logged. */
  readonly nodeUrl: string
  readonly payoutAddress: string
  readonly stratumPort: number
  readonly initialDifficulty: number
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
    nodeUrl: nodeUrl(source, `POOL_${upper}_NODE_URL`),
    payoutAddress: required(source, `POOL_${upper}_PAYOUT_ADDRESS`),
    stratumPort: integer(source, `POOL_${upper}_STRATUM_PORT`, DEFAULT_STRATUM_PORT[chain], 1, 65_535),
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
