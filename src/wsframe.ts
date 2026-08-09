/**
 * RFC 6455 server framing, and nothing above it.
 *
 * This file is to `wsstratum.ts` what `stratum.ts`'s line splitter is to `session.ts`: it turns a
 * byte stream into whole messages and back, and it has no idea what a message means. The protocol
 * above it is unchanged and lives where it always did.
 *
 * ## Why this is hand-written and not `ws`
 *
 * `ws` is the obvious answer and it is not taken, for three reasons that are checkable rather than
 * stylistic:
 *
 *   - **Nothing in this estate depends on it.** Hearth needed a WebSocket for gossip through a
 *     Cloudflare Tunnel and wrote `node/src/ws.js` rather than take the dependency; that file is the
 *     precedent this one follows, down to the shape of the frame reader. A second, divergent answer
 *     to "how does CloudsForge frame a WebSocket" is worth more scrutiny than one dependency saves.
 *   - **The adaptation is total.** Stratum is already newline-delimited JSON, so ONE TEXT MESSAGE IS
 *     ONE STRATUM LINE, with no re-framing and no change below `session.ts`. What is actually needed
 *     is the handshake, the three length forms, client masking, continuation and ping/pong — small,
 *     fully specified, and testable against vectors published in the RFC rather than against this
 *     file's own encoder.
 *   - **The surface is a browser's.** A WebSocket endpoint is reachable from any page on the
 *     internet with no preflight, which the raw TCP listener is not. Every bound here is therefore
 *     taken from the DECLARED length before a byte of payload is buffered, and applies to the
 *     assembled message so that continuation frames are not a way around it.
 *
 * ## What is deliberately not implemented
 *
 * permessage-deflate (RSV1 is refused outright, because a peer must not be able to hand a mining
 * pool a decompression bomb), subprotocol negotiation (see `wsstratum.ts` — the ticket travels in
 * the protocol, not in the handshake), and binary frames, which are refused rather than decoded:
 * every message in Stratum v1 is text, and a client sending binary has either negotiated something
 * nobody agreed to or is not a miner.
 */

import { createHash } from 'node:crypto'

/**
 * RFC 6455 §4.2.2 step 5. The one magic constant in the protocol and the one thing here that cannot
 * be derived from anything else, so `wsframe.test.ts` checks the derived accept value against the
 * vector the RFC itself publishes rather than against this file. Hearth's own note records why that
 * matters: its first draft transposed two characters, its client and server agreed with each other
 * perfectly, every framing test passed, and no real WebSocket implementation on earth would have
 * completed the handshake.
 */
export const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export function acceptKey(key: string): string {
  return createHash('sha1').update(key + WEBSOCKET_GUID).digest('base64')
}

export const OPCODE = Object.freeze({
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
})

export const CLOSE_CODE = Object.freeze({
  NORMAL: 1000,
  GOING_AWAY: 1001,
  PROTOCOL_ERROR: 1002,
  UNSUPPORTED_DATA: 1003,
  POLICY_VIOLATION: 1008,
  TOO_BIG: 1009,
})

const EMPTY = Buffer.alloc(0)

/**
 * The minimum a `net.Socket` has to look like for this file to drive it.
 *
 * Narrower than `net.Socket` on purpose: a test can hand this a pair of arrays and drive the frame
 * reader with bytes it built by hand, which is the only way to check a parser against an adversary
 * rather than against its own writer.
 */
export interface RawSocket {
  readonly destroyed: boolean
  readonly writableLength: number
  write(chunk: Buffer): boolean
  end(): void
  destroy(): void
  on(event: 'data', listener: (chunk: Buffer) => void): unknown
  on(event: 'close', listener: () => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
  setNoDelay?(enable: boolean): unknown
  setTimeout?(ms: number): unknown
}

export interface WsConnectionOptions {
  /** Cap on the ASSEMBLED message, applied to the declared frame length before anything is held. */
  readonly maxMessageBytes: number
  /**
   * How often to send an unsolicited ping, and how long silence may last before the connection is
   * declared dead. See `wsstratum.ts`, which owns the numbers and the reason they exist at all.
   */
  readonly pingMs: number
  readonly idleMs: number
  readonly now?: () => number
  /** A protocol fault, for a log line. Never carries payload bytes. */
  readonly onProtocolError?: (reason: string) => void
}

/**
 * One WebSocket connection, presenting the surface `stratum.ts` already expects of a socket.
 *
 * That is the whole design and it is Hearth's: the transport is adapted to the reader, so nothing
 * below learns there are two transports. `stratum.ts` sees something it can hand lines to and take
 * lines from, and its `Wire` interface is satisfied structurally by this class and by the thin
 * adapter around `net.Socket` beside it.
 */
export class WsConnection {
  readonly #socket: RawSocket
  readonly #options: WsConnectionOptions
  readonly #now: () => number
  #buffer: Buffer = EMPTY
  #fragments: Buffer[] | null = null
  #fragmentBytes = 0
  #dataHandler: ((chunk: string) => void) | null = null
  #closeHandler: (() => void) | null = null
  #lastSeenAtMs: number
  #keepaliveTimer: NodeJS.Timeout | null = null
  #sentClose = false
  #destroyed = false
  #closeAnnounced = false

  constructor(socket: RawSocket, options: WsConnectionOptions) {
    this.#socket = socket
    this.#options = options
    this.#now = options.now ?? (() => Date.now())
    this.#lastSeenAtMs = this.#now()

    socket.setNoDelay?.(true)
    // The socket's own idle timeout is cleared: liveness on this transport is decided by the ping
    // and the deadline below, which measure the WEBSOCKET rather than the TCP connection. Leaving
    // both in place would give one connection two clocks that disagree.
    socket.setTimeout?.(0)
    socket.on('data', (chunk) => this.#read(chunk))
    socket.on('error', () => this.destroy())
    socket.on('close', () => this.#finish())

    if (options.pingMs > 0) this.#scheduleKeepalive()
  }

  get destroyed(): boolean {
    return this.#destroyed
  }

  get writableLength(): number {
    return this.#socket.writableLength
  }

  onData(handler: (chunk: string) => void): void {
    this.#dataHandler = handler
  }

  onClose(handler: () => void): void {
    this.#closeHandler = handler
  }

  /**
   * Send one stratum line as one TEXT frame.
   *
   * The trailing newline `stratum.ts` appends is stripped, because on this transport the frame IS
   * the delimiter and a newline inside it is a byte the client has to trim before `JSON.parse`.
   * Nothing is lost: `#deliver` puts one back on the way in, so both sides of `session.ts` see the
   * text they always did.
   */
  write(line: string): void {
    const text = line.endsWith('\n') ? line.slice(0, -1) : line
    this.#frame(OPCODE.TEXT, Buffer.from(text, 'utf8'))
  }

  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#stopKeepalive()
    this.#buffer = EMPTY
    this.#fragments = null
    if (!this.#socket.destroyed) {
      this.#sendClose(CLOSE_CODE.GOING_AWAY)
      // `end()` flushes the close frame; `destroy()` on its own discards it. The socket is then
      // torn down without waiting for a peer that may never answer.
      try {
        this.#socket.end()
      } catch {
        /* already gone */
      }
      const timer = setTimeout(() => {
        try {
          this.#socket.destroy()
        } catch {
          /* already gone */
        }
      }, 100)
      timer.unref?.()
    }
    this.#finish()
  }

  /**
   * Bytes the HTTP parser read past the handshake, if any.
   *
   * Fed by `wsstratum.ts` only after the session is wired, or a client that pipelines its
   * `mining.subscribe` into the upgrade request loses it.
   */
  push(chunk: Buffer): void {
    this.#read(chunk)
  }

  // ---- receive ---------------------------------------------------------------------------------

  #read(chunk: Buffer): void {
    if (this.#destroyed || chunk.length === 0) return
    this.#lastSeenAtMs = this.#now()
    this.#buffer = this.#buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.#buffer, chunk])
    while (!this.#destroyed && this.#step()) {
      /* consume frames until one is short */
    }
  }

  /** Consume exactly one frame. False when more bytes are needed, or when the connection is over. */
  #step(): boolean {
    const buffer = this.#buffer
    if (buffer.length < 2) return false

    const first = buffer[0] as number
    const second = buffer[1] as number
    const fin = (first & 0x80) !== 0
    const reserved = first & 0x70
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f
    let offset = 2

    // No extension was negotiated, so a reserved bit is either a client that believes we agreed to
    // permessage-deflate or a probe. Neither is a miner.
    if (reserved !== 0) return this.#fail(CLOSE_CODE.PROTOCOL_ERROR, 'reserved bits set with no extension negotiated')

    if (length === 126) {
      if (buffer.length < 4) return false
      length = buffer.readUInt16BE(2)
      offset = 4
    } else if (length === 127) {
      if (buffer.length < 10) return false
      // The high word is read rather than the 64-bit value trusted to be small. A length that
      // overflows into something plausible is exactly how a cap gets stepped over.
      if (buffer.readUInt32BE(2) !== 0) return this.#fail(CLOSE_CODE.TOO_BIG, 'frame length above 2^32')
      length = buffer.readUInt32BE(6)
      offset = 10
    }

    const control = (opcode & 0x8) !== 0
    if (control && (length > 125 || !fin)) {
      return this.#fail(CLOSE_CODE.PROTOCOL_ERROR, 'a control frame must be short and unfragmented')
    }
    // RFC 6455 §5.1: a client MUST mask. Checked rather than assumed, because a server that accepts
    // an unmasked client frame is a server that can be fed a proxy's cached bytes as a message.
    if (!masked) return this.#fail(CLOSE_CODE.PROTOCOL_ERROR, 'client frame is not masked')

    // THE BOUND, TAKEN FROM THE HEADER. Nothing below allocates for this frame until it is known to
    // fit, so a page cannot make this process hold memory by announcing a size it never sends.
    if (length > this.#options.maxMessageBytes) {
      return this.#fail(CLOSE_CODE.TOO_BIG, `frame declares ${length} bytes, cap is ${this.#options.maxMessageBytes}`)
    }

    if (control) {
      if (opcode !== OPCODE.CLOSE && opcode !== OPCODE.PING && opcode !== OPCODE.PONG) {
        return this.#fail(CLOSE_CODE.PROTOCOL_ERROR, `unknown control opcode ${opcode}`)
      }
    } else if (opcode === OPCODE.CONTINUATION) {
      if (this.#fragments === null) return this.#fail(CLOSE_CODE.PROTOCOL_ERROR, 'continuation with nothing to continue')
      // …and the same cap ACROSS fragments, which is the way around a per-frame one.
      if (this.#fragmentBytes + length > this.#options.maxMessageBytes) {
        return this.#fail(CLOSE_CODE.TOO_BIG, 'fragments exceed the message cap')
      }
    } else if (opcode === OPCODE.TEXT) {
      if (this.#fragments !== null) return this.#fail(CLOSE_CODE.PROTOCOL_ERROR, 'a new message inside an unfinished one')
    } else if (opcode === OPCODE.BINARY) {
      // Every message in Stratum v1 is text. A binary frame is not a miner speaking a dialect, it is
      // a client that has not read the protocol, and decoding it would invent a contract.
      return this.#fail(CLOSE_CODE.UNSUPPORTED_DATA, 'this endpoint speaks text frames only')
    } else {
      return this.#fail(CLOSE_CODE.PROTOCOL_ERROR, `unknown opcode ${opcode}`)
    }

    const start = offset + 4
    if (buffer.length < start + length) return false

    const payload = Buffer.from(buffer.subarray(start, start + length))
    const key = buffer.subarray(offset, offset + 4)
    for (let i = 0; i < payload.length; i += 1) payload[i] = (payload[i] as number) ^ (key[i & 3] as number)

    const end = start + length
    // The tail is copied rather than kept as a view: a subarray pins the whole allocation, which
    // turns one oversized frame into that many bytes held for the life of the connection.
    this.#buffer = end === buffer.length ? EMPTY : Buffer.from(buffer.subarray(end))

    if (opcode === OPCODE.PING) {
      this.#frame(OPCODE.PONG, payload)
      return true
    }
    if (opcode === OPCODE.PONG) return true
    if (opcode === OPCODE.CLOSE) {
      this.#sendClose(CLOSE_CODE.NORMAL)
      this.destroy()
      return false
    }

    if (opcode !== OPCODE.CONTINUATION) {
      this.#fragments = []
      this.#fragmentBytes = 0
    }
    this.#fragments?.push(payload)
    this.#fragmentBytes += payload.length
    if (!fin) return true

    const parts = this.#fragments ?? []
    const message = parts.length === 1 ? (parts[0] as Buffer) : Buffer.concat(parts, this.#fragmentBytes)
    this.#fragments = null
    this.#fragmentBytes = 0
    this.#deliver(message)
    return true
  }

  /**
   * Hand one assembled message up as a stratum line.
   *
   * A newline is appended when the message does not already end in one, because `stratum.ts` splits
   * its read buffer on `\n` and holds whatever follows the last one — a message delivered without a
   * terminator would sit in that buffer until the connection was dropped for an oversized line, and
   * the miner would see its `mining.subscribe` answered by silence. Clients that send the newline
   * are equally fine; this is one contract with two spellings, and both are accepted on the way in.
   */
  #deliver(message: Buffer): void {
    if (this.#dataHandler === null) return
    const text = message.toString('utf8')
    this.#dataHandler(text.endsWith('\n') ? text : `${text}\n`)
  }

  // ---- send ------------------------------------------------------------------------------------

  #frame(opcode: number, payload: Buffer): void {
    if (this.#socket.destroyed) return
    const length = payload.length
    const extra = length < 126 ? 0 : length < 65_536 ? 2 : 8
    const head = Buffer.alloc(2 + extra)
    head[0] = 0x80 | opcode
    if (length < 126) {
      head[1] = length
    } else if (length < 65_536) {
      head[1] = 126
      head.writeUInt16BE(length, 2)
    } else {
      head[1] = 127
      head.writeUInt32BE(0, 2)
      head.writeUInt32BE(length, 6)
    }
    // A server MUST NOT mask (RFC 6455 §5.1), so the mask bit is never set and no key is written.
    try {
      this.#socket.write(length === 0 ? head : Buffer.concat([head, payload]))
    } catch {
      this.destroy()
    }
  }

  #sendClose(code: number): void {
    if (this.#sentClose) return
    this.#sentClose = true
    const body = Buffer.alloc(2)
    body.writeUInt16BE(code, 0)
    this.#frame(OPCODE.CLOSE, body)
  }

  // ---- keepalive -------------------------------------------------------------------------------

  /**
   * A self-rescheduling timeout rather than `setInterval`, which the estate's CI rejects and which
   * would stack a second ping behind a slow write. `stratum.ts` schedules its share flush the same
   * way and for the same reason.
   */
  #scheduleKeepalive(): void {
    if (this.#destroyed) return
    const timer = setTimeout(() => this.#tick(), this.#options.pingMs)
    timer.unref?.()
    this.#keepaliveTimer = timer
  }

  /**
   * The ping, and the deadline it pairs with.
   *
   * A ping on its own proves nothing. It is the ABSENCE of anything coming back that has to be acted
   * on, or a half-open connection through a tunnel looks alive for ever — and on this transport that
   * means a browser tab that has been closed still counting as a connected miner.
   */
  #tick(): void {
    if (this.#destroyed) return
    if (this.#options.idleMs > 0 && this.#now() - this.#lastSeenAtMs > this.#options.idleMs) {
      this.#options.onProtocolError?.('the peer stopped answering pings')
      this.destroy()
      return
    }
    this.#frame(OPCODE.PING, EMPTY)
    this.#scheduleKeepalive()
  }

  #stopKeepalive(): void {
    if (this.#keepaliveTimer) clearTimeout(this.#keepaliveTimer)
    this.#keepaliveTimer = null
  }

  // ---- teardown --------------------------------------------------------------------------------

  #fail(code: number, reason: string): boolean {
    this.#options.onProtocolError?.(reason)
    this.#sendClose(code)
    this.destroy()
    return false
  }

  #finish(): void {
    if (this.#closeAnnounced) return
    this.#closeAnnounced = true
    this.#destroyed = true
    this.#stopKeepalive()
    this.#buffer = EMPTY
    this.#fragments = null
    this.#closeHandler?.()
  }
}
