/**
 * RFC 6455 framing, driven by bytes built here rather than by this file's own encoder.
 *
 * That distinction is the whole value of this suite. A framing test that encodes with `#frame` and
 * decodes with `#step` proves the two agree with each other and nothing else — and Hearth's note on
 * its own hand-written WebSocket records exactly that failure: its first draft transposed two
 * characters of the handshake GUID, its client and server agreed perfectly, every framing test
 * passed, and no real WebSocket implementation on earth would have completed the handshake.
 *
 * So: the accept value is checked against the vector published in RFC 6455 §1.3, and every inbound
 * frame below is assembled by hand with a mask applied by hand. The outbound frames are then read
 * back the same way, byte by byte, rather than fed to the reader.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { acceptKey, CLOSE_CODE, OPCODE, WEBSOCKET_GUID, WsConnection, type RawSocket } from './wsframe.ts'

/** A socket that records what was written and lets a test push bytes in. */
class FakeSocket implements RawSocket {
  destroyed = false
  writableLength = 0
  readonly written: Buffer[] = []
  readonly noDelay: boolean[] = []
  readonly timeouts: number[] = []
  #data: ((chunk: Buffer) => void) | null = null
  #close: (() => void) | null = null

  write(chunk: Buffer): boolean {
    this.written.push(Buffer.from(chunk))
    return true
  }

  end(): void {
    this.destroyed = true
  }

  destroy(): void {
    this.destroyed = true
    this.#close?.()
  }

  on(event: 'data' | 'close' | 'error', listener: (arg: never) => void): unknown {
    if (event === 'data') this.#data = listener as (chunk: Buffer) => void
    if (event === 'close') this.#close = listener as () => void
    return this
  }

  setNoDelay(enable: boolean): unknown {
    this.noDelay.push(enable)
    return this
  }

  setTimeout(ms: number): unknown {
    this.timeouts.push(ms)
    return this
  }

  /** Deliver bytes as if they had arrived off the wire. */
  feed(chunk: Buffer): void {
    this.#data?.(chunk)
  }

  /** Everything written, concatenated, so a test can walk the outbound frames. */
  get out(): Buffer {
    return Buffer.concat(this.written)
  }
}

/**
 * A client frame, masked as RFC 6455 §5.1 requires of a client.
 *
 * Built here rather than borrowed from the class under test. The mask key is fixed so a failure is
 * reproducible; four zero bytes would be a mask that does nothing and would hide an unmasking bug.
 */
function clientFrame(
  opcode: number,
  payload: Buffer,
  options: { fin?: boolean; mask?: Buffer; declaredLength?: number; reserved?: number; masked?: boolean } = {},
): Buffer {
  const fin = options.fin ?? true
  const mask = options.mask ?? Buffer.from([0x37, 0xfa, 0x21, 0x3d])
  const masked = options.masked ?? true
  const length = options.declaredLength ?? payload.length

  const head: number[] = [(fin ? 0x80 : 0) | (options.reserved ?? 0) | opcode]
  const maskBit = masked ? 0x80 : 0
  let extra = Buffer.alloc(0)
  if (length < 126) {
    head.push(maskBit | length)
  } else if (length < 65_536) {
    head.push(maskBit | 126)
    extra = Buffer.alloc(2)
    extra.writeUInt16BE(length, 0)
  } else {
    head.push(maskBit | 127)
    extra = Buffer.alloc(8)
    extra.writeUInt32BE(Math.floor(length / 2 ** 32), 0)
    extra.writeUInt32BE(length >>> 0, 4)
  }

  const body = Buffer.from(payload)
  if (masked) for (let i = 0; i < body.length; i += 1) body[i] = (body[i] as number) ^ (mask[i & 3] as number)
  return Buffer.concat([Buffer.from(head), extra, masked ? mask : Buffer.alloc(0), body])
}

/** Read one server frame off the front of a buffer. Servers never mask, which this asserts. */
function readServerFrame(buffer: Buffer): { opcode: number; fin: boolean; payload: Buffer; rest: Buffer } {
  const first = buffer[0] as number
  const second = buffer[1] as number
  assert.equal(second & 0x80, 0, 'a server MUST NOT mask (RFC 6455 §5.1)')
  let length = second & 0x7f
  let offset = 2
  if (length === 126) {
    length = buffer.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    assert.equal(buffer.readUInt32BE(2), 0)
    length = buffer.readUInt32BE(6)
    offset = 10
  }
  return {
    opcode: first & 0x0f,
    fin: (first & 0x80) !== 0,
    payload: buffer.subarray(offset, offset + length),
    rest: buffer.subarray(offset + length),
  }
}

function connect(socket: FakeSocket, over: Partial<ConstructorParameters<typeof WsConnection>[1]> = {}): WsConnection {
  return new WsConnection(socket, { maxMessageBytes: 16 * 1024, pingMs: 0, idleMs: 0, ...over })
}

/* ------------------------------------------------------------------ the handshake */

test('the accept value matches the vector RFC 6455 publishes', () => {
  // §1.3, verbatim. The one constant in this protocol that cannot be derived from anything else, and
  // the one a transposition inside this repository would hide from every other test in this file.
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
  assert.equal(WEBSOCKET_GUID, '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
})

/* ------------------------------------------------------------------ receiving */

test('a masked text frame is unmasked and delivered as a stratum line', () => {
  const socket = new FakeSocket()
  const connection = connect(socket)
  const lines: string[] = []
  connection.onData((chunk) => lines.push(chunk))

  socket.feed(clientFrame(OPCODE.TEXT, Buffer.from('{"id":1,"method":"mining.subscribe"}', 'utf8')))

  // The newline is appended on the way in. `stratum.ts` splits its read buffer on '\n' and holds
  // whatever follows the last one, so a message delivered without a terminator would sit there
  // unparsed until the connection was dropped — the miner would see its subscribe answered by
  // silence.
  assert.deepEqual(lines, ['{"id":1,"method":"mining.subscribe"}\n'])
})

test('a client that sends its own newline is not given a second one', () => {
  const socket = new FakeSocket()
  const connection = connect(socket)
  const lines: string[] = []
  connection.onData((chunk) => lines.push(chunk))
  socket.feed(clientFrame(OPCODE.TEXT, Buffer.from('{"id":1}\n', 'utf8')))
  assert.deepEqual(lines, ['{"id":1}\n'])
})

test('all three length forms decode to the same bytes', () => {
  for (const size of [5, 126, 200, 65_536, 70_000]) {
    const socket = new FakeSocket()
    const connection = connect(socket, { maxMessageBytes: 128 * 1024 })
    const lines: string[] = []
    connection.onData((chunk) => lines.push(chunk))
    // A payload the reader cannot get right by accident: 'a' repeated would survive an off-by-one in
    // the mask index, which is the bug this is looking for.
    const payload = Buffer.from(Array.from({ length: size }, (_v, i) => 97 + (i % 26)))
    socket.feed(clientFrame(OPCODE.TEXT, payload))
    assert.equal(lines.length, 1, `size ${size}`)
    assert.equal(lines[0], `${payload.toString('utf8')}\n`, `size ${size}`)
  }
})

test('a frame split across three TCP reads is assembled', () => {
  const socket = new FakeSocket()
  const connection = connect(socket)
  const lines: string[] = []
  connection.onData((chunk) => lines.push(chunk))

  // A byte stream has no frame boundaries in it. Splitting mid-header, mid-mask and mid-payload is
  // the ordinary case on a real connection, not an edge one.
  const frame = clientFrame(OPCODE.TEXT, Buffer.from('{"id":7}', 'utf8'))
  socket.feed(frame.subarray(0, 1))
  assert.deepEqual(lines, [])
  socket.feed(frame.subarray(1, 5))
  assert.deepEqual(lines, [])
  socket.feed(frame.subarray(5))
  assert.deepEqual(lines, ['{"id":7}\n'])
})

test('two frames arriving in one read are both delivered', () => {
  const socket = new FakeSocket()
  const connection = connect(socket)
  const lines: string[] = []
  connection.onData((chunk) => lines.push(chunk))
  socket.feed(
    Buffer.concat([
      clientFrame(OPCODE.TEXT, Buffer.from('one', 'utf8')),
      clientFrame(OPCODE.TEXT, Buffer.from('two', 'utf8')),
    ]),
  )
  assert.deepEqual(lines, ['one\n', 'two\n'])
})

test('a continued message is delivered once, whole', () => {
  const socket = new FakeSocket()
  const connection = connect(socket)
  const lines: string[] = []
  connection.onData((chunk) => lines.push(chunk))

  socket.feed(clientFrame(OPCODE.TEXT, Buffer.from('{"id":', 'utf8'), { fin: false }))
  socket.feed(clientFrame(OPCODE.CONTINUATION, Buffer.from('1,"method"', 'utf8'), { fin: false }))
  socket.feed(clientFrame(OPCODE.CONTINUATION, Buffer.from(':"x"}', 'utf8')))
  assert.deepEqual(lines, ['{"id":1,"method":"x"}\n'])
})

test('a ping is answered with a pong carrying the same payload', () => {
  const socket = new FakeSocket()
  connect(socket)
  socket.feed(clientFrame(OPCODE.PING, Buffer.from('keepalive', 'utf8')))
  const frame = readServerFrame(socket.out)
  assert.equal(frame.opcode, OPCODE.PONG)
  assert.equal(frame.payload.toString('utf8'), 'keepalive')
})

test('a pong is accepted and delivers nothing', () => {
  const socket = new FakeSocket()
  const connection = connect(socket)
  const lines: string[] = []
  connection.onData((chunk) => lines.push(chunk))
  socket.feed(clientFrame(OPCODE.PONG, Buffer.alloc(0)))
  assert.deepEqual(lines, [])
  assert.equal(connection.destroyed, false)
})

test('a close frame is answered and the connection ends', () => {
  const socket = new FakeSocket()
  const connection = connect(socket)
  let closed = false
  connection.onClose(() => {
    closed = true
  })
  socket.feed(clientFrame(OPCODE.CLOSE, Buffer.alloc(0)))
  assert.equal(readServerFrame(socket.out).opcode, OPCODE.CLOSE)
  assert.equal(connection.destroyed, true)
  assert.equal(closed, true)
})

/* ------------------------------------------------------------------ refusals */

test('an unmasked client frame is refused', () => {
  // RFC 6455 §5.1 requires a client to mask. A server that accepts an unmasked client frame is a
  // server that can be fed a proxy's cached bytes as a message.
  const socket = new FakeSocket()
  const reasons: string[] = []
  const connection = connect(socket, { onProtocolError: (reason) => reasons.push(reason) })
  const lines: string[] = []
  connection.onData((chunk) => lines.push(chunk))

  socket.feed(clientFrame(OPCODE.TEXT, Buffer.from('hello', 'utf8'), { masked: false }))
  assert.deepEqual(lines, [])
  assert.equal(connection.destroyed, true)
  assert.match(reasons[0] ?? '', /not masked/)
  assert.equal(closeCodeOf(socket), CLOSE_CODE.PROTOCOL_ERROR)
})

test('a binary frame is refused rather than decoded', () => {
  // Every message in Stratum v1 is text. Decoding a binary frame would invent a contract nobody
  // wrote down, and the client that sent it is not a miner.
  const socket = new FakeSocket()
  const reasons: string[] = []
  const connection = connect(socket, { onProtocolError: (reason) => reasons.push(reason) })
  socket.feed(clientFrame(OPCODE.BINARY, Buffer.from([0x00, 0x01, 0x02])))
  assert.equal(connection.destroyed, true)
  assert.match(reasons[0] ?? '', /text frames only/)
  assert.equal(closeCodeOf(socket), CLOSE_CODE.UNSUPPORTED_DATA)
})

test('a reserved bit is refused, so a decompression bomb has nowhere to arrive', () => {
  const socket = new FakeSocket()
  const reasons: string[] = []
  const connection = connect(socket, { onProtocolError: (reason) => reasons.push(reason) })
  socket.feed(clientFrame(OPCODE.TEXT, Buffer.from('hello', 'utf8'), { reserved: 0x40 }))
  assert.equal(connection.destroyed, true)
  assert.match(reasons[0] ?? '', /reserved bits/)
})

test('a frame that DECLARES more than the cap is refused before a byte of payload arrives', () => {
  // The bound is taken from the header, which is the point: a page that announces a megabyte and
  // then sends nothing must not be able to make this process hold a megabyte.
  const socket = new FakeSocket()
  const reasons: string[] = []
  const connection = connect(socket, { maxMessageBytes: 1_024, onProtocolError: (reason) => reasons.push(reason) })

  // Ten bytes: the two-byte header and the 64-bit length, and not one byte of mask or payload.
  socket.feed(clientFrame(OPCODE.TEXT, Buffer.alloc(0), { declaredLength: 100_000 }).subarray(0, 10))
  assert.equal(connection.destroyed, true)
  assert.match(reasons[0] ?? '', /cap is 1024/)
  assert.equal(closeCodeOf(socket), CLOSE_CODE.TOO_BIG)
})

test('fragments cannot add up to more than the message cap', () => {
  const socket = new FakeSocket()
  const reasons: string[] = []
  const connection = connect(socket, { maxMessageBytes: 100, onProtocolError: (reason) => reasons.push(reason) })
  const lines: string[] = []
  connection.onData((chunk) => lines.push(chunk))

  // Each frame is under the cap. Together they are not, which is the way around a per-frame bound.
  socket.feed(clientFrame(OPCODE.TEXT, Buffer.alloc(60, 0x61), { fin: false }))
  socket.feed(clientFrame(OPCODE.CONTINUATION, Buffer.alloc(60, 0x61), { fin: false }))
  assert.deepEqual(lines, [])
  assert.equal(connection.destroyed, true)
  assert.match(reasons[0] ?? '', /fragments exceed/)
})

test('a control frame may be neither long nor fragmented', () => {
  for (const [name, frame] of [
    ['long', clientFrame(OPCODE.PING, Buffer.alloc(200, 0x61))],
    ['fragmented', clientFrame(OPCODE.PING, Buffer.from('x'), { fin: false })],
  ] as const) {
    const socket = new FakeSocket()
    const reasons: string[] = []
    const connection = connect(socket, { onProtocolError: (reason) => reasons.push(reason) })
    socket.feed(frame)
    assert.equal(connection.destroyed, true, name)
    assert.match(reasons[0] ?? '', /control frame/, name)
  }
})

test('a continuation with nothing to continue is refused', () => {
  const socket = new FakeSocket()
  const reasons: string[] = []
  const connection = connect(socket, { onProtocolError: (reason) => reasons.push(reason) })
  socket.feed(clientFrame(OPCODE.CONTINUATION, Buffer.from('orphan', 'utf8')))
  assert.equal(connection.destroyed, true)
  assert.match(reasons[0] ?? '', /nothing to continue/)
})

test('a new message inside an unfinished one is refused', () => {
  const socket = new FakeSocket()
  const reasons: string[] = []
  const connection = connect(socket, { onProtocolError: (reason) => reasons.push(reason) })
  socket.feed(clientFrame(OPCODE.TEXT, Buffer.from('first', 'utf8'), { fin: false }))
  socket.feed(clientFrame(OPCODE.TEXT, Buffer.from('second', 'utf8')))
  assert.equal(connection.destroyed, true)
  assert.match(reasons[0] ?? '', /unfinished/)
})

/* ------------------------------------------------------------------ sending */

test('a line is sent as one unmasked text frame with the newline stripped', () => {
  const socket = new FakeSocket()
  const connection = connect(socket)
  connection.write('{"id":1,"result":true}\n')
  const frame = readServerFrame(socket.out)
  assert.equal(frame.opcode, OPCODE.TEXT)
  assert.equal(frame.fin, true)
  // The frame IS the delimiter on this transport. A newline inside it is a byte the client has to
  // trim before `JSON.parse`, so it does not travel.
  assert.equal(frame.payload.toString('utf8'), '{"id":1,"result":true}')
})

test('an outbound message longer than 125 bytes uses the extended length form', () => {
  const socket = new FakeSocket()
  const connection = connect(socket)
  // A real `mining.notify` with a full merkle branch is several hundred bytes, so this is the
  // ordinary path for the message that matters most, not an edge case.
  const line = 'x'.repeat(1_000)
  connection.write(`${line}\n`)
  const frame = readServerFrame(socket.out)
  assert.equal(frame.opcode, OPCODE.TEXT)
  assert.equal(frame.payload.toString('utf8'), line)
  assert.equal((socket.out[1] as number) & 0x7f, 126)
})

/* ------------------------------------------------------------------ keepalive */

test('the keepalive pings on its own and gives up after the idle deadline', async () => {
  const socket = new FakeSocket()
  let clock = 0
  const reasons: string[] = []
  const connection = connect(socket, {
    pingMs: 5,
    idleMs: 20,
    now: () => clock,
    onProtocolError: (reason) => reasons.push(reason),
  })

  await new Promise((resolve) => setTimeout(resolve, 20))
  // Silence in wall-clock terms but not in the connection's, because its clock has not moved.
  assert.ok(socket.written.length > 0, 'expected at least one unsolicited ping')
  assert.equal(readServerFrame(socket.out).opcode, OPCODE.PING)
  assert.equal(connection.destroyed, false)

  // Past the deadline with nothing having arrived. A ping proves nothing on its own — it is the
  // absence of anything coming back that has to be acted on, or a browser tab that was closed an
  // hour ago is still a connected miner.
  clock = 1_000
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(connection.destroyed, true)
  assert.match(reasons[0] ?? '', /stopped answering/)
})

test('anything arriving resets the idle deadline', async () => {
  const socket = new FakeSocket()
  let clock = 0
  const connection = connect(socket, { pingMs: 5, idleMs: 20, now: () => clock })

  clock = 1_000
  // A pong is the smallest thing a live peer sends. It carries no message and must still count.
  socket.feed(clientFrame(OPCODE.PONG, Buffer.alloc(0)))
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(connection.destroyed, false)
})

test('the socket timeout is cleared so one connection does not have two clocks', () => {
  const socket = new FakeSocket()
  connect(socket)
  assert.deepEqual(socket.timeouts, [0])
  assert.deepEqual(socket.noDelay, [true])
})

/** The close code in the first CLOSE frame written, or null. */
function closeCodeOf(socket: FakeSocket): number | null {
  let rest = socket.out
  while (rest.length >= 2) {
    const frame = readServerFrame(rest)
    if (frame.opcode === OPCODE.CLOSE) return frame.payload.readUInt16BE(0)
    rest = frame.rest
  }
  return null
}
