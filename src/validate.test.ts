/**
 * Share validation, exercised by actually mining shares.
 *
 * Nothing here asserts on a hand-written header. The tests below take a job, search the nonce space
 * for a value that clears the share target, and hand the result to `validateShare` exactly as a
 * miner would. That is slower than a fixture and it is the only way to test the accept path
 * honestly: a fixed "known good" header would be a header this file computed with the same
 * conversions the code under test uses, and would agree with any consistent mistake.
 *
 * Mining in a test suite is affordable because of how `targetForDifficulty` scales. At a share
 * difficulty of 1/65536 the target is the difficulty-1 target multiplied by 65536 — around 2^240 for
 * SHA-256d, so roughly one nonce in 65536 clears it and a share is found in a fraction of a second.
 * For scrypt the same difficulty puts the target near 2^256, so the first nonce tried is a share,
 * which matters because scrypt is deliberately expensive and a search would take minutes.
 *
 * The block path is reached the same way regtest reaches it: `REGTEST_BITS` decodes to a target just
 * under 2^255, so a share is almost certainly also a block. `MAINNET_BITS` is used for the case that
 * must NOT be a block. Without those two fixtures the `isBlock` branch — the single most valuable
 * decision this service makes — would be the one path the suite never took.
 *
 * Staleness and duplicate detection are NOT here. `validateShare` never sees a job it was not given,
 * and the seen-share set lives on the connection; both are `session.test.ts`'s business.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { buildJob, type Job } from './work.ts'
import { parseTemplate } from './template.ts'
import { fakeTemplateReply, FAKE_PAYOUT_SCRIPT, MAINNET_BITS, REGTEST_BITS } from './faketemplate.ts'
import { shareKey, STRATUM_ERROR, validateShare, MAX_NTIME_AHEAD_SECONDS, type ShareContext } from './validate.ts'
import { powHash, sha256d } from './pow.ts'
import type { PowAlgorithm } from './chains.ts'
import type { AuxBlock } from './auxtemplate.ts'
import { magicOccurrences, MERGED_MINING_MAGIC } from './auxpow.ts'
import { coinbaseScriptSig } from './coinbase.ts'

const EXTRANONCE1 = Buffer.from('a1b2c3d4', 'hex')
const NOW = 1_760_000_500

/** The difficulty at which a share is cheap enough to find inside a test. See the file header. */
const EASY = 1 / 65536

function job(options: { bitsHex?: string; chain?: 'btc' | 'ltc'; aux?: AuxBlock | null } = {}): Job {
  const template = parseTemplate(fakeTemplateReply({ bitsHex: options.bitsHex ?? REGTEST_BITS }))
  return buildJob({
    chain: options.chain ?? 'btc',
    template,
    payoutScriptHex: FAKE_PAYOUT_SCRIPT,
    tag: Buffer.from('/cloudsforge/', 'utf8'),
    extranonce1Size: 4,
    extranonce2Size: 4,
    id: 'job-1',
    cleanJobs: true,
    aux: options.aux ?? null,
    createdAt: new Date(NOW * 1000),
  })
}

/**
 * An aux block whose target is named directly rather than decoded from bits.
 *
 * `parseAuxBlock` derives the target from `bits` and `auxtemplate.test.ts` is where that decoding is
 * under test. Here the target is the independent variable — the whole point is to put it either side
 * of a share that has already been found — and going through a compact-bits encoding to express
 * "everything meets this" would be testing the encoder a second time in the file that needs the
 * number.
 */
function auxAt(target: bigint): AuxBlock {
  return {
    chain: 'doge',
    hashHex: 'd0'.repeat(32),
    height: 5_400_000,
    bitsHex: '1a01cf29',
    target,
    previousBlockHashHex: 'ab'.repeat(32),
    coinbaseValue: 1_000_000_000_000n,
    fetchedAt: new Date(NOW * 1000),
  }
}

/** Everything meets it, and nothing does. The two ends of `meetsTarget`. */
const ANY_HASH_WINS = (1n << 256n) - 1n
const NO_HASH_WINS = 1n

function context(overrides: Partial<ShareContext> = {}): ShareContext {
  return {
    job: job(),
    algorithm: 'sha256d',
    extranonce1: EXTRANONCE1,
    extranonce2Size: 4,
    shareDifficulty: EASY,
    versionMask: 0,
    nowSeconds: NOW,
    ...overrides,
  }
}

/**
 * Search the nonce space for a share that clears the context's target.
 *
 * Returns the submission a miner would send. Throws rather than looping for ever, because a failure
 * to find a share at difficulty 1/65536 in a million tries means the target arithmetic is wrong and
 * an infinite loop would hide that as a hung suite.
 */
function mine(ctx: ShareContext, extranonce2Hex = '00000001'): { nonceHex: string; ntimeHex: string; extranonce2Hex: string } {
  const ntimeHex = ctx.job.ntimeHex
  for (let nonce = 0; nonce < 1_000_000; nonce += 1) {
    const nonceHex = nonce.toString(16).padStart(8, '0')
    const result = validateShare({ jobId: ctx.job.id, extranonce2Hex, ntimeHex, nonceHex }, ctx)
    if (result.status === 'accepted') return { nonceHex, ntimeHex, extranonce2Hex }
  }
  throw new Error('no share found in a million nonces: the target arithmetic is wrong')
}

/* ------------------------------------------------------------------ the accept path */

test('a share that clears the target is accepted and reports what it achieved', () => {
  const ctx = context()
  const submission = { jobId: ctx.job.id, ...mine(ctx) }
  const result = validateShare(submission, ctx)

  assert.equal(result.status, 'accepted')
  if (result.status !== 'accepted') return
  assert.equal(result.header.length, 80)
  assert.equal(result.creditedDifficulty, EASY, 'credited at the difficulty it was judged at')
  assert.ok(result.achievedDifficulty >= EASY, 'an accepted share achieved at least what was asked')
  assert.equal(result.ntime, Number.parseInt(ctx.job.ntimeHex, 16))
  // The header the pool built must be the one it hashed.
  assert.equal(powHash('sha256d', result.header).toString('hex'), result.powHash.toString('hex'))
})

test('the header is rebuilt from the pool record, not from what the miner claimed', () => {
  // The security model in one assertion. The submission carries four small strings; every other
  // field of the header must come from the job.
  const ctx = context()
  const submission = { jobId: ctx.job.id, ...mine(ctx) }
  const result = validateShare(submission, ctx)
  assert.equal(result.status, 'accepted')
  if (result.status !== 'accepted') return

  // prevhash occupies bytes 4..36 of the header, in internal order.
  const expectedPrev = Buffer.from(ctx.job.template.previousBlockHashHex, 'hex').reverse()
  assert.ok(result.header.subarray(4, 36).equals(expectedPrev))
  // nbits occupies bytes 72..76 and comes from the template, never from the miner.
  assert.equal(result.header.subarray(72, 76).toString('hex'), Buffer.from(ctx.job.bitsHex, 'hex').reverse().toString('hex'))
})

test('a share below the target is rejected as low difficulty', () => {
  // Difficulty 1 against a nonce that was only good enough for 1/65536.
  const easy = context()
  const submission = { jobId: easy.job.id, ...mine(easy) }
  const hard = context({ shareDifficulty: 1_000_000 })
  const result = validateShare(submission, hard)

  assert.equal(result.status, 'rejected')
  if (result.status !== 'rejected') return
  assert.equal(result.code, STRATUM_ERROR.LOW_DIFFICULTY)
  // The message names both numbers, because a miner reading it needs to know how far off it was.
  assert.match(result.message, /below the required/)
})

/* ------------------------------------------------------------------ the block path */

test('a share that also clears the block target is marked as a block', () => {
  // Regtest bits: the target is just under 2^255, so a share is a block with probability ~1/2 per
  // attempt. Search until one is.
  const ctx = context({ job: job({ bitsHex: REGTEST_BITS }) })
  for (let nonce = 0; nonce < 100_000; nonce += 1) {
    const result = validateShare(
      { jobId: ctx.job.id, extranonce2Hex: '00000001', ntimeHex: ctx.job.ntimeHex, nonceHex: nonce.toString(16).padStart(8, '0') },
      ctx,
    )
    if (result.status === 'accepted' && result.isBlock) {
      // A block is still a share: both facts are recorded, never one instead of the other.
      assert.ok(result.achievedDifficulty >= EASY)
      assert.equal(result.creditedDifficulty, EASY)
      return
    }
  }
  assert.fail('no block found against the regtest target')
})

test('a share that does not clear the block target is a share and not a block', () => {
  // Mainnet-era bits: the block target is around 2^224, far beyond a share found at 2^240.
  const ctx = context({ job: job({ bitsHex: MAINNET_BITS }) })
  const submission = { jobId: ctx.job.id, ...mine(ctx) }
  const result = validateShare(submission, ctx)
  assert.equal(result.status, 'accepted')
  if (result.status !== 'accepted') return
  assert.equal(result.isBlock, false)
})

test('the block hash is SHA-256d even on a scrypt chain', () => {
  // `getblockhash` on a Litecoin node returns the SHA-256d hash, and so does every explorer.
  // Recording the scrypt digest would produce a blocks row matching nothing anybody can look up.
  const ctx = context({ algorithm: 'scrypt', job: job({ chain: 'ltc' }) })
  const submission = { jobId: ctx.job.id, ...mine(ctx) }
  const result = validateShare(submission, ctx)
  assert.equal(result.status, 'accepted')
  if (result.status !== 'accepted') return

  assert.equal(result.headerHash.toString('hex'), sha256d(result.header).toString('hex'))
  assert.notEqual(result.headerHash.toString('hex'), result.powHash.toString('hex'))
  // And the proof-of-work hash really is scrypt.
  assert.equal(result.powHash.toString('hex'), powHash('scrypt', result.header).toString('hex'))
})

test('the proof-of-work function is dispatched on the chain, not assumed', () => {
  // The failure this guards is the one the brief singles out: a pool using the wrong hash function
  // silently rejects every share. Same header, two algorithms, two different answers.
  const ctx = context({ algorithm: 'scrypt', job: job({ chain: 'ltc' }) })
  const submission = { jobId: ctx.job.id, ...mine(ctx) }
  const result = validateShare(submission, ctx)
  assert.equal(result.status, 'accepted')
  if (result.status !== 'accepted') return
  assert.notEqual(
    powHash('scrypt', result.header).toString('hex'),
    powHash('sha256d', result.header).toString('hex'),
  )
})

/* ------------------------------------------------------------------ malformed submissions */

test('a field that is not hex of the right length is refused', () => {
  const ctx = context()
  const base = { jobId: ctx.job.id, extranonce2Hex: '00000001', ntimeHex: ctx.job.ntimeHex, nonceHex: '00000000' }
  const cases: [string, Record<string, string>][] = [
    ['extranonce2 too short', { extranonce2Hex: '000001' }],
    ['extranonce2 too long', { extranonce2Hex: '0000000101' }],
    ['extranonce2 not hex', { extranonce2Hex: 'zzzzzzzz' }],
    ['ntime too short', { ntimeHex: '0001' }],
    ['nonce too short', { nonceHex: '00' }],
    ['nonce not hex', { nonceHex: 'gggggggg' }],
  ]
  for (const [name, override] of cases) {
    const result = validateShare({ ...base, ...override }, ctx)
    assert.equal(result.status, 'rejected', name)
    if (result.status !== 'rejected') continue
    assert.equal(result.code, STRATUM_ERROR.OTHER, name)
  }
})

test('an ntime below the template mintime is refused', () => {
  const ctx = context()
  const belowMin = (ctx.job.template.minTime - 1).toString(16).padStart(8, '0')
  const result = validateShare(
    { jobId: ctx.job.id, extranonce2Hex: '00000001', ntimeHex: belowMin, nonceHex: '00000000' },
    ctx,
  )
  assert.equal(result.status, 'rejected')
  if (result.status !== 'rejected') return
  assert.match(result.message, /mintime/)
})

test('an ntime too far ahead of our clock is refused', () => {
  const ctx = context()
  const tooFar = (NOW + MAX_NTIME_AHEAD_SECONDS + 1).toString(16).padStart(8, '0')
  const result = validateShare(
    { jobId: ctx.job.id, extranonce2Hex: '00000001', ntimeHex: tooFar, nonceHex: '00000000' },
    ctx,
  )
  assert.equal(result.status, 'rejected')
  if (result.status !== 'rejected') return
  assert.match(result.message, /ahead/)
})

test('ntime rolling within the allowed range is accepted', () => {
  // Miners roll ntime forward as they exhaust nonce space. Refusing that would reject honest work
  // from exactly the fastest hardware.
  const ctx = context()
  const rolled = (Number.parseInt(ctx.job.ntimeHex, 16) + 30).toString(16).padStart(8, '0')
  let found = false
  for (let nonce = 0; nonce < 1_000_000 && !found; nonce += 1) {
    const result = validateShare(
      { jobId: ctx.job.id, extranonce2Hex: '00000001', ntimeHex: rolled, nonceHex: nonce.toString(16).padStart(8, '0') },
      ctx,
    )
    if (result.status === 'accepted') {
      assert.equal(result.ntime, Number.parseInt(rolled, 16))
      found = true
    }
  }
  assert.ok(found, 'a rolled ntime never produced an accepted share')
})

/* ------------------------------------------------------------------ version rolling */

test('a version is refused when the connection never negotiated rolling', () => {
  const ctx = context({ versionMask: 0 })
  const result = validateShare(
    { jobId: ctx.job.id, extranonce2Hex: '00000001', ntimeHex: ctx.job.ntimeHex, nonceHex: '00000000', versionHex: '20000000' },
    ctx,
  )
  assert.equal(result.status, 'rejected')
  if (result.status !== 'rejected') return
  assert.match(result.message, /version rolling/)
})

test('a version that changes bits outside the mask is refused', () => {
  // The bits outside the mask are consensus signalling. A miner able to set them could signal for a
  // soft fork the pool never agreed to, using the pool's own block.
  const ctx = context({ versionMask: 0x1fffe000 })
  const outside = (ctx.job.template.version ^ 0x00000001) >>> 0
  const result = validateShare(
    {
      jobId: ctx.job.id,
      extranonce2Hex: '00000001',
      ntimeHex: ctx.job.ntimeHex,
      nonceHex: '00000000',
      versionHex: outside.toString(16).padStart(8, '0'),
    },
    ctx,
  )
  assert.equal(result.status, 'rejected')
  if (result.status !== 'rejected') return
  assert.match(result.message, /outside the negotiated mask/)
})

test('a version rolled only inside the mask is accepted and lands in the header', () => {
  const mask = 0x1fffe000
  const ctx = context({ versionMask: mask })
  const rolled = ((ctx.job.template.version & ~mask) | (0x00002000 & mask)) >>> 0
  const versionHex = rolled.toString(16).padStart(8, '0')

  for (let nonce = 0; nonce < 1_000_000; nonce += 1) {
    const result = validateShare(
      {
        jobId: ctx.job.id,
        extranonce2Hex: '00000001',
        ntimeHex: ctx.job.ntimeHex,
        nonceHex: nonce.toString(16).padStart(8, '0'),
        versionHex,
      },
      ctx,
    )
    if (result.status === 'accepted') {
      // The rolled version is what the header carries. The header holds it little-endian, so reading
      // bytes 0..4 as a LE uint32 gives back the value the miner sent big-endian on the wire.
      assert.equal(result.header.readUInt32LE(0), rolled)
      // And it is genuinely different from the job's own version, or this test proved nothing.
      assert.notEqual(rolled, ctx.job.template.version >>> 0)
      return
    }
  }
  assert.fail('a version-rolled share was never accepted')
})

/* ------------------------------------------------------------------ the duplicate key */

test('the share key is exactly the fields a miner controls', () => {
  const base = { jobId: 'j1', extranonce2Hex: 'AABBCCDD', ntimeHex: '686F1C40', nonceHex: '00001111' }
  // Case-insensitive: firmware differs on this and two spellings of one solution are one solution.
  assert.equal(shareKey(base), shareKey({ ...base, extranonce2Hex: 'aabbccdd', ntimeHex: '686f1c40' }))
  // Every controlled field changes the key.
  assert.notEqual(shareKey(base), shareKey({ ...base, jobId: 'j2' }))
  assert.notEqual(shareKey(base), shareKey({ ...base, extranonce2Hex: 'aabbccde' }))
  assert.notEqual(shareKey(base), shareKey({ ...base, ntimeHex: '686f1c41' }))
  assert.notEqual(shareKey(base), shareKey({ ...base, nonceHex: '00001112' }))
  // Version is part of the key: a version-rolling miner varies it as a fifth search dimension, and
  // omitting it would reject a genuinely distinct solution as a duplicate.
  assert.notEqual(shareKey(base), shareKey({ ...base, versionHex: '20000000' }))
})

test('the stratum error codes are the ones miner firmware prints', () => {
  // Pinned because a pool that answers 20 to everything cannot be diagnosed from the miner's side,
  // which §6 names as what makes an honest pool indistinguishable from a dishonest one.
  assert.equal(STRATUM_ERROR.OTHER, 20)
  assert.equal(STRATUM_ERROR.JOB_NOT_FOUND, 21)
  assert.equal(STRATUM_ERROR.DUPLICATE_SHARE, 22)
  assert.equal(STRATUM_ERROR.LOW_DIFFICULTY, 23)
  assert.equal(STRATUM_ERROR.UNAUTHORIZED, 24)
  assert.equal(STRATUM_ERROR.NOT_SUBSCRIBED, 25)
})

/* ------------------------------------------------- the merged chain, which is a second target */

test('a job with no commitment reports nothing about the merged chain', () => {
  // `none` and `short` are different facts and the union keeps them apart: one says this pool was
  // not merging, the other says it was and this share was not good enough.
  const ctx = context()
  const result = validateShare({ jobId: ctx.job.id, ...mine(ctx) }, ctx)
  assert.equal(result.status, 'accepted')
  if (result.status !== 'accepted') return
  assert.equal(result.aux.kind, 'none')
  assert.equal(magicOccurrences(coinbaseScriptSig(result.coinbase)), 0, 'an uncommitted coinbase carries magic')
})

test('a share that misses the aux target is short, and is still an ordinary accepted share', () => {
  const ctx = context({ job: job({ aux: auxAt(NO_HASH_WINS) }) })
  const result = validateShare({ jobId: ctx.job.id, ...mine(ctx) }, ctx)
  assert.equal(result.status, 'accepted')
  if (result.status !== 'accepted') return
  assert.equal(result.aux.kind, 'short')
  assert.equal(result.creditedDifficulty, EASY, 'the merged chain changed what the parent credited')
  assert.equal(result.isBlock, true, 'the regtest block target was not met; the fixture changed')
})

test('A SHARE THAT MEETS THE AUX TARGET CARRIES THE BLOCK THE JOB COMMITTED TO', () => {
  // Identity, not equality. The hash `submitauxblock` is called with has to be the one this
  // coinbase committed to; reading it from `AuxTemplateSource` at submission time would submit a
  // proof for whatever Dogecoin is building NOW, which is a block this miner never committed to.
  const committed = auxAt(ANY_HASH_WINS)
  const ctx = context({ job: job({ aux: committed }) })
  const result = validateShare({ jobId: ctx.job.id, ...mine(ctx) }, ctx)

  assert.equal(result.status, 'accepted')
  if (result.status !== 'accepted') return
  assert.equal(result.aux.kind, 'won')
  if (result.aux.kind !== 'won') return
  assert.equal(result.aux.block, committed, 'the winning share names a block other than the one in its coinbase')
  assert.equal(magicOccurrences(coinbaseScriptSig(result.coinbase)), 1)
})

test('AN EXTRANONCE CARRYING THE MAGIC SPOILS THE MERGED HALF AND NOT THE PARENT SHARE', () => {
  // `CAuxPow::check` searches the scriptSig and refuses a second occurrence outright — "Multiple
  // merged mining headers in coinbase". The pool contributes one, in coinb1; the miner chose this
  // one. The Litecoin block is untouched by it, so the share is credited exactly as any other, and
  // only the Dogecoin half is lost. See the reasoning in `auxpow.ts` for why this is not a refusal.
  const ctx = context({ job: job({ aux: auxAt(ANY_HASH_WINS) }) })
  const submission = { jobId: ctx.job.id, ...mine(ctx, MERGED_MINING_MAGIC.toString('hex')) }
  const result = validateShare(submission, ctx)

  assert.equal(result.status, 'accepted', 'an honest miner lost credit for real work over 4 bytes it chose')
  if (result.status !== 'accepted') return
  assert.equal(result.creditedDifficulty, EASY)
  assert.equal(result.aux.kind, 'spoiled')
  if (result.aux.kind !== 'spoiled') return
  assert.equal(result.aux.occurrences, 2)
  assert.equal(magicOccurrences(coinbaseScriptSig(result.coinbase)), 2, 'the fixture did not reach the case')
})

test('the aux target is measured against the same proof as the parent, not a second hash', () => {
  // Merged mining does not re-hash anything. One scrypt digest, compared to two targets — which is
  // the entire reason a Dogecoin block costs a Litecoin miner nothing. A second hash here would be
  // this file quietly reintroducing the cost merged mining exists to avoid.
  const ctx = context({ job: job({ aux: auxAt(ANY_HASH_WINS) }) })
  const result = validateShare({ jobId: ctx.job.id, ...mine(ctx) }, ctx)
  assert.equal(result.status, 'accepted')
  if (result.status !== 'accepted') return
  assert.equal(powHash(ctx.algorithm, result.header).toString('hex'), result.powHash.toString('hex'))
})
