/**
 * The Stratum v1 state machine, driven by parsed messages.
 *
 * `session.ts` has no socket in it, which is what makes this file possible: every test below is a
 * sequence of `handle` calls and an assertion about what was sent. The framing, the timeouts and the
 * back-pressure are `stratum.test.ts`'s business.
 *
 * Two things here are worth more than the rest.
 *
 * **The ordering rules.** `mining.set_difficulty` must reach the miner before the first
 * `mining.notify`, because a miner that receives work before a difficulty assumes 1 — and difficulty
 * 1 on either of these chains means a modern machine submitting thousands of shares a second. The
 * protocol has no way to express "this job is at that difficulty"; the only thing that binds them is
 * the order they arrive in.
 *
 * **The rejection codes.** §6 of the multi-chain document says the failure that makes an honest pool
 * indistinguishable from a dishonest one is a miner unable to tell why its work was refused. Every
 * rejection below is checked for its specific code, not merely for being a rejection.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { JobRegistry, type Job } from './work.ts'
import { parseTemplate } from './template.ts'
import { fakeTemplateReply, fakeHashHex, FAKE_PAYOUT_SCRIPT, REGTEST_BITS } from './faketemplate.ts'
import { DEFAULT_VARDIFF } from './vardiff.ts'
import { STRATUM_ERROR } from './validate.ts'
// A value import, which the test tier may make and `session.ts` may not — see
// `browserdriven.test.ts`. Used so the harness feeds the same name production feeds, rather than
// a literal that would keep passing after contracts-chain renamed the chain.
import { nameFor } from './chains.ts'
import type { AddressVerdict } from './payoutaddress.ts'
import {
  parseWorkerName,
  Session,
  VERSION_ROLLING_MASK,
  type AcceptedShare,
  type FoundAuxBlock,
  type FoundBlock,
  type OutgoingMessage,
  type SpoiledAuxBlock,
  type SessionDeps,
} from './session.ts'

const EXTRANONCE1 = Buffer.from('a1b2c3d4', 'hex')
const START_MS = 1_760_000_500_000

interface Harness {
  readonly session: Session
  readonly sent: OutgoingMessage[]
  readonly shares: AcceptedShare[]
  readonly blocks: FoundBlock[]
  readonly auxBlocks: FoundAuxBlock[]
  readonly auxSpoiled: SpoiledAuxBlock[]
  readonly registry: JobRegistry
  readonly outcomes: { outcome: string; code: number | null }[]
  advance(ms: number): void
  pushTemplate(options?: Parameters<typeof fakeTemplateReply>[0]): Job
}

/**
 * The vardiff options the harness runs with.
 *
 * Identical to the shipped defaults but for `minDifficulty`, which has to drop below the shipped
 * 0.001 for a reason that is about the tests rather than about the pool. Every share here is mined
 * for real — there is no way to fake one, that is the point of proof of work — so the target has to
 * be reachable inside a loop. At 1/65536 a SHA-256d share turns up in about sixty-five thousand
 * attempts, which is a fraction of a second; at 0.001 it is four million, which is several seconds
 * per test and a suite nobody runs. `validate.test.ts` makes the same trade for the same reason.
 */
const TEST_VARDIFF = { ...DEFAULT_VARDIFF, minDifficulty: 1 / 65536 }

function harness(overrides: Partial<SessionDeps> = {}): Harness {
  const sent: OutgoingMessage[] = []
  const shares: AcceptedShare[] = []
  const blocks: FoundBlock[] = []
  const auxBlocks: FoundAuxBlock[] = []
  const auxSpoiled: SpoiledAuxBlock[] = []
  const outcomes: { outcome: string; code: number | null }[] = []
  let nowMs = START_MS

  const registry = new JobRegistry({
    chain: 'btc',
    tag: Buffer.from('/cloudsforge/', 'utf8'),
    extranonce1Size: 4,
    extranonce2Size: 4,
    now: () => nowMs,
  })
  registry.setPayoutScript(FAKE_PAYOUT_SCRIPT)

  const session = new Session({
    chain: 'btc',
    chainName: nameFor('btc'),
    algorithm: 'sha256d',
    registry,
    extranonce1: EXTRANONCE1,
    extranonce2Size: 4,
    // 1/65536 keeps a share findable inside a test. See `validate.test.ts` on why.
    initialDifficulty: 1 / 65536,
    minDifficulty: 1 / 65536,
    maxDifficulty: 4_294_967_296,
    vardiff: TEST_VARDIFF,
    now: () => nowMs,
    send: (message) => sent.push(message),
    onAcceptedShare: (share) => shares.push(share),
    onBlock: (block) => blocks.push(block),
    onAuxBlock: (block) => auxBlocks.push(block),
    onAuxSpoiled: (spoiled) => auxSpoiled.push(spoiled),
    onOutcome: (outcome, code) => outcomes.push({ outcome, code }),
    ...overrides,
  })

  return {
    session,
    sent,
    shares,
    blocks,
    auxBlocks,
    auxSpoiled,
    registry,
    outcomes,
    advance(ms) {
      nowMs += ms
    },
    pushTemplate(options) {
      return registry.push(parseTemplate(fakeTemplateReply({ bitsHex: REGTEST_BITS, ...options })))
    },
  }
}

/** Subscribe and authorise, the way every real connection starts. */
function connect(h: Harness, username = 'bc1qexampleaddress.rig1'): void {
  h.session.handle({ id: 1, method: 'mining.subscribe', params: ['cgminer/4.10.0'] })
  h.session.handle({ id: 2, method: 'mining.authorize', params: [username, 'x'] })
}

/** Find a nonce that this session will accept for the given job. */
function mineFor(h: Harness, job: Job, extranonce2Hex = '00000001'): string {
  for (let nonce = 0; nonce < 1_000_000; nonce += 1) {
    const nonceHex = nonce.toString(16).padStart(8, '0')
    const before = h.sent.length
    h.session.handle({
      id: 99,
      method: 'mining.submit',
      params: ['w', job.id, extranonce2Hex, job.ntimeHex, nonceHex],
    })
    const reply = h.sent.slice(before).find((m) => m.id === 99)
    if (reply?.result === true) return nonceHex
  }
  throw new Error('no acceptable share found')
}

/* ------------------------------------------------------------------ the handshake */

test('subscribe answers with the extranonce1 and extranonce2 size', () => {
  const h = harness()
  h.session.handle({ id: 1, method: 'mining.subscribe', params: [] })

  const reply = h.sent.find((m) => m.id === 1)
  assert.ok(reply)
  const result = reply?.result as [unknown, string, number]
  assert.equal(result[1], EXTRANONCE1.toString('hex'), 'extranonce1 must be this connection own')
  assert.equal(result[2], 4, 'extranonce2 size')
  // Firmware parses the subscription structure strictly even though nothing uses the ids.
  const subscriptions = result[0] as [string, string][]
  assert.deepEqual(subscriptions.map((s) => s[0]), ['mining.set_difficulty', 'mining.notify'])
})

test('authorize splits the username and answers true', () => {
  const h = harness()
  connect(h, 'bc1qexampleaddress.rig1')

  const reply = h.sent.find((m) => m.id === 2)
  assert.equal(reply?.result, true)
  assert.equal(h.session.account, 'bc1qexampleaddress')
  assert.equal(h.session.worker, 'rig1')
  assert.ok(h.session.authorised)
})

test('difficulty is sent before the first job, never after', () => {
  // The ordering rule the protocol cannot express any other way. A miner told a job first assumes
  // difficulty 1 and floods.
  const h = harness()
  h.pushTemplate()
  connect(h)

  const notifications = h.sent.filter((m) => m.method !== undefined)
  const difficultyAt = notifications.findIndex((m) => m.method === 'mining.set_difficulty')
  const notifyAt = notifications.findIndex((m) => m.method === 'mining.notify')
  assert.ok(difficultyAt >= 0, 'no set_difficulty was ever sent')
  assert.ok(notifyAt >= 0, 'no notify was ever sent')
  assert.ok(difficultyAt < notifyAt, 'the job reached the miner before its difficulty')
})

test('an empty or unstorable worker name is refused as unauthorized', () => {
  for (const username of ['', '   ', 'has space.rig', 'a'.repeat(200), 'bad<script>.rig']) {
    const h = harness()
    h.session.handle({ id: 1, method: 'mining.subscribe', params: [] })
    h.session.handle({ id: 2, method: 'mining.authorize', params: [username, 'x'] })
    const reply = h.sent.find((m) => m.id === 2)
    assert.equal(reply?.result, false, `${JSON.stringify(username)} was accepted`)
    assert.equal((reply?.error as [number, string, unknown])[0], STRATUM_ERROR.UNAUTHORIZED)
    assert.ok(!h.session.authorised)
  }
})

test('the password is never echoed anywhere', () => {
  // It is ignored by design — every pool treats it as a free-text options field — and because it is
  // ignored it must never be stored or reflected. A password appearing in a reply is a password in
  // somebody's log.
  const h = harness()
  h.session.handle({ id: 1, method: 'mining.subscribe', params: [] })
  h.session.handle({ id: 2, method: 'mining.authorize', params: ['acct.rig', 'hunter2'] })
  assert.ok(!JSON.stringify(h.sent).includes('hunter2'))
})

test('an unknown method is answered rather than ignored', () => {
  // Silence is how a miner ends up waiting for ever for a reply the pool decided not to send.
  const h = harness()
  h.session.handle({ id: 7, method: 'mining.nonsense', params: [] })
  const reply = h.sent.find((m) => m.id === 7)
  assert.ok(reply)
  assert.equal((reply?.error as [number, string, unknown])[0], STRATUM_ERROR.OTHER)
})

/* ------------------------------------------------------------------ ordering guards */

test('submitting before subscribing is refused with NOT_SUBSCRIBED', () => {
  const h = harness()
  h.session.handle({ id: 3, method: 'mining.submit', params: ['w', 'j', '00000001', '00000000', '00000000'] })
  const reply = h.sent.find((m) => m.id === 3)
  assert.equal((reply?.error as [number, string, unknown])[0], STRATUM_ERROR.NOT_SUBSCRIBED)
})

test('submitting before authorizing is refused with UNAUTHORIZED', () => {
  const h = harness()
  h.session.handle({ id: 1, method: 'mining.subscribe', params: [] })
  h.session.handle({ id: 3, method: 'mining.submit', params: ['w', 'j', '00000001', '00000000', '00000000'] })
  const reply = h.sent.find((m) => m.id === 3)
  assert.equal((reply?.error as [number, string, unknown])[0], STRATUM_ERROR.UNAUTHORIZED)
})

test('no job is pushed to a connection that has not authorised', () => {
  const h = harness()
  h.session.handle({ id: 1, method: 'mining.subscribe', params: [] })
  const job = h.pushTemplate()
  h.session.pushJob(job, true)
  assert.equal(h.sent.filter((m) => m.method === 'mining.notify').length, 0)
})

/* ------------------------------------------------------------------ shares */

test('a valid share is accepted, credited once, and reported', () => {
  const h = harness()
  const job = h.pushTemplate()
  connect(h)
  const nonceHex = mineFor(h, job)

  assert.equal(h.shares.length, 1, 'exactly one credit per accepted share')
  const share = h.shares[0]
  assert.equal(share?.account, 'bc1qexampleaddress')
  assert.equal(share?.worker, 'rig1')
  assert.equal(share?.jobId, job.id)
  assert.equal(share?.height, job.height)
  assert.ok((share?.difficultyUnits ?? 0n) > 0n, 'a share with no weight is not a share')
  assert.ok((share?.achievedUnits ?? 0n) >= (share?.difficultyUnits ?? 0n))
  assert.equal(h.session.counts.accepted, 1)
  assert.ok(nonceHex.length === 8)
})

test('A SHARE AGAINST A JOB THIS POOL RETIRED IS STALE, NOT DISHONEST', () => {
  const h = harness()
  const job = h.pushTemplate()
  connect(h)
  // A new tip retires everything built on the old parent — see `work.ts`. The miner was mid-attempt
  // on work that was valid when it started it, and the answer to that is code 21, which every miner
  // displays as "stale" and none of them counts as a fault.
  h.pushTemplate({ previousBlockHashHex: fakeHashHex('a-new-tip') })
  h.session.handle({
    id: 10,
    method: 'mining.submit',
    params: ['w', job.id, '00000001', '00000000', '00000000'],
  })
  const reply = h.sent.find((m) => m.id === 10)
  assert.equal((reply?.error as [number, string, unknown])[0], STRATUM_ERROR.JOB_NOT_FOUND)
  assert.match((reply?.error as [number, string, unknown])[1], /stale/)
  assert.equal(h.shares.length, 0)
})

test('A SHARE AGAINST AN ID THIS POOL NEVER ISSUED IS NOT STALE — micro-org#237', () => {
  // The other half of the same fix. Answering this "stale, fetch fresh work" is the cheap version
  // and it tells a client that fabricates job ids, or that is pointed at the wrong pool, to carry
  // on. Code 20 is what a malformed `mining.submit` gets, which is the right company for it.
  const h = harness()
  h.pushTemplate()
  connect(h)
  h.session.handle({
    id: 10,
    method: 'mining.submit',
    params: ['w', 'no-such-job', '00000001', '00000000', '00000000'],
  })
  const reply = h.sent.find((m) => m.id === 10)
  assert.equal((reply?.error as [number, string, unknown])[0], STRATUM_ERROR.OTHER)
  assert.match((reply?.error as [number, string, unknown])[1], /not issued by this pool/)
  assert.doesNotMatch((reply?.error as [number, string, unknown])[1], /fetch fresh work/)
  assert.equal(h.shares.length, 0)
})

test('the same solution submitted twice is a duplicate', () => {
  const h = harness()
  const job = h.pushTemplate()
  connect(h)
  const nonceHex = mineFor(h, job)

  h.session.handle({
    id: 11,
    method: 'mining.submit',
    params: ['w', job.id, '00000001', job.ntimeHex, nonceHex],
  })
  const reply = h.sent.find((m) => m.id === 11)
  assert.equal((reply?.error as [number, string, unknown])[0], STRATUM_ERROR.DUPLICATE_SHARE)
  // And it was not credited a second time.
  assert.equal(h.shares.length, 1)
})

test('a duplicate is caught before the hash is computed', () => {
  // Recorded before hashing so a replayed share costs one set lookup rather than one scrypt. Checked
  // by replaying something that is NOT a valid share: it must come back as a duplicate on the second
  // attempt, which can only happen if the key was recorded before validation rejected it.
  const h = harness()
  const job = h.pushTemplate()
  connect(h)
  const bad = ['w', job.id, '00000001', job.ntimeHex, 'ffffffff']
  h.session.handle({ id: 20, method: 'mining.submit', params: bad })
  h.session.handle({ id: 21, method: 'mining.submit', params: bad })
  const second = h.sent.find((m) => m.id === 21)
  assert.equal((second?.error as [number, string, unknown])[0], STRATUM_ERROR.DUPLICATE_SHARE)
})

test('a malformed submit is refused without being credited', () => {
  const h = harness()
  h.pushTemplate()
  connect(h)
  h.session.handle({ id: 12, method: 'mining.submit', params: ['w', 123, '00000001'] })
  const reply = h.sent.find((m) => m.id === 12)
  assert.equal((reply?.error as [number, string, unknown])[0], STRATUM_ERROR.OTHER)
  assert.equal(h.shares.length, 0)
})

test('a share that is a block is reported as both a share and a block', () => {
  // Never one instead of the other: a share that is a block is still the share it was, and losing
  // that row loses the accounting for the most valuable submission the pool will ever receive.
  const h = harness()
  // Against `REGTEST_BITS` the block target is easier than the share target, so the first accepted
  // share is necessarily also a block — which is the only way to reach this branch without finding a
  // real one. It is the same trick a regtest node plays, for the same reason.
  const job = h.pushTemplate({ bitsHex: REGTEST_BITS })
  connect(h)
  mineFor(h, job, '00000002')

  assert.equal(h.blocks.length, 1, 'no block was found against the regtest target')
  assert.ok(h.shares.some((s) => s.isBlock), 'the block was not also recorded as a share')
  const block = h.blocks[0]
  assert.equal(block?.header.length, 80)
  assert.equal(block?.account, 'bc1qexampleaddress')
})

test('every outcome is reported to the counter callback with its code', () => {
  // The specific code, not merely "rejected". An operator reading the counter has to be able to see
  // stale work and a broken client as two different lines, which is micro-org#237 one layer out.
  const h = harness()
  const job = h.pushTemplate()
  connect(h)
  h.pushTemplate({ previousBlockHashHex: fakeHashHex('a-new-tip') })
  h.session.handle({ id: 40, method: 'mining.submit', params: ['w', job.id, '00000001', '00000000', '00000000'] })
  h.session.handle({ id: 41, method: 'mining.submit', params: ['w', 'nope', '00000001', '00000000', '00000000'] })
  assert.deepEqual(h.outcomes, [
    { outcome: 'rejected', code: STRATUM_ERROR.JOB_NOT_FOUND },
    { outcome: 'rejected', code: STRATUM_ERROR.OTHER },
  ])
})

/* ------------------------------------------------------------------ version rolling */

test('mining.configure intersects the requested mask rather than obeying it', () => {
  // A client asking for a wider mask would otherwise be granted the right to set version bits that
  // signal for soft forks, using blocks this pool paid for.
  const h = harness()
  h.session.handle({
    id: 1,
    method: 'mining.configure',
    params: [['version-rolling'], { 'version-rolling.mask': 'ffffffff' }],
  })
  const result = h.sent.find((m) => m.id === 1)?.result as Record<string, unknown>
  assert.equal(result['version-rolling'], true)
  assert.equal(result['version-rolling.mask'], VERSION_ROLLING_MASK.toString(16).padStart(8, '0'))
})

test('a narrower requested mask is honoured as requested', () => {
  const h = harness()
  h.session.handle({
    id: 1,
    method: 'mining.configure',
    params: [['version-rolling'], { 'version-rolling.mask': '00002000' }],
  })
  const result = h.sent.find((m) => m.id === 1)?.result as Record<string, unknown>
  assert.equal(result['version-rolling.mask'], '00002000')
})

test('an extension the pool does not implement is answered false, not true', () => {
  // An extension answered true that the pool does not implement is worse than one answered false,
  // because the miner then relies on it.
  const h = harness()
  h.session.handle({ id: 1, method: 'mining.configure', params: [['minimum-difficulty', 'subscribe-extranonce'], {}] })
  const result = h.sent.find((m) => m.id === 1)?.result as Record<string, unknown>
  assert.equal(result['minimum-difficulty'], false)
  assert.equal(result['subscribe-extranonce'], false)
})

/* ------------------------------------------------------------------ suggest_difficulty */

test('a suggested difficulty is clamped, not obeyed', () => {
  const h = harness({ minDifficulty: 16, maxDifficulty: 1024 })
  h.session.handle({ id: 1, method: 'mining.suggest_difficulty', params: [0.000001] })
  assert.equal(h.session.difficulty, 16)

  const h2 = harness({ minDifficulty: 16, maxDifficulty: 1024 })
  h2.session.handle({ id: 1, method: 'mining.suggest_difficulty', params: [999_999] })
  assert.equal(h2.session.difficulty, 1024)
})

test('a suggestion that is not a positive number is refused', () => {
  for (const value of [0, -1, 'lots', null]) {
    const h = harness()
    h.session.handle({ id: 1, method: 'mining.suggest_difficulty', params: [value] })
    const reply = h.sent.find((m) => m.id === 1)
    assert.equal(reply?.result, false, `${JSON.stringify(value)} was accepted`)
  }
})

test('an accepted suggestion is echoed back as a set_difficulty', () => {
  // The miner has to be told the number that was actually chosen, or it is mining at one difficulty
  // and reconciling against another.
  const h = harness({ minDifficulty: 1, maxDifficulty: 1_000_000 })
  h.session.handle({ id: 1, method: 'mining.suggest_difficulty', params: [512] })
  const set = h.sent.filter((m) => m.method === 'mining.set_difficulty')
  assert.equal(set.length, 1)
  assert.deepEqual(set[0]?.params, [512])
})

/* ------------------------------------------------------------------ job pushes */

test('a pushed job carries the nine positional notify parameters', () => {
  const h = harness()
  connect(h)
  const job = h.pushTemplate()
  h.session.pushJob(job, true)

  const notify = h.sent.filter((m) => m.method === 'mining.notify').at(-1)
  assert.ok(notify)
  const params = notify?.params as unknown[]
  assert.equal(params.length, 9)
  assert.equal(params[0], job.id)
  assert.equal(params[1], job.prevHashStratum)
  assert.equal(params[5], job.versionHex)
  assert.equal(params[6], job.bitsHex)
  assert.equal(params[8], true, 'clean_jobs')
  assert.ok(Array.isArray(params[4]), 'the merkle branch is a list')
})

test('a job push walks difficulty down for a connection that has submitted nothing', () => {
  // The vardiff idle path, through the session. This is the connection that is invisible to any
  // retarget rule driven by shares.
  const h = harness({ initialDifficulty: 1024, minDifficulty: 1, maxDifficulty: 4_294_967_296 })
  connect(h)
  assert.equal(h.session.difficulty, 1024)

  for (let i = 0; i < 3; i += 1) {
    h.advance(DEFAULT_VARDIFF.retargetMs)
    h.session.pushJob(h.pushTemplate(), false)
  }
  assert.ok(h.session.difficulty < 1024, 'a silent miner was never retargeted down')
  const set = h.sent.filter((m) => m.method === 'mining.set_difficulty')
  assert.ok(set.length > 1, 'the miner was never told about the change')
})

/* ------------------------------------------------------------------ the username */

test('parseWorkerName splits on the first dot only', () => {
  // Worker labels contain dots in the field; accounts do not.
  assert.deepEqual(parseWorkerName('acct.rig.1'), { account: 'acct', worker: 'rig.1' })
  assert.deepEqual(parseWorkerName('acct'), { account: 'acct', worker: '' })
  assert.deepEqual(parseWorkerName('bc1qexample.miner-02'), { account: 'bc1qexample', worker: 'miner-02' })
})

test('parseWorkerName refuses rather than sanitising', () => {
  // This is the only string in the whole protocol that a stranger chooses and the pool stores.
  // Sanitising would mine them under a name they did not choose and cannot find in their history.
  for (const bad of ['', '.rig', 'a b.rig', 'acct.rig worker', '<img>.x', 'a'.repeat(200), 'acct.' + 'w'.repeat(100)]) {
    assert.equal(parseWorkerName(bad), null, `${JSON.stringify(bad)} was accepted`)
  }
})

test('parseWorkerName accepts the address shapes miners actually use', () => {
  for (const good of [
    '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
    'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    'ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kgmn4n9',
    'LTC-worker_1',
  ]) {
    assert.notEqual(parseWorkerName(good), null, `${good} was refused`)
  }
})

/* -------------------------------------------------- the browser transport (micro-org#289) */

/**
 * A redeemer that answers one secret and records everything it was asked.
 *
 * Single-use is `tickets.ts`'s property and is tested there; what matters here is which FIELD this
 * session reads and what it does with the answer.
 */
function ticketing(secret: string, identity: { account: string; worker: string }) {
  const presented: string[] = []
  const spent = new Set<string>()
  const redeem = (value: string) => {
    presented.push(value)
    if (value !== secret || spent.has(value)) return null
    spent.add(value)
    return identity
  }
  return { presented, redeem }
}

test('on the browser transport the identity comes from the ticket, not from the username', () => {
  // The reversal micro-org#289 settled on. A browser has just proved who it is to
  // `POST /v1/pool/ticket`; taking its word for an account name afterwards would be strictly worse
  // information than the pool already holds, and would let a tab mine into somebody else's history.
  const tickets = ticketing('ticket-value', { account: 'cf-00112233445566aa', worker: 'web-abc123' })
  const h = harness({ redeemTicket: tickets.redeem })
  h.session.handle({ id: 1, method: 'mining.subscribe', params: ['cloudsforge-web/1'] })
  h.session.handle({ id: 2, method: 'mining.authorize', params: ['bc1qattacker.rig1', 'ticket-value'] })

  assert.equal(h.sent.find((m) => m.id === 2)?.result, true)
  assert.equal(h.session.account, 'cf-00112233445566aa')
  assert.equal(h.session.worker, 'web-abc123')
  // The username was not consulted at all — not parsed, not fallen back to, not blended in.
  assert.deepEqual(tickets.presented, ['ticket-value'])
})

test('a browser share is credited to the ticket account', () => {
  // The end of the chain the whole feature exists for: work done in a tab lands in `pool_shares`
  // under the label this service minted for that estate account. `payoutsImplemented` is false, so
  // this is a record of work and nothing else — but it is the record the account is entitled to.
  const tickets = ticketing('t', { account: 'cf-1122334455667788', worker: 'web-ffeedd' })
  const h = harness({ redeemTicket: tickets.redeem })
  const job = h.pushTemplate()
  h.session.handle({ id: 1, method: 'mining.subscribe', params: [] })
  h.session.handle({ id: 2, method: 'mining.authorize', params: ['ignored', 't'] })
  mineFor(h, job)

  assert.equal(h.shares.length, 1)
  assert.equal(h.shares[0]?.account, 'cf-1122334455667788')
  assert.equal(h.shares[0]?.worker, 'web-ffeedd')
})

test('every way of failing to present a ticket gets the same refusal', () => {
  // One answer for four causes, for the reason `tickets.ts` gives: telling them apart would let
  // anybody holding a candidate value learn whether it was ever real, and an honest client does the
  // same thing in all four cases, which is ask for another ticket.
  const messages = new Set<string>()
  for (const password of [undefined, '', '   ', 'never-was-a-ticket', 'ticket-value']) {
    const tickets = ticketing('ticket-value', { account: 'cf-a', worker: 'web-a' })
    // Spend it first, so the last case is a REPLAY of a real value rather than an unknown one.
    if (password === 'ticket-value') tickets.redeem('ticket-value')
    const h = harness({ redeemTicket: tickets.redeem })
    h.session.handle({ id: 1, method: 'mining.subscribe', params: [] })
    h.session.handle({ id: 2, method: 'mining.authorize', params: ['acct.rig', password] })

    const reply = h.sent.find((m) => m.id === 2)
    assert.equal(reply?.result, false, `${JSON.stringify(password)} was accepted`)
    const error = reply?.error as [number, string, unknown]
    assert.equal(error[0], STRATUM_ERROR.UNAUTHORIZED)
    assert.ok(!h.session.authorised)
    messages.add(error[1])
  }
  assert.equal(messages.size, 1, 'the refusals differ, which is an oracle')
})

test('the refusal says where to get a ticket and repeats nothing that was presented', () => {
  // A refusal is the log line anything on the internet can make this process write, so it must not
  // contain the value it was handed. It must still be actionable: a page that cannot tell "your
  // ticket expired" from "this pool is broken" retries the wrong thing.
  const tickets = ticketing('ticket-value', { account: 'cf-a', worker: 'web-a' })
  const h = harness({ redeemTicket: tickets.redeem })
  h.session.handle({ id: 1, method: 'mining.subscribe', params: [] })
  h.session.handle({ id: 2, method: 'mining.authorize', params: ['acct.rig', 'super-secret-ticket'] })

  const serialised = JSON.stringify(h.sent)
  assert.ok(!serialised.includes('super-secret-ticket'), 'the presented value was echoed back')
  assert.match((h.sent.find((m) => m.id === 2)?.error as [number, string, unknown])[1], /POST \/v1\/pool\/ticket/)
})

test('a ticket account still receives its difficulty before its first job', () => {
  // The ordering rule is a property of the session, not of the transport, and the browser path is a
  // second entry into it. A tab told a job before a difficulty assumes 1 and hashes for ever.
  const tickets = ticketing('t', { account: 'cf-a', worker: 'web-a' })
  const h = harness({ redeemTicket: tickets.redeem })
  h.pushTemplate()
  h.session.handle({ id: 1, method: 'mining.subscribe', params: [] })
  h.session.handle({ id: 2, method: 'mining.authorize', params: ['x', 't'] })

  const notifications = h.sent.filter((m) => m.method !== undefined).map((m) => m.method)
  assert.ok(notifications.indexOf('mining.set_difficulty') < notifications.indexOf('mining.notify'))
})

test('without a redeemer the username path is untouched, and no ticket can be presented', () => {
  // Raw TCP is unchanged by micro-org#289 and this is the assertion that says so. A pool with no
  // identity configured hands `session.ts` no redeemer, and every miner in the field keeps
  // authorising with a payout address and the password every one of them sends, which is `x`.
  const h = harness()
  h.session.handle({ id: 1, method: 'mining.subscribe', params: [] })
  h.session.handle({ id: 2, method: 'mining.authorize', params: ['bc1qexampleaddress.rig1', 'anything-at-all'] })
  assert.equal(h.sent.find((m) => m.id === 2)?.result, true)
  assert.equal(h.session.account, 'bc1qexampleaddress')
})

/* ------------------------------- the payout address, checked with the node (micro-org#286) */

/**
 * A `checkPayoutAddress` that answers from a table and records what it was asked.
 *
 * Deliberately a plain function and not an `AddressChecker`: the caching, the bounding and the
 * three-way verdict are `payoutaddress.test.ts`'s business, and what is under test here is only what
 * the session DOES with each of the three answers.
 */
function addressCheck(
  verdicts: Record<string, AddressVerdict>,
  fallback: AddressVerdict = 'invalid',
): { readonly asked: string[]; readonly check: (address: string) => Promise<AddressVerdict> } {
  const asked: string[] = []
  return {
    asked,
    check: (address: string): Promise<AddressVerdict> => {
      asked.push(address)
      return Promise.resolve(verdicts[address] ?? fallback)
    },
  }
}

test('THE ACCOUNT HALF OF THE USERNAME IS PUT TO THE NODE, AND THE WORKER HALF IS NOT', async () => {
  // A stratum username on raw TCP IS a payout address, and `parseWorkerName` only ever decided what
  // could be STORED. `.rig1` is a label the miner's owner typed; asking a node to validate it as an
  // address would refuse every miner with a worker name.
  const checker = addressCheck({ bc1qexampleaddress: 'valid' })
  const h = harness({ checkPayoutAddress: checker.check })
  h.session.handle({ id: 1, method: 'mining.subscribe', params: [] })
  h.session.handle({ id: 2, method: 'mining.authorize', params: ['bc1qexampleaddress.rig1', 'x'] })
  await Promise.resolve()

  assert.deepEqual(checker.asked, ['bc1qexampleaddress'])
  assert.equal(h.sent.find((m) => m.id === 2)?.result, true)
  assert.equal(h.session.account, 'bc1qexampleaddress')
  assert.equal(h.session.worker, 'rig1')
})

test('AN ADDRESS THE NODE DOES NOT RECOGNISE IS REFUSED, AND NOTHING IS CREDITED TO IT', async () => {
  // The defect micro-org#286 records. Before this, a miner who pasted a Bitcoin address into the
  // Litecoin pool, or fat-fingered one character of a bech32 string, mined for as long as they left
  // it running and every share was recorded against something that can never be paid.
  const checker = addressCheck({}, 'invalid')
  const h = harness({ checkPayoutAddress: checker.check })
  const job = h.pushTemplate()
  h.session.handle({ id: 1, method: 'mining.subscribe', params: [] })
  h.session.handle({ id: 2, method: 'mining.authorize', params: ['1BitcoinAddressOnALitecoinPool.rig', 'x'] })
  await Promise.resolve()

  const reply = h.sent.find((m) => m.id === 2)
  assert.equal(reply?.result, false)
  assert.equal((reply?.error as [number, string, unknown])[0], STRATUM_ERROR.UNAUTHORIZED)
  assert.ok(!h.session.authorised)

  // No job, and no credit. A refused connection that still received work would be a miner hashing
  // for nothing and never being told.
  h.session.pushJob(job, true)
  assert.equal(h.sent.filter((m) => m.method === 'mining.notify').length, 0)
  h.session.handle({ id: 3, method: 'mining.submit', params: ['w', job.id, '00000001', job.ntimeHex, '00000000'] })
  assert.equal(h.shares.length, 0)
})

test('the refusal says what the field is for, because that is what the miner has got wrong', async () => {
  const checker = addressCheck({}, 'invalid')
  const h = harness({ checkPayoutAddress: checker.check })
  h.session.handle({ id: 1, method: 'mining.subscribe', params: [] })
  h.session.handle({ id: 2, method: 'mining.authorize', params: ['nonsense.rig', 'x'] })
  await Promise.resolve()

  const message = (h.sent.find((m) => m.id === 2)?.error as [number, string, unknown])[1]
  // Names the chain, so somebody who pointed a Litecoin miner at the Bitcoin port can see it, and
  // says what the username is FOR, which is the second commonest cause of getting here.
  assert.match(message, /Bitcoin/)
  assert.match(message, /\.worker/)
})

test('A NODE THAT CANNOT BE ASKED LETS THE MINER THROUGH — FAILING OPEN, ON PURPOSE', async () => {
  // The deliberate choice, argued in `payoutaddress.ts`. The stratum listener stays up while the
  // node is away by design; refusing here would disconnect every rig that reconnects during an
  // operator's node problem, for a fault that is not the miner's, and each would then retry at once.
  // Letting them through costs a share row against an address that is re-checked on their next
  // connection and that cannot be paid before it is checked — re-measured 2026-08-10, the payout
  // path exists and is inert: `payoutsImplemented` is derived from `CUSTODY_BACKING_CLOSED` and the
  // payout configuration, and both terms are false on every deployment.
  const checker = addressCheck({ bc1qexampleaddress: 'unavailable' })
  const h = harness({ checkPayoutAddress: checker.check })
  h.pushTemplate()
  h.session.handle({ id: 1, method: 'mining.subscribe', params: [] })
  h.session.handle({ id: 2, method: 'mining.authorize', params: ['bc1qexampleaddress.rig1', 'x'] })
  await Promise.resolve()

  assert.equal(h.sent.find((m) => m.id === 2)?.result, true)
  assert.ok(h.session.authorised)
  assert.equal(h.session.account, 'bc1qexampleaddress')
  // And it is a whole authorisation, not a half one: difficulty then work, in that order.
  const methods = h.sent.filter((m) => m.method !== undefined).map((m) => m.method)
  assert.ok(methods.indexOf('mining.set_difficulty') < methods.indexOf('mining.notify'))
})

test('a username the pool would not store never reaches the node', async () => {
  // `parseWorkerName` still runs first and is unchanged, which is what micro-org#286 asks for. It is
  // also the cheaper guard: an unbounded string of control characters is refused here rather than
  // being posted to a node as an RPC parameter.
  const checker = addressCheck({}, 'valid')
  for (const username of ['', 'has space.rig', 'a'.repeat(200), 'bad<script>.rig']) {
    const h = harness({ checkPayoutAddress: checker.check })
    h.session.handle({ id: 1, method: 'mining.subscribe', params: [] })
    h.session.handle({ id: 2, method: 'mining.authorize', params: [username, 'x'] })
    await Promise.resolve()
    assert.equal(h.sent.find((m) => m.id === 2)?.result, false, `${JSON.stringify(username)} was accepted`)
  }
  assert.deepEqual(checker.asked, [], 'an unstorable username was posted to the node')
})

test('THE BROWSER TRANSPORT IS NEVER ASKED, BECAUSE ITS ACCOUNT IS NOT AN ADDRESS', async () => {
  // `cf-00112233445566aa` is a label this service minted for an estate account. It is not an address
  // and no node would call it one, so a check on this path would refuse every browser miner there
  // has ever been. The structural guarantee is that the ticket path never reads a username at all.
  const checker = addressCheck({}, 'invalid')
  const tickets = ticketing('ticket-value', { account: 'cf-00112233445566aa', worker: 'web-abc123' })
  const h = harness({ redeemTicket: tickets.redeem, checkPayoutAddress: checker.check })
  h.session.handle({ id: 1, method: 'mining.subscribe', params: [] })
  h.session.handle({ id: 2, method: 'mining.authorize', params: ['bc1qattacker.rig1', 'ticket-value'] })
  await Promise.resolve()

  assert.equal(h.sent.find((m) => m.id === 2)?.result, true)
  assert.equal(h.session.account, 'cf-00112233445566aa')
  assert.deepEqual(checker.asked, [])
})

test('a pool with no node check configured behaves exactly as it did before', async () => {
  // The absent case, which is every existing caller and every test above this section. Authorisation
  // stays synchronous and nothing is queued, so a miner that pipelines a submit behind its authorise
  // is answered in the same turn it always was.
  const h = harness()
  const job = h.pushTemplate()
  h.session.handle({ id: 1, method: 'mining.subscribe', params: [] })
  h.session.handle({ id: 2, method: 'mining.authorize', params: ['bc1qexampleaddress.rig1', 'x'] })
  assert.equal(h.sent.find((m) => m.id === 2)?.result, true, 'authorisation did not settle synchronously')
  assert.ok(h.sent.some((m) => m.method === 'mining.notify'))
  assert.ok(job)
})

test('A SUBMIT THAT ARRIVES WHILE THE NODE IS BEING ASKED IS QUEUED, NOT CALLED UNAUTHORIZED', async () => {
  // The one wrong answer available in this window: telling a miner that did authorise that it did
  // not. It is a real sequence — a client that pipelines its handshake sends subscribe, authorize
  // and its first submit without waiting — and before the queue it would have been rejected with 24.
  // Definite assignment: the executor runs synchronously when `checkPayoutAddress` is called, which
  // is inside the `mining.authorize` below, so this is set before the first assertion reads it.
  let settle!: (verdict: AddressVerdict) => void
  const h = harness({
    checkPayoutAddress: () =>
      new Promise<AddressVerdict>((resolve) => {
        settle = resolve
      }),
  })
  const job = h.pushTemplate()
  h.session.handle({ id: 1, method: 'mining.subscribe', params: [] })
  h.session.handle({ id: 2, method: 'mining.authorize', params: ['bc1qexampleaddress.rig1', 'x'] })
  h.session.handle({ id: 3, method: 'mining.submit', params: ['w', job.id, '00000001', job.ntimeHex, 'deadbeef'] })

  // Nothing has been said about the submit yet, and in particular nothing wrong has been said.
  assert.equal(h.sent.find((m) => m.id === 3), undefined)

  settle('valid')
  await Promise.resolve()
  await Promise.resolve()

  assert.equal(h.sent.find((m) => m.id === 2)?.result, true)
  const submitReply = h.sent.find((m) => m.id === 3)
  assert.ok(submitReply, 'the queued submit was never answered')
  // It is answered on its merits — this nonce does not meet the target — and NOT with 24.
  assert.notEqual((submitReply?.error as [number, string, unknown])[0], STRATUM_ERROR.UNAUTHORIZED)
  // And the ordering rule survives the queue: difficulty and work still precede the submit's reply.
  const sentMethods = h.sent.map((m) => m.method ?? `reply:${String(m.id)}`)
  assert.ok(sentMethods.indexOf('mining.notify') < sentMethods.indexOf('reply:3'))
})

test('the queue is bounded, because a client can fill it as fast as it likes', async () => {
  // An unbounded queue here is memory growth at whatever rate a peer can write, held for as long as
  // a node takes to answer. Past the limit the miner is told, with an id it can match, rather than
  // being left waiting or silently dropped.
  const h = harness({ checkPayoutAddress: () => new Promise<AddressVerdict>(() => {}) })
  h.session.handle({ id: 1, method: 'mining.subscribe', params: [] })
  h.session.handle({ id: 2, method: 'mining.authorize', params: ['bc1qexampleaddress.rig1', 'x'] })
  for (let i = 0; i < 100; i += 1) {
    h.session.handle({ id: 1000 + i, method: 'mining.suggest_difficulty', params: [1] })
  }
  const refusals = h.sent.filter((m) => (m.error as [number, string, unknown] | undefined)?.[0] === STRATUM_ERROR.OTHER)
  assert.equal(refusals.length, 100 - 32, 'the queue was not bounded at 32')
})
