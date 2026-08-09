/**
 * The TCP listener and the line framing. Everything above the framing is `session.ts`.
 *
 * Stratum v1 is newline-delimited JSON-RPC over a raw socket. There is no framing beyond the
 * newline, no length prefix, no handshake and no TLS in the deployed protocol — miners speak plain
 * TCP, which is why the listener is a separate port from the HTTP one and why nothing
 * authentication-shaped happens on it.
 *
 * ## There are now two transports, and only one of them is in this file
 *
 * micro-org#289 added Stratum v1 over WebSocket, on the HTTP port, for a browser miner. That
 * transport is `wsstratum.ts` and `wsframe.ts`; **the protocol is not forked**. Both transports end
 * up in `#attach` below, building the same `Session` against the same registry and the same
 * validation, and the only thing either of them does is turn bytes into lines and lines back into
 * bytes. `Wire` is the seam: a thing that carries lines, is either a `net.Socket` or a
 * `WsConnection`, and is not asked which.
 *
 * **Raw TCP behaviour is unchanged by that addition.** A miner on the stratum port still gets a
 * free-text username, no account, no authentication and the hardware difficulty band, exactly as
 * before. Everything that is different for a browser — a redeemed ticket instead of a username, a
 * difficulty floor set for JavaScript rather than for silicon — arrives through the optional
 * `browser` block below and is reachable only from `attachWebSocket`.
 *
 * ## What this file guards against, which a naive `data` handler does not
 *
 *   - **A line that never ends.** A peer can send bytes forever with no newline in them. Without a
 *     cap the buffer grows until the process dies, and it takes every other miner's connection with
 *     it. `MAX_LINE_BYTES` is generous for the longest real message (a `mining.submit`) and small
 *     enough that thousands of connections cannot exhaust memory between them.
 *   - **A connection that connects and says nothing.** Also free for the attacker and also a slot.
 *     A socket that has not subscribed within `HANDSHAKE_TIMEOUT_MS` is closed.
 *   - **Backpressure.** `mining.notify` goes to every connection at once. If a peer stops reading,
 *     Node buffers the writes indefinitely — so a socket whose buffer is over `MAX_WRITE_BUFFER` on
 *     a push is destroyed rather than fed.
 *
 * ## Why shares are buffered before they are written
 *
 * A share submission is answered in the time it takes to hash a header. Putting a database round
 * trip in front of that reply would make the pool's acknowledgement latency the database's write
 * latency, which is the first thing a miner notices and the thing that decides whether they stay.
 *
 * So accepted shares go into an array and are flushed on a short timer. **The cost is real and is
 * stated rather than hidden: a hard kill loses up to one flush interval of shares.** For a debt
 * record that is a genuine (if small) unfairness, so the interval is short, the flush runs on
 * shutdown before the process exits, and a block is NEVER buffered — a found block is written
 * synchronously, before the miner is even told the share was accepted, because that one record is
 * worth more than every other row in the table put together.
 */

import { createServer, type Server, type Socket } from 'node:net'
import { randomBytes } from 'node:crypto'
import { Session, type AcceptedShare, type FoundAuxBlock, type FoundBlock, type SpoiledAuxBlock } from './session.ts'
import type { JobRegistry, Job } from './work.ts'
import type { VardiffOptions } from './vardiff.ts'
import type { RedeemedTicket } from './tickets.ts'
import type { AddressVerdict } from './payoutaddress.ts'
// A value import, which is allowed here and not in `session.ts`: this file is server-only and is
// never loaded out of a bare checkout, so the package resolves. It is the boundary — the name is
// read once here and handed down.
import { nameFor, type PoolChainId, type PowAlgorithm } from './chains.ts'

/** Longest line accepted. A `mining.submit` is around 200 bytes; this is two orders of magnitude up. */
export const MAX_LINE_BYTES = 16 * 1024
const HANDSHAKE_TIMEOUT_MS = 30_000
const IDLE_TIMEOUT_MS = 10 * 60_000
const MAX_WRITE_BUFFER = 1024 * 1024
const EXTRANONCE1_BYTES = 4
export const EXTRANONCE2_BYTES = 4

/**
 * Something that carries stratum lines. A `net.Socket` and a WebSocket both are one.
 *
 * Deliberately not `net.Socket` and deliberately not an `EventEmitter`: this is the entire contract
 * between a transport and the protocol, it is four methods and two properties, and writing it down
 * is what makes it impossible for the second transport to grow behaviour the first does not have.
 * `wsframe.ts`'s `WsConnection` satisfies it structurally, as does the adapter around `net.Socket`
 * below — neither implements an interface by name, so neither can drift from it silently.
 */
export interface Wire {
  readonly destroyed: boolean
  /** Bytes queued but not yet flushed. `broadcast` drops a connection that stops draining. */
  readonly writableLength: number
  /** One line, newline included. */
  write(line: string): void
  destroy(): void
  onData(handler: (chunk: string) => void): void
  onClose(handler: () => void): void
}

/**
 * What differs for a connection arriving over WebSocket. Absent means this pool serves browsers not
 * at all, which is the default and the only mode raw TCP has ever known.
 */
export interface BrowserTransportOptions {
  /**
   * Where a browser connection starts, which is nowhere near where a rig starts. `vardiff.ts` has
   * the arithmetic: at Litecoin's hardware start of 512, one share is 37 hours of pure-JS scrypt.
   */
  readonly initialDifficulty: number
  /** The hardware band with its floor moved for the transport. See `browserVardiff`. */
  readonly vardiff: VardiffOptions
  /**
   * Spend a mining ticket, or refuse. Mandatory on this transport — a WebSocket connection has no
   * other way to name an account, and the label it mines under is this function's answer and never
   * the client's claim.
   */
  readonly redeemTicket: (secret: string) => RedeemedTicket | null
}

export interface StratumServerOptions {
  readonly chain: PoolChainId
  readonly algorithm: PowAlgorithm
  readonly registry: JobRegistry
  readonly host: string
  readonly port: number
  readonly initialDifficulty: number
  readonly vardiff: VardiffOptions
  /** Present only when an operator has configured identity; see `env.ts` and `index.ts`. */
  readonly browser?: BrowserTransportOptions | undefined
  /**
   * Ask the chain's node whether a raw TCP miner's username is an address it would pay to.
   *
   * Handed to every session and consulted by none of the browser ones — a session holding a
   * `redeemTicket` never reads a username at all, so the branch in `session.ts` that calls this is
   * unreachable there. Optional so that a `StratumServer` can still be constructed without a node,
   * which is what most of `stratum.test.ts` does. micro-org#286.
   */
  readonly checkPayoutAddress?: ((address: string) => Promise<AddressVerdict>) | undefined
  readonly flushIntervalMs?: number
  /**
   * How long a connection may stay silent before it is closed. Defaults to `HANDSHAKE_TIMEOUT_MS`.
   *
   * A seam, and one worth having rather than leaving the constant unreachable: the slot-exhaustion
   * this defends against is the cheapest attack on the listener, and a test that has to wait thirty
   * seconds to prove the defence works is a test that gets deleted the first time the suite feels
   * slow.
   */
  readonly handshakeTimeoutMs?: number
  readonly now?: () => number
  /** Called with a batch of accepted shares. Must not throw; a failure here is logged and dropped. */
  readonly persistShares: (shares: readonly AcceptedShare[]) => Promise<void>
  /** Called synchronously on a block, before the miner is told anything. Must not throw. */
  readonly onBlock: (block: FoundBlock) => void
  /**
   * The same, for the merged chain. Both required — see `SessionDeps`.
   *
   * Passed through unconditionally rather than only for chains with an aux chain configured. Whether
   * merged mining is on is a property of the JOB, decided in `work.ts` from what the registry holds,
   * and a listener that also decided it would be a second copy of that decision in a file that has
   * no business having an opinion about Dogecoin.
   */
  readonly onAuxBlock: (block: FoundAuxBlock) => void
  readonly onAuxSpoiled: (spoiled: SpoiledAuxBlock) => void
  /** Every submission's outcome, for counters. Rejections are counted and never stored. */
  readonly onOutcome?: (outcome: 'accepted' | 'rejected', code: number | null) => void
  readonly log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void
}

interface Connection {
  readonly wire: Wire
  readonly session: Session
  readonly extranonce1: Buffer
  buffer: string
  handshakeTimer: NodeJS.Timeout | null
}

/**
 * A `net.Socket` seen as a `Wire`.
 *
 * The encoding and the two socket-level timers are set here rather than by the caller so that the
 * TCP transport's whole shape is in one place. `setEncoding('utf8')` is what makes `data` a string
 * on this path and matches what the WebSocket transport delivers, so the line splitter above sees
 * one kind of chunk.
 */
function socketWire(socket: Socket): Wire {
  // Nagle's algorithm batches small writes, and every message in this protocol is a small write.
  // Left on, a `mining.notify` can sit in the kernel for tens of milliseconds after a new block —
  // which is exactly the interval in which every share being computed is already worthless.
  socket.setNoDelay(true)
  socket.setTimeout(IDLE_TIMEOUT_MS)
  socket.setEncoding('utf8')
  socket.on('timeout', () => socket.destroy())
  socket.on('error', () => socket.destroy())
  return {
    get destroyed() {
      return socket.destroyed
    },
    get writableLength() {
      return socket.writableLength
    },
    write: (line) => {
      if (!socket.destroyed) socket.write(line)
    },
    destroy: () => socket.destroy(),
    onData: (handler) => {
      socket.on('data', (chunk: string | Buffer) => handler(typeof chunk === 'string' ? chunk : chunk.toString('utf8')))
    },
    onClose: (handler) => {
      socket.on('close', handler)
    },
  }
}

export class StratumServer {
  readonly chain: PoolChainId
  readonly #options: StratumServerOptions
  readonly #connections = new Set<Connection>()
  readonly #extranonces = new Set<string>()
  #server: Server | null = null
  #pending: AcceptedShare[] = []
  #flushTimer: NodeJS.Timeout | null = null
  #closing = false
  readonly #now: () => number

  constructor(options: StratumServerOptions) {
    this.chain = options.chain
    this.#options = options
    this.#now = options.now ?? (() => Date.now())
  }

  get connectionCount(): number {
    return this.#connections.size
  }

  /**
   * The port actually bound, or null before `listen` and after `close`.
   *
   * Not the same number as `options.port`, which is the point: a suite that wants a real socket has
   * to ask for port 0 and let the kernel choose, because a hard-coded port makes the tests fail
   * against whatever else on the machine happened to be listening — and fail as a bind error in a
   * `before` hook, which reads like a broken test rather than a busy port. Production passes a real
   * port and this answers it back.
   */
  get boundPort(): number | null {
    const address = this.#server?.address()
    return address !== null && typeof address === 'object' ? address.port : null
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.#accept(socket))
      server.on('error', reject)
      server.listen(this.#options.port, this.#options.host, () => {
        server.off('error', reject)
        server.on('error', (err) => this.#options.log('error', 'stratum listener error', { err: String(err) }))
        this.#server = server
        this.#scheduleFlush()
        resolve()
      })
    })
  }

  /** Whether this chain will accept a browser. False unless the deploy configured identity. */
  get servesBrowsers(): boolean {
    return this.#options.browser !== undefined
  }

  /** Push a job to every authorised connection. The fan-out `mining.notify` exists for. */
  broadcast(job: Job, cleanJobs: boolean): void {
    for (const connection of this.#connections) {
      if (connection.wire.writableLength > MAX_WRITE_BUFFER) {
        // The peer has stopped reading. Feeding it more is how one dead miner becomes the pool's
        // memory ceiling.
        this.#options.log('warn', 'dropping a connection that is not draining', { chain: this.chain })
        connection.wire.destroy()
        continue
      }
      connection.session.pushJob(job, cleanJobs)
    }
  }

  /**
   * Take a connection that arrived over WebSocket.
   *
   * Returns false when this chain serves no browsers, which is not an error: identity is optional
   * configuration and a pool run by somebody with no estate at all is the ordinary case. The caller
   * turns that into a refused upgrade rather than a socket that connects and then says nothing.
   */
  attachWebSocket(wire: Wire): boolean {
    const browser = this.#options.browser
    if (browser === undefined || this.#closing) return false
    this.#attach(wire, browser)
    return true
  }

  async close(): Promise<void> {
    this.#closing = true
    if (this.#flushTimer) clearTimeout(this.#flushTimer)
    this.#flushTimer = null
    for (const connection of this.#connections) connection.wire.destroy()
    this.#connections.clear()
    const server = this.#server
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      this.#server = null
    }
    // The last flush, after the listener is closed and before the process is allowed to exit. This
    // is the difference between a clean deploy losing nothing and losing a few seconds of shares.
    await this.flush()
  }

  /** Write everything buffered. Called on a timer and once more at shutdown. */
  async flush(): Promise<void> {
    if (this.#pending.length === 0) return
    const batch = this.#pending
    this.#pending = []
    try {
      await this.#options.persistShares(batch)
    } catch (err) {
      // Putting them back would risk an unbounded queue against a database that is down, and
      // dropping them silently would be the accounting failure §6 is about. So they are dropped
      // LOUDLY, with the count, which is the honest option of the three.
      this.#options.log('error', 'lost a batch of accepted shares', {
        chain: this.chain,
        shares: batch.length,
        err: String(err),
      })
    }
  }

  #scheduleFlush(): void {
    if (this.#closing) return
    // A self-rescheduling timeout rather than `setInterval`, so a slow flush delays the next one
    // instead of stacking a second write behind it. The estate's CI rejects an unmarked
    // `setInterval` for exactly this reason.
    const timer = setTimeout(() => {
      void this.flush().finally(() => this.#scheduleFlush())
    }, this.#options.flushIntervalMs ?? 2_000)
    timer.unref?.()
    this.#flushTimer = timer
  }

  #accept(socket: Socket): void {
    if (this.#closing) {
      socket.destroy()
      return
    }
    // No browser options: a raw TCP miner authorises with a username exactly as it always has.
    this.#attach(socketWire(socket), undefined)
  }

  /**
   * Build one session on one wire. The single place a connection comes into existence.
   *
   * Both transports arrive here, which is the point: the handshake timeout, the extranonce
   * allocation, the line splitting, the share buffering and the teardown are one implementation, and
   * a change to any of them cannot apply to one transport and not the other.
   */
  #attach(wire: Wire, browser: BrowserTransportOptions | undefined): void {
    const extranonce1 = this.#allocateExtranonce1()
    const vardiff = browser?.vardiff ?? this.#options.vardiff
    const connection: Connection = {
      wire,
      extranonce1,
      buffer: '',
      handshakeTimer: null,
      session: new Session({
        chain: this.chain,
        chainName: nameFor(this.chain),
        algorithm: this.#options.algorithm,
        registry: this.#options.registry,
        extranonce1,
        extranonce2Size: EXTRANONCE2_BYTES,
        initialDifficulty: browser?.initialDifficulty ?? this.#options.initialDifficulty,
        minDifficulty: vardiff.minDifficulty,
        maxDifficulty: vardiff.maxDifficulty,
        vardiff,
        now: this.#now,
        send: (message) => wire.write(`${JSON.stringify(message)}\n`),
        onAcceptedShare: (share) => this.#pending.push(share),
        onBlock: (block) => this.#options.onBlock(block),
        onAuxBlock: (block) => this.#options.onAuxBlock(block),
        onAuxSpoiled: (spoiled) => this.#options.onAuxSpoiled(spoiled),
        onOutcome: this.#options.onOutcome,
        // Undefined on raw TCP, which is what keeps that path byte-for-byte what it was: a session
        // with no redeemer reads the username and ignores the password, exactly as before.
        redeemTicket: browser?.redeemTicket,
        // And the mirror of it: the address check belongs to the username path, so it is passed to
        // a browser session too and is simply never reached there. Written this way rather than
        // conditionally, so that the ONE place deciding which identity a transport uses stays
        // `session.ts` — a second copy of that decision here is how the two drift apart.
        checkPayoutAddress: this.#options.checkPayoutAddress,
      }),
    }
    this.#connections.add(connection)

    connection.handshakeTimer = setTimeout(() => {
      if (!connection.session.authorised) wire.destroy()
    }, this.#options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS)
    connection.handshakeTimer.unref?.()

    wire.onData((chunk) => this.#onData(connection, chunk))
    wire.onClose(() => {
      if (connection.handshakeTimer) clearTimeout(connection.handshakeTimer)
      this.#extranonces.delete(extranonce1.toString('hex'))
      this.#connections.delete(connection)
    })
  }

  /**
   * A per-connection extranonce1, unique among live connections.
   *
   * Random rather than a counter, because two replicas behind one DNS name must not hand the same
   * value to two different miners — a counter would give both replicas 00000001 for their first
   * connection, and those two miners would then search identical coinbase space and duplicate each
   * other's work for as long as they both stayed. Four random bytes make that a 1-in-4-billion
   * accident instead of a certainty, and the in-process set removes it entirely within a replica.
   */
  #allocateExtranonce1(): Buffer {
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const candidate = randomBytes(EXTRANONCE1_BYTES)
      const hex = candidate.toString('hex')
      if (!this.#extranonces.has(hex)) {
        this.#extranonces.add(hex)
        return candidate
      }
    }
    throw new Error('could not allocate a unique extranonce1 — too many live connections')
  }

  #onData(connection: Connection, chunk: string): void {
    connection.buffer += chunk
    if (connection.buffer.length > MAX_LINE_BYTES) {
      this.#options.log('warn', 'closing a connection that sent an oversized line', { chain: this.chain })
      connection.wire.destroy()
      return
    }

    let newline = connection.buffer.indexOf('\n')
    while (newline !== -1) {
      const line = connection.buffer.slice(0, newline).trim()
      connection.buffer = connection.buffer.slice(newline + 1)
      if (line !== '') this.#onLine(connection, line)
      newline = connection.buffer.indexOf('\n')
    }
  }

  #onLine(connection: Connection, line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // Not JSON at all — a port scan, a browser, a miner pointed at the wrong port. There is no id
      // to answer to, so there is nothing to say.
      connection.wire.destroy()
      return
    }
    if (typeof parsed !== 'object' || parsed === null) {
      connection.wire.destroy()
      return
    }
    const message = parsed as { id?: unknown; method?: unknown; params?: unknown }
    if (typeof message.method !== 'string') return

    const id =
      typeof message.id === 'number' || typeof message.id === 'string' ? message.id : null
    const params = Array.isArray(message.params) ? (message.params as unknown[]) : []

    try {
      connection.session.handle({ id, method: message.method, params })
    } catch (err) {
      // One connection's bad input must never take the listener down. The socket is closed because
      // a session that threw is a session whose state nobody can vouch for.
      this.#options.log('error', 'a stratum session threw', {
        chain: this.chain,
        method: message.method,
        err: String(err),
      })
      connection.wire.destroy()
    }
  }
}
