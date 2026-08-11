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
import { HttpError, TimeoutError, type HttpClient, type RequestOptions } from '@cloudsforge/http'
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

/**
 * A real MWEB integrating transaction — the HogEx — captured from a real template.
 *
 * Litecoin Core 0.21.5.6, regtest, `getblocktemplate {"rules":["mweb","segwit"]}` at height 433 on
 * 2026-08-09, the block that `scripts/regtest-mweb.sh` reproduces. **Copied rather than
 * constructed**, and that is the whole value of it: a hand-built fixture would only prove that
 * `mweb.ts` can parse what this file writes, which is a tautology. These bytes are the ones a node
 * actually emitted, and `mweb.test.ts` walks them field by field against the layout documented in
 * `mweb.ts`.
 *
 * The trailing `00` before the locktime is the byte that decides: the MWEB field present and empty,
 * which is what a HogEx is and what an ordinary MWEB-carrying transaction is not.
 */
export const REGTEST_HOGEX_DATA =
  '02000000000801' +
  '40d34df5f273e1728b41fd409a020cc051a1c638c093cc2524b1e5535734d4d3' +
  '0000000000ffffffff' +
  '018860814a00000000225820' +
  '3e1b37197b099d1281e331eee87364b42db1bd48cd7d945cb9b062b6629730bd' +
  '0000000000'

/** The txid the same node reported for the transaction above. Display order, as the RPC gives it. */
export const REGTEST_HOGEX_TXID = '05595c73b5d753a2f7d6c06fb05898a60da3088f5260c2a7ecdd8ab90bf3f355'

/**
 * The top-level `mweb` field of the same template: the extension block, 167 bytes, no presence
 * marker. The marker is `MWEB_BLOCK_PRESENT` and belongs to the block serialiser.
 */
export const REGTEST_MWEB_BLOCK =
  '8231c3e3ef5c90522ea1cc6cb96f462a20358f0f546ef99c6365c5d03d772223' +
  '55860000000000000000000000000000000000000000000000000000000000000000' +
  'af2edc674154ff129d9e826727ada0828d3ba480924bbed84bf6dcae2e1f1db2' +
  '17e28fe8b75bd371070a27f71c6158a56a38b6f1eaf45ab09fbb9b2fde1ad540' +
  '00000000000000000000000000000000000000000000000000000000000000000200000000'

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
  /**
   * Shape this template the way a Litecoin node shapes one once MWEB has activated: the HogEx
   * appended as the LAST transaction, and the extension block in the top-level `mweb` field.
   *
   * Off by default, because most of this suite is about behaviour both chains share and a Bitcoin
   * template never has either field.
   */
  readonly mweb?: boolean
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

  // Last, because that is where Litecoin puts it and where consensus requires it. A fixture that put
  // it anywhere else would be testing a template no node produces.
  if (options.mweb === true) {
    transactions.push({ data: REGTEST_HOGEX_DATA, txid: REGTEST_HOGEX_TXID, fee: 0, weight: 376 })
  }

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
  if (options.mweb === true) reply['mweb'] = REGTEST_MWEB_BLOCK
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
  /**
   * Fail a `getblocktemplate` that carries a `longpollid`, while a plain one still answers.
   *
   * `'timeout'` is the production shape of micro-org#307, not a convenience: a node running
   * `blocksonly=1` has a permanently empty mempool, so the only thing that can end a longpoll is a
   * new block. Between blocks the longpoll never returns and the client's deadline is what fires —
   * while plain fetches against the same node answer instantly throughout.
   *
   * `'unreachable'` is the control. It is the same class of error to the caller — a
   * `NodeUnavailableError` off a longpoll — and it must NOT provoke the same response, because a
   * request that never reached the node stranded nothing there to wait for.
   */
  readonly longPollFails?: 'timeout' | 'unreachable'
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
        case 'getblocktemplate': {
          const request = (params[0] ?? {}) as { longpollid?: unknown }
          if (options.longPollFails !== undefined && typeof request.longpollid === 'string') {
            if (options.longPollFails === 'timeout') throw new TimeoutError('http://node.invalid:8332/', 1)
            // A body that holds no JSON-RPC error is what a proxy in front of a stopped node
            // returns, and it is what `rpc.ts` classifies as unavailability rather than refusal.
            throw new HttpError({
              status: 502,
              method: 'POST',
              url: 'http://node.invalid:8332/',
              body: '<html>bad gateway</html>',
            })
          }
          return { result: template, error: null } as T
        }
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
