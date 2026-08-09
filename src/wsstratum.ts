/**
 * Stratum v1 over WebSocket, on the HTTP port. The transport a browser can actually reach.
 *
 * `stratum.ts` is the raw TCP listener and `session.ts` is the protocol; this file is a third thing
 * that feeds the same `session.ts` frames from a different pipe. **The protocol is not forked.** A
 * connection arriving here ends up in the same `#attach` as a connection arriving on port 3334,
 * building the same `Session` against the same `JobRegistry` and the same validation, and the only
 * difference between them is how a line becomes bytes.
 *
 * ## Why this is on the EXISTING HTTP port and not a port of its own
 *
 * Because a browser cannot reach a new one. Everything published from this estate arrives through a
 * Cloudflare Tunnel and then Traefik: the tunnel carries HTTP and WebSocket and cannot carry a raw
 * TCP stream at all, which is the whole reason the stratum port is bound to loopback and
 * `stratumEndpoint` is null on the deployed pool. A second container port would need a second router,
 * a second hostname and a second certificate to be worth anything, and it would be reachable by
 * exactly the same set of clients as this path. Sharing `PORT` costs one `upgrade` listener.
 *
 * ## ═══ KEEPALIVE IS APPLICATION-LEVEL, BECAUSE NOTHING BELOW CAN DO IT ═══════════════════════
 *
 * A mining connection is idle in the HTTP sense for long stretches: between one `mining.notify` and
 * the next there may be a minute of silence in each direction, and a browser doing a few hundred
 * hashes a second submits a share every few seconds at best. Every hop between the tab and this
 * process has an opinion about how long a silent connection may live, and the precedent for what to
 * do about it is Hearth's `HEARTH_P2P_WS` — the estate's other long-lived WebSocket, container port
 * 8648, `PathPrefix('/p2p')`, router `cf-api-p2p` in `deploy/gateway/dynamic/estate-web.yml`. That
 * router's own comment is titled "NOTHING HERE MAY KILL A HEALTHY LONG-LIVED CONNECTION", and the
 * three findings behind it apply here unchanged:
 *
 *   - **Traefik has no per-router idle timeout.** `respondingTimeouts` is static configuration on an
 *     entrypoint, not something a dynamic router can set, so there is no knob in the gateway to turn
 *     for this path even if somebody wanted to.
 *   - **Go stops counting the moment the connection is hijacked.** `net/http`'s `(*conn).hijackLocked`
 *     calls `rwc.SetDeadline(time.Time{})`, clearing both deadlines, so an upgraded connection is not
 *     subject to the read or write timeouts a Go proxy applies to ordinary requests. (Noted because
 *     it is the reason the gateway CANNOT help, not because anything here is Go — micro-pool is
 *     TypeScript on Node, and Node's own `server.setTimeout` never applied to an upgraded socket
 *     either.)
 *   - **Cloudflare's edge closes an idle WebSocket at roughly a hundred seconds, and that is the one
 *     clock this estate cannot set.** It is not configurable on the plan the estate runs on and it is
 *     the shortest of the lot, so it is the number every other value here is chosen against.
 *
 * Hence `WS_PING_MS` and `WS_IDLE_MS` below, both taken from Hearth's `P2P_WS_PING_MS` and
 * `P2P_WS_IDLE_MS` for the reason its `params.js` gives: a ping every twenty seconds keeps the
 * connection carrying bytes well inside the edge's window, and declaring death at seventy seconds
 * means **three missed pings, not one**, so a single scheduling hiccup on a laptop that has just
 * woken up does not disconnect a miner mid-share.
 *
 * ## The handshake is unauthenticated, and the authorisation is in the protocol
 *
 * Nothing is checked at upgrade time beyond the shape of the request and whether this pool serves
 * the chain that was asked for. No bearer token, no ticket in the query string, no `Origin`
 * allowlist. That is deliberate and `tickets.ts` carries the argument: the browser `WebSocket`
 * constructor cannot set headers, so anything presented at handshake time would have to travel in
 * the URL — into every access log between the tab and here — and the credential is instead spent
 * inside the protocol, in the `mining.authorize` password field, which this service has never logged.
 *
 * An unauthorised connection can therefore be opened by anybody, and it can do exactly one thing:
 * sit there until the handshake timeout in `stratum.ts` closes it. It gets no job, no difficulty and
 * no extranonce it can use, because `session.ts` hands out work only after `mining.authorize`
 * succeeds.
 *
 * ## CORS
 *
 * There is none here, and none is needed. A WebSocket upgrade is not subject to the same-origin
 * policy and carries no preflight, so a CORS header on this response would be decoration. The estate
 * gateway already applies `cf-cors` to every `websecure` router — which is what makes the ordinary
 * `POST /v1/pool/ticket` fetch work from the console origin — and this file neither sets a CORS
 * header nor reads `Origin`. Hearth's p2p endpoint refuses any request carrying an `Origin` header
 * precisely because a browser must never be a gossip peer; here a browser is the ONLY intended
 * client, so the same check would refuse every real caller.
 */

import type { Server as HttpServer, IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { acceptKey, WsConnection } from './wsframe.ts'
import { isPoolChainId, type PoolChainId } from './chains.ts'
import { MAX_LINE_BYTES, type Wire } from './stratum.ts'

/**
 * Where a browser dials, minus the chain.
 *
 * Under `/v1` because that is what the estate gateway already routes to this service — `cf-api-pool`
 * matches `PathPrefix('/v1')` on the pool hostname — so publishing this transport needed no new
 * router, no new rule and no new hostname. A path outside `/v1` would have needed all three, and a
 * gateway change is a change in a repository this one does not own.
 *
 * `env.ts` refuses a `POOL_WEBSOCKET_PUBLIC_ORIGIN` that carries a path, so that this constant is the
 * only place the path exists and a deploy cannot pin a stale copy of it.
 */
export const STRATUM_WS_PATH = '/v1/pool/stratum'

/** See the header. Three missed pings before a connection is declared dead, never one. */
export const WS_PING_MS = 20_000
export const WS_IDLE_MS = 70_000

/** Reason phrases for the handful of refusals below. A refused upgrade never reaches a route. */
const UPGRADE_STATUS: Readonly<Record<number, string>> = Object.freeze({
  400: 'Bad Request',
  404: 'Not Found',
  426: 'Upgrade Required',
  503: 'Service Unavailable',
})

/** The part of a `StratumServer` this file needs. Structural, so a test can pass a stub. */
export interface StratumTarget {
  attachWebSocket(wire: Wire): boolean
}

export interface WsStratumOptions {
  readonly server: HttpServer
  /** This pool's listener for a chain, or null when it does not serve that chain at all. */
  readonly resolve: (chain: PoolChainId) => StratumTarget | null
  readonly log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void
  readonly pingMs?: number
  readonly idleMs?: number
}

/**
 * Answer WebSocket upgrades on the HTTP server, for as long as it lives.
 *
 * Returns nothing to detach with, deliberately: the listener's lifetime is the server's, and the
 * shutdown path in `index.ts` closes the server and then the stratum listeners, which destroys every
 * live connection through the same route a TCP miner takes.
 */
export function attachStratumWebSocket(options: WsStratumOptions): void {
  const pingMs = options.pingMs ?? WS_PING_MS
  const idleMs = options.idleMs ?? WS_IDLE_MS

  options.server.on('upgrade', (req: IncomingMessage, duplex: Duplex, head: Buffer) => {
    // The `upgrade` event is typed as a `Duplex` because that is the weakest thing it could be. It
    // is always a `net.Socket` — an upgraded connection is the raw TCP stream the request arrived
    // on — and `wsframe.ts` needs `setNoDelay` and `setTimeout` off it.
    const socket = duplex as Socket
    const refuse = (status: number, why: string): void => {
      // The path is logged, truncated, and nothing else from the request is. A refused upgrade is a
      // log line anything on the internet can make this process write, so it carries no header, no
      // query string and no address.
      options.log('debug', 'refused a websocket upgrade', { status, why, path: pathOf(req).slice(0, 64) })
      try {
        socket.write(
          `HTTP/1.1 ${status} ${UPGRADE_STATUS[status] ?? 'Error'}\r\n` +
            'Connection: close\r\n' +
            'Content-Length: 0\r\n\r\n',
        )
      } catch {
        /* the peer may already be gone */
      }
      socket.destroy()
    }

    if (String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
      refuse(400, 'not a websocket upgrade')
      return
    }
    const chain = chainOf(pathOf(req))
    if (chain === null) {
      refuse(404, `this endpoint is ${STRATUM_WS_PATH}/<chain>`)
      return
    }
    if (String(req.headers['sec-websocket-version'] ?? '') !== '13') {
      refuse(400, 'unsupported websocket version')
      return
    }
    const key = req.headers['sec-websocket-key']
    if (typeof key !== 'string' || Buffer.from(key, 'base64').length !== 16) {
      refuse(400, 'missing or malformed Sec-WebSocket-Key')
      return
    }

    const target = options.resolve(chain)
    if (target === null) {
      // Either this pool does not serve that chain, or it serves it and is not currently able to
      // hand out work. Both are 503 rather than 404 from the client's point of view, and neither is
      // worth distinguishing to a stranger: a page that cannot mine right now retries either way.
      refuse(503, 'no browser mining on this chain right now')
      return
    }

    socket.setNoDelay(true)
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        // No `Sec-WebSocket-Protocol`. A subprotocol is not negotiated, and echoing one a client
        // asked for would be agreeing to something nobody has written down. The browser client sends
        // no protocol list; see the wire contract in the README.
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    )

    const connection = new WsConnection(socket, {
      // The same cap the TCP transport applies to a line, applied here to an assembled message. One
      // message is one line, so one number covers both and a browser cannot use fragmentation to
      // hold more of this process's memory than a miner on a socket can.
      maxMessageBytes: MAX_LINE_BYTES,
      pingMs,
      idleMs,
      onProtocolError: (reason) => options.log('debug', 'websocket connection dropped', { chain, reason }),
    })

    if (!target.attachWebSocket(connection)) {
      // Between `resolve` and here the chain stopped serving — a shutdown, in practice. Nothing has
      // been sent yet, so the connection is closed rather than left to time out.
      connection.destroy()
      return
    }
    // Bytes the HTTP parser read past the handshake. Fed only after the session exists, or a client
    // that pipelined `mining.subscribe` into its upgrade request would lose it.
    if (head && head.length > 0) connection.push(head)
  })
}

function pathOf(req: IncomingMessage): string {
  return (req.url ?? '/').split('?')[0] ?? '/'
}

/**
 * The chain a path names, or null.
 *
 * Scoped per chain rather than selected by a message, because a connection's extranonce, difficulty
 * and job history all belong to one chain's listener and there is no moment at which moving between
 * them would be coherent. It is in the path rather than in a query parameter so that the endpoint
 * this service publishes is one complete URL a browser passes to `new WebSocket(...)` with nothing to
 * assemble — which is the whole lesson of micro-org#285.
 */
function chainOf(path: string): PoolChainId | null {
  if (!path.startsWith(`${STRATUM_WS_PATH}/`)) return null
  const rest = path.slice(STRATUM_WS_PATH.length + 1)
  const name = rest.toLowerCase()
  return isPoolChainId(name) ? name : null
}
