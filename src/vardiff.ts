/**
 * Variable difficulty: keeping each connection at a steady share rate whatever hardware is behind
 * it.
 *
 * ## What this is for, which is not what it sounds like
 *
 * Difficulty does not change how much a miner earns. A share at difficulty 4096 is worth exactly
 * four times a share at 1024 in `pplns.ts`, and a miner's expected credit per unit of hashrate is
 * the same at any setting. What difficulty controls is the *granularity of the estimate*: at too low
 * a difficulty a fast machine floods the pool with shares it must hash-check and store, and at too
 * high a difficulty a slow machine submits a share every twenty minutes and its credit is dominated
 * by luck for hours at a time.
 *
 * That second case is the one that matters to a person. §6 of
 * `docs/ecosystem/36-multi-chain-and-mining-pool.md` says the share history has to be checkable by
 * the miner against their own machine. A miner whose difficulty is set far too high sees an empty
 * share history and a running fan, and has no way to tell a badly-tuned pool from a dishonest one.
 * **So the direction that matters most here is DOWN, and the case that matters most is the miner
 * that has submitted nothing at all** — which is exactly the case a naive implementation cannot see,
 * because it retargets from observed shares and there are none.
 *
 * ## The estate has no precedent for this, so the shape is stated explicitly
 *
 *   - **A dead band.** No change unless the observed rate is outside ±`variancePercent` of target.
 *     Retargeting on every wobble sends a `mining.set_difficulty` every few seconds, and each one
 *     is a discontinuity in the miner's own accounting.
 *   - **A step clamp.** One retarget moves difficulty by at most `maxStepFactor`. A single unlucky
 *     window on a machine at its correct difficulty can show a rate 5× low; obeying it would set a
 *     difficulty the miner then takes ten minutes to climb back out of.
 *   - **A minimum sample count**, and a window that EXTENDS rather than resets until it is met. A
 *     rate computed from two shares is not a rate; but a window that throws its partial count away
 *     and starts again leaves a band of share rates — too slow to fill a window, too active to look
 *     silent — in which no retarget can ever happen and a miner is pinned at several times its
 *     correct difficulty indefinitely. The rate is measured against actual elapsed time, so an
 *     extended window gives a correct answer rather than a late one.
 *   - **An idle ratchet**, described above, which is the only path that does not need samples.
 *   - **Hard clamps** at both ends. `minDifficulty` stops a dying connection from being handed a
 *     difficulty so low it floods; `maxDifficulty` is a backstop against a runaway multiply.
 *
 * Everything here is a pure function of numbers and timestamps, with the clock injected, because a
 * retarget rule that can only be observed by attaching a real miner for an hour is a retarget rule
 * nobody will ever change with confidence. `vardiff.test.ts` drives convergence, both clamps, the
 * dead band and the silent-miner path on a fake clock.
 */

export interface VardiffOptions {
  /** The share rate this aims for, per minute, per connection. */
  readonly targetSharesPerMinute: number
  /** How long a measurement window is. */
  readonly retargetMs: number
  /** Dead band, as a fraction: 0.3 means "do nothing while within ±30% of target". */
  readonly variance: number
  /** The most one retarget may multiply or divide difficulty by. */
  readonly maxStepFactor: number
  readonly minDifficulty: number
  readonly maxDifficulty: number
  /** Shares needed in a window before its rate is believed. */
  readonly minSamples: number
  /**
   * Silence, as a multiple of the expected interval between shares, before the idle ratchet fires.
   *
   * Expressed as a multiple rather than as a duration on purpose: the expected interval is
   * `60 / targetSharesPerMinute` seconds, so a pool tuned for a share every four seconds and one
   * tuned for a share every thirty both wait the same number of *expected shares* before deciding
   * the miner is over-difficultied rather than merely unlucky. A fixed duration would be too
   * twitchy for one and too patient for the other.
   */
  readonly idleFactor: number
}

export const DEFAULT_VARDIFF: VardiffOptions = Object.freeze({
  targetSharesPerMinute: 12,
  retargetMs: 90_000,
  variance: 0.3,
  maxStepFactor: 4,
  minDifficulty: 0.001,
  maxDifficulty: 4_294_967_296,
  minSamples: 6,
  idleFactor: 8,
})

/**
 * ═══ THE DIFFICULTY BAND IS PER TRANSPORT, AND THE UNIT CHANGES WITH IT ═══════════════════════
 *
 * Everything above is tuned for the miner this pool was written for: a machine on the raw TCP
 * listener, doing between a megahash and a terahash. `minDifficulty: 0.001` and the per-chain
 * starting difficulties in `env.ts` (btc 65,536, ltc 512) are all chosen against that.
 *
 * micro-org#289 adds a second transport — Stratum v1 over WebSocket — whose only client is a
 * browser tab running scrypt in JavaScript, which the issue measures at "a few hundred hashes per
 * second per core" (2026-08-09). Handing that connection the hardware band produces the one failure
 * mode `vardiff.ts` exists to prevent, by a road the idle ratchet is too slow to close:
 *
 *   - At ltc's starting difficulty of 512, one share costs 512 × 2^16 ≈ 33.6 million scrypt hashes.
 *     At 250 H/s that is **37 hours**. The connection submits nothing.
 *   - The ratchet then divides by `maxStepFactor` once per 90-second window. Walking 512 down to
 *     something a browser can hit takes eight or nine windows — the better part of a quarter of an
 *     hour of a spinning fan, an empty share list and no way to tell a mis-set difficulty from a
 *     broken miner. §6 of `docs/ecosystem/36-multi-chain-and-mining-pool.md` is exactly about that
 *     confusion.
 *
 * ## Why the band is expressed in HASHES and not in difficulty
 *
 * Because `minDifficulty: 0.001` does not mean one thing. Difficulty is a unit whose size depends on
 * the algorithm — `hashesPerDifficulty` is ~2^32 for SHA-256d and ~2^16 for scrypt — so the same
 * floor asks a Litecoin miner for 66 hashes and a Bitcoin miner for 4.3 million. A factor of 65,536
 * between two chains is fine when the client is an ASIC that does either number instantly, and it is
 * not fine when the client is a browser: 4.3 million SHA-256d hashes in JavaScript is seconds, and
 * 66 scrypt hashes is a flood.
 *
 * So the browser band names the thing that is actually constant across chains — **how much work one
 * share should cost** — and converts through `hashesPerDifficulty` at the call site. The same two
 * numbers then mean the same wait on both algorithms, which is what "a floor set for the transport"
 * has to mean.
 *
 * The values, and the arithmetic behind them at the issue's 250 H/s per core:
 *
 *   - **1,024 hashes to start.** ~4 seconds to the first share on one core, and under a second on a
 *     machine running the `hardwareConcurrency - 1` workers the client defaults to. The first share
 *     is the whole point: it is the evidence that turns "possibly broken" into "mining".
 *   - **256 hashes as the floor.** One share per second per core, which is the fastest this pool is
 *     willing to be asked to hash-check and store per browser. It is also low enough for the slow
 *     end that matters — a single duty-cycled core on battery at 50 H/s still lands a share every
 *     five seconds, which is the target rate exactly.
 *
 * Vardiff does the rest in both directions from there, unchanged. The ceiling is NOT lowered: a
 * connection only reaches a high difficulty by sustaining the share rate that justifies it, and a
 * browser on a fast machine that can do so should be allowed to.
 */
export const BROWSER_INITIAL_HASHES_PER_SHARE = 1_024
export const BROWSER_MIN_HASHES_PER_SHARE = 256

/**
 * The starting difficulty for a browser connection on a chain with this hashes-per-difficulty.
 *
 * Rounded through `roundDifficulty` for the reason that function gives: the number is sent to the
 * miner in `mining.set_difficulty` and printed on both sides, and two spellings of one difficulty is
 * a reconciliation the miner cannot complete.
 */
export function browserInitialDifficulty(hashesPerDifficulty: number): number {
  return roundDifficulty(BROWSER_INITIAL_HASHES_PER_SHARE / hashesPerDifficulty)
}

/**
 * The hardware band with its floor replaced by the browser one.
 *
 * Only `minDifficulty` moves. Target rate, window, dead band, step clamp, sample count and the idle
 * factor are properties of the CONTROLLER rather than of the client, and they are as right for a tab
 * as for a rig — a browser that stops hashing when it is backgrounded needs the same ratchet, on the
 * same clock, as a rig whose fans have failed.
 */
export function browserVardiff(base: VardiffOptions, hashesPerDifficulty: number): VardiffOptions {
  const floor = roundDifficulty(BROWSER_MIN_HASHES_PER_SHARE / hashesPerDifficulty)
  return Object.freeze({ ...base, minDifficulty: Math.min(floor, base.maxDifficulty) })
}

/**
 * The difficulty implied by an observed share rate, with every guard applied.
 *
 * Pure. Returns the current difficulty unchanged when nothing should move, so a caller can compare
 * for equality rather than interpreting a null.
 */
export function nextDifficulty(current: number, observedSharesPerMinute: number, options: VardiffOptions): number {
  if (!Number.isFinite(current) || current <= 0) throw new RangeError(`difficulty must be positive (got ${current})`)
  const target = options.targetSharesPerMinute

  // Zero observed shares cannot produce a ratio, and it is not this function's case anyway — the
  // idle ratchet handles it, because "no shares in a window" says nothing about how far off the
  // difficulty is, only that it is too high.
  if (observedSharesPerMinute <= 0) return clamp(current / options.maxStepFactor, options)

  // ═══ THE RATIO IS observed/target AND THE ORDER IS NOT INTERCHANGEABLE ═══════════════════════
  //
  // This is the one line in the file that has to be right, and it is the one that reads equally
  // plausibly backwards. A miner submitting MORE shares than the target is a miner whose difficulty
  // is too LOW, so difficulty must go UP — which means multiplying by a number above 1, which means
  // the observed rate is the numerator. Written the other way round the controller is not merely
  // inaccurate, it is unstable in the direction of collapse: too many shares lowers difficulty,
  // which produces more shares, which lowers it again, until every connection is pinned at
  // `minDifficulty` flooding the pool with worthless submissions. `vardiff.test.ts` drives a
  // simulated miner from difficulty 1 up to its correct difficulty precisely so that this cannot be
  // inverted again without the suite going red.
  //
  // The equivalent form used by most pool software is `newDiff = curDiff × targetTime / actualTime`,
  // where time is seconds per share; since time per share is `60 / rate`, that ratio is
  // `observed / target` exactly. The dead band is tested on the ratio rather than on the resulting
  // difficulty so that it means the same thing at every scale.
  const ratio = observedSharesPerMinute / target
  if (Math.abs(ratio - 1) <= options.variance) return current

  const stepped = Math.min(Math.max(ratio, 1 / options.maxStepFactor), options.maxStepFactor)
  return clamp(current * stepped, options)
}

function clamp(difficulty: number, options: VardiffOptions): number {
  return Math.min(Math.max(difficulty, options.minDifficulty), options.maxDifficulty)
}

/**
 * Round a difficulty to something a miner's own accounting will agree with.
 *
 * Difficulties are exchanged as JSON numbers and both sides derive a target from them by the same
 * arithmetic, so in principle any float works. In practice a difficulty of 8192.000000001 is a
 * difficulty that prints differently in two places, and the miner reconciling their share history
 * against ours — the §6 requirement — has to decide whether the mismatch is rounding or theft.
 * Rounding to three significant decimals below 1 and to whole numbers above it keeps every value
 * printable and comparable.
 */
export function roundDifficulty(difficulty: number): number {
  if (difficulty >= 1) return Math.round(difficulty)
  return Number(difficulty.toPrecision(3))
}

export interface VardiffState {
  readonly difficulty: number
  readonly windowStartedAtMs: number
  readonly sharesInWindow: number
  readonly lastShareAtMs: number
}

/**
 * One connection's difficulty controller.
 *
 * Event-driven by construction: it is asked to reconsider when a share is accepted and when a new
 * job is pushed to the connection. Nothing here runs on a timer of its own, which is both the
 * estate's rule about `setInterval` and the right design — template arrivals are already a clock,
 * one that ticks about as often as the retarget window needs, and a connection with no shares and
 * no jobs is a connection with nothing to retarget for.
 */
export class Vardiff {
  #difficulty: number
  #windowStartedAtMs: number
  #sharesInWindow = 0
  #lastShareAtMs: number
  readonly #options: VardiffOptions

  constructor(args: { initialDifficulty: number; nowMs: number; options?: VardiffOptions }) {
    this.#options = args.options ?? DEFAULT_VARDIFF
    this.#difficulty = clamp(args.initialDifficulty, this.#options)
    this.#windowStartedAtMs = args.nowMs
    this.#lastShareAtMs = args.nowMs
  }

  get difficulty(): number {
    return this.#difficulty
  }

  get state(): VardiffState {
    return {
      difficulty: this.#difficulty,
      windowStartedAtMs: this.#windowStartedAtMs,
      sharesInWindow: this.#sharesInWindow,
      lastShareAtMs: this.#lastShareAtMs,
    }
  }

  /**
   * Record an accepted share and return a new difficulty if one is due, else null.
   *
   * Only accepted shares count. Feeding rejects in would let a miner with a broken client — one
   * sending stale jobs at speed — argue its way to a higher difficulty on work that was never
   * valid.
   */
  recordShare(nowMs: number): number | null {
    this.#sharesInWindow += 1
    this.#lastShareAtMs = nowMs
    return this.#maybeRetarget(nowMs)
  }

  /**
   * Reconsider without a share. Called when a job is pushed.
   *
   * This is the path that saves the silent miner. If the window has elapsed with too few shares to
   * measure AND the connection has been quiet for `idleFactor` expected intervals, difficulty comes
   * down by the full step. Repeated, that walks a wildly over-set difficulty down to something the
   * machine can actually hit — which is the difference between a miner who sees their shares and one
   * who concludes the pool is broken.
   */
  onIdle(nowMs: number): number | null {
    return this.#maybeRetarget(nowMs)
  }

  #maybeRetarget(nowMs: number): number | null {
    const elapsedMs = nowMs - this.#windowStartedAtMs
    if (elapsedMs < this.#options.retargetMs) return null

    const expectedIntervalMs = 60_000 / this.#options.targetSharesPerMinute
    const silentFor = nowMs - this.#lastShareAtMs
    const starved = this.#sharesInWindow < this.#options.minSamples

    let next: number
    if (starved && silentFor >= expectedIntervalMs * this.#options.idleFactor) {
      // The silent case. There is no measured rate to aim at, so this does not try to compute one:
      // it takes the largest step down the clamp allows, and does it again next window if the
      // silence continues.
      next = clamp(this.#difficulty / this.#options.maxStepFactor, this.#options)
    } else if (starved) {
      // Too few shares to believe a rate, but the connection is not silent either — it is being
      // unlucky, or it just connected, or it is moderately over-difficultied.
      //
      // ═══ THE WINDOW EXTENDS. IT MUST NOT RESET. ═══════════════════════════════════════════════
      //
      // Resetting here — starting a fresh window and throwing the partial count away — opens a gap
      // in which NOTHING can ever retarget, and a miner falls into it silently and stays there.
      // With the shipped defaults the gap is a share interval between 15s and 40s: too slow to
      // gather `minSamples` inside one `retargetMs` window, too active to satisfy the ratchet's
      // silence test. Every window would collect four or five shares, discard them, and begin
      // again, for ever, while the miner sits at between three and eight times its correct
      // difficulty watching a share history far too sparse to reconcile against its own machine.
      // That is precisely the §6 failure the ratchet exists to prevent, reached by a different
      // road. `vardiff.test.ts` walks a miner down through that band, which is how the gap was
      // found in the first place.
      //
      // Letting the window run on instead costs nothing and closes the gap completely: the samples
      // accumulate until there are enough to believe, and the rate is computed against the ACTUAL
      // elapsed time rather than the nominal window, so a longer window yields a correspondingly
      // lower measured rate and the retarget is right rather than merely late. The window cannot
      // grow without bound, because a connection quiet enough for that has by definition passed the
      // silence threshold and is taken by the branch above.
      return null
    } else {
      const observed = (this.#sharesInWindow * 60_000) / elapsedMs
      next = nextDifficulty(this.#difficulty, observed, this.#options)
    }

    this.#windowStartedAtMs = nowMs
    this.#sharesInWindow = 0

    const rounded = roundDifficulty(next)
    if (rounded === this.#difficulty) return null
    this.#difficulty = rounded
    return rounded
  }
}
