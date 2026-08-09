/**
 * One miner connection's state machine, with no socket in it.
 *
 * Everything a Stratum connection does — subscribing, authorising, being told a difficulty, being
 * pushed a job, submitting a share — is here, driven by parsed JSON objects in and a `send` callback
 * out. `stratum.ts` owns the TCP socket and the line framing and does nothing else.
 *
 * That split is not tidiness. The protocol's interesting behaviour is all in the ORDER of things:
 * a submit before a subscribe, a submit against a job issued at a difficulty that has since
 * changed, a duplicate arriving after the job has aged out. Every one of those is a few lines to
 * write as a test against this class and a considerable production to set up against a real socket,
 * and the ones nobody tests are the ones that reject an honest miner's work.
 *
 * ## The difficulty race, which is the subtle one
 *
 * `mining.set_difficulty` is a notification. It does not have a reply, so there is no moment at
 * which the pool knows the miner has adopted it — and the miner is mid-nonce-range when it arrives.
 * A share computed against the old difficulty can therefore land after the new one is in force,
 * legitimately.
 *
 * Resolving it by "whatever difficulty is current" rejects honest work every time difficulty goes
 * up. Resolving it by "whatever difficulty was current when the job was issued" credits too much
 * every time difficulty goes down. **So each job issuance is stamped with the difficulty in effect
 * when it was sent to THIS connection, and a share is judged at the lower of that and the current
 * one — and credited at the threshold it was judged at.** The miner is never rejected for work it
 * was entitled to do, and the pool never credits more than the work proves. The share's actually
 * achieved difficulty is recorded separately, so the miner can still reconcile.
 */

import { difficultyUnits } from './pplns.ts'
import { notifyParams, type Job, type JobRegistry } from './work.ts'
import { shareKey, validateShare, STRATUM_ERROR, type ShareResult } from './validate.ts'
import { Vardiff, roundDifficulty, type VardiffOptions } from './vardiff.ts'
import { nameFor, type PoolChainId, type PowAlgorithm } from './chains.ts'
import type { AddressVerdict } from './payoutaddress.ts'

export interface OutgoingMessage {
  readonly id: number | string | null
  readonly result?: unknown
  readonly error?: readonly [number, string, unknown] | null
  readonly method?: string
  readonly params?: readonly unknown[]
}

export interface AcceptedShare {
  readonly chain: PoolChainId
  readonly account: string
  readonly worker: string
  readonly jobId: string
  readonly height: number
  readonly difficultyUnits: bigint
  readonly achievedUnits: bigint
  readonly isBlock: boolean
}

export interface FoundBlock {
  readonly job: Job
  readonly header: Buffer
  readonly coinbase: Buffer
  readonly headerHash: Buffer
  readonly account: string
  readonly worker: string
  readonly creditedDifficulty: number
}

export interface SessionDeps {
  readonly chain: PoolChainId
  readonly algorithm: PowAlgorithm
  readonly registry: JobRegistry
  readonly extranonce1: Buffer
  readonly extranonce2Size: number
  readonly initialDifficulty: number
  readonly minDifficulty: number
  readonly maxDifficulty: number
  readonly vardiff: VardiffOptions
  readonly now: () => number
  readonly send: (message: OutgoingMessage) => void
  readonly onAcceptedShare: (share: AcceptedShare) => void
  readonly onBlock: (block: FoundBlock) => void
  /** Counters. Kept as a callback so `telemetry` does not have to exist to test this file. */
  readonly onOutcome?: ((outcome: 'accepted' | 'rejected', code: number | null) => void) | undefined
  /**
   * Spend a mining ticket presented in the `mining.authorize` password field, or refuse it.
   *
   * **Present only on the WebSocket transport, and mandatory there.** Its presence is what switches
   * `#authorize` from "the username is the identity" to "the ticket is the identity"; its absence is
   * raw TCP, unchanged. There is no third mode, and in particular there is no transport on which a
   * ticket is optional — a connection that could authorise either way would let a browser choose to
   * mine as somebody else's payout address by typing it.
   *
   * The function returns the account and worker labels. It does not take them.
   */
  readonly redeemTicket?: ((secret: string) => { account: string; worker: string } | null) | undefined
  /**
   * Ask the chain's own node whether a stratum username is an address it would pay to.
   *
   * **Consulted on the raw TCP path only**, which is the only path where the account is a string the
   * miner chose. On the browser transport the account is a `cf-…` label this service minted for an
   * estate user, it is not an address, and putting it to `validateaddress` would refuse every
   * browser miner there has ever been. The structural guarantee is the same one that decides which
   * field carries the identity: `redeemTicket` present means ticket, and the ticket path never
   * reaches this.
   *
   * Absent means no check, which is what every existing test and every previously written caller
   * gets. `AddressChecker` in `payoutaddress.ts` is the production implementation and its header
   * carries the reasoning, including why an unreachable node is `'unavailable'` rather than a
   * refusal. micro-org#286.
   */
  readonly checkPayoutAddress?: ((address: string) => Promise<AddressVerdict>) | undefined
}

/**
 * The version bits a miner may roll, when it asks.
 *
 * `0x1fffe000` is the range BIP320 set aside for exactly this — the bits no consensus rule reads —
 * and it is what every SHA-256d firmware asks for. The mask is intersected with the miner's request
 * rather than taken from it: a client asking for a wider mask would otherwise be granted the right
 * to set version bits that signal for soft forks, using blocks this pool paid for.
 */
export const VERSION_ROLLING_MASK = 0x1fffe000

/**
 * How many recent solutions a connection remembers for duplicate detection.
 *
 * A duplicate can only be a duplicate of a share against a job that is still valid, and
 * `JOB_HISTORY` bounds that to a handful of jobs. This is generous relative to that, and bounded
 * because an unbounded set is a memory leak with a miner's uptime as its growth rate.
 */
const SEEN_SHARE_LIMIT = 4_096

/**
 * Requests held while an authorisation is waiting on the node.
 *
 * `mining.authorize` became able to await an RPC in micro-org#286, and everything that arrives in
 * that window has to go somewhere. Answering it immediately would be wrong — a `mining.submit` sent
 * straight after an authorise would be told "authorize before submitting", which is a lie about a
 * connection that did authorise — so it is queued and replayed in order.
 *
 * Bounded because the queue is filled by whoever is connecting. A client that pipelines is answered
 * beyond this point rather than buffered; the limit is far above anything a real miner sends between
 * an authorise and its reply, which is nothing.
 */
const PENDING_LIMIT = 32

interface Incoming {
  readonly id: number | string | null
  readonly method: string
  readonly params: readonly unknown[]
}

export class Session {
  readonly #deps: SessionDeps
  #subscribed = false
  #account: string | null = null
  #worker = ''
  #vardiff: Vardiff
  #versionMask = 0
  /** Difficulty in force for this connection when each job was pushed to it. See the header note. */
  readonly #jobDifficulty = new Map<string, number>()
  readonly #seen = new Set<string>()
  #accepted = 0
  #rejected = 0
  /** Non-null exactly while an address check is outstanding. See `PENDING_LIMIT`. */
  #pending: Incoming[] | null = null

  constructor(deps: SessionDeps) {
    this.#deps = deps
    this.#vardiff = new Vardiff({
      initialDifficulty: deps.initialDifficulty,
      nowMs: deps.now(),
      options: deps.vardiff,
    })
  }

  get authorised(): boolean {
    return this.#account !== null
  }

  get account(): string | null {
    return this.#account
  }

  get worker(): string {
    return this.#worker
  }

  get difficulty(): number {
    return this.#vardiff.difficulty
  }

  get counts(): { accepted: number; rejected: number } {
    return { accepted: this.#accepted, rejected: this.#rejected }
  }

  /**
   * Handle one parsed request.
   *
   * A request with no recognised method is answered with error 20 rather than ignored. Silence on an
   * unknown method is how a miner ends up waiting forever for a reply to something the pool decided
   * not to answer.
   */
  handle(message: Incoming): void {
    if (this.#pending !== null) {
      if (this.#pending.length >= PENDING_LIMIT) {
        // Not silence and not a disconnect: the miner is told, with an id it can match, that this
        // one was not processed. A connection that gets here is pipelining hard enough that
        // something is wrong at its end, and it needs to see that rather than to wait.
        this.#deps.send({
          id: message.id,
          result: null,
          error: [STRATUM_ERROR.OTHER, 'too many requests while authorization is still in flight', null],
        })
        return
      }
      this.#pending.push(message)
      return
    }
    this.#dispatch(message)
  }

  #dispatch(message: Incoming): void {
    switch (message.method) {
      case 'mining.configure':
        this.#configure(message.id, message.params)
        return
      case 'mining.subscribe':
        this.#subscribe(message.id)
        return
      case 'mining.authorize':
        this.#authorize(message.id, message.params)
        return
      case 'mining.submit':
        this.#submit(message.id, message.params)
        return
      case 'mining.extranonce.subscribe':
        // "Tell me if my extranonce1 changes." This pool never changes one — it is assigned at
        // subscribe and held for the life of the connection — so agreeing costs nothing and is
        // true. Refusing makes some firmware reconnect in a loop looking for a pool that agrees.
        this.#deps.send({ id: message.id, result: true, error: null })
        return
      case 'mining.suggest_difficulty':
        this.#suggestDifficulty(message.id, message.params)
        return
      default:
        this.#deps.send({
          id: message.id,
          result: null,
          error: [STRATUM_ERROR.OTHER, `unknown method ${message.method}`, null],
        })
    }
  }

  #configure(id: number | string | null, params: readonly unknown[]): void {
    // params[0] is the list of extensions the miner wants; params[1] their parameters. Only
    // version-rolling is answered — an extension answered `true` that the pool does not implement
    // is worse than one answered `false`, because the miner then relies on it.
    const requested = Array.isArray(params[0]) ? (params[0] as unknown[]) : []
    const options = typeof params[1] === 'object' && params[1] !== null ? (params[1] as Record<string, unknown>) : {}
    const result: Record<string, unknown> = {}

    if (requested.includes('version-rolling')) {
      const askedRaw = options['version-rolling.mask']
      const asked = typeof askedRaw === 'string' && /^[0-9a-fA-F]{8}$/.test(askedRaw)
        ? Number.parseInt(askedRaw, 16) >>> 0
        : VERSION_ROLLING_MASK
      this.#versionMask = (asked & VERSION_ROLLING_MASK) >>> 0
      result['version-rolling'] = this.#versionMask !== 0
      result['version-rolling.mask'] = this.#versionMask.toString(16).padStart(8, '0')
    }
    for (const extension of requested) {
      if (typeof extension === 'string' && !(extension in result)) result[extension] = false
    }
    this.#deps.send({ id, result, error: null })
  }

  #subscribe(id: number | string | null): void {
    this.#subscribed = true
    // The reply is positional and its first element is a list of [notification, subscription id]
    // pairs. The subscription ids are never used for anything by either side in practice, but
    // firmware parses the structure strictly, so it is sent in the shape everything expects.
    const subscriptionId = this.#deps.extranonce1.toString('hex')
    this.#deps.send({
      id,
      result: [
        [
          ['mining.set_difficulty', `${subscriptionId}1`],
          ['mining.notify', `${subscriptionId}2`],
        ],
        subscriptionId,
        this.#deps.extranonce2Size,
      ],
      error: null,
    })
  }

  /**
   * `mining.authorize`.
   *
   * The username is the miner's identity and the password is ignored — that is the protocol as
   * deployed, not a shortcut. Every pool in the field treats the password as a free-text field for
   * client-side options, hardware sends `x` by default, and a pool that rejected a wrong one would
   * reject essentially every miner. **Because it is ignored it is never read, never stored and never
   * logged**, which is the only handling of an unused credential field that is safe.
   *
   * The username splits on the first dot: `account.worker`. A username with no dot is an account
   * with a single unnamed worker.
   *
   * ## The account half is then put to the node, which is what micro-org#286 added
   *
   * `parseWorkerName` decides what may be stored; it does not and cannot decide what may be paid.
   * When `checkPayoutAddress` is configured the account is checked with the chain's own
   * `validateaddress` before the miner is authorised — see `#authorizeCheckedAddress` below and the
   * header of `payoutaddress.ts`. `parseWorkerName` itself is unchanged and still runs first, since
   * a username the pool would refuse to store must not reach the node at all.
   *
   * ## On the WebSocket transport it is the other way round, and that is not an inconsistency
   *
   * When `redeemTicket` is present — which is only ever on the browser transport — the password is
   * the identity and the USERNAME is ignored. The reversal is forced by what the two transports can
   * prove. A raw TCP miner has no estate account and cannot be asked for one; their username is a
   * payout address they chose, and the pool takes their word for it because there is nothing else to
   * take. A browser miner has just presented an estate access token to `POST /v1/pool/ticket` and
   * been handed a value that names an account this service minted, so taking their word for anything
   * would be strictly worse information.
   *
   * **The password is still never read as a password, never stored and never logged.** It is looked
   * up by equality in an in-memory map and then forgotten, and it appears in no error message: a
   * failure says the ticket was refused and does not repeat the value, because a refusal is the log
   * line anything on the internet can make this process write.
   */
  #authorize(id: number | string | null, params: readonly unknown[]): void {
    const redeem = this.#deps.redeemTicket
    if (redeem !== undefined) {
      this.#authorizeWithTicket(id, params, redeem)
      return
    }
    const username = typeof params[0] === 'string' ? params[0].trim() : ''
    if (username === '') {
      this.#deps.send({ id, result: false, error: [STRATUM_ERROR.UNAUTHORIZED, 'a worker name is required', null] })
      return
    }
    const parsed = parseWorkerName(username)
    if (parsed === null) {
      this.#deps.send({
        id,
        result: false,
        error: [STRATUM_ERROR.UNAUTHORIZED, 'the worker name contains characters this pool will not store', null],
      })
      return
    }
    const check = this.#deps.checkPayoutAddress
    if (check === undefined) {
      this.#account = parsed.account
      this.#worker = parsed.worker
      this.#completeAuthorize(id)
      return
    }
    this.#authorizeCheckedAddress(id, parsed, check)
  }

  /**
   * The raw TCP path with the node consulted about the payout address. micro-org#286.
   *
   * A stratum username on this transport IS a payout address — it is the only thing the pool knows
   * about the miner and the only place a payment could go — and until now it was accepted on the
   * strength of `parseWorkerName`, which is a check on what may be STORED and not on what may be
   * PAID. This service already refuses to open its stratum port until the node has validated the
   * pool's own payout address (`chainservice.ts`, `payoutScriptFor` in `template.ts`); asking the
   * same node the same question about the miner's address is the missing half of that.
   *
   * Everything arriving while the node is being asked is queued rather than answered, because the
   * one wrong answer available here is to tell a miner who did authorise that they did not.
   */
  #authorizeCheckedAddress(
    id: number | string | null,
    parsed: { account: string; worker: string },
    check: (address: string) => Promise<AddressVerdict>,
  ): void {
    this.#pending = []
    const settle = (verdict: AddressVerdict): void => {
      if (verdict === 'invalid') {
        this.#deps.send({
          id,
          result: false,
          error: [
            STRATUM_ERROR.UNAUTHORIZED,
            // Says what is wrong AND what the field is for, because the commonest cause of this is
            // a miner that has an address for a different chain in it, and the second commonest is
            // a worker label typed where the address goes.
            `${nameFor(this.#deps.chain)} does not recognise that payout address — the username must be` +
              ' the address you want paid at, optionally followed by .worker',
            null,
          ],
        })
        this.#drain()
        return
      }
      if (verdict === 'unavailable') {
        // Fail open, and say so. `payoutaddress.ts` carries the argument; the short form is that the
        // listener deliberately stays up while the node is away, so refusing here would disconnect
        // every rig that reconnects during an operator's node problem, for a fault that is not the
        // miner's — while letting them through costs a share row against an address that will be
        // checked again on their next connection and cannot be paid before it is. The counter and
        // the log line for it are raised by `AddressChecker` itself, which is the only place that
        // knows the difference between a fresh unavailable answer and a cached one.
      }
      this.#account = parsed.account
      this.#worker = parsed.worker
      this.#completeAuthorize(id)
      this.#drain()
    }

    void check(parsed.account).then(settle, () => {
      // The checker does not throw — it returns a verdict for every outcome — but a dependency that
      // rejects must not leave this connection queueing forever with no reply. Treated as the node
      // being unreachable, which is the same posture for the same reason.
      settle('unavailable')
    })
  }

  /**
   * Replay what arrived while an authorisation was outstanding, in the order it arrived.
   *
   * Re-entrant on purpose: a queued message can start a second authorisation, and the rest of the
   * queue then has to go back behind it rather than being processed against a half-settled session.
   */
  #drain(): void {
    const queued = this.#pending ?? []
    this.#pending = null
    // Back through the front door rather than straight to `#dispatch`, which is what makes this
    // re-entrant for free: if a replayed message starts a second authorisation, `handle` sees the
    // queue re-opened and puts the remainder behind it, exactly as it would for a live one.
    for (const message of queued) this.handle(message)
  }

  /**
   * `mining.authorize` on the browser transport: the password is a ticket and nothing else is read.
   *
   * Refusal is one message for every cause — no ticket, an unknown one, an expired one, one already
   * spent. `tickets.ts` gives the reason: distinguishing them would let anybody holding a candidate
   * value learn whether it was ever real, and an honest client does the same thing in all four cases,
   * which is ask for another ticket.
   */
  #authorizeWithTicket(
    id: number | string | null,
    params: readonly unknown[],
    redeem: (secret: string) => { account: string; worker: string } | null,
  ): void {
    const presented = typeof params[1] === 'string' ? params[1].trim() : ''
    const redeemed = presented === '' ? null : redeem(presented)
    if (redeemed === null) {
      this.#deps.send({
        id,
        result: false,
        error: [
          STRATUM_ERROR.UNAUTHORIZED,
          // Says what to do and repeats nothing that was presented.
          'a mining ticket is required — get one from POST /v1/pool/ticket and send it as the password',
          null,
        ],
      })
      return
    }
    this.#account = redeemed.account
    this.#worker = redeemed.worker
    this.#completeAuthorize(id)
  }

  /** The tail both authorisation paths share: say yes, set a difficulty, then hand out work. */
  #completeAuthorize(id: number | string | null): void {
    this.#deps.send({ id, result: true, error: null })

    // Difficulty first, then work. A miner that receives a job before it has been told a difficulty
    // assumes 1, which on either of these chains means a flood of shares from anything modern.
    this.#deps.send({ id: null, method: 'mining.set_difficulty', params: [this.#vardiff.difficulty] })
    const job = this.#deps.registry.current
    if (job) this.pushJob(job, true)
  }

  /**
   * `mining.suggest_difficulty`: the miner's own opinion of what it can hit.
   *
   * Taken as a starting point and clamped, not obeyed. It is genuinely useful — a miner knows its
   * own hashrate and vardiff would otherwise spend several windows discovering it — but it is also
   * a number from the other side of the connection, and a suggestion of 0.000001 from a
   * misconfigured client would flood the pool with worthless shares.
   */
  #suggestDifficulty(id: number | string | null, params: readonly unknown[]): void {
    const suggested = typeof params[0] === 'number' ? params[0] : Number.NaN
    if (!Number.isFinite(suggested) || suggested <= 0) {
      this.#deps.send({ id, result: false, error: [STRATUM_ERROR.OTHER, 'a positive difficulty is required', null] })
      return
    }
    const clamped = roundDifficulty(
      Math.min(Math.max(suggested, this.#deps.minDifficulty), this.#deps.maxDifficulty),
    )
    this.#vardiff = new Vardiff({
      initialDifficulty: clamped,
      nowMs: this.#deps.now(),
      options: this.#deps.vardiff,
    })
    this.#deps.send({ id, result: true, error: null })
    this.#deps.send({ id: null, method: 'mining.set_difficulty', params: [this.#vardiff.difficulty] })
  }

  /**
   * Push a job to this connection, stamping the difficulty it is issued at.
   *
   * Also the vardiff clock. A new job arriving is the natural moment to reconsider difficulty —
   * it happens on every template, which is often enough to be responsive and rare enough not to
   * churn — and it is the path by which a connection that has submitted NOTHING gets its difficulty
   * walked down. See `vardiff.ts`: that miner is invisible to any retarget rule driven by shares.
   */
  pushJob(job: Job, cleanJobs: boolean): void {
    if (!this.#subscribed || this.#account === null) return

    const retargeted = this.#vardiff.onIdle(this.#deps.now())
    if (retargeted !== null) {
      this.#deps.send({ id: null, method: 'mining.set_difficulty', params: [retargeted] })
    }

    this.#jobDifficulty.set(job.id, this.#vardiff.difficulty)
    // Bounded the same way the job registry is: a stamp for a job that can no longer be submitted
    // against is a stamp nothing will ever read.
    if (this.#jobDifficulty.size > 32) {
      const oldest = this.#jobDifficulty.keys().next()
      if (!oldest.done) this.#jobDifficulty.delete(oldest.value)
    }

    this.#deps.send({ id: null, method: 'mining.notify', params: notifyParams(job, cleanJobs) })
  }

  #submit(id: number | string | null, params: readonly unknown[]): void {
    if (!this.#subscribed) {
      this.#reject(id, STRATUM_ERROR.NOT_SUBSCRIBED, 'subscribe before submitting')
      return
    }
    const account = this.#account
    if (account === null) {
      this.#reject(id, STRATUM_ERROR.UNAUTHORIZED, 'authorize before submitting')
      return
    }

    const [, jobIdRaw, extranonce2Raw, ntimeRaw, nonceRaw, versionRaw] = params
    if (
      typeof jobIdRaw !== 'string' ||
      typeof extranonce2Raw !== 'string' ||
      typeof ntimeRaw !== 'string' ||
      typeof nonceRaw !== 'string'
    ) {
      this.#reject(id, STRATUM_ERROR.OTHER, 'mining.submit takes worker, job id, extranonce2, ntime and nonce')
      return
    }

    const submission = {
      jobId: jobIdRaw,
      extranonce2Hex: extranonce2Raw,
      ntimeHex: ntimeRaw,
      nonceHex: nonceRaw,
      versionHex: typeof versionRaw === 'string' ? versionRaw : undefined,
    }

    const job = this.#deps.registry.get(jobIdRaw)
    if (!job) {
      // Two different facts, and until micro-org#237 they got one answer. A job this pool issued and
      // has since retired is STALE — the miner did real work that arrived late, which is not a
      // fault and which code 21 is the protocol's word for. An id this pool never issued is not
      // stale, and telling a client that fabricates ids to "fetch fresh work" tells it it is fine;
      // it gets code 20, the same answer a malformed submit gets a few lines up. `recall` in
      // `work.ts` draws the line and says why it can.
      const gone = this.#deps.registry.recall(jobIdRaw)
      this.#reject(id, gone.stale ? STRATUM_ERROR.JOB_NOT_FOUND : STRATUM_ERROR.OTHER, gone.message)
      return
    }

    const key = shareKey(submission)
    if (this.#seen.has(key)) {
      this.#reject(id, STRATUM_ERROR.DUPLICATE_SHARE, 'duplicate share')
      return
    }
    // Recorded before the hash rather than after, so a replayed share costs one set lookup rather
    // than one scrypt.
    this.#seen.add(key)
    if (this.#seen.size > SEEN_SHARE_LIMIT) {
      const oldest = this.#seen.values().next()
      if (!oldest.done) this.#seen.delete(oldest.value)
    }

    // The lower of the two difficulties. See the note at the top of this file.
    const issued = this.#jobDifficulty.get(jobIdRaw) ?? this.#vardiff.difficulty
    const judgedAt = Math.min(issued, this.#vardiff.difficulty)

    const result: ShareResult = validateShare(submission, {
      job,
      algorithm: this.#deps.algorithm,
      extranonce1: this.#deps.extranonce1,
      extranonce2Size: this.#deps.extranonce2Size,
      shareDifficulty: judgedAt,
      versionMask: this.#versionMask,
      nowSeconds: Math.floor(this.#deps.now() / 1000),
    })

    if (result.status === 'rejected') {
      this.#reject(id, result.code, result.message)
      return
    }

    this.#accepted += 1
    this.#deps.onOutcome?.('accepted', null)
    this.#deps.send({ id, result: true, error: null })

    this.#deps.onAcceptedShare({
      chain: this.#deps.chain,
      account,
      worker: this.#worker,
      jobId: job.id,
      height: job.height,
      difficultyUnits: difficultyUnits(result.creditedDifficulty),
      achievedUnits: difficultyUnits(result.achievedDifficulty),
      isBlock: result.isBlock,
    })

    if (result.isBlock) {
      this.#deps.onBlock({
        job,
        header: result.header,
        coinbase: result.coinbase,
        headerHash: result.headerHash,
        account,
        worker: this.#worker,
        creditedDifficulty: result.creditedDifficulty,
      })
    }

    const retargeted = this.#vardiff.recordShare(this.#deps.now())
    if (retargeted !== null) {
      this.#deps.send({ id: null, method: 'mining.set_difficulty', params: [retargeted] })
    }
  }

  #reject(id: number | string | null, code: number, message: string): void {
    this.#rejected += 1
    this.#deps.onOutcome?.('rejected', code)
    this.#deps.send({ id, result: false, error: [code, message, null] })
  }
}

/**
 * Split a stratum username into an account and a worker label.
 *
 * The account is usually a payout address and the worker is whatever the operator typed into their
 * miner. Both go into the database and both are shown on a page, so the character set is restricted
 * here rather than trusted: this is the only string in the whole protocol that a stranger chooses
 * and the pool stores. Returning null — rather than sanitising — means the miner is told their
 * worker name was refused, instead of quietly mining under a name they did not choose and cannot
 * find in their own share history.
 */
export function parseWorkerName(username: string): { account: string; worker: string } | null {
  if (username.length > 128) return null
  const dot = username.indexOf('.')
  const account = dot === -1 ? username : username.slice(0, dot)
  const worker = dot === -1 ? '' : username.slice(dot + 1)
  if (account.length === 0 || account.length > 96) return null
  if (worker.length > 64) return null
  // Base58 and bech32 addresses, and ordinary worker labels. Deliberately no whitespace, no control
  // characters and no punctuation beyond the three that appear in real worker names.
  if (!/^[A-Za-z0-9_:-]+$/.test(account)) return null
  if (worker !== '' && !/^[A-Za-z0-9_.-]+$/.test(worker)) return null
  return { account, worker }
}
