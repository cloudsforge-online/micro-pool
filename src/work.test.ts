/**
 * The job registry: what it holds, what it lets go of, and what it still says about what it let go.
 *
 * `work.ts` had no test file of its own until micro-org#237 needed one. `buildJob` and
 * `notifyParams` were exercised through `session.test.ts` and `regtest.test.ts` — every accepted
 * share in this suite goes through both — but the REGISTRY, which is the part that decides what a
 * miner may still submit against, was only ever driven forwards. Nothing pushed a job out and then
 * asked about it, which is exactly the situation #237 is about.
 *
 * The distinction under test throughout is one distinction: a job this pool issued and has since
 * retired is STALE, and an id it never issued is UNKNOWN. They are opposite instructions to a
 * miner, and answering both the same way is the defect.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { JobRegistry, JOB_HISTORY, RETAINED_TURNOVERS, type Job } from './work.ts'
import { parseTemplate } from './template.ts'
import { fakeTemplateReply, fakeHashHex, FAKE_PAYOUT_SCRIPT } from './faketemplate.ts'
import { commitmentOffset, hasSingleCommitment, magicOccurrences, MERGED_MINING_MAGIC } from './auxpow.ts'
import { targetFromCompactBits } from './pow.ts'
import type { AuxBlock } from './auxtemplate.ts'

function registry(history?: number): JobRegistry {
  const reg = new JobRegistry({
    chain: 'btc',
    tag: Buffer.from('/cloudsforge/', 'utf8'),
    extranonce1Size: 4,
    extranonce2Size: 4,
    ...(history === undefined ? {} : { history }),
  })
  reg.setPayoutScript(FAKE_PAYOUT_SCRIPT)
  return reg
}

/**
 * One template on the tip named by `tip`, at `height`.
 *
 * The tip is the parameter that matters here: two pushes with the same tip are the
 * fee-improvement case and stack up in the history, two with different tips are the new-block case
 * and clear it. Everything about retirement follows from which of those happened.
 */
function push(reg: JobRegistry, tip: string, height = 800_000): string {
  return reg.push(parseTemplate(fakeTemplateReply({ previousBlockHashHex: fakeHashHex(tip), height }))).id
}

test('a job that is still in the history is not a question for recall at all', () => {
  const reg = registry()
  const id = push(reg, 'tip-a')
  assert.equal(reg.get(id)?.id, id)
  assert.equal(reg.remembered, 0, 'a live job was retired')
})

test('AN ID THIS POOL NEVER ISSUED IS NOT STALE, AND IS NOT TOLD TO FETCH FRESH WORK', () => {
  // The half of micro-org#237 that the cheap fix gets wrong. Answering every unknown id "stale" is
  // one line shorter and tells a client that fabricates ids, or that is pointed at the wrong pool,
  // that it is doing fine.
  const reg = registry()
  push(reg, 'tip-a')

  for (const fabricated of ['no-such-job', 'deadbeef', 'ffffffff', '', '2']) {
    const recall = reg.recall(fabricated)
    assert.equal(recall.stale, false, `${fabricated} was called stale`)
    assert.equal(recall.reason, 'unknown')
    assert.match(recall.message, /not issued by this pool/)
  }
})

test('A JOB RETIRED BY A NEW TIP IS STALE, AND SAYS THE TIP MOVED', () => {
  const reg = registry()
  const first = push(reg, 'tip-a')
  push(reg, 'tip-b')

  assert.equal(reg.get(first), null, 'the old job survived a new tip')
  const recall = reg.recall(first)
  assert.equal(recall.stale, true)
  assert.equal(recall.reason, 'superseded')
  assert.match(recall.message, /tip moved/)
})

test('A JOB THAT FELL PAST THE HISTORY IS STALE TOO, AND SAYS SO DIFFERENTLY', () => {
  // Eviction has nothing to do with the tip and nothing to do with age: a pool taking a template
  // every ten seconds retires perfectly live work this way. It must read to a miner exactly as
  // supersession does — same code, same "fetch fresh work" — or the fix covers only the easy half.
  const reg = registry()
  const ids = Array.from({ length: JOB_HISTORY + 1 }, () => push(reg, 'tip-a'))
  const oldest = ids[0] as string

  assert.equal(reg.get(oldest), null, 'the history is not bounded by JOB_HISTORY')
  const recall = reg.recall(oldest)
  assert.equal(recall.stale, true)
  assert.equal(recall.reason, 'evicted')
  assert.match(recall.message, new RegExp(`last ${JOB_HISTORY} jobs`))
})

test('the eviction message quotes the history this registry was actually built with', () => {
  // Interpolated rather than written out, so it cannot describe a pool that was retuned away from
  // the default and never had its strings updated.
  const reg = registry(2)
  const ids = Array.from({ length: 3 }, () => push(reg, 'tip-a'))
  assert.match(reg.recall(ids[0] as string).message, /last 2 jobs/)
  assert.doesNotMatch(reg.recall(ids[0] as string).message, /last 4 jobs/)
})

test('AN ID PAST THE END OF THE RING IS STILL STALE — IT LOSES ITS REASON, NOT ITS STANDING', () => {
  // hearth had to name this as a hole it could not close: its template ids are sixteen random
  // bytes, so once the ring forgets one it cannot tell it from a fabrication. This registry's ids
  // are a counter, so it can, and a miner that surfaces very late is still told the truth.
  const reg = registry()
  const first = push(reg, 'tip-a')
  for (let i = 0; i < JOB_HISTORY * RETAINED_TURNOVERS + 4; i += 1) push(reg, 'tip-a')

  const recall = reg.recall(first)
  assert.equal(recall.stale, true, 'a job this pool issued was called a fabrication')
  assert.equal(recall.reason, 'forgotten')
  assert.match(recall.message, /issued by this pool/)
})

test('the ring of remembered reasons is bounded', () => {
  // The key is not a stranger's to choose here — ids are the pool's own — but an unbounded map that
  // grows once per template is a leak with a clock on it, which is the same leak more slowly.
  const reg = registry()
  for (let i = 0; i < 500; i += 1) push(reg, 'tip-a')
  assert.equal(reg.remembered, JOB_HISTORY * RETAINED_TURNOVERS)
})

test('the ring evicts what was retired longest ago, not what was retired last', () => {
  // The entry retired most recently belongs to the miner likeliest to still be mid-attempt, so
  // dropping it first would forget precisely the one worth remembering.
  const reg = registry(1)
  const ids = Array.from({ length: RETAINED_TURNOVERS + 2 }, () => push(reg, 'tip-a'))
  const retired = ids.slice(0, -1)

  assert.equal(reg.remembered, RETAINED_TURNOVERS)
  assert.equal(reg.recall(retired[0] as string).reason, 'forgotten', 'the oldest kept its reason')
  assert.equal(reg.recall(retired[retired.length - 1] as string).reason, 'evicted', 'the newest lost its reason')
})

test('a new tip retires every job it clears, not merely the one it replaced', () => {
  const reg = registry()
  const ids = Array.from({ length: JOB_HISTORY }, () => push(reg, 'tip-a'))
  push(reg, 'tip-b')

  for (const id of ids) {
    const recall = reg.recall(id)
    assert.equal(recall.stale, true, `${id} was not retired`)
    assert.equal(recall.reason, 'superseded', `${id} was retired for the wrong reason`)
  }
})

test('AN ID IS ONLY THE POOL’S IF IT IS THE EXACT STRING THE POOL ISSUED', () => {
  // `parseInt` reads all of these as one, and a value comparison alone would hand a fabricated
  // string the standing of a job this pool actually handed out. It issued "1".
  const reg = registry()
  const first = push(reg, 'tip-a')
  assert.equal(first, '1', 'the id scheme changed; the counter argument in work.ts needs rereading')
  push(reg, 'tip-b')

  assert.equal(reg.recall('1').stale, true)
  for (const impostor of ['0x1', '01', ' 1', '1 ', '+1', '1.0']) {
    assert.equal(reg.recall(impostor).stale, false, `${JSON.stringify(impostor)} passed as an issued id`)
  }
})

test('an id above the counter is unknown even when it is well-formed hex', () => {
  // The other direction of the same check: ids climb, so anything past the counter has not been
  // handed out yet and saying "stale" about it would be a guess about the future.
  const reg = registry()
  push(reg, 'tip-a')
  push(reg, 'tip-b')
  assert.equal(reg.recall('1').stale, true, '1 was issued and has been retired')
  assert.equal(reg.recall('3').stale, false)
  assert.equal(reg.recall('3').reason, 'unknown')
})

/* --- the aux commitment, and the far more common case of not rebuilding for it --- */

/**
 * A Litecoin registry, because merged mining has a parent and Bitcoin is not it.
 *
 * The registry itself does not check the pairing — `env.ts` does, at configuration time, against
 * `AUX_PARENT` — so this could be driven with the `btc` helper above and would pass. It is not,
 * because a test that merges Dogecoin into Bitcoin is a test that documents a thing this pool
 * refuses to do.
 */
function ltcRegistry(history?: number): JobRegistry {
  const reg = new JobRegistry({
    chain: 'ltc',
    tag: Buffer.from('/cloudsforge/', 'utf8'),
    extranonce1Size: 4,
    extranonce2Size: 4,
    ...(history === undefined ? {} : { history }),
  })
  reg.setPayoutScript(FAKE_PAYOUT_SCRIPT)
  return reg
}

/**
 * An aux block, named by the DOGE tip it was built on and by its own hash.
 *
 * Those two are separate parameters on purpose: the whole of `setAux` turns on the difference
 * between them. dogecoind hands back a new HASH every time it reassembles its block, and clears its
 * map only when the TIP moves — so "same tip, new hash" is the case that must not rebuild, and it is
 * unreachable in a fixture that derives one from the other.
 */
function auxBlock(tip: string, hash: string): AuxBlock {
  return {
    chain: 'doge',
    hashHex: fakeHashHex(hash),
    height: 5_400_000,
    bitsHex: '1a01cf29',
    target: targetFromCompactBits(0x1a01cf29),
    previousBlockHashHex: fakeHashHex(tip),
    coinbaseValue: 1_000_000_000_000n,
    fetchedAt: new Date(0),
  }
}

/** Where the commitment for `block` sits in `job`'s coinb1, or -1. */
function committedOffset(job: Job, block: AuxBlock): number {
  return commitmentOffset(job.coinbase.coinb1, block.hashHex)
}

test('a job built with an aux block carries its hash in coinb1, exactly once', () => {
  const reg = ltcRegistry()
  const doge = auxBlock('doge-tip-a', 'doge-block-1')
  assert.equal(reg.setAux(doge), null, 'there was no job to rebuild yet')

  const job = reg.push(parseTemplate(fakeTemplateReply({ previousBlockHashHex: fakeHashHex('ltc-a') })))
  assert.equal(job.aux?.hashHex, doge.hashHex)
  assert.notEqual(committedOffset(job, doge), -1, 'the aux root is not where CAuxPow::check will look')
  assert.equal(hasSingleCommitment(job.coinbase.coinb1), true)
  // Ahead of the miner's bytes, which is the property that makes the offset a fact about the job
  // rather than a fact about whoever submits against it. See `coinbase.ts`.
  assert.equal(job.coinbase.coinb2.includes(MERGED_MINING_MAGIC), false)
})

test('with no aux block a job is an ordinary one, and that is not an error', () => {
  const reg = ltcRegistry()
  const job = reg.push(parseTemplate(fakeTemplateReply({ previousBlockHashHex: fakeHashHex('ltc-a') })))
  assert.equal(job.aux, null)
  assert.equal(magicOccurrences(job.coinbase.coinb1), 0)
})

test('A NEW AUX HASH ON THE SAME AUX TIP DOES NOT REBUILD ANYTHING', () => {
  // The churn case, and the reason `setAux` compares previous-block hashes rather than hashes.
  // dogecoind reassembles its block as its mempool turns over and returns a different hash each
  // time, but `mapNewBlock` is only cleared on a tip change — so the hash already in coinb1 is still
  // submittable and still wins the same block. Rebuilding here would issue a job every few seconds
  // and evict work miners are still grinding on, for nothing.
  const reg = ltcRegistry()
  const first = auxBlock('doge-tip-a', 'doge-block-1')
  reg.setAux(first)
  const job = reg.push(parseTemplate(fakeTemplateReply({ previousBlockHashHex: fakeHashHex('ltc-a') })))

  for (const label of ['doge-block-2', 'doge-block-3', 'doge-block-4']) {
    assert.equal(reg.setAux(auxBlock('doge-tip-a', label)), null, `${label} forced a rebuild`)
  }
  assert.equal(reg.current?.id, job.id, 'the current job changed')
  assert.equal(reg.current?.aux?.hashHex, first.hashHex, 'the commitment moved without a new job')
  assert.equal(reg.remembered, 0, 'a job was retired')
})

test('AN AUX TIP MOVING REBUILDS THE JOB, AND DOES NOT TELL MINERS TO DISCARD LITECOIN WORK', () => {
  const reg = ltcRegistry()
  const before = auxBlock('doge-tip-a', 'doge-block-1')
  reg.setAux(before)
  const old = reg.push(parseTemplate(fakeTemplateReply({ previousBlockHashHex: fakeHashHex('ltc-a') })))

  const after = auxBlock('doge-tip-b', 'doge-block-9')
  const rebuilt = reg.setAux(after)
  assert.notEqual(rebuilt, null, 'the committed hash is now "block hash unknown" and nothing was rebuilt')
  assert.equal(rebuilt?.cleanJobs, false, 'a Dogecoin tip change threw away in-flight Litecoin work')
  assert.equal(rebuilt?.aux?.hashHex, after.hashHex)
  assert.notEqual(committedOffset(rebuilt!, after), -1)

  // The Litecoin block has not changed, so the old job is still worth a Litecoin block and stays
  // submittable. Only the Dogecoin half of it is dead, and that half was a bonus.
  assert.equal(reg.get(old.id)?.id, old.id, 'an aux refresh retired live Litecoin work')
  assert.equal(reg.get(old.id)?.aux?.hashHex, before.hashHex, 'the old job forgot what it committed to')
})

test('a job that predates the aux block gains a commitment as soon as one exists', () => {
  // dogecoind spends its first hours in initial block download, during which every job is built
  // without a commitment. The moment it can answer, the next job commits — waiting for the Litecoin
  // tip to move would mine an uncommitted block for a full block interval for no reason.
  const reg = ltcRegistry()
  const uncommitted = reg.push(parseTemplate(fakeTemplateReply({ previousBlockHashHex: fakeHashHex('ltc-a') })))
  assert.equal(uncommitted.aux, null)

  const doge = auxBlock('doge-tip-a', 'doge-block-1')
  const rebuilt = reg.setAux(doge)
  assert.equal(rebuilt?.aux?.hashHex, doge.hashHex)
  assert.equal(rebuilt?.cleanJobs, false)
})

test('LOSING THE AUX BLOCK DOES NOT REBUILD, AND DOES NOT STRIP THE COMMITMENT', () => {
  // dogecoind restarting, losing its peers or falling back into initial block download makes the
  // source publish null. The 44 bytes already in coinb1 are inert, not harmful — they cannot make a
  // Litecoin block less valid — and the tip they name may well still be dogecoind's when it returns.
  // Spending a job to remove them would throw that away.
  const reg = ltcRegistry()
  const doge = auxBlock('doge-tip-a', 'doge-block-1')
  reg.setAux(doge)
  const job = reg.push(parseTemplate(fakeTemplateReply({ previousBlockHashHex: fakeHashHex('ltc-a') })))

  assert.equal(reg.setAux(null), null)
  assert.equal(reg.aux, null, 'the registry still thinks it can merge')
  assert.equal(reg.current?.id, job.id)
  assert.equal(reg.current?.aux?.hashHex, doge.hashHex, 'the live job lost a commitment that may still pay')

  // …and the NEXT job, built for a real Litecoin tip change, is the one that goes without.
  const next = reg.push(parseTemplate(fakeTemplateReply({ previousBlockHashHex: fakeHashHex('ltc-b') })))
  assert.equal(next.aux, null)
  assert.equal(next.cleanJobs, true)
})

test('a rebuilt job is a new id, and the one it displaced is answered as a live job', () => {
  // Two jobs for one Litecoin template is the shape merged mining introduces, and #237's whole
  // subject is what the registry says about an id afterwards. A rebuilt-past job was not retired,
  // so it is not stale — it is simply still there.
  const reg = ltcRegistry()
  reg.setAux(auxBlock('doge-tip-a', 'doge-block-1'))
  const first = reg.push(parseTemplate(fakeTemplateReply({ previousBlockHashHex: fakeHashHex('ltc-a') })))
  const second = reg.setAux(auxBlock('doge-tip-b', 'doge-block-2'))

  assert.notEqual(second?.id, first.id)
  assert.equal(reg.get(first.id)?.id, first.id, 'a rebuild retired the job it displaced')
  assert.equal(reg.remembered, 0, 'a rebuild retired something')
  // `recall` is deliberately not asked here. It is only ever consulted after `get` has returned
  // null — see its doc comment — and a live job is not a question.
})
