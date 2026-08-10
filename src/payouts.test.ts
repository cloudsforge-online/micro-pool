/**
 * The payout seam, and the sink that now fills it — which still cannot pay anybody.
 *
 * ## The key's algebra
 *
 * The part of this shape that actually constrains an implementation is the idempotency key.
 * `wallet/src/deposits.ts` established `credit_key` in this estate as one string used BOTH as a
 * local unique constraint and as the ledger's `idempotencyKey`; the value of that convention is
 * entirely in there being one of it. A second scheme invented here would mean a block credited twice
 * under two different keys, and nothing downstream could tell. So the first tier of tests is about
 * what the key distinguishes, what it does not, and that it contains nothing that varies between two
 * computations of the same claim — a key with a timestamp in it is not an idempotency key, it is a
 * nonce with an idempotency key's name.
 *
 * ## The two gates
 *
 * micro-org#302 added `LedgerPayoutSink`, and two independent things stand between it and a miner
 * being paid. Neither is an environment variable and both are tested here: the payout configuration
 * block is unset on every deployment that exists, and `CUSTODY_BACKING_CLOSED` is `false` because
 * the pool's payout address is not observed by the indexer. Its comment carries the whole finding.
 *
 * ## The database tier
 *
 * Everything about at-most-once lives in constraints — a unique index settling a race, a conditional
 * update refusing to overwrite a finished row — and no fake has either, so the sink's own behaviour
 * is tested against a real Postgres. Gated on `POOL_TEST_DATABASE_URL`.
 */

import test, { after, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import postgres from 'postgres'
import { migrate, type Sql as DbSql } from '@cloudsforge/db'
import { MIGRATIONS, POOL_TABLES } from './migrations.ts'
import { PAYOUT_FLUSH_KIND, recurringFor } from './jobs.ts'
import { claimPayoutCredit, insertAccountLink, markPayoutCredited, upsertWorker, type Exec } from './store.ts'
import type { LedgerClient, PostEntryRequest } from './ledgerclient.ts'
import {
  CUSTODY_BACKING_CLOSED,
  LedgerPayoutSink,
  PayoutRefusedError,
  PayoutsNotImplementedError,
  payoutsImplemented,
  poolPayoutCreditKey,
  type LedgerPayoutSinkDeps,
  type PayoutClaim,
} from './payouts.ts'

const BLOCK = '00000000000000000002a7c4c1e48d76c5a37902165a270156b7a8d72728a054'

test('the credit key follows the estate shape', () => {
  assert.equal(
    poolPayoutCreditKey('btc', 'mainnet', BLOCK, 42),
    `pool:payout:btc:mainnet:${BLOCK}:42`,
  )
})

test('the key is namespaced so it cannot collide with another service', () => {
  // `wallet` issues deposit credit keys against the same ledger. Two services minting keys into one
  // namespace is the collision that makes idempotency meaningless.
  assert.ok(poolPayoutCreditKey('ltc', 'testnet', BLOCK, 1).startsWith('pool:payout:'))
})

test('every field that identifies a claim changes the key', () => {
  const base = poolPayoutCreditKey('btc', 'mainnet', BLOCK, 42)
  const other = '00000000000000000001111111111111111111111111111111111111111111ff'
  assert.notEqual(base, poolPayoutCreditKey('ltc', 'mainnet', BLOCK, 42), 'chain')
  assert.notEqual(base, poolPayoutCreditKey('btc', 'testnet', BLOCK, 42), 'network')
  assert.notEqual(base, poolPayoutCreditKey('btc', 'mainnet', other, 42), 'block')
  assert.notEqual(base, poolPayoutCreditKey('btc', 'mainnet', BLOCK, 43), 'worker')
})

test('a chain and its testnet never share a key', () => {
  // The failure this prevents is not theoretical: the same block hash cannot occur on both networks,
  // but a bug that pointed a mainnet pool at a testnet node could produce a claim that looked
  // already-credited and was silently skipped.
  assert.notEqual(
    poolPayoutCreditKey('btc', 'mainnet', BLOCK, 7),
    poolPayoutCreditKey('btc', 'testnet', BLOCK, 7),
  )
})

test('the key is stable across case, because a block hash is not case-sensitive', () => {
  // Core answers lower-case; an operator pasting from an explorer may not. Two spellings of one
  // block must not be two claims.
  assert.equal(
    poolPayoutCreditKey('btc', 'mainnet', BLOCK.toUpperCase(), 42),
    poolPayoutCreditKey('btc', 'mainnet', BLOCK, 42),
  )
})

test('the key is a pure function of the claim', () => {
  // No time, no counter, no randomness. Computed twice, seconds apart, it must be identical — that
  // is the entire property an idempotency key has.
  const first = poolPayoutCreditKey('btc', 'mainnet', BLOCK, 42)
  const second = poolPayoutCreditKey('btc', 'mainnet', BLOCK, 42)
  assert.equal(first, second)
  // And it contains nothing that looks like a timestamp: no 10- or 13-digit run outside the hash.
  const withoutHash = first.replace(BLOCK, '')
  assert.ok(!/\d{10,}/.test(withoutHash), `the key carries something clock-shaped: ${withoutHash}`)
})

test('the not-implemented error says plainly what does and does not happen', () => {
  // It exists so a future partial implementation has something honest to throw, rather than
  // returning silently or logging and continuing — both of which produce a pool that says it paid.
  const err = new PayoutsNotImplementedError('crediting a block reward')
  assert.ok(err instanceof Error)
  assert.equal(err.name, 'PayoutsNotImplementedError')
  assert.match(err.message, /payouts are not implemented/)
  assert.match(err.message, /crediting a block reward/)
  // It must name what DOES work, or an operator reading it cannot tell whether shares were lost too.
  assert.match(err.message, /[Ss]hares are recorded/)
  assert.match(err.message, /src\/payouts\.ts/)
})

test('THE MODULE GAINED AN IMPLEMENTATION, AND EVERY WAY OF REACHING IT IS STILL SHUT', async () => {
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // This test used to assert that `payouts.ts` had exactly two runtime exports and therefore no
  // implementation at all — the brief's "do not stub anything that would look like it works".
  // micro-org#302 added the implementation, so that spelling is now false, and it is RE-POINTED
  // rather than deleted because the property it protected has not changed:
  //
  //     **nothing in this release can pay anybody, and making it able to is a code change.**
  //
  // The export list is still pinned, because a NEW runtime export is a new way in and should be
  // read by whoever adds it. What has changed is that the list is allowed to contain the sink —
  // and is checked against the two gates that keep the sink inert.
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  const module: Record<string, unknown> = await import('./payouts.ts')
  const runtimeExports = Object.keys(module).filter((name) => typeof module[name] === 'function')
  assert.deepEqual(
    runtimeExports.sort(),
    [
      'LedgerPayoutSink',
      'PayoutRefusedError',
      'PayoutsNotImplementedError',
      // Added 2026-08-10 and pure: it reads the interlock and answers a question, it moves nothing.
      // It is on this list rather than exempted from it because that is what the list is for — the
      // next person to add a name here has to explain it in the same place.
      'payoutsImplemented',
      'poolPayoutCreditKey',
    ],
    'payouts.ts gained a runtime export: if it credits anything, the README and PR must stop saying it does not',
  )

  // Gate one, in the source rather than in the environment, so switching it on is reviewed.
  assert.equal(CUSTODY_BACKING_CLOSED, false, 'the custody interlock was opened; read its comment before shipping that')
})

/* ------------------------------------------------ the sink, and the two gates in front of it */

const CLAIM: PayoutClaim = {
  chain: 'ltc',
  network: 'mainnet',
  blockHash: BLOCK,
  blockHeight: 2_700_000,
  workerId: 7,
  account: 'ltc1qtkkwej6dwp0m58k99ckac76qp4agyu3pr0pqvp',
  amount: 1_250_000_000n,
  asset: 'LTC',
  units: 4_096n,
  creditKey: poolPayoutCreditKey('ltc', 'mainnet', BLOCK, 7),
}

/** A sink whose every dependency throws, so anything that gets past the interlock is caught here. */
function sealedSink(overrides: Partial<LedgerPayoutSinkDeps> = {}): LedgerPayoutSink {
  return new LedgerPayoutSink({
    sql: (() => {
      throw new Error('the database was touched')
    }) as unknown as LedgerPayoutSinkDeps['sql'],
    ledger: {
      postEntry: () => {
        throw new Error('the ledger was called')
      },
    },
    minimumUnits: 1n,
    custodyBackingConfirmed: false,
    correlationId: () => 'test',
    log: () => {},
    ...overrides,
  })
}

test('THE CUSTODY INTERLOCK REFUSES BEFORE ANYTHING IS READ, WRITTEN OR POSTED', async () => {
  // The point of the ordering: the refusal happens before the database is queried and before the
  // ledger is called, so a deployment that somehow configured payouts cannot half-record one. Both
  // fakes above throw on contact, so reaching either fails this test with a different message.
  await assert.rejects(
    () => sealedSink().credit(CLAIM),
    (err: unknown) => {
      assert.ok(err instanceof PayoutRefusedError)
      assert.equal(err.reason, 'custody_backing_not_confirmed')
      // The refusal must name the consequence, not just say no. An operator who reads "refused" and
      // nothing else removes the check; one who reads "would freeze LTC withdrawals estate-wide"
      // goes and looks at micro-org#248 first.
      assert.match(err.message, /freeze the asset estate-wide/)
      assert.match(err.message, /CUSTODY_BACKING_CLOSED/)
      return true
    },
  )
})

test('THE COMPOSITION ROOT PASSES THE INTERLOCK CONSTANT, NOT A LITERAL', () => {
  // The interlock is a parameter so the branches behind it are reachable from a test — which is only
  // safe if production provably cannot pass anything else. Read out of `index.ts` rather than
  // asserted about behaviour, because the value that matters is the one written at the single call
  // site, and no runtime assertion here can observe that file's wiring.
  const root = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
  assert.match(
    root,
    /custodyBackingConfirmed:\s*CUSTODY_BACKING_CLOSED\b/,
    'index.ts no longer passes the interlock constant to the payout sink',
  )
  assert.ok(
    !/custodyBackingConfirmed:\s*true/.test(root),
    'index.ts hard-codes the interlock open; read CUSTODY_BACKING_CLOSED before shipping that',
  )
})

test('WHAT A CLIENT IS TOLD ABOUT PAYOUTS IS DERIVED FROM THE TWO GATES, NOT WRITTEN DOWN', () => {
  // micro-org#302 step 4 is "flip `payoutsImplemented` to true only when all three are in and a
  // payout has actually settled". Written as four literals — two routes and two boot lines — that
  // step's failure mode is doing three of the four, and the one clients read is the one nothing
  // checks. Derived, the flip is a consequence of the gates opening and cannot be performed alone.
  //
  // Both terms are asserted because neither is redundant: a configured deployment with the interlock
  // shut must not claim to pay, and an open interlock on a deployment nobody configured has no sink
  // to pay from.
  assert.equal(payoutsImplemented(true), CUSTODY_BACKING_CLOSED)
  assert.equal(payoutsImplemented(false), false, 'no payout configuration, so nothing can settle')

  // And the value that actually ships. This line is a tripwire rather than a tautology: it fails the
  // day somebody opens the interlock, which is precisely when a human should be reading this file.
  assert.equal(payoutsImplemented(true), false, 'CUSTODY_BACKING_CLOSED is open — read payouts.ts')
})

test('THE COMPOSITION ROOT DERIVES THE WIRE FIELD RATHER THAN TYPING IT', () => {
  // The counterpart to the interlock check above, for the same reason and read the same way: the
  // value that matters is the one written at the single call site, and no runtime assertion here
  // can observe that file's wiring.
  const root = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
  assert.match(
    root,
    /const payoutsAreImplemented = payoutsImplemented\(env\.payouts !== null\)/,
    'index.ts no longer derives the payout claim from the interlock and the configuration',
  )
  assert.ok(
    !/payoutsImplemented:\s*(true|false)\b/.test(root),
    'index.ts writes a literal payout claim somewhere; it must publish the derived value',
  )
})

test('A CLAIM UNDER THE MINIMUM RECORDS NOTHING AT ALL, SO IT CAN STILL BE PAID LATER', async () => {
  // The failure being prevented: writing a `pool_payout_credits` row for a dust claim would mark it
  // handled by the very unique constraint that makes this at-most-once, and the key is per block per
  // worker — there is exactly one of it, so that claim could never be paid. Both fakes throw on
  // contact, so the refusal is proved to happen before the row is claimed and before the ledger is
  // called.
  const sink = sealedSink({ custodyBackingConfirmed: true, minimumUnits: CLAIM.amount + 1n })
  await assert.rejects(
    () => sink.credit(CLAIM),
    (err: unknown) => {
      assert.ok(err instanceof PayoutRefusedError)
      assert.equal(err.reason, 'below_minimum')
      assert.match(err.message, /nothing was recorded/)
      return true
    },
  )
})

test('a claim exactly ON the minimum is payable, and one a single unit under it is not', async () => {
  // The boundary, stated rather than implied. "Minimum" means the least amount that IS paid, so the
  // comparison is `<` and not `<=`; getting that backwards costs a miner the exact payout the
  // operator configured, and would never be noticed because it looks like a rounding story.
  //
  // Proved by which dependency each call reaches. At the minimum the refusal is gone and the next
  // step — the account lookup — throws its own recognisable error from the sealed `sql`.
  const atMinimum = sealedSink({ custodyBackingConfirmed: true, minimumUnits: CLAIM.amount })
  await assert.rejects(() => atMinimum.credit(CLAIM), /the database was touched/)

  const oneUnder = sealedSink({ custodyBackingConfirmed: true, minimumUnits: CLAIM.amount + 1n })
  await assert.rejects(() => oneUnder.credit(CLAIM), PayoutRefusedError)
})

test('the minimum has no default, so a sink cannot be built without somebody having chosen one', () => {
  // Not a runtime assertion — a type-level one, checked here by construction. `minimumUnits` is a
  // required field on `LedgerPayoutSinkDeps`, which is what makes "payouts are configured" and
  // "somebody typed the threshold" the same statement. If the field ever gains a default, this test
  // still compiles and the comment above it becomes the only warning left.
  const deps: LedgerPayoutSinkDeps = {
    sql: null as unknown as LedgerPayoutSinkDeps['sql'],
    ledger: { postEntry: () => Promise.reject(new Error('unused')) },
    minimumUnits: 5_000_000n,
    custodyBackingConfirmed: false,
    correlationId: () => 'test',
    log: () => {},
  }
  assert.equal(deps.minimumUnits, 5_000_000n)
  assert.ok(new LedgerPayoutSink(deps) instanceof LedgerPayoutSink)
})

test('THE FLUSH JOB IS NOT SCHEDULED ON A DEPLOYMENT WITH PAYOUTS OFF', () => {
  // Off means off all the way down: no sink, no job row, nothing in the queue for an operator to
  // find and wonder about. `recurringFor`'s second argument is the subset of chains an operator
  // configured a minimum for, and it defaults to none — which is every deployment on 2026-08-09.
  const off = recurringFor(['btc', 'ltc'])
  assert.deepEqual(off.filter((job) => job.kind === PAYOUT_FLUSH_KIND), [])

  // And when it IS on, it is on per chain, keyed on the contended resource like every other
  // recurring job here. Litecoin's backlog must not wait behind Bitcoin's.
  const on = recurringFor(['btc', 'ltc'], ['ltc'])
  assert.deepEqual(
    on.filter((job) => job.kind === PAYOUT_FLUSH_KIND).map((job) => job.key),
    ['chain:ltc'],
  )
  assert.equal(new Set(on.map((job) => `${job.kind} ${job.key}`)).size, on.length)
})

/* ------------------------------------------------ database-backed: claim, post, and the retry */

/**
 * The tier that needs a real Postgres, because what is being tested is a unique constraint settling
 * a race and a conditional update refusing to overwrite a finished row. No fake has either.
 *
 * Gated on `POOL_TEST_DATABASE_URL`, whose name must contain "test" — the estate's standard guard
 * against a suite that truncates a database somebody cared about.
 */
const url = process.env['POOL_TEST_DATABASE_URL']
const enabled = Boolean(url && /test/i.test(url))
const skip = enabled ? false : 'set POOL_TEST_DATABASE_URL (name must contain "test")'

let sql: postgres.Sql
const db = (): Exec => sql as unknown as Exec

/** Entries the fake ledger was asked to post, in order. */
let posted: PostEntryRequest[] = []

/**
 * A ledger that records what it was asked and dedupes on the idempotency key, as the real one does.
 *
 * Deduping matters here rather than being decoration: the retry path exists precisely because a
 * response can be lost after the entry landed, and a fake that posted twice would let a broken
 * implementation pass.
 */
function fakeLedger(): LedgerClient {
  const seen = new Map<string, string>()
  return {
    postEntry: (request) => {
      posted.push(request)
      const existing = seen.get(request.idempotencyKey)
      const id = existing ?? `entry-${seen.size + 1}`
      seen.set(request.idempotencyKey, id)
      return Promise.resolve({ id, kind: request.kind, recordedAt: new Date().toISOString(), replayed: existing !== undefined })
    },
  }
}

function openSink(overrides: Partial<LedgerPayoutSinkDeps> = {}): LedgerPayoutSink {
  return new LedgerPayoutSink({
    sql: db(),
    ledger: fakeLedger(),
    minimumUnits: 1n,
    // Opened only here. Production passes `CUSTODY_BACKING_CLOSED`, which the test above reads out
    // of `index.ts` to prove.
    custodyBackingConfirmed: true,
    correlationId: () => 'corr-1',
    log: () => {},
    ...overrides,
  })
}

const USER = '11111111-1111-4111-8111-111111111111'

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
  posted = []
  await sql.unsafe(`truncate ${POOL_TABLES.join(', ')} restart identity cascade`)
})

/** A worker row the payout credit's foreign key can point at, plus the account link that pays it. */
async function seedLinkedWorker(): Promise<number> {
  const workerId = await upsertWorker(db(), { chain: 'ltc', account: CLAIM.account, worker: 'rig1' })
  await insertAccountLink(db(), { userId: USER, account: CLAIM.account })
  return workerId
}

test('AN UNLINKED MINER IS REFUSED RATHER THAN CREDITED TO A LIABILITY OWED TO NOBODY', { skip }, async () => {
  // Most pool accounts are a payout address somebody typed into their own firmware, and there is no
  // ledger account for a string. Crediting `user:<the address>` would look plausible and would
  // create a balance no withdrawal can ever drain and no reconciliation can ever square.
  const workerId = await upsertWorker(db(), { chain: 'ltc', account: CLAIM.account, worker: 'rig1' })
  await assert.rejects(
    () => openSink().credit({ ...CLAIM, workerId }),
    (err: unknown) => {
      assert.ok(err instanceof PayoutRefusedError)
      assert.equal(err.reason, 'no_estate_account')
      return true
    },
  )
  assert.deepEqual(posted, [], 'the ledger was called for a miner with no estate account')
  const rows = await sql`select id from pool_payout_credits`
  assert.equal(rows.length, 0, 'a refused claim left a row behind')
})

test('THE CREDIT IS CLAIMED LOCALLY BEFORE THE LEDGER IS TOLD, AND THE KEY IS THE SAME STRING', { skip }, async () => {
  // The estate's shape, from `wallet/src/deposits.ts`: claim, commit, then post. The ordering is the
  // whole safety argument — a crash between the two leaves a row with no entry, which is visible and
  // retriable, where the reverse leaves an entry this service does not know it made.
  const workerId = await seedLinkedWorker()
  await openSink().credit({ ...CLAIM, workerId })

  assert.equal(posted.length, 1)
  const entry = posted[0]
  assert.equal(entry?.idempotencyKey, CLAIM.creditKey, 'the ledger key is not the local key')
  assert.equal(entry?.kind, 'reward_granted')
  assert.equal(entry?.actor, 'service:pool')
  // Double-entry, 04-domain-model §2: the custody asset rises because the coinbase paid into a
  // custody-held address, and the miner's liability rises because the estate now owes them.
  assert.deepEqual(
    entry?.postings.map((p) => [p.direction, p.account.subject, p.account.type, p.amount.toString()]),
    [
      ['debit', 'custody', 'asset', CLAIM.amount.toString()],
      ['credit', `user:${USER}`, 'liability', CLAIM.amount.toString()],
    ],
  )

  const [row] = await sql`
    select credit_key, ledger_entry_id, amount::text as amount, credited_at from pool_payout_credits
  `
  assert.equal(row?.['credit_key'], CLAIM.creditKey)
  assert.equal(row?.['ledger_entry_id'], 'entry-1')
  assert.equal(row?.['amount'], CLAIM.amount.toString())
  assert.ok(row?.['credited_at'] !== null, 'the claim was posted and never closed')
})

test('THE SAME CLAIM TWICE PAYS ONCE, AND THE SECOND CALL NEVER REACHES THE LEDGER', { skip }, async () => {
  // The local unique constraint is the first line, not the ledger's dedupe. Relying on the peer
  // would mean every retry costs a round trip and a pool with a backlog hammers the ledger with
  // movements it has already made.
  const workerId = await seedLinkedWorker()
  const sink = openSink()
  await sink.credit({ ...CLAIM, workerId })
  await sink.credit({ ...CLAIM, workerId })

  assert.equal(posted.length, 1, 'a duplicate claim was posted to the ledger')
  const rows = await sql`select id from pool_payout_credits`
  assert.equal(rows.length, 1)
})

test('a claim that was recorded and never posted is finished by the flush, exactly once', { skip }, async () => {
  // The safety net the claim-then-post ordering requires. Simulated the only honest way: claim the
  // row through the store, as a crashed `credit` would have left it, then run the flush.
  const workerId = await seedLinkedWorker()
  const id = await claimPayoutCredit(db(), {
    chain: 'ltc',
    network: 'mainnet',
    blockHash: CLAIM.blockHash,
    blockHeight: CLAIM.blockHeight,
    workerId,
    account: CLAIM.account,
    assetCode: 'LTC',
    amount: CLAIM.amount,
    creditKey: CLAIM.creditKey,
  })
  assert.ok(id !== null)

  const sink = openSink()
  assert.equal(await sink.flushPending('ltc', 10), 1)
  assert.equal(posted.length, 1)
  assert.equal(posted[0]?.idempotencyKey, CLAIM.creditKey)

  // And it does not run twice: the row is closed, so a second flush has nothing to drain.
  assert.equal(await sink.flushPending('ltc', 10), 0)
  assert.equal(posted.length, 1)
})

test('the flush is scoped to one chain, so a Litecoin backlog is not drained by a Bitcoin run', { skip }, async () => {
  const workerId = await seedLinkedWorker()
  await claimPayoutCredit(db(), {
    chain: 'ltc',
    network: 'mainnet',
    blockHash: CLAIM.blockHash,
    blockHeight: CLAIM.blockHeight,
    workerId,
    account: CLAIM.account,
    assetCode: 'LTC',
    amount: CLAIM.amount,
    creditKey: CLAIM.creditKey,
  })
  assert.equal(await openSink().flushPending('btc', 10), 0)
  assert.deepEqual(posted, [])
})

test('a claim whose account link has since been removed is left pending rather than deleted', { skip }, async () => {
  // The row is a real debt and the only record of it. Dropping it because the join no longer
  // resolves would erase money somebody is owed to tidy up a query.
  const workerId = await seedLinkedWorker()
  await claimPayoutCredit(db(), {
    chain: 'ltc',
    network: 'mainnet',
    blockHash: CLAIM.blockHash,
    blockHeight: CLAIM.blockHeight,
    workerId,
    account: CLAIM.account,
    assetCode: 'LTC',
    amount: CLAIM.amount,
    creditKey: CLAIM.creditKey,
  })
  await sql`delete from pool_account_links`

  const errors: string[] = []
  const sink = openSink({ log: (level, message) => { if (level === 'error') errors.push(message) } })
  assert.equal(await sink.flushPending('ltc', 10), 0)
  assert.deepEqual(posted, [])
  assert.equal(errors.length, 1, 'an unpayable claim was passed over in silence')
  const rows = await sql`select ledger_entry_id from pool_payout_credits`
  assert.equal(rows.length, 1, 'the claim was deleted')
  assert.equal(rows[0]?.['ledger_entry_id'], null)
})

test('a replica that lost the race to close a claim does not overwrite the winner', { skip }, async () => {
  // `markPayoutCredited` carries `ledger_entry_id is null` in its predicate for this case. The
  // ledger deduped on the same key, so there is no second entry — there is simply nothing to record.
  const workerId = await seedLinkedWorker()
  const id = await claimPayoutCredit(db(), {
    chain: 'ltc',
    network: 'mainnet',
    blockHash: CLAIM.blockHash,
    blockHeight: CLAIM.blockHeight,
    workerId,
    account: CLAIM.account,
    assetCode: 'LTC',
    amount: CLAIM.amount,
    creditKey: CLAIM.creditKey,
  })
  assert.ok(id !== null)
  assert.equal(await markPayoutCredited(db(), { chain: 'ltc', id, ledgerEntryId: 'first' }), true)
  assert.equal(await markPayoutCredited(db(), { chain: 'ltc', id, ledgerEntryId: 'second' }), false)
  const [row] = await sql`select ledger_entry_id from pool_payout_credits where id = ${id}`
  assert.equal(row?.['ledger_entry_id'], 'first')
})
