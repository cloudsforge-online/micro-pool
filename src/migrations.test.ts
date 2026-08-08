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
import { BASELINE_VERSION, MIGRATIONS, SCHEMA_VERSION } from './migrations.ts'

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
