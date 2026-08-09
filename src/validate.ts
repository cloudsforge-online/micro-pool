/**
 * Share validation: rebuilding the exact 80 bytes the miner hashed, hashing them, and deciding what
 * the result is worth.
 *
 * **The pool reconstructs; it never trusts.** A `mining.submit` carries four small strings and a job
 * id. Everything else — the coinbase, the merkle root, the version, the previous block — comes from
 * the pool's own record of the job it issued. That is the whole security model of a Stratum pool: a
 * miner can only choose bytes inside the space it was given, and any share whose header does not
 * hash under the target is worth nothing whatever the miner claims about it.
 *
 * ## The three verdicts, and why they are three
 *
 *   1. **Below the share target** — rejected, code 23. Ordinary and expected; most submissions from
 *      a miscalibrated client look like this.
 *   2. **At or above the share target** — an accepted share. It is a debt record: proof that work was
 *      done, credited in `pplns.ts`. It is not money and it is not a block.
 *   3. **At or above the BLOCK target** — a block, and also a share. These are checked separately
 *      and both are recorded, because a share that is a block is still the share it was. Collapsing
 *      the two checks into one — "is it a block? no, then is it a share?" — is how a pool loses the
 *      accounting for the single most valuable submission it will ever receive.
 *
 * ## Stale, duplicate, and the order they are checked in
 *
 * Staleness is checked first because it is the cheapest and because a stale share is not a fault:
 * the miner did real work on a job that was valid when it started. Duplicates are checked before the
 * hash, because a duplicate is either a retransmit or an attempt to be paid twice for one solution,
 * and hashing it first would let a miner spend the pool's CPU by replaying one share forever.
 *
 * Every rejection carries the numeric code the protocol assigns it. Miner software displays these,
 * and a pool that answers 20 ("other") to everything is a pool nobody can diagnose from the miner's
 * side — which §6 of `docs/ecosystem/36-multi-chain-and-mining-pool.md` names as the thing that
 * makes an honest pool indistinguishable from a dishonest one.
 */

import { buildHeader } from './coinbase.ts'
import { coinbaseTxId } from './coinbase.ts'
import { hashFromDisplay, isHex, swap32Hex } from './bytes.ts'
import { merkleRootFromBranch } from './merkle.ts'
import { meetsTarget, difficultyOfHash, powHash, targetForDifficulty } from './pow.ts'
import { coinbaseFor, type Job } from './work.ts'
import type { PowAlgorithm } from './chains.ts'

/**
 * The error codes Stratum v1 assigns. There is no RFC; this set is what every implementation in the
 * field uses and what miner firmware prints back to its operator.
 */
export const STRATUM_ERROR = Object.freeze({
  OTHER: 20,
  JOB_NOT_FOUND: 21,
  DUPLICATE_SHARE: 22,
  LOW_DIFFICULTY: 23,
  UNAUTHORIZED: 24,
  NOT_SUBSCRIBED: 25,
})

export type StratumErrorCode = (typeof STRATUM_ERROR)[keyof typeof STRATUM_ERROR]

/**
 * How far ahead of our own clock a submitted `ntime` may be.
 *
 * Miners roll ntime forward as they exhaust nonce space, and consensus allows a header up to two
 * hours ahead of network-adjusted time. Two hours is far more rope than any honest miner needs, and
 * a header that far ahead is a block the network will hold rather than accept — so this is tighter
 * than consensus deliberately. The floor is the template's own `mintime`, which is the
 * median-time-past bound: below it the block is invalid outright.
 */
export const MAX_NTIME_AHEAD_SECONDS = 600

export interface ShareSubmission {
  readonly jobId: string
  readonly extranonce2Hex: string
  readonly ntimeHex: string
  readonly nonceHex: string
  /** Present only when the connection negotiated version rolling. See `versionMask`. */
  readonly versionHex?: string | undefined
}

export interface ShareContext {
  readonly job: Job
  readonly algorithm: PowAlgorithm
  readonly extranonce1: Buffer
  readonly extranonce2Size: number
  /** The difficulty this share is judged at. See `session.ts` for which of two it is. */
  readonly shareDifficulty: number
  /**
   * The bits of the block version the miner is allowed to change, or 0 for none.
   *
   * Version rolling (BIP310, negotiated through `mining.configure`) is how modern SHA-256d hardware
   * gets extra nonce space cheaply, and firmware that has negotiated it WILL send a sixth parameter
   * whether or not the pool expects one. Bits outside the mask must match the job's version exactly:
   * a miner that could set any version bit could signal for a soft fork the pool never agreed to,
   * using the pool's own block.
   */
  readonly versionMask: number
  readonly nowSeconds: number
}

export type ShareResult =
  | {
      readonly status: 'rejected'
      readonly code: StratumErrorCode
      readonly message: string
    }
  | {
      readonly status: 'accepted'
      /** Proof-of-work hash, internal byte order. */
      readonly powHash: Buffer
      /** The block header hash — SHA-256d always, even on scrypt chains. See below. */
      readonly headerHash: Buffer
      readonly header: Buffer
      readonly coinbase: Buffer
      /** The difficulty this share actually achieved, for the miner to reconcile against. */
      readonly achievedDifficulty: number
      /** The difficulty it was credited at, which is what `pplns.ts` weights by. */
      readonly creditedDifficulty: number
      readonly isBlock: boolean
      readonly ntime: number
    }

/**
 * A key that identifies one solution, for duplicate detection.
 *
 * The four fields a miner controls, and nothing else. Two submissions agreeing on all four are the
 * same header — there is nothing left that could differ — so this is exact rather than heuristic.
 * The version is included because a version-rolling miner varies it as a fifth search dimension, and
 * omitting it would reject a genuinely distinct solution as a duplicate.
 */
export function shareKey(submission: ShareSubmission): string {
  return [
    submission.jobId,
    submission.extranonce2Hex.toLowerCase(),
    submission.ntimeHex.toLowerCase(),
    submission.nonceHex.toLowerCase(),
    (submission.versionHex ?? '').toLowerCase(),
  ].join(':')
}

export function validateShare(submission: ShareSubmission, context: ShareContext): ShareResult {
  const job = context.job

  if (!isHex(submission.extranonce2Hex, context.extranonce2Size)) {
    return reject(
      STRATUM_ERROR.OTHER,
      `extranonce2 must be ${context.extranonce2Size} bytes of hex`,
    )
  }
  if (!isHex(submission.ntimeHex, 4)) return reject(STRATUM_ERROR.OTHER, 'ntime must be 4 bytes of hex')
  if (!isHex(submission.nonceHex, 4)) return reject(STRATUM_ERROR.OTHER, 'nonce must be 4 bytes of hex')

  const ntime = Number.parseInt(submission.ntimeHex, 16)
  if (ntime < job.template.minTime) {
    return reject(STRATUM_ERROR.OTHER, `ntime ${ntime} is below the template's mintime ${job.template.minTime}`)
  }
  if (ntime > context.nowSeconds + MAX_NTIME_AHEAD_SECONDS) {
    return reject(STRATUM_ERROR.OTHER, `ntime ${ntime} is more than ${MAX_NTIME_AHEAD_SECONDS}s ahead`)
  }

  // The version the header will carry. Without version rolling it is the job's, full stop.
  let version = job.template.version >>> 0
  if (submission.versionHex !== undefined) {
    if (!isHex(submission.versionHex, 4)) return reject(STRATUM_ERROR.OTHER, 'version must be 4 bytes of hex')
    const submitted = Number.parseInt(submission.versionHex, 16) >>> 0
    const mask = context.versionMask >>> 0
    if (mask === 0) {
      return reject(STRATUM_ERROR.OTHER, 'this connection did not negotiate version rolling')
    }
    if ((submitted & ~mask) >>> 0 !== (version & ~mask) >>> 0) {
      return reject(STRATUM_ERROR.OTHER, 'the submitted version changes bits outside the negotiated mask')
    }
    version = submitted
  }

  const coinbase = coinbaseFor(job, context.extranonce1, Buffer.from(submission.extranonce2Hex, 'hex'))
  const merkleRoot = merkleRootFromBranch(coinbaseTxId(coinbase), job.merkleSteps)

  const header = buildHeader({
    version: swap32Hex(version.toString(16).padStart(8, '0')),
    prevHash: hashFromDisplay(job.template.previousBlockHashHex),
    merkleRoot,
    ntime: swap32Hex(submission.ntimeHex),
    nbits: swap32Hex(job.bitsHex),
    nonce: swap32Hex(submission.nonceHex),
  })

  // The chain's proof-of-work function — scrypt on Litecoin, SHA-256d on Bitcoin. This is the
  // dispatch `chains.ts` exists to make explicit, and `powHash` has no default branch.
  const pow = powHash(context.algorithm, header)
  const shareTarget = targetForDifficulty(context.algorithm, context.shareDifficulty)

  if (!meetsTarget(pow, shareTarget)) {
    const achieved = difficultyOfHash(context.algorithm, pow)
    return reject(
      STRATUM_ERROR.LOW_DIFFICULTY,
      `share difficulty ${achieved.toFixed(3)} is below the required ${context.shareDifficulty}`,
    )
  }

  return {
    status: 'accepted',
    powHash: pow,
    // **A block's identity is its SHA-256d header hash on every chain in this family, including
    // Litecoin.** Scrypt is the proof-of-work function only; `getblockhash` on a Litecoin node
    // returns the SHA-256d hash, and so does every explorer. Recording the scrypt digest as the
    // block hash would produce a `blocks` row whose hash matches nothing anybody can look up.
    headerHash: powHash('sha256d', header),
    header,
    coinbase,
    achievedDifficulty: difficultyOfHash(context.algorithm, pow),
    creditedDifficulty: context.shareDifficulty,
    isBlock: meetsTarget(pow, job.template.blockTarget),
    ntime,
  }
}

function reject(code: StratumErrorCode, message: string): ShareResult {
  return { status: 'rejected', code, message }
}
