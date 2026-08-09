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
import { fakeTemplateReply, FAKE_PAYOUT_SCRIPT, REGTEST_BITS } from './faketemplate.ts'
import { DEFAULT_VARDIFF } from './vardiff.ts'
import { STRATUM_ERROR } from './validate.ts'
import {
  parseWorkerName,
  Session,
  VERSION_ROLLING_MASK,
  type AcceptedShare,
  type FoundBlock,
  type OutgoingMessage,
  type SessionDeps,
} from './session.ts'

const EXTRANONCE1 = Buffer.from('a1b2c3d4', 'hex')
const START_MS = 1_760_000_500_000

interface Harness {
  readonly session: Session
  readonly sent: OutgoingMessage[]
  readonly shares: AcceptedShare[]
  readonly blocks: FoundBlock[]
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
    onOutcome: (outcome, code) => outcomes.push({ outcome, code }),
    ...overrides,
  })

  return {
    session,
    sent,
    shares,
    blocks,
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

test('a share against an unknown job is stale, not dishonest', () => {
  const h = harness()
  h.pushTemplate()
  connect(h)
  h.session.handle({
    id: 10,
    method: 'mining.submit',
    params: ['w', 'no-such-job', '00000001', '00000000', '00000000'],
  })
  const reply = h.sent.find((m) => m.id === 10)
  assert.equal((reply?.error as [number, string, unknown])[0], STRATUM_ERROR.JOB_NOT_FOUND)
  assert.match((reply?.error as [number, string, unknown])[1], /stale/)
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
  const h = harness()
  h.pushTemplate()
  connect(h)
  h.session.handle({ id: 40, method: 'mining.submit', params: ['w', 'nope', '00000001', '00000000', '00000000'] })
  assert.deepEqual(h.outcomes, [{ outcome: 'rejected', code: STRATUM_ERROR.JOB_NOT_FOUND }])
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
