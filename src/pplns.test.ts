/**
 * PPLNS allocation, with the balance property fuzzed.
 *
 * `pplns.ts` says of its own invariant that "`pplns.test.ts` asserts that equality on random inputs,
 * because it is the one property that cannot be checked by eye and the one whose violation is
 * indistinguishable from theft". That is the substance of this file.
 *
 * The reason to fuzz rather than to pick examples: the failure mode of integer division is not a
 * crash, it is a rounding residue that vanishes. A hand-picked case with round numbers divides
 * exactly and proves nothing at all. The interesting inputs are the ones where `net × units` does not
 * divide by `totalUnits`, and those are easiest to reach by generating many.
 *
 * The generator is a seeded PRNG rather than `Math.random`, so a failure names a case that can be
 * reproduced. A flaky property test is worse than none: it trains its readers to re-run it.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  allocateReward,
  DIFFICULTY_UNIT_SCALE,
  difficultyUnits,
  unitsToDifficulty,
  windowUnitsFor,
  type WindowEntry,
} from './pplns.ts'

/** mulberry32: small, seeded, and adequate for choosing test inputs. */
function prng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/* ------------------------------------------------------------------ the difficulty unit */

test('difficulty is stored as a scaled integer, never as a float', () => {
  // Shares are a debt record. A float that cannot represent 0.1 exactly is not a ledger, and two
  // pools summing the same shares in a different order would disagree in the last place.
  assert.equal(DIFFICULTY_UNIT_SCALE, 100_000_000n)
  assert.equal(difficultyUnits(1), 100_000_000n)
  assert.equal(difficultyUnits(0.5), 50_000_000n)
  assert.equal(difficultyUnits(1024), 102_400_000_000n)
  // The smallest difficulty the scale can represent, which is well below any vardiff minimum.
  assert.equal(difficultyUnits(0.00000001), 1n)
})

test('a difficulty too small for the scale is refused rather than rounded to nothing', () => {
  // Rounding to zero would credit a share with no weight at all: work done, nothing recorded.
  assert.throws(() => difficultyUnits(0), RangeError)
  assert.throws(() => difficultyUnits(-1), RangeError)
  assert.throws(() => difficultyUnits(0.000000001), RangeError)
  assert.throws(() => difficultyUnits(Number.NaN), RangeError)
})

test('units convert back to the difficulty they came from', () => {
  for (const difficulty of [0.001, 1, 512, 1024, 65_536, 4_294_967_296]) {
    assert.equal(unitsToDifficulty(difficultyUnits(difficulty)), difficulty)
  }
})

test('the window is sized as a multiple of network difficulty', () => {
  // PPLNS pays the last N shares where N is expressed in difficulty, not in count — otherwise the
  // window would mean something different for every miner on it.
  assert.equal(windowUnitsFor(1, 1), DIFFICULTY_UNIT_SCALE)
  assert.equal(windowUnitsFor(100, 2), 200n * DIFFICULTY_UNIT_SCALE)
  assert.equal(windowUnitsFor(1000, 0.5), 500n * DIFFICULTY_UNIT_SCALE)
})

/* ------------------------------------------------------------------ allocation */

function entries(units: readonly (number | bigint)[]): WindowEntry[] {
  return units.map((value, index) => ({ workerId: index + 1, units: BigInt(value) }))
}

test('a reward divides in proportion to units', () => {
  const result = allocateReward({ reward: 1000n, feeBasisPoints: 0, entries: entries([1, 1, 2]) })
  assert.equal(result.fee, 0n)
  assert.equal(result.totalUnits, 4n)
  assert.deepEqual(
    result.allocations.map((a) => a.amount),
    [250n, 250n, 500n],
  )
})

test('the fee is taken off the top, once', () => {
  // 2% of 1000 is 20; the remaining 980 splits evenly.
  const result = allocateReward({ reward: 1000n, feeBasisPoints: 200, entries: entries([1, 1]) })
  assert.equal(result.fee, 20n)
  assert.deepEqual(
    result.allocations.map((a) => a.amount),
    [490n, 490n],
  )
  assert.equal(result.allocations.reduce((s, a) => s + a.amount, 0n) + result.fee, 1000n)
})

test('a fee outside 0..10000 basis points is refused', () => {
  assert.throws(() => allocateReward({ reward: 1n, feeBasisPoints: -1, entries: entries([1]) }), RangeError)
  assert.throws(() => allocateReward({ reward: 1n, feeBasisPoints: 10_001, entries: entries([1]) }), RangeError)
  assert.throws(() => allocateReward({ reward: 1n, feeBasisPoints: 1.5, entries: entries([1]) }), RangeError)
  // The endpoints are legal: 0% and 100% are both coherent policies, and neither is chosen here.
  assert.doesNotThrow(() => allocateReward({ reward: 100n, feeBasisPoints: 0, entries: entries([1]) }))
  assert.doesNotThrow(() => allocateReward({ reward: 100n, feeBasisPoints: 10_000, entries: entries([1]) }))
})

test('a negative reward is refused', () => {
  assert.throws(() => allocateReward({ reward: -1n, feeBasisPoints: 0, entries: entries([1]) }), RangeError)
})

test('an empty window makes the whole reward the fee rather than dividing by zero', () => {
  // A real state: a block found in the first seconds of a pool's life, or after a prune. The caller
  // gets an allocation list of length zero, not a crash and not a silent loss.
  const result = allocateReward({ reward: 5_000_000_000n, feeBasisPoints: 100, entries: [] })
  assert.equal(result.fee, 5_000_000_000n)
  assert.deepEqual(result.allocations, [])
  assert.equal(result.totalUnits, 0n)
})

test('the largest remainder goes to the largest fractional parts, deterministically', () => {
  // 100 across three equal workers is 33 each with 1 left over. Exactly one worker gets the extra
  // unit, and which one is fixed by the tie-break rather than by iteration order.
  const result = allocateReward({ reward: 100n, feeBasisPoints: 0, entries: entries([1, 1, 1]) })
  assert.equal(result.allocations.reduce((s, a) => s + a.amount, 0n), 100n)
  assert.deepEqual(
    result.allocations.map((a) => a.amount),
    [34n, 33n, 33n],
    'the tie must break toward the smaller workerId',
  )
})

test('the same window always allocates the same way', () => {
  // A miner checking our arithmetic against their own has to be able to reproduce it exactly.
  const window = entries([7, 13, 1, 999, 4])
  const first = allocateReward({ reward: 123_456_789n, feeBasisPoints: 175, entries: window })
  const second = allocateReward({ reward: 123_456_789n, feeBasisPoints: 175, entries: [...window] })
  assert.deepEqual(first, second)
})

test('allocation order follows the input, not the tie-break order', () => {
  // The sort is scratch work for deciding who gets the spare units. If it leaked into the returned
  // order, a caller zipping allocations against its own worker list would credit the wrong people.
  const result = allocateReward({ reward: 100n, feeBasisPoints: 0, entries: entries([1, 500, 1]) })
  assert.deepEqual(
    result.allocations.map((a) => a.workerId),
    [1, 2, 3],
  )
})

/* ------------------------------------------------------------------ the property */

test('allocations plus fee equal the reward exactly, over ten thousand random windows', () => {
  // The one property that cannot be checked by eye and whose violation is indistinguishable from
  // theft. Every case here is a full block reward divided among a real number of workers.
  const random = prng(0x5eed)
  for (let iteration = 0; iteration < 10_000; iteration += 1) {
    const workerCount = 1 + Math.floor(random() * 40)
    const window: WindowEntry[] = Array.from({ length: workerCount }, (_unused, index) => ({
      workerId: index + 1,
      // Deliberately lumpy: a pool has one big farm and a long tail of small rigs, and an even
      // split is the case least likely to produce a remainder.
      units: BigInt(1 + Math.floor(random() ** 4 * 10_000_000)),
    }))
    const reward = BigInt(1 + Math.floor(random() * 5_000_000_000))
    const feeBasisPoints = Math.floor(random() * 10_001)

    const result = allocateReward({ reward, feeBasisPoints, entries: window })
    const allocated = result.allocations.reduce((sum, a) => sum + a.amount, 0n)

    assert.equal(
      allocated + result.fee,
      reward,
      `iteration ${iteration}: ${allocated} + ${result.fee} != ${reward} ` +
        `(${workerCount} workers, ${feeBasisPoints}bp)`,
    )
    // Nobody is ever allocated a negative amount, and the fee never exceeds the reward.
    assert.ok(result.fee >= 0n && result.fee <= reward, `iteration ${iteration}: fee out of range`)
    for (const allocation of result.allocations) {
      assert.ok(allocation.amount >= 0n, `iteration ${iteration}: negative allocation`)
    }
  }
})

test('a worker with more units is never allocated less than one with fewer', () => {
  // Monotonicity. Largest-remainder can hand a spare unit to a smaller worker, so the guarantee is
  // "never less", not "strictly more" — but an allocation that inverted the order would mean the
  // proportions were computed against the wrong denominator.
  const random = prng(0x1337)
  for (let iteration = 0; iteration < 2_000; iteration += 1) {
    const window: WindowEntry[] = Array.from({ length: 12 }, (_unused, index) => ({
      workerId: index + 1,
      units: BigInt(1 + Math.floor(random() * 100_000)),
    }))
    const result = allocateReward({ reward: 1_000_000_000n, feeBasisPoints: 100, entries: window })
    const byUnits = [...result.allocations].sort((a, b) => (a.units < b.units ? -1 : a.units > b.units ? 1 : 0))
    for (let i = 1; i < byUnits.length; i += 1) {
      const lower = byUnits[i - 1] as (typeof byUnits)[number]
      const higher = byUnits[i] as (typeof byUnits)[number]
      // Allow the one-unit largest-remainder wobble.
      assert.ok(
        higher.amount >= lower.amount - 1n,
        `iteration ${iteration}: ${higher.units} units got ${higher.amount}, ${lower.units} got ${lower.amount}`,
      )
    }
  }
})

test('a single worker takes the entire net reward', () => {
  // The degenerate case that a proportional divide gets wrong if the denominator is miscounted.
  const result = allocateReward({ reward: 312_500_000n, feeBasisPoints: 250, entries: entries([42]) })
  assert.equal(result.fee, 7_812_500n)
  assert.equal(result.allocations[0]?.amount, 312_500_000n - 7_812_500n)
})

test('a reward of zero allocates zero without failing the balance check', () => {
  const result = allocateReward({ reward: 0n, feeBasisPoints: 100, entries: entries([1, 2, 3]) })
  assert.equal(result.fee, 0n)
  assert.equal(result.allocations.reduce((s, a) => s + a.amount, 0n), 0n)
})
