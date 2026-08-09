/**
 * Merged mining: the 44 bytes that go in a Litecoin coinbase, and the proof that is handed to
 * Dogecoin afterwards.
 *
 * A merge-mined chain does not have its own nonce. A Dogecoin block is won by finding a *Litecoin*
 * header whose scrypt hash meets Dogecoin's target, where that Litecoin block's coinbase contains a
 * commitment to the Dogecoin block being claimed. The commitment is what makes the work
 * non-transferable: the Litecoin header's merkle root covers the coinbase, the coinbase names one
 * specific Dogecoin block, so the same proof cannot be re-pointed at a different one afterwards.
 *
 * Everything in this file was transcribed from `src/auxpow.cpp` and `src/auxpow.h` of Dogecoin
 * 1.14.9 — the version the estate runs — read on 2026-08-09 at tag `v1.14.9`. It is transcription
 * and not interpretation, because every rule below is a consensus rule whose violation is a rejected
 * block and nothing else: no warning, no log line on our side, and exactly one opportunity to
 * observe it.
 *
 * ## The whole of it is `CAuxPow::check`, and with one aux chain most of it collapses
 *
 * The general scheme lets a miner commit to many aux chains at once through a merkle tree, and the
 * commitment names the tree's root rather than any one chain. This pool merges exactly one chain
 * into Litecoin, so that tree has height 0 — and at height 0 the machinery disappears:
 *
 *   - `CheckMerkleBranch(hashAuxBlock, {}, 0)` returns `hashAuxBlock` unchanged, so **the "chain
 *     merkle root" in the commitment IS the Dogecoin block hash**, with no hashing of any kind.
 *   - `vChainMerkleBranch` is empty and `nChainIndex` is 0.
 *   - `nSize` must equal `1u << merkleHeight`, so the tree size field is 1.
 *   - `getExpectedIndex(nonce, chainId, 0)` ends in `rand % (1 << 0)`, which is `rand % 1`, which is
 *     0 for every nonce. **The nonce is not searched and does not matter**; it is written as zero.
 *     Implementations that grind it are satisfying a constraint that only exists above height 0.
 *
 * What does not collapse is the byte order and the placement, and both are silent when wrong.
 *
 * ## The 32 bytes are in DISPLAY order, which is the reverse of everything else here
 *
 * `CAuxPow::check` builds the bytes it searches the coinbase for like this:
 *
 *     const uint256 nRootHash = CheckMerkleBranch(hashAuxBlock, vChainMerkleBranch, nChainIndex);
 *     std::vector<unsigned char> vchRootHash(nRootHash.begin(), nRootHash.end());
 *     std::reverse(vchRootHash.begin(), vchRootHash.end()); // correct endian
 *
 * A `uint256` iterates in internal (little-endian) order, so the reverse is display order — the
 * order an explorer prints and the order `createauxblock` returns its `hash` field in. So the bytes
 * that go into the scriptSig are `Buffer.from(auxHashHex, 'hex')` **exactly as the RPC gave them**,
 * with no `hashFromDisplay` and no `.reverse()`. That is the opposite of the rule every other 32
 * bytes in this repository follows, which is why it is written out here and asserted against a
 * fixed vector in `auxpow.test.ts` rather than left to a reader's judgement at the call site.
 *
 * ## The magic must appear exactly once in the whole scriptSig
 *
 * `check` searches for `pchMergedMiningHeader` from the start, then searches again from one byte
 * past what it found; a second occurrence anywhere is `Multiple merged mining headers in coinbase`
 * and the block is refused. The scriptSig also carries the miner's extranonce, which this pool does
 * not choose — so a miner submitting the four bytes `fa be 6d 6d` as its extranonce2, or straddling
 * that pattern across the extranonce boundary, would produce a Litecoin block that is perfectly
 * valid and a Dogecoin block that consensus throws away. `hasSingleCommitment` and
 * `magicOccurrences` are the checks for it.
 *
 * **The share is still accepted for Litecoin.** This paragraph said the opposite until the
 * arithmetic was done, and the old reasoning — "a miner that sends it deliberately is spending
 * nothing to destroy the most valuable submission the pool can receive" — is recorded here because
 * it is half right and the half it is wrong about is the half that decides. An adversary sending the
 * pattern deliberately loses nothing whether the share is rejected or merely disqualified from the
 * merged half, so refusing it deters nobody. What refusing it does cost is an HONEST miner's credit
 * for real Litecoin work: a rig steps through only a few dozen extranonce2 values per ten-second
 * job, so at 2^-32 per value a pool of a thousand of them trips it roughly once every couple of
 * years — rare, but not never, and the miner whose share is thrown away did nothing wrong. So
 * `validate.ts` reports it as `AuxShareOutcome.spoiled`: the parent share stands, the merged half is
 * lost, and the event is loud enough for an operator to see it happen.
 */

import { hashToDisplay } from './bytes.ts'
import { sha256d } from './pow.ts'

/**
 * `pchMergedMiningHeader` — `{ 0xfa, 0xbe, 'm', 'm' }`, i.e. `fa be 6d 6d`.
 *
 * Spelled with the two ASCII bytes as their hex rather than as `'mm'` so that this constant can be
 * compared to a hex dump of a real coinbase without a step in between.
 */
export const MERGED_MINING_MAGIC = Buffer.from([0xfa, 0xbe, 0x6d, 0x6d])

/**
 * The number of aux chains this pool commits to, and therefore the merkle tree size in the
 * commitment.
 *
 * One, and `check` requires the field to be `1u << vChainMerkleBranch.size()`. Committing to a
 * second chain later is not a matter of changing this number: it means building the chain merkle
 * tree, choosing each chain's slot through `getExpectedIndex`, and carrying a real
 * `vChainMerkleBranch` — so the constant is named rather than inlined precisely so that a reader
 * changing it finds this paragraph.
 */
export const AUX_CHAIN_MERKLE_SIZE = 1

/** Total bytes of the commitment: magic, root, tree size, nonce. */
export const AUX_COMMITMENT_BYTES = MERGED_MINING_MAGIC.length + 32 + 4 + 4

/**
 * The commitment, as it sits inside the coinbase scriptSig, behind its own push opcode.
 *
 * The push is not required by `check` — the coinbase scriptSig is never executed, and Dogecoin's own
 * `initAuxPow` writes a bare push of a 40-byte blob with no magic at all, relying on a backward
 * compatibility path that only applies within the first 20 bytes of the script. It is pushed here
 * anyway, for two reasons that are not consensus: the scriptSig stays a well-formed script for the
 * benefit of explorers and `btcdeb`-shaped tooling, and the length byte in front makes the 44 bytes
 * legible in a hex dump instead of running into whatever precedes them.
 *
 * @param auxHashHex the `hash` field of `createauxblock`, display order, as the RPC returned it.
 */
export function auxCommitment(auxHashHex: string): Buffer {
  const root = Buffer.from(auxHashHex, 'hex')
  if (root.length !== 32) {
    throw new RangeError(`the aux block hash is ${root.length} bytes of hex, expected 32`)
  }
  const trailer = Buffer.alloc(8)
  trailer.writeUInt32LE(AUX_CHAIN_MERKLE_SIZE, 0)
  // The nonce. Zero, and not searched: at merkle height 0 `getExpectedIndex` returns 0 whatever it
  // is, because the computation ends in `% (1 << 0)`. See the header.
  trailer.writeUInt32LE(0, 4)
  const commitment = Buffer.concat([MERGED_MINING_MAGIC, root, trailer])
  if (commitment.length !== AUX_COMMITMENT_BYTES) {
    throw new RangeError(`the commitment is ${commitment.length} bytes, expected ${AUX_COMMITMENT_BYTES}`)
  }
  // `pushData` is not reused here on purpose: it lives in `bytes.ts` behind a 75-byte ceiling meant
  // for the pushes a coinbase makes, and this is a fixed 44 that must never silently become a
  // two-byte OP_PUSHDATA1 — the offsets `check` computes are relative to bytes, not to opcodes.
  return Buffer.concat([Buffer.from([AUX_COMMITMENT_BYTES]), commitment])
}

/**
 * Does this scriptSig carry exactly one merged-mining commitment?
 *
 * False when it carries none and false when it carries two, because both are the same outcome for
 * the block — `check` refuses it — and a caller has nothing different to do about them. The reason
 * they differ is worth a log line, which is why `magicOccurrences` is exported beside it.
 */
export function hasSingleCommitment(scriptSig: Buffer): boolean {
  return magicOccurrences(scriptSig) === 1
}

/** How many times `fa be 6d 6d` occurs in these bytes, overlapping occurrences included. */
export function magicOccurrences(scriptSig: Buffer): number {
  let count = 0
  // Advances by one rather than by four, matching `std::search(pcHead + 1, ...)`: two overlapping
  // occurrences are two occurrences to Dogecoin, and a scan that stepped over the match would miss
  // exactly the case an adversary would construct.
  for (let at = scriptSig.indexOf(MERGED_MINING_MAGIC); at !== -1; at = scriptSig.indexOf(MERGED_MINING_MAGIC, at + 1)) {
    count += 1
  }
  return count
}

/**
 * Where the aux root sits in an assembled coinbase, or -1.
 *
 * Used by the self-test in `auxpow.test.ts` and by the pre-submission assertion in `blocks.ts`,
 * which re-derives the offset from the bytes actually being submitted rather than from the bytes
 * that were meant to be built. The two are the same number every time except on the one occasion
 * that matters.
 */
export function commitmentOffset(scriptSig: Buffer, auxHashHex: string): number {
  const at = scriptSig.indexOf(MERGED_MINING_MAGIC)
  if (at === -1) return -1
  const root = Buffer.from(auxHashHex, 'hex')
  const found = scriptSig.subarray(at + MERGED_MINING_MAGIC.length, at + MERGED_MINING_MAGIC.length + 32)
  return found.equals(root) ? at : -1
}

/** A vector of 32-byte hashes, as Bitcoin's serialiser writes one: a compact size, then the bytes. */
function hashVector(hashes: readonly Buffer[]): Buffer {
  if (hashes.length > 0xfc) throw new RangeError(`a ${hashes.length}-element hash vector needs a wider compact size`)
  return Buffer.concat([Buffer.from([hashes.length]), ...hashes])
}

/** A signed 32-bit integer, little-endian, as `READWRITE(int)` writes one. */
function int32LE(value: number): Buffer {
  const buffer = Buffer.alloc(4)
  buffer.writeInt32LE(value, 0)
  return buffer
}

export interface AuxPowProof {
  /**
   * The parent coinbase, non-witness serialised — exactly the bytes `assembleCoinbase` produced and
   * exactly the bytes the miner hashed.
   *
   * Non-witness on purpose. `CMerkleTx::GetHash()` is `tx->GetHash()`, which is the txid, which is
   * by definition the witness-stripped hash; and a coinbase whose input count is 1 deserialises
   * unambiguously as a legacy transaction on Dogecoin 1.14.9, which never asks for witness data
   * here (`fMineWitnessTx` is hard-coded false in its own block assembler). Sending the witness form
   * would be sending bytes whose only effect is to be stripped again.
   */
  readonly parentCoinbase: Buffer
  /** The 80-byte Litecoin header whose scrypt hash met Dogecoin's target. */
  readonly parentHeader: Buffer
  /** The branch linking the coinbase to `parentHeader`'s merkle root. Internal order. */
  readonly merkleSteps: readonly Buffer[]
}

/**
 * The serialised `CAuxPow`, as `submitauxblock`'s second argument.
 *
 * The field order is `CAuxPow::SerializationOp` composed with the `CMerkleTx` it derives from, and
 * the composition is the part that is easy to get wrong from a description — `hashBlock` sits
 * between the transaction and the branch, and is the field most write-ups of merged mining omit:
 *
 *     CMerkleTx:  tx, hashBlock, vMerkleBranch, nIndex
 *     CAuxPow:    <the above>, vChainMerkleBranch, nChainIndex, parentBlock
 *
 * `hashBlock` is not checked by `CAuxPow::check` at all — nothing reads it on the verifying side —
 * but it is a field of the wire format, so omitting it does not produce a proof that fails a check:
 * it produces a byte stream that deserialises with every subsequent field shifted 32 bytes, and
 * Dogecoin reports that as a malformed submission with no indication of which field was wrong. It is
 * filled with the parent block's own hash, which is what a `CMerkleTx` for a mined block would hold.
 *
 * `nIndex` is 0 and `check` requires it — `if (nIndex != 0) return error("AuxPow is not a generate")`
 * — because the coinbase is the first transaction of a block by definition.
 */
export function serialiseAuxPow(proof: AuxPowProof): Buffer {
  if (proof.parentHeader.length !== 80) {
    throw new RangeError(`the parent header is ${proof.parentHeader.length} bytes, expected 80`)
  }
  for (const step of proof.merkleSteps) {
    if (step.length !== 32) throw new RangeError(`a merkle step is ${step.length} bytes, expected 32`)
  }
  return Buffer.concat([
    proof.parentCoinbase,
    // The parent block's hash, internal order — which is what the field is, and what `sha256d` of a
    // header returns, so there is no conversion here and there must not be one.
    sha256d(proof.parentHeader),
    hashVector(proof.merkleSteps),
    int32LE(0), // nIndex: the coinbase is transaction 0.
    hashVector([]), // vChainMerkleBranch: empty at merkle height 0.
    int32LE(0), // nChainIndex: `getExpectedIndex` is 0 for every nonce at height 0.
    proof.parentHeader,
  ])
}

/** The parent block hash a log line should print, given the header that was submitted. */
export function parentBlockHashOf(parentHeader: Buffer): string {
  return hashToDisplay(sha256d(parentHeader))
}
