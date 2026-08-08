/**
 * The merkle branch a miner needs, and the root it folds to.
 *
 * A Stratum pool never sends the transaction list. It sends the miner a *branch*: the log-n hashes
 * that, folded left-to-right against a coinbase transaction id, reconstruct the block's merkle
 * root. This is what makes the protocol work at all — the miner varies the extranonce inside the
 * coinbase, which changes the coinbase txid, which changes the root, which changes the header,
 * without the pool having to resend anything.
 *
 * ## Two properties of Bitcoin's merkle tree that are easy to get wrong
 *
 * **A level with an odd number of nodes duplicates its last node.** Not "promotes it unchanged", as
 * several other merkle constructions do. This is a well-known wart (it is the source of CVE-2012-2459)
 * and it is consensus, so it is reproduced here rather than corrected.
 *
 * **The branch is built with the coinbase's own slot left empty.** The coinbase is index 0 and its
 * id is not known when the branch is computed — that is the entire point — so the tree is walked
 * with a hole at position 0 and the branch records the sibling at each level. `merkleSteps` takes
 * the transaction ids *excluding* the coinbase for that reason, and a caller that passed the
 * coinbase in would get a branch that is silently one level wrong.
 *
 * All hashes here are in INTERNAL order. `getblocktemplate` reports txids in display order, so the
 * caller reverses them on the way in — `bytes.ts` names that conversion. Folding display-order
 * hashes produces a root that is uniformly wrong, and the symptom is that every share fails.
 */

import { sha256d } from './pow.ts'

/**
 * The merkle branch for a block whose coinbase is not yet known.
 *
 * `transactionIds` is every transaction in the template EXCEPT the coinbase, in template order, in
 * internal byte order. An empty list gives an empty branch, which is correct: a block containing
 * only its coinbase has the coinbase txid as its merkle root, and folding nothing leaves it alone.
 */
export function merkleSteps(transactionIds: readonly Buffer[]): Buffer[] {
  const steps: Buffer[] = []
  // Index 0 is the coinbase's hole. It is never read — every level takes its sibling from index 1
  // and then rebuilds from index 2 upwards — but it has to occupy the slot, or every node in the
  // tree sits one position to the left and the branch describes a different tree.
  let level: (Buffer | null)[] = [null, ...transactionIds]

  while (level.length > 1) {
    steps.push(level[1] as Buffer)
    // Duplicate the last node on an odd level. `level.length` counts the coinbase hole, so the
    // parity being tested is the real one.
    if (level.length % 2 === 1) level.push(level[level.length - 1] as Buffer)

    const next: (Buffer | null)[] = [null]
    for (let i = 2; i < level.length; i += 2) {
      next.push(sha256d(Buffer.concat([level[i] as Buffer, level[i + 1] as Buffer])))
    }
    level = next
  }
  return steps
}

/**
 * Fold a coinbase transaction id through a branch to the merkle root.
 *
 * This is the operation the miner performs, reproduced here so the pool validates a share against
 * the root the miner actually hashed rather than against one it recomputed a different way. Doing
 * it any other way would let the pool and the miner disagree about a block they both did the work
 * for.
 */
export function merkleRootFromBranch(coinbaseTxId: Buffer, steps: readonly Buffer[]): Buffer {
  let root = coinbaseTxId
  for (const step of steps) {
    root = sha256d(Buffer.concat([root, step]))
  }
  return root
}

/**
 * The merkle root of a complete transaction list, coinbase first.
 *
 * Not used to build jobs — the branch is, because the coinbase is not known then. It exists so the
 * suite can check the branch against an independently computed root, which is the only test of
 * `merkleSteps` that is not just a restatement of it. `merkle.test.ts` runs the two against each
 * other for every list length from 1 to 24, which is where the odd-level duplication either holds
 * or does not.
 */
export function merkleRootOf(transactionIds: readonly Buffer[]): Buffer {
  if (transactionIds.length === 0) throw new RangeError('a block has at least a coinbase')
  let level = [...transactionIds]
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(level[level.length - 1] as Buffer)
    const next: Buffer[] = []
    for (let i = 0; i < level.length; i += 2) {
      next.push(sha256d(Buffer.concat([level[i] as Buffer, level[i + 1] as Buffer])))
    }
    level = next
  }
  return level[0] as Buffer
}
