/**
 * Fixtures: a `getblocktemplate` reply that is shaped like a real one, and a fake node that serves
 * it.
 *
 * The counterpart of `indexer/src/fakebitcoin.ts`, and it exists for a narrower reason. A pool's
 * interesting behaviour is almost all downstream of a template — the coinbase split, the merkle
 * branch, the header, the share verdict — and none of it can be exercised without one. Pointing the
 * suite at a real node would make every assertion depend on whatever the mempool happened to hold,
 * and a regtest node is a container the test would have to own.
 *
 * The fixtures are therefore deterministic and hand-built, and the two properties that matter are:
 *
 *   - **The transaction ids are real hashes of real bytes**, so the merkle branch computed over them
 *     is a branch over a well-formed tree rather than over strings that happen to be 64 characters
 *     long.
 *   - **The block target is configurable**, because the single most important branch in
 *     `validate.ts` — this share is a BLOCK — is unreachable at mainnet difficulty and would
 *     otherwise be the one path the suite never took. `REGTEST_BITS` makes almost every hash a
 *     block, which is exactly what a regtest node does and for the same reason.
 *
 * Not a test file: no `.test.ts` suffix, so `node --test src/*.test.ts` does not run it.
 */

import { createHash } from 'node:crypto'
import { HttpError, type HttpClient, type RequestOptions } from '@cloudsforge/http'
import { NodeRpc } from './rpc.ts'
import type { PoolChainId } from './chains.ts'

/** A P2PKH `scriptPubKey`, the shape `validateaddress` returns for a legacy address. */
export const FAKE_PAYOUT_SCRIPT = `76a914${'11'.repeat(20)}88ac`

/**
 * Regtest's `powLimit`, and the reason it is here.
 *
 * `207fffff` decodes to a target just under 2^255, so roughly every second hash clears it. That is
 * what makes the block path testable at all: at mainnet's `1d00ffff` a test would have to find an
 * actual Bitcoin block. Litecoin, Bitcoin and every other fork use the same value for the same
 * purpose, so this is not an invention of this file.
 */
export const REGTEST_BITS = '207fffff'

/** Mainnet-era Bitcoin difficulty, for the case where a share must NOT be a block. */
export const MAINNET_BITS = '1d00ffff'

export interface FakeTemplateOptions {
  readonly height?: number
  readonly version?: number
  readonly previousBlockHashHex?: string
  readonly curTime?: number
  readonly minTime?: number
  readonly bitsHex?: string
  readonly coinbaseValue?: number
  /** How many non-coinbase transactions the template carries. Ids are derived, not random. */
  readonly transactionCount?: number
  readonly witnessCommitment?: string | null
  readonly longPollId?: string | null
}

/** A deterministic 32-byte hash, in DISPLAY order, derived from a label. */
export function fakeHashHex(label: string): string {
  return createHash('sha256').update(createHash('sha256').update(label).digest()).digest().toString('hex')
}

/**
 * A `getblocktemplate` reply as the node would serialise it — not a `BlockTemplate`.
 *
 * Deliberately the raw JSON shape, so that `parseTemplate` is on the path of every test that uses a
 * template. A fixture that skipped the parser would leave the estate's one boundary against a
 * malformed template untested by everything except the tests written for it directly.
 */
export function fakeTemplateReply(options: FakeTemplateOptions = {}): Record<string, unknown> {
  const count = options.transactionCount ?? 3
  const transactions = Array.from({ length: count }, (_unused, index) => {
    // `data` is hashed into `txid` so the two agree, which is what a node guarantees and what a
    // fixture with unrelated fields would not.
    const data = `0100000001${index.toString(16).padStart(8, '0')}${'00'.repeat(40)}`
    const bytes = Buffer.from(data, 'hex')
    const txid = createHash('sha256')
      .update(createHash('sha256').update(bytes).digest())
      .digest()
      .reverse()
      .toString('hex')
    return { data, txid, fee: 1000 + index, weight: 400 }
  })

  const curTime = options.curTime ?? 1_760_000_000
  const reply: Record<string, unknown> = {
    height: options.height ?? 800_000,
    version: options.version ?? 0x20000000,
    previousblockhash: options.previousBlockHashHex ?? fakeHashHex('tip'),
    curtime: curTime,
    mintime: options.minTime ?? curTime - 3600,
    bits: options.bitsHex ?? REGTEST_BITS,
    coinbasevalue: options.coinbaseValue ?? 312_500_000,
    transactions,
  }
  const witness = options.witnessCommitment === undefined ? `6a24aa21a9ed${'22'.repeat(32)}` : options.witnessCommitment
  if (witness !== null) reply['default_witness_commitment'] = witness
  if (options.longPollId !== null && options.longPollId !== undefined) reply['longpollid'] = options.longPollId
  return reply
}

export interface FakeNodeOptions {
  readonly chain?: PoolChainId
  readonly template?: Record<string, unknown>
  /** What `getblockchaininfo.chain` answers. `'main'` is what mainnet Core says. */
  readonly nodeChain?: string
  readonly addressValid?: boolean
  /** Methods that should raise a JSON-RPC error instead of answering, and the code to raise. */
  readonly faults?: Readonly<Record<string, { code: number; message: string }>>
}

export interface FakeNode {
  readonly rpc: NodeRpc
  /** Every method called, in order. Asserting on this is how longpoll usage is checked. */
  readonly calls: { method: string; params: readonly unknown[] }[]
  /** Replace the template the node will serve on the next `getblocktemplate`. */
  setTemplate(template: Record<string, unknown>): void
  /** What the last `submitblock` was handed, hex. Null until one arrives. */
  readonly submitted: () => string | null
  /** What `submitblock` answers. `null` is Core's way of saying the block was accepted. */
  setSubmitResult(result: string | null): void
}

/**
 * A `NodeRpc` wired to an in-memory node.
 *
 * Built through the real `NodeRpc` rather than as a stand-in object, so the JSON-RPC envelope, the
 * error unwrapping and the id counter are all on the path. The seam is `NodeRpcOptions.client`,
 * which exists for this.
 */
export function fakeNode(options: FakeNodeOptions = {}): FakeNode {
  const calls: { method: string; params: readonly unknown[] }[] = []
  let template = options.template ?? fakeTemplateReply()
  let submitted: string | null = null
  let submitResult: string | null = null

  const client: Pick<HttpClient, 'request'> = {
    async request<T>(_path: string, requestOptions?: RequestOptions): Promise<T> {
      const body = (requestOptions?.body ?? {}) as { method?: string; params?: unknown[] }
      const method = body.method ?? ''
      const params = body.params ?? []
      calls.push({ method, params })

      const fault = options.faults?.[method]
      if (fault) {
        // Core reports an application-level JSON-RPC error as a 500 with the error in the body.
        // Raising it that way keeps `jsonRpcErrorIn` on the path.
        throw new HttpError({
          status: 500,
          method: 'POST',
          url: 'http://node.invalid:8332/',
          body: JSON.stringify({ result: null, error: fault, id: 1 }),
        })
      }

      switch (method) {
        case 'getblocktemplate':
          return { result: template, error: null } as T
        case 'validateaddress':
          return {
            result:
              options.addressValid === false
                ? { isvalid: false }
                : { isvalid: true, scriptPubKey: FAKE_PAYOUT_SCRIPT },
            error: null,
          } as T
        case 'getblockchaininfo':
          return { result: { chain: options.nodeChain ?? 'main' }, error: null } as T
        case 'submitblock':
          submitted = typeof params[0] === 'string' ? params[0] : null
          return { result: submitResult, error: null } as T
        default:
          return { result: null, error: { code: -32601, message: `no such method ${method}` } } as T
      }
    },
  }

  const rpc = new NodeRpc({
    chain: options.chain ?? 'btc',
    // Userinfo on purpose: several tests assert that nothing ever echoes it.
    url: 'http://rpcuser:rpcpassword@node.invalid:8332/',
    client,
  })

  return {
    rpc,
    calls,
    setTemplate(next) {
      template = next
    },
    submitted: () => submitted,
    setSubmitResult(result) {
      submitResult = result
    },
  }
}
