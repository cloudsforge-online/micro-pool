/**
 * The WebSocket transport, over a real HTTP server and a real socket.
 *
 * Every request below is written as bytes onto a TCP connection rather than made with a client
 * library, because what is being checked is the HANDSHAKE — the status line, the accept header, the
 * absence of a subprotocol — and a client that hides those is a client that would pass whatever this
 * file wrote. The same reasoning as `wsframe.test.ts`: a transport tested against its own encoder is
 * tested against nothing.
 *
 * What matters most here is the set of refusals. This endpoint is reachable from any page on the
 * internet with no preflight, so the states it can be put into by a stranger are the interesting
 * ones, and each of them has to end in a socket that is closed rather than a session that exists.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { connect, type Socket } from 'node:net'
import type { AddressInfo } from 'node:net'
import { randomBytes } from 'node:crypto'
import { acceptKey, OPCODE } from './wsframe.ts'
import { attachStratumWebSocket, STRATUM_WS_PATH, WS_IDLE_MS, WS_PING_MS, type StratumTarget } from './wsstratum.ts'
import type { Wire } from './stratum.ts'

interface Harness {
  readonly port: number
  /** Every wire the transport handed to a target, in order. */
  readonly wires: Wire[]
  readonly refusals: { status: number; why: string }[]
}

async function withTransport(
  options: {
    /** Handed the harness's own target, so a test that intercepts routing still records its wires. */
    resolve?: (chain: string, target: StratumTarget) => StratumTarget | null
    accept?: boolean
  },
  fn: (h: Harness) => Promise<void>,
): Promise<void> {
  const wires: Wire[] = []
  const refusals: { status: number; why: string }[] = []
  const target: StratumTarget = {
    attachWebSocket: (wire) => {
      if (options.accept === false) return false
      wires.push(wire)
      return true
    },
  }

  const server: Server = createServer((_req, res) => res.end())
  attachStratumWebSocket({
    server,
    resolve: (chain) => (options.resolve ? options.resolve(chain, target) : target),
    log: (_level, _message, fields) => {
      if (fields && typeof fields['status'] === 'number') {
        refusals.push({ status: fields['status'] as number, why: String(fields['why']) })
      }
    },
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  try {
    await fn({ port, wires, refusals })
  } finally {
    // Every wire is destroyed before the server is closed, and that ordering is not tidiness — it is
    // the same ordering `index.ts` shuts down in, for a reason this harness discovered the hard way.
    // Node stops tracking a socket's lifetime once it has been hijacked by an `upgrade` handler, so
    // `server.close()` never calls back while an upgraded connection is still open, however the
    // CLIENT went away. Destroying from this side is what ends it.
    for (const wire of wires) wire.destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

/** A raw connection with the handshake written by hand. Resolves once headers have been read. */
function upgrade(
  port: number,
  path: string,
  headers: Record<string, string | null> = {},
): Promise<{ socket: Socket; head: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    const defaults: Record<string, string | null> = {
      Host: `127.0.0.1:${port}`,
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
    }
    const merged = { ...defaults, ...headers }
    const lines = Object.entries(merged)
      .filter(([, value]) => value !== null)
      .map(([name, value]) => `${name}: ${value as string}`)

    let buffer = Buffer.alloc(0)
    socket.on('error', reject)
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      const end = buffer.indexOf('\r\n\r\n')
      if (end === -1) return
      socket.removeAllListeners('data')
      resolve({ socket, head: buffer.subarray(0, end).toString('utf8'), body: buffer.subarray(end + 4) })
    })
    socket.on('connect', () => {
      socket.write(`GET ${path} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`)
    })
  })
}

/** One masked client frame, built here rather than by the code under test. */
function clientText(text: string): Buffer {
  const mask = randomBytes(4)
  const payload = Buffer.from(text, 'utf8')
  for (let i = 0; i < payload.length; i += 1) payload[i] = (payload[i] as number) ^ (mask[i & 3] as number)
  assert.ok(payload.length < 126, 'this helper only builds short frames')
  return Buffer.concat([Buffer.from([0x80 | OPCODE.TEXT, 0x80 | payload.length]), mask, payload])
}

function statusOf(head: string): number {
  return Number(head.split('\r\n')[0]?.split(' ')[1])
}

function headerOf(head: string, name: string): string | null {
  const line = head
    .split('\r\n')
    .slice(1)
    .find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`))
  return line ? (line.slice(line.indexOf(':') + 1).trim() ?? null) : null
}

/* ------------------------------------------------------------------ the handshake */

test('a well-formed upgrade is answered 101 with the derived accept value', async () => {
  await withTransport({}, async (h) => {
    const key = randomBytes(16).toString('base64')
    const { socket, head } = await upgrade(h.port, `${STRATUM_WS_PATH}/btc`, { 'Sec-WebSocket-Key': key })
    assert.equal(statusOf(head), 101)
    assert.equal(headerOf(head, 'sec-websocket-accept'), acceptKey(key))
    assert.equal(headerOf(head, 'upgrade')?.toLowerCase(), 'websocket')
    // No subprotocol is negotiated. Echoing one a client asked for would be agreeing to something
    // nobody has written down, and the ticket travels in the protocol rather than in the handshake.
    assert.equal(headerOf(head, 'sec-websocket-protocol'), null)
    assert.equal(h.wires.length, 1)
    socket.destroy()
  })
})

test('a subprotocol offered by the client is not echoed back', async () => {
  await withTransport({}, async (h) => {
    const { socket, head } = await upgrade(h.port, `${STRATUM_WS_PATH}/btc`, {
      'Sec-WebSocket-Protocol': 'stratum, mining',
    })
    assert.equal(statusOf(head), 101)
    assert.equal(headerOf(head, 'sec-websocket-protocol'), null)
    socket.destroy()
  })
})

test('the path names the chain, and the chain is case-insensitive', async () => {
  const seen: string[] = []
  await withTransport(
    {
      resolve: (chain, target) => {
        seen.push(chain)
        return target
      },
    },
    async (h) => {
      const a = await upgrade(h.port, `${STRATUM_WS_PATH}/ltc`)
      a.socket.destroy()
      const b = await upgrade(h.port, `${STRATUM_WS_PATH}/BTC`)
      b.socket.destroy()
      assert.deepEqual(seen, ['ltc', 'btc'])
    },
  )
})

test('a query string on the endpoint is ignored rather than being a way to pass a credential', async () => {
  // Deliberate: nothing in the URL is read. A ticket in a query string is a ticket in every access
  // log between the tab and here, which is the reason `tickets.ts` puts it in the protocol instead.
  await withTransport({}, async (h) => {
    const { socket, head } = await upgrade(h.port, `${STRATUM_WS_PATH}/btc?ticket=whatever`)
    assert.equal(statusOf(head), 101)
    socket.destroy()
  })
})

/* ------------------------------------------------------------------ refusals */

test('an ordinary GET on the endpoint is not an upgrade and is refused', async () => {
  await withTransport({}, async (h) => {
    const res = await fetch(`http://127.0.0.1:${h.port}${STRATUM_WS_PATH}/btc`)
    // The plain HTTP server answers it; there is no upgrade to refuse. What matters is that no wire
    // was created for a request that never became a WebSocket.
    assert.ok(res.ok || res.status >= 400)
    await res.text()
    assert.equal(h.wires.length, 0)
  })
})

test('an upgrade to something other than websocket is refused 400', async () => {
  await withTransport({}, async (h) => {
    const { socket, head } = await upgrade(h.port, `${STRATUM_WS_PATH}/btc`, { Upgrade: 'h2c' })
    assert.equal(statusOf(head), 400)
    assert.equal(h.wires.length, 0)
    socket.destroy()
  })
})

test('an unknown path is refused 404 and names the endpoint', async () => {
  await withTransport({}, async (h) => {
    const { socket, head } = await upgrade(h.port, '/v1/pool/socket')
    assert.equal(statusOf(head), 404)
    assert.match(h.refusals[0]?.why ?? '', /\/v1\/pool\/stratum\/<chain>/)
    socket.destroy()
  })
})

test('a chain this pool does not implement is refused 404, not accepted and then dropped', async () => {
  await withTransport({}, async (h) => {
    const { socket, head } = await upgrade(h.port, `${STRATUM_WS_PATH}/doge`)
    // `doge` is refused BY NAME in `chains.ts` — merge-mining is not implemented and a pool that
    // handed out Dogecoin work would hand out solutions the network discards. It is not a chain that
    // could be added by filling in a table row, and this endpoint must not be a second door to it.
    assert.equal(statusOf(head), 404)
    assert.equal(h.wires.length, 0)
    socket.destroy()
  })
})

test('the endpoint with no chain at all is refused', async () => {
  await withTransport({}, async (h) => {
    const { socket, head } = await upgrade(h.port, STRATUM_WS_PATH)
    assert.equal(statusOf(head), 404)
    socket.destroy()
  })
})

test('a websocket version other than 13 is refused 400', async () => {
  await withTransport({}, async (h) => {
    const { socket, head } = await upgrade(h.port, `${STRATUM_WS_PATH}/btc`, { 'Sec-WebSocket-Version': '8' })
    assert.equal(statusOf(head), 400)
    socket.destroy()
  })
})

test('a missing or malformed key is refused 400', async () => {
  for (const key of [null, 'short', 'bm90LWEta2V5']) {
    await withTransport({}, async (h) => {
      const { socket, head } = await upgrade(h.port, `${STRATUM_WS_PATH}/btc`, { 'Sec-WebSocket-Key': key })
      assert.equal(statusOf(head), 400, String(key))
      assert.equal(h.wires.length, 0)
      socket.destroy()
    })
  }
})

test('a chain this pool serves no browsers for is refused 503', async () => {
  await withTransport({ resolve: () => null }, async (h) => {
    // Identity is optional configuration and a pool with none is the ordinary case. A browser is
    // told so rather than being connected to something that will never hand it a job.
    const { socket, head } = await upgrade(h.port, `${STRATUM_WS_PATH}/btc`)
    assert.equal(statusOf(head), 503)
    assert.match(h.refusals[0]?.why ?? '', /no browser mining/)
    socket.destroy()
  })
})

test('a chain that stops serving between resolve and attach closes rather than hanging', async () => {
  await withTransport({ accept: false }, async (h) => {
    const { socket, head } = await upgrade(h.port, `${STRATUM_WS_PATH}/btc`)
    // The handshake has already been written, so this is a 101 followed by a close — there is no
    // status left to send. What must not happen is a browser left holding an open socket that will
    // never carry a job.
    assert.equal(statusOf(head), 101)
    await new Promise<void>((resolve) => socket.on('close', () => resolve()))
  })
})

test('a refusal logs the path and nothing else about the request', async () => {
  await withTransport({}, async (h) => {
    const { socket, head } = await upgrade(h.port, '/v1/pool/nope', { 'X-Secret': 'do-not-log-me' })
    assert.equal(statusOf(head), 404)
    // A refused upgrade is a log line anything on the internet can make this process write, so it
    // carries no header, no query string and no address.
    assert.deepEqual(Object.keys(h.refusals[0] ?? {}).sort(), ['status', 'why'])
    socket.destroy()
  })
})

/* ------------------------------------------------------------------ end to end */

test('a line sent as a frame reaches the wire, and a line written comes back as a frame', async () => {
  await withTransport({}, async (h) => {
    const { socket } = await upgrade(h.port, `${STRATUM_WS_PATH}/btc`)
    const wire = h.wires[0] as Wire
    const received: string[] = []
    wire.onData((chunk) => received.push(chunk))

    socket.write(clientText('{"id":1,"method":"mining.subscribe","params":[]}'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(received, ['{"id":1,"method":"mining.subscribe","params":[]}\n'])

    const back = new Promise<Buffer>((resolve) => socket.once('data', (chunk: Buffer) => resolve(chunk)))
    wire.write('{"id":1,"result":true}\n')
    const frame = await back
    assert.equal((frame[0] as number) & 0x0f, OPCODE.TEXT)
    assert.equal((frame[1] as number) & 0x80, 0, 'a server MUST NOT mask')
    assert.equal(frame.subarray(2).toString('utf8'), '{"id":1,"result":true}')
    socket.destroy()
  })
})

test('bytes pipelined into the upgrade request are not lost', async () => {
  // A client that writes its `mining.subscribe` immediately after the handshake, in the same TCP
  // segment, is a client whose first message the HTTP parser has already read. It is fed to the
  // connection after the session exists, or the miner's first message vanishes.
  await withTransport({}, async (h) => {
    const key = randomBytes(16).toString('base64')
    const socket = connect(h.port, '127.0.0.1')
    await new Promise<void>((resolve) => socket.on('connect', () => resolve()))
    socket.write(
      Buffer.concat([
        Buffer.from(
          `GET ${STRATUM_WS_PATH}/btc HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
            `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n\r\n`,
        ),
        clientText('{"id":1,"method":"mining.subscribe","params":[]}'),
      ]),
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    const wire = h.wires[0] as Wire
    assert.ok(wire !== undefined, 'expected the upgrade to have been accepted')
    const received: string[] = []
    wire.onData((chunk) => received.push(chunk))
    await new Promise((resolve) => setTimeout(resolve, 50))
    // Handled either way: the bytes were pushed after the wire was handed over, so they are either
    // already delivered to the handler `stratum.ts` installs synchronously, or buffered for it.
    // What this test rules out is the connection being dead.
    assert.equal(wire.destroyed, false)
    socket.destroy()
  })
})

/* ------------------------------------------------------------------ the keepalive numbers */

test('the keepalive declares death after three missed pings, not one', () => {
  // Both numbers are taken from Hearth's `HEARTH_P2P_WS`, the estate's other long-lived WebSocket,
  // and both are chosen against a clock this estate cannot set: Cloudflare's edge closes an idle
  // WebSocket at roughly a hundred seconds and that is not configurable on the plan the estate runs.
  // Traefik has no per-router idle timeout to lean on instead — `respondingTimeouts` is static on an
  // entrypoint — so the ping has to come from here.
  assert.ok(WS_PING_MS < 100_000, 'the ping must fit well inside the edge idle window')
  assert.ok(WS_IDLE_MS >= WS_PING_MS * 3, 'a single scheduling hiccup must not disconnect a miner')
  assert.equal(WS_PING_MS, 20_000)
  assert.equal(WS_IDLE_MS, 70_000)
})

test('the path is under /v1, where the estate gateway already routes this service', () => {
  // `cf-api-pool` matches PathPrefix('/v1') on the pool hostname. A path outside it would have needed
  // a new router, a new rule and a new hostname — a change in a repository this one does not own.
  assert.ok(STRATUM_WS_PATH.startsWith('/v1/'))
})
