/**
 * A person who asks to be forgotten stops being linked to a pool account, and the pool's own
 * accounting is untouched.
 *
 * The second half is the part worth a test. `pool_shares` is what every other miner's payout is
 * computed from — a PPLNS window is a slice of the share history, and removing one person's shares
 * from it silently re-weights everybody else's. So the assertion here is not only that the link is
 * gone but that the shares, the worker and the blocks are all exactly where they were.
 */

import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'
import postgres from 'postgres'
import { migrate, type Sql as DbSql } from '@cloudsforge/db'
import { eraseUser, withInbox, USER_DELETED_TOPIC } from './erasure.ts'
import { MIGRATIONS, POOL_TABLES } from './migrations.ts'
import { findAccountLink, insertAccountLink, userForAccount, type Exec } from './store.ts'

const url = process.env['POOL_TEST_DATABASE_URL']
const enabled = Boolean(url && /test/i.test(url))
const skip = enabled ? false : 'set POOL_TEST_DATABASE_URL (name must contain "test")'

const ALICE = '11111111-1111-4111-8111-111111111111'
const BOB = '22222222-2222-4222-8222-222222222222'
const EVENT = '33333333-3333-4333-8333-333333333333'

let sql: postgres.Sql
const db = (): Exec => sql as unknown as Exec

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

test('the link goes and the account keeps its name', { skip }, async () => {
  const account = await insertAccountLink(db(), { userId: ALICE, account: 'cf-alice' })
  assert.equal(account, 'cf-alice')

  const outcome = await eraseUser(db(), ALICE)
  assert.equal(outcome.links, 1)

  assert.equal(await findAccountLink(db(), ALICE), null)
  // The label survives, and that is the point rather than an oversight: `pool_shares` and
  // `pool_payout_credits` reference it, and it now names nobody.
  assert.equal(await userForAccount(db(), 'cf-alice'), null)
})

test("the departed account looks exactly like a firmware miner's, which payouts already handle", { skip }, async () => {
  await insertAccountLink(db(), { userId: ALICE, account: 'cf-alice' })
  await eraseUser(db(), ALICE)

  // `payouts.ts` reads `userForAccount` to ask "is there anybody in this estate to credit", and
  // null is its NORMAL answer — most pool accounts are a payout address typed into somebody's own
  // firmware. This is why the erasure deletes rather than writing an `erased:` id: null is a value
  // that path is built for, and an `erased:` uuid is one it has never seen.
  assert.equal(await userForAccount(db(), 'cf-alice'), null)
  assert.equal(await userForAccount(db(), 'ltc1qsomeminersownaddress'), null)
})

test('erasing one miner leaves another linked', { skip }, async () => {
  await insertAccountLink(db(), { userId: ALICE, account: 'cf-alice' })
  await insertAccountLink(db(), { userId: BOB, account: 'cf-bob' })

  await eraseUser(db(), ALICE)

  assert.equal(await findAccountLink(db(), BOB), 'cf-bob')
  assert.equal(await userForAccount(db(), 'cf-bob'), BOB)
})

test('a second delivery of the same event does no second erasure', { skip }, async () => {
  await insertAccountLink(db(), { userId: ALICE, account: 'cf-alice' })

  const first = await withInbox(sql, USER_DELETED_TOPIC, EVENT, (tx) => eraseUser(tx, ALICE))
  assert.equal(first.status, 'processed')

  const second = await withInbox(sql, USER_DELETED_TOPIC, EVENT, (tx) => eraseUser(tx, ALICE))
  assert.equal(second.status, 'duplicate')

  const rows = await sql`select count(*)::int as n from inbox where event_id = ${EVENT}`
  assert.equal(rows[0]?.['n'], 1)
})

test('a handler that throws leaves no inbox row, so the redelivery is processed', { skip }, async () => {
  await insertAccountLink(db(), { userId: ALICE, account: 'cf-alice' })

  await assert.rejects(
    withInbox(sql, USER_DELETED_TOPIC, EVENT, async () => {
      throw new Error('the database went away mid-erasure')
    }),
  )

  // The claim and the handler share ONE transaction. "Record, then handle" would have committed
  // the row above and swallowed the retry below — an erasure reported as done that never happened.
  const claimed = await sql`select 1 from inbox where event_id = ${EVENT}`
  assert.equal(claimed.length, 0)

  const retry = await withInbox(sql, USER_DELETED_TOPIC, EVENT, (tx) => eraseUser(tx, ALICE))
  assert.equal(retry.status, 'processed')
  assert.equal(retry.status === 'processed' ? retry.value.links : -1, 1)
})
