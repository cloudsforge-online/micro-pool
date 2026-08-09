/**
 * The producer: a matured block becoming claims.
 *
 * Almost all of this needs a real Postgres, and that is not incidental. What is being tested is the
 * join between three things that each already work — the maturity verdict, the recorded PPLNS
 * window, and the sink — and the join is made of queries. A fake database here would be a fake of
 * exactly the part that was missing.
 *
 * Two properties are worth naming as the ones the rest hang off:
 *
 *   - **Nothing is paid before `matured`.** A pending block and an orphaned block both allocate
 *     nothing, and the same block pays the moment (and only the moment) the maturity sweep promotes
 *     it. That is the first half of micro-org#302 holding the door for the second.
 *   - **Every unit of the reward is accounted for.** Fee plus allocations equals the reward exactly,
 *     for a reward deliberately chosen not to divide evenly, because "the remainder has to go
 *     somewhere deliberate" is the requirement and a test on a round number would not see it.
 */

import test, { after, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import postgres from 'postgres'
import { migrate, type Sql as DbSql } from '@cloudsforge/db'
import { MIGRATIONS, POOL_TABLES } from './migrations.ts'
import { CREDIT_KIND, PAYOUT_FLUSH_KIND, recurringFor } from './jobs.ts'
import { creditMaturedBlocks, type RewardCreditSweep } from './rewards.ts'
import {
  CUSTODY_BACKING_CLOSED,
  LedgerPayoutSink,
  PayoutRefusedError,
  poolPayoutCreditKey,
  type PayoutClaim,
  type PayoutSink,
} from './payouts.ts'
import type { LedgerClient, PostEntryRequest } from './ledgerclient.ts'
import {
  blocksAwaitingCredit,
  insertAccountLink,
  insertShares,
  payableBlocks,
  recordBlock,
  setBlockMaturity,
  upsertWorker,
  type Exec,
} from './store.ts'
import { difficultyUnits } from './pplns.ts'

/* --------------------------------------------------------------------------- the schedule, unit */

test('THE PRODUCER IS SCHEDULED ON EXACTLY THE SAME TERMS AS THE FLUSH IT FEEDS', () => {
  /*
   * A flush job with no producer drains a table nothing writes to, and a producer with no flush
   * leaves a lost response unrecovered for ever. They are two halves of one mechanism, so the thing
   * being pinned here is that they are switched on together and by the same condition.
   */
  const off = recurringFor(['btc', 'ltc'])
  assert.deepEqual(
    off.filter((job) => job.kind === CREDIT_KIND),
    [],
    'a deployment with payouts off scheduled a job that credits miners',
  )

  const on = recurringFor(['btc', 'ltc'], ['ltc'])
  assert.deepEqual(
    on.filter((job) => job.kind === CREDIT_KIND).map((job) => job.key),
    ['chain:ltc'],
  )
  assert.deepEqual(
    on.filter((job) => job.kind === PAYOUT_FLUSH_KIND).map((job) => job.key),
    ['chain:ltc'],
    'the producer and the flush are scheduled for different chains',
  )
  // Keyed per chain, like every other job here: two chains are two independent accounting universes
  // and one key would make the Bitcoin allocation wait behind the Litecoin one.
  assert.equal(new Set(on.map((job) => `${job.kind} ${job.key}`)).size, on.length)

  // A merge-mined chain is paid on its own terms, and the two thresholds are independent: here
  // Dogecoin has a minimum and its parent does not, so the pair is scheduled for `doge` alone. That
  // is a real configuration rather than a curiosity — the amounts are of different assets at
  // different prices, and `env.ts` reads the two variables separately for exactly that reason.
  const merged = recurringFor(['ltc'], ['doge'], ['doge'])
  assert.deepEqual(
    merged.filter((job) => job.kind === CREDIT_KIND || job.kind === PAYOUT_FLUSH_KIND).map((job) => job.key),
    ['chain:doge', 'chain:doge'],
  )
})

/* ------------------------------------------------------------------ the sweep, against a database */

const url = process.env['POOL_TEST_DATABASE_URL']
const enabled = Boolean(url && /test/i.test(url))
const skip = enabled ? false : 'set POOL_TEST_DATABASE_URL (name must contain "test")'

let sql: postgres.Sql
const db = (): Exec => sql as unknown as Exec

const HASH = '0000000000000000000123456789abcdef0123456789abcdef0123456789abcd'
const HEIGHT = 2_700_000
const USER = '11111111-1111-4111-8111-111111111111'

/**
 * A reward chosen so the split does NOT come out even.
 *
 * 100 units at 250 basis points is a fee of 2.5, which integer division floors to 2 — so the half
 * unit the pool does not take stays in the miners' 98, and 98 across three equal weights is 32 each
 * with 2 left over. Every one of those numbers is asserted below, because each is a place a unit
 * could be lost or invented.
 */
const REWARD = 100n
const FEE_BASIS_POINTS = 250

/** Claims a sink was offered, in order, without any of them going anywhere. */
let offered: PayoutClaim[] = []

/**
 * A sink that records what it was asked and refuses on demand.
 *
 * `refuse` names the reason for one worker id, which is how the two skip paths are exercised without
 * having to construct a real below-minimum amount or unlink an account mid-sweep.
 */
function fakeSink(refuse: (claim: PayoutClaim) => string | null = () => null): PayoutSink {
  return {
    credit: (claim) => {
      offered.push(claim)
      const reason = refuse(claim)
      if (reason !== null) return Promise.reject(new PayoutRefusedError(reason, 'refused by the test'))
      return Promise.resolve()
    },
  }
}

let posted: PostEntryRequest[] = []

/** The same deduping fake `payouts.test.ts` uses: a lost response must not become a second entry. */
function fakeLedger(): LedgerClient {
  const seen = new Map<string, string>()
  return {
    postEntry: (request) => {
      posted.push(request)
      const existing = seen.get(request.idempotencyKey)
      const id = existing ?? `entry-${seen.size + 1}`
      seen.set(request.idempotencyKey, id)
      return Promise.resolve({
        id,
        kind: request.kind,
        recordedAt: new Date().toISOString(),
        replayed: existing !== undefined,
      })
    },
  }
}

const errors: string[] = []

async function sweep(sink: PayoutSink): Promise<RewardCreditSweep> {
  return creditMaturedBlocks({
    sql: db(),
    sink,
    chain: 'ltc',
    network: 'mainnet',
    asset: 'LTC',
    feeBasisPoints: FEE_BASIS_POINTS,
    log: (level, message) => {
      if (level === 'error') errors.push(message)
    },
  })
}

/** One worker with one share of the given weight. Returns its id. */
async function worker(name: string, account: string, difficulty: number): Promise<number> {
  const id = await upsertWorker(db(), { chain: 'ltc', account, worker: name })
  await insertShares(db(), [
    {
      chain: 'ltc',
      workerId: id,
      jobId: 'job-1',
      height: HEIGHT,
      difficultyUnits: difficultyUnits(difficulty),
      achievedUnits: difficultyUnits(difficulty),
      isBlock: false,
    },
  ])
  return id
}

/** The share id range currently on file, which is what `blocks.ts` snapshots when a block is found. */
async function windowBounds(): Promise<{ first: bigint; last: bigint }> {
  const rows = await sql<{ first: string; last: string }[]>`
    select min(id)::text as first, max(id)::text as last from pool_shares where chain = 'ltc'
  `
  const row = rows[0]
  if (!row) throw new Error('no shares')
  return { first: BigInt(row.first), last: BigInt(row.last) }
}

/** Record a block over the shares that exist now, and leave it at whatever maturity is asked for. */
async function block(
  args: { hash?: string; height?: number; matured?: boolean; from?: bigint } = {},
): Promise<string> {
  const hash = args.hash ?? HASH
  const all = await windowBounds()
  const bounds = { first: args.from ?? all.first, last: all.last }
  await recordBlock(db(), {
    chain: 'ltc',
    shareChain: 'ltc',
    height: args.height ?? HEIGHT,
    hash,
    foundByWorkerId: null,
    networkDifficultyUnits: difficultyUnits(34_512_119.5),
    reward: REWARD,
    submitStatus: 'accepted',
    submitDetail: null,
    windowFirstShareId: bounds.first,
    windowLastShareId: bounds.last,
  })
  if (args.matured !== false) {
    await setBlockMaturity(db(), { chain: 'ltc', hash, status: 'matured', confirmations: 100, detail: null })
  }
  return hash
}

async function creditedAt(hash: string): Promise<boolean> {
  const rows = await sql`select payout_credited_at is not null as marked from pool_blocks where hash = ${hash}`
  return Boolean((rows[0] as { marked: boolean } | undefined)?.marked)
}

before(async () => {
  if (!enabled) return
  sql = postgres(url as string, { max: 4, onnotice: () => {} })
  await sql.unsafe(`drop table if exists ${POOL_TABLES.join(', ')}, jobs, schema_migrations cascade`)
  await migrate(sql as unknown as DbSql, MIGRATIONS, { service: 'pool-test' })
})

after(async () => {
  if (!enabled) return
  await sql.end({ timeout: 5 })
})

beforeEach(async () => {
  if (!enabled) return
  offered = []
  posted = []
  errors.length = 0
  await sql.unsafe(`truncate ${POOL_TABLES.join(', ')} restart identity cascade`)
})

test('NOTHING IS ALLOCATED UNTIL THE BLOCK HAS MATURED', { skip }, async () => {
  /*
   * The first half of micro-org#302 holding the door for the second. A block the node accepted is
   * not a reward that exists — that was the whole defect — so the producer must read the maturity
   * verdict and nothing else, and the same block has to become payable the moment the sweep
   * promotes it and not one moment earlier.
   */
  await worker('rig1', 'acct-a', 1)
  const hash = await block({ matured: false })

  assert.deepEqual(await sweep(fakeSink()), {
    blocks: 0,
    credited: 0,
    skippedZero: 0,
    skippedBelowMinimum: 0,
    skippedNoAccount: 0,
    stopped: false,
  })
  assert.deepEqual(offered, [], 'a block whose fate is unknown was allocated')

  // And an orphan is not a reward either, in the state the reorg test leaves behind.
  await setBlockMaturity(db(), {
    chain: 'ltc',
    hash,
    status: 'orphaned',
    confirmations: -1,
    detail: 'not on the active chain',
  })
  assert.equal((await sweep(fakeSink())).blocks, 0)
  assert.deepEqual(offered, [])
})

test('EVERY UNIT OF THE REWARD IS ACCOUNTED FOR, AND THE FEE ROUNDS TOWARDS THE MINERS', { skip }, async () => {
  /*
   * The requirement the coordinator named: the arithmetic must not lose or invent a unit, and the
   * remainder has to go somewhere deliberate.
   *
   * Three equal weights against a reward of 100 at 250bp. The fee is 2 rather than 2.5 because
   * integer division floors, and the half unit it does not take stays in the miners' share — the
   * opposite rounding would take a unit from them that nobody chose to take. 98 across three equal
   * weights is 32 each with 2 left over, and largest remainder hands those two out one at a time
   * rather than dropping them.
   */
  await worker('rig1', 'acct-a', 1)
  await worker('rig2', 'acct-b', 1)
  await worker('rig3', 'acct-c', 1)
  await block()

  const result = await sweep(fakeSink())
  assert.equal(result.blocks, 1)
  assert.equal(result.credited, 3)

  const amounts = offered.map((claim) => claim.amount).sort()
  assert.deepEqual(amounts, [32n, 33n, 33n])
  const paid = amounts.reduce((sum, amount) => sum + amount, 0n)
  assert.equal(paid, 98n, 'the miners were not paid the whole net reward')
  assert.equal(paid + 2n, REWARD, 'the fee plus the allocations is not the reward')

  // Each claim carries the weight it was derived from, which is what lets a miner reproduce the
  // arithmetic — 36 §6 — and the key is `poolPayoutCreditKey` unchanged.
  for (const claim of offered) {
    assert.equal(claim.units, difficultyUnits(1))
    assert.equal(claim.creditKey, poolPayoutCreditKey('ltc', 'mainnet', HASH, claim.workerId))
    assert.equal(claim.asset, 'LTC')
    assert.equal(claim.blockHeight, HEIGHT)
  }
  assert.equal(new Set(offered.map((claim) => claim.creditKey)).size, 3, 'two workers shared a key')
})

test('THE WINDOW IS THE ONE RECORDED WHEN THE BLOCK WAS FOUND, NOT THE ONE ALIVE AT MATURITY', { skip }, async () => {
  /*
   * A hundred confirmations is about four hours on Litecoin, and a busy pool takes a great many
   * shares in four hours. If the allocation re-derived the window at credit time it would pay the
   * miners who happened to be connected when the block matured rather than the ones whose work
   * found it — which is not a rounding error, it is paying the wrong people.
   */
  // One miner whose shares had already fallen out of the window when the block was found, one inside
  // it, and one who connected while the block was maturing. Only the middle one earned this block.
  const before = await worker('rig0', 'acct-z', 1)
  const inside = await worker('rig1', 'acct-a', 1)
  const bounds = await windowBounds()
  await block({ from: bounds.last })
  const after = await worker('rig2', 'acct-b', 1)

  await sweep(fakeSink())
  assert.deepEqual(
    offered.map((claim) => claim.workerId),
    [inside],
    'a miner outside the recorded window was paid out of this block',
  )
  assert.notEqual(inside, before)
  assert.notEqual(inside, after)
  // The whole net reward went to the one miner in the window.
  assert.equal(offered[0]?.amount, 98n)
})

test('A BLOCK IS ALLOCATED ONCE, AND THE MARKER IS WHAT STOPS IT BEING WALKED AGAIN', { skip }, async () => {
  await worker('rig1', 'acct-a', 1)
  const hash = await block()

  assert.equal((await sweep(fakeSink())).blocks, 1)
  assert.equal(await creditedAt(hash), true)
  assert.equal(offered.length, 1)

  // The second run reads an empty queue rather than re-offering a claim the credit key would have
  // deduped anyway. The unique constraint is the safety; this is the reason the sweep does not grow
  // without bound for the life of the pool.
  assert.equal((await sweep(fakeSink())).blocks, 0)
  assert.equal(offered.length, 1, 'the same block was allocated twice')

  // Still payable — the block's reward did not stop existing because it was paid out. The two
  // questions are asked by two statements and this is the difference between them.
  assert.equal((await payableBlocks(db(), { chain: 'ltc', limit: 10 })).length, 1)
  assert.equal((await blocksAwaitingCredit(db(), { chain: 'ltc', limit: 10 })).length, 0)
})

test('THE DEFINITION OF PAYABLE AND THE QUEUE THAT DRAINS IT AGREE ON EVERY STATE', { skip }, async () => {
  // Two statements carrying the same predicate can drift, so the agreement is pinned rather than
  // trusted. `payableBlocks` is the definition; `blocksAwaitingCredit` is it plus the marker.
  await worker('rig1', 'acct-a', 1)
  const hash = await block({ matured: false })
  const both = async () => ({
    payable: (await payableBlocks(db(), { chain: 'ltc', limit: 10 })).length,
    queued: (await blocksAwaitingCredit(db(), { chain: 'ltc', limit: 10 })).length,
  })

  assert.deepEqual(await both(), { payable: 0, queued: 0 }, 'a pending block')
  await setBlockMaturity(db(), { chain: 'ltc', hash, status: 'matured', confirmations: 100, detail: null })
  assert.deepEqual(await both(), { payable: 1, queued: 1 }, 'a matured block')
  await sweep(fakeSink())
  assert.deepEqual(await both(), { payable: 1, queued: 0 }, 'an allocated block')
})

test('A SHARE THAT ROUNDS TO NOTHING IS SKIPPED RATHER THAN CLAIMED FOR ZERO', { skip }, async () => {
  /*
   * A thousand-to-one weight against a reward of 100 units: the small miner's exact share is under
   * one unit and the largest-remainder pass gives the leftover to the large one. There is nothing to
   * pay, and `pool_payout_credits.amount > 0` would refuse the insert anyway — but the reason for
   * skipping rather than clamping is that a zero-value ledger entry is a movement of no money that a
   * miner would nonetheless find in their history and have to ask about.
   */
  await worker('rig1', 'acct-a', 1000)
  await worker('rig2', 'acct-b', 1)
  const hash = await block()

  const result = await sweep(fakeSink())
  assert.equal(result.skippedZero, 1)
  assert.equal(result.credited, 1)
  assert.deepEqual(
    offered.map((claim) => claim.amount),
    [98n],
    'a claim worth nothing was offered to the sink',
  )
  assert.equal(await creditedAt(hash), true)
})

test('A BLOCK WITH NO SHARES BEHIND IT PAYS NOBODY AND IS NOT WALKED AGAIN', { skip }, async () => {
  // The first block of a pool's life, or one found before the share buffer flushed. `blocks.ts`
  // records null window bounds for it. There is nobody to pay, the whole reward is the pool's, and
  // the row must not come back every ten minutes for ever.
  await recordBlock(db(), {
    chain: 'ltc',
    shareChain: 'ltc',
    height: HEIGHT,
    hash: HASH,
    foundByWorkerId: null,
    networkDifficultyUnits: difficultyUnits(1),
    reward: REWARD,
    submitStatus: 'accepted',
    submitDetail: null,
    windowFirstShareId: null,
    windowLastShareId: null,
  })
  await setBlockMaturity(db(), { chain: 'ltc', hash: HASH, status: 'matured', confirmations: 100, detail: null })

  assert.equal((await sweep(fakeSink())).blocks, 1)
  assert.deepEqual(offered, [])
  assert.equal(await creditedAt(HASH), true)
})

test('A SKIPPED CLAIM IS COUNTED AND THE BLOCK IS STILL FINISHED', { skip }, async () => {
  /*
   * The two ordinary skips: a claim under the operator's minimum, and a miner who gave an address
   * and never an estate account. Neither is a failure and neither may stop the block — on a real
   * pool the second one is most of the window, and a sweep that stopped on it would never finish a
   * block at all.
   */
  const dust = await worker('rig1', 'acct-a', 1)
  const external = await worker('rig2', 'acct-b', 1)
  await worker('rig3', 'acct-c', 1)
  const hash = await block()

  const result = await sweep(
    fakeSink((claim) => {
      if (claim.workerId === dust) return 'below_minimum'
      if (claim.workerId === external) return 'no_estate_account'
      return null
    }),
  )
  assert.deepEqual(result, {
    blocks: 1,
    credited: 1,
    skippedZero: 0,
    skippedBelowMinimum: 1,
    skippedNoAccount: 1,
    stopped: false,
  })
  assert.equal(await creditedAt(hash), true)
  assert.deepEqual(errors, [], 'an ordinary skip was logged as an error')
})

test('THE CUSTODY INTERLOCK STOPS THE WHOLE SWEEP AND LEAVES THE BLOCK UNMARKED', { skip }, async () => {
  /*
   * `CUSTODY_BACKING_CLOSED` is a constant, so the second claim would be refused for the same reason
   * as the first: stopping is the only response that does not print one line per worker for a
   * condition that has nothing to do with any of them. Leaving the block unmarked is what makes the
   * refusal recoverable — the day the interlock opens, the next sweep allocates the block from the
   * top.
   */
  await worker('rig1', 'acct-a', 1)
  await worker('rig2', 'acct-b', 1)
  const hash = await block()

  const shut = new LedgerPayoutSink({
    sql: db(),
    ledger: fakeLedger(),
    minimumUnits: 1n,
    // The production value, read from the module rather than written as `false` here, so this test
    // starts failing the moment somebody flips it without opening the gate it describes.
    custodyBackingConfirmed: CUSTODY_BACKING_CLOSED,
    correlationId: () => 'corr-1',
    log: () => {},
  })

  const result = await sweep(shut)
  assert.equal(result.stopped, true)
  assert.equal(result.credited, 0)
  assert.equal(result.blocks, 0)
  assert.deepEqual(posted, [], 'the ledger was called with the interlock shut')
  assert.equal(await creditedAt(hash), false, 'a block nothing was paid out of was marked as done')
  assert.equal((await blocksAwaitingCredit(db(), { chain: 'ltc', limit: 10 })).length, 1)
  assert.match(String(errors[0]), /REFUSED EVERY CLAIM/)
  const rows = await sql`select id from pool_payout_credits`
  assert.equal(rows.length, 0)
})

test('A FAILURE PART WAY THROUGH A BLOCK IS FINISHED BY THE NEXT RUN, EXACTLY ONCE', { skip }, async () => {
  /*
   * The ledger going away mid-block. The block is left unmarked and re-walked, which is only safe
   * because `credit_key` makes re-offering an already-credited claim a no-op that never reaches the
   * ledger — so the miner who was paid before the failure is not paid again.
   */
  await worker('rig1', 'acct-a', 1)
  await worker('rig2', 'acct-b', 1)
  await worker('rig3', 'acct-c', 1)
  const hash = await block()

  let fail = true
  const credited = new Set<string>()
  const flaky: PayoutSink = {
    credit: (claim) => {
      offered.push(claim)
      if (fail && offered.length === 2) return Promise.reject(new Error('the ledger is unreachable'))
      credited.add(claim.creditKey)
      return Promise.resolve()
    },
  }

  const first = await sweep(flaky)
  assert.equal(first.stopped, true)
  assert.equal(first.credited, 1)
  assert.equal(await creditedAt(hash), false)
  assert.match(String(errors[0]), /leaving the rest of this sweep for later/)
  // Three workers, one failure on the second: the third is NOT offered. A sink that just failed is a
  // sink that will probably fail again, and pressing on would turn one unreachable ledger into one
  // log line per worker in the window with no more chance of success.
  assert.equal(offered.length, 2, 'the sweep kept offering claims after the sink failed')

  fail = false
  const second = await sweep(flaky)
  assert.equal(second.stopped, false)
  assert.equal(second.blocks, 1)
  assert.equal(await creditedAt(hash), true)
  // Five offers for three workers: the second run re-walks the block from the top, so the worker who
  // was already credited is offered twice. Three DISTINCT keys, which is what the ledger and the
  // local unique constraint both dedupe on — the re-offer is a no-op, not a second payment.
  assert.equal(offered.length, 5)
  assert.equal(credited.size, 3)
})

test('THE LOOP IS CLOSED: A MATURED BLOCK REACHES THE LEDGER UNDER ITS OWN CREDIT KEY', { skip }, async () => {
  /*
   * The end-to-end micro-org#302 asks for, with the real sink and a fake ledger, and the reason this
   * change exists: before it, `store.payableBlocks` had no caller, `PayoutClaim` was never
   * constructed, and `pool.flush-payouts` drained a table nothing wrote to.
   *
   * The interlock is opened HERE and nowhere else, exactly as `payouts.test.ts` opens it, so that
   * the path behind it is tested while the constant in the source stays false.
   */
  const workerId = await worker('rig1', 'acct-a', 1)
  await insertAccountLink(db(), { userId: USER, account: 'acct-a' })
  const hash = await block()

  const sink = new LedgerPayoutSink({
    sql: db(),
    ledger: fakeLedger(),
    minimumUnits: 1n,
    custodyBackingConfirmed: true,
    correlationId: () => 'corr-1',
    log: () => {},
  })

  const result = await sweep(sink)
  assert.equal(result.credited, 1)
  assert.equal(result.blocks, 1)

  const key = poolPayoutCreditKey('ltc', 'mainnet', hash, workerId)
  assert.equal(posted.length, 1)
  assert.equal(posted[0]?.idempotencyKey, key, 'the ledger was called with a key of its own')
  assert.equal(posted[0]?.postings[1]?.account.subject, `user:${USER}`)
  assert.equal(posted[0]?.postings[1]?.amount, 98n)

  const rows = await sql<{ credit_key: string; amount: string; entry: string | null }[]>`
    select credit_key, amount::text, ledger_entry_id as entry from pool_payout_credits
  `
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.credit_key, key, 'the local row and the ledger disagree about the key')
  assert.equal(rows[0]?.amount, '98')
  assert.ok(rows[0]?.entry, 'the claim was left unposted')
})
