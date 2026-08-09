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
 *
 * ## Why a job that is GONE still has to answer for itself (micro-org#237)
 *
 * A job leaves the history in one of two ways and, until this was written, both of them left the
 * pool answering exactly what it answers a miner that made an id up. That is the whole of #237: a
 * miner has to be able to tell "you were too slow" apart from "your submission is wrong", because
 * they are opposite instructions. The first means refetch and carry on and is nobody's fault; the
 * second means the client has a bug, and miner software counts those and stops sessions over them.
 *
 * `hearth` reached the same defect from the HTTP side — its `/mining/submit` answered 400 where it
 * meant 409 — and fixed it in `node/src/retiredtemplates.js` with a bounded ring of retired ids.
 * The split it drew is the one drawn here, in the codes Stratum has instead of status codes:
 *
 *   - a job this pool ISSUED and has since retired  → `JOB_NOT_FOUND` (21), the stale code
 *   - an id this pool never issued                  → `OTHER` (20), the same code a malformed
 *                                                     `mining.submit` already gets
 *
 * hearth refused the cheaper fix of calling every unknown id stale, and so does this. "Your work
 * was late" and "you are sending ids this pool never handed out" are different facts, and a pool
 * that answers a fabricated id with "fetch fresh work" is telling a broken client to keep going.
 *
 * hearth had to name a hole it could not close: its ring is bounded, so an id retired long enough
 * ago is forgotten and answers `unknown` again — its template ids are sixteen random bytes and it
 * has no other way to know whether it issued one. THIS registry has no such hole, because its ids
 * are a monotonic counter rendered in hex (see `push`). Every id this process ever issued is
 * therefore recognisable from the counter alone, whether or not the ring still remembers it, so a
 * retired job is answered `stale` for the life of the process and only a genuinely fabricated id
 * gets code 20. The ring is kept anyway, and only for the REASON — "the tip moved" and "this pool
 * keeps the last four jobs" are different things to tell an operator, and neither is derivable from
 * a number.
 *
 * ## Merged mining makes a job rebuildable, which nothing here previously was
 *
 * Until AuxPoW there was exactly one reason a job existed: a template arrived. A job now also gets
 * built when the *Dogecoin* tip moves under a commitment this pool already made, because the
 * commitment lives in `coinb1` and there is no way to change it without changing the coinbase, and
 * no way to change the coinbase without a new job. `setAux` is that path and it is deliberately
 * narrow — see its comment for the two rebuilds it refuses, which are far more common than the one
 * it performs.
 *
 * The consequence worth stating here is what it does NOT do. A rebuild leaves the job it displaced
 * live and submittable, because the Litecoin block those miners are working on has not changed and
 * a share against the old commitment still wins it. Only the Dogecoin half of that job is dead, and
 * the Dogecoin half was always a bonus on work that was going to happen anyway.
 */

import { assembleCoinbase, buildCoinbase, type CoinbaseParts } from './coinbase.ts'
import { auxCommitment } from './auxpow.ts'
import { stratumPrevHash, toStratumScalar } from './bytes.ts'
import { merkleSteps } from './merkle.ts'
import type { BlockTemplate } from './template.ts'
import type { AuxBlock } from './auxtemplate.ts'
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

/**
 * How many retired job ids keep their REASON, as a multiple of the live history.
 *
 * Under a steady stream of fee-improvement templates the history retires exactly one job for every
 * job it gains, so a ring the size of the history is consumed by one full turnover — and the entry
 * it would drop first belongs to the miner that has been grinding longest, which is the one likeliest
 * to still be mid-attempt. A margin is the entire point. Four turnovers rather than three or five
 * because nothing available distinguishes those; the defensible claim is only that it must be more
 * than one.
 *
 * Nothing is lost when it is exceeded. An id past the end of the ring is still recognised as one this
 * pool issued — see the header — so it is still answered `stale`; it is answered without a reason.
 */
export const RETAINED_TURNOVERS = 4

/**
 * Why a job is no longer submittable against, in the words an operator needs.
 *
 *   superseded  the tip moved under it. Its parent block is not the chain's any more, so the block
 *               it was mining cannot be won by anybody.
 *   evicted     it fell past `JOB_HISTORY` as newer templates arrived. Nothing to do with its age
 *               and nothing to do with the tip: a busy pool retires perfectly live work this way,
 *               so it must read to a miner exactly as supersession does.
 *   forgotten   this pool issued it and no longer remembers which of the two it was.
 */
export type JobRetirement = 'superseded' | 'evicted' | 'forgotten'

/** What `JobRegistry.recall` says about an id the registry does not hold. */
export interface JobRecall {
  /**
   * True when this pool issued the id, whatever else is or is not remembered about it.
   *
   * Set explicitly in both branches rather than left off one of them. Absent-and-falsy is what
   * produced micro-org#237 in the first place: "nobody thought about it here" and "this is
   * definitely not stale" were the same value, and no reviewer could tell them apart.
   */
  readonly stale: boolean
  readonly reason: JobRetirement | 'unknown'
  /** The text that goes back to the miner, over the wire, in the error member. */
  readonly message: string
}

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
  /**
   * The aux block this job's coinbase commits to, or null when it commits to none.
   *
   * Carried on the job rather than read from the source at submission time, and that is the entire
   * point of the field. `AuxTemplateSource.current` is what the pool would commit to *now*; this is
   * what this particular coinbase actually did commit to, minutes ago, and the two differ every time
   * Dogecoin finds a block. A share arriving against this job proves work over THESE bytes, so the
   * hash `submitauxblock` is called with has to come from here — asking the source would submit a
   * proof for a block the miner never committed to, which is a proof that does not verify.
   *
   * Null is ordinary. See `auxtemplate.ts`: dogecoind in initial block download, with no peers, or
   * simply unconfigured all mean mine Litecoin without a commitment.
   */
  readonly aux: AuxBlock | null
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
  readonly aux: AuxBlock | null
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
    // Built here rather than passed in already-serialised so that a job and its commitment cannot be
    // constructed out of step with each other: `job.aux` and the 44 bytes in `coinb1` come from the
    // same expression, and there is no argument a caller could get wrong independently.
    auxCommitment: options.aux === null ? undefined : auxCommitment(options.aux.hashHex),
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
    aux: options.aux,
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
  #aux: AuxBlock | null = null
  #jobs: Job[] = []
  #counter = 0
  /**
   * Retired ids and why, newest last — `Map` keeps insertion order, so eviction is oldest-first.
   *
   * Ids only. A retired job holds its whole `BlockTemplate`, transactions and all, which is the
   * expensive part and is precisely what retiring it was for; keeping one alive to answer questions
   * about itself would defeat the bound that retired it. An id is a handful of bytes.
   */
  readonly #retired = new Map<string, Exclude<JobRetirement, 'forgotten'>>()
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

  /** What the NEXT job will commit to. `current.aux` is what the current one already did. */
  get aux(): AuxBlock | null {
    return this.#aux
  }

  /**
   * Take a fresh aux block from the source, and rebuild the current job if the old commitment has
   * stopped being worth anything.
   *
   * Returns the rebuilt job, which the caller must broadcast, or null when nothing needed doing —
   * which is the common case and is the reason this method exists rather than a plain setter.
   *
   * ## A new aux hash is NOT a reason to rebuild. A new aux TIP is.
   *
   * `createauxblock` hands back a different hash every time dogecoind reassembles its block, which is
   * every time its mempool turns over — several times a minute. But `mapNewBlock` is only cleared on
   * a **tip** change (see `auxtemplate.ts`, quoting `AuxMiningCreateBlock`), so every one of those
   * hashes stays submittable until DOGE actually finds a block. Rebuilding on each new hash would
   * therefore issue a new job every few seconds, churn `JOB_HISTORY` fast enough to evict work miners
   * are still grinding on, and buy exactly nothing: the hash already committed to is still in the
   * node's map and still wins the same Dogecoin block.
   *
   * So the trigger is the aux chain's own previous-block hash moving, which is the one event that
   * turns the committed hash into `block hash unknown`.
   *
   * ## Losing the aux block is not a reason to rebuild either
   *
   * When the source goes to null — dogecoind restarted, lost its peers, fell back into initial block
   * download — the commitment already in `coinb1` is inert, not harmful. It costs 44 bytes of a
   * scriptSig that has room for them and it cannot make the Litecoin block any less valid. Rebuilding
   * to strip it would spend a job to remove something that is not doing damage, and would throw away
   * the commitment in the case where dogecoind comes back with the same tip and the hash was live the
   * whole time. Null propagates to the next job the tip change builds, and no sooner.
   */
  setAux(aux: AuxBlock | null): Job | null {
    this.#aux = aux
    // Nothing to rebuild, and nothing lost: the next `push` reads `#aux` and commits to whatever it
    // then holds.
    if (aux === null) return null
    const current = this.#jobs[0]
    if (current === undefined) return null
    // Same aux tip: the hash in `coinb1` is still in dogecoind's map and still wins the same block.
    if (current.aux !== null && current.aux.previousBlockHashHex === aux.previousBlockHashHex) return null
    // Either the aux tip moved under the commitment, or this job has none and could have one. Both
    // are worth a job; neither is worth telling miners to discard Litecoin work, hence `false`.
    return this.#install(current.template, false)
  }

  get(id: string): Job | null {
    return this.#jobs.find((job) => job.id === id) ?? null
  }

  /** How many retired ids still carry a reason. Test and operational visibility only. */
  get remembered(): number {
    return this.#retired.size
  }

  /**
   * What to tell a miner that submitted against an id this registry does not hold — micro-org#237.
   *
   * Only ever called after `get` has returned null; a live job is not a question. The two answers
   * are the two facts, and they are not two shades of one refusal:
   *
   *   stale     the work was late. Not a fault, not a strike, refetch and carry on.
   *   unknown   this pool never issued that id. The client is confused, is talking to the wrong
   *             pool, or is fabricating ids, and telling it to fetch fresh work would be telling a
   *             broken client that it is fine.
   */
  recall(id: string): JobRecall {
    const reason = this.#retired.get(id)
    if (reason !== undefined) return { stale: true, reason, message: this.#message(reason) }
    if (this.#wasIssued(id)) return { stale: true, reason: 'forgotten', message: this.#message('forgotten') }
    return {
      stale: false,
      // Named rather than guessed at. An operator who reads "not issued by this pool" about an id
      // they know WAS issued would be right to stop trusting the stale answers too, so this claim
      // has to be one the registry can actually make — which, its ids being a counter, it can.
      reason: 'unknown',
      message: 'unknown job — this id was not issued by this pool',
    }
  }

  /**
   * Did this process hand out this exact string?
   *
   * Ids are `#counter.toString(16)` and the counter only ever climbs, so every id ever issued is
   * every canonical lowercase hex rendering of 1 through the counter. Compared back through
   * `toString(16)` rather than by value alone so that `0x3`, `03`, `+3`, ` 3` and `3 ` — all of
   * which `parseInt` accepts as three — are not credited as ids the pool issued. It issued `3`.
   *
   * A restart resets the counter, but a restart also drops every connection, so no miner is holding
   * an id from the previous process to submit against this one.
   */
  #wasIssued(id: string): boolean {
    const n = Number.parseInt(id, 16)
    return Number.isSafeInteger(n) && n >= 1 && n <= this.#counter && n.toString(16) === id
  }

  #message(reason: JobRetirement): string {
    if (reason === 'superseded') return 'stale job — the tip moved under it; fetch fresh work'
    if (reason === 'evicted') {
      // Interpolated rather than written out, so this can never quote a history this registry has
      // since been configured away from.
      return `stale job — this pool keeps the last ${this.#history} jobs; fetch fresh work`
    }
    return 'stale job — issued by this pool and retired too long ago to say why; fetch fresh work'
  }

  #retire(id: string, reason: Exclude<JobRetirement, 'forgotten'>): void {
    this.#retired.set(id, reason)
    while (this.#retired.size > this.#history * RETAINED_TURNOVERS) {
      const oldest = this.#retired.keys().next()
      if (oldest.done) break
      this.#retired.delete(oldest.value)
    }
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
    const previous = this.#jobs[0]
    const cleanJobs = !previous || previous.template.previousBlockHashHex !== template.previousBlockHashHex
    return this.#install(template, cleanJobs)
  }

  /**
   * Build a job for a template, retire whatever that displaces, and return it.
   *
   * Shared by `push` and `setAux` because the two differ in exactly one thing — who decides
   * `cleanJobs` — and in nothing else. A separate rebuild path would be a second place for the
   * retirement bookkeeping to be wrong, and the retirement bookkeeping is what answers a miner whose
   * share arrived late.
   */
  #install(template: BlockTemplate, cleanJobs: boolean): Job {
    if (this.#payoutScriptHex === null) {
      throw new Error(`no payout script is set for ${this.chain}; the node has not validated the payout address yet`)
    }

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
      aux: this.#aux,
      createdAt: new Date(this.#now()),
    })

    // A new tip invalidates history outright. Every job built on the old parent is now mining a
    // block that cannot be won, so keeping them would credit shares for work with no chance — and
    // the miners were told to drop them by `clean_jobs` in the same breath.
    const kept = cleanJobs ? [job] : [job, ...this.#jobs].slice(0, this.#history)

    // Whatever fell out is RETIRED, not discarded: a share against it is still in flight somewhere
    // and has to be answered as late rather than as wrong — micro-org#237.
    //
    // Oldest first — `#jobs` is newest-first, hence the reverse — so that the ring's insertion order
    // always reads as time of retirement, which is the thing its eviction rule assumes. Measured
    // 2026-08-09: with these bounds that ordering is not observable from outside, because a tip
    // change retires at most `#history` jobs at once and the ring holds four times that, so every
    // member of a batch outlives every entry already in it whichever way round they go in. Written
    // this way regardless, because the alternative is a structure whose order is right by accident
    // of two constants that are allowed to move.
    const keptIds = new Set(kept.map((held) => held.id))
    for (let index = this.#jobs.length - 1; index >= 0; index -= 1) {
      const retiring = this.#jobs[index]
      if (retiring && !keptIds.has(retiring.id)) this.#retire(retiring.id, cleanJobs ? 'superseded' : 'evicted')
    }

    this.#jobs = kept
    return job
  }
}
