import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import postgres from 'postgres'
import { migrate, type Sql as DbSql } from '@cloudsforge/db'
import { MIGRATIONS, POOL_TABLES } from './migrations.ts'
import { COINBASE_MATURITY, inspectBlock, sweepMaturity, type MaturityStatus } from './maturity.ts'
import { NodeRpcError, NodeUnavailableError, type NodeRpc } from './rpc.ts'
import {
  blocksAwaitingMaturity,
  payableBlocks,
  recentBlocks,
  recordBlock,
  setBlockMaturity,
  type Exec,
} from './store.ts'
import { difficultyUnits } from './pplns.ts'
import { MATURITY_KIND, PRUNE_KIND, recurringFor } from './jobs.ts'

/**
 * The watcher, in two tiers, for the same reason `store.test.ts` is.
 *
 * The first tier is the verdict function against a fake node. Every interesting case here is a case
 * a real node produces rarely and on its own schedule — a reorg, a reindexed node that has forgotten
 * a hash, a node still catching up — and waiting for one to occur is not testing.
 *
 * The second tier is the sweep against a real Postgres, because the thing micro-org#302 is actually
 * about is a ROW changing state, and the assertion that matters is what the row says afterwards. The
 * headline test in this file is the one the issue asks for by name: record a block, re-organise it
 * away, and show that the row ends `orphaned` and that nothing is payable.
 *
 * `regtest.test.ts` runs the same `inspectBlock` against a real litecoind after a real
 * `invalidateblock`, which is the only way to know that the -1 this file fakes is the -1 Core sends.
 */

/* ------------------------------------------------------------------ the verdict, against a fake node */

type Answer = unknown | Error

/**
 * A node that answers `getblock` and `getblockhash` from a script, and records what it was asked.
 *
 * Shaped like `fakeRpc` in `payoutaddress.test.ts`. It asserts on the method name, because a
 * verdict reached without asking the node BOTH questions is the specific failure this file exists to
 * prevent — a block can report a positive confirmation count and still not be the block at its own
 * height, and a fake that silently accepted any method would let that check be deleted.
 */
function fakeRpc(script: {
  getblock?: (hash: string) => Answer
  getblockhash?: (height: number) => Answer
}): { readonly asked: string[]; readonly rpc: Pick<NodeRpc, 'call'> } {
  const asked: string[] = []
  return {
    asked,
    rpc: {
      call: async <T,>(method: string, params: readonly unknown[] = []): Promise<T> => {
        asked.push(method)
        if (method === 'getblock') {
          assert.equal(params[1], 1, 'verbosity 1: the header, not the serialised block or its transactions')
          const answer = script.getblock?.(String(params[0]))
          if (answer instanceof Error) throw answer
          return answer as T
        }
        if (method === 'getblockhash') {
          const answer = script.getblockhash?.(Number(params[0]))
          if (answer instanceof Error) throw answer
          return answer as T
        }
        throw new Error(`the maturity check asked the node an unexpected method: ${method}`)
      },
    },
  }
}

const HASH = '0000000000000000000000009f2b1a4c6d8e0f2a4b6c8d0e2f4a6b8c0d2e4f6a'
const HEIGHT = 2_912_004

test('COINBASE MATURITY IS EACH CHAIN\'S OWN CONSENSUS RULE, NOT THE DEPOSIT CONFIRMATION DEPTH', () => {
  // Pinned against being "tidied up" into `chainSpec().confirmations` later. Those are 12 for LTC and
  // 6 for BTC and they are the estate's DEPOSIT credit depths — a risk judgement about somebody
  // else's incoming payment. `COINBASE_MATURITY` is not a judgement: it is a consensus rule, and a
  // transaction spending a coinbase before it is rejected by every node on the network. Swapping one
  // for the other would make this pool declare a reward spendable roughly eight times too early.
  assert.equal(COINBASE_MATURITY.btc, 100)
  assert.equal(COINBASE_MATURITY.ltc, 100)
  // And pinned against the OTHER tidy-up, which is the likelier one now that there are three chains:
  // making them all 100 because two of them are. Dogecoin's is 240 from height 145000 — read from
  // `chainparams.cpp` at v1.14.9, and `maturity.ts` carries the provenance. A Dogecoin block
  // declared mature at 100 would be allocated and credited 140 blocks before its coinbase could be
  // spent, which is a payout the pool cannot fund.
  assert.equal(COINBASE_MATURITY.doge, 240)
  assert.notEqual(COINBASE_MATURITY.doge, COINBASE_MATURITY.ltc)
})

test('A MERGE-MINED BLOCK IS JUDGED ON ITS OWN CHAIN AND ITS OWN NUMBER', async () => {
  // The whole reason `chain` here is a `MinedChainId`. 100 confirmations matures a Litecoin block
  // and leaves a Dogecoin one pending, and the sweep for `doge` puts this `getblock` to dogecoind —
  // the node that answered the `submitauxblock` — because it is the only node in the estate that has
  // ever heard of the hash.
  const young = fakeRpc({
    getblock: () => ({ hash: HASH, confirmations: 100, height: HEIGHT }),
    getblockhash: () => HASH,
  })
  const pending = await inspectBlock(young.rpc, { chain: 'doge', hash: HASH, height: HEIGHT })
  assert.equal(pending.status, 'pending')
  assert.match(pending.detail ?? '', /100 of 240 confirmations/)

  const buried = fakeRpc({
    getblock: () => ({ hash: HASH, confirmations: 240, height: HEIGHT }),
    getblockhash: () => HASH,
  })
  const matured = await inspectBlock(buried.rpc, { chain: 'doge', hash: HASH, height: HEIGHT })
  assert.equal(matured.status, 'matured')
})

test('A BLOCK THE NODE REPORTS AS OFF THE ACTIVE CHAIN IS ORPHANED', async () => {
  // -1 is Core's own signal for a block it still holds in its index that is not on the active chain.
  // It is the cheapest possible detection and the primary one.
  const node = fakeRpc({ getblock: () => ({ hash: HASH, confirmations: -1, height: HEIGHT }) })
  const verdict = await inspectBlock(node.rpc, { chain: 'ltc', hash: HASH, height: HEIGHT })
  assert.equal(verdict.status, 'orphaned')
  assert.equal(verdict.confirmations, -1)
  assert.match(verdict.detail ?? '', /not on the active chain/)
  // And it stopped there: once the node has said the block lost, asking which block won is a second
  // round trip that cannot change the answer.
  assert.deepEqual(node.asked, ['getblock'])
})

test('A POSITIVE CONFIRMATION COUNT IS NOT ENOUGH; THE HEIGHT IS RE-ASKED', async () => {
  // The case the -1 check alone cannot see: a node answering that the block is buried 150 deep while
  // also answering that a different block occupies its height. That is a node contradicting itself,
  // and it is exactly the state to refuse to pay on rather than reason about — this pool would
  // otherwise be at its most confident here, since 150 confirmations reads as thoroughly settled.
  const winner = '00000000000000000000000fedcba9876543210fedcba9876543210fedcba98765'
  const node = fakeRpc({
    getblock: () => ({ hash: HASH, confirmations: 150, height: HEIGHT }),
    getblockhash: () => winner,
  })
  const verdict = await inspectBlock(node.rpc, { chain: 'ltc', hash: HASH, height: HEIGHT })
  assert.equal(verdict.status, 'orphaned')
  assert.match(verdict.detail ?? '', new RegExp(winner))
  assert.deepEqual(node.asked, ['getblock', 'getblockhash'])
})

test('THE HASH COMPARISON IS CASE-INSENSITIVE, BECAUSE A HASH IS NOT A STRING TO A CHAIN', async () => {
  // `poolPayoutCreditKey` lowercases for the same reason. A node that answered in upper case and a
  // row stored in lower case would otherwise be a permanent, silent orphaning of every block found.
  const node = fakeRpc({
    getblock: () => ({ confirmations: COINBASE_MATURITY.ltc, height: HEIGHT }),
    getblockhash: () => HASH.toUpperCase(),
  })
  const verdict = await inspectBlock(node.rpc, { chain: 'ltc', hash: HASH, height: HEIGHT })
  assert.equal(verdict.status, 'matured')
})

test('MATURITY IS EXACTLY 100 CONFIRMATIONS, WITH NO MARGIN IN EITHER DIRECTION', async () => {
  // A coinbase mined at H is first spendable in the block at H+100, which requires the tip to be at
  // H+99, which `getblock` reports as `confirmations = 100`. So 99 is pending and 100 is matured, and
  // both halves are asserted because an off-by-one here is invisible: 99 vs 100 confirmations is a
  // two-and-a-half minute difference on Litecoin and the only symptom is a spend the network refuses.
  const at = async (confirmations: number): Promise<MaturityStatus> => {
    const node = fakeRpc({
      getblock: () => ({ confirmations, height: HEIGHT }),
      getblockhash: () => HASH,
    })
    return (await inspectBlock(node.rpc, { chain: 'ltc', hash: HASH, height: HEIGHT })).status
  }
  assert.equal(await at(99), 'pending')
  assert.equal(await at(100), 'matured')
  assert.equal(await at(101), 'matured')
})

test('A YOUNG BLOCK IS PENDING AND SAYS HOW FAR IT HAS TO GO', async () => {
  const node = fakeRpc({
    getblock: () => ({ confirmations: 7, height: HEIGHT }),
    getblockhash: () => HASH,
  })
  const verdict = await inspectBlock(node.rpc, { chain: 'ltc', hash: HASH, height: HEIGHT })
  assert.equal(verdict.status, 'pending')
  assert.equal(verdict.confirmations, 7)
  assert.equal(verdict.detail, '7 of 100 confirmations')
})

test('A HASH THE NODE HAS NEVER HEARD OF IS PENDING, NOT ORPHANED', async () => {
  // The single most dangerous guess available here. An orphaned block STAYS in the node's block
  // index and reports -1; a node that returns -5 is a node that never had it — reindexed, restored
  // from a snapshot, or simply not the node that took the submission. Reading that as `orphaned`
  // would destroy a real credit on the strength of an operator swapping a node.
  const node = fakeRpc({
    getblock: () =>
      new NodeRpcError({ code: -5, message: 'Block not found', method: 'getblock', chain: 'ltc' }),
  })
  const verdict = await inspectBlock(node.rpc, { chain: 'ltc', hash: HASH, height: HEIGHT })
  assert.equal(verdict.status, 'pending')
  assert.equal(verdict.confirmations, null)
  assert.match(verdict.detail ?? '', /no record of this block hash/)
})

test('A NODE THAT HAS NOT REACHED THE HEIGHT YET IS PENDING', async () => {
  // `-8 Block height out of range` from a node still catching up after a restart. The active chain
  // does not reach this height, so the block is certainly not buried in it — but it is not excluded
  // from it either, and the honest answer is that the question cannot be answered yet.
  const node = fakeRpc({
    getblock: () => ({ confirmations: 120, height: HEIGHT }),
    getblockhash: () =>
      new NodeRpcError({ code: -8, message: 'Block height out of range', method: 'getblockhash', chain: 'ltc' }),
  })
  const verdict = await inspectBlock(node.rpc, { chain: 'ltc', hash: HASH, height: HEIGHT })
  assert.equal(verdict.status, 'pending')
  assert.match(verdict.detail ?? '', /no block at height/)
})

test('AN UNREACHABLE NODE IS NOT A VERDICT AT ALL, IT IS AN ERROR', async () => {
  // Deliberately not folded into `pending`. An outage and a four-hour-old block would then be the
  // same row state, and one of those is worth an alert while the other is the normal condition of
  // every block this pool finds.
  const node = fakeRpc({
    getblock: () => new NodeUnavailableError({ method: 'getblock', chain: 'ltc', cause: 'ECONNREFUSED' }),
  })
  await assert.rejects(
    () => inspectBlock(node.rpc, { chain: 'ltc', hash: HASH, height: HEIGHT }),
    NodeUnavailableError,
  )
})

test('THE SWEEP IS SCHEDULED PER CHAIN, AND RE-ARMS UNDER THE SAME KEY IT WAS ENQUEUED WITH', () => {
  // Rule 8: no `setInterval`, so this is a leased recurring job, and a recurring job is only
  // recurring if `rescheduleRecurring` can find it again by `(kind, key)` after it completes. The
  // pair is built twice from `recurringFor` in `jobs.ts` — once to seed and once to re-arm — and a
  // key that did not match would produce a sweep that ran exactly once per boot and then stopped,
  // which looks identical from the outside to a sweep with nothing to do.
  const recurring = recurringFor(['btc', 'ltc'])
  const maturity = recurring.filter((job) => job.kind === MATURITY_KIND)
  assert.deepEqual(
    maturity.map((job) => job.key),
    ['chain:btc', 'chain:ltc'],
  )
  // A merge-mined chain gets a sweep of its own and NOT a prune of its own. `pool_shares` has no
  // Dogecoin rows — the shares that won a Dogecoin block are Litecoin's — so a `pool.prune-shares`
  // keyed `chain:doge` would run hourly for ever, delete nothing, and read as a prune that has
  // quietly stopped working. The maturity sweep is the opposite case: the block is Dogecoin's, it is
  // orphaned by a Dogecoin reorg, and no Litecoin sweep could answer for it.
  const merged = recurringFor(['ltc'], [], ['doge'])
  assert.deepEqual(
    merged.map((job) => `${job.kind} ${job.key}`),
    [`${PRUNE_KIND} chain:ltc`, `${MATURITY_KIND} chain:ltc`, `${MATURITY_KIND} chain:doge`],
  )
  // The lease names the contended resource. Both chains' sweeps are independent work against
  // independent nodes, and one key for both would make the Bitcoin sweep wait behind the Litecoin one.
  assert.equal(new Set(recurring.map((job) => `${job.kind} ${job.key}`)).size, recurring.length)
  for (const job of maturity) assert.ok(job.everyMs > 0 && job.everyMs <= 15 * 60_000)
})

/* ------------------------------------------------------------------ the sweep, against a real database */

const url = process.env['POOL_TEST_DATABASE_URL']
const enabled = Boolean(url && /test/i.test(url))
const skip = enabled ? false : 'set POOL_TEST_DATABASE_URL (name must contain "test")'

let sql: postgres.Sql
const db = (): Exec => sql as unknown as Exec

async function record(args: {
  hash: string
  height: number
  submitStatus?: string
}): Promise<number> {
  return recordBlock(db(), {
    chain: 'ltc',
    shareChain: 'ltc',
    height: args.height,
    hash: args.hash,
    foundByWorkerId: null,
    networkDifficultyUnits: difficultyUnits(34_512_119.5),
    reward: 625_000_000n,
    submitStatus: args.submitStatus ?? 'accepted',
    submitDetail: null,
    windowFirstShareId: null,
    windowLastShareId: null,
  })
}

/** The whole maturity side of one row, read straight from the table rather than through a mapper. */
async function maturityRow(hash: string): Promise<Record<string, unknown> | undefined> {
  const rows = await sql`
    select maturity_status, confirmations, maturity_detail,
           maturity_checked_at is not null as checked,
           matured_at is not null as matured
    from pool_blocks where chain = 'ltc' and hash = ${hash}
  `
  return rows[0] as Record<string, unknown> | undefined
}

const sweepWith = async (rpc: Pick<NodeRpc, 'call'>) =>
  sweepMaturity({ sql: db(), rpc, chain: 'ltc', log: () => {} })

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

test('A RECORDED BLOCK STARTS PENDING, WHICH IS TO SAY NOT PAYABLE', { skip }, async () => {
  // Migration 4's default, and the direction that costs nothing to be wrong about. A block whose
  // fate has never been checked is a block whose reward this pool cannot demonstrate it has.
  await record({ hash: HASH, height: HEIGHT })
  assert.equal((await maturityRow(HASH))?.['maturity_status'], 'pending')
  assert.deepEqual(await payableBlocks(db(), { chain: 'ltc', limit: 10 }), [])
})

test('A BLOCK THE NODE REFUSED IS NEVER ASKED ABOUT AGAIN', { skip }, async () => {
  // Migration 4 back-fills it to `orphaned` and `blocksAwaitingMaturity` filters on
  // `submit_status = 'accepted'` besides. Both, because the back-fill only ran once against the rows
  // that existed then, and rejections keep happening.
  await record({ hash: HASH, height: HEIGHT, submitStatus: 'rejected' })
  const node = fakeRpc({
    getblock: () => {
      throw new Error('the sweep asked the node about a block the node had already refused')
    },
  })
  const sweep = await sweepWith(node.rpc)
  assert.equal(sweep.checked, 0)
  assert.deepEqual(node.asked, [])
  assert.deepEqual(await payableBlocks(db(), { chain: 'ltc', limit: 10 }), [])
})

test('A BLOCK RE-ORGANISED AWAY ENDS ORPHANED AND NOTHING IS PAYABLE', { skip }, async () => {
  /*
   * THE TEST micro-org#302 ASKS FOR BY NAME.
   *
   * The sequence is the one that actually happens on a chain: the node accepts the submission onto
   * its tip, the pool records `submit_status = 'accepted'`, the block starts accumulating
   * confirmations — and then, well inside the 100-block maturity window, a competing chain wins and
   * the block this pool found is no longer in it. Before this change the row would have kept saying
   * `accepted` for ever, and the only status a payout path had to read said the reward existed.
   *
   * The block is deliberately taken PART WAY to maturity first, so that the assertion is about a
   * block being taken back out of contention rather than about one that was never in it.
   */
  await record({ hash: HASH, height: HEIGHT })

  // Nine confirmations deep on the chain the node currently has.
  const growing = fakeRpc({
    getblock: () => ({ hash: HASH, confirmations: 9, height: HEIGHT }),
    getblockhash: () => HASH,
  })
  assert.deepEqual(await sweepWith(growing.rpc), { checked: 1, matured: 0, orphaned: 0, pending: 1 })
  assert.equal((await maturityRow(HASH))?.['confirmations'], 9)
  assert.deepEqual(await payableBlocks(db(), { chain: 'ltc', limit: 10 }), [])

  // The reorg. The node still holds the block — it is in its index — and now says it is not on the
  // active chain, and that its height belongs to somebody else's block.
  const winner = '000000000000000000000000abcdef0123456789abcdef0123456789abcdef012'
  const reorged = fakeRpc({
    getblock: () => ({ hash: HASH, confirmations: -1, height: HEIGHT }),
    getblockhash: () => winner,
  })
  assert.deepEqual(await sweepWith(reorged.rpc), { checked: 1, matured: 0, orphaned: 1, pending: 0 })

  const row = await maturityRow(HASH)
  assert.equal(row?.['maturity_status'], 'orphaned')
  assert.equal(row?.['confirmations'], -1)
  assert.match(String(row?.['maturity_detail']), /not on the active chain/)
  assert.equal(row?.['checked'], true)
  // Never matured, so never stamped. `matured_at` is the moment the reward became real, and a row
  // that carried one while saying `orphaned` would be a contradiction somebody eventually resolves
  // in favour of the timestamp.
  assert.equal(row?.['matured'], false)

  // The assertion the issue actually cares about, and the one a reader should check first.
  assert.deepEqual(await payableBlocks(db(), { chain: 'ltc', limit: 10 }), [])
  // And the submission verdict is untouched: `accepted` was true when it was recorded and remains
  // the only evidence separating "the coinbase was built wrongly" from "we lost a race".
  const [block] = await recentBlocks(db(), { chain: 'ltc', limit: 1 })
  assert.equal(block?.submitStatus, 'accepted')
  assert.equal(block?.maturityStatus, 'orphaned')
})

test('ORPHANED IS TERMINAL: A LATER SWEEP CANNOT WALK IT BACK TO MATURED', { skip }, async () => {
  // The chain can in principle reorg the reorg. This pool has no way to revoke a payout it has
  // already made, so the trade is deliberate and one-directional: the worst case is a block that was
  // worth something being treated as worthless, which costs the pool and never costs a miner money
  // they were already given.
  await record({ hash: HASH, height: HEIGHT })
  await sweepWith(fakeRpc({ getblock: () => ({ confirmations: -1, height: HEIGHT }) }).rpc)
  assert.equal((await maturityRow(HASH))?.['maturity_status'], 'orphaned')

  // The block "comes back", 200 deep, and the sweep does not even look at it: it is no longer a
  // candidate. Belt and braces, `setBlockMaturity` carries `maturity_status = 'pending'` in its own
  // predicate, so a direct call cannot do it either.
  const back = fakeRpc({
    getblock: () => ({ confirmations: 200, height: HEIGHT }),
    getblockhash: () => HASH,
  })
  assert.equal((await sweepWith(back.rpc)).checked, 0)
  await setBlockMaturity(db(), { chain: 'ltc', hash: HASH, status: 'matured', confirmations: 200, detail: null })
  assert.equal((await maturityRow(HASH))?.['maturity_status'], 'orphaned')
  assert.deepEqual(await payableBlocks(db(), { chain: 'ltc', limit: 10 }), [])
})

test('A MATURED BLOCK BECOMES PAYABLE AND STOPS BEING A CANDIDATE', { skip }, async () => {
  await record({ hash: HASH, height: HEIGHT })
  const node = fakeRpc({
    getblock: () => ({ confirmations: 100, height: HEIGHT }),
    getblockhash: () => HASH,
  })
  assert.deepEqual(await sweepWith(node.rpc), { checked: 1, matured: 1, orphaned: 0, pending: 0 })

  const row = await maturityRow(HASH)
  assert.equal(row?.['maturity_status'], 'matured')
  assert.equal(row?.['matured'], true)
  assert.deepEqual(await payableBlocks(db(), { chain: 'ltc', limit: 10 }), [{ hash: HASH, height: HEIGHT }])
  // Settled, so no longer worth an RPC round trip every ten minutes for the rest of the pool's life.
  assert.deepEqual(await blocksAwaitingMaturity(db(), { chain: 'ltc', limit: 10 }), [])
})

test('THE SWEEP IS SCOPED TO ONE CHAIN', { skip }, async () => {
  // Two independent accounting universes in one schema. A Litecoin sweep that read the Bitcoin rows
  // would ask a litecoind about a Bitcoin block hash, get -5, and — correctly, but for the wrong
  // reason — leave it pending for ever.
  await record({ hash: HASH, height: HEIGHT })
  await recordBlock(db(), {
    chain: 'btc',
    shareChain: 'btc',
    height: 900_000,
    hash: '00000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    foundByWorkerId: null,
    networkDifficultyUnits: difficultyUnits(1),
    reward: 312_500_000n,
    submitStatus: 'accepted',
    submitDetail: null,
    windowFirstShareId: null,
    windowLastShareId: null,
  })
  const candidates = await blocksAwaitingMaturity(db(), { chain: 'ltc', limit: 10 })
  assert.deepEqual(candidates, [{ hash: HASH, height: HEIGHT }])
})

test('AN UNAVAILABLE NODE STOPS THE SWEEP AND CHANGES NOTHING', { skip }, async () => {
  // Every remaining row would get the same answer, and a hundred ten-second timeouts is a job that
  // outlives its own lease. The rows are left exactly as they were, which is the safe direction:
  // `pending` is not payable, so an outage delays a payment rather than inventing or destroying one.
  await record({ hash: HASH, height: HEIGHT })
  await record({ hash: '00000000000000000000000cccccccccccccccccccccccccccccccccccccccccc', height: HEIGHT + 1 })
  const node = fakeRpc({
    getblock: () => new NodeUnavailableError({ method: 'getblock', chain: 'ltc', cause: 'ETIMEDOUT' }),
  })
  assert.deepEqual(await sweepWith(node.rpc), { checked: 0, matured: 0, orphaned: 0, pending: 0 })
  assert.deepEqual(node.asked, ['getblock'], 'the second block was asked about after the node was known to be down')
  const row = await maturityRow(HASH)
  assert.equal(row?.['maturity_status'], 'pending')
  assert.equal(row?.['checked'], false, 'a sweep that could not ask must not stamp the row as checked')
})

test('THE SWEEP COUNTS EVERY VERDICT IT REACHES, FOR THE METRIC', { skip }, async () => {
  // `pool_block_maturity_total`, labelled by status. An orphan rate is not something an operator can
  // discover from the block list — it needs one row per verdict over time.
  const young = '00000000000000000000000dddddddddddddddddddddddddddddddddddddddddd'
  await record({ hash: HASH, height: HEIGHT })
  await record({ hash: young, height: HEIGHT + 1 })
  const seen: MaturityStatus[] = []
  await sweepMaturity({
    sql: db(),
    rpc: fakeRpc({
      getblock: (hash) => ({ confirmations: hash === HASH ? -1 : 4, height: HEIGHT }),
      getblockhash: (height) => (height === HEIGHT ? HASH : young),
    }).rpc,
    chain: 'ltc',
    log: () => {},
    onVerdict: (status) => seen.push(status),
  })
  assert.deepEqual(seen.sort(), ['orphaned', 'pending'])
})

test('AN ORPHAN IS LOGGED AT ERROR, BECAUSE NOBODY GOES LOOKING FOR ONE', { skip }, async () => {
  // A block reward this pool recorded and does not have. It is the one event in this file that must
  // reach an operator without being asked for, and `warn` in an estate that runs a busy service is
  // a line nobody reads.
  await record({ hash: HASH, height: HEIGHT })
  const lines: Array<{ level: string; message: string }> = []
  await sweepMaturity({
    sql: db(),
    rpc: fakeRpc({ getblock: () => ({ confirmations: -1, height: HEIGHT }) }).rpc,
    chain: 'ltc',
    log: (level, message) => lines.push({ level, message }),
  })
  const orphan = lines.find((line) => line.message.includes('ORPHANED'))
  assert.ok(orphan, `no orphan line was logged: ${JSON.stringify(lines)}`)
  assert.equal(orphan?.level, 'error')
})
