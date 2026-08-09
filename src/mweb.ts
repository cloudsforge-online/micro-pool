/**
 * MWEB: the two things a Litecoin block needs that a Bitcoin block does not, and how to recognise
 * them in bytes the node hands us.
 *
 * ## What MWEB is, from a pool's point of view
 *
 * MimbleWimble Extension Blocks activated on Litecoin mainnet at block 2,265,984 (LIP-0002/0003).
 * The confidential side of the chain lives in a separate structure — the *extension block* — that is
 * carried alongside the canonical transaction list rather than inside it, and it is bound to the
 * canonical block by one transaction: the **HogEx**, the "hogwarts express" integrating transaction.
 * The HogEx spends the previous block's HogEx output plus every peg-in in this block, and pays out
 * every peg-out plus the new MWEB coin supply to a single witness-version-8 output whose 32-byte
 * program is the hash of the extension block's header. That output is the commitment; the coinbase
 * has nothing to do with it.
 *
 * Two consequences fall out of that, and this file exists for both:
 *
 *   1. **The HogEx must be the last transaction in the block.** Not "is usually last" — Litecoin
 *      Core's block deserialiser reads the extension block off the wire *if and only if* the final
 *      transaction is a HogEx (`CBlock::SerializationOp`, mirrored in `test/functional/
 *      test_framework/messages.py`'s `CBlock.serialize`). A block whose HogEx sits anywhere else is
 *      not a block with a misordered transaction; it is a byte stream the node cannot parse.
 *   2. **The extension block is appended after the transaction vector**, preceded by a one-byte
 *      presence marker. `getblocktemplate`'s top-level `mweb` field is that structure WITHOUT the
 *      marker, so the marker is this repository's to write.
 *
 * ## Why the HogEx is detected by parsing rather than by position
 *
 * Because the whole point of the exercise is that being right by accident and being right on purpose
 * are indistinguishable until a block is rejected. Litecoin Core does put the HogEx last in
 * `getblocktemplate.transactions`, so code that simply preserved template order would have produced
 * a valid block today — and would have gone on doing so until the day it did not, with nothing in
 * the repository able to tell the difference. Reading the transaction and asserting what it is turns
 * a coincidence into a checked invariant, and it is what lets `template.ts` refuse a template it
 * cannot build a valid block from instead of mining one the network will throw away.
 *
 * ## How a HogEx is recognised
 *
 * Litecoin extends the segwit serialisation rather than replacing it. A transaction with either
 * witness or MWEB data is written as `version | 0x00 | flags | vin | vout | [witness] | [mweb] |
 * locktime`, where `flags & 1` means a witness stack follows the outputs and `flags & 8` means an
 * MWEB field follows that. The MWEB field is itself one presence byte: `0x01` introduces a
 * MimbleWimble transaction hanging off an ordinary Litecoin transaction, and **`0x00` — the field
 * present but empty — is what marks the HogEx**. That is the whole test, and it is why this file has
 * to walk the inputs, outputs and witness to reach the byte that decides.
 *
 * Measured against Litecoin Core 0.21.5.6 on regtest, 2026-08-09. A real HogEx from a real template,
 * with the fields split out:
 *
 *     02000000                                                              version 2
 *     00 08                                                                 marker, flags = MWEB
 *     01 40d34d…d4d3 00000000 00 ffffffff                                   one input, no scriptSig
 *     01 8860814a00000000 22 5820 3e1b37…30bd                               one output, OP_8 <32>
 *     00                                                                    MWEB field, empty → HogEx
 *     00000000                                                              locktime
 *
 * The `5820` in that output is the commitment described above: witness version 8, 32-byte program,
 * the extension block header's hash. Nothing in this repository computes it — the node does, and it
 * arrives inside the transaction data we pass through untouched.
 */

import { readVarInt } from './bytes.ts'

/**
 * The byte that precedes the extension block in a serialised Litecoin block.
 *
 * `0x01` for present, `0x00` for absent, and Core writes one or the other only when the last
 * transaction is a HogEx. `getblocktemplate` does not include it in the `mweb` field — the field is
 * the extension block alone — so a caller that concatenated the template's hex straight onto the
 * transaction vector would produce a block whose extension block is short by its first byte, and the
 * node would reject it as unparseable. Both halves of that sentence were checked against a real
 * regtest block on 2026-08-09: the node-mined block's tail is `01` followed by exactly the 167 bytes
 * the template's `mweb` field held.
 */
export const MWEB_BLOCK_PRESENT = 0x01

/** `flags & 1`: a witness stack follows the outputs. Segwit, unchanged by Litecoin. */
const FLAG_WITNESS = 1
/** `flags & 8`: an MWEB field follows the witness. Litecoin's addition to the serialisation. */
const FLAG_MWEB = 8

/**
 * Is this serialised transaction Litecoin's MWEB integrating transaction?
 *
 * False for anything that is not — a Bitcoin transaction, a Litecoin transaction with no MWEB data,
 * and a Litecoin transaction that carries a MimbleWimble transaction of its own (`flags & 8` with a
 * present marker) are all ordinary transactions that go in the block in template order.
 *
 * **Malformed input throws rather than answering false.** These bytes came from
 * `getblocktemplate.transactions[].data` and are going into a block unchanged; a transaction this
 * cannot walk is one the pool does not understand well enough to submit, and answering "not a HogEx"
 * would turn a parse failure into a silently misplaced extension block.
 */
export function isHogEx(transaction: Buffer): boolean {
  let offset = 4 // version

  const firstVector = readVarInt(transaction, offset)
  // A zero-length input vector is not a legal transaction, so Core reuses it as the segwit marker:
  // seeing it means the flags byte follows and the real vectors come after that. Seeing anything
  // else means this is the pre-segwit serialisation, which has no flags and therefore no MWEB field.
  if (firstVector.value !== 0) return false
  offset += firstVector.size

  if (offset >= transaction.length) throw new RangeError('a transaction ended where its flags byte should be')
  const flags = transaction.readUInt8(offset)
  offset += 1
  if ((flags & FLAG_MWEB) === 0) return false

  const inputs = readVarInt(transaction, offset)
  offset += inputs.size
  for (let i = 0; i < inputs.value; i += 1) {
    offset += 32 + 4 // prevout hash, prevout index
    const script = readVarInt(transaction, offset)
    offset += script.size + script.value + 4 // scriptSig, sequence
  }

  const outputs = readVarInt(transaction, offset)
  offset += outputs.size
  for (let i = 0; i < outputs.value; i += 1) {
    offset += 8 // value
    const script = readVarInt(transaction, offset)
    offset += script.size + script.value
  }

  if ((flags & FLAG_WITNESS) !== 0) {
    // One stack per input, each a vector of length-prefixed items. The count is the input count and
    // is not repeated on the wire, which is why the inputs had to be walked rather than skipped.
    for (let i = 0; i < inputs.value; i += 1) {
      const items = readVarInt(transaction, offset)
      offset += items.size
      for (let item = 0; item < items.value; item += 1) {
        const length = readVarInt(transaction, offset)
        offset += length.size + length.value
      }
    }
  }

  if (offset >= transaction.length) throw new RangeError('a transaction ended where its MWEB field should be')
  const mwebPresent = transaction.readUInt8(offset)
  // Present-and-empty is the HogEx. Present-and-populated is an ordinary transaction with a
  // MimbleWimble part, which is not this.
  return mwebPresent === 0
}

/**
 * Where the HogEx is in a template's transaction list, and a refusal if it is anywhere but the end.
 *
 * Returns `-1` when there is none, which is the ordinary case for Bitcoin and for Litecoin before
 * MWEB activated. Throws when there is more than one, or when the one there is is not last, because
 * neither of those can be turned into a block: Core's deserialiser only looks for an extension block
 * behind a final HogEx, and the pool cannot reorder the list to fix it — the template's
 * `default_witness_commitment` was computed over the witness merkle root of the transactions **in
 * the order the node gave them**, so moving one would silently invalidate a commitment this
 * repository deliberately does not recompute. Refusing the template is the only honest answer, and
 * it surfaces as a stale template and an unready chain rather than as a rejected block.
 */
export function hogExIndexOf(transactions: readonly Buffer[]): number {
  let found = -1
  for (let index = 0; index < transactions.length; index += 1) {
    if (!isHogEx(transactions[index] as Buffer)) continue
    if (found !== -1) {
      throw new Error(
        `the template carries two MWEB integrating transactions, at ${found} and ${index}. A block has ` +
          'exactly one, and it is the last transaction.',
      )
    }
    found = index
  }
  if (found !== -1 && found !== transactions.length - 1) {
    throw new Error(
      `the template puts the MWEB integrating transaction at ${found} of ${transactions.length}, not last. ` +
        'Litecoin reads the extension block off the wire only when the final transaction is the ' +
        'integrating one, so a block built from this template would not deserialise. Reordering here ' +
        'is not a fix: the witness commitment the node supplied was computed over this order.',
    )
  }
  return found
}
