/**
 * Right to erasure — `identity.user.deleted`, handled.
 *
 * Rule 6 of docs/ecosystem/03 §2: every service storing a `user_id` subscribes to this event and
 * erases. This service stores exactly one, and micro-org#534 held it open along with the other
 * three money-holding services until the owner settled the rule on 2026-09-02: **everything is
 * anonymised.** `deploy/erasure/register.psv` carries the decision in full, including the clause
 * that governs this file — deletion stays legal where deletion leaves LESS behind than
 * anonymisation would, because it is then the strictly stronger form of the same outcome.
 *
 * ── ONE ROW, AND THE SCHEMA WAS BUILT SO THAT IT WOULD BE ONE ROW ──────────────────────────────
 *
 * `pool_account_links.user_id` is the only column in this service that names a person, and that is
 * by design rather than luck. Migration 3's header refused to add a nullable `user_id` to
 * `pool_workers` precisely so that the estate account would never become a property of every miner:
 * a stranger points hardware at the stratum port, types whatever they like as a username, and
 * appears in `pool_workers` on exactly the same terms as an account holder. `pool_shares`,
 * `pool_blocks` and `pool_payout_credits` all reach a person — when there is one — through the
 * opaque `account` label and never through an id.
 *
 * So the work record is already anonymous. What identifies anybody is the single link row, and
 * removing it is the whole erasure.
 *
 * ── WHY THIS ONE DELETES WHERE THE OTHER THREE ANONYMISE ────────────────────────────────────────
 *
 * Anonymising here would leave `erased:<uuid> → <account>`: a row whose only content is that
 * SOMEBODY who no longer exists mined under that label. It anonymises nothing further than deleting
 * it does, and it leaves behind a fact that deletion does not. That is the register's test, and it
 * points one way.
 *
 * It also matters that deletion lands on a path this service already handles. `payouts.ts` calls
 * `userForAccount` to ask "is there anybody in this estate to credit", and null is its normal
 * answer — MOST pool accounts are not labels at all, they are the payout address a miner typed into
 * their own firmware, and those have no estate user and never did. A deleted link makes the
 * departed person's account look exactly like one of those, which `payouts.ts` refuses by name. An
 * `erased:` user id, by contrast, would be a value that has never existed on that path: it would be
 * handed to the ledger as a subject to credit, and the money would be posted into an account named
 * after nobody.
 *
 * ── WHAT IS NOT ERASED, AND CANNOT BE ───────────────────────────────────────────────────────────
 *
 * A firmware miner's `account` is frequently their own payout ADDRESS, which is personal enough in
 * the sense that matters. It cannot be erased on this event, because nothing links it to an estate
 * user id — that is the same property, read from the other side, that makes the stratum port open
 * to strangers. An erasure request from such a miner reaches this estate as an address, not as a
 * uuid, and has no handler. Recorded here rather than left for someone to discover: it is a real
 * limit, not an oversight, and closing it needs a route that takes an address and a proof of
 * control, which does not exist.
 *
 * Pending payout credits are the other limit, and it is the one custody and ledger share: nothing
 * settles a departing person's balance before the identifier goes, so a matured credit for the
 * deleted link becomes unpayable at the moment this runs. A handler that refused the erasure until
 * the balance was zero would be an erasure that never completes, which is the failure this
 * subscription exists to end.
 *
 * ── ONE PLANE ───────────────────────────────────────────────────────────────────────────────────
 *
 * This service has never held one database per network — `env.ts` reads a single `POOL_DATABASE_URL`
 * and `POOL_NETWORK` names the one network this process serves. There is no per-plane sweep to do
 * and no `CF-Network` to read, so the shape that left every testnet erasure undone for a fortnight
 * (micro-org#474) cannot arise here.
 */

import { SIGNATURE_HEADER, verifyDelivery } from '@cloudsforge/contracts-events'
import type { Sql } from 'postgres'
import type { Exec } from './store.ts'

export const USER_DELETED_TOPIC = 'identity.user.deleted'

export type InboxOutcome<T> = { readonly status: 'processed'; readonly value: T } | { readonly status: 'duplicate' }

/**
 * Run an inbound event's handler exactly once.
 *
 * Written here rather than imported because this service has no `outbox.ts` to put it in — it
 * publishes nothing, and migration 8's header explains why receiving one event does not change
 * that. The shape is the estate's, and the load-bearing part is that the claim and the handler
 * share ONE transaction: a handler that throws leaves no inbox row, so the redelivery is processed
 * rather than swallowed. "Record, then handle" loses an event every time the handler fails after
 * the insert commits, and for an erasure that means a deletion reported as done that never was.
 */
export async function withInbox<T>(
  sql: Sql,
  topic: string,
  eventId: string,
  handle: (tx: Exec) => Promise<T>,
): Promise<InboxOutcome<T>> {
  const outcome = await sql.begin(async (tx) => {
    const claimed = await tx<{ event_id: string }[]>`
      insert into inbox (topic, event_id) values (${topic}, ${eventId})
      on conflict (topic, event_id) do nothing
      returning event_id
    `
    if (claimed.length === 0) return { result: { status: 'duplicate' } as InboxOutcome<T> }
    const value = await handle(tx as unknown as Exec)
    return { result: { status: 'processed', value } as InboxOutcome<T> }
  })
  return outcome.result
}

export interface ErasureOutcome {
  /** Link rows removed. 0 or 1 — `user_id` is the primary key. */
  readonly links: number
}

/**
 * Unlink one user from their pool account.
 *
 * The account label, its workers, its shares and its blocks all stay exactly as they are. They are
 * a record of work done, they name nobody once this row is gone, and deleting them would destroy
 * the pool's own accounting for a window that other miners were paid out of.
 *
 * Counts are returned rather than logged here, and the caller logs the count and never the id —
 * writing the erased id into a log would recreate, in the one store nothing erases, exactly what
 * the request was to remove.
 */
export async function eraseUser(exec: Exec, userId: string): Promise<ErasureOutcome> {
  const rows = await exec`delete from pool_account_links where user_id = ${userId} returning 1`
  return { links: rows.length }
}

/**
 * ── VERIFY WITH THE CONTRACT, NOT WITH A LOCAL COPY OF IT ──────────────────────────────────────
 *
 * This file first shipped with its own `SIGNATURE_HEADER = 'x-cloudsforge-signature'` and its own
 * `sha256=<hmac over the body>`, copied from `micro-custody`'s `outbox.ts`. Both were wrong, and
 * wrong in the same way custody's were: the estate's delivery signature is the CONTRACT's —
 * `cf-signature: t=<seconds>,v1=<hmac over "<seconds>.<body>">` — and it carries a freshness
 * window that a plain body MAC does not have.
 *
 * MEASURED on 2026-09-02, with the subscription live: identity's relay logged
 * `POST http://pool:4000/v1/events -> 401` on all 50 attempted deliveries, while `micro-ledger` —
 * which delegates to the contract — took all 50 with the SAME key (compared by digest, never by
 * value). A probe hand-signed in the old scheme was accepted, which is what proved the key was
 * right and the scheme was wrong.
 *
 * So `@cloudsforge/contracts-events` is now a dependency of this service. It is the only one it
 * has that exists purely to CONSUME an event — `env.ts` still says this pool publishes nothing,
 * and that is still true.
 */
export { SIGNATURE_HEADER }

/** Timing-safety and the freshness window both live in the contract's verifier. */
export function verifyEventSignature(body: string, secret: string, presented: string): boolean {
  return verifyDelivery(body, presented, secret).ok
}
