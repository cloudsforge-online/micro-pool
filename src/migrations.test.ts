/**
 * The migration set.
 *
 * `runtime/packages/db`'s `migrate()` refuses a set in which a released migration's `up` text has
 * changed, which makes a migration append-only the moment it ships. That rule is the reason these
 * tests are worth having: they are cheap now and they are the only warning available before a
 * changed migration reaches an environment that has already run it.
 *
 * The other assertion here is a negative one. There is no payouts table, and there must not be one
 * until payouts are actually implemented — a schema that looks ready to credit miners is the same
 * kind of lie as a function that returns without doing anything.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { JOBS_SCHEMA_SQL } from '@cloudsforge/jobs'
import { BASELINE_VERSION, MIGRATIONS, POOL_CHAIN_TABLES, POOL_TABLES, SCHEMA_VERSION } from './migrations.ts'

test('versions are unique, positive and strictly increasing', () => {
  const versions = MIGRATIONS.map((m) => m.version)
  assert.deepEqual(versions, [...versions].sort((a, b) => a - b), 'migrations are out of order')
  assert.equal(new Set(versions).size, versions.length, 'two migrations share a version')
  for (const version of versions) assert.ok(Number.isInteger(version) && version > 0)
})

test('every migration has a name', () => {
  // The name is what appears in the migration table and in an operator's log line when one fails.
  for (const migration of MIGRATIONS) {
    assert.ok(migration.name.length > 0, `migration ${migration.version} has no name`)
    assert.ok(migration.up.trim().length > 0, `migration ${migration.version} has an empty body`)
  }
})

test('SCHEMA_VERSION is the highest version in the set', () => {
  assert.equal(SCHEMA_VERSION, Math.max(...MIGRATIONS.map((m) => m.version)))
})

test('the baseline is zero, meaning a fresh database runs everything', () => {
  assert.equal(BASELINE_VERSION, 0)
})

test('the jobs schema is the runtime package verbatim, never a hand copy', () => {
  // Copying the DDL by hand is how a service ends up with a jobs table missing the (kind, key)
  // unique constraint, which silently turns every recurring enqueue into a duplicate run.
  const jobs = MIGRATIONS.find((m) => m.version === 1)
  assert.ok(jobs)
  assert.equal(jobs?.up, JOBS_SCHEMA_SQL)
})

test('the pool tables are created by the second migration', () => {
  const pool = MIGRATIONS.find((m) => m.version === 2)
  assert.ok(pool)
  for (const table of ['pool_workers', 'pool_shares', 'pool_blocks']) {
    assert.match(pool?.up ?? '', new RegExp(`create table if not exists ${table}`))
  }
})

test('every pool table is scoped by chain', () => {
  // One database, two chains. A table without a chain column is a table in which a Bitcoin share and
  // a Litecoin share are the same row, and PPLNS would then divide a Bitcoin block among miners who
  // were mining Litecoin.
  const pool = MIGRATIONS.find((m) => m.version === 2)?.up ?? ''
  for (const table of ['pool_workers', 'pool_shares']) {
    const body = pool.slice(pool.indexOf(`create table if not exists ${table}`))
    const firstStatementEnd = body.indexOf(');')
    assert.ok(firstStatementEnd > 0, `could not find the end of ${table}`)
    assert.match(body.slice(0, firstStatementEnd), /\bchain\b/, `${table} is not scoped by chain`)
  }
})

test('there is no payouts table', () => {
  // Payouts are not implemented. A table named for them would be read by the next person as a
  // half-finished feature rather than as an unstarted one, and the difference matters when the
  // question is "has anybody been paid?".
  //
  // Checked against the DDL with SQL comments stripped, because the prose in this file discusses
  // payouts at length — including a comment whose whole purpose is to record that the table is
  // absent on purpose. A grep that could not tell those apart would fail on the explanation for why
  // it should pass.
  const ddl = MIGRATIONS.map((m) => m.up)
    .join('\n')
    .replace(/--[^\n]*/g, '')
    .toLowerCase()
  for (const forbidden of ['payout', 'credit_key', 'balance']) {
    assert.ok(
      !ddl.includes(forbidden),
      `the schema itself names "${forbidden}", but nothing in this release credits anybody`,
    )
  }
})

test('migrations are idempotent in shape', () => {
  // Every table creation guards itself, so a re-run against a partially migrated database does not
  // fail on the first object that already exists.
  const pool = MIGRATIONS.find((m) => m.version === 2)?.up ?? ''
  const creates = pool.match(/create table (?!if not exists)/g)
  assert.equal(creates, null, 'a table is created without `if not exists`')
})

/* ------------------------------------------------ the account link (micro-org#289) */

test('THE ACCOUNT LINK IS A NEW TABLE, AND `pool_workers` DID NOT GROW A USER COLUMN', () => {
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // The property migration 2 wrote down and this change had to preserve: there is no join from a
  // worker to an estate user, because a miner points hardware at a port and gives an address, and
  // requiring an account first would exclude every miner who already has one.
  //
  // The obvious implementation of browser mining — a nullable `user_id` on `pool_workers` — would
  // have retired that sentence quietly. It is not made. This test fails if anybody makes it later.
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  const workers = MIGRATIONS.find((m) => m.version === 2)?.up ?? ''
  const body = workers.slice(workers.indexOf('create table if not exists pool_workers'))
  assert.ok(!/\buser_id\b/.test(body.slice(0, body.indexOf(');'))), 'pool_workers grew a user column')
  // And no later migration added one either, which is the version of this check that keeps working.
  const later = MIGRATIONS.filter((m) => m.version > 2)
    .map((m) => m.up.replace(/--[^\n]*/g, ''))
    .join('\n')
  assert.ok(!/alter table\s+pool_workers/i.test(later), 'a later migration altered pool_workers')

  const link = MIGRATIONS.find((m) => m.version === 3)
  assert.equal(link?.name, 'account-links')
  assert.match(link?.up ?? '', /create table if not exists pool_account_links/)
})

test('one user has one account and one account has one user', () => {
  // Both halves are load-bearing and neither is decoration. Without the first, two ticket requests
  // racing on first use produce two labels and split a share history in half with no way to put it
  // back together. Without the second, one person's work can be credited into another's page.
  const link = MIGRATIONS.find((m) => m.version === 3)?.up ?? ''
  assert.match(link, /user_id\s+text\s+primary key/)
  assert.match(link, /unique \(account\)/)
})

test('the account link is not chain-scoped, and the scoping sweep knows it', () => {
  // The one table here whose rows do not belong to a chain, because a person does not. If it were
  // in `POOL_CHAIN_TABLES` the sweep in `store.test.ts` would demand a `chain` filter on a statement
  // that has no chain to filter by, and the fix somebody reached for would be a column.
  assert.ok(!POOL_CHAIN_TABLES.includes('pool_account_links'))
  assert.ok(POOL_TABLES.includes('pool_account_links'))
  // Every chain-scoped table is still in the full list, so the sweep and the teardown stay in step.
  for (const table of POOL_CHAIN_TABLES) assert.ok(POOL_TABLES.includes(table), `${table} is missing`)
})

test('the account link stores no estate identity beyond the id, and no ticket', () => {
  // A ticket lives for sixty seconds in memory; a row lives for ever. A handle or an email here
  // would make a browser miner's estate identity a permanent property of the pool's database, and
  // `GET /v1/pool/shares?account=` is public.
  const link = (MIGRATIONS.find((m) => m.version === 3)?.up ?? '').replace(/--[^\n]*/g, '').toLowerCase()
  for (const forbidden of ['email', 'handle', 'ticket', 'token', 'secret']) {
    assert.ok(!link.includes(forbidden), `the account link stores "${forbidden}"`)
  }
})

/* ------------------------------------------------ block maturity (micro-org#302) */

test('MATURITY IS A NEW COLUMN SET, AND `submit_status` WAS NOT REPURPOSED', () => {
  // The tempting shape was to widen `submit_status` with `matured` and `orphaned` values, and it is
  // wrong: they answer different questions at different times. `submit_status` is the node's verbatim
  // reply at the one moment it could be observed, and it is the only thing that separates "we built
  // the coinbase wrongly" from "we lost a race". A status rewritten in place would have destroyed
  // that evidence in exactly the case somebody needed it.
  const maturity = MIGRATIONS.find((m) => m.version === 4)
  assert.equal(maturity?.name, 'block-maturity')
  const up = maturity?.up ?? ''
  for (const column of ['maturity_status', 'confirmations', 'maturity_detail', 'maturity_checked_at', 'matured_at']) {
    assert.match(up, new RegExp(`add column if not exists\\s+${column}\\b`), `${column} is missing`)
  }
  assert.ok(!/drop column/i.test(up), 'the maturity migration drops a column')
  assert.ok(!/alter column\s+submit_status/i.test(up), 'the maturity migration rewrites the submission verdict')
})

test('A BLOCK NOBODY HAS CHECKED DEFAULTS TO PENDING, NOT TO MATURED', () => {
  // The direction that costs nothing to be wrong about. `pending` is not payable, so the failure mode
  // of a column defaulting the other way — every block already recorded silently becoming eligible
  // the moment the column appeared — is not available.
  const up = MIGRATIONS.find((m) => m.version === 4)?.up ?? ''
  assert.match(up, /maturity_status\s+text not null default 'pending'/)
  assert.match(up, /check \(maturity_status in \('pending', 'matured', 'orphaned'\)\)/)
})

test('THE BACK-FILL ONLY TOUCHES BLOCKS THE NODE ALREADY REFUSED', () => {
  // A rejected block was never on the chain, so `orphaned` is a fact about it rather than a guess,
  // and it is the one class of existing row a migration may settle without asking a node. Every
  // accepted block stays `pending` until the watcher has actually re-read it — including the ones
  // this pool found before the watcher existed.
  const up = MIGRATIONS.find((m) => m.version === 4)?.up ?? ''
  const update = up.slice(up.indexOf('update pool_blocks'))
  assert.match(update, /set maturity_status = 'orphaned'/)
  assert.match(update, /where submit_status <> 'accepted'/)
  assert.ok(!/set maturity_status = 'matured'/.test(up), 'a migration declared a block matured')
})
