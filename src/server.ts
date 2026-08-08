/**
 * The HTTP surface. Not the mining surface — that is `stratum.ts`, on its own TCP port.
 *
 * Plain `node:http`, kept from the service template along with the request-id echo, the RED metrics
 * and the single error shape. Rule 4 of docs/ecosystem/03 §2: `/livez`, `/readyz` and `/metrics` on
 * every service, or it does not pass CI.
 *
 * ## Everything here is public, and that is a decision rather than an omission
 *
 * The template's `@cloudsforge/auth` wiring is gone, and none of these routes takes a bearer token.
 * The reason is in `env.ts` at more length, and it comes from 36 §6: **"the share history has to be
 * checkable by the miner against their own machine, which is a product requirement and not a
 * nicety."** The only identity a miner has at this service is the stratum username they typed into
 * their own firmware — there is no estate account behind it, and there cannot be, because the whole
 * point is that a stranger with an ASIC can point it here and be paid. Gating the share history
 * behind an estate login would make it checkable by nobody.
 *
 * What follows from that, and is enforced below rather than assumed:
 *
 *   - **`account` is a query parameter, not an authenticated subject.** Anybody may read anybody's
 *     shares. That is the same posture as every public pool and as a block explorer: the data is a
 *     record of work done against a public chain, and it is already visible in the coinbase.
 *   - **Nothing here writes.** There is no POST, no PUT and no DELETE on this port. The only thing
 *     that mutates state in this service is a share arriving on the stratum port, and that path does
 *     not pass through this file.
 *   - **Every list is bounded** by a `limit` that is clamped rather than trusted, because an
 *     unauthenticated caller asking for a million rows is a database load-generator otherwise.
 */

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Lifecycle } from '@cloudsforge/lifecycle'
import { Metrics, newRequestId, type Logger } from '@cloudsforge/telemetry'
import { hashesPerDifficulty } from './pow.ts'
import { unitsToDifficulty } from './pplns.ts'
import { algorithmFor, assetFor, decimalsFor, isPoolChainId, type PoolChainId } from './chains.ts'
import { chainActivity, recentBlocks, sharesForAccount, workersForAccount, type Exec } from './store.ts'
import type { ChainStatus } from './chainservice.ts'

export interface PoolSnapshot {
  readonly network: string
  readonly feeBasisPoints: number
  readonly pplnsMultiplier: number
  readonly chains: readonly ChainStatus[]
}

export interface ServerDeps {
  readonly lifecycle: Lifecycle
  readonly logger: Logger
  readonly metrics: Metrics
  readonly sql: Exec
  /** The live state of every configured chain. Read, never cached — it changes every template. */
  readonly snapshot: () => PoolSnapshot
  /**
   * Refresh sampled gauges immediately before `/metrics` renders.
   *
   * Connection counts and template age are values that must be read, not counted, and reading them
   * on a timer would be the one `setInterval` in this repository — which is precisely the shape rule
   * 8 exists to keep out. A scrape is already periodic, so the scrape is when to sample.
   */
  readonly beforeScrape?: () => Promise<void>
}

/**
 * The window a "current" hashrate is estimated over.
 *
 * Ten minutes is a compromise between two wrong answers. Shorter, and a miner submitting a share
 * every thirty seconds sees their reported hashrate swing by half between page loads, because share
 * arrival is Poisson and a handful of samples says almost nothing. Longer, and a rig that stopped
 * five minutes ago is still reported as mining, which is the failure an operator is most likely to
 * be looking at this page to catch.
 */
const HASHRATE_WINDOW_SECONDS = 600

/**
 * An inbound request id is trusted only if it is safe to put in a log line and echo in a header.
 * Anything else is replaced rather than rejected — the caller does not need a 400 over this, and
 * an unvalidated value here is a header-injection and a log-forgery primitive at once.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/

interface Reply {
  readonly status: number
  readonly body?: unknown
  readonly text?: string
  readonly contentType?: string
}

interface RequestContext {
  readonly req: IncomingMessage
  readonly url: URL
  readonly requestId: string
  readonly log: Logger
}

interface Route {
  readonly method: string
  readonly path: string
  readonly handle: (ctx: RequestContext, deps: ServerDeps) => Promise<Reply>
}

export function createServer(deps: ServerDeps): Server {
  const routes = buildRoutes()
  let inFlight = 0

  return createHttpServer((req, res) => {
    const startedAt = process.hrtime.bigint()
    const presented = headerOf(req, 'x-request-id')
    const requestId = presented && SAFE_REQUEST_ID.test(presented) ? presented : newRequestId()

    // Echoed before anything can fail, so even a 500 carries the id the user will quote.
    res.setHeader('x-request-id', requestId)

    const url = new URL(req.url ?? '/', `http://${headerOf(req, 'host') ?? 'localhost'}`)
    const route = routes.find((r) => r.method === (req.method ?? 'GET') && r.path === url.pathname)
    // Unmatched paths collapse to one label. Using the raw path would let any caller mint
    // unbounded time series and take the scrape target down with cardinality.
    const routeLabel = route ? route.path : 'unmatched'

    const log = deps.logger.child({ requestId, method: req.method ?? 'GET', route: routeLabel })

    inFlight += 1
    deps.metrics.set('http_requests_in_flight', inFlight)

    const finish = (status: number) => {
      inFlight -= 1
      deps.metrics.set('http_requests_in_flight', inFlight)
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6
      deps.metrics.increment('http_requests_total', {
        method: req.method ?? 'GET',
        route: routeLabel,
        status: String(status),
      })
      deps.metrics.observe('http_request_duration_ms', durationMs, {
        method: req.method ?? 'GET',
        route: routeLabel,
      })
    }

    void handle(route, { req, url, requestId, log }, deps)
      .then((reply) => {
        send(res, reply, requestId)
        finish(reply.status)
      })
      .catch((err: unknown) => {
        // Reaching here means the error mapping itself failed. Answer, then say so loudly.
        log.error('request handler threw after mapping', { err })
        send(res, errorReply(500, 'internal', 'the request could not be completed', requestId), requestId)
        finish(500)
      })
  })
}

async function handle(route: Route | undefined, ctx: RequestContext, deps: ServerDeps): Promise<Reply> {
  if (!route) {
    return errorReply(404, 'not_found', `no route for ${ctx.req.method} ${ctx.url.pathname}`, ctx.requestId)
  }
  try {
    return await route.handle(ctx, deps)
  } catch (err) {
    if (err instanceof BadRequestError) {
      return errorReply(400, 'bad_request', err.message, ctx.requestId)
    }
    ctx.log.error('unhandled request failure', { err })
    return errorReply(500, 'internal', 'the request could not be completed', ctx.requestId)
  }
}

function buildRoutes(): Route[] {
  return [
    {
      method: 'GET',
      path: '/livez',
      /**
       * Static, deliberately. Liveness answers one question — should this process be killed and
       * restarted — and a liveness probe that consults a dependency restarts a healthy process
       * every time the database blinks. For this service the stakes are higher than usual: a
       * restart drops every miner's TCP connection and loses whatever shares are still buffered.
       */
      handle: async (_ctx, deps) => ({ status: 200, body: deps.lifecycle.livez() }),
    },
    {
      method: 'GET',
      path: '/readyz',
      handle: async (_ctx, deps) => {
        const report = await deps.lifecycle.readyz()
        return { status: report.ready ? 200 : 503, body: report }
      },
    },
    {
      method: 'GET',
      path: '/metrics',
      handle: async (ctx, deps) => {
        try {
          await deps.beforeScrape?.()
        } catch (err) {
          ctx.log.warn('gauge refresh failed; serving the previous values', { err })
        }
        return {
          status: 200,
          text: deps.metrics.render(),
          contentType: 'text/plain; version=0.0.4; charset=utf-8',
        }
      },
    },
    {
      method: 'GET',
      path: '/v1/pool',
      /**
       * What this pool is and what it is currently doing. The front page of 36 §5.4.
       *
       * `payoutsImplemented: false` is in the response body rather than only in the README, because
       * a `micro-pool-web` written against this API would otherwise have to know from documentation
       * that the number it is about to show is not a balance. Making it a field means the UI can be
       * built now and cannot accidentally imply a payment that will not arrive.
       */
      handle: async (_ctx, deps) => {
        const snapshot = deps.snapshot()
        const chains = await Promise.all(
          snapshot.chains.map(async (status) => {
            const chain = status.chain as PoolChainId
            const activity = await chainActivity(deps.sql, { chain, sinceSeconds: HASHRATE_WINDOW_SECONDS })
            return {
              chain,
              name: status.name,
              asset: assetFor(chain),
              decimals: decimalsFor(chain),
              algorithm: status.algorithm,
              stratumPort: status.stratumPort,
              connections: status.connections,
              height: status.height,
              networkDifficulty: status.networkDifficulty,
              templateAgeSeconds: status.templateAgeSeconds,
              ready: status.ready,
              windowSeconds: HASHRATE_WINDOW_SECONDS,
              sharesInWindow: activity.shares,
              workersInWindow: activity.workers,
              hashrateEstimate: hashrateFrom(chain, activity.units, HASHRATE_WINDOW_SECONDS),
            }
          }),
        )
        return {
          status: 200,
          body: {
            network: snapshot.network,
            feeBasisPoints: snapshot.feeBasisPoints,
            pplnsWindowMultiplier: snapshot.pplnsMultiplier,
            // Named, not implied. See `payouts.ts`.
            payoutsImplemented: false,
            chains,
          },
        }
      },
    },
    {
      method: 'GET',
      path: '/v1/pool/blocks',
      handle: async (ctx, deps) => {
        const chain = chainParam(ctx, deps)
        const blocks = await recentBlocks(deps.sql, { chain, limit: limitParam(ctx, 50, 200) })
        return {
          status: 200,
          body: {
            chain,
            asset: assetFor(chain),
            decimals: decimalsFor(chain),
            payoutsImplemented: false,
            blocks: blocks.map((block) => ({
              height: block.height,
              hash: block.hash,
              foundAt: block.foundAt.toISOString(),
              // A string, because it is money in the smallest unit and a JSON number is not a safe
              // container for one. Estate convention: `contracts-chain` amounts cross a wire as text.
              reward: block.reward.toString(),
              networkDifficulty: unitsToDifficulty(block.networkDifficultyUnits),
              // The node's verdict, verbatim. A rejected block is shown rather than hidden — it is
              // the single most useful diagnostic this service can publish, and a pool that only
              // displayed its accepted blocks would be hiding the one failure miners must know about.
              submitStatus: block.submitStatus,
              submitDetail: block.submitDetail,
            })),
          },
        }
      },
    },
    {
      method: 'GET',
      path: '/v1/pool/workers',
      handle: async (ctx, deps) => {
        const chain = chainParam(ctx, deps)
        const account = accountParam(ctx)
        const workers = await workersForAccount(deps.sql, {
          chain,
          account,
          sinceSeconds: HASHRATE_WINDOW_SECONDS,
        })
        return {
          status: 200,
          body: {
            chain,
            account,
            windowSeconds: HASHRATE_WINDOW_SECONDS,
            workers: workers.map((worker) => ({
              worker: worker.worker,
              lastSeenAt: worker.lastSeenAt.toISOString(),
              difficulty: worker.lastDifficulty === null ? null : unitsToDifficulty(worker.lastDifficulty),
              sharesInWindow: worker.recentShares,
              hashrateEstimate: hashrateFrom(chain, worker.recentUnits, HASHRATE_WINDOW_SECONDS),
            })),
          },
        }
      },
    },
    {
      method: 'GET',
      path: '/v1/pool/shares',
      /**
       * One account's share history, share by share.
       *
       * This is the endpoint 36 §6 asks for. It returns the job id, the difficulty the share was
       * credited at and the difficulty it actually achieved — which is exactly what a miner's own
       * log records — so the two can be reconciled line for line. A count would not be checkable
       * against anything, and "checkable by the miner against their own machine" is the requirement.
       */
      handle: async (ctx, deps) => {
        const chain = chainParam(ctx, deps)
        const account = accountParam(ctx)
        const shares = await sharesForAccount(deps.sql, { chain, account, limit: limitParam(ctx, 100, 1_000) })
        return {
          status: 200,
          body: {
            chain,
            account,
            shares: shares.map((share) => ({
              id: share.id.toString(),
              worker: share.worker,
              jobId: share.jobId,
              height: share.height,
              creditedDifficulty: unitsToDifficulty(share.difficultyUnits),
              achievedDifficulty: unitsToDifficulty(share.achievedUnits),
              isBlock: share.isBlock,
              createdAt: share.createdAt.toISOString(),
            })),
          },
        }
      },
    },
  ]
}

/**
 * Hashes per second implied by the difficulty credited over a window.
 *
 * The conversion is per algorithm and that is the entire reason this is a function rather than a
 * multiplication at each call site. Difficulty 1 on SHA-256d is 2^32 hashes; on scrypt, whose
 * difficulty-1 target is 2^16 times looser, it is 2^16. A single formula would report every
 * Litecoin miner as 65,536 times faster than they are — and it would be believed, because the number
 * has no unit attached that would look wrong.
 */
function hashrateFrom(chain: PoolChainId, units: bigint, seconds: number): number {
  if (seconds <= 0) return 0
  return (unitsToDifficulty(units) * hashesPerDifficulty(algorithmFor(chain))) / seconds
}

/** The chain to query. Required when the pool serves more than one, because there is no sane default. */
function chainParam(ctx: RequestContext, deps: ServerDeps): PoolChainId {
  const configured = deps.snapshot().chains.map((status) => status.chain)
  const raw = ctx.url.searchParams.get('chain')?.trim().toLowerCase()
  if (!raw) {
    if (configured.length === 1 && isPoolChainId(configured[0] ?? '')) return configured[0] as PoolChainId
    throw new BadRequestError(`chain is required; this pool serves ${configured.join(', ')}`)
  }
  if (!isPoolChainId(raw) || !configured.includes(raw)) {
    throw new BadRequestError(`this pool does not serve ${raw}; it serves ${configured.join(', ')}`)
  }
  return raw
}

/**
 * The account whose records are being asked for.
 *
 * Validated against the same character set `parseWorkerName` accepts, so a value that could never
 * have been stored is refused with a 400 rather than becoming a query that returns nothing. The two
 * are indistinguishable to a caller otherwise, and "no shares" is the answer a miner will read as
 * "the pool lost my work".
 */
function accountParam(ctx: RequestContext): string {
  const account = ctx.url.searchParams.get('account')?.trim() ?? ''
  if (account === '') throw new BadRequestError('account is required')
  if (account.length > 96 || !/^[A-Za-z0-9_:-]+$/.test(account)) {
    throw new BadRequestError('account is not a worker name this pool could have stored')
  }
  return account
}

function limitParam(ctx: RequestContext, fallback: number, max: number): number {
  const raw = ctx.url.searchParams.get('limit')
  if (raw === null || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) throw new BadRequestError('limit must be a positive whole number')
  // Clamped rather than refused: a caller asking for more than the ceiling gets the ceiling, which
  // is what they wanted, and the ceiling is what keeps an unauthenticated endpoint from being a way
  // to ask the database for every share ever recorded.
  return Math.min(value, max)
}

class BadRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadRequestError'
  }
}

/**
 * The error shape, identical on every failure and always carrying the request id.
 *
 * The id in the body rather than only in the header is what makes a support conversation work: a
 * user can read back what their browser showed them, and it joins to the log line and the trace.
 */
function errorReply(status: number, code: string, message: string, requestId: string): Reply {
  return { status, body: { error: { code, message, requestId } } }
}

function send(res: ServerResponse, reply: Reply, requestId: string): void {
  if (res.writableEnded) return
  const payload = reply.text ?? `${JSON.stringify(reply.body ?? {})}\n`
  res.writeHead(reply.status, {
    'content-type': reply.contentType ?? 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'x-request-id': requestId,
    // Health, metrics and pool state are all point-in-time facts. A cached 200 from a replica that
    // has since gone unready is exactly the lie this whole package exists to stop telling.
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}
