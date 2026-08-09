/**
 * JSON-RPC against the estate's own Bitcoin-family nodes.
 *
 * This is deliberately a smaller thing than `indexer/src/rpc.ts`, and the difference is worth
 * stating because the two files look like they should be the same. The indexer reads chain history
 * and can read it from anybody — it holds a pool of providers, orders them by health and fails over,
 * because a public block is a public block and any endpoint that answers is as good as another.
 *
 * A pool cannot do that. `getblocktemplate` is not a read of settled history; it is a request for
 * work that a specific node has assembled from a specific mempool, and `submitblock` must go back to
 * the same node that issued the template. Two nodes hand out templates over different transaction
 * sets, so failing over between them mid-job would hand miners a job whose merkle branch belongs to
 * a block the other node never proposed. There is therefore exactly ONE endpoint per chain here, and
 * an endpoint that stops answering stops the chain rather than silently switching to another.
 *
 * ## The credential
 *
 * Bitcoin Core and its forks authenticate RPC with HTTP Basic and offer no alternative, and in this
 * estate the credential is carried as userinfo in the endpoint URL. `URL.origin` DISCARDS USERINFO —
 * `http://user:pass@host:8332` has an origin of `http://host:8332` — so a client built from the
 * origin drops the credential and the node answers **401**, which reads exactly like a wrong
 * password and sends the diagnosis to the wrong place entirely. `indexer/src/rpc.ts` carries the
 * same warning, having been bitten by it.
 *
 * The fix is to lift the credential into a default `authorization` header. The second half of the
 * fix, which matters more here, is that **nothing in this file ever puts the URL into a message, a
 * log line, a metric label or an error**. `hostOf` is the only thing that touches it, and it returns
 * host and port. An `HttpError` from `@cloudsforge/http` redacts its own URL; the errors this file
 * raises never hold one to begin with.
 */

import { CircuitOpenError, HttpClient, HttpError, TimeoutError } from '@cloudsforge/http'
import type { AuxChainId, PoolChainId } from './chains.ts'

/**
 * The chains this client can be pointed at.
 *
 * Wider than `PoolChainId` because merged mining talks to a node this pool does not mine ON — an
 * aux chain has no template, no stratum port and no share accounting here, but it has a node, and
 * every error message and log label this file produces wants to name it. The union is only ever a
 * LABEL: nothing in this file dispatches on it, so an aux chain reaching here cannot take a code
 * path meant for a primary one.
 */
export type RpcChainId = PoolChainId | AuxChainId

/** The node answered and refused. Carries the JSON-RPC error code verbatim. */
export class NodeRpcError extends Error {
  readonly code: number
  readonly rpcMethod: string
  readonly chain: RpcChainId
  constructor(args: { code: number; message: string; method: string; chain: RpcChainId }) {
    super(`${args.chain} ${args.method} → ${args.code} ${args.message}`)
    this.name = 'NodeRpcError'
    this.code = args.code
    this.rpcMethod = args.method
    this.chain = args.chain
  }
}

/** The node did not answer. Not a domain failure — the caller makes no progress and retries later. */
export class NodeUnavailableError extends Error {
  readonly rpcMethod: string
  readonly chain: RpcChainId
  constructor(args: { method: string; chain: RpcChainId; cause: string }) {
    super(`${args.chain} ${args.method}: the node did not answer — ${args.cause}`)
    this.name = 'NodeUnavailableError'
    this.rpcMethod = args.method
    this.chain = args.chain
  }
}

export interface NodeCallOptions {
  readonly deadlineMs?: number
  readonly signal?: AbortSignal
  /**
   * May this call be retried inside the HTTP client?
   *
   * JSON-RPC is a POST, and `@cloudsforge/http` attempts an unkeyed POST exactly once — the right
   * default, since a retried POST is how a wallet gets debited twice. Every method here is either a
   * read or naturally idempotent, so the flag is opt-out rather than opt-in, and `submitblock` is
   * the one worth naming: submitting the same block twice is not a double spend, it is a node that
   * answers `duplicate`. Losing a found block to one transient socket error is the far worse
   * outcome, so it retries.
   */
  readonly retryable?: boolean
}

export interface NodeRpcOptions {
  readonly chain: RpcChainId
  /** Full endpoint URL, credential and all. Never logged, never stored, never put in an error. */
  readonly url: string
  readonly deadlineMs?: number
  /** Test seam. Production builds one client and keeps it for the life of the process. */
  readonly client?: Pick<HttpClient, 'request'>
}

interface JsonRpcResponse<T> {
  readonly result?: T
  readonly error?: { code?: number; message?: string } | null
}

/**
 * The `Authorization` value for a URL that carries userinfo, or `undefined` when it does not.
 *
 * Exported so `rpc.test.ts` can assert the encoding directly, and because the estate has already
 * paid for this being wrong once. `decodeURIComponent` is not decoration: an RPC password with a
 * `@` or a `/` in it has to be percent-encoded to survive being written into a URL at all, and
 * base64-ing the still-encoded form sends a password nobody configured.
 */
export function basicAuthFor(url: string): string | undefined {
  const parsed = new URL(url)
  if (parsed.username === '') return undefined
  const user = decodeURIComponent(parsed.username)
  const pass = decodeURIComponent(parsed.password)
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
}

/**
 * **None, and none could apply.**
 *
 * The peer here is a `bitcoind` or a `litecoind`, not a CloudsForge service. The credential is HTTP
 * Basic out of the node's own URL; it is not minted by `micro-identity` and is not validated against
 * `@cloudsforge/contracts-auth`, so granting this service an estate scope would not change one byte
 * that leaves this file.
 *
 * It is written down because `micro-deploy`'s grant derivation reads any module that builds an
 * `HttpClient` and mentions a bearer as one presenting an estate credential — a deliberately loose
 * test, since a false negative yields no grant at all. `indexer/src/rpc.ts` states the same verdict
 * for the same reason and in the same words. `Object.freeze([])` rather than the
 * `NO_SCOPES_REQUIRED` spelling because `@cloudsforge/contracts-auth` is not a dependency of this
 * repository and adding one so a constant can be empty more prettily would put a package in the
 * image for no runtime effect.
 */
export const NODE_RPC_SCOPES: readonly string[] = Object.freeze([])

export class NodeRpc {
  readonly chain: RpcChainId
  /** Host and port only. Safe to log, and it is what every log line and metric label uses. */
  readonly host: string
  readonly #path: string
  readonly #client: Pick<HttpClient, 'request'>
  readonly #deadlineMs: number
  #nextId = 1

  constructor(options: NodeRpcOptions) {
    const parsed = new URL(options.url)
    this.chain = options.chain
    this.host = parsed.host
    this.#path = `${parsed.pathname}${parsed.search}`
    this.#deadlineMs = options.deadlineMs ?? 10_000

    const basic = basicAuthFor(options.url)
    this.#client =
      options.client ??
      new HttpClient({
        baseUrl: parsed.origin,
        ...(basic === undefined ? {} : { headers: { authorization: basic } }),
        // The breaker key and every metric label derive from this, so it is the chain's name and
        // never the URL.
        name: `node:${options.chain}`,
        defaultRetries: 1,
        defaultDeadlineMs: this.#deadlineMs,
      })
  }

  async call<T>(method: string, params: readonly unknown[] = [], options: NodeCallOptions = {}): Promise<T> {
    const id = this.#nextId++
    const retryable = options.retryable ?? true
    let response: JsonRpcResponse<T>
    try {
      response = await this.#client.request<JsonRpcResponse<T>>(this.#path, {
        method: 'POST',
        body: { jsonrpc: '1.0', id, method, params },
        ...(retryable ? { idempotencyKey: `${method}:${id}` } : {}),
        deadlineMs: options.deadlineMs ?? this.#deadlineMs,
        ...(options.signal ? { signal: options.signal } : {}),
      })
    } catch (err) {
      // A 500 from Core is how it reports an application-level JSON-RPC error, and the useful part
      // is in the body rather than in the status. Unwrapping it here means callers can switch on a
      // JSON-RPC code — which is what distinguishes "this block is a duplicate" from "this node is
      // gone" — instead of parsing a body at each call site.
      const unwrapped = jsonRpcErrorIn(err)
      if (unwrapped) {
        throw new NodeRpcError({ code: unwrapped.code, message: unwrapped.message, method, chain: this.chain })
      }
      throw new NodeUnavailableError({ method, chain: this.chain, cause: describe(err) })
    }

    if (response.error) {
      throw new NodeRpcError({
        code: response.error.code ?? -32000,
        message: response.error.message ?? 'unknown JSON-RPC error',
        method,
        chain: this.chain,
      })
    }
    return response.result as T
  }
}

/**
 * The JSON-RPC error inside an `HttpError`'s body, when there is one.
 *
 * Best-effort by construction: a proxy in front of the node can return an HTML 502 that parses to
 * nothing, and that is genuinely an unavailability rather than a refusal. Returning null there
 * routes it to `NodeUnavailableError`, which is the honest classification.
 */
function jsonRpcErrorIn(err: unknown): { code: number; message: string } | null {
  if (!(err instanceof HttpError)) return null
  try {
    const parsed: unknown = JSON.parse(err.body)
    if (typeof parsed !== 'object' || parsed === null) return null
    const error: unknown = (parsed as { error?: unknown }).error
    if (typeof error !== 'object' || error === null) return null
    const code: unknown = (error as { code?: unknown }).code
    const message: unknown = (error as { message?: unknown }).message
    if (typeof code !== 'number') return null
    return { code, message: typeof message === 'string' ? message : 'unknown JSON-RPC error' }
  } catch {
    return null
  }
}

function describe(err: unknown): string {
  if (err instanceof CircuitOpenError) return `circuit open (${err.upstream})`
  if (err instanceof TimeoutError) return 'timeout'
  if (err instanceof HttpError) return `http ${err.status}`
  if (err instanceof Error) return err.message
  return String(err)
}
