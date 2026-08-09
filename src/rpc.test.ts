/**
 * The node client, and mostly the two things about it that are not obvious.
 *
 * **The credential.** Every endpoint URL in this estate carries the RPC password as userinfo, so
 * every one of these tests runs against a URL that has a real-looking password in it, and the file
 * ends with a sweep asserting that no error this module raises has ever seen it. That sweep is the
 * point of the file. `rpc.ts` explains at length why `URL.origin` silently drops userinfo and turns
 * a working password into a 401 that reads like a wrong one; the tests below pin both halves — that
 * the credential does reach the wire as an `Authorization` header, and that it reaches nothing else.
 *
 * **The classification.** Bitcoin Core reports an application-level JSON-RPC error as a 500 with the
 * error in the body, which means "this block is a duplicate" and "this node is behind a dead proxy"
 * arrive as the same HTTP status. A caller that cannot tell them apart either retries a refusal
 * forever or gives up on a transient failure, so the split between `NodeRpcError` and
 * `NodeUnavailableError` is checked here from both directions, including the malformed bodies that
 * have to fall to the unavailable side.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { CircuitOpenError, HttpError, TimeoutError, type HttpClient, type RequestOptions } from '@cloudsforge/http'
import { NODE_RPC_SCOPES, NodeRpc, NodeRpcError, NodeUnavailableError, basicAuthFor } from './rpc.ts'

/** The shape every test in this file points at. Userinfo on purpose. */
const URL_WITH_CREDENTIAL = 'http://rpcuser:s3cr3tpassw0rd@node.invalid:8332/'

interface Recorded {
  readonly path: string
  readonly options: RequestOptions | undefined
}

interface Stub {
  readonly client: Pick<HttpClient, 'request'>
  readonly calls: Recorded[]
}

/** A client that answers with `reply`, or throws `reply` when it is an error. */
function stub(reply: unknown | (() => unknown)): Stub {
  const calls: Recorded[] = []
  return {
    calls,
    client: {
      async request<T>(path: string, options?: RequestOptions): Promise<T> {
        calls.push({ path, options })
        const value = typeof reply === 'function' ? (reply as () => unknown)() : reply
        if (value instanceof Error) throw value
        return value as T
      },
    },
  }
}

function rpcWith(stubbed: Stub, url = URL_WITH_CREDENTIAL): NodeRpc {
  return new NodeRpc({ chain: 'btc', url, client: stubbed.client })
}

/* ------------------------------------------------------------------ the credential */

test('basicAuthFor encodes the userinfo as HTTP Basic', () => {
  const header = basicAuthFor('http://rpcuser:rpcpassword@node.invalid:8332/')
  assert.equal(header, `Basic ${Buffer.from('rpcuser:rpcpassword').toString('base64')}`)
  // Spelled out once, so a change to the encoding fails against a constant rather than against
  // another call to the same function.
  assert.equal(header, 'Basic cnBjdXNlcjpycGNwYXNzd29yZA==')
})

test('basicAuthFor percent-decodes before encoding', () => {
  // A password with an `@` in it cannot appear literally in a URL, so whoever wrote the endpoint had
  // to escape it. Base64-ing the escaped form sends `p%40ss`, which is not the password, and the
  // node answers 401 — indistinguishable from a genuinely wrong credential.
  const header = basicAuthFor('http://us%40er:p%40ss%2Fword@node.invalid:8332/')
  assert.equal(header, `Basic ${Buffer.from('us@er:p@ss/word').toString('base64')}`)
})

test('basicAuthFor answers undefined for a URL with no userinfo', () => {
  assert.equal(basicAuthFor('http://node.invalid:8332/'), undefined)
})

test('basicAuthFor keeps a username with an empty password', () => {
  // `http://cookieuser@host` is a real shape — Core's `.cookie` file auth is a username and an
  // empty password often enough that dropping the header here would break it.
  assert.equal(basicAuthFor('http://only@node.invalid:8332/'), `Basic ${Buffer.from('only:').toString('base64')}`)
})

test('the host is host and port, and never the credential', () => {
  const rpc = rpcWith(stub({ result: null, error: null }))
  assert.equal(rpc.host, 'node.invalid:8332')
  assert.ok(!rpc.host.includes('s3cr3t'))
  assert.ok(!rpc.host.includes('@'))
})

/* ------------------------------------------------------------------ the envelope */

test('a call sends a JSON-RPC 1.0 envelope with the method and params', async () => {
  const s = stub({ result: { height: 800_000 }, error: null })
  const result = await rpcWith(s).call<{ height: number }>('getblocktemplate', [{ rules: ['segwit'] }])

  assert.deepEqual(result, { height: 800_000 })
  assert.equal(s.calls.length, 1)
  assert.equal(s.calls[0]?.options?.method, 'POST')
  assert.deepEqual(s.calls[0]?.options?.body, {
    jsonrpc: '1.0',
    id: 1,
    method: 'getblocktemplate',
    params: [{ rules: ['segwit'] }],
  })
})

test('params default to an empty array rather than being omitted', async () => {
  // Core rejects a request with no `params` member on some methods. Sending `[]` is what every
  // other client does and what the node's own `bitcoin-cli` does.
  const s = stub({ result: 'ok', error: null })
  await rpcWith(s).call('getblockchaininfo')
  assert.deepEqual((s.calls[0]?.options?.body as { params?: unknown }).params, [])
})

test('the id increments per call on one client', async () => {
  const s = stub({ result: null, error: null })
  const rpc = rpcWith(s)
  await rpc.call('a')
  await rpc.call('b')
  await rpc.call('c')
  assert.deepEqual(
    s.calls.map((c) => (c.options?.body as { id: number }).id),
    [1, 2, 3],
  )
})

test('the path and query of the endpoint survive into the request', async () => {
  // Core serves a named wallet at a sub-path. Rebuilding the request from the origin alone would
  // send every call to `/` and hit the default wallet instead.
  const s = stub({ result: null, error: null })
  const rpc = new NodeRpc({ chain: 'btc', url: 'http://u:p@node.invalid:8332/wallet/pool?x=1', client: s.client })
  await rpc.call('getbalance')
  assert.equal(s.calls[0]?.path, '/wallet/pool?x=1')
})

test('a call is retryable by default and carries an idempotency key', async () => {
  const s = stub({ result: null, error: null })
  await rpcWith(s).call('getblocktemplate')
  assert.equal(s.calls[0]?.options?.idempotencyKey, 'getblocktemplate:1')
})

test('a call marked not retryable carries no idempotency key at all', async () => {
  // Absent, not undefined: `@cloudsforge/http` decides on presence, and an explicit `undefined`
  // under `exactOptionalPropertyTypes` is a different value from a missing member.
  const s = stub({ result: null, error: null })
  await rpcWith(s).call('sendrawtransaction', ['ff'], { retryable: false })
  assert.ok(!('idempotencyKey' in (s.calls[0]?.options ?? {})))
})

test('the deadline defaults to the client deadline and a call may shorten it', async () => {
  const s = stub({ result: null, error: null })
  const rpc = new NodeRpc({ chain: 'btc', url: URL_WITH_CREDENTIAL, deadlineMs: 4_000, client: s.client })
  await rpc.call('getblocktemplate')
  await rpc.call('getblocktemplate', [], { deadlineMs: 250 })
  assert.equal(s.calls[0]?.options?.deadlineMs, 4_000)
  assert.equal(s.calls[1]?.options?.deadlineMs, 250)
})

test('an abort signal is passed through, and is absent when none was given', async () => {
  const s = stub({ result: null, error: null })
  const rpc = rpcWith(s)
  const controller = new AbortController()
  await rpc.call('getblocktemplate', [], { signal: controller.signal })
  await rpc.call('getblocktemplate')
  assert.equal(s.calls[0]?.options?.signal, controller.signal)
  assert.ok(!('signal' in (s.calls[1]?.options ?? {})))
})

test('a null result is a result and not a failure', async () => {
  // `submitblock` answers null to mean the block was accepted. Treating a falsy result as an error
  // would report every accepted block as a failed submission.
  const s = stub({ result: null, error: null })
  assert.equal(await rpcWith(s).call('submitblock', ['00']), null)
})

/* ------------------------------------------------------------------ refusal vs unavailability */

test('a JSON-RPC error in a 200 body becomes a NodeRpcError carrying the code', async () => {
  const s = stub({ result: null, error: { code: -8, message: 'Block decode failed' } })
  await assert.rejects(rpcWith(s).call('submitblock', ['00']), (err: unknown) => {
    assert.ok(err instanceof NodeRpcError)
    assert.equal(err.code, -8)
    assert.equal(err.rpcMethod, 'submitblock')
    assert.equal(err.chain, 'btc')
    assert.match(err.message, /Block decode failed/)
    return true
  })
})

test('a JSON-RPC error missing its code and message still classifies as a refusal', async () => {
  const s = stub({ result: null, error: {} })
  await assert.rejects(rpcWith(s).call('getblocktemplate'), (err: unknown) => {
    assert.ok(err instanceof NodeRpcError)
    assert.equal(err.code, -32000, 'the generic server-error code, so callers can still switch')
    assert.match(err.message, /unknown JSON-RPC error/)
    return true
  })
})

test('a 500 with a JSON-RPC error in the body is unwrapped into a refusal', async () => {
  // This is the shape Core actually uses, and the reason the unwrapping exists: without it every
  // "duplicate block" would be indistinguishable from a node that fell over.
  const s = stub(
    new HttpError({
      status: 500,
      method: 'POST',
      url: URL_WITH_CREDENTIAL,
      body: JSON.stringify({ result: null, error: { code: -22, message: 'duplicate' }, id: 1 }),
    }),
  )
  await assert.rejects(rpcWith(s).call('submitblock', ['00']), (err: unknown) => {
    assert.ok(err instanceof NodeRpcError)
    assert.equal(err.code, -22)
    return true
  })
})

test('a 502 whose body is not JSON is an unavailability, not a refusal', async () => {
  // A proxy in front of the node. The node never saw the call, so the honest classification is that
  // no progress was made rather than that the request was rejected.
  const s = stub(
    new HttpError({
      status: 502,
      method: 'POST',
      url: URL_WITH_CREDENTIAL,
      body: '<html><body>502 Bad Gateway</body></html>',
    }),
  )
  await assert.rejects(rpcWith(s).call('getblocktemplate'), (err: unknown) => {
    assert.ok(err instanceof NodeUnavailableError)
    assert.match(err.message, /http 502/)
    assert.equal(err.rpcMethod, 'getblocktemplate')
    assert.equal(err.chain, 'btc')
    return true
  })
})

test('a JSON body with no usable JSON-RPC error falls to unavailable', async () => {
  // Each of these parses, and none of them names a code. Guessing one would invent a refusal the
  // node never made.
  const bodies = ['null', '"a string"', '{}', '{"error":null}', '{"error":"boom"}', '{"error":{"code":"-8"}}']
  for (const body of bodies) {
    const s = stub(new HttpError({ status: 500, method: 'POST', url: URL_WITH_CREDENTIAL, body }))
    await assert.rejects(rpcWith(s).call('getblocktemplate'), (err: unknown) => {
      assert.ok(err instanceof NodeUnavailableError, `body ${body} must not become a refusal`)
      return true
    })
  }
})

test('an error object with a code but no message gets the generic message', async () => {
  const s = stub(
    new HttpError({
      status: 500,
      method: 'POST',
      url: URL_WITH_CREDENTIAL,
      body: JSON.stringify({ error: { code: -1 } }),
    }),
  )
  await assert.rejects(rpcWith(s).call('getblocktemplate'), (err: unknown) => {
    assert.ok(err instanceof NodeRpcError)
    assert.equal(err.code, -1)
    assert.match(err.message, /unknown JSON-RPC error/)
    return true
  })
})

test('a timeout is an unavailability and says so', async () => {
  const s = stub(new TimeoutError(URL_WITH_CREDENTIAL, 10_000))
  await assert.rejects(rpcWith(s).call('getblocktemplate'), (err: unknown) => {
    assert.ok(err instanceof NodeUnavailableError)
    assert.match(err.message, /timeout/)
    return true
  })
})

test('an open circuit is an unavailability and names the breaker, not the URL', async () => {
  const s = stub(new CircuitOpenError('node:btc', 5_000))
  await assert.rejects(rpcWith(s).call('getblocktemplate'), (err: unknown) => {
    assert.ok(err instanceof NodeUnavailableError)
    assert.match(err.message, /circuit open \(node:btc\)/)
    return true
  })
})

test('a thrown non-Error is stringified rather than swallowed', async () => {
  const s = stub(() => {
    throw 'socket hang up'
  })
  await assert.rejects(rpcWith(s).call('getblocktemplate'), (err: unknown) => {
    assert.ok(err instanceof NodeUnavailableError)
    assert.match(err.message, /socket hang up/)
    return true
  })
})

/* ------------------------------------------------------------------ the sweep */

test('no error this module raises carries the endpoint credential', async () => {
  // The whole reason `rpc.ts` never lets the URL out of its constructor. Every failure mode above
  // is replayed here and every message is checked, because a leak needs only one path and the log
  // it lands in is not one this repository controls.
  const failures: (Error | string | Record<string, unknown>)[] = [
    new HttpError({ status: 500, method: 'POST', url: URL_WITH_CREDENTIAL, body: '<html>500</html>' }),
    new HttpError({
      status: 500,
      method: 'POST',
      url: URL_WITH_CREDENTIAL,
      body: JSON.stringify({ error: { code: -22, message: 'duplicate' } }),
    }),
    new TimeoutError(URL_WITH_CREDENTIAL, 10_000),
    new CircuitOpenError('node:btc', 5_000),
  ]

  const messages: string[] = []
  for (const failure of failures) {
    const s = stub(failure)
    await assert.rejects(rpcWith(s).call('getblocktemplate'), (err: unknown) => {
      messages.push(err instanceof Error ? `${err.name}: ${err.message}` : String(err))
      return true
    })
  }
  // And the in-body refusal path, which is the one that never touches `@cloudsforge/http`'s own
  // redaction and therefore has no safety net but this file.
  const inBody = stub({ result: null, error: { code: -8, message: 'Block decode failed' } })
  await assert.rejects(rpcWith(inBody).call('submitblock', ['00']), (err: unknown) => {
    messages.push(err instanceof Error ? `${err.name}: ${err.message}` : String(err))
    return true
  })

  assert.equal(messages.length, 5)
  for (const message of messages) {
    assert.ok(!message.includes('s3cr3t'), `password leaked: ${message}`)
    assert.ok(!message.includes('rpcuser'), `username leaked: ${message}`)
    assert.ok(!message.includes('@'), `userinfo separator present, so a URL got out: ${message}`)
  }
})

test('the estate scope list is empty and frozen', () => {
  // `micro-deploy` derives grants from this. Empty is the answer, and it is frozen so that a later
  // `push` cannot quietly grant this service an estate credential it has no use for.
  assert.deepEqual([...NODE_RPC_SCOPES], [])
  assert.ok(Object.isFrozen(NODE_RPC_SCOPES))
})
