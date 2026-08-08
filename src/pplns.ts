/**
 * PPLNS: Pay Per Last N Shares — the accounting that turns a pile of shares into a claim on a block
 * reward.
 *
 * ## What PPLNS is, stated once, because the alternatives fail differently
 *
 * When the pool finds a block, it looks backwards over the most recent shares — not the shares
 * "since the last block", and not all shares ever — and divides the reward among the miners who
 * contributed them, in proportion to the difficulty of each. The window is sized in *work*, as a
 * multiple of the network difficulty, so it holds roughly the amount of work a block is expected to
 * take however lucky or unlucky the pool has been.
 *
 * The two things this buys are worth naming, because they are the reasons not to do something
 * simpler:
 *
 *   - **It is not per-round.** A round is the time between blocks, and it is wildly variable: a
 *     round that ends after ten minutes and one that ends after six hours pay their participants
 *     completely differently for the same hashrate. PPLNS' fixed-work window flattens that.
 *   - **It is not PPS.** Pay-per-share pays a miner a fixed amount for every share regardless of
 *     whether the pool finds anything, which means the pool is carrying the variance — it is
 *     insurance, and it needs a float to underwrite it. This estate has no such float and §5.3 of
 *     `docs/ecosystem/36-multi-chain-and-mining-pool.md` chose PPLNS. That decision is not
 *     relitigated here.
 *
 * PPLNS also has a cost, and honesty about it belongs in the product: a miner who leaves is still
 * inside the window for a while and keeps earning; a miner who arrives earns nothing extra for their
 * first window. That is a fairness property, not a bug, and `micro-pool-web` is where it has to be
 * explained.
 *
 * ## Everything here is integer arithmetic
 *
 * Weights are integers (`difficulty × 10^8` — see `migrations.ts` for why) and the reward is an
 * integer number of the chain's smallest unit. The division is done by largest remainder so that
 * **the allocated amounts sum to exactly the amount being allocated**, with no dust created and none
 * lost. `pplns.test.ts` asserts that equality on random inputs, because it is the one property that
 * cannot be checked by eye and the one whose violation is indistinguishable from theft.
 */

/**
 * The fixed-point scale between a difficulty and the integer weight it is stored and summed as.
 *
 * 10^8, the same scale `contracts-chain` gives every Bitcoin-family asset, chosen for the same
 * reason: it is enough resolution that no realistic value rounds to zero, and it is small enough
 * that a share's weight stays far inside a signed 64-bit column.
 */
export const DIFFICULTY_UNIT_SCALE = 100_000_000n

/**
 * A difficulty as the integer weight the database stores.
 *
 * Rounds, and then refuses zero. A share credited at a difficulty so small it rounds to no weight at
 * all would be recorded as work that earns nothing — which is precisely the invisible loss this
 * whole file exists to prevent. `vardiff.ts` clamps difficulty at 0.001, well above the 10^-8 where
 * this could bite, so a zero here means a bug upstream and should stop rather than continue.
 */
export function difficultyUnits(difficulty: number): bigint {
  if (!Number.isFinite(difficulty) || difficulty <= 0) {
    throw new RangeError(`difficulty must be a positive finite number (got ${difficulty})`)
  }
  const units = BigInt(Math.round(difficulty * Number(DIFFICULTY_UNIT_SCALE)))
  if (units <= 0n) throw new RangeError(`difficulty ${difficulty} rounds to zero weight`)
  return units
}

/** The inverse, for display and for logging. Lossy by one part in 10^8, which is why it is one-way. */
export function unitsToDifficulty(units: bigint): number {
  return Number(units) / Number(DIFFICULTY_UNIT_SCALE)
}

/**
 * How much work the window holds, as a multiple of the network difficulty.
 *
 * A multiplier of 2 means "the last two blocks' worth of expected work". Larger windows smooth a
 * miner's income further and lengthen the tail they keep earning over after they leave; smaller ones
 * do the reverse. There is no correct value, which is why it is configuration rather than a
 * constant — but there IS a wrong shape, which is a window measured in shares or in time. Both drift
 * with difficulty and with the pool's own size, and a window that quietly changes meaning when the
 * network retargets is a window nobody can reason about.
 */
export function windowUnitsFor(networkDifficulty: number, multiplier: number): bigint {
  if (!Number.isFinite(networkDifficulty) || networkDifficulty <= 0) {
    throw new RangeError(`network difficulty must be positive (got ${networkDifficulty})`)
  }
  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    throw new RangeError(`the PPLNS window multiplier must be positive (got ${multiplier})`)
  }
  return difficultyUnits(networkDifficulty) * BigInt(Math.round(multiplier * 1000)) / 1000n
}

export interface WindowEntry {
  readonly workerId: number
  readonly units: bigint
}

export interface Allocation {
  readonly workerId: number
  readonly units: bigint
  /** The chain's smallest unit. Sums, with the fee, to exactly the reward. */
  readonly amount: bigint
}

export interface AllocationResult {
  readonly fee: bigint
  readonly allocations: readonly Allocation[]
  readonly totalUnits: bigint
}

/**
 * Divide a block reward across a PPLNS window.
 *
 * ## The fee
 *
 * Taken off the top, once, as basis points of the whole reward. §7.1 of the multi-chain document
 * records that **the pool fee has not been chosen**, which is why there is no default anywhere in
 * this repository: `env.ts` requires `POOL_FEE_BASIS_POINTS` and refuses to start without it. A
 * default of 0 would be a choice ("free") and a default of 200 would be a choice ("2%"), and either
 * one made here would answer an open product question by omission.
 *
 * ## Largest remainder, and why not the obvious thing
 *
 * The obvious thing is to give each worker `floor(net × units / total)` and stop. That loses up to
 * one unit per worker — with a thousand workers, a thousand units of somebody's money vanish from
 * the accounting on every block, and the pool's books do not balance against the reward it received.
 * Largest remainder hands the shortfall back to the workers with the largest fractional parts, one
 * unit each, until the total is exact.
 *
 * Ties break on the smaller `workerId`. Any deterministic rule would do; what matters is that it IS
 * deterministic, so that recomputing an allocation from the same window gives the same answer — a
 * miner checking our arithmetic against their own has to be able to reproduce it exactly.
 */
export function allocateReward(args: {
  readonly reward: bigint
  readonly feeBasisPoints: number
  readonly entries: readonly WindowEntry[]
}): AllocationResult {
  if (args.reward < 0n) throw new RangeError('a reward cannot be negative')
  if (!Number.isInteger(args.feeBasisPoints) || args.feeBasisPoints < 0 || args.feeBasisPoints > 10_000) {
    throw new RangeError(`the pool fee must be 0..10000 basis points (got ${args.feeBasisPoints})`)
  }

  const totalUnits = args.entries.reduce((sum, entry) => sum + entry.units, 0n)
  const fee = (args.reward * BigInt(args.feeBasisPoints)) / 10_000n

  // No shares in the window is a real state — a block found in the first seconds of a pool's life,
  // or after a share table was pruned too aggressively. The whole reward is then the fee, and the
  // caller sees an allocation list of length zero rather than a silent division by zero.
  if (totalUnits === 0n) {
    return { fee: args.reward, allocations: [], totalUnits: 0n }
  }

  const net = args.reward - fee
  const scratch = args.entries.map((entry) => {
    const numerator = net * entry.units
    return {
      workerId: entry.workerId,
      units: entry.units,
      amount: numerator / totalUnits,
      remainder: numerator % totalUnits,
    }
  })

  let allocated = scratch.reduce((sum, entry) => sum + entry.amount, 0n)
  const leftover = net - allocated
  if (leftover > 0n) {
    const order = [...scratch].sort((a, b) => {
      if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1
      return a.workerId - b.workerId
    })
    for (let i = 0; i < Number(leftover); i += 1) {
      const entry = order[i % order.length]
      if (!entry) break
      entry.amount += 1n
    }
    allocated = scratch.reduce((sum, entry) => sum + entry.amount, 0n)
  }

  // The invariant this file exists for, asserted rather than assumed. If it ever fails, stopping is
  // better than paying: a reward that does not add up is a discrepancy somebody would have to be
  // told about anyway, and finding it here costs nothing.
  if (allocated + fee !== args.reward) {
    throw new Error(
      `PPLNS allocation does not balance: ${allocated} allocated + ${fee} fee != ${args.reward} reward`,
    )
  }

  return {
    fee,
    allocations: scratch.map(({ workerId, units, amount }) => ({ workerId, units, amount })),
    totalUnits,
  }
}
