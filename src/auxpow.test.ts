/**
 * The acceptance gate for merged mining.
 *
 * Nothing this repository already tests turns from red to green when AuxPoW lands, because Dogecoin
 * stays refused as a primary chain and the Litecoin path is unchanged when no aux chain is
 * configured. So the proof that this works has to be built rather than observed, and it is built the
 * only way a consensus rule can be tested without the consensus: by writing the verifier out too,
 * from Dogecoin's own source, and running our builder against it.
 *
 * `checkAuxPow` below is a line-by-line transcription of `CAuxPow::check` in `src/auxpow.cpp` of
 * Dogecoin 1.14.9 — the version the estate runs — with the C++ left in comments beside each step. It
 * is deliberately NOT written in the style of this repository: it keeps the original's names, its
 * order, and its early returns, so that a reader can diff the two rather than trust that they agree.
 * A verifier rewritten to be idiomatic is a verifier that has been reasoned about, and the entire
 * value of this one is that it has not been.
 *
 * The fixed vectors matter as much as the round trip. A round trip proves the builder and the
 * transcription agree with each other; it does not prove either agrees with Dogecoin. The byte-exact
 * assertions are what pin the one decision that a round trip cannot catch, because it is symmetric:
 * whether the 32 bytes of the aux hash go into the coinbase in display order or internal order.
 * Reverse both sides and every round trip still passes.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  AUX_COMMITMENT_BYTES,
  MERGED_MINING_MAGIC,
  auxCommitment,
  commitmentOffset,
  hasSingleCommitment,
  magicOccurrences,
  serialiseAuxPow,
} from './auxpow.ts'
import { assembleCoinbase, buildCoinbase, buildHeader, coinbaseTxId } from './coinbase.ts'
import { merkleRootFromBranch, merkleSteps } from './merkle.ts'
import { sha256d } from './pow.ts'

/** A Dogecoin block hash as `createauxblock` reports it: display order, most significant byte first. */
const AUX_HASH_HEX = '00000000000000c1a5f0e6d47b2a9c3e8f0d1b4a6c7e9f2038475869aabbccdd'

/**
 * `CAuxPow::check`, transcribed. The C++ it came from is quoted against each step.
 *
 * Returns the error string Dogecoin would have logged, or null on success — `error(...)` in Core
 * returns false and logs, and collapsing that to a boolean here would make every failure look the
 * same, which is precisely the diagnostic this file exists to provide.
 */
function checkAuxPow(auxpow: Buffer, hashAuxBlockHex: string): string | null {
  const view = readAuxPow(auxpow)

  // if (nIndex != 0) return error("AuxPow is not a generate");
  if (view.nIndex !== 0) return 'AuxPow is not a generate'

  // params.fStrictChainId is false for the PARENT chain on Dogecoin mainnet, so the chain-ID
  // comparison against the parent is not reachable and is not transcribed. It is named here rather
  // than silently skipped: were it ever enabled, a Litecoin parent would still pass, because
  // Litecoin block versions do not encode Dogecoin's chain ID.

  // if (vChainMerkleBranch.size() > 30) return error("Aux POW chain merkle branch too long");
  if (view.vChainMerkleBranch.length > 30) return 'Aux POW chain merkle branch too long'

  // const uint256 nRootHash = CheckMerkleBranch(hashAuxBlock, vChainMerkleBranch, nChainIndex);
  // std::vector<unsigned char> vchRootHash(nRootHash.begin(), nRootHash.end());
  // std::reverse(vchRootHash.begin(), vchRootHash.end()); // correct endian
  //
  // `hashAuxBlock` is a uint256, whose bytes are internal order; the hex a caller holds is display
  // order, so it is reversed on the way in and reversed again here. The two cancel, and the
  // cancellation is written out rather than shortened because it is the whole subject of this file.
  const hashAuxBlock = Buffer.from(hashAuxBlockHex, 'hex').reverse()
  const nRootHash = checkMerkleBranch(hashAuxBlock, view.vChainMerkleBranch, view.nChainIndex)
  const vchRootHash = Buffer.from(nRootHash).reverse()

  // if (CheckMerkleBranch(GetHash(), vMerkleBranch, nIndex) != parentBlock.hashMerkleRoot)
  //     return error("Aux POW merkle root incorrect");
  const computedRoot = checkMerkleBranch(sha256d(view.tx), view.vMerkleBranch, view.nIndex)
  if (!computedRoot.equals(view.parentHashMerkleRoot)) return 'Aux POW merkle root incorrect'

  // if (tx->vin.empty()) return error("Aux POW coinbase has no inputs");
  // const CScript script = tx->vin[0].scriptSig;
  const script = scriptSigOf(view.tx)
  if (script === null) return 'Aux POW coinbase has no inputs'

  // CScript::const_iterator pcHead = std::search(script.begin(), script.end(), magic);
  // CScript::const_iterator pc = std::search(script.begin(), script.end(), vchRootHash);
  const pcHead = script.indexOf(MERGED_MINING_MAGIC)
  const pc = script.indexOf(vchRootHash)

  // if (pc == script.end()) return error("Aux POW missing chain merkle root in parent coinbase");
  if (pc === -1) return 'Aux POW missing chain merkle root in parent coinbase'

  if (pcHead !== -1) {
    // if (script.end() != std::search(pcHead + 1, script.end(), magic))
    //     return error("Multiple merged mining headers in coinbase");
    if (script.indexOf(MERGED_MINING_MAGIC, pcHead + 1) !== -1) return 'Multiple merged mining headers in coinbase'
    // if (pcHead + sizeof(pchMergedMiningHeader) != pc)
    //     return error("Merged mining header is not just before chain merkle root");
    if (pcHead + MERGED_MINING_MAGIC.length !== pc) return 'Merged mining header is not just before chain merkle root'
  } else {
    // if (pc - script.begin() > 20)
    //     return error("Aux POW chain merkle root must start in the first 20 bytes ...");
    if (pc > 20) return 'Aux POW chain merkle root must start in the first 20 bytes of the parent coinbase'
  }

  // pc += vchRootHash.size();
  // if (script.end() - pc < 8) return error("Aux POW missing chain merkle tree size and nonce ...");
  const trailer = pc + vchRootHash.length
  if (script.length - trailer < 8) return 'Aux POW missing chain merkle tree size and nonce in parent coinbase'

  // memcpy(&nSize, &pc[0], 4); nSize = le32toh(nSize);
  // if (nSize != (1u << merkleHeight)) return error("Aux POW merkle branch size does not match ...");
  const nSize = script.readUInt32LE(trailer)
  const merkleHeight = view.vChainMerkleBranch.length
  if (nSize !== 1 << merkleHeight) return 'Aux POW merkle branch size does not match parent coinbase'

  // memcpy(&nNonce, &pc[4], 4); nNonce = le32toh(nNonce);
  // if (nChainIndex != getExpectedIndex(nNonce, nChainId, merkleHeight)) return error("... wrong index");
  const nNonce = script.readUInt32LE(trailer + 4)
  if (view.nChainIndex !== getExpectedIndex(nNonce, DOGECOIN_AUXPOW_CHAIN_ID, merkleHeight)) {
    return 'Aux POW wrong index'
  }

  return null
}

/** Dogecoin's `nAuxpowChainId`. Only ever reaches `getExpectedIndex`, which is 0 at height 0. */
const DOGECOIN_AUXPOW_CHAIN_ID = 0x0062

/**
 * `CAuxPow::getExpectedIndex`, transcribed.
 *
 * The C++ relies on uint32 wraparound; `Math.imul` is what reproduces that in JavaScript, where `*`
 * would go through a double and lose the low bits it is the entire point of keeping.
 */
function getExpectedIndex(nNonce: number, nChainId: number, h: number): number {
  let rand = nNonce >>> 0
  rand = (Math.imul(rand, 1103515245) + 12345) >>> 0
  rand = (rand + nChainId) >>> 0
  rand = (Math.imul(rand, 1103515245) + 12345) >>> 0
  return rand % (1 << h)
}

/** `CAuxPow::CheckMerkleBranch`, transcribed. */
function checkMerkleBranch(hash: Buffer, branch: readonly Buffer[], index: number): Buffer {
  if (index === -1) return Buffer.alloc(32, 0)
  let current = hash
  let nIndex = index
  for (const step of branch) {
    current = (nIndex & 1) !== 0 ? sha256d(Buffer.concat([step, current])) : sha256d(Buffer.concat([current, step]))
    nIndex >>= 1
  }
  return current
}

/**
 * The scriptSig of the first input of a non-witness serialised transaction.
 *
 * Enough of a parser to reach one field, and no more — the repository's rule that transactions are
 * opaque hex holds everywhere except the two places that must look inside one, and this is a test.
 */
function scriptSigOf(tx: Buffer): Buffer | null {
  let at = 4 // version
  const inputs = tx.readUInt8(at)
  at += 1
  if (inputs === 0) return null
  at += 32 + 4 // prevout hash, prevout index
  const length = tx.readUInt8(at)
  at += 1
  return tx.subarray(at, at + length)
}

/** The inverse of `serialiseAuxPow`, so the transcription reads the same bytes Dogecoin would. */
function readAuxPow(auxpow: Buffer): {
  tx: Buffer
  nIndex: number
  vMerkleBranch: Buffer[]
  vChainMerkleBranch: Buffer[]
  nChainIndex: number
  parentHashMerkleRoot: Buffer
} {
  // The parent header is the last 80 bytes; everything before it is read forwards. Anchoring on the
  // end rather than parsing the transaction's length means this reader does not have to be a second
  // transaction parser, which is the thing most likely to be wrong in it.
  const parentHeader = auxpow.subarray(auxpow.length - 80)
  const parentHashMerkleRoot = parentHeader.subarray(36, 68)

  // The transaction and the branch are both variable length, so the boundary between them can only
  // be found by walking the transaction. It is one input and a known output shape, so the walk is
  // short — and it is a test, where a second transaction parser costs nothing but this paragraph.
  let at = 4
  at += 1 // input count, always 1 here
  at += 32 + 4
  const scriptLength = auxpow.readUInt8(at)
  at += 1 + scriptLength + 4 // scriptSig, sequence
  const outputs = auxpow.readUInt8(at)
  at += 1
  for (let output = 0; output < outputs; output += 1) {
    at += 8
    const length = auxpow.readUInt8(at)
    at += 1 + length
  }
  at += 4 // locktime
  const tx = auxpow.subarray(0, at)

  at += 32 // hashBlock
  const branchCount = auxpow.readUInt8(at)
  at += 1
  const vMerkleBranch: Buffer[] = []
  for (let step = 0; step < branchCount; step += 1) {
    vMerkleBranch.push(auxpow.subarray(at, at + 32))
    at += 32
  }
  const nIndex = auxpow.readInt32LE(at)
  at += 4
  const chainBranchCount = auxpow.readUInt8(at)
  at += 1
  const vChainMerkleBranch: Buffer[] = []
  for (let step = 0; step < chainBranchCount; step += 1) {
    vChainMerkleBranch.push(auxpow.subarray(at, at + 32))
    at += 32
  }
  const nChainIndex = auxpow.readInt32LE(at)
  at += 4
  assert.equal(at, auxpow.length - 80, 'the auxpow reader did not land exactly on the parent header')

  return { tx, nIndex, vMerkleBranch, vChainMerkleBranch, nChainIndex, parentHashMerkleRoot }
}

/** A Litecoin job of the shape `work.ts` builds, with the aux commitment in it. */
function parentBlock(options: { auxHashHex?: string; extranonce2?: Buffer; tag?: Buffer } = {}) {
  const auxHashHex = options.auxHashHex ?? AUX_HASH_HEX
  const parts = buildCoinbase({
    height: 3_156_948,
    coinbaseValue: 625_000_000n,
    payoutScriptHex: '0014' + 'ab'.repeat(20),
    witnessCommitmentHex: null,
    tag: options.tag ?? Buffer.from('/cloudsforge/', 'utf8'),
    extranonce1Size: 4,
    extranonce2Size: 4,
    auxCommitment: auxCommitment(auxHashHex),
  })
  const coinbase = assembleCoinbase(parts, Buffer.from('deadbeef', 'hex'), options.extranonce2 ?? Buffer.from('00000001', 'hex'))

  // Two other transactions, so the merkle branch is not empty — a branch of length zero would let a
  // reversed fold pass by doing nothing, which is the defect this whole file is about.
  const others = [sha256d(Buffer.from('one')), sha256d(Buffer.from('two'))]
  const steps = merkleSteps(others)
  const merkleRoot = merkleRootFromBranch(coinbaseTxId(coinbase), steps)

  const header = buildHeader({
    version: Buffer.from('00000020', 'hex'),
    prevHash: sha256d(Buffer.from('prev')),
    merkleRoot,
    ntime: Buffer.from('401c6f68', 'hex'),
    nbits: Buffer.from('1a2b3c4d', 'hex'),
    nonce: Buffer.from('01020304', 'hex'),
  })

  return { auxHashHex, coinbase, header, steps }
}

test('the commitment is the exact 45 bytes Dogecoin searches for', () => {
  const commitment = auxCommitment(AUX_HASH_HEX)
  assert.equal(commitment.length, AUX_COMMITMENT_BYTES + 1, 'a push opcode and 44 bytes')
  assert.equal(
    commitment.toString('hex'),
    // 0x2c push, magic, the aux hash EXACTLY as the RPC gave it, tree size 1, nonce 0.
    '2c' + 'fabe6d6d' + AUX_HASH_HEX + '01000000' + '00000000',
  )
})

test('the aux hash goes in unreversed, which is the reverse of every other hash here', () => {
  // The assertion a round trip cannot make. `hashFromDisplay` is what the rest of this repository
  // applies to a hash that arrives from an RPC; applying it here would produce a commitment that is
  // internally consistent, passes every symmetric test, and is rejected by Dogecoin every time.
  const commitment = auxCommitment(AUX_HASH_HEX)
  const embedded = commitment.subarray(1 + MERGED_MINING_MAGIC.length, 1 + MERGED_MINING_MAGIC.length + 32)
  assert.equal(embedded.toString('hex'), AUX_HASH_HEX)
  assert.notEqual(embedded.toString('hex'), Buffer.from(AUX_HASH_HEX, 'hex').reverse().toString('hex'))
})

test('a proof this pool builds passes a transcription of CAuxPow::check', () => {
  const built = parentBlock()
  const auxpow = serialiseAuxPow({
    parentCoinbase: built.coinbase,
    parentHeader: built.header,
    merkleSteps: built.steps,
  })
  assert.equal(checkAuxPow(auxpow, built.auxHashHex), null)
})

test('the proof is refused when it names a different aux block', () => {
  const built = parentBlock()
  const auxpow = serialiseAuxPow({
    parentCoinbase: built.coinbase,
    parentHeader: built.header,
    merkleSteps: built.steps,
  })
  const other = '00000000000000ffeeddccbbaa998877665544332211000fedcba9876543210f'
  assert.equal(checkAuxPow(auxpow, other), 'Aux POW missing chain merkle root in parent coinbase')
})

test('the proof is refused when the merkle branch does not reach the header', () => {
  const built = parentBlock()
  const auxpow = serialiseAuxPow({
    parentCoinbase: built.coinbase,
    parentHeader: built.header,
    // One step short: the fold lands somewhere that is not the root in the header.
    merkleSteps: built.steps.slice(0, 1),
  })
  assert.equal(checkAuxPow(auxpow, built.auxHashHex), 'Aux POW merkle root incorrect')
})

test('an extranonce2 of fabe6d6d destroys the proof, so the pool has to see it coming', () => {
  // The grief vector. The Litecoin block is untouched and perfectly valid; the Dogecoin block that
  // the same header won is thrown away by consensus, and nothing on this side would say why.
  const built = parentBlock({ extranonce2: Buffer.from('fabe6d6d', 'hex') })
  const auxpow = serialiseAuxPow({
    parentCoinbase: built.coinbase,
    parentHeader: built.header,
    merkleSteps: built.steps,
  })
  assert.equal(checkAuxPow(auxpow, built.auxHashHex), 'Multiple merged mining headers in coinbase')

  // Which is exactly what `hasSingleCommitment` is for, and it is checked on the assembled coinbase
  // rather than on the parts, because the offending bytes are the miner's.
  const script = scriptSigOf(built.coinbase) as Buffer
  assert.equal(magicOccurrences(script), 2)
  assert.equal(hasSingleCommitment(script), false)
})

test('an ordinary share carries exactly one commitment', () => {
  const script = scriptSigOf(parentBlock().coinbase) as Buffer
  assert.equal(hasSingleCommitment(script), true)
  // Immediately after the BIP34 height push and its own push opcode, and before the extranonce —
  // which is the placement that makes the commitment a property of the JOB rather than of the
  // submission, and therefore something the pool can assert about before it hands the work out.
  assert.equal(commitmentOffset(script, AUX_HASH_HEX), 5)
})

test('the aux hash must be 32 bytes', () => {
  assert.throws(() => auxCommitment('abcd'), /expected 32/)
})
