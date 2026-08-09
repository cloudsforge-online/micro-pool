/**
 * The versioned schema.
 *
 * Rule 7 of docs/ecosystem/03 §2: versioned files, run by a one-shot job under an advisory lock,
 * expand/contract only. Nothing here is executed by `index.ts` — `src/migrator.ts` is the only
 * caller, and the service asserts the version rather than reaching it.
 *
 * **A released migration is immutable.** `@cloudsforge/db` checksums each one and refuses a run
 * where the text changed after it was applied, because two databases would then disagree about what
 * "version 2" means. The fix for a wrong migration is always a new migration.
 *
 * ## Why difficulty is stored as an integer number of units and not as a float
 *
 * A share's weight is the difficulty it was credited at, and those weights are summed over hundreds
 * of thousands of rows to decide how a block reward is divided. `double precision` sums are not
 * associative: the same set of shares aggregated in a different order gives a different total, and
 * two answers to "what is this miner owed" that differ in the tenth decimal place are two answers.
 *
 * So every difficulty here is `difficulty × 10^8`, stored as `bigint`, exactly the way the estate
 * stores money — `contracts-chain` gives every Bitcoin-family asset 8 decimals for the same reason.
 * `pplns.ts` owns the conversion in both directions and nothing else performs it. Postgres sums
 * bigints into `numeric`, which is exact and has no overflow to reason about, and the result parses
 * straight back into a JavaScript `bigint`.
 *
 * §6 of `docs/ecosystem/36-multi-chain-and-mining-pool.md`: "Share accounting that loses shares is
 * indistinguishable, from the miner's side, from a pool that steals them." A float sum does not lose
 * a share, it loses a fraction of one — which is worse, because it is unfalsifiable.
 */

import { JOBS_SCHEMA_SQL } from '@cloudsforge/jobs'
import type { Migration } from '@cloudsforge/db'

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'jobs',
    // Taken verbatim from the runtime package so the table the claim query assumes and the table
    // that exists cannot drift. Copying the DDL by hand is how a service ends up with a jobs table
    // missing the (kind, key) unique constraint, which silently turns every recurring enqueue into
    // a duplicate run.
    up: JOBS_SCHEMA_SQL,
  },
  {
    version: 2,
    name: 'pool',
    up: `
      -- One row per (chain, account, worker). The account is what a payout would eventually be
      -- made to and the worker is the miner's own label for one machine; both come out of the
      -- stratum username, which is the only identity the protocol has. There is no join to an
      -- estate user here and that is deliberate: a miner points hardware at a port and gives an
      -- address, and requiring an account first would exclude every miner who already has one.
      create table if not exists pool_workers (
        id              bigserial   primary key,
        chain           text        not null,
        account         text        not null,
        worker          text        not null,
        first_seen_at   timestamptz not null default now(),
        last_seen_at    timestamptz not null default now(),
        last_difficulty bigint,
        constraint pool_workers_identity_uniq unique (chain, account, worker)
      );

      create index if not exists pool_workers_account_idx on pool_workers (chain, account, last_seen_at desc);

      -- The debt record. Every accepted share, until pruned, with the difficulty it was credited at
      -- AND the difficulty it actually achieved. Both are stored because the second is what a
      -- miner's own software prints: 36 §5.4 requires the share history to be checkable against the
      -- miner's machine, and a history that records only what we chose to credit gives them nothing
      -- to check against.
      create table if not exists pool_shares (
        id               bigserial   primary key,
        chain            text        not null,
        worker_id        bigint      not null references pool_workers (id),
        job_id           text        not null,
        height           integer     not null,
        difficulty_units bigint      not null,
        achieved_units   bigint      not null,
        is_block         boolean     not null default false,
        created_at       timestamptz not null default now()
      );

      -- The PPLNS window walks backwards from the newest share on a chain, so this is the access
      -- path for the accounting. Descending, because that is the only direction it is ever read in.
      create index if not exists pool_shares_window_idx on pool_shares (chain, id desc);
      create index if not exists pool_shares_worker_idx on pool_shares (worker_id, id desc);
      create index if not exists pool_shares_recent_idx on pool_shares (chain, created_at desc);

      -- Blocks this pool found. The window bounds are recorded AT THE MOMENT THE BLOCK WAS FOUND,
      -- because PPLNS is a claim about which shares were outstanding then — recomputing the window
      -- later against a pruned share table would silently pay a different set of people.
      create table if not exists pool_blocks (
        id                       bigserial   primary key,
        chain                    text        not null,
        height                   integer     not null,
        hash                     text        not null,
        found_by_worker_id       bigint      references pool_workers (id),
        found_at                 timestamptz not null default now(),
        network_difficulty_units bigint      not null,
        reward                   bigint      not null,
        -- What the node said when the block was submitted: 'accepted', or the node's own rejection
        -- reason verbatim. A pool that records only the blocks the node liked has no record of the
        -- ones it did not, which is the single most important thing to be able to look at.
        submit_status            text        not null,
        submit_detail            text,
        window_first_share_id    bigint,
        window_last_share_id     bigint,
        constraint pool_blocks_hash_uniq unique (chain, hash)
      );

      create index if not exists pool_blocks_recent_idx on pool_blocks (chain, found_at desc);
    `,
  },
]

/**
 * The tables this service owns, named once.
 *
 * Read by `store.test.ts` twice over: to reset the schema between database-backed cases, and — the
 * reason it is a constant rather than a literal in a test — to drive the scoping sweep that checks
 * every statement in `store.ts` naming one of these also filters on `chain`. A list that lived only
 * in the test would grow a table late or not at all, and the statement it failed to cover would be
 * the one reading another chain's shares.
 */
export const POOL_TABLES: readonly string[] = Object.freeze(['pool_shares', 'pool_blocks', 'pool_workers'])

/**
 * The version this build requires. `index.ts` asserts it at boot and refuses to serve below it,
 * which is what stops a replica of the new code answering requests against the old schema when a
 * deploy runs ahead of its migrator.
 *
 * **There is deliberately no payouts table here.** Payout crediting is not implemented in this
 * release — `payouts.ts` says so in detail and the README says so in the first screen. A table
 * called `pool_payout_credits` sitting empty in the schema would read, to the next person, as a
 * feature that exists and is not firing. The migration that creates it belongs to the change that
 * writes to it.
 */
export const SCHEMA_VERSION: number = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)

/**
 * How an existing hand-built schema is adopted. This service is new and has no predecessor, so it
 * is 0 and stays 0.
 */
export const BASELINE_VERSION = 0
