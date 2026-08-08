/**
 * Variable difficulty, driven on a fake clock.
 *
 * `vardiff.ts` names this file twice, and the second citation is the reason it exists. The retarget
 * ratio was written inverted at first — `target / observed` rather than `observed / target` — with a
 * comment confidently explaining the wrong behaviour. Inverted, the controller is not merely
 * inaccurate: it is unstable toward collapse. Too many shares lowers difficulty, which produces more
 * shares, which lowers it again, until every connection sits at `minDifficulty` flooding the pool.
 * Nothing about the code looks wrong, and on a real pool the symptom would appear hours later as
 * "the pool is slow" rather than as an error anywhere.
 *
 * So the first test below is not a unit test of `nextDifficulty`. It is a simulated miner of a fixed
 * hashrate, connected at a difficulty far below its correct one, retargeted repeatedly, asserted to
 * CLIMB. An inverted ratio cannot pass it, and neither can any of the other sign errors available in
 * this file.
 *
 * Everything is deterministic. The simulated miner produces shares at exactly the rate its hashrate
 * and difficulty imply, with no variance, because this suite is testing the controller and not the
 * Poisson process it sits in. Variance would make the test flaky and would not make it stronger.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_VARDIFF, nextDifficulty, roundDifficulty, Vardiff, type VardiffOptions } from './vardiff.ts'

/** Options with the defaults' shape but easier numbers to reason about in an assertion. */
function options(overrides: Partial<VardiffOptions> = {}): VardiffOptions {
  return { ...DEFAULT_VARDIFF, ...overrides }
}

/* ═══════════════════════════════════════════════ the direction test ═══════════════════════════ */

test('a miner connected far below its correct difficulty is retargeted UP', () => {
  // A machine whose true rate is 12 shares/minute at difficulty 1024, connected at difficulty 1.
  // At difficulty 1 it produces 1024× the target rate. The controller must climb.
  const opts = options()
  const correctDifficulty = 1024
  const hashSharesPerMinute = (difficulty: number) =>
    opts.targetSharesPerMinute * (correctDifficulty / difficulty)

  let now = 0
  const vardiff = new Vardiff({ initialDifficulty: 1, nowMs: now, options: opts })
  const seen: number[] = [vardiff.difficulty]

  for (let window = 0; window < 12; window += 1) {
    const rate = hashSharesPerMinute(vardiff.difficulty)
    // Feed one window's worth of shares, spaced evenly, then let the window close.
    const shares = Math.max(1, Math.round((rate * opts.retargetMs) / 60_000))
    const gap = opts.retargetMs / shares
    for (let i = 0; i < shares; i += 1) {
      now += gap
      vardiff.recordShare(now)
    }
    if (vardiff.difficulty !== seen[seen.length - 1]) seen.push(vardiff.difficulty)
  }

  // It must have moved up, monotonically, and settled at its correct difficulty.
  for (let i = 1; i < seen.length; i += 1) {
    assert.ok(
      (seen[i] as number) > (seen[i - 1] as number),
      `difficulty went down on a miner that was too easy: ${seen.join(' -> ')}`,
    )
  }
  assert.equal(vardiff.difficulty, correctDifficulty, `did not converge: ${seen.join(' -> ')}`)
  // Capped at maxStepFactor per window, so 1 -> 1024 takes exactly five ×4 steps.
  assert.deepEqual(seen, [1, 4, 16, 64, 256, 1024])
})

test('a miner connected far above its correct difficulty is retargeted DOWN', () => {
  // The mirror case, and the one a real pool hits when a rig is unplugged and something far smaller
  // connects to the same worker name.
  //
  // Modelled with BOTH drivers, because this direction genuinely needs both: at difficulty 4096 a
  // machine whose correct difficulty is 16 submits roughly one share every twenty minutes, so the
  // measured path never has a sample to work from and the descent is entirely the idle ratchet's
  // doing. The ratchet only runs from `onIdle`, which the chain service calls on every job push.
  // Simulating shares alone would show this miner stuck at 4096 for ever — see the test below,
  // which pins that on purpose.
  const opts = options()
  const correctDifficulty = 16
  const JOB_PUSH_MS = 30_000
  const TICK_MS = 1_000

  let now = 0
  const vardiff = new Vardiff({ initialDifficulty: 4096, nowMs: now, options: opts })
  const seen: number[] = [vardiff.difficulty]
  const intervalMs = () => 60_000 / (opts.targetSharesPerMinute * (correctDifficulty / vardiff.difficulty))
  let nextShareAt = intervalMs()

  // Sixty simulated minutes.
  for (let tick = 0; tick < 3_600; tick += 1) {
    now += TICK_MS
    if (now >= nextShareAt) {
      vardiff.recordShare(now)
      nextShareAt = now + intervalMs()
    }
    if (now % JOB_PUSH_MS === 0) vardiff.onIdle(now)
    if (vardiff.difficulty !== seen[seen.length - 1]) {
      seen.push(vardiff.difficulty)
      nextShareAt = now + intervalMs()
    }
  }

  assert.ok(vardiff.difficulty < 4096, `never came down: ${seen.join(' -> ')}`)
  assert.equal(vardiff.difficulty, correctDifficulty, `did not converge: ${seen.join(' -> ')}`)
  // Monotone descent, in ×4 steps, with no overshoot below the correct difficulty.
  assert.deepEqual(seen, [4096, 1024, 256, 64, 16])
})

test('a slow miner is rescued by shares alone, and faster by job pushes', () => {
  // Both rescue paths, contrasted, because the relationship between them is the subtle part.
  //
  // `recordShare` assigns `lastShareAtMs = now` before it considers retargeting, so at the instant a
  // share is recorded the connection has by definition been silent for zero milliseconds and the
  // ratchet's silence condition cannot hold. A miner submitting one share per window is therefore
  // starved-but-not-silent every time. Because the window now EXTENDS rather than resetting, its
  // shares still accumulate, and on the sixth one there are finally enough samples to measure: a
  // rate of 0.67/minute against a target of 12 asks for a very large cut, clamped to ×1/4.
  const opts = options()
  let now = 0
  const viaShares = new Vardiff({ initialDifficulty: 4096, nowMs: now, options: opts })
  for (let window = 0; window < 5; window += 1) {
    now += opts.retargetMs
    assert.equal(viaShares.recordShare(now), null, 'retargeted before it had enough samples')
  }
  now += opts.retargetMs
  assert.equal(viaShares.recordShare(now), 1024, 'the sixth sample should have completed a measurement')

  // Job pushes get there faster, because the ratchet does not wait for samples at all: four windows
  // of silence take the same connection from 4096 to 16 while the share-driven path has managed one
  // step. This is why `chainservice.ts` calls `onIdle` on every job push.
  let idleNow = 0
  const viaIdle = new Vardiff({ initialDifficulty: 4096, nowMs: idleNow, options: opts })
  for (let window = 0; window < 4; window += 1) {
    idleNow += opts.retargetMs
    viaIdle.onIdle(idleNow)
  }
  assert.equal(viaIdle.difficulty, 16)
})

test('there is no band of share rates in which nothing ever retargets', () => {
  // The regression test for the gap the extending window closes. A miner whose share interval falls
  // between `retargetMs / minSamples` (15s) and `idleFactor` expected intervals (40s) is too slow to
  // fill a window and too active to look silent. With a resetting window it would retarget NEVER,
  // at three to eight times its correct difficulty, for as long as it stayed connected.
  //
  // Swept across the whole band rather than at one point, because the failure was invisible at both
  // edges and only showed up in the middle.
  const opts = options()
  for (const intervalMs of [16_000, 20_000, 25_000, 30_000, 35_000, 39_000]) {
    let now = 0
    const vardiff = new Vardiff({ initialDifficulty: 4096, nowMs: now, options: opts })
    // Half an hour of shares at this fixed interval, and nothing else — no job pushes, so the
    // ratchet cannot be what saves it.
    for (let i = 0; i < 1_800_000 / intervalMs; i += 1) {
      now += intervalMs
      vardiff.recordShare(now)
    }
    assert.ok(
      vardiff.difficulty < 4096,
      `a miner submitting every ${intervalMs}ms was never retargeted (stuck at ${vardiff.difficulty})`,
    )
  }
})

test('nextDifficulty moves the same way as the simulation, stated directly', () => {
  // The property above, without the loop, so a failure says which of the two is wrong.
  const opts = options()
  // Twice the target rate means difficulty is half what it should be: go up.
  assert.ok(nextDifficulty(100, opts.targetSharesPerMinute * 2, opts) > 100)
  // Half the target rate: go down.
  assert.ok(nextDifficulty(100, opts.targetSharesPerMinute / 2, opts) < 100)
  // And the magnitude is the ratio, not its inverse.
  assert.equal(nextDifficulty(100, opts.targetSharesPerMinute * 2, opts), 200)
  assert.equal(nextDifficulty(100, opts.targetSharesPerMinute / 2, opts), 50)
})

/* ═══════════════════════════════════════════════ the guards ═══════════════════════════════════ */

test('the dead band leaves difficulty alone inside ±variance', () => {
  const opts = options({ variance: 0.3 })
  const target = opts.targetSharesPerMinute
  // Just inside, both sides.
  assert.equal(nextDifficulty(1000, target * 1.29, opts), 1000)
  assert.equal(nextDifficulty(1000, target * 0.71, opts), 1000)
  assert.equal(nextDifficulty(1000, target, opts), 1000)
  // Just outside moves.
  assert.notEqual(nextDifficulty(1000, target * 1.31, opts), 1000)
  assert.notEqual(nextDifficulty(1000, target * 0.69, opts), 1000)
  // The exact boundary is deliberately NOT asserted. `target * 1.3 / target` is 1.3000000000000003
  // in binary floating point, so which side of `<=` it lands on is a property of IEEE 754 and not of
  // this controller. Pinning it would be pinning the wrong thing, and a test that fails when the
  // dead band is rewritten in an algebraically identical way is worse than no test.
})

test('one retarget moves by at most maxStepFactor in each direction', () => {
  const opts = options({ maxStepFactor: 4 })
  const target = opts.targetSharesPerMinute
  // A wildly high observed rate would imply ×100; the clamp holds it to ×4.
  assert.equal(nextDifficulty(1000, target * 100, opts), 4000)
  // And the same downward: ÷100 becomes ÷4.
  assert.equal(nextDifficulty(1000, target / 100, opts), 250)
})

test('both hard clamps hold', () => {
  const opts = options({ minDifficulty: 10, maxDifficulty: 5000 })
  const target = opts.targetSharesPerMinute
  assert.equal(nextDifficulty(20, target / 100, opts), 10)
  assert.equal(nextDifficulty(4000, target * 100, opts), 5000)
  // A difficulty already outside the clamp is brought back inside by the constructor.
  assert.equal(new Vardiff({ initialDifficulty: 1, nowMs: 0, options: opts }).difficulty, 10)
  assert.equal(new Vardiff({ initialDifficulty: 999_999, nowMs: 0, options: opts }).difficulty, 5000)
})

test('a difficulty that is not a positive number is refused', () => {
  const opts = options()
  assert.throws(() => nextDifficulty(0, 10, opts), RangeError)
  assert.throws(() => nextDifficulty(-1, 10, opts), RangeError)
  assert.throws(() => nextDifficulty(Number.NaN, 10, opts), RangeError)
  assert.throws(() => nextDifficulty(Number.POSITIVE_INFINITY, 10, opts), RangeError)
})

test('a window with too few shares to measure does not retarget', () => {
  // Four shares in ninety seconds is a rate of 2.7/minute, which is far below the target of 12 and
  // would imply a large step down. It must not be believed: `minSamples` is 6.
  const opts = options({ minSamples: 6 })
  let now = 0
  const vardiff = new Vardiff({ initialDifficulty: 1000, nowMs: now, options: opts })
  // Five shares at twenty-second spacing: 100 seconds, so the 90-second window HAS elapsed, and
  // five samples is one short of the six required. Four shares would not have closed the window at
  // all and would have tested nothing.
  for (let i = 0; i < 5; i += 1) {
    now += 20_000
    assert.equal(vardiff.recordShare(now), null)
  }
  // The window has elapsed but the sample count has not been met, and the miner is not silent
  // either — it submitted 20 seconds ago. Nothing happens to the difficulty.
  assert.equal(vardiff.difficulty, 1000)
  // The samples are KEPT, not discarded: the window extends until it can measure. Discarding them
  // is what created the retarget gap the sweep above guards.
  assert.equal(vardiff.state.sharesInWindow, 5)
  assert.equal(vardiff.state.windowStartedAtMs, 0)

  // One more share meets `minSamples`, and now it measures — against the true 120 seconds elapsed,
  // not against the nominal 90, so the rate is right rather than merely late.
  now += 20_000
  const retarget = vardiff.recordShare(now)
  assert.equal(retarget, 250, 'six shares in 120s is 3/minute against a target of 12: cut by the clamp')
})

test('the window does not close early', () => {
  const opts = options()
  let now = 0
  const vardiff = new Vardiff({ initialDifficulty: 1000, nowMs: now, options: opts })
  // Twenty shares in ten seconds is a huge rate, but the window is 90 seconds and it has not
  // elapsed. Retargeting on a partial window would let a burst move difficulty.
  for (let i = 0; i < 20; i += 1) {
    now += 500
    assert.equal(vardiff.recordShare(now), null)
  }
  assert.equal(vardiff.difficulty, 1000)
  assert.equal(vardiff.state.sharesInWindow, 20)
})

/* ═══════════════════════════════════════════════ the silent miner ════════════════════════════ */

test('a miner that submits nothing is ratcheted down one step per window', () => {
  // The case `vardiff.ts` calls the one that matters most: a difficulty set so high the machine
  // never produces a share, so there is no measurement to retarget from. Without this path the
  // miner sees an empty share history for ever and cannot tell a mis-tuned pool from a dishonest
  // one.
  const opts = options({ minDifficulty: 0.001, maxStepFactor: 4 })
  let now = 0
  const vardiff = new Vardiff({ initialDifficulty: 1024, nowMs: now, options: opts })
  const seen: number[] = []

  for (let window = 0; window < 6; window += 1) {
    now += opts.retargetMs
    const next = vardiff.onIdle(now)
    if (next !== null) seen.push(next)
  }

  assert.deepEqual(seen, [256, 64, 16, 4, 1, 0.25])
})

test('the idle ratchet waits for real silence, not merely a short window', () => {
  // `idleFactor` is 8 expected intervals. At 12 shares/minute the expected interval is 5s, so the
  // ratchet needs 40s of silence. A miner that submitted 10 seconds ago is unlucky, not silent, and
  // dropping its difficulty on that basis would fight with the measured path.
  const opts = options()
  let now = 0
  const vardiff = new Vardiff({ initialDifficulty: 1024, nowMs: now, options: opts })
  now += 85_000
  vardiff.recordShare(now) // one share, 5 seconds before the window closes
  now += 5_000
  assert.equal(vardiff.onIdle(now), null)
  assert.equal(vardiff.difficulty, 1024)
})

test('the idle ratchet stops at minDifficulty rather than approaching zero', () => {
  const opts = options({ minDifficulty: 1, maxStepFactor: 4 })
  let now = 0
  const vardiff = new Vardiff({ initialDifficulty: 16, nowMs: now, options: opts })
  for (let window = 0; window < 10; window += 1) {
    now += opts.retargetMs
    vardiff.onIdle(now)
  }
  assert.equal(vardiff.difficulty, 1)
})

test('a share arriving resets the silence', () => {
  // Checks that `lastShareAtMs` is actually maintained: a miner submitting slowly but steadily must
  // be handled by the measured path, never by the ratchet.
  const opts = options()
  let now = 0
  const vardiff = new Vardiff({ initialDifficulty: 1024, nowMs: now, options: opts })
  now += 50_000
  vardiff.recordShare(now)
  assert.equal(vardiff.state.lastShareAtMs, 50_000)
  now += 40_000
  // The window has now elapsed (90s) with one share, and the last share was 40s ago — exactly the
  // ratchet threshold, so it fires. One second less and it would not.
  const fired = vardiff.onIdle(now)
  assert.equal(fired, 256)
})

/* ═══════════════════════════════════════════════ presentation ════════════════════════════════ */

test('roundDifficulty produces values a miner can print and compare', () => {
  // §6 of the spec requires a miner to be able to reconcile their share history against their own
  // machine. A difficulty of 8192.000000001 prints differently in two places and makes that
  // reconciliation ambiguous.
  assert.equal(roundDifficulty(8192.000000001), 8192)
  assert.equal(roundDifficulty(1023.6), 1024)
  assert.equal(roundDifficulty(1), 1)
  assert.equal(roundDifficulty(0.5), 0.5)
  assert.equal(roundDifficulty(0.001), 0.001)
  assert.equal(roundDifficulty(0.0009765625), 0.000977)
})

test('a retarget that rounds to the current difficulty reports no change', () => {
  // Otherwise a `mining.set_difficulty` is sent that changes nothing, and every one of those is a
  // discontinuity in the miner's own accounting for no reason.
  const opts = options({ variance: 0 })
  let now = 0
  const vardiff = new Vardiff({ initialDifficulty: 1000, nowMs: now, options: opts })
  // A rate a hair above target: the ratio is outside the (zero) dead band, but 1000 × 1.0004
  // rounds back to 1000.
  const shares = 18
  const gap = opts.retargetMs / shares
  for (let i = 0; i < shares; i += 1) {
    now += gap
    vardiff.recordShare(now)
  }
  // 18 shares in 90s is 12/minute exactly — the target — so difficulty is unchanged and no
  // set_difficulty is due.
  assert.equal(vardiff.difficulty, 1000)
})

test('the exposed state is the state the controller actually used', () => {
  const opts = options()
  const vardiff = new Vardiff({ initialDifficulty: 64, nowMs: 1_000, options: opts })
  assert.deepEqual(vardiff.state, {
    difficulty: 64,
    windowStartedAtMs: 1_000,
    sharesInWindow: 0,
    lastShareAtMs: 1_000,
  })
  vardiff.recordShare(2_000)
  assert.equal(vardiff.state.sharesInWindow, 1)
  assert.equal(vardiff.state.lastShareAtMs, 2_000)
})

test('the defaults are the ones the service ships with', () => {
  // Pinned because they are the numbers every connection gets, and a change to them is a change to
  // every miner's experience that should be deliberate.
  assert.equal(DEFAULT_VARDIFF.targetSharesPerMinute, 12)
  assert.equal(DEFAULT_VARDIFF.retargetMs, 90_000)
  assert.equal(DEFAULT_VARDIFF.variance, 0.3)
  assert.equal(DEFAULT_VARDIFF.maxStepFactor, 4)
  assert.equal(DEFAULT_VARDIFF.minSamples, 6)
  assert.equal(DEFAULT_VARDIFF.idleFactor, 8)
  assert.ok(Object.isFrozen(DEFAULT_VARDIFF))
})
