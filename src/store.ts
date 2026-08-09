/**
 * Every statement this service issues.
 *
 * Two rules hold across the file:
 *
 *   1. **Every statement against a chain-scoped table filters on `chain`.** A pool serving two
 *      chains has two independent accounting universes, and a query that spans them would divide a
 *      Bitcoin block's reward among Litecoin miners. `store.test.ts` greps this file for a statement
 *      that names one of `POOL_CHAIN_TABLES` without naming the column.
 *
 *      There is exactly one table that is not in that list, and it is `pool_account_links` — the
 *      map from an estate user to their pool account label, added by micro-org#289. A person is not
 *      per chain: one user has one label and mines whatever they point a tab at. The exception is
 *      declared in `migrations.ts` and honoured by the sweep, rather than being an argument that
 *      has to be had again at every call site.
 *
 *   2. **Nothing here decides anything.** These functions record what happened and answer questions
 *      about what was recorded. The share validation lives in `validate.ts`, the allocation lives in
 *      `pplns.ts`, and neither of them touches a database. Keeping the judgement out of the SQL is
 *      what makes the judgement testable without one.
 *
 * Difficulty weights cross this boundary as `bigint` and live in `bigint` columns — see
 * `migrations.ts` for why they are integers. postgres.js returns `bigint` columns and `numeric`
 * aggregates as strings, so every read goes through `BigInt(...)` and no weight is ever a `number`
 * on the way out of the database.
 *
 * They go the other way as **decimal strings**, through `param()` below, for a reason that is worth
 * stating because it looks like a wart. postgres.js will not bind a JavaScript `bigint` to a
 * parameter unless the connection is configured with a custom type for it, and configuring one here
 * would put a driver-level setting between this file and correctness — the sort of thing that is
 * right until somebody opens a second pool without it. A decimal string is bound as text and cast by
 * Postgres into the `bigint` column, which is exact for every value a `bigint` can hold, needs no
 * driver configuration, and fails loudly rather than silently if the column type ever changes.
 */

import type { Sql } from 'postgres'
import type { PoolChainId } from './chains.ts'

/** The pool, or a transaction inside it. */
export type Exec = Sql

/** A `bigint` as a bound parameter. See the note in the file header on why this is not a `bigint`. */
function param(value: bigint | null): string | null {
  return value === null ? null : value.toString()
}

export interface WorkerIdentity {
  readonly chain: PoolChainId
  readonly account: string
  readonly worker: string
}

/**
 * Find or create a worker, and mark it seen.
 *
 * `on conflict … do update` rather than a select-then-insert: two connections from the same rig
 * authorising in the same millisecond is the ordinary case, not a race to be surprised by, and the
 * unique constraint is what settles it. The update is what keeps `last_seen_at` meaningful, which is
 * how a page distinguishes a worker that is mining now from one that mined last March.
 */
export async function upsertWorker(
  exec: Exec,
  identity: WorkerIdentity,
  difficultyUnits: bigint | null = null,
): Promise<number> {
  const rows = await exec<{ id: string }[]>`
    insert into pool_workers (chain, account, worker, last_difficulty)
    values (${identity.chain}, ${identity.account}, ${identity.worker}, ${param(difficultyUnits)})
    on conflict (chain, account, worker) do update
      set last_seen_at = now(),
          last_difficulty = coalesce(excluded.last_difficulty, pool_workers.last_difficulty)
    returning id
  `
  const row = rows[0]
  if (!row) throw new Error(`upsertWorker returned no row for ${identity.chain}/${identity.account}`)
  return Number(row.id)
}

/**
 * The pool account label for an estate user, if this service has ever minted one.
 *
 * An `update … returning` rather than a `select`, so the read and the "this account is in use"
 * timestamp are one statement and one round trip. `last_used_at` is what tells an operator the
 * difference between an account somebody mined from last week and one minted by a page that was
 * opened once, which is the only question this table exists to answer beyond the label itself.
 *
 * Not chain-scoped, and the only statement in this file that is not. Migration 3 says why: a person
 * is not per chain, and `store.test.ts` drives its scoping sweep from `POOL_CHAIN_TABLES` so that
 * this exception is declared once rather than argued about at every call site.
 */
export async function findAccountLink(exec: Exec, userId: string): Promise<string | null> {
  const rows = await exec<{ account: string }[]>`
    update pool_account_links
       set last_used_at = now()
     where user_id = ${userId}
    returning account
  `
  return rows[0]?.account ?? null
}

/**
 * Claim a pool account label for a user, or lose the race and return null.
 *
 * `on conflict do nothing` on the primary key means a caller that loses gets no row back, which is
 * the signal `tickets.ts` reads to go and fetch the winner's label. A `do update` would have been
 * shorter and would have been wrong: it would overwrite one of two concurrently-minted labels, and a
 * user whose account label changed between two ticket requests would have their share history split
 * across two accounts with nothing joining them.
 */
export async function insertAccountLink(
  exec: Exec,
  link: { userId: string; account: string },
): Promise<string | null> {
  const rows = await exec<{ account: string }[]>`
    insert into pool_account_links (user_id, account)
    values (${link.userId}, ${link.account})
    on conflict (user_id) do nothing
    returning account
  `
  return rows[0]?.account ?? null
}

export interface ShareInput {
  readonly chain: PoolChainId
  readonly workerId: number
  readonly jobId: string
  readonly height: number
  readonly difficultyUnits: bigint
  readonly achievedUnits: bigint
  readonly isBlock: boolean
}

/**
 * Record accepted shares.
 *
 * Takes an array because a busy pool accepts shares far faster than it can afford a round trip
 * each — `stratum.ts` buffers them and flushes on a short timer, so the hot path of a submission is
 * a hash and a reply, never a database write. What that buffering costs is a small tail of shares
 * lost if the process is killed uncleanly, and that trade is made deliberately and stated in the
 * README rather than hidden: the alternative is a pool whose share acknowledgement latency is the
 * database's write latency, which is the thing miners notice first.
 *
 * Rejected shares are NOT stored. They are counted in metrics and returned to the miner with a
 * reason, and storing every low-difficulty submission would be storing several orders of magnitude
 * more rows than the accounting has any use for.
 */
export async function insertShares(exec: Exec, shares: readonly ShareInput[]): Promise<void> {
  if (shares.length === 0) return
  const rows = shares.map((share) => ({
    chain: share.chain,
    worker_id: share.workerId,
    job_id: share.jobId,
    height: share.height,
    difficulty_units: param(share.difficultyUnits),
    achieved_units: param(share.achievedUnits),
    is_block: share.isBlock,
  }))
  await exec`
    insert into pool_shares ${exec(
      rows,
      'chain',
      'worker_id',
      'job_id',
      'height',
      'difficulty_units',
      'achieved_units',
      'is_block',
    )}
  `
}

export interface BlockInput {
  readonly chain: PoolChainId
  readonly height: number
  readonly hash: string
  readonly foundByWorkerId: number | null
  readonly networkDifficultyUnits: bigint
  readonly reward: bigint
  readonly submitStatus: string
  readonly submitDetail: string | null
  readonly windowFirstShareId: bigint | null
  readonly windowLastShareId: bigint | null
}

/**
 * Record a block, whatever the node said about it.
 *
 * `on conflict do nothing` on `(chain, hash)`: a submission retried after a lost response reaches
 * here twice, and the second one must not become a second block. The return is the row id either
 * way, so a caller cannot tell the two apart — which is correct, because there is one block.
 */
export async function recordBlock(exec: Exec, block: BlockInput): Promise<number> {
  const rows = await exec<{ id: string }[]>`
    insert into pool_blocks (
      chain, height, hash, found_by_worker_id, network_difficulty_units, reward,
      submit_status, submit_detail, window_first_share_id, window_last_share_id
    )
    values (
      ${block.chain}, ${block.height}, ${block.hash}, ${block.foundByWorkerId},
      ${param(block.networkDifficultyUnits)}, ${param(block.reward)},
      ${block.submitStatus}, ${block.submitDetail},
      ${param(block.windowFirstShareId)}, ${param(block.windowLastShareId)}
    )
    on conflict (chain, hash) do nothing
    returning id
  `
  const inserted = rows[0]
  if (inserted) return Number(inserted.id)
  const existing = await exec<{ id: string }[]>`
    select id from pool_blocks where chain = ${block.chain} and hash = ${block.hash}
  `
  const row = existing[0]
  if (!row) throw new Error(`block ${block.hash} neither inserted nor found on ${block.chain}`)
  return Number(row.id)
}

export interface MaturityCandidate {
  readonly hash: string
  readonly height: number
}

/**
 * The blocks on one chain whose fate is still unknown, oldest first.
 *
 * **`submit_status = 'accepted'` is in the predicate and is not decoration.** A block the node
 * refused was never on the chain and asking the node about it once every ten minutes for ever would
 * be asking a question that has already been answered — migration 4 back-fills those rows to
 * `orphaned` for the same reason. Oldest first because the oldest pending block is the one closest
 * to maturing, so a capped sweep makes progress from the end that is about to move.
 */
export async function blocksAwaitingMaturity(
  exec: Exec,
  args: { chain: PoolChainId; limit: number },
): Promise<MaturityCandidate[]> {
  const rows = await exec<{ hash: string; height: number }[]>`
    select hash, height
    from pool_blocks
    where chain = ${args.chain}
      and maturity_status = 'pending'
      and submit_status = 'accepted'
    order by found_at
    limit ${args.limit}
  `
  return rows.map((row) => ({ hash: row.hash, height: row.height }))
}

/**
 * Record where a block stands, without ever touching what the node said at submission.
 *
 * `submit_status` is not in the update list and must never be: it is the node's verbatim verdict at
 * the one moment it could be observed, and a row rewritten to say `orphaned` would have thrown away
 * the only evidence distinguishing a coinbase built wrongly from bad luck. The two facts sit beside
 * each other.
 *
 * The predicate carries `maturity_status = 'pending'` so an `orphaned` row cannot be walked back to
 * `matured` by a later sweep — `maturity.ts` explains why orphaned is terminal — and so two replicas
 * racing on the same block settle rather than flapping. `matured_at` is set only on the transition,
 * which is what makes it the time the block matured rather than the time it was last looked at.
 */
export async function setBlockMaturity(
  exec: Exec,
  args: {
    chain: PoolChainId
    hash: string
    status: 'pending' | 'matured' | 'orphaned'
    confirmations: number | null
    detail: string | null
  },
): Promise<void> {
  await exec`
    update pool_blocks
       set maturity_status     = ${args.status},
           confirmations       = ${args.confirmations},
           maturity_detail     = ${args.detail},
           maturity_checked_at = now(),
           matured_at          = case when ${args.status} = 'matured' then now() else matured_at end
     where chain = ${args.chain}
       and hash = ${args.hash}
       and maturity_status = 'pending'
  `
}

/**
 * The blocks on one chain whose rewards actually exist: accepted, re-read, and buried past maturity.
 *
 * **This is the one definition of "payable" in this service, and it is deliberately a query rather
 * than a rule written down in prose.** Before micro-org#302 the only status a block carried was
 * `submit_status`, and the obvious mistake an eventual payout path was going to make was to treat
 * `accepted` as the eligibility test — which is a claim about what one node said once, not about
 * what is in the chain. Anything that pays must read this and nothing else, so that adding a new
 * disqualifying condition later is one edit here rather than a search for every place that
 * remembered to check.
 *
 * `matured` is the only status that qualifies, and the asymmetry is the point: `pending` covers both
 * a young block and a node that could not be reached, and both of those are "we do not know yet".
 *
 * Nothing calls this to pay anybody today — `payouts.ts` explains at length that no payout path
 * exists — so its only consumer is the test that asserts a re-organised block leaves it empty.
 */
export async function payableBlocks(
  exec: Exec,
  args: { chain: PoolChainId; limit: number },
): Promise<MaturityCandidate[]> {
  const rows = await exec<{ hash: string; height: number }[]>`
    select hash, height
    from pool_blocks
    where chain = ${args.chain}
      and maturity_status = 'matured'
      and submit_status = 'accepted'
    order by height
    limit ${args.limit}
  `
  return rows.map((row) => ({ hash: row.hash, height: row.height }))
}

export interface WindowRow {
  readonly workerId: number
  readonly account: string
  readonly worker: string
  readonly units: bigint
}

export interface WindowResult {
  readonly rows: readonly WindowRow[]
  readonly firstShareId: bigint | null
  readonly lastShareId: bigint | null
  readonly totalUnits: bigint
}

/**
 * The PPLNS window: the most recent shares on a chain, walking backwards, until their difficulty
 * sums to `windowUnits`.
 *
 * The running sum is computed in the database rather than by fetching shares and adding them up in
 * JavaScript, for the ordinary reason — a window on a busy chain is hundreds of thousands of rows —
 * and the boundary is `running - difficulty_units < windowUnits`, which **includes the share that
 * crosses the line** rather than excluding it. Excluding it would make the window very slightly
 * smaller than asked for; including it makes it very slightly larger. Either is defensible and the
 * choice matters only in that it is fixed: a miner reproducing the arithmetic has to get the same
 * set of shares we did.
 *
 * `endShareId` is passed rather than assumed to be "now" because a window is a claim about the
 * moment a block was found. Recomputing it later against a table that has since grown would answer
 * a different question.
 */
export async function pplnsWindow(
  exec: Exec,
  args: { chain: PoolChainId; endShareId: bigint; windowUnits: bigint },
): Promise<WindowResult> {
  const rows = await exec<
    { worker_id: string; account: string; worker: string; units: string; first_id: string; last_id: string }[]
  >`
    with windowed as (
      select
        s.id,
        s.worker_id,
        s.difficulty_units,
        sum(s.difficulty_units) over (order by s.id desc rows between unbounded preceding and current row) as running
      from pool_shares s
      where s.chain = ${args.chain} and s.id <= ${param(args.endShareId)}
    ),
    included as (
      select id, worker_id, difficulty_units
      from windowed
      where running - difficulty_units < ${param(args.windowUnits)}
    )
    select
      i.worker_id,
      w.account,
      w.worker,
      sum(i.difficulty_units)::text as units,
      min(i.id)::text as first_id,
      max(i.id)::text as last_id
    from included i
    join pool_workers w on w.id = i.worker_id
    group by i.worker_id, w.account, w.worker
    order by i.worker_id
  `

  if (rows.length === 0) {
    return { rows: [], firstShareId: null, lastShareId: null, totalUnits: 0n }
  }

  let firstShareId: bigint | null = null
  let lastShareId: bigint | null = null
  let totalUnits = 0n
  const mapped = rows.map((row) => {
    const first = BigInt(row.first_id)
    const last = BigInt(row.last_id)
    firstShareId = firstShareId === null || first < firstShareId ? first : firstShareId
    lastShareId = lastShareId === null || last > lastShareId ? last : lastShareId
    const units = BigInt(row.units)
    totalUnits += units
    return { workerId: Number(row.worker_id), account: row.account, worker: row.worker, units }
  })

  return { rows: mapped, firstShareId, lastShareId, totalUnits }
}

/**
 * The newest share id on a chain, which is where a window ends. Null when there are none.
 *
 * ═══ THE CAST IS ALIASED, AND THAT IS NOT COSMETIC ═══════════════════════════════════════════════
 *
 * `select id::text from pool_shares order by id desc` does NOT order by the share id. The output
 * column of `id::text` is itself called `id`, and SQL resolves a bare `ORDER BY` name against the
 * select list before it looks at the table — so the sort is over **text**, and text says `'9'` is
 * greater than `'10'`. With ten shares on file this answers 9. With two million it answers 999,999,
 * because that is the lexicographically largest decimal string below it.
 *
 * What that produces is not an off-by-one. This id is the `endShareId` of the PPLNS window computed
 * when a block is found, so a wrong answer here silently pays out against a window that ends a
 * million shares in the past: every miner who contributed since is credited nothing, the totals all
 * balance, and the row in `pool_blocks` records a window that looks entirely ordinary. That is
 * exactly the failure 36 §6 names — accounting that loses shares is indistinguishable, from the
 * miner's side, from a pool that steals them.
 *
 * Aliasing the cast to a name that is not a column name removes the ambiguity: `ORDER BY id` now has
 * only one thing it can mean. Every other statement in this file that sorts on a cast column
 * qualifies the sort key (`order by s.id`), which is the other way to say the same thing, and
 * `store.test.ts` pins this one against a table whose row count crosses a digit boundary.
 */
export async function latestShareId(exec: Exec, chain: PoolChainId): Promise<bigint | null> {
  const rows = await exec<{ share_id: string }[]>`
    select id::text as share_id from pool_shares where chain = ${chain} order by id desc limit 1
  `
  const row = rows[0]
  return row ? BigInt(row.share_id) : null
}

export interface ChainActivity {
  readonly shares: number
  readonly units: bigint
  readonly workers: number
}

/**
 * Accepted shares, summed difficulty and distinct workers over a recent interval.
 *
 * The summed difficulty is what a hashrate estimate is derived from, and it is returned raw rather
 * than converted here on purpose: turning work into a hashrate needs the chain's algorithm (see
 * `hashesPerDifficulty` in `pow.ts`), and a store that quietly assumed SHA-256d would report every
 * Litecoin miner as 65,536 times faster than they are.
 */
export async function chainActivity(
  exec: Exec,
  args: { chain: PoolChainId; sinceSeconds: number },
): Promise<ChainActivity> {
  const rows = await exec<{ shares: string; units: string | null; workers: string }[]>`
    select
      count(*)::text                            as shares,
      coalesce(sum(difficulty_units), 0)::text  as units,
      count(distinct worker_id)::text           as workers
    from pool_shares
    where chain = ${args.chain}
      and created_at > now() - make_interval(secs => ${args.sinceSeconds})
  `
  const row = rows[0]
  if (!row) return { shares: 0, units: 0n, workers: 0 }
  return { shares: Number(row.shares), units: BigInt(row.units ?? '0'), workers: Number(row.workers) }
}

export interface WorkerSummary {
  readonly workerId: number
  readonly account: string
  readonly worker: string
  readonly lastSeenAt: Date
  readonly lastDifficulty: bigint | null
  readonly recentShares: number
  readonly recentUnits: bigint
}

/** Every worker under one account, with its recent contribution. The `/workers` page of 36 §5.4. */
export async function workersForAccount(
  exec: Exec,
  args: { chain: PoolChainId; account: string; sinceSeconds: number },
): Promise<WorkerSummary[]> {
  const rows = await exec<
    {
      id: string
      account: string
      worker: string
      last_seen_at: Date
      last_difficulty: string | null
      recent_shares: string
      recent_units: string
    }[]
  >`
    select
      w.id,
      w.account,
      w.worker,
      w.last_seen_at,
      w.last_difficulty::text,
      count(s.id)::text                           as recent_shares,
      coalesce(sum(s.difficulty_units), 0)::text  as recent_units
    from pool_workers w
    left join pool_shares s
      on s.worker_id = w.id
     and s.chain = ${args.chain}
     and s.created_at > now() - make_interval(secs => ${args.sinceSeconds})
    where w.chain = ${args.chain} and w.account = ${args.account}
    group by w.id, w.account, w.worker, w.last_seen_at, w.last_difficulty
    order by w.worker
  `
  return rows.map((row) => ({
    workerId: Number(row.id),
    account: row.account,
    worker: row.worker,
    lastSeenAt: row.last_seen_at,
    lastDifficulty: row.last_difficulty === null ? null : BigInt(row.last_difficulty),
    recentShares: Number(row.recent_shares),
    recentUnits: BigInt(row.recent_units),
  }))
}

export interface ShareRecord {
  readonly id: bigint
  readonly worker: string
  readonly jobId: string
  readonly height: number
  readonly difficultyUnits: bigint
  readonly achievedUnits: bigint
  readonly isBlock: boolean
  readonly createdAt: Date
}

/**
 * One account's most recent shares, newest first.
 *
 * This is the endpoint 36 §6 is about. "The share history has to be checkable by the miner against
 * their own machine, which is a product requirement and not a nicety" — so it returns the achieved
 * difficulty of each share and the job it was against, which is what a miner's own log records, and
 * not merely a count.
 */
export async function sharesForAccount(
  exec: Exec,
  args: { chain: PoolChainId; account: string; limit: number },
): Promise<ShareRecord[]> {
  const rows = await exec<
    {
      id: string
      worker: string
      job_id: string
      height: number
      difficulty_units: string
      achieved_units: string
      is_block: boolean
      created_at: Date
    }[]
  >`
    select
      s.id::text, w.worker, s.job_id, s.height,
      s.difficulty_units::text, s.achieved_units::text, s.is_block, s.created_at
    from pool_shares s
    join pool_workers w on w.id = s.worker_id
    where s.chain = ${args.chain} and w.account = ${args.account}
    order by s.id desc
    limit ${args.limit}
  `
  return rows.map((row) => ({
    id: BigInt(row.id),
    worker: row.worker,
    jobId: row.job_id,
    height: row.height,
    difficultyUnits: BigInt(row.difficulty_units),
    achievedUnits: BigInt(row.achieved_units),
    isBlock: row.is_block,
    createdAt: row.created_at,
  }))
}

export interface BlockRecord {
  readonly height: number
  readonly hash: string
  readonly foundAt: Date
  readonly reward: bigint
  readonly networkDifficultyUnits: bigint
  readonly submitStatus: string
  readonly submitDetail: string | null
  /**
   * Whether the block survived, as `maturity.ts` last measured it — a different fact from
   * `submitStatus`, which is what the node said once at submission and is never revised.
   */
  readonly maturityStatus: string
  readonly confirmations: number | null
}

export async function recentBlocks(
  exec: Exec,
  args: { chain: PoolChainId; limit: number },
): Promise<BlockRecord[]> {
  const rows = await exec<
    {
      height: number
      hash: string
      found_at: Date
      reward: string
      network_difficulty_units: string
      submit_status: string
      submit_detail: string | null
      maturity_status: string
      confirmations: number | null
    }[]
  >`
    select height, hash, found_at, reward::text, network_difficulty_units::text, submit_status,
           submit_detail, maturity_status, confirmations
    from pool_blocks
    where chain = ${args.chain}
    order by found_at desc
    limit ${args.limit}
  `
  return rows.map((row) => ({
    height: row.height,
    hash: row.hash,
    foundAt: row.found_at,
    reward: BigInt(row.reward),
    networkDifficultyUnits: BigInt(row.network_difficulty_units),
    submitStatus: row.submit_status,
    submitDetail: row.submit_detail,
    maturityStatus: row.maturity_status,
    confirmations: row.confirmations,
  }))
}

/**
 * Delete shares older than a retention horizon — but never any share still inside a window that a
 * recorded block depends on.
 *
 * The floor is the oldest `window_first_share_id` of any block on file, and it is not a nicety: a
 * block's PPLNS allocation is reproducible only while the shares it names still exist, and §6 says
 * the miner has to be able to check it. Pruning by age alone would make the pool's own record of who
 * earned what unverifiable, starting with the oldest block and working forwards.
 */
export async function pruneShares(
  exec: Exec,
  args: { chain: PoolChainId; retentionDays: number; limit: number },
): Promise<number> {
  const rows = await exec<{ pruned: string }[]>`
    with floor_id as (
      select coalesce(min(window_first_share_id), 9223372036854775807) as id
      from pool_blocks
      where chain = ${args.chain}
    ),
    doomed as (
      select s.id
      from pool_shares s, floor_id f
      where s.chain = ${args.chain}
        and s.id < f.id
        and s.created_at < now() - make_interval(days => ${args.retentionDays})
      order by s.id
      limit ${args.limit}
    )
    delete from pool_shares
    where id in (select id from doomed)
    returning 1 as pruned
  `
  return rows.length
}
