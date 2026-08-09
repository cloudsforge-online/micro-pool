/**
 * The listener, over a real socket.
 *
 * `session.test.ts` drives the protocol by calling `handle` directly, which is the right way to test
 * a state machine and is exactly why it proves nothing about this file. Everything below binds a
 * loopback port and speaks TCP to it, because the properties that matter here are properties of the
 * transport and disappear the moment the transport is faked:
 *
 *   - **Framing.** A message is a line, and a line arrives in whatever chunks the network chose. A
 *     handler that treats one `data` event as one message works perfectly against a fake and fails
 *     against a miner whose 300-byte submit was split across two segments — which is not rare, it is
 *     what happens the first time a submit crosses an MTU boundary.
 *   - **The refusals.** A line with no end, a payload that is not JSON, a connection that says
 *     nothing at all. Each of these is free for the peer and costs the pool a slot or a buffer, and
 *     each one is a socket being destroyed, which cannot be observed without a socket.
 *   - **Back-pressure.** `broadcast` writing to a peer that has stopped reading. The test for it
 *     below deliberately fills a real kernel buffer rather than asserting on a mocked
 *     `writableLength`, because the number that matters is Node's, not one the test made up.
 *
 * The shares are mined for real, as everywhere else in this suite, but they are mined **in process**
 * against the same `validateShare` the server runs and only the winning nonce is sent over the wire.
 * Mining through the socket would be sixty-five thousand round trips for one accepted share.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createConnection, type Socket } from 'node:net'
import { StratumServer, EXTRANONCE2_BYTES, MAX_LINE_BYTES, type StratumServerOptions } from './stratum.ts'
import { JobRegistry, type Job } from './work.ts'
import { parseTemplate } from './template.ts'
import { fakeTemplateReply, FAKE_PAYOUT_SCRIPT, MAINNET_BITS, REGTEST_BITS } from './faketemplate.ts'
import { DEFAULT_VARDIFF } from './vardiff.ts'
import { validateShare } from './validate.ts'
import type { AcceptedShare, FoundBlock } from './session.ts'

/** See `session.test.ts`: 0.001 would put a test share four million hashes away. */
const TEST_VARDIFF = { ...DEFAULT_VARDIFF, minDifficulty: 1 / 65536 }
const SHARE_DIFFICULTY = 1 / 65536
const USERNAME = 'bc1qexampleaddress.rig1'

interface LogLine {
  readonly level: string
  readonly message: string
  readonly fields: Record<string, unknown> | undefined
}

interface Harness {
  readonly server: StratumServer
  readonly registry: JobRegistry
  readonly logs: LogLine[]
  /** Every batch handed to `persistShares`, kept as batches so buffering is visible. */
  readonly batches: AcceptedShare[][]
  readonly blocks: FoundBlock[]
  readonly persisted: () => AcceptedShare[]
  push(options?: Parameters<typeof fakeTemplateReply>[0]): Job
  connect(): Promise<Client>
  failNextPersist(): void
}

interface Client {
  readonly socket: Socket
  /** Every message received, parsed. */
  readonly messages: Record<string, unknown>[]
  send(message: Record<string, unknown>): void
  /** Raw bytes, for the framing tests. */
  raw(text: string): void
  /** Resolves with the first message matching `predicate`, including ones already received. */
  await(predicate: (message: Record<string, unknown>) => boolean, label: string): Promise<Record<string, unknown>>
  /** Resolves when the server closes the connection. Rejects on timeout. */
  awaitClose(label: string): Promise<void>
  readonly closed: () => boolean
  end(): void
}

const harnesses: Harness[] = []
const clients: Client[] = []

async function harness(overrides: Partial<StratumServerOptions> = {}): Promise<Harness> {
  const logs: LogLine[] = []
  const batches: AcceptedShare[][] = []
  const blocks: FoundBlock[] = []
  let failPersist = false

  const registry = new JobRegistry({
    chain: 'btc',
    tag: Buffer.from('/cloudsforge/', 'utf8'),
    extranonce1Size: 4,
    extranonce2Size: EXTRANONCE2_BYTES,
  })
  registry.setPayoutScript(FAKE_PAYOUT_SCRIPT)

  const server = new StratumServer({
    chain: 'btc',
    algorithm: 'sha256d',
    registry,
    host: '127.0.0.1',
    // Port 0: the kernel picks. `boundPort` is how the tests find out which.
    port: 0,
    initialDifficulty: SHARE_DIFFICULTY,
    vardiff: TEST_VARDIFF,
    flushIntervalMs: 20,
    persistShares: async (shares) => {
      if (failPersist) {
        failPersist = false
        throw new Error('the database is down')
      }
      batches.push([...shares])
    },
    onBlock: (block) => blocks.push(block),
    log: (level, message, fields) => logs.push({ level, message, fields }),
    ...overrides,
  })
  await server.listen()

  const h: Harness = {
    server,
    registry,
    logs,
    batches,
    blocks,
    persisted: () => batches.flat(),
    push(options) {
      return registry.push(parseTemplate(fakeTemplateReply({ bitsHex: REGTEST_BITS, ...options })))
    },
    failNextPersist() {
      failPersist = true
    },
    connect: () => client(server.boundPort ?? 0),
  }
  harnesses.push(h)
  return h
}

function client(port: number): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ port, host: '127.0.0.1' })
    const messages: Record<string, unknown>[] = []
    const waiters: { predicate: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void }[] =
      []
    let closed = false
    let buffer = ''

    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line !== '') {
          const parsed = JSON.parse(line) as Record<string, unknown>
          messages.push(parsed)
          for (let i = waiters.length - 1; i >= 0; i -= 1) {
            const waiter = waiters[i]
            if (waiter && waiter.predicate(parsed)) {
              waiters.splice(i, 1)
              waiter.resolve(parsed)
            }
          }
        }
        newline = buffer.indexOf('\n')
      }
    })
    socket.on('error', () => {
      // A destroy from the far end surfaces as ECONNRESET on some platforms and as a clean close on
      // others. Both mean the same thing here and neither is a test failure.
      closed = true
    })
    socket.on('close', () => {
      closed = true
    })

    const api: Client = {
      socket,
      messages,
      send(message) {
        socket.write(`${JSON.stringify(message)}\n`)
      },
      raw(text) {
        socket.write(text)
      },
      await(predicate, label) {
        const existing = messages.find(predicate)
        if (existing) return Promise.resolve(existing)
        return new Promise((resolveWaiter, rejectWaiter) => {
          const timer = setTimeout(() => rejectWaiter(new Error(`timed out waiting for ${label}`)), 5_000)
          waiters.push({
            predicate,
            resolve: (m) => {
              clearTimeout(timer)
              resolveWaiter(m)
            },
          })
        })
      },
      awaitClose(label) {
        if (closed) return Promise.resolve()
        return new Promise((resolveClose, rejectClose) => {
          const timer = setTimeout(() => rejectClose(new Error(`timed out waiting for ${label}`)), 5_000)
          socket.once('close', () => {
            clearTimeout(timer)
            resolveClose()
          })
        })
      },
      closed: () => closed,
      end() {
        socket.destroy()
      },
    }

    socket.once('connect', () => {
      clients.push(api)
      resolve(api)
    })
    socket.once('error', reject)
  })
}

/** Subscribe and authorise. Answers the extranonce1 the server assigned this connection. */
async function connect(c: Client, username = USERNAME): Promise<Buffer> {
  c.send({ id: 1, method: 'mining.subscribe', params: ['cgminer/4.10.0'] })
  const subscribed = await c.await((m) => m['id'] === 1, 'the subscribe reply')
  const result = subscribed['result'] as [unknown, string, number]
  c.send({ id: 2, method: 'mining.authorize', params: [username, 'x'] })
  await c.await((m) => m['id'] === 2, 'the authorize reply')
  return Buffer.from(result[1], 'hex')
}

/**
 * A nonce that solves `job` at the session's difficulty, found in process.
 *
 * Runs the server's own `validateShare`, so a nonce this accepts is a nonce the server accepts —
 * there is no second implementation here to drift.
 */
function mine(job: Job, extranonce1: Buffer, extranonce2Hex = '00000001'): string {
  for (let nonce = 0; nonce < 2_000_000; nonce += 1) {
    const nonceHex = nonce.toString(16).padStart(8, '0')
    const result = validateShare(
      { jobId: job.id, extranonce2Hex, ntimeHex: job.ntimeHex, nonceHex },
      {
        job,
        algorithm: 'sha256d',
        extranonce1,
        extranonce2Size: EXTRANONCE2_BYTES,
        shareDifficulty: SHARE_DIFFICULTY,
        versionMask: 0,
        // The job's own ntime, so the freshness window in `validate.ts` is not a clock race here.
        nowSeconds: Number.parseInt(job.ntimeHex, 16),
      },
    )
    if (result.status === 'accepted') return nonceHex
  }
  throw new Error('no acceptable share found')
}

/** Poll until `condition` holds. The flush is on a timer, so there is nothing to await on. */
async function until(condition: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test.after(async () => {
  for (const c of clients) c.end()
  for (const h of harnesses) await h.server.close()
})

/* ------------------------------------------------------------------ framing */

test('a message split across two writes is one message', async () => {
  const h = await harness()
  const c = await h.connect()

  // The exact failure a naive `data` handler has: one logical message, two segments. Written with a
  // pause between them so they cannot coalesce into a single read on the far end.
  c.raw('{"id":1,"method":"mining.sub')
  await new Promise((resolve) => setTimeout(resolve, 20))
  c.raw('scribe","params":[]}\n')

  const reply = await c.await((m) => m['id'] === 1, 'the subscribe reply')
  assert.ok(Array.isArray(reply['result']))
})

test('two messages in one write are two messages', async () => {
  const h = await harness()
  const c = await h.connect()

  // The other half: a miner that pipelines, or a segment that carried a submit and the previous
  // reply's tail. A handler that parses the whole chunk as one JSON document destroys the socket.
  c.raw('{"id":1,"method":"mining.subscribe","params":[]}\n{"id":2,"method":"mining.authorize","params":["a.b","x"]}\n')

  await c.await((m) => m['id'] === 1, 'the subscribe reply')
  await c.await((m) => m['id'] === 2, 'the authorize reply')
})

test('CRLF endings and blank lines are tolerated', async () => {
  const h = await harness()
  const c = await h.connect()

  // Some firmware sends CRLF and some sends a keep-alive newline. Neither is worth a disconnect.
  c.raw('\r\n\n{"id":1,"method":"mining.subscribe","params":[]}\r\n\n')

  await c.await((m) => m['id'] === 1, 'the subscribe reply')
  assert.equal(h.server.connectionCount, 1, 'a blank line is not a reason to close a connection')
})

test('a line that never ends is closed once it passes the cap', async () => {
  const h = await harness()
  const c = await h.connect()

  // No newline anywhere in it. Uncapped, this is a peer that can consume the process's memory for
  // the price of one socket.
  c.raw('x'.repeat(MAX_LINE_BYTES + 1_024))

  await c.awaitClose('the oversized-line disconnect')
  assert.ok(
    h.logs.some((l) => l.level === 'warn' && l.message.includes('oversized')),
    'the disconnect is logged, because a miner whose connection vanished deserves an explanation somewhere',
  )
})

test('a line just under the cap is accepted', async () => {
  const h = await harness()
  const c = await h.connect()

  // The boundary in the other direction. A cap that fires early truncates a legitimate submit from a
  // miner with a long worker name, which is a far harder failure to diagnose than a rejected one.
  const padding = 'p'.repeat(MAX_LINE_BYTES - 128)
  c.send({ id: 1, method: 'mining.subscribe', params: [padding] })

  await c.await((m) => m['id'] === 1, 'the subscribe reply')
  assert.ok(!c.closed())
})

test('a payload that is not JSON closes the connection without a reply', async () => {
  const h = await harness()
  const c = await h.connect()

  // A port scan, a browser, a miner pointed at the HTTP port. There is no id to answer to, so an
  // error reply would have to invent one.
  c.raw('GET / HTTP/1.1\r\n')
  c.raw('\n')

  await c.awaitClose('the non-JSON disconnect')
  assert.equal(c.messages.length, 0)
})

test('a JSON scalar is not a request and closes the connection', async () => {
  const h = await harness()
  const c = await h.connect()

  c.raw('42\n')

  await c.awaitClose('the non-object disconnect')
})

test('a JSON object with no method is ignored, and the connection survives it', async () => {
  const h = await harness()
  const c = await h.connect()

  // This is what a stray response looks like — a miner echoing something back, or a proxy's own
  // keep-alive. It is not a request, there is nothing to answer, and it is not grounds for a
  // disconnect either.
  c.send({ id: 7, result: true, error: null })
  c.send({ id: 1, method: 'mining.subscribe', params: [] })

  await c.await((m) => m['id'] === 1, 'the subscribe reply')
  assert.ok(!c.messages.some((m) => m['id'] === 7))
})

test('a session that throws takes its own connection down and nothing else', async () => {
  const h = await harness()
  const victim = await h.connect()
  const bystander = await h.connect()
  await connect(bystander)

  // `registry.current` is read on authorize. Shadowing the prototype getter with one that throws is
  // the only way in from outside; the point of the test is the listener's containment, not this
  // particular fault.
  Object.defineProperty(h.registry, 'current', {
    configurable: true,
    get() {
      throw new Error('the registry exploded')
    },
  })

  victim.send({ id: 1, method: 'mining.subscribe', params: [] })
  await victim.await((m) => m['id'] === 1, 'the subscribe reply')
  victim.send({ id: 2, method: 'mining.authorize', params: [USERNAME, 'x'] })

  await victim.awaitClose('the disconnect after a session throw')
  assert.ok(h.logs.some((l) => l.level === 'error' && l.message.includes('threw')))
  assert.ok(!bystander.closed(), 'one connection bad input must not be another connection outage')
})

/* ------------------------------------------------------------------ connections */

test('the subscribe reply carries this connection own extranonce1 and the extranonce2 size', async () => {
  const h = await harness()
  const c = await h.connect()
  const extranonce1 = await connect(c)

  assert.equal(extranonce1.length, 4)
  const reply = c.messages.find((m) => m['id'] === 1)
  assert.equal((reply?.['result'] as [unknown, string, number])[2], EXTRANONCE2_BYTES)
})

test('two connections never share an extranonce1', async () => {
  const h = await harness()
  const seen = new Set<string>()
  for (let i = 0; i < 12; i += 1) {
    const c = await h.connect()
    seen.add((await connect(c)).toString('hex'))
  }

  // Two miners with the same extranonce1 search identical coinbase space and duplicate each other's
  // work for as long as they both stay connected. Twelve is not proof of the random draw, but it is
  // proof the uniqueness set is wired up at all.
  assert.equal(seen.size, 12)
  assert.equal(h.server.connectionCount, 12)
})

test('an extranonce1 is returned to the pool when its connection closes', async () => {
  const h = await harness()
  const c = await h.connect()
  await connect(c)
  assert.equal(h.server.connectionCount, 1)

  c.end()
  await until(() => h.server.connectionCount === 0, 'the connection to be forgotten')
})

test('a connection that says nothing is closed at the handshake deadline', async () => {
  // The cheapest attack on a listener: connect, send nothing, hold a slot. Costs the peer one file
  // descriptor and costs the pool one.
  const h = await harness({ handshakeTimeoutMs: 150 })
  const c = await h.connect()

  await c.awaitClose('the handshake timeout')
  await until(() => h.server.connectionCount === 0, 'the slot to be released')
})

test('a connection that subscribed but never authorised is closed too', async () => {
  // Subscribing is free and does not identify anybody. The deadline is on authorisation, not on
  // saying something, or the attack above works with one extra packet.
  const h = await harness({ handshakeTimeoutMs: 150 })
  const c = await h.connect()
  c.send({ id: 1, method: 'mining.subscribe', params: [] })
  await c.await((m) => m['id'] === 1, 'the subscribe reply')

  await c.awaitClose('the handshake timeout')
})

test('an authorised connection is not closed at the handshake deadline', async () => {
  const h = await harness({ handshakeTimeoutMs: 150 })
  const c = await h.connect()
  await connect(c)

  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.ok(!c.closed())
  assert.equal(h.server.connectionCount, 1)
})

/* ------------------------------------------------------------------ broadcast */

test('a broadcast reaches every authorised connection', async () => {
  const h = await harness()
  const a = await h.connect()
  const b = await h.connect()
  await connect(a)
  await connect(b)

  const job = h.push()
  h.server.broadcast(job, true)

  for (const c of [a, b]) {
    const notify = await c.await((m) => m['method'] === 'mining.notify', 'the job')
    const params = notify['params'] as unknown[]
    assert.equal(params.length, 9, 'mining.notify is nine positional parameters and firmware counts them')
    assert.equal(params[0], job.id)
    assert.equal(params[8], true, 'clean_jobs')
  }
})

test('a connection that has not authorised is not sent work', async () => {
  const h = await harness()
  const c = await h.connect()
  c.send({ id: 1, method: 'mining.subscribe', params: [] })
  await c.await((m) => m['id'] === 1, 'the subscribe reply')

  h.server.broadcast(h.push(), true)
  await new Promise((resolve) => setTimeout(resolve, 50))

  // There is nobody to credit a share to yet, so a job would be work done for an account the pool
  // cannot name.
  assert.ok(!c.messages.some((m) => m['method'] === 'mining.notify'))
})

test('a peer that has stopped reading is dropped rather than buffered', async () => {
  const h = await harness()
  const c = await h.connect()
  await connect(c)
  const job = h.push({ transactionCount: 60 })

  // The client stops reading here. `pause()` is what a miner whose firmware has wedged looks like
  // from this side: the socket is open, the TCP window closes, and every further write lands in
  // Node's own buffer. Uncapped, one wedged miner is the pool's memory ceiling.
  c.socket.pause()

  // Filling a real kernel receive buffer takes as many writes as the kernel decided to size it, and
  // that number is not knowable here — hence a loop with a cap rather than an arithmetic guess.
  // The cap is high enough for an auto-tuned loopback buffer of several megabytes and low enough to
  // fail in seconds rather than hang. The log line is the loop's exit condition and not
  // `connectionCount`, because `destroy()` only schedules the close event: the count does not drop
  // until a later tick, so a loop watching it would keep spinning after the drop had happened.
  const dropped = (): boolean => h.logs.some((l) => l.level === 'warn' && l.message.includes('not draining'))
  for (let i = 0; i < 100_000 && !dropped(); i += 1) {
    h.server.broadcast(job, false)
  }

  assert.ok(dropped(), 'the wedged connection must have been dropped, and loudly')
  await until(() => h.server.connectionCount === 0, 'the dropped connection to be forgotten')
})

/* ------------------------------------------------------------------ shares, end to end */

test('a mined share travels the whole path and is persisted', async () => {
  const h = await harness()
  const c = await h.connect()
  const extranonce1 = await connect(c)
  const job = h.push({ bitsHex: MAINNET_BITS })
  h.server.broadcast(job, true)
  await c.await((m) => m['method'] === 'mining.notify', 'the job')

  const nonceHex = mine(job, extranonce1)
  c.send({ id: 4, method: 'mining.submit', params: ['w', job.id, '00000001', job.ntimeHex, nonceHex] })

  const reply = await c.await((m) => m['id'] === 4, 'the submit reply')
  assert.equal(reply['result'], true)
  assert.equal(reply['error'], null)

  await until(() => h.persisted().length === 1, 'the share to be flushed')
  const share = h.persisted()[0]
  assert.equal(share?.account, 'bc1qexampleaddress')
  assert.equal(share?.worker, 'rig1')
  assert.equal(share?.jobId, job.id)
  assert.equal(share?.height, job.height)
  assert.ok((share?.difficultyUnits ?? 0n) > 0n)
})

test('shares are batched rather than written one at a time', async () => {
  // The interval is set out of reach and the flush is called by hand, so the assertion below is
  // about the buffer rather than about a race with a timer. The timer itself is covered by the
  // previous test, which waits for it.
  const h = await harness({ flushIntervalMs: 60_000 })
  const c = await h.connect()
  const extranonce1 = await connect(c)
  const job = h.push({ bitsHex: MAINNET_BITS })
  h.server.broadcast(job, true)
  await c.await((m) => m['method'] === 'mining.notify', 'the job')

  // Three distinct solutions — a different extranonce2 is a different coinbase and therefore a
  // different search space, which is the whole reason the field exists. All three are found before
  // any is submitted, so the submits go out back to back.
  const solutions = ['00000001', '00000002', '00000003'].map((extranonce2) => ({
    extranonce2,
    nonceHex: mine(job, extranonce1, extranonce2),
  }))
  for (const [index, solution] of solutions.entries()) {
    c.send({
      id: 40 + index,
      method: 'mining.submit',
      params: ['w', job.id, solution.extranonce2, job.ntimeHex, solution.nonceHex],
    })
  }
  for (const index of [0, 1, 2]) {
    const reply = await c.await((m) => m['id'] === 40 + index, `submit ${index}`)
    assert.equal(reply['result'], true, `submit ${index} must be accepted`)
  }

  // The replies are the point: all three came back without a database round trip, which is what the
  // buffer buys and what a miner measures the pool by.
  assert.equal(h.persisted().length, 0, 'nothing is written before a flush')
  await h.server.flush()
  assert.equal(h.batches.length, 1, 'one write for three shares')
  assert.equal(h.persisted().length, 3)
})

test('a block is recorded before the miner is even told the share was accepted', async () => {
  const h = await harness({ flushIntervalMs: 60_000 })
  const c = await h.connect()
  const extranonce1 = await connect(c)
  // Regtest bits put the block target above the share target, so the first accepted share is
  // necessarily also a block. See `faketemplate.ts`.
  const job = h.push()
  h.server.broadcast(job, true)
  await c.await((m) => m['method'] === 'mining.notify', 'the job')

  const nonceHex = mine(job, extranonce1)
  c.send({ id: 4, method: 'mining.submit', params: ['w', job.id, '00000001', job.ntimeHex, nonceHex] })
  await c.await((m) => m['id'] === 4, 'the submit reply')

  // The flush interval is a minute, so nothing buffered can have been written. The block is here
  // anyway, which is the guarantee: a found block never waits on a timer.
  assert.equal(h.blocks.length, 1)
  assert.equal(h.persisted().length, 0)
  assert.equal(h.blocks[0]?.job.height, job.height)
  assert.equal(h.blocks[0]?.account, 'bc1qexampleaddress')
  assert.equal(h.blocks[0]?.header.length, 80)
})

test('a stale job id is refused with 21 and the connection stays up', async () => {
  const h = await harness()
  const c = await h.connect()
  await connect(c)
  h.push()

  c.send({ id: 4, method: 'mining.submit', params: ['w', 'deadbeef', '00000001', '68e7a900', '00000000'] })
  const reply = await c.await((m) => m['id'] === 4, 'the submit reply')

  const error = reply['error'] as [number, string, unknown]
  assert.equal(error[0], 21)
  assert.ok(!c.closed(), 'a rejected share is a normal event, not a protocol violation')
})

/* ------------------------------------------------------------------ the flush */

test('close flushes what is buffered', async () => {
  // A deploy restarts this process. Without the shutdown flush, every restart quietly costs each
  // connected miner up to one interval of credited work.
  const h = await harness({ flushIntervalMs: 60_000 })
  const c = await h.connect()
  const extranonce1 = await connect(c)
  const job = h.push({ bitsHex: MAINNET_BITS })
  h.server.broadcast(job, true)
  await c.await((m) => m['method'] === 'mining.notify', 'the job')

  const nonceHex = mine(job, extranonce1)
  c.send({ id: 4, method: 'mining.submit', params: ['w', job.id, '00000001', job.ntimeHex, nonceHex] })
  await c.await((m) => m['id'] === 4, 'the submit reply')
  assert.equal(h.persisted().length, 0)

  await h.server.close()
  assert.equal(h.persisted().length, 1)
})

test('close destroys live connections and stops accepting new ones', async () => {
  const h = await harness()
  const c = await h.connect()
  await connect(c)
  const port = h.server.boundPort
  assert.ok(typeof port === 'number' && port > 0)

  await h.server.close()
  await c.awaitClose('the shutdown disconnect')
  assert.equal(h.server.connectionCount, 0)
  assert.equal(h.server.boundPort, null)

  await assert.rejects(client(port ?? 0), 'the listener is gone, so the port refuses')
})

test('a failed write drops the batch loudly and does not requeue it', async () => {
  const h = await harness({ flushIntervalMs: 60_000 })
  const c = await h.connect()
  const extranonce1 = await connect(c)
  const job = h.push({ bitsHex: MAINNET_BITS })
  h.server.broadcast(job, true)
  await c.await((m) => m['method'] === 'mining.notify', 'the job')

  const nonceHex = mine(job, extranonce1)
  c.send({ id: 4, method: 'mining.submit', params: ['w', job.id, '00000001', job.ntimeHex, nonceHex] })
  await c.await((m) => m['id'] === 4, 'the submit reply')

  h.failNextPersist()
  await h.server.flush()

  const dropped = h.logs.find((l) => l.level === 'error' && l.message.includes('lost a batch'))
  assert.ok(dropped, 'a lost share is an accounting failure and is never silent')
  assert.equal(dropped?.fields?.['shares'], 1, 'the count is the whole value of the log line')

  // Requeueing would build an unbounded queue against a database that is down, which is how the
  // process dies instead of one batch. The second flush writes nothing.
  await h.server.flush()
  assert.equal(h.persisted().length, 0)
})

test('flushing with nothing buffered does not call the writer at all', async () => {
  const h = await harness({ flushIntervalMs: 60_000 })
  await h.server.flush()
  assert.equal(h.batches.length, 0, 'an idle pool must not write an empty batch every interval')
})

/* ------------------------------------------------------------------ the listener itself */

test('listen rejects rather than resolving when the port is taken', async () => {
  const first = await harness()
  const port = first.server.boundPort ?? 0

  const second = new StratumServer({
    chain: 'btc',
    algorithm: 'sha256d',
    registry: first.registry,
    host: '127.0.0.1',
    port,
    initialDifficulty: SHARE_DIFFICULTY,
    vardiff: TEST_VARDIFF,
    persistShares: async () => {},
    onBlock: () => {},
    log: () => {},
  })

  // A boot that resolved here would report a healthy pool listening on a port it does not own.
  await assert.rejects(second.listen(), /EADDRINUSE/)
  assert.equal(second.boundPort, null)
})

/* -------------------------------------------------- the WebSocket transport (micro-org#289) */

/**
 * A `Wire` that is not a socket.
 *
 * The point of the seam. `wsframe.test.ts` proves the framing and `wsstratum.test.ts` proves the
 * upgrade; what has to be proved HERE is that a wire which is not a `net.Socket` gets the same
 * session, the same line splitter and the same teardown — so the fake is deliberately minimal, and
 * anything `stratum.ts` starts needing from a socket beyond these six members breaks this file.
 */
function fakeWire() {
  const lines: string[] = []
  let dataHandler: ((chunk: string) => void) | null = null
  let closeHandler: (() => void) | null = null
  let destroyed = false
  const wire = {
    get destroyed() {
      return destroyed
    },
    writableLength: 0,
    write: (line: string) => {
      lines.push(line)
    },
    destroy: () => {
      if (destroyed) return
      destroyed = true
      closeHandler?.()
    },
    onData: (handler: (chunk: string) => void) => {
      dataHandler = handler
    },
    onClose: (handler: () => void) => {
      closeHandler = handler
    },
  }
  return {
    wire,
    lines,
    /** Everything received, parsed, in order. */
    messages: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    feed: (text: string) => dataHandler?.(text),
  }
}

const BROWSER_START = 1 / 65536 / 4

function browserOptions(redeem: (secret: string) => { account: string; worker: string } | null) {
  return {
    initialDifficulty: BROWSER_START,
    vardiff: { ...TEST_VARDIFF, minDifficulty: BROWSER_START },
    redeemTicket: redeem,
  }
}

test('a pool with no identity configured serves no browsers and says so', async () => {
  // Not an error and not a crash: identity is optional configuration, a pool run by somebody with no
  // estate is the ordinary case, and `wsstratum.ts` turns this false into a refused upgrade carrying
  // a status rather than a socket that connects and then never speaks.
  const h = await harness()
  const fake = fakeWire()
  assert.equal(h.server.servesBrowsers, false)
  assert.equal(h.server.attachWebSocket(fake.wire), false)
  assert.equal(h.server.connectionCount, 0)
  assert.deepEqual(fake.lines, [], 'a refused wire must be told nothing at all')
})

test('a browser authorises with a ticket and mines under the account the ticket named', async () => {
  const h = await harness({ browser: browserOptions(() => ({ account: 'cf-00112233445566aa', worker: 'web-a1b2c3' })) })
  h.push()
  const fake = fakeWire()
  assert.equal(h.server.servesBrowsers, true)
  assert.equal(h.server.attachWebSocket(fake.wire), true)

  fake.feed(`${JSON.stringify({ id: 1, method: 'mining.subscribe', params: ['cloudsforge-web/1'] })}\n`)
  fake.feed(`${JSON.stringify({ id: 2, method: 'mining.authorize', params: ['ignored', 'a-ticket'] })}\n`)

  const messages = fake.messages()
  assert.equal(messages.find((m) => m.id === 2)?.result, true)
  // The whole handshake reached a wire that has no file descriptor behind it.
  assert.ok(messages.some((m) => m.method === 'mining.notify'))
  assert.equal(h.server.connectionCount, 1)
})

test('a browser starts at the browser difficulty, not at the one a rig gets', async () => {
  // The per-transport band, observed where it actually lands: in the `mining.set_difficulty` the
  // client is sent. A browser handed a rig's starting difficulty submits nothing for hours and is
  // indistinguishable from a miner that is broken.
  const h = await harness({ browser: browserOptions(() => ({ account: 'cf-a', worker: 'web-a' })) })
  const fake = fakeWire()
  h.server.attachWebSocket(fake.wire)
  fake.feed(`${JSON.stringify({ id: 1, method: 'mining.subscribe', params: [] })}\n`)
  fake.feed(`${JSON.stringify({ id: 2, method: 'mining.authorize', params: ['x', 't'] })}\n`)

  const set = fake.messages().find((m) => m.method === 'mining.set_difficulty')
  assert.deepEqual(set?.params, [BROWSER_START])

  // And a TCP miner on the same server is still handed the hardware one. One `StratumServer`, one
  // registry, one set of jobs, two bands.
  const tcp = await h.connect()
  tcp.send({ id: 1, method: 'mining.subscribe', params: [] })
  tcp.send({ id: 2, method: 'mining.authorize', params: [USERNAME, 'x'] })
  const tcpSet = await tcp.await((m) => m.method === 'mining.set_difficulty', 'set_difficulty over TCP')
  assert.deepEqual(tcpSet.params, [SHARE_DIFFICULTY])
})

test('a browser that presents no ticket is refused and never gets work', async () => {
  const h = await harness({ browser: browserOptions(() => null) })
  h.push()
  const fake = fakeWire()
  h.server.attachWebSocket(fake.wire)
  fake.feed(`${JSON.stringify({ id: 1, method: 'mining.subscribe', params: [] })}\n`)
  fake.feed(`${JSON.stringify({ id: 2, method: 'mining.authorize', params: ['bc1qexampleaddress.rig1', 'x'] })}\n`)

  const messages = fake.messages()
  assert.equal(messages.find((m) => m.id === 2)?.result, false)
  // The username was a perfectly good one and would have worked over TCP. On this transport it is
  // not an identity, and a refusal that still handed out a job would credit the work to a stranger.
  assert.ok(!messages.some((m) => m.method === 'mining.notify'))
})

test('a browser is broadcast to, and its slot is released when it goes away', async () => {
  const h = await harness({ browser: browserOptions(() => ({ account: 'cf-a', worker: 'web-a' })) })
  const fake = fakeWire()
  h.server.attachWebSocket(fake.wire)
  fake.feed(`${JSON.stringify({ id: 1, method: 'mining.subscribe', params: [] })}\n`)
  fake.feed(`${JSON.stringify({ id: 2, method: 'mining.authorize', params: ['x', 't'] })}\n`)

  const before = fake.messages().filter((m) => m.method === 'mining.notify').length
  h.server.broadcast(h.push(), true)
  assert.equal(fake.messages().filter((m) => m.method === 'mining.notify').length, before + 1)

  // The teardown is the shared one: closing the wire must free the connection and its extranonce,
  // or a page refreshed a few thousand times exhausts a four-byte space this listener never reuses.
  fake.wire.destroy()
  assert.equal(h.server.connectionCount, 0)
})

test('a draining pool refuses a browser rather than handing it work it will not settle', async () => {
  // Same rule the TCP listener follows on the way down, and it has to be checked separately because
  // the WebSocket transport does not go through `#accept`: the HTTP server is still up and still
  // accepting upgrades at the moment the chains are closing.
  const h = await harness({ browser: browserOptions(() => ({ account: 'cf-a', worker: 'web-a' })) })
  await h.server.close()
  const fake = fakeWire()
  assert.equal(h.server.attachWebSocket(fake.wire), false)
  assert.equal(h.server.connectionCount, 0)
})

/* -------------------------- the payout address check reaches a real connection (micro-org#286) */

test('A MINER ON A REAL SOCKET IS REFUSED WHEN THE NODE DOES NOT RECOGNISE ITS ADDRESS', async () => {
  // `session.test.ts` proves the state machine refuses; this proves the refusal is REACHABLE. The
  // check is configuration on `StratumServer` and it is handed to every session it builds, so a
  // wiring that quietly dropped it would leave every test in `session.test.ts` green and every
  // miner in production unchecked. That is the whole failure mode micro-org#286 is about, one layer
  // up: a guard nothing calls.
  const asked: string[] = []
  const h = await harness({
    checkPayoutAddress: (address) => {
      asked.push(address)
      return Promise.resolve(address === 'bc1qexampleaddress' ? 'valid' : 'invalid')
    },
  })
  h.push()

  const refused = await h.connect()
  refused.send({ id: 1, method: 'mining.subscribe', params: [] })
  await refused.await((m) => m['id'] === 1, 'the subscribe reply')
  refused.send({ id: 2, method: 'mining.authorize', params: ['1SomeoneElsesChainAddress.rig', 'x'] })
  const reply = await refused.await((m) => m['id'] === 2, 'the authorize reply')
  assert.equal(reply['result'], false)
  assert.equal((reply['error'] as [number, string, unknown])[0], 24)

  // And a good address still gets all the way to work, over the same socket path.
  const accepted = await h.connect()
  await connect(accepted)
  await accepted.await((m) => m['method'] === 'mining.notify', 'the first job')

  assert.deepEqual(asked, ['1SomeoneElsesChainAddress', 'bc1qexampleaddress'])
})
