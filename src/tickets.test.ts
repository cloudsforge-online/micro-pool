/**
 * Mining tickets, and the opaque account a browser miner is credited under.
 *
 * Three properties are load-bearing and each has a test that fails if it is relaxed: a ticket is
 * **single-use**, it **expires**, and the store is **bounded**. The first is the reason a signed
 * stateless ticket was rejected — a value that verifies by arithmetic verifies as many times as it
 * is presented — and the third is not optional however trusted the caller is.
 *
 * The labels are checked against the character set `parseWorkerName` accepts, because an account
 * label this file generates and `session.ts` refuses would be a browser miner that authorises and
 * then cannot store a share, which is the worst of the available failures: the work is done and the
 * record is not.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  accountForUser,
  MAX_LIVE_TICKETS,
  newAccountLabel,
  newBrowserWorkerLabel,
  TICKET_TTL_MS,
  TicketStore,
} from './tickets.ts'
import { parseWorkerName } from './session.ts'
import type { Exec } from './store.ts'

test('a ticket is redeemed once and never again', () => {
  const store = new TicketStore()
  const minted = store.mint({ account: 'cf-0011223344556677', worker: 'web-abcdef' })

  assert.deepEqual(store.redeem(minted.secret), { account: 'cf-0011223344556677', worker: 'web-abcdef' })
  // The second attempt is the one that matters. A replayable ticket is a credential worth stealing,
  // and the single-use property is the only thing standing between a leaked value and somebody
  // else's account.
  assert.equal(store.redeem(minted.secret), null)
  assert.equal(store.size, 0)
})

test('a ticket expires', () => {
  let clock = 0
  const store = new TicketStore({ now: () => clock })
  const minted = store.mint({ account: 'cf-a', worker: 'web-a' })

  clock = TICKET_TTL_MS
  // Exactly at the deadline, not past it: a ticket whose life is defined as "sixty seconds" must not
  // be worth anything at the sixtieth.
  assert.equal(store.redeem(minted.secret), null)
})

test('a ticket presented one millisecond before the deadline still works', () => {
  let clock = 0
  const store = new TicketStore({ now: () => clock })
  const minted = store.mint({ account: 'cf-a', worker: 'web-a' })
  clock = TICKET_TTL_MS - 1
  assert.deepEqual(store.redeem(minted.secret), { account: 'cf-a', worker: 'web-a' })
})

test('a value that was never a ticket is refused exactly like a spent one', () => {
  const store = new TicketStore()
  // One answer for three cases on purpose. Distinguishing them would let anybody holding a candidate
  // value learn whether it was ever real, and an honest client does the same thing in all three: it
  // asks for another ticket.
  assert.equal(store.redeem('not-a-ticket'), null)
  assert.equal(store.redeem(''), null)
})

test('the store is bounded and drops the oldest rather than growing', () => {
  const store = new TicketStore({ max: 4 })
  const first = store.mint({ account: 'cf-1', worker: 'web-1' })
  store.mint({ account: 'cf-2', worker: 'web-2' })
  store.mint({ account: 'cf-3', worker: 'web-3' })
  store.mint({ account: 'cf-4', worker: 'web-4' })
  const last = store.mint({ account: 'cf-5', worker: 'web-5' })

  assert.equal(store.size, 4)
  // The oldest went. That costs its holder one retry; not dropping it costs this process its memory.
  assert.equal(store.redeem(first.secret), null)
  assert.deepEqual(store.redeem(last.secret), { account: 'cf-5', worker: 'web-5' })
})

test('expired tickets are swept on mint rather than on a timer', () => {
  // Rule 8: there is no `setInterval` in this repository. The store already has a clock that ticks
  // whenever anything happens, and an expired entry nobody mints past is an entry nobody can redeem.
  let clock = 0
  const store = new TicketStore({ now: () => clock })
  for (let i = 0; i < 10; i += 1) store.mint({ account: `cf-${i}`, worker: `web-${i}` })
  assert.equal(store.size, 10)

  clock = TICKET_TTL_MS + 1
  store.mint({ account: 'cf-fresh', worker: 'web-fresh' })
  assert.equal(store.size, 1)
})

test('two tickets never collide', () => {
  const store = new TicketStore()
  const secrets = new Set<string>()
  for (let i = 0; i < 500; i += 1) secrets.add(store.mint({ account: 'cf-a', worker: 'web-a' }).secret)
  assert.equal(secrets.size, 500)
})

test('the default bound is the one this service ships with', () => {
  assert.equal(MAX_LIVE_TICKETS, 10_000)
  assert.equal(TICKET_TTL_MS, 60_000)
})

/* ------------------------------------------------------------------ the labels */

test('a generated account label is one this pool could have stored', () => {
  for (let i = 0; i < 50; i += 1) {
    const account = newAccountLabel()
    const worker = newBrowserWorkerLabel()
    // The round trip that matters: an account this file generates and `session.ts` then refuses
    // would be a miner that authorises, hashes, and has no record of it.
    assert.deepEqual(parseWorkerName(`${account}.${worker}`), { account, worker })
    // And the shape the README publishes, so an operator reading `pool_workers` can tell a browser
    // account from the payout address every other row carries.
    assert.match(account, /^cf-[0-9a-f]{16}$/)
    assert.match(worker, /^web-[0-9a-f]{6}$/)
  }
})

test('an account label carries nothing about the user', () => {
  // `GET /v1/pool/shares?account=` is public. Crediting browser work to an estate user id would make
  // mining in a tab cost you a stable identifier anybody can enumerate work against.
  const labels = new Set(Array.from({ length: 200 }, () => newAccountLabel()))
  assert.equal(labels.size, 200)
})

/* ------------------------------------------------------------------ the account link */

/** An `Exec` that answers each query in turn from a script, recording what it was asked. */
function scriptedSql(answers: readonly unknown[][]): Exec & { readonly calls: string[] } {
  const calls: string[] = []
  let index = 0
  const exec = ((strings: TemplateStringsArray) => {
    calls.push(strings.join('?'))
    const answer = answers[index] ?? []
    index += 1
    return Promise.resolve(answer)
  }) as unknown as Exec & { calls: string[] }
  Object.defineProperty(exec, 'calls', { value: calls })
  return exec
}

test('an existing link is returned without inserting', async () => {
  const sql = scriptedSql([[{ account: 'cf-00112233445566aa' }]])
  assert.equal(await accountForUser(sql, 'user-1'), 'cf-00112233445566aa')
  assert.equal(sql.calls.length, 1)
  assert.match(sql.calls[0] ?? '', /update pool_account_links/)
})

test('a first-time user gets a link created', async () => {
  const sql = scriptedSql([[], [{ account: 'cf-1122334455667788' }]])
  assert.equal(await accountForUser(sql, 'user-2'), 'cf-1122334455667788')
  assert.match(sql.calls[1] ?? '', /insert into pool_account_links/)
})

test('two ticket requests racing produce ONE account, not two', async () => {
  // A React effect running twice in development fires this twice with no row yet. The unique
  // constraint settles it, `on conflict do nothing` makes the loser return no row, and the loser
  // then reads the winner's label. Two accounts for one user would split a share history in half
  // with no way to put it back together.
  const sql = scriptedSql([[], [], [{ account: 'cf-99887766554433aa' }]])
  assert.equal(await accountForUser(sql, 'user-3'), 'cf-99887766554433aa')
  assert.equal(sql.calls.length, 3)
})

test('a link that is neither inserted nor found is an error, not a silent second account', async () => {
  const sql = scriptedSql([[], [], []])
  await assert.rejects(() => accountForUser(sql, 'user-4'), /neither inserted nor found/)
})
