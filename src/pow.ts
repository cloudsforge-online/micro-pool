/**
 * Proof of work: the two hash functions, the two difficulty units, and the arithmetic that turns a
 * difficulty into a target.
 *
 * Everything in this file is pure and synchronous, which is deliberate — it is the part of a pool
 * that must be exactly right, and it is tested against real mined blocks in `pow.test.ts` rather
 * than against its own assumptions.
 *
 * ══ SCRYPT COMES FROM `node:crypto`, NOT FROM AN NPM PACKAGE, AND HERE IS THE REASONING ═════════
 *
 * The instruction for this work was to prefer a well-established npm package over hand-rolling a
 * scrypt. That is the right instinct and the conclusion here does not contradict it: **Node's own
 * `crypto.scryptSync` is OpenSSL's scrypt**, which is more established than any npm package that
 * could have been chosen, is maintained by the platform rather than by this repository, is
 * native rather than JavaScript, and adds no dependency to the image or to the supply chain that
 * `pnpm-workspace.yaml`'s `minimumReleaseAge` exists to police.
 *
 * The candidate it replaces is `scrypt-js`, which is genuinely well established (it is what ethers
 * uses). It is pure JavaScript, so it is roughly an order of magnitude slower than OpenSSL's, and
 * on a share-validation hot path — one scrypt per submitted share, across every connected miner —
 * that is a real cost for no correctness gain.
 *
 * **The thing to actually verify was that they compute the same function, and they do.** Litecoin's
 * proof of work is scrypt with N=1024, r=1, p=1, a 32-byte output, and the 80-byte block header
 * used as BOTH the password and the salt. That is exactly RFC 7914 scrypt with those parameters, so
 * any conforming implementation answers identically. `pow.test.ts` pins it the only way that
 * settles the question: it hashes the real Litecoin and Dogecoin genesis headers, whose nonces were
 * found by actual mining, and asserts the result falls under the target those blocks were mined
 * against. A wrong scrypt lands under a 2^-20 target with probability about one in a million.
 *
 * The one thing `crypto.scryptSync` needs said out loud is `maxmem`. It defaults to 32 MiB and
 * refuses above it; Litecoin's parameters need 128 × N × r = 128 KiB, so the default is three
 * orders of magnitude clear. It is left at the default rather than raised, because a raised
 * `maxmem` here would be a knob whose only possible effect is to let a future edit pick parameters
 * this chain does not use.
 */

import { createHash, scryptSync } from 'node:crypto'
import type { PowAlgorithm } from './chains.ts'

/** Bitcoin's proof of work, and the hash of every transaction and merkle node in the family. */
export function sha256d(data: Buffer): Buffer {
  return createHash('sha256').update(createHash('sha256').update(data).digest()).digest()
}

/**
 * Litecoin's proof of work.
 *
 * The header is passed as both password and salt because that is what the function Litecoin
 * actually uses does — it is not an oversight or a convenience. Anyone reading this who is used to
 * scrypt as a password hash will expect a distinct salt; there is none, and introducing one would
 * compute a different function from the one the network validates against.
 */
export function scryptPow(header: Buffer): Buffer {
  return scryptSync(header, header, 32, { N: 1024, r: 1, p: 1 })
}

/**
 * The proof-of-work hash for a chain's algorithm.
 *
 * No `default:` branch and an exhaustive `never` at the bottom, so a new member of `PowAlgorithm`
 * fails the typecheck here rather than falling through to Bitcoin's function and silently
 * rejecting every share on the new chain.
 */
export function powHash(algorithm: PowAlgorithm, header: Buffer): Buffer {
  switch (algorithm) {
    case 'sha256d':
      return sha256d(header)
    case 'scrypt':
      return scryptPow(header)
    default: {
      const unreachable: never = algorithm
      throw new Error(`no proof-of-work function for ${String(unreachable)}`)
    }
  }
}

/**
 * ══ THE DIFFICULTY-1 TARGET, PER ALGORITHM, AND WHY SCRYPT'S IS NOT BITCOIN'S ═══════════════════
 *
 * A stratum difficulty is meaningless on its own. It is a multiple of a *difficulty-1 target*, and
 * the pool and the miner have to be using the same one or they disagree about what a share is
 * worth. There is no negotiation for this in the protocol: it is a convention, baked into the
 * mining firmware, and the pool's only job is to match it.
 *
 * For SHA-256d the convention is Bitcoin's own: 0xFFFF × 2^208, the target the network's difficulty
 * 1 corresponds to. Nothing is ambiguous there.
 *
 * **For scrypt it is 2^16 times easier, and it is NOT Litecoin's own network difficulty-1 either.**
 * This is the detail worth being careful about, because there are three plausible values and two of
 * them are wrong:
 *
 *   * Bitcoin's 0xFFFF × 2^208 — wrong, and would make every difficulty this pool sets 65,536×
 *     harder than the miner believes it to be. The miner submits nothing, decides the pool is
 *     broken, and leaves.
 *   * Litecoin's consensus `powLimit`, 0xFFFF × 2^220 (compact 0x1e0ffff0) — plausible, wrong by a
 *     factor of 16, and the most tempting of the three because it is the number actually written
 *     in the chain's source.
 *   * 0xFFFF × 2^224 — **correct**, and it is correct for the only reason that matters: it is what
 *     deployed mining software computes against. cgminer's `set_target` multiplies the SHA-256d
 *     difficulty-1 target by 65,536 when it is mining scrypt, and node-stratum-pool — which is what
 *     most Litecoin pools in existence are built on — carries the same 2^16 multiplier under the
 *     name `algos.scrypt.multiplier`. So the miner's local accept/reject accounting and its
 *     reported hashrate are both computed against this value.
 *
 * The consequence of choosing the wrong one is not a crash. It is that the pool's share counter and
 * the miner's share counter disagree by a constant factor, which is precisely the observation
 * `docs/ecosystem/36-multi-chain-and-mining-pool.md` §6 says is indistinguishable, from the miner's
 * side, from a pool that steals: "the share history has to be checkable by the miner against their
 * own machine, which is a product requirement and not a nicety."
 *
 * These are the pool's SHARE units. They have nothing to do with a chain's *block* target, which is
 * never derived from a difficulty here — it is decoded from the `bits` field the node itself put in
 * the template, by `targetFromCompactBits`.
 */
const DIFF1_SHA256D = 0xffffn * 2n ** 208n
const DIFF1_SCRYPT = 0xffffn * 2n ** 224n

export function diff1TargetFor(algorithm: PowAlgorithm): bigint {
  switch (algorithm) {
    case 'sha256d':
      return DIFF1_SHA256D
    case 'scrypt':
      return DIFF1_SCRYPT
    default: {
      const unreachable: never = algorithm
      throw new Error(`no difficulty-1 target for ${String(unreachable)}`)
    }
  }
}

/**
 * Fixed-point scale for the difficulty → target division.
 *
 * A stratum difficulty arrives as a JSON number and a target is a 256-bit integer, so the division
 * has to cross from float to bigint somewhere. Doing it by rounding the difficulty to an integer
 * first would quantise every difficulty below 1 to zero — and difficulties below 1 are ordinary on
 * scrypt, where a single GPU is worth a fraction of a share unit. 2^16 of fixed-point headroom
 * keeps four decimal places of difficulty exact and keeps the numerator well inside a double for
 * every difficulty this pool will ever set.
 */
const DIFFICULTY_SCALE = 65_536n

/**
 * The 256-bit target a share must beat to count at this difficulty.
 *
 * Rounds the difficulty rather than truncating, and floors the division, so the target this returns
 * is never *easier* than the difficulty asked for. Erring in that direction is the safe one: the
 * pool credits a share only for work that was certainly done.
 */
export function targetForDifficulty(algorithm: PowAlgorithm, difficulty: number): bigint {
  if (!Number.isFinite(difficulty) || difficulty <= 0) {
    throw new RangeError(`difficulty must be a positive finite number (got ${difficulty})`)
  }
  const scaled = BigInt(Math.round(difficulty * Number(DIFFICULTY_SCALE)))
  if (scaled <= 0n) {
    throw new RangeError(`difficulty ${difficulty} rounds to zero at this fixed-point scale`)
  }
  return (diff1TargetFor(algorithm) * DIFFICULTY_SCALE) / scaled
}

/**
 * The difficulty a given proof-of-work hash actually achieved.
 *
 * Recorded alongside every accepted share, and it is not decoration: §5.4 of the multi-chain
 * document requires that a miner can reconcile our share history against their own machine's log,
 * and the observed difficulty of a share is the value their software prints. Storing only the
 * difficulty we assigned would leave them nothing to compare against but a count.
 */
export function difficultyOfHash(algorithm: PowAlgorithm, hash: Buffer): number {
  const value = powHashToBigInt(hash)
  if (value === 0n) return Number.POSITIVE_INFINITY
  return Number((diff1TargetFor(algorithm) * DIFFICULTY_SCALE) / value) / Number(DIFFICULTY_SCALE)
}

/**
 * A proof-of-work hash as the integer it is compared as.
 *
 * **The reversal is the whole of it.** Both hash functions emit 32 bytes that the consensus rules
 * read as a LITTLE-endian 256-bit integer, while every place a human sees a block hash — an
 * explorer, `getblockhash`, the `previousblockhash` field of a template — shows the same bytes
 * reversed, big-endian. Comparing the raw digest against a target as big-endian is the classic
 * version of this mistake and it does not fail loudly: it accepts and rejects roughly the wrong
 * shares, forever.
 */
export function powHashToBigInt(hash: Buffer): bigint {
  return BigInt(`0x${Buffer.from(hash).reverse().toString('hex')}`)
}

/** Does this proof-of-work hash meet the target? Inclusive, as consensus is. */
export function meetsTarget(hash: Buffer, target: bigint): boolean {
  return powHashToBigInt(hash) <= target
}

/**
 * The 256-bit target encoded in a header's compact `bits` field.
 *
 * This is the BLOCK target and it is decoded from what the node put in the template — never
 * derived from a difficulty, never configured, never guessed. It is the one number in a pool that
 * decides whether a share is a block, and the node is its only honest source.
 *
 * The negative-and-overflow branches are the ones a reader will be tempted to drop. They cannot
 * arise from a mainnet template and they are kept anyway: this function is the boundary at which
 * an integer from another process becomes an arithmetic assumption, and "cannot happen" is how a
 * malformed value becomes a target of zero that no share can ever meet.
 */
export function targetFromCompactBits(bits: number): bigint {
  if (!Number.isInteger(bits) || bits < 0 || bits > 0xffffffff) {
    throw new RangeError(`bits must be a uint32 (got ${bits})`)
  }
  const exponent = bits >>> 24
  const mantissa = BigInt(bits & 0x007fffff)
  if ((bits & 0x00800000) !== 0) {
    throw new RangeError(`bits ${bits.toString(16)} sets the sign bit — no valid target is negative`)
  }
  const target = exponent <= 3 ? mantissa >> (8n * BigInt(3 - exponent)) : mantissa << (8n * BigInt(exponent - 3))
  if (target === 0n) throw new RangeError(`bits ${bits.toString(16)} decodes to a zero target`)
  if (target > 2n ** 256n - 1n) {
    throw new RangeError(`bits ${bits.toString(16)} decodes above 2^256`)
  }
  return target
}

/**
 * How many hashes a share of difficulty 1 is expected to cost, for this algorithm.
 *
 * `2^256 / diff1Target`, which comes out at about 2^32 for SHA-256d and about 2^16 for scrypt —
 * and the ratio between them is exactly the 2^16 difficulty-unit difference explained above, which
 * is the point. A hashrate estimate is `sum(difficulty) × this / seconds`, and using SHA-256d's
 * constant on a scrypt chain would report every Litecoin miner as 65,536 times faster than they
 * are. Nothing in the pool's accounting depends on this number; it is display only, and it is
 * derived rather than written down so that it cannot drift from the difficulty-1 targets it is a
 * consequence of.
 */
export function hashesPerDifficulty(algorithm: PowAlgorithm): number {
  return Number((2n ** 256n * DIFFICULTY_SCALE) / diff1TargetFor(algorithm)) / Number(DIFFICULTY_SCALE)
}

/**
 * The network difficulty a block target represents, in this algorithm's own share units.
 *
 * Used for exactly one thing: sizing the PPLNS window, which is a multiple of the network
 * difficulty. Because it is expressed in the same units as the difficulties this pool assigns to
 * miners, the window arithmetic in `pplns.ts` compares like with like and needs no second
 * conversion factor — which is where a unit error would otherwise hide.
 */
export function networkDifficultyOf(algorithm: PowAlgorithm, blockTarget: bigint): number {
  if (blockTarget <= 0n) throw new RangeError('a block target must be positive')
  return Number((diff1TargetFor(algorithm) * DIFFICULTY_SCALE) / blockTarget) / Number(DIFFICULTY_SCALE)
}
