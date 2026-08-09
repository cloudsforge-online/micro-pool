/**
 * Jobs: a template plus a coinbase plus a merkle branch, in the shape `mining.notify` sends and in
 * the shape a submitted share has to be checked against.
 *
 * A job is built once per template and shared by every connected miner. What is *not* shared is the
 * extranonce1 — that is per connection, assigned at `mining.subscribe`, and it is the reason two
 * miners on the same job never search the same space. So the job holds `coinb1` and `coinb2` with
 * the miner's bytes missing from between them, and the coinbase is only assembled when a share
 * arrives and the pool knows whose extranonce1 to put there.
 *
 * ## Why old jobs are kept rather than discarded on the next template
 *
 * A share is in flight the moment before a new block arrives. The miner had a valid job, did real
 * work, and the answer arrives a few hundred milliseconds after the pool moved on. If the registry
 * held only the current job the pool would answer "job not found" and the miner would see a reject
 * for work it did honestly. Keeping a bounded history lets those land: they are still credited
 * against the share target, and only the *block* they can no longer be is lost — which was never
 * theirs to lose, because the block they were mining was already found by somebody else.
 *
 * What must NOT happen is accepting a share against a job whose parent block is many blocks old,
 * because that is a miner (or a mis-set client) burning the pool's accounting on work with no chance
 * of ever being a block. `JOB_HISTORY` bounds it, and `clean_jobs` on a new tip tells honest miners
 * to drop everything anyway.
 */

import { assembleCoinbase, buildCoinbase, type CoinbaseParts } from './coinbase.ts'
import { stratumPrevHash, toStratumScalar } from './bytes.ts'
import { merkleSteps } from './merkle.ts'
import type { BlockTemplate } from './template.ts'
import type { PoolChainId } from './chains.ts'

/**
 * How many jobs stay valid for submission.
 *
 * Four is a compromise with a reason on each side: too few and a miner with a slow link gets its
 * honest late shares rejected; too many and a pool credits work against templates whose tip is
 * several blocks in the past. At one template every ten seconds under longpoll, four is roughly the
 * last half-minute — comfortably longer than any real submission delay and far shorter than a block
 * interval on either chain.
 */
export const JOB_HISTORY = 4

export interface Job {
  /** The `mining.notify` job id. Opaque to the miner; it comes back verbatim on `mining.submit`. */
  readonly id: string
  readonly chain: PoolChainId
  readonly height: number
  /** The template this was built from, kept whole because `submitblock` needs its transactions. */
  readonly template: BlockTemplate
  readonly coinbase: CoinbaseParts
  /** Internal byte order. The order `merkleRootFromBranch` folds in. */
  readonly merkleSteps: readonly Buffer[]
  /** The wire form of the above: display-order hex, as `mining.notify` carries it. */
  readonly merkleStepsHex: readonly string[]
  readonly prevHashStratum: string
  readonly versionHex: string
  readonly bitsHex: string
  readonly ntimeHex: string
  /** True when this job's parent block differs from the previous job's — a real new tip. */
  readonly cleanJobs: boolean
  readonly createdAt: Date
}

export interface JobBuildOptions {
  readonly chain: PoolChainId
  readonly template: BlockTemplate
  readonly payoutScriptHex: string
  readonly tag: Buffer
  readonly extranonce1Size: number
  readonly extranonce2Size: number
  readonly id: string
  readonly cleanJobs: boolean
  readonly createdAt: Date
}

export function buildJob(options: JobBuildOptions): Job {
  const template = options.template
  const coinbase = buildCoinbase({
    height: template.height,
    coinbaseValue: template.coinbaseValue,
    payoutScriptHex: options.payoutScriptHex,
    witnessCommitmentHex: template.witnessCommitmentHex,
    tag: options.tag,
    extranonce1Size: options.extranonce1Size,
    extranonce2Size: options.extranonce2Size,
  })

  const steps = merkleSteps(template.transactions.map((tx) => tx.txid))

  return {
    id: options.id,
    chain: options.chain,
    height: template.height,
    template,
    coinbase,
    merkleSteps: steps,
    // `mining.notify` carries the branch in the same order a block explorer prints a hash: the
    // reverse of the order it is folded in. Sending internal order here produces a miner that
    // computes a different merkle root from the pool for the same coinbase, which shows up as
    // every share being rejected and nothing else.
    merkleStepsHex: steps.map((step) => Buffer.from(step).reverse().toString('hex')),
    prevHashStratum: stratumPrevHash(template.previousBlockHashHex),
    versionHex: toStratumScalar(template.version >>> 0),
    bitsHex: template.bitsHex,
    ntimeHex: toStratumScalar(template.curTime),
    cleanJobs: options.cleanJobs,
    createdAt: options.createdAt,
  }
}

/**
 * The `params` array of a `mining.notify`, in the order the protocol fixes.
 *
 * Positional, undocumented outside implementations, and every field is a string. Written out with a
 * name against each position because the failure mode of getting one wrong is not an error — it is
 * a miner that hashes a header nobody asked for.
 */
export function notifyParams(job: Job, cleanJobs: boolean): readonly unknown[] {
  return [
    job.id,
    job.prevHashStratum,
    job.coinbase.coinb1.toString('hex'),
    job.coinbase.coinb2.toString('hex'),
    job.merkleStepsHex,
    job.versionHex,
    job.bitsHex,
    job.ntimeHex,
    cleanJobs,
  ]
}

/** The coinbase for one connection's extranonce1 and one submission's extranonce2. */
export function coinbaseFor(job: Job, extranonce1: Buffer, extranonce2: Buffer): Buffer {
  return assembleCoinbase(job.coinbase, extranonce1, extranonce2)
}

export interface JobRegistryOptions {
  readonly chain: PoolChainId
  readonly tag: Buffer
  readonly extranonce1Size: number
  readonly extranonce2Size: number
  readonly history?: number
  readonly now?: () => number
}

/**
 * The jobs one chain currently considers valid, newest first.
 *
 * The payout script is set after construction, by `setPayoutScript`, because it comes from the node
 * and the node is asked at boot. A registry with no payout script refuses to build a job rather than
 * building one that pays somewhere else — there is no default that could be right.
 */
export class JobRegistry {
  readonly chain: PoolChainId
  #payoutScriptHex: string | null = null
  #jobs: Job[] = []
  #counter = 0
  readonly #options: JobRegistryOptions
  readonly #history: number
  readonly #now: () => number

  constructor(options: JobRegistryOptions) {
    this.chain = options.chain
    this.#options = options
    this.#history = options.history ?? JOB_HISTORY
    this.#now = options.now ?? (() => Date.now())
  }

  setPayoutScript(scriptHex: string): void {
    this.#payoutScriptHex = scriptHex
  }

  get current(): Job | null {
    return this.#jobs[0] ?? null
  }

  get(id: string): Job | null {
    return this.#jobs.find((job) => job.id === id) ?? null
  }

  /**
   * Build and install a job for a new template.
   *
   * `cleanJobs` is true when the parent block changed, and only then. Setting it on every job would
   * make miners throw away in-flight work every ten seconds for no reason — the point of a
   * fee-improvement template is that a miner may switch to it at leisure, and the point of a new-tip
   * template is that it must not keep working on the old one for even a second longer.
   */
  push(template: BlockTemplate): Job {
    if (this.#payoutScriptHex === null) {
      throw new Error(`no payout script is set for ${this.chain}; the node has not validated the payout address yet`)
    }
    const previous = this.#jobs[0]
    const cleanJobs = !previous || previous.template.previousBlockHashHex !== template.previousBlockHashHex

    this.#counter += 1
    const job = buildJob({
      chain: this.chain,
      template,
      payoutScriptHex: this.#payoutScriptHex,
      tag: this.#options.tag,
      extranonce1Size: this.#options.extranonce1Size,
      extranonce2Size: this.#options.extranonce2Size,
      // Hex, monotonic, and prefixed per process start is unnecessary: a job id is only ever
      // interpreted by this process, and a restart drops every connection anyway.
      id: this.#counter.toString(16),
      cleanJobs,
      createdAt: new Date(this.#now()),
    })

    // A new tip invalidates history outright. Every job built on the old parent is now mining a
    // block that cannot be won, so keeping them would credit shares for work with no chance — and
    // the miners were told to drop them by `clean_jobs` in the same breath.
    this.#jobs = cleanJobs ? [job] : [job, ...this.#jobs].slice(0, this.#history)
    return job
  }
}
