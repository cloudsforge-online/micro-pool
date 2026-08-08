/**
 * The TCP listener and the line framing. Everything above the framing is `session.ts`.
 *
 * Stratum v1 is newline-delimited JSON-RPC over a raw socket. There is no framing beyond the
 * newline, no length prefix, no handshake and no TLS in the deployed protocol — miners speak plain
 * TCP, which is why the listener is a separate port from the HTTP one and why nothing
 * authentication-shaped happens on it.
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
import { Session, type AcceptedShare, type FoundBlock, type OutgoingMessage } from './session.ts'
import type { JobRegistry, Job } from './work.ts'
import type { VardiffOptions } from './vardiff.ts'
import type { PoolChainId, PowAlgorithm } from './chains.ts'

/** Longest line accepted. A `mining.submit` is around 200 bytes; this is two orders of magnitude up. */
export const MAX_LINE_BYTES = 16 * 1024
const HANDSHAKE_TIMEOUT_MS = 30_000
const IDLE_TIMEOUT_MS = 10 * 60_000
const MAX_WRITE_BUFFER = 1024 * 1024
const EXTRANONCE1_BYTES = 4
export const EXTRANONCE2_BYTES = 4

export interface StratumServerOptions {
  readonly chain: PoolChainId
  readonly algorithm: PowAlgorithm
  readonly registry: JobRegistry
  readonly host: string
  readonly port: number
  readonly initialDifficulty: number
  readonly vardiff: VardiffOptions
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
  /** Every submission's outcome, for counters. Rejections are counted and never stored. */
  readonly onOutcome?: (outcome: 'accepted' | 'rejected', code: number | null) => void
  readonly log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void
}

interface Connection {
  readonly socket: Socket
  readonly session: Session
  readonly extranonce1: Buffer
  buffer: string
  handshakeTimer: NodeJS.Timeout | null
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

  /** Push a job to every authorised connection. The fan-out `mining.notify` exists for. */
  broadcast(job: Job, cleanJobs: boolean): void {
    for (const connection of this.#connections) {
      if (connection.socket.writableLength > MAX_WRITE_BUFFER) {
        // The peer has stopped reading. Feeding it more is how one dead miner becomes the pool's
        // memory ceiling.
        this.#options.log('warn', 'dropping a connection that is not draining', { chain: this.chain })
        connection.socket.destroy()
        continue
      }
      connection.session.pushJob(job, cleanJobs)
    }
  }

  async close(): Promise<void> {
    this.#closing = true
    if (this.#flushTimer) clearTimeout(this.#flushTimer)
    this.#flushTimer = null
    for (const connection of this.#connections) connection.socket.destroy()
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
    // Nagle's algorithm batches small writes, and every message in this protocol is a small write.
    // Left on, a `mining.notify` can sit in the kernel for tens of milliseconds after a new block —
    // which is exactly the interval in which every share being computed is already worthless.
    socket.setNoDelay(true)
    socket.setTimeout(IDLE_TIMEOUT_MS)

    const extranonce1 = this.#allocateExtranonce1()
    const connection: Connection = {
      socket,
      extranonce1,
      buffer: '',
      handshakeTimer: null,
      session: new Session({
        chain: this.chain,
        algorithm: this.#options.algorithm,
        registry: this.#options.registry,
        extranonce1,
        extranonce2Size: EXTRANONCE2_BYTES,
        initialDifficulty: this.#options.initialDifficulty,
        minDifficulty: this.#options.vardiff.minDifficulty,
        maxDifficulty: this.#options.vardiff.maxDifficulty,
        vardiff: this.#options.vardiff,
        now: this.#now,
        send: (message) => this.#send(socket, message),
        onAcceptedShare: (share) => this.#pending.push(share),
        onBlock: (block) => this.#options.onBlock(block),
        onOutcome: this.#options.onOutcome,
      }),
    }
    this.#connections.add(connection)

    connection.handshakeTimer = setTimeout(() => {
      if (!connection.session.authorised) socket.destroy()
    }, this.#options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS)
    connection.handshakeTimer.unref?.()

    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => this.#onData(connection, chunk))
    socket.on('timeout', () => socket.destroy())
    socket.on('error', () => socket.destroy())
    socket.on('close', () => {
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
      connection.socket.destroy()
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
      connection.socket.destroy()
      return
    }
    if (typeof parsed !== 'object' || parsed === null) {
      connection.socket.destroy()
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
      connection.socket.destroy()
    }
  }

  #send(socket: Socket, message: OutgoingMessage): void {
    if (socket.destroyed) return
    socket.write(`${JSON.stringify(message)}\n`)
  }
}
