import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import postgres from 'postgres'
import { migrate, type Sql as DbSql } from '@cloudsforge/db'
import { MIGRATIONS, POOL_CHAIN_TABLES, POOL_TABLES } from './migrations.ts'
import { difficultyUnits } from './pplns.ts'
import {
  chainActivity,
  insertShares,
  latestShareId,
  pplnsWindow,
  pruneShares,
  recentBlocks,
  recordBlock,
  sharesForAccount,
  upsertWorker,
  workersForAccount,
  findAccountLink,
  insertAccountLink,
  type Exec,
} from './store.ts'
import { accountForUser } from './tickets.ts'

/**
 * The store, in two tiers.
 *
 * The first needs no database at all: it reads `store.ts` as text and checks the invariant its own
 * header claims — **every statement that names a pool table also filters on `chain`**. A pool serving
 * Bitcoin and Litecoin has two independent accounting universes in one schema, and a single query
 * that forgot the column would divide a Bitcoin block's reward among Litecoin miners. That is not a
 * failure anybody notices from the outside; the numbers all look plausible.
 *
 * The second tier runs against a real Postgres, because the assertions worth making here are about
 * things no fake can have: a unique constraint settling a race, a window function's frame, `on
 * conflict do nothing` returning no row, and a delete that has to consult another table before it
 * removes anything. Gated on `POOL_TEST_DATABASE_URL`, whose name must contain "test" — the estate's
 * standard guard against a suite that truncates a database somebody cared about.
 */

/* ------------------------------------------------------------------ the scoping invariant */

/**
 * Strip comments, so an assertion about SQL cannot be satisfied — or defeated — by prose.
 *
 * `store.ts` discusses its own statements in the surrounding comments and names the tables while
 * doing it. Those sentences are not statements, and a sweep that could not tell the difference would
 * be checking the documentation.
 */
function code(source: string): string {
  const lines: string[] = []
  let inBlock = false
  for (const line of source.split('\n')) {
    const trimmed = line.trim()
    if (inBlock) {
      if (trimmed.includes('*' + '/')) inBlock = false
      continue
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*' + '/')) inBlock = true
      continue
    }
    if (trimmed.startsWith('//')) continue
    lines.push(line)
  }
  return lines.join('\n')
}

test('every statement that touches a pool table filters on the chain', () => {
  // Checked against the source rather than trusted to review. The schema cannot enforce this — a
  // chain is a column, not a database — so this sweep is the only thing standing between the estate
  // and a query that reads both chains' shares as one.
  const source = code(readFileSync(new URL('./store.ts', import.meta.url), 'utf8'))
  const literals = source.match(/`[^`]*`/g) ?? []
  // Driven by the CHAIN-scoped tables, not by every table this service owns. `pool_account_links`
  // maps an estate user to their pool account label and carries no chain column at all — migration 3
  // explains why a person is not per chain — so sweeping it here would demand a filter on a column
  // that does not exist, and the only way to satisfy that would be to add one.
  const statements = literals.filter((literal) =>
    POOL_CHAIN_TABLES.some((table) => new RegExp(`\\b${table}\\b`).test(literal)),
  )
  assert.ok(statements.length >= 8, `expected the store's statements, found ${statements.length}`)
  for (const statement of statements) {
    const first = statement.split('\n')[1]?.trim() ?? statement.slice(0, 60)
    assert.match(statement, /\bchain\b/, `statement does not scope the chain: ${first}`)
  }
})

test('no statement in the store names a table this service does not own', () => {
  // Rule 1, from the other direction. A pool reading `wallet_balances` would be a distributed
  // monolith's first step, and the estate's CI greps for a second connection string but not for a
  // foreign table name.
  const source = code(readFileSync(new URL('./store.ts', import.meta.url), 'utf8'))
  const tables = new Set(
    (source.match(/\b(?:from|join|into|update)\s+([a-z_][a-z0-9_]*)/g) ?? []).map(
      (match) => match.split(/\s+/)[1] ?? '',
    ),
  )
  // `set` gets in because `on conflict … do update set` puts a keyword exactly where a table name
  // goes. Filtering keywords rather than dropping `update` from the pattern, so a real `update
  // wallet_balances` would still be caught.
  const keywords = new Set(['set', 'select'])
  const allowed = new Set([...POOL_TABLES, 'floor_id', 'windowed', 'included', 'doomed'])
  for (const table of tables) {
    if (keywords.has(table)) continue
    assert.ok(allowed.has(table), `store.ts reads a table it does not own: ${table}`)
  }
})

/* ------------------------------------------------------------------ database-backed */

const url = process.env['POOL_TEST_DATABASE_URL']
const enabled = Boolean(url && /test/i.test(url))
const skip = enabled ? false : 'set POOL_TEST_DATABASE_URL (name must contain "test")'

let sql: postgres.Sql
const db = (): Exec => sql as unknown as Exec

const UNIT = difficultyUnits(1)

async function seedShares(
  chain: 'btc' | 'ltc',
  account: string,
  worker: string,
  count: number,
  perShare: bigint = UNIT,
): Promise<number> {
  const workerId = await upsertWorker(db(), { chain, account, worker }, perShare)
  await insertShares(
    db(),
    Array.from({ length: count }, (_unused, index) => ({
      chain,
      workerId,
      jobId: `job-${index}`,
      height: 800_000 + index,
      difficultyUnits: perShare,
      achievedUnits: perShare * 3n,
      isBlock: false,
    })),
  )
  return workerId
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
  await sql.unsafe(`truncate ${POOL_TABLES.join(', ')} restart identity cascade`)
})

test('a worker is created once and found thereafter', { skip }, async () => {
  const first = await upsertWorker(db(), { chain: 'btc', account: 'acct', worker: 'rig1' }, UNIT)
  const second = await upsertWorker(db(), { chain: 'btc', account: 'acct', worker: 'rig1' }, UNIT * 2n)
  assert.equal(first, second, 'one rig became two rows')
  const [row] = await sql`select last_difficulty::text from pool_workers where id = ${first}`
  assert.equal(row?.['last_difficulty'], (UNIT * 2n).toString())
})

test('a worker with no difficulty yet does not erase the one on file', { skip }, async () => {
  // `mining.authorize` arrives before any difficulty is known for a reconnecting rig, and the
  // upsert on that path passes null. Overwriting would blank the number the page shows.
  const id = await upsertWorker(db(), { chain: 'btc', account: 'acct', worker: 'rig1' }, UNIT)
  await upsertWorker(db(), { chain: 'btc', account: 'acct', worker: 'rig1' })
  const [row] = await sql`select last_difficulty::text from pool_workers where id = ${id}`
  assert.equal(row?.['last_difficulty'], UNIT.toString())
})

test('one name on two chains is two workers', { skip }, async () => {
  // The same rig can mine Bitcoin on 3333 and Litecoin on 3334 under the same label, and the two
  // must never share a share history: the difficulties are not comparable and the rewards are
  // different assets.
  const btc = await upsertWorker(db(), { chain: 'btc', account: 'acct', worker: 'rig1' })
  const ltc = await upsertWorker(db(), { chain: 'ltc', account: 'acct', worker: 'rig1' })
  assert.notEqual(btc, ltc)
})

test('an unnamed worker is a worker, because a username with no dot is legal', { skip }, async () => {
  const id = await upsertWorker(db(), { chain: 'btc', account: 'acct', worker: '' })
  assert.ok(id > 0)
  const workers = await workersForAccount(db(), { chain: 'btc', account: 'acct', sinceSeconds: 3600 })
  assert.equal(workers.length, 1)
  assert.equal(workers[0]?.worker, '')
})

test('shares are recorded in bulk and read back exactly', { skip }, async () => {
  // Exactly: the weights are bigints on both sides of the driver, and the whole reason they are
  // integers is that a float sum of a hundred thousand of them is not associative.
  await seedShares('btc', 'acct', 'rig1', 3)
  const shares = await sharesForAccount(db(), { chain: 'btc', account: 'acct', limit: 10 })
  assert.equal(shares.length, 3)
  assert.equal(shares[0]?.difficultyUnits, UNIT)
  assert.equal(shares[0]?.achievedUnits, UNIT * 3n)
  assert.equal(typeof shares[0]?.difficultyUnits, 'bigint')
  // Newest first, which is the order a miner reads their own log in.
  assert.deepEqual(
    shares.map((share) => share.height),
    [800_002, 800_001, 800_000],
  )
})

test('an empty share batch does not issue a statement', { skip }, async () => {
  // The flush timer fires on an idle pool too.
  await assert.doesNotReject(() => insertShares(db(), []))
})

test('a share history is scoped to the chain it was mined on', { skip }, async () => {
  await seedShares('btc', 'acct', 'rig1', 2)
  await seedShares('ltc', 'acct', 'rig1', 5)
  assert.equal((await sharesForAccount(db(), { chain: 'btc', account: 'acct', limit: 50 })).length, 2)
  assert.equal((await sharesForAccount(db(), { chain: 'ltc', account: 'acct', limit: 50 })).length, 5)
})

test('the newest share id is the end of a window, per chain', { skip }, async () => {
  assert.equal(await latestShareId(db(), 'btc'), null)
  await seedShares('btc', 'acct', 'rig1', 2)
  await seedShares('ltc', 'acct', 'rig1', 2)
  const btc = await latestShareId(db(), 'btc')
  const ltc = await latestShareId(db(), 'ltc')
  assert.ok(btc !== null && ltc !== null)
  assert.notEqual(btc, ltc, 'the two chains share a sequence but must not share a window')
})

test('the newest share id is the numerically newest, across a digit boundary', { skip }, async () => {
  // The regression that found a real defect. `select id::text … order by id` sorts by the CAST
  // column, because its output name is also `id` — so it answered 9 out of ten shares, and would
  // answer 999,999 out of two million. Eleven rows is the smallest table that can tell the two
  // orderings apart, which is why this is not folded into the test above.
  await seedShares('btc', 'acct', 'rig1', 11)
  const [truth] = await sql<{ m: string }[]>`select max(id)::text as m from pool_shares where chain = 'btc'`
  assert.equal(await latestShareId(db(), 'btc'), BigInt(truth?.m ?? '0'))
  assert.equal(await latestShareId(db(), 'btc'), 11n)
})

test('the PPLNS window sums by worker and stops at the requested weight', { skip }, async () => {
  // Ten shares of one unit each; a window of four units. The boundary rule includes the share that
  // crosses the line, so four shares come back — and which four is fixed, because a miner
  // reproducing our arithmetic has to get the same set.
  const workerId = await seedShares('btc', 'acct', 'rig1', 10)
  const end = await latestShareId(db(), 'btc')
  assert.ok(end !== null)
  const window = await pplnsWindow(db(), { chain: 'btc', endShareId: end, windowUnits: UNIT * 4n })
  assert.equal(window.rows.length, 1)
  assert.equal(window.rows[0]?.workerId, workerId)
  assert.equal(window.totalUnits, UNIT * 4n)
  assert.equal(window.lastShareId, end)
  assert.equal(window.firstShareId, end - 3n)
})

test('a window divides between workers in proportion to what they submitted', { skip }, async () => {
  const alice = await seedShares('btc', 'alice', 'rig', 3)
  const bob = await seedShares('btc', 'bob', 'rig', 1)
  const end = await latestShareId(db(), 'btc')
  const window = await pplnsWindow(db(), { chain: 'btc', endShareId: end as bigint, windowUnits: UNIT * 100n })
  const byWorker = new Map(window.rows.map((row) => [row.workerId, row.units]))
  assert.equal(byWorker.get(alice), UNIT * 3n)
  assert.equal(byWorker.get(bob), UNIT)
  assert.equal(window.totalUnits, UNIT * 4n)
  // The account and label come back with the units, because the payout that does not exist yet will
  // need them and because the page shows them.
  assert.deepEqual(window.rows.map((row) => row.account).sort(), ['alice', 'bob'])
})

test('a window never reaches across chains', { skip }, async () => {
  // The single most costly mistake this schema allows, and the reason the sweep at the top of this
  // file exists.
  await seedShares('btc', 'alice', 'rig', 2)
  await seedShares('ltc', 'bob', 'rig', 8)
  const end = await latestShareId(db(), 'ltc')
  const window = await pplnsWindow(db(), { chain: 'btc', endShareId: end as bigint, windowUnits: UNIT * 100n })
  assert.deepEqual(
    window.rows.map((row) => row.account),
    ['alice'],
  )
  assert.equal(window.totalUnits, UNIT * 2n)
})

test('a window ending before a share does not include it', { skip }, async () => {
  // `endShareId` is a claim about the moment a block was found. Shares that arrived after are not
  // part of it, however recently.
  await seedShares('btc', 'acct', 'rig', 4)
  const [row] = await sql<{ share_id: string }[]>`select id::text as share_id from pool_shares order by id limit 1`
  const window = await pplnsWindow(db(), {
    chain: 'btc',
    endShareId: BigInt(row?.share_id ?? '0'),
    windowUnits: UNIT * 100n,
  })
  assert.equal(window.totalUnits, UNIT)
})

test('an empty window is empty rather than an error', { skip }, async () => {
  const window = await pplnsWindow(db(), { chain: 'btc', endShareId: 1n, windowUnits: UNIT * 100n })
  assert.deepEqual(window.rows, [])
  assert.equal(window.totalUnits, 0n)
  assert.equal(window.firstShareId, null)
})

test('a block is recorded once however many times it is submitted', { skip }, async () => {
  // A submission retried after a lost response reaches here twice, and the second must not become a
  // second block. The caller cannot tell the two apart, which is correct: there is one block.
  const workerId = await seedShares('btc', 'acct', 'rig', 1)
  const block = {
    chain: 'btc' as const,
    shareChain: 'btc' as const,
    height: 800_000,
    hash: 'a'.repeat(64),
    foundByWorkerId: workerId,
    networkDifficultyUnits: UNIT * 1000n,
    reward: 312_500_000n,
    submitStatus: 'accepted',
    submitDetail: null,
    windowFirstShareId: 1n,
    windowLastShareId: 1n,
  }
  const first = await recordBlock(db(), block)
  const second = await recordBlock(db(), block)
  assert.equal(first, second)
  const [count] = await sql<{ n: string }[]>`select count(*)::text as n from pool_blocks`
  assert.equal(count?.n, '1')
})

test('a block the node rejected is recorded with what it said', { skip }, async () => {
  // The single most important thing to be able to look at. A pool that stores only the blocks the
  // node liked has no record of the ones it did not.
  await recordBlock(db(), {
    chain: 'btc',
    shareChain: 'btc',
    height: 800_000,
    hash: 'b'.repeat(64),
    foundByWorkerId: null,
    networkDifficultyUnits: UNIT,
    reward: 0n,
    submitStatus: 'rejected',
    submitDetail: 'bad-txnmrklroot',
    windowFirstShareId: null,
    windowLastShareId: null,
  })
  const blocks = await recentBlocks(db(), { chain: 'btc', limit: 10 })
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0]?.submitStatus, 'rejected')
  assert.equal(blocks[0]?.submitDetail, 'bad-txnmrklroot')
})

test('the same block hash on two chains is two rows', { skip }, async () => {
  // Impossible in practice and cheap to allow for; the uniqueness is on (chain, hash) rather than
  // on hash for the same reason every other table here is scoped.
  const hash = 'c'.repeat(64)
  const base = {
    height: 1,
    hash,
    foundByWorkerId: null,
    networkDifficultyUnits: UNIT,
    reward: 0n,
    submitStatus: 'accepted',
    submitDetail: null,
    windowFirstShareId: null,
    windowLastShareId: null,
  }
  const btc = await recordBlock(db(), { ...base, chain: 'btc', shareChain: 'btc' })
  const ltc = await recordBlock(db(), { ...base, chain: 'ltc', shareChain: 'ltc' })
  assert.notEqual(btc, ltc)
})

test('activity is summed per chain and returned as raw work, not a hashrate', { skip }, async () => {
  // Raw on purpose: turning work into a hashrate needs the chain's algorithm, and a store that
  // assumed SHA-256d would report every Litecoin miner as 65,536 times faster than they are.
  await seedShares('btc', 'alice', 'rig', 3)
  await seedShares('btc', 'bob', 'rig', 2)
  await seedShares('ltc', 'alice', 'rig', 7)
  const btc = await chainActivity(db(), { chain: 'btc', sinceSeconds: 3600 })
  assert.equal(btc.shares, 5)
  assert.equal(btc.units, UNIT * 5n)
  assert.equal(btc.workers, 2)
  const ltc = await chainActivity(db(), { chain: 'ltc', sinceSeconds: 3600 })
  assert.equal(ltc.shares, 7)
})

test('activity over an empty interval is zero rather than null', { skip }, async () => {
  const activity = await chainActivity(db(), { chain: 'btc', sinceSeconds: 3600 })
  assert.deepEqual(activity, { shares: 0, units: 0n, workers: 0 })
})

test('a worker listing includes one that has submitted nothing recently', { skip }, async () => {
  // The left join is the point: a rig that mined last week still exists, and a page that dropped it
  // would tell its owner their worker was gone.
  await seedShares('btc', 'acct', 'busy', 3)
  await upsertWorker(db(), { chain: 'btc', account: 'acct', worker: 'idle' })
  const workers = await workersForAccount(db(), { chain: 'btc', account: 'acct', sinceSeconds: 3600 })
  assert.deepEqual(
    workers.map((worker) => [worker.worker, worker.recentShares]),
    [
      ['busy', 3],
      ['idle', 0],
    ],
  )
  assert.equal(workers[1]?.recentUnits, 0n)
})

test('pruning removes old shares and stops at the oldest window a block depends on', { skip }, async () => {
  // The floor is not a nicety. A block's allocation is reproducible only while the shares it names
  // still exist, and §6 says the miner has to be able to check it — so pruning by age alone would
  // make the pool's own record of who earned what unverifiable, oldest block first.
  const workerId = await seedShares('btc', 'acct', 'rig', 10)
  await sql`update pool_shares set created_at = now() - interval '90 days'`
  // Aliased away from `id` for the reason `latestShareId` documents at length: a bare `order by id`
  // over a `id::text` select list sorts the ids as words.
  const ids = await sql<{ share_id: string }[]>`select id::text as share_id from pool_shares order by id`
  const fifth = BigInt(ids[4]?.share_id ?? '0')
  await recordBlock(db(), {
    chain: 'btc',
    shareChain: 'btc',
    height: 800_000,
    hash: 'd'.repeat(64),
    foundByWorkerId: workerId,
    networkDifficultyUnits: UNIT,
    reward: 1n,
    submitStatus: 'accepted',
    submitDetail: null,
    windowFirstShareId: fifth,
    windowLastShareId: BigInt(ids[9]?.share_id ?? '0'),
  })

  const pruned = await pruneShares(db(), { chain: 'btc', retentionDays: 30, limit: 1000 })
  assert.equal(pruned, 4, 'pruning crossed into the window a block depends on')
  const remaining = await sql<{ n: string }[]>`select count(*)::text as n from pool_shares`
  assert.equal(remaining[0]?.n, '6')
})

test('pruning leaves shares that are merely young', { skip }, async () => {
  await seedShares('btc', 'acct', 'rig', 5)
  assert.equal(await pruneShares(db(), { chain: 'btc', retentionDays: 30, limit: 1000 }), 0)
})

test('pruning one chain does not touch another', { skip }, async () => {
  await seedShares('btc', 'acct', 'rig', 4)
  await seedShares('ltc', 'acct', 'rig', 4)
  await sql`update pool_shares set created_at = now() - interval '90 days'`
  await pruneShares(db(), { chain: 'btc', retentionDays: 30, limit: 1000 })
  const [ltc] = await sql<{ n: string }[]>`select count(*)::text as n from pool_shares where chain = 'ltc'`
  assert.equal(ltc?.n, '4')
})

test('a merge-mined block protects the PARENT chain shares its window names', { skip }, async () => {
  // KILLS THE MUTATION `where share_chain = ${args.chain}` -> `where chain = ${args.chain}` in
  // `pruneShares`'s floor CTE, which is what the query actually said until 2026-08-11.
  //
  // A Dogecoin block is won by LITECOIN shares: the row carries `chain = 'doge'` and
  // `share_chain = 'ltc'`, and its `window_first_share_id` points into `pool_shares` where
  // `chain = 'ltc'`. Keyed on `chain`, the Litecoin prune never sees that block, the floor collapses
  // to the `coalesce` sentinel, and all ten shares go — after which the block allocates over zero
  // shares, the whole reward becomes the pool fee, and the miner who found it is paid nothing with
  // no error raised anywhere. The parent-chain tests above cannot catch it, because on a block whose
  // `share_chain` equals its `chain` the two predicates select the same rows.
  const workerId = await seedShares('ltc', 'acct', 'rig', 10)
  await sql`update pool_shares set created_at = now() - interval '90 days'`
  const ids = await sql<{ share_id: string }[]>`select id::text as share_id from pool_shares order by id`
  await recordBlock(db(), {
    chain: 'doge',
    shareChain: 'ltc',
    height: 5_000_000,
    hash: 'e'.repeat(64),
    foundByWorkerId: workerId,
    networkDifficultyUnits: UNIT,
    reward: 1n,
    submitStatus: 'accepted',
    submitDetail: null,
    windowFirstShareId: BigInt(ids[4]?.share_id ?? '0'),
    windowLastShareId: BigInt(ids[9]?.share_id ?? '0'),
  })

  const pruned = await pruneShares(db(), { chain: 'ltc', retentionDays: 30, limit: 1000 })
  assert.equal(pruned, 4, 'the prune crossed into the window a merge-mined block depends on')
  const remaining = await sql<{ n: string }[]>`select count(*)::text as n from pool_shares`
  assert.equal(remaining[0]?.n, '6')
})

test('pruning respects its batch limit, so one call cannot lock the table for a minute', { skip }, async () => {
  await seedShares('btc', 'acct', 'rig', 10)
  await sql`update pool_shares set created_at = now() - interval '90 days'`
  assert.equal(await pruneShares(db(), { chain: 'btc', retentionDays: 30, limit: 3 }), 3)
  assert.equal(await pruneShares(db(), { chain: 'btc', retentionDays: 30, limit: 3 }), 3)
})

/* ------------------------------------------------ the account link (micro-org#289) */

test('a first ticket request creates the link, and every later one finds it', { skip }, async () => {
  assert.equal(await findAccountLink(db(), 'user-1'), null)
  assert.equal(await insertAccountLink(db(), { userId: 'user-1', account: 'cf-00112233445566aa' }), 'cf-00112233445566aa')
  assert.equal(await findAccountLink(db(), 'user-1'), 'cf-00112233445566aa')
  // The label is minted once and never re-minted. A user whose account label changed between two
  // ticket requests would have their share history split across two accounts with nothing joining
  // them, and no way to put it back together after the fact.
  assert.equal(await accountForUser(db(), 'user-1'), 'cf-00112233445566aa')
})

test('the loser of a race gets no row back rather than overwriting the winner', { skip }, async () => {
  // The whole reason the statement is `do nothing` and not `do update`. A React effect running twice
  // in development fires two ticket requests with no row yet; both must end up with ONE label.
  await insertAccountLink(db(), { userId: 'user-2', account: 'cf-1111111111111111' })
  assert.equal(await insertAccountLink(db(), { userId: 'user-2', account: 'cf-2222222222222222' }), null)
  assert.equal(await findAccountLink(db(), 'user-2'), 'cf-1111111111111111')
})

test('two users cannot end up sharing one account label', { skip }, async () => {
  // The second half of the constraint. Collision is astronomically unlikely — the label is sixteen
  // hex characters of `randomBytes` — but the failure it would cause is one person's work appearing
  // in another person's page, so the database refuses rather than trusting the entropy.
  await insertAccountLink(db(), { userId: 'user-3', account: 'cf-3333333333333333' })
  await assert.rejects(() => insertAccountLink(db(), { userId: 'user-4', account: 'cf-3333333333333333' }))
})

test('accountForUser is safe to call concurrently and yields one label', { skip }, async () => {
  const results = await Promise.all(Array.from({ length: 8 }, () => accountForUser(db(), 'user-5')))
  assert.equal(new Set(results).size, 1, `${new Set(results).size} labels were minted for one user`)
  const rows = await sql<{ n: string }[]>`select count(*)::text as n from pool_account_links`
  assert.equal(rows[0]?.n, '1')
})

test('finding a link touches last_used_at, so a dormant account is visible as one', { skip }, async () => {
  await insertAccountLink(db(), { userId: 'user-6', account: 'cf-6666666666666666' })
  await sql`update pool_account_links set last_used_at = now() - interval '30 days'`
  await findAccountLink(db(), 'user-6')
  const [row] = await sql<{ stale: boolean }[]>`
    select last_used_at < now() - interval '1 minute' as stale from pool_account_links where user_id = 'user-6'
  `
  assert.equal(row?.stale, false, 'a redeemed link did not record that it was used')
})

test('a browser account is a pool account like any other, and joins to its shares', { skip }, async () => {
  // The end of the chain: the label in `pool_account_links` is an ordinary `pool_workers.account`,
  // which is what makes the public read routes work for a browser miner with no change at all.
  const account = await accountForUser(db(), 'user-7')
  await seedShares('ltc', account, 'web-abc123', 3)
  const shares = await sharesForAccount(db(), { chain: 'ltc', account, limit: 10 })
  assert.equal(shares.length, 3)
  const workers = await workersForAccount(db(), { chain: 'ltc', account, sinceSeconds: 3_600 })
  assert.deepEqual(workers.map((w) => w.worker), ['web-abc123'])
})

test('the account link survives a chain being pruned out from under it', { skip }, async () => {
  // The link is not chain-scoped and nothing chain-scoped may delete it. Losing it would mint the
  // same user a SECOND label on their next ticket and orphan every share under the first.
  const account = await accountForUser(db(), 'user-8')
  await seedShares('btc', account, 'web-aaaaaa', 4)
  await sql`update pool_shares set created_at = now() - interval '90 days'`
  await pruneShares(db(), { chain: 'btc', retentionDays: 30, limit: 1000 })
  assert.equal(await findAccountLink(db(), 'user-8'), account)
})
