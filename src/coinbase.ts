/**
 * The coinbase transaction: the one transaction in a block the pool writes itself, split in two so
 * a miner can vary the middle.
 *
 * ## Why it is split, and where
 *
 * Stratum sends `coinb1` and `coinb2`. The miner concatenates `coinb1 || extranonce1 ||
 * extranonce2 || coinb2`, hashes it to get the coinbase txid, and folds that through the merkle
 * branch. `extranonce1` is the pool's — assigned per connection, so two miners never search the
 * same space — and `extranonce2` is the miner's own counter. Together they are the search space
 * that lets a miner keep working after it has exhausted all 2^32 values of the header nonce, which
 * modern hardware does in well under a second.
 *
 * So the split point is not arbitrary: it falls in the middle of the input's `scriptSig`, and the
 * two halves are opaque byte strings the miner never parses. What the pool must get right is that
 * the *length prefix* of that scriptSig — written into `coinb1`, before the miner's bytes exist —
 * already counts the extranonce bytes that will be inserted after it. A prefix that counts only
 * what `coinb1` contains produces a transaction that deserialises into garbage, and the failure is
 * invisible until a block is submitted and rejected.
 *
 * ## The payout script is asked of the node, never derived here
 *
 * `POOL_PAYOUT_ADDRESS_<CHAIN>` is turned into a `scriptPubKey` by calling `validateaddress` on the
 * node that will mine the block. This repository does not know Bitcoin's version bytes, Litecoin's
 * bech32 HRP, or anything else about address encoding, and **that is deliberate**.
 *
 * `contracts-chain`'s LTC comment records where address encoding lives in this estate — "custody
 * and settlement as a network parameter table (different version bytes, a different bech32 HRP and
 * a different WIF byte)" — and its DOGE comment names precisely the accident this avoids: a
 * consumer that derives Dogecoin's parameters by pattern-matching Litecoin's "will produce
 * addresses that no Dogecoin node will ever pay to". §6 of the multi-chain document lists the same
 * thing as a risk in its own right. A pool that mis-encodes its payout address does not fail on any
 * ordinary day; it fails by paying a block reward to an address nobody holds the key for, once,
 * irreversibly.
 *
 * The node is the authority on its own chain's addresses, it is already a dependency, and it
 * answers in one call. `indexer`'s Bitcoin worker takes the same position from the other direction:
 * it "never encodes an address, only reads the one `scriptPubKey.address` the node emits".
 */

import { int64LE, pushData, scriptNum, uint32LE, varInt } from './bytes.ts'
import { MWEB_BLOCK_PRESENT } from './mweb.ts'
import { sha256d } from './pow.ts'

/** The 32-byte witness reserved value. See `witnessSerialisedCoinbase`. */
export const WITNESS_RESERVED_VALUE = Buffer.alloc(32, 0)

export interface CoinbaseInput {
  /** The height this block will have. BIP34 requires it as the first push of the scriptSig. */
  readonly height: number
  /** The full reward — subsidy plus fees — in the chain's smallest unit, as the template states it. */
  readonly coinbaseValue: bigint
  /** The pool's payout `scriptPubKey`, hex, as `validateaddress` returned it. */
  readonly payoutScriptHex: string
  /**
   * `default_witness_commitment` from the template, hex, or null on a template that has none.
   *
   * Taken verbatim rather than computed. The node derived it from the witness merkle root of the
   * transaction set it just handed us, and the coinbase's own contribution to that root is fixed
   * at zero by definition — so the node's value is correct for any coinbase we build over the same
   * transaction list, provided the witness reserved value is 32 zero bytes, which is what
   * `WITNESS_RESERVED_VALUE` is. Recomputing it here would be a second implementation of a
   * consensus rule for no benefit and one more place to be wrong.
   */
  readonly witnessCommitmentHex: string | null
  /** Bytes identifying this pool in the coinbase. Conventional, and visible on every explorer. */
  readonly tag: Buffer
  readonly extranonce1Size: number
  readonly extranonce2Size: number
  /**
   * The merged-mining commitment from `auxpow.ts`, or absent when this pool merges no chain.
   *
   * ## Why it goes here, and why it goes BEFORE the extranonce
   *
   * `CAuxPow::check` requires the aux root to sit immediately after the four magic bytes, and the
   * magic to occur exactly once in the whole scriptSig. Both are properties of a byte range this
   * function owns — and only if the commitment is in `coinb1`, ahead of the miner's bytes. Putting
   * it in `coinb2` would work for consensus, but it would sit *after* the extranonce, and the pool
   * would no longer be able to say anything about the commitment's offset without first knowing
   * which miner submitted and what it chose. Here, the commitment is a fact about the job.
   *
   * It follows the BIP34 height push rather than preceding it, because the height push must be the
   * first item of the scriptSig and that is consensus on the Litecoin side. Merged mining does not
   * get to reorder it: `check`'s backward-compatibility branch — the one that allows a missing magic
   * when the root starts within 20 bytes — exists precisely because early implementations put the
   * commitment first, and it is not a licence to do so on a chain with BIP34 active.
   *
   * **A commitment makes the job disposable.** It names one Dogecoin block, and Dogecoin's
   * `mapNewBlock` is cleared the moment its own tip moves, after which that block hash answers
   * `block hash unknown` to `submitauxblock`. So a job built with a commitment is only as good as
   * the aux tip it was built against; `auxtemplate.ts` is what notices, and `work.ts` is what
   * rebuilds. Nothing about the Litecoin block changes, which is why the rebuild is `cleanJobs =
   * false`: the miner may finish what it is doing.
   */
  readonly auxCommitment?: Buffer | undefined
}

export interface CoinbaseParts {
  /** Everything up to and including the push opcode for the extranonce. */
  readonly coinb1: Buffer
  /** Everything after the extranonce bytes. */
  readonly coinb2: Buffer
  readonly extranonce1Size: number
  readonly extranonce2Size: number
}

const COINBASE_TX_VERSION = 1
const COINBASE_SEQUENCE = 0xffffffff
const COINBASE_LOCKTIME = 0
const PREVOUT_INDEX = 0xffffffff
const PREVOUT_HASH = Buffer.alloc(32, 0)

/**
 * Consensus caps a coinbase scriptSig at 100 bytes and requires at least 2. The height push and the
 * extranonce are fixed costs; the tag is what a configuration can make too long, so it is checked
 * here where the arithmetic is, and refused at boot rather than at the first block.
 */
const MAX_SCRIPT_SIG_BYTES = 100

export function buildCoinbase(input: CoinbaseInput): CoinbaseParts {
  const heightPush = pushData(scriptNum(input.height))
  const extranonceBytes = input.extranonce1Size + input.extranonce2Size
  if (extranonceBytes < 1 || extranonceBytes > 75) {
    throw new RangeError(`the extranonce is ${extranonceBytes} bytes; it must fit one script push`)
  }
  const tagPush = pushData(input.tag)
  const aux = input.auxCommitment ?? Buffer.alloc(0)

  // The prefix counts the bytes the miner will insert, which do not exist yet. This single number
  // is the reason coinb1 and coinb2 cannot be built independently of each other.
  const scriptSigLength = heightPush.length + aux.length + 1 + extranonceBytes + tagPush.length
  if (scriptSigLength < 2 || scriptSigLength > MAX_SCRIPT_SIG_BYTES) {
    throw new RangeError(
      `the coinbase scriptSig would be ${scriptSigLength} bytes; consensus allows 2 to ${MAX_SCRIPT_SIG_BYTES}. ` +
        (aux.length === 0
          ? 'The adjustable part is the pool tag.'
          : `The adjustable part is the pool tag; merged mining is taking ${aux.length} of the budget.`),
    )
  }

  const coinb1 = Buffer.concat([
    uint32LE(COINBASE_TX_VERSION),
    varInt(1),
    PREVOUT_HASH,
    uint32LE(PREVOUT_INDEX),
    varInt(scriptSigLength),
    heightPush,
    aux,
    // The push opcode for the extranonce. Its operand is the miner's bytes, which follow.
    Buffer.from([extranonceBytes]),
  ])

  const outputs: Buffer[] = [
    Buffer.concat([int64LE(input.coinbaseValue), varInt(payoutScript(input.payoutScriptHex).length), payoutScript(input.payoutScriptHex)]),
  ]
  if (input.witnessCommitmentHex !== null) {
    const commitment = Buffer.from(input.witnessCommitmentHex, 'hex')
    if (commitment.length === 0) throw new RangeError('the template supplied an empty witness commitment')
    // Last, and value zero. BIP141 reads the commitment from the highest-indexed output that
    // matches the pattern, so appending is the position that cannot be invalidated by adding
    // another output later.
    outputs.push(Buffer.concat([int64LE(0n), varInt(commitment.length), commitment]))
  }

  const coinb2 = Buffer.concat([
    tagPush,
    uint32LE(COINBASE_SEQUENCE),
    varInt(outputs.length),
    ...outputs,
    uint32LE(COINBASE_LOCKTIME),
  ])

  return { coinb1, coinb2, extranonce1Size: input.extranonce1Size, extranonce2Size: input.extranonce2Size }
}

function payoutScript(hex: string): Buffer {
  const script = Buffer.from(hex, 'hex')
  if (script.length === 0) throw new RangeError('the payout scriptPubKey is empty')
  return script
}

/**
 * The complete coinbase as the miner assembled it, and therefore as it must be hashed.
 *
 * The sizes are checked rather than assumed. A miner that sends an `extranonce2` of the wrong
 * length is not a protocol curiosity to be tolerated: the bytes would land inside the scriptSig at
 * the right offset but the length prefix would then be wrong, and the resulting transaction would
 * hash to something the miner never computed. Rejecting is the only answer that keeps the pool's
 * arithmetic and the miner's in agreement.
 */
export function assembleCoinbase(parts: CoinbaseParts, extranonce1: Buffer, extranonce2: Buffer): Buffer {
  if (extranonce1.length !== parts.extranonce1Size) {
    throw new RangeError(`extranonce1 is ${extranonce1.length} bytes, expected ${parts.extranonce1Size}`)
  }
  if (extranonce2.length !== parts.extranonce2Size) {
    throw new RangeError(`extranonce2 is ${extranonce2.length} bytes, expected ${parts.extranonce2Size}`)
  }
  return Buffer.concat([parts.coinb1, extranonce1, extranonce2, parts.coinb2])
}

/**
 * The coinbase transaction id, which is what goes into the merkle tree.
 *
 * **Computed over the non-witness serialisation, which is what `assembleCoinbase` produces.** A
 * txid is by definition the hash of a transaction stripped of its witness, and the coinbase this
 * pool builds carries no witness bytes at all in the form the miner hashes — the witness is added
 * only when the block is serialised for submission. The two forms therefore have the same txid,
 * which is what makes the split coinbase compatible with segwit at all.
 */
export function coinbaseTxId(coinbase: Buffer): Buffer {
  return sha256d(coinbase)
}

/**
 * The coinbase again, this time with the segwit marker, flag and witness stack, for `submitblock`.
 *
 * A block that carries a witness commitment output must have a coinbase with exactly one witness
 * stack item of 32 bytes. It is not optional and the node rejects the block without it. The value
 * is 32 zero bytes because that is what the node assumed when it computed
 * `default_witness_commitment` — the two are one decision, and changing this constant without
 * recomputing the commitment produces a block that fails validation on the commitment check.
 *
 * This works as a splice rather than a rebuild because the layout is known exactly: the version is
 * the first four bytes and the locktime is the last four, and everything between them is the input
 * and output vectors, unchanged between the two serialisations. Rebuilding from
 * `CoinbaseParts` instead would mean re-inserting the miner's extranonce and getting the same
 * bytes by a longer route — with the risk that the two routes disagree, which is exactly the class
 * of defect that makes a found block unspendable.
 */
export function witnessSerialisedCoinbase(coinbase: Buffer): Buffer {
  if (coinbase.length < 10) throw new RangeError('this is not a serialised transaction')
  const version = coinbase.subarray(0, 4)
  const body = coinbase.subarray(4, coinbase.length - 4)
  const locktime = coinbase.subarray(coinbase.length - 4)
  return Buffer.concat([
    version,
    Buffer.from([0x00, 0x01]), // marker, flag
    body,
    Buffer.from([0x01, 0x20]), // one stack item, 32 bytes
    WITNESS_RESERVED_VALUE,
    locktime,
  ])
}

/**
 * The 80-byte block header.
 *
 * Every argument is already in the order the header wants, because the conversions are named in
 * `bytes.ts` and done at the protocol boundary. This function does no reordering of its own on
 * purpose: a header builder that also reverses things is a header builder whose callers stop
 * knowing what order they hold.
 */
export function buildHeader(args: {
  readonly version: Buffer
  readonly prevHash: Buffer
  readonly merkleRoot: Buffer
  readonly ntime: Buffer
  readonly nbits: Buffer
  readonly nonce: Buffer
}): Buffer {
  for (const [name, value, size] of [
    ['version', args.version, 4],
    ['prevHash', args.prevHash, 32],
    ['merkleRoot', args.merkleRoot, 32],
    ['ntime', args.ntime, 4],
    ['nbits', args.nbits, 4],
    ['nonce', args.nonce, 4],
  ] as const) {
    if (value.length !== size) throw new RangeError(`header field ${name} is ${value.length} bytes, expected ${size}`)
  }
  return Buffer.concat([args.version, args.prevHash, args.merkleRoot, args.ntime, args.nbits, args.nonce])
}

/**
 * The complete block, ready for `submitblock`.
 *
 * The transactions arrive as the hex the template gave for each, and are passed through untouched —
 * they are already consensus-serialised, witnesses and all, and re-encoding them would be a third
 * implementation of transaction serialisation in a repository that needs none.
 *
 * ## The MWEB extension block, and the byte in front of it
 *
 * `mwebHex` is Litecoin's extension block, from the template's top-level `mweb` field, and it goes
 * after the transaction vector behind a one-byte presence marker that the template does NOT include.
 * A caller that concatenated the field on its own would be one byte short and the node would reject
 * the block as unparseable; a caller that omitted it on a block whose last transaction is the HogEx
 * would be short by the whole extension block. Both were checked against a node rather than
 * reasoned about — see `mweb.ts` — and this is the one place either can be written.
 *
 * It is `null` for Bitcoin always, and for Litecoin before MWEB activated. `template.ts` is what
 * guarantees the invariant this function relies on: `mwebHex` is non-null exactly when the last
 * transaction is the integrating one, which is exactly when Core looks for an extension block.
 */
export function serialiseBlock(args: {
  readonly header: Buffer
  readonly coinbase: Buffer
  readonly transactionsHex: readonly string[]
  readonly mwebHex?: string | null
}): Buffer {
  const mwebHex = args.mwebHex ?? null
  return Buffer.concat([
    args.header,
    varInt(args.transactionsHex.length + 1),
    args.coinbase,
    ...args.transactionsHex.map((hex) => Buffer.from(hex, 'hex')),
    ...(mwebHex === null ? [] : [Buffer.from([MWEB_BLOCK_PRESENT]), Buffer.from(mwebHex, 'hex')]),
  ])
}
