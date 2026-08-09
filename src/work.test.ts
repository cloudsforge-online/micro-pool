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
import { JobRegistry, JOB_HISTORY, RETAINED_TURNOVERS } from './work.ts'
import { parseTemplate } from './template.ts'
import { fakeTemplateReply, fakeHashHex, FAKE_PAYOUT_SCRIPT } from './faketemplate.ts'

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
