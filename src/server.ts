/**
 * The HTTP surface. Not the mining surface — that is `stratum.ts`, on its own TCP port.
 *
 * Plain `node:http`, kept from the service template along with the request-id echo, the RED metrics
 * and the single error shape. Rule 4 of docs/ecosystem/03 §2: `/livez`, `/readyz` and `/metrics` on
 * every service, or it does not pass CI.
 *
 * ## Every READ here is public, and that is a decision rather than an omission
 *
 * None of the routes that answer a question about work already done takes a bearer token. The reason
 * is in `env.ts` at more length, and it comes from 36 §6: **"the share history has to be checkable by
 * the miner against their own machine, which is a product requirement and not a nicety."** The only
 * identity a miner has at this service is the stratum username they typed into their own firmware —
 * there is no estate account behind it, and there cannot be, because the whole point is that a
 * stranger with an ASIC can point it here and be paid. Gating the share history behind an estate
 * login would make it checkable by nobody.
 *
 * What follows from that, and is enforced below rather than assumed:
 *
 *   - **`account` is a query parameter, not an authenticated subject.** Anybody may read anybody's
 *     shares. That is the same posture as every public pool and as a block explorer: the data is a
 *     record of work done against a public chain, and it is already visible in the coinbase.
 *   - **Every list is bounded** by a `limit` that is clamped rather than trusted, because an
 *     unauthenticated caller asking for a million rows is a database load-generator otherwise.
 *
 * ## There is now exactly ONE authenticated route, and it is the only thing here that writes
 *
 * `POST /v1/pool/ticket`, added by micro-org#289. This file used to say "nothing here writes"; that
 * is no longer true and the exception is narrow enough to state completely. The route verifies an
 * estate access token, finds or creates the caller's opaque pool account, and mints a sixty-second
 * single-use ticket that a browser spends on the WebSocket mining transport. It exists because the
 * browser `WebSocket` constructor cannot set request headers — `tickets.ts` holds that argument.
 *
 * Three properties of it are load-bearing and are enforced below:
 *
 *   - **A token fault is 401, a verifier fault is 503.** `statusFor` from `@cloudsforge/auth` makes
 *     that decision, and the difference matters: answering 401 because the identity service is having
 *     a bad minute signs every user in the estate out of the miner.
 *   - **Users only.** A service token is refused with 403. There is no operator use for a mining
 *     ticket, and a service principal has no user id to credit work to.
 *   - **The response is the only place the ticket ever appears.** It is not logged, not counted by
 *     value and not stored beyond `TicketStore`'s map.
 */

import { NetworkUnknownError, requestNetwork, type Network } from '@cloudsforge/http'
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Lifecycle } from '@cloudsforge/lifecycle'
import { Metrics, newRequestId, type Logger } from '@cloudsforge/telemetry'
import { bearerFrom, statusFor, type Principal } from '@cloudsforge/auth'
import { hashesPerDifficulty } from './pow.ts'
import { unitsToDifficulty } from './pplns.ts'
import {
  algorithmFor,
  assetFor,
  auxAssetFor,
  decimalsFor,
  isMinedChainId,
  isPoolChainId,
  minedAssetFor,
  minedDecimalsFor,
  type MinedChainId,
  type PoolChainId,
} from './chains.ts'
import { chainActivity, recentBlocks, sharesForAccount, workersForAccount, type Exec } from './store.ts'
import { accountForUser, newBrowserWorkerLabel, type MintedTicket } from './tickets.ts'
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
  /**
   * The estate the STRATUM LISTENERS serve — `POOL_NETWORK`.
   *
   * Still a process-wide value, and correctly so: there is one set of listeners on one chain set,
   * and testnet stratum is explicitly deferred (micro-deploy `docs/network-consolidation.md` §9).
   * This is what a request's `CF-Network` is compared AGAINST, not a substitute for it.
   */
  readonly network: Network
  /** The live state of every configured chain. Read, never cached — it changes every template. */
  readonly snapshot: () => PoolSnapshot
  /**
   * Whether this deployment can pay anybody, as `payoutsImplemented` in `payouts.ts` derived it.
   *
   * A dependency and not a literal in the two handlers that publish it. Until 2026-08-10 both wrote
   * `false` inline, which was accurate and unfalsifiable: nothing connected the sentence a client
   * reads to the interlock and the configuration that decide it, so the day either changed the wire
   * would have kept saying whatever was typed. `index.ts` passes
   * `payoutsImplemented(env.payouts !== null)` and has nothing else to pass.
   *
   * Not part of `PoolSnapshot`, because a snapshot is what changes every template and this does not
   * change at all after boot.
   */
  readonly payoutsImplemented: boolean
  /**
   * Refresh sampled gauges immediately before `/metrics` renders.
   *
   * Connection counts and template age are values that must be read, not counted, and reading them
   * on a timer would be the one `setInterval` in this repository — which is precisely the shape rule
   * 8 exists to keep out. A scrape is already periodic, so the scrape is when to sample.
   */
  readonly beforeScrape?: () => Promise<void>
  /**
   * Browser mining, or `undefined` when this deployment has no estate identity configured.
   *
   * Optional because identity is optional (`env.ts` says why at length): a pool run by somebody with
   * no estate at all is the ordinary case for this software, and it must start. When this is absent
   * the ticket route still EXISTS and answers 503 with a reason, rather than 404 — the difference is
   * the one a browser client can act on. A 404 says "you are talking to something that is not a
   * pool"; a 503 says "this pool does not offer browser mining", which is a true statement about a
   * correctly deployed service and is exactly what `GET /v1/pool`'s null endpoint already implies.
   */
  readonly browserMining?: BrowserMiningDeps | undefined
}

export interface BrowserMiningDeps {
  /**
   * Turn a bearer token into a principal, or throw. `Verifier.principal` in production; the shape is
   * structural so a test can supply one without a JWKS server.
   */
  readonly principal: (token: string) => Promise<Principal>
  /** Mint a ticket for an account. The secret is returned to the caller and never logged. */
  readonly mint: (identity: { account: string; worker: string }) => MintedTicket
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

/**
 * Routes that answer without belonging to a network — kubelet and Prometheus bypass the gateway.
 */
const OPERATIONAL_ROUTES: ReadonlySet<string> = new Set(['/livez', '/readyz', '/metrics'])

interface RequestContext {
  readonly req: IncomingMessage
  readonly url: URL
  readonly requestId: string
  readonly log: Logger
  /**
   * The estate this request is asking about, from the `CF-Network` header.
   *
   * pool is the one wave-5 service where the two halves genuinely differ: the API is dual-network,
   * the STRATUM LISTENERS are not. `POOL_CHAINS` is mainnet-only and testnet stratum is explicitly
   * deferred (micro-deploy `docs/network-consolidation.md` §9) until somebody makes it a product
   * decision — so there is no testnet pool DATA to serve, and never has been.
   *
   * That makes the honest answer to a testnet request "there is no pool on this network", not
   * mainnet's hashrate with a testnet label on it. The alternative — serving mainnet's numbers to
   * a testnet viewer — is the exact defect the frontends were fixed for: pool presence must follow
   * the network being VIEWED, not the container doing the serving.
   */
  readonly network: Network
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

    // ── CROSS-ORIGIN READS, THE INDEXER'S WAY (micro-org#459 stage 3) ─────────────────────────
    //
    // pool-web viewing the OTHER network fetches this pool's public state from the sibling
    // estate's pages, anonymously. The indexer already carries the estate's answer for public
    // chain facts, reasons documented at its header site: wildcard origin carries no credentials
    // semantics — browsers refuse `*` + credentials outright, so a cookie can never ride on it,
    // and a presented bearer still has to survive verification like any other. The route table
    // has no OPTIONS entries, so without this a genuine preflight 404s and every cross-origin
    // read dies before it is made. Only a genuine preflight (it names the method it asks about)
    // is short-circuited; a bare OPTIONS still falls through to the 404 below.
    if ((req.method ?? '') === 'OPTIONS' && headerOf(req, 'access-control-request-method')) {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type, x-request-id, traceparent, tracestate, baggage',
        'access-control-max-age': '86400',
      })
      res.end()
      return
    }

    const route = routes.find((r) => r.method === (req.method ?? 'GET') && r.path === url.pathname)
    // Unmatched paths collapse to one label. Using the raw path would let any caller mint
    // unbounded time series and take the scrape target down with cardinality.
    const routeLabel = route ? route.path : 'unmatched'

    const log = deps.logger.child({ requestId, method: req.method ?? 'GET', route: routeLabel })

    inFlight += 1
    deps.metrics.set('http_requests_in_flight', inFlight)

    const finish = (status: number, metricNetwork: string) => {
      inFlight -= 1
      deps.metrics.set('http_requests_in_flight', inFlight)
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6
      deps.metrics.increment('http_requests_total', {
        method: req.method ?? 'GET',
        route: routeLabel,
        status: String(status),
        network: metricNetwork,
      })
      deps.metrics.observe('http_request_duration_ms', durationMs, {
        method: req.method ?? 'GET',
        route: routeLabel,
        network: metricNetwork,
      })
    }

    const networkless = route !== undefined && OPERATIONAL_ROUTES.has(route.path)
    let network: Network
    try {
      network = networkless
        ? deps.network
        : requestNetwork(req.headers, { fallback: deps.network })
    } catch (err) {
      log.error('request carries no usable network', {
        err: err instanceof NetworkUnknownError ? err.message : err,
      })
      send(res, errorReply(500, 'network_unknown', 'this request could not be attributed to a network', requestId), requestId)
      finish(500, 'unknown')
      return
    }

    void handle(route, { req, url, requestId, log, network }, deps)
      .then((reply) => {
        send(res, reply, requestId)
        finish(reply.status, network)
      })
      .catch((err: unknown) => {
        // Reaching here means the error mapping itself failed. Answer, then say so loudly.
        log.error('request handler threw after mapping', { err })
        send(res, errorReply(500, 'internal', 'the request could not be completed', requestId), requestId)
        finish(500, network)
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
       * `payoutsImplemented` is in the response body rather than only in the README, because a
       * `micro-pool-web` written against this API would otherwise have to know from documentation
       * that the number it is about to show is not a balance. Making it a field means the UI can be
       * built now and cannot accidentally imply a payment that will not arrive.
       *
       * It is `false` on every deployment that exists, and it is DERIVED rather than written down:
       * `deps.payoutsImplemented` comes from `payoutsImplemented()` in `payouts.ts`, which ANDs the
       * `CUSTODY_BACKING_CLOSED` interlock with whether an operator configured a payout minimum at
       * all. A literal here would have been a promise this file could make without the sink's
       * agreement, and micro-org#302 asked for the flip to be one act rather than four.
       *
       * ## `stratumEndpoint` is null far more often than it is not, and null is an answer
       *
       * The same principle, applied to the thing a miner actually needs. This response used to
       * carry a port and no name, which left every consumer to invent the other half — and
       * micro-pool-web duly derived it from `window.location.hostname`, producing
       * `stratum+tcp://pool.<apex>:3334` on a public page. That endpoint cannot connect: the
       * console's hostname is served through a Cloudflare Tunnel and Traefik, neither of which
       * forwards a raw TCP stream, and the listener is bound to loopback by default anyway. A
       * plausible connection string that does not connect is worse than no connection string,
       * because its owner debugs their hardware instead of asking a question (micro-org#285).
       *
       * So the endpoint is reported when an operator has published one and is **null** otherwise —
       * not the `Host` header, not the bind address, not the bound port. A consumer renders the
       * absence. `stratumPort` remains beside it and is the BIND: honest about itself, useless as
       * half of a connection string, and named as such in `ChainStatus`.
       *
       * ## `websocketEndpoint` is reported the same way, and for the same reason
       *
       * micro-org#289 added a second transport a browser can reach, and it gets the treatment #285
       * settled rather than a second answer to the same question: it is a complete URL taken from
       * `POOL_WEBSOCKET_PUBLIC_ORIGIN` with this service's own path appended, or **null**. It is
       * never assembled from the request `Host`, never defaulted from `PORT`, and there is no
       * fallback for it to be quietly wrong in. Null means no operator has published one — a page
       * renders the absence instead of dialling an address nobody promised.
       *
       * ## `browserMining` is the one field here that says WHY, and it is not the same as the null
       *
       * micro-org#360. A null `websocketEndpoint` has always meant "you cannot mine this in a
       * browser", and it means it for two completely different reasons that a consumer reading
       * null alone cannot tell apart: no operator published an origin — a deployment fact, with
       * nothing to say to a reader — or this pool refuses the chain to browsers on purpose. BTC is
       * the second. It is mined here by hardware over Stratum and refused to browsers by name,
       * because at 793 EH/s of purpose-built SHA-256 silicon a browser tab returns shares that can
       * never become a block, and a page that renders that refusal as an absence tells its reader
       * the deployment is unfinished rather than that the answer is no.
       *
       * So the stance travels: `{available, reason}`, `available` narrowed by BOTH the chain table
       * and whether this deployment serves browsers at all, `reason` only ever the table's. A
       * consumer prints the reason verbatim when it is non-null and falls back to its own wording
       * when it is null — which is exactly what `{available: false, reason: null}` means, a chain
       * this pool would serve on a deployment that has published nowhere to serve it from.
       *
       * It is copied here field by field like everything else in this object rather than spread
       * out of `status()`, and it was missed on the first pass: 2.5.20 reached mainnet with the
       * stance computed, enforced at the transport and absent from the wire, so `GET /v1/pool`
       * reported BTC exactly as it reports a chain nobody published — which is the failure the
       * field exists to prevent.
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
              stratumEndpoint: status.stratumEndpoint,
              websocketEndpoint: status.websocketEndpoint,
              // Both halves named, so a consumer can distinguish a refusal from an absence without
              // asking a second question. Copied rather than spread for the same reason `merged` is.
              browserMining: {
                available: status.browserMining.available,
                reason: status.browserMining.reason,
              },
              connections: status.connections,
              height: status.height,
              networkDifficulty: status.networkDifficulty,
              templateAgeSeconds: status.templateAgeSeconds,
              ready: status.ready,
              windowSeconds: HASHRATE_WINDOW_SECONDS,
              sharesInWindow: activity.shares,
              workersInWindow: activity.workers,
              hashrateEstimate: hashrateFrom(chain, activity.units, HASHRATE_WINDOW_SECONDS),
              /**
               * The merge-mined chain, or null. Copied field by field rather than spread, like
               * everything else in this object, so that adding a field to `MergedChainStatus`
               * cannot publish it by accident.
               *
               * `hashrateEstimate` is deliberately NOT repeated inside it. The hashrate that mines
               * an aux block is the parent's, entire — it is the same shares, the same units and
               * the number immediately above; a second copy under a Dogecoin heading would read as
               * a second pool's worth of hashing.
               */
              merged: status.merged
                ? {
                    chain: status.merged.chain,
                    name: status.merged.name,
                    asset: auxAssetFor(status.merged.chain),
                    committed: status.merged.committed,
                    unavailability: status.merged.unavailability,
                    height: status.merged.height,
                    networkDifficulty: status.merged.networkDifficulty,
                  }
                : null,
            }
          }),
        )
        return {
          status: 200,
          body: {
            network: snapshot.network,
            feeBasisPoints: snapshot.feeBasisPoints,
            pplnsWindowMultiplier: snapshot.pplnsMultiplier,
            // Named, not implied, and derived rather than typed. See `payouts.ts`.
            payoutsImplemented: deps.payoutsImplemented,
            chains,
          },
        }
      },
    },
    {
      method: 'POST',
      path: '/v1/pool/ticket',
      /**
       * Mint one mining ticket for the authenticated user. The only write on this port.
       *
       * The request carries no body and none is read — everything this route needs is in the
       * `Authorization` header, and a body would be a second place for a client to say who it is.
       * The chain is not named here either: a ticket is worth one authorisation on one connection,
       * and WHICH chain that connection is for is already in the WebSocket path. Scoping it twice
       * would create a pair that can disagree.
       *
       * The response carries the account and the worker label so a page can show them before a share
       * has ever been submitted — both are the SERVER's, generated here, and neither is anything the
       * client asked for. `expiresInMs` rather than an absolute time, because the one clock a browser
       * and this process reliably share is the elapsed one; a `Date` here would be compared against a
       * laptop that is forty seconds out and produce a ticket that looks expired on arrival.
       */
      handle: async (ctx, deps) => {
        // Nothing reads the body, and an unread request body keeps a keep-alive connection from
        // being reusable. Draining it is one line and costs nothing.
        ctx.req.resume()

        const browser = deps.browserMining
        if (browser === undefined) {
          return errorReply(
            503,
            'browser_mining_unavailable',
            'this pool is not configured for browser mining; point mining firmware at the stratum port instead',
            ctx.requestId,
          )
        }

        const token = bearerFrom(headerOf(ctx.req, 'authorization'))
        if (token === null) {
          return errorReply(401, 'unauthenticated', 'a bearer token is required to mine from a browser', ctx.requestId)
        }

        let principal: Principal
        try {
          principal = await browser.principal(token)
        } catch (err) {
          const status = statusFor(err)
          if (status === null) throw err
          // The reason is not echoed. A verification failure's message names key ids, issuers and
          // clock skews, and repeating it to an unauthenticated caller is how a token oracle is
          // built. The log line below carries what an operator needs.
          ctx.log.warn('a ticket request was refused', { status })
          return status === 503
            ? errorReply(503, 'identity_unavailable', 'identity could not be reached; try again shortly', ctx.requestId)
            : errorReply(status, 'unauthenticated', 'that token was not accepted', ctx.requestId)
        }

        if (principal.kind !== 'user') {
          // A service principal has no user id, so there is nothing to credit the work to, and there
          // is no operator task that needs a mining ticket. 403 rather than 401: the credential was
          // perfectly good and presenting a better one will not help.
          return errorReply(403, 'forbidden', 'a mining ticket belongs to a person, not to a service', ctx.requestId)
        }

        const account = await accountForUser(deps.sql, principal.userId)
        const ticket = browser.mint({ account, worker: newBrowserWorkerLabel() })
        // The account and the worker, never the secret. This line is the audit trail for browser
        // mining and it must stay safe to keep.
        ctx.log.info('minted a mining ticket', { account, worker: ticket.worker })
        return {
          status: 200,
          body: {
            ticket: ticket.secret,
            account: ticket.account,
            worker: ticket.worker,
            expiresInMs: Math.max(0, ticket.expiresAtMs - Date.now()),
          },
        }
      },
    },
    {
      method: 'GET',
      path: '/v1/pool/blocks',
      handle: async (ctx, deps) => {
        const chain = minedChainParam(ctx, deps)
        const blocks = await recentBlocks(deps.sql, { chain, limit: limitParam(ctx, 50, 200) })
        return {
          status: 200,
          body: {
            chain,
            asset: minedAssetFor(chain),
            decimals: minedDecimalsFor(chain),
            // The second place this reaches a client, and the one a block list makes most tempting
            // to drop: a page showing found blocks is exactly where a reader infers a payment.
            payoutsImplemented: deps.payoutsImplemented,
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
              // What the node said LATER, which is a different claim from `submitStatus` and the one
              // that decides whether the reward exists. `maturity.ts`: a submission the node accepted
              // onto its tip can still lose a reorg well inside the 100-block coinbase maturity
              // window, so this is published beside the submission verdict rather than replacing it.
              // `pending` until the watcher has re-read the block, which is also the state of every
              // block for the first four hours (Litecoin) after it is found.
              maturityStatus: block.maturityStatus,
              // The node's own count, and negative when the node holds the block but it is off the
              // active chain. Null when the watcher has not managed to ask yet.
              confirmations: block.confirmations,
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

/**
 * The chain to query for records of WORK — shares and workers. A share chain, never an aux one.
 *
 * Required when the pool serves more than one, because there is no sane default.
 *
 * An aux chain is refused here rather than accepted and answered with an empty list, and the
 * refusal is the honest answer rather than a limitation: a merge-mined chain has no shares of its
 * own and never will. A miner's Litecoin work is what produced the Dogecoin block, so their share
 * history for it IS their Litecoin share history, and answering `chain=doge` with zero shares would
 * tell a miner their merged work was not recorded. See `minedChainParam` for the other half.
 */
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
 * The chain to query for BLOCKS, which is a wider set than the chain to query for shares.
 *
 * ── WHY THIS IS A SECOND FUNCTION AND NOT A FLAG ON THE FIRST ─────────────────────────────────
 *
 * `pool_blocks` is keyed by `MinedChainId` and `pool_shares` by `PoolChainId`; that split is the
 * whole shape of merge mining in this service. A merge-mined Dogecoin block is a real block with a
 * real hash, a real reward and a real maturity countdown, and until this existed it was recorded in
 * a table nothing could read back — the pool would have won DOGE that no miner, and no operator,
 * could see anywhere except in the database. The two callers want different sets and neither wants
 * a boolean deciding which one it is getting.
 *
 * The set offered is what this deployment can actually have won: the configured share chains, plus
 * the aux chains those chains are committing to. It is read off the live snapshot rather than off
 * `MINED_CHAIN_IDS`, so a pool with no aux configured refuses `doge` exactly as it did before, with
 * the same sentence — a 400 saying which chains exist is a better answer than a 200 with an empty
 * list, which reads as "the pool found nothing" rather than "the pool does not mine that".
 *
 * The DEFAULT when `chain` is absent stays the single share chain and never becomes an aux one. A
 * reader who asked no question means the chain they point a miner at.
 */
function minedChainParam(ctx: RequestContext, deps: ServerDeps): MinedChainId {
  const chains = deps.snapshot().chains
  const parents = chains.map((status) => status.chain)
  // Only aux chains this pool is configured for. `merged` is non-null exactly when an operator set
  // `POOL_<PARENT>_AUX_CHAINS`, and it stays non-null while the aux node is unreachable — a block
  // won an hour ago is still readable during an outage that stops new ones being won.
  const aux = chains.flatMap((status) => (status.merged ? [status.merged.chain] : []))
  const served: string[] = [...parents, ...aux]

  const raw = ctx.url.searchParams.get('chain')?.trim().toLowerCase()
  if (!raw) {
    if (parents.length === 1 && isPoolChainId(parents[0] ?? '')) return parents[0] as PoolChainId
    throw new BadRequestError(`chain is required; this pool mines ${served.join(', ')}`)
  }
  if (!isMinedChainId(raw) || !served.includes(raw)) {
    throw new BadRequestError(`this pool does not mine ${raw}; it mines ${served.join(', ')}`)
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
    // See the OPTIONS handler above for why this is `*` and why that grants nothing. On the
    // estate's own credentialed surfaces the gateway's cf-cors overwrites this with an echoed
    // origin (measured on the indexer, which set the precedent); for everyone else — the sibling
    // estate's pages, a community dashboard — this is what lets a browser read a public fact.
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'x-request-id',
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
