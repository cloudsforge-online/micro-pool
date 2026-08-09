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
  {
    version: 3,
    name: 'account-links',
    /*
     * ═══ THIS IS A NEW TABLE BECAUSE `pool_workers` MUST NOT GROW A USER COLUMN ═════════════════
     *
     * Version 2 above says, in the DDL and not only in prose: "There is no join to an estate user
     * here and that is deliberate: a miner points hardware at a port and gives an address, and
     * requiring an account first would exclude every miner who already has one." micro-org#289 adds
     * a browser miner that DOES have an estate account, and the obvious change — a nullable
     * `user_id` on `pool_workers` — would quietly retire that sentence. It is not made.
     *
     * The property being preserved is not tidiness. Raw TCP is unchanged by this migration and by
     * the release it belongs to: a stranger still connects to the stratum port, still types whatever
     * they like as a username, still has no account, and still appears in `pool_workers` on exactly
     * the same terms as before. The link below is additive and opt-in, it is written only when an
     * estate user asks this service for a mining ticket, and every path that reads a share or a
     * worker is untouched by its existence. A column on `pool_workers` would have made the estate
     * account a property of every miner — null for most of them, which is the shape that invites the
     * next reader to make it `not null`.
     *
     * ## Deliberately NOT chain-scoped, which is the one place this table differs from every other
     *
     * Every other table here carries `chain` and every statement filters on it, because a pool
     * serving two chains has two accounting universes. A person is not per chain. One estate user
     * has one pool account and mines whatever they point a tab at, so the label is minted once and
     * reused, and `store.test.ts` drives its scoping sweep from `POOL_CHAIN_TABLES` rather than from
     * every table this service owns for exactly this reason.
     */
    up: `
      create table if not exists pool_account_links (
        -- The estate user id, as it appears in the 'sub' claim of an access token. Never published:
        -- GET /v1/pool/shares?account= is unauthenticated, so the label a browser miner is credited
        -- under is the opaque 'account' below and never this column. See src/tickets.ts.
        user_id      text        primary key,
        -- The pool account label. Random and opaque, minted on first use, and inside the character
        -- set session.ts enforces for a stratum username so that it is a legal account everywhere
        -- else in this schema.
        account      text        not null,
        created_at   timestamptz not null default now(),
        last_used_at timestamptz not null default now(),
        -- One user, one account, and no account shared by two users. The first half stops a share
        -- history being split in two by a race on first use; the second stops one user's work being
        -- credited into another's page.
        constraint pool_account_links_account_uniq unique (account)
      );
    `,
  },
  {
    version: 4,
    name: 'block-maturity',
    /*
     * ═══ `submit_status` IS WHAT THE NODE SAID ONCE. THIS IS WHETHER IT STAYED TRUE ═════════════
     *
     * Migration 2 above records `submit_status` and says what it is for: "What the node said when
     * the block was submitted". Nothing re-read it afterwards, and micro-org#302 is the defect that
     * follows from that — a coinbase is unspendable for 100 blocks on both chains and a block can be
     * orphaned well inside that window, so `accepted` means the node took the block, not that the
     * block is in the chain. Paying against `accepted` alone pays money that does not exist.
     *
     * The columns below are a SECOND fact beside the first rather than a correction of it. Nothing
     * overwrites `submit_status`, because the node's verbatim verdict at submission time is the most
     * useful diagnostic this service produces and a row that had been edited to say `orphaned` would
     * have lost it. `maturity_status` answers a different question — is this block on the active
     * chain at spendable depth — and `maturity.ts` is the only thing that writes it.
     *
     * ## Why the default is `pending` and why that is the safe direction
     *
     * Every block already on file becomes `pending` and is therefore NOT payable, including blocks
     * the pool found months ago that have been buried since. The watcher re-reads each one against
     * the node and promotes it. The reverse default — assuming an old accepted block matured —
     * would have made the back-fill itself the payment decision, which is exactly the conflation
     * this migration exists to undo.
     *
     * ## Blocks the node REFUSED are back-filled `orphaned`, not left `pending`
     *
     * A block `submitblock` rejected never entered the chain and never will, so it is not waiting
     * for anything; leaving it `pending` would put a permanent row in the watcher's queue and in
     * every "still maturing" count an operator reads. `orphaned` is literally accurate for it — not
     * on the active chain — and the reason it is not on the active chain is preserved unchanged in
     * `submit_status` and `submit_detail` beside it.
     */
    up: `
      alter table pool_blocks
        add column if not exists maturity_status      text not null default 'pending',
        add column if not exists confirmations        integer,
        add column if not exists maturity_detail      text,
        add column if not exists maturity_checked_at  timestamptz,
        add column if not exists matured_at           timestamptz;

      -- Three values and no more. A payout path reads 'matured' and nothing else, so a fourth
      -- spelling introduced later by a typo would be a block that is silently never paid; the
      -- constraint turns that into a failed write at the moment it is made.
      alter table pool_blocks
        drop constraint if exists pool_blocks_maturity_ck;
      alter table pool_blocks
        add constraint pool_blocks_maturity_ck
        check (maturity_status in ('pending', 'matured', 'orphaned'));

      update pool_blocks
         set maturity_status = 'orphaned',
             maturity_detail = 'the node refused this block at submission; it was never on the chain'
       where submit_status <> 'accepted' and maturity_status = 'pending';

      -- The watcher's access path: the pending blocks of one chain, oldest first. Partial, because
      -- the rows it excludes are the overwhelming majority once a pool has been running a while and
      -- they are never selected by this query again.
      create index if not exists pool_blocks_pending_maturity_idx
        on pool_blocks (chain, found_at)
        where maturity_status = 'pending';
    `,
  },
]

/**
 * The tables whose every row belongs to one chain.
 *
 * This is the list that drives the scoping sweep in `store.test.ts` — the check that every statement
 * naming one of these also filters on `chain`. A pool serving Bitcoin and Litecoin has two
 * independent accounting universes in one schema, a query that forgot the column would divide a
 * Bitcoin block's reward among Litecoin miners, and nothing about the resulting numbers looks wrong
 * from outside. The list is a constant rather than a literal in the test so that a new table is
 * covered by the sweep the day it is added rather than the day somebody remembers.
 *
 * `pool_account_links` is deliberately NOT here. It maps an estate user to their pool account label
 * and a person is not per chain; migration 3 says so where the table is created.
 */
export const POOL_CHAIN_TABLES: readonly string[] = Object.freeze(['pool_shares', 'pool_blocks', 'pool_workers'])

/**
 * Every table this service owns, chain-scoped or not.
 *
 * Read by `store.test.ts` to reset the schema between database-backed cases, and to check rule 1
 * from the other direction: a statement in `store.ts` naming a table that is not in this list is a
 * pool reading somebody else's data.
 */
export const POOL_TABLES: readonly string[] = Object.freeze([...POOL_CHAIN_TABLES, 'pool_account_links'])

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
