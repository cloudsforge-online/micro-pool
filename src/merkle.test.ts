/**
 * The merkle branch, checked against real blocks and against an independent root.
 *
 * `merkle.ts` says of its own two functions that "`merkle.test.ts` runs the two against each other
 * for every list length from 1 to 24, which is where the odd-level duplication either holds or does
 * not". That cross-check is the substance of this file, and it is worth being precise about why it
 * proves anything: `merkleSteps` walks the tree with a hole at index 0 and collects siblings, while
 * `merkleRootOf` folds a complete list with no hole at all. They are different algorithms over the
 * same tree. Agreement between them at every length is evidence; a test that rebuilt the branch the
 * way `merkleSteps` builds it would be evidence of nothing.
 *
 * The lengths matter because the odd-level duplication is a parity bug waiting to happen and it does
 * not fire at every size. A tree of 4 transactions never has an odd level; a tree of 6 has one at
 * the second level and not the first. Sweeping 1..24 covers every parity pattern that occurs below
 * five levels.
 *
 * Two real blocks anchor the sweep to consensus rather than to self-consistency, because two
 * functions can agree with each other and both be wrong about Bitcoin.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { hashFromDisplay, hashToDisplay } from './bytes.ts'
import { merkleRootFromBranch, merkleRootOf, merkleSteps } from './merkle.ts'
import { sha256d } from './pow.ts'

/** Deterministic, distinct, and not a hash of anything — the tree does not care what the leaves are. */
function leaf(index: number): Buffer {
  return sha256d(Buffer.from(`leaf/${index}`, 'utf8'))
}

/* --------------------------------------------------------- anchored to real blocks */

test('block 170 rebuilds its published merkle root', () => {
  // The first block with a non-coinbase transaction: Satoshi to Hal Finney. Two leaves, so exactly
  // one branch step and no duplication anywhere — the simplest case that is not degenerate.
  const coinbase = hashFromDisplay('b1fea52486ce0c62bb442b530a3f0132b826c74e473d1f2c220bfa78111c5082')
  const spend = hashFromDisplay('f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16')
  const expected = '7dac2c5666815c17a3b36427de37bb9d2e2c5ccec3f8633eb91a4205cb4c10ff'

  assert.equal(hashToDisplay(merkleRootOf([coinbase, spend])), expected)

  // And by the route the pool actually takes: a branch built without knowing the coinbase, folded
  // against the coinbase afterwards.
  const steps = merkleSteps([spend])
  assert.equal(steps.length, 1)
  assert.equal(hashToDisplay(steps[0] as Buffer), hashToDisplay(spend))
  assert.equal(hashToDisplay(merkleRootFromBranch(coinbase, steps)), expected)
})

test('a block whose only transaction is the coinbase has it as the root', () => {
  // The genesis block, and every empty block since. Folding nothing must leave the coinbase alone;
  // an implementation that hashed the lone leaf once more would produce a root nobody agrees with.
  const coinbase = hashFromDisplay('4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b')
  assert.deepEqual(merkleSteps([]), [])
  assert.equal(
    hashToDisplay(merkleRootFromBranch(coinbase, [])),
    '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b',
  )
  assert.equal(hashToDisplay(merkleRootOf([coinbase])), hashToDisplay(coinbase))
})

test('four transactions pair into two levels with no duplication', () => {
  // The case that distinguishes "pairs correctly" from "happens to work for two". The expected root
  // is folded by hand here — H(H(a||b) || H(c||d)) — rather than taken from a published block, so
  // the expectation is arithmetic this file performs itself and not a value recalled from memory.
  // Block 170 above is the anchor to real consensus; this one is the anchor to the shape of the
  // tree.
  const [a, b, c, d] = [leaf(0), leaf(1), leaf(2), leaf(3)]
  const expected = sha256d(
    Buffer.concat([sha256d(Buffer.concat([a, b])), sha256d(Buffer.concat([c, d]))]),
  )

  assert.equal(merkleRootOf([a, b, c, d]).toString('hex'), expected.toString('hex'))

  // And the branch route: the siblings a miner is handed for a 4-transaction block are `b` and
  // H(c||d), in that order.
  const steps = merkleSteps([b, c, d])
  assert.equal(steps.length, 2)
  assert.equal((steps[0] as Buffer).toString('hex'), b.toString('hex'))
  assert.equal((steps[1] as Buffer).toString('hex'), sha256d(Buffer.concat([c, d])).toString('hex'))
  assert.equal(merkleRootFromBranch(a, steps).toString('hex'), expected.toString('hex'))
})

/* --------------------------------------------------------- the sweep */

test('the branch folds to the same root as the full tree for every length from 1 to 24', () => {
  for (let count = 1; count <= 24; count += 1) {
    const all = Array.from({ length: count }, (_unused, index) => leaf(index))
    const coinbase = all[0] as Buffer
    const rest = all.slice(1)

    const viaBranch = merkleRootFromBranch(coinbase, merkleSteps(rest))
    const viaTree = merkleRootOf(all)
    assert.equal(
      viaBranch.toString('hex'),
      viaTree.toString('hex'),
      `branch and full tree disagree at ${count} transaction(s)`,
    )
  }
})

test('the branch has one step per level of the tree', () => {
  // ceil(log2(n)) steps, which is the property that makes the protocol cheap. Asserted separately
  // from correctness because a branch can fold to the right root while carrying a redundant step,
  // and that would be a `mining.notify` larger than it needs to be on every job.
  const expected = new Map([
    [1, 0],
    [2, 1],
    [3, 2],
    [4, 2],
    [5, 3],
    [8, 3],
    [9, 4],
    [16, 4],
    [17, 5],
    [24, 5],
  ])
  for (const [count, depth] of expected) {
    const rest = Array.from({ length: count - 1 }, (_unused, index) => leaf(index + 1))
    assert.equal(merkleSteps(rest).length, depth, `wrong branch length for ${count} transaction(s)`)
  }
})

test('an odd level duplicates its last node rather than promoting it', () => {
  // Stated directly against the construction, because this is consensus and the alternative is the
  // more natural thing to write. Three leaves: level 0 is [a,b,c] -> [ab, cc]; root is H(ab||cc).
  // If `c` were promoted unchanged the root would be H(ab||c), a different and wrong value.
  const a = leaf(1)
  const b = leaf(2)
  const c = leaf(3)
  const ab = sha256d(Buffer.concat([a, b]))
  const cc = sha256d(Buffer.concat([c, c]))
  assert.equal(merkleRootOf([a, b, c]).toString('hex'), sha256d(Buffer.concat([ab, cc])).toString('hex'))
  assert.notEqual(merkleRootOf([a, b, c]).toString('hex'), sha256d(Buffer.concat([ab, c])).toString('hex'))
})

test('the coinbase is excluded from the branch input', () => {
  // The mistake `merkle.ts` warns about, made deliberately: passing the coinbase in shifts every
  // node one slot and yields a branch that folds to a different root. It does not throw — nothing
  // can detect it — so the only defence is that this asserts the two are not the same.
  const all = Array.from({ length: 7 }, (_unused, index) => leaf(index))
  const correct = merkleRootFromBranch(all[0] as Buffer, merkleSteps(all.slice(1)))
  const wrong = merkleRootFromBranch(all[0] as Buffer, merkleSteps(all))
  assert.equal(correct.toString('hex'), merkleRootOf(all).toString('hex'))
  assert.notEqual(wrong.toString('hex'), correct.toString('hex'))
})

test('changing the coinbase changes the root through the same branch', () => {
  // The property the whole protocol rests on: the branch is fixed for a job and the miner moves the
  // root by moving the extranonce. If a branch fold ignored its input the pool would accept every
  // extranonce as producing the same block.
  const rest = Array.from({ length: 5 }, (_unused, index) => leaf(index + 1))
  const steps = merkleSteps(rest)
  const first = merkleRootFromBranch(leaf(100), steps)
  const second = merkleRootFromBranch(leaf(101), steps)
  assert.notEqual(first.toString('hex'), second.toString('hex'))
})

test('merkleRootOf refuses an empty block', () => {
  // Not reachable from a template — every block has a coinbase — but the alternative to throwing is
  // returning `undefined` as a Buffer and failing much later with no clue where it came from.
  assert.throws(() => merkleRootOf([]), RangeError)
})

test('the branch is order-sensitive', () => {
  // Bitcoin's tree is not a set commitment. Folding is left-to-right and the concatenation order is
  // root||step, never step||root.
  const rest = Array.from({ length: 4 }, (_unused, index) => leaf(index + 1))
  const steps = merkleSteps(rest)
  const coinbase = leaf(0)
  const forward = merkleRootFromBranch(coinbase, steps)
  const reversed = merkleRootFromBranch(coinbase, [...steps].reverse())
  assert.notEqual(forward.toString('hex'), reversed.toString('hex'))
  assert.equal(
    forward.toString('hex'),
    steps
      .reduce((acc, step) => sha256d(Buffer.concat([acc, step])), coinbase)
      .toString('hex'),
  )
})
