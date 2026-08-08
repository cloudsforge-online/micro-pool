/**
 * The composition root.
 *
 * Everything this service is made of is constructed here, once, in an order that is not arbitrary.
 * Each step below carries the reason it must precede the next.
 *
 * What this file deliberately does **not** do: run migrations. That is `src/migrator.ts`, a
 * separate one-shot process. See AD-17 and rule 7.
 *
 * ## The order that is specific to a pool
 *
 * A pool has a second listener, and it is not interchangeable with the HTTP one. **The stratum ports
 * open only after every chain has validated its node's network and its payout address**, because a
 * miner that connects gets work immediately and work handed out before those checks is work mined
 * towards an address that may not exist. Conversely, on the way down, the stratum ports close FIRST:
 * a miner whose connection drops reconnects somewhere useful within seconds, whereas one that stays
 * connected to a draining pool keeps hashing against a job nobody will accept a share for.
 *
 * Traces are exported by the OpenTelemetry SDK loaded ahead of this module —
 * `NODE_OPTIONS=--import @opentelemetry/auto-instrumentations-node/register` in the deploy, which
 * reads `OTEL_EXPORTER_OTLP_ENDPOINT` and friends from the environment itself. That is why no
 * `OTEL_*` variable appears in `src/env.ts`: the service does not read them, so under rule 9 it must
 * not declare them.
 */

import postgres from 'postgres'
import { assertSchemaAtLeast, type Sql as DbSql } from '@cloudsforge/db'
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs'
import { Lifecycle, installSignalHandlers, postgresProbe, type Probe } from '@cloudsforge/lifecycle'
import { Logger, Metrics, registerHttpMetrics, registerJobMetrics } from '@cloudsforge/telemetry'
import { SERVICE, env } from './env.ts'
import { SCHEMA_VERSION } from './migrations.ts'
import { createServer } from './server.ts'
import { ChainService, registerPoolMetrics } from './chainservice.ts'
import { registerHandlers, rescheduleRecurring, seedRecurring } from './jobs.ts'
import type { Exec } from './store.ts'

// 1. Environment. Importing `./env.ts` validated it; a missing variable has already exited with a
//    structured line naming it. Nothing below may run first, because every step after this reads
//    configuration and a half-built service that then exits is harder to diagnose than one that
//    never started.

// 2. Telemetry, before anything that can fail, so a boot failure is a structured, searchable,
//    redacted line rather than a bare V8 stack the collector drops.
const logger = new Logger({
  service: SERVICE,
  level: env.logLevel,
  version: env.version,
  env: env.env,
})
const metrics = registerPoolMetrics(registerJobMetrics(registerHttpMetrics(new Metrics())))
logger.info('starting', {
  version: env.version,
  schemaVersion: SCHEMA_VERSION,
  network: env.network,
  chains: env.chains.map((chain) => chain.chain),
  feeBasisPoints: env.feeBasisPoints,
  // Stated at boot, every boot. An operator reading the first ten lines of a log must not be able
  // to come away believing this service pays anybody. See `payouts.ts`.
  payoutsImplemented: false,
})

// 3. The database pool. Opened before the schema assertion for the obvious reason that the
//    assertion is a query, and before the Lifecycle because the readiness probe closes over it.
const sql = postgres(env.databaseUrl, {
  max: env.databasePoolMax,
  // postgres.js writes notices to stderr as unstructured text by default, which is how a
  // connection string ends up in a log the collector cannot parse.
  onnotice: () => {},
})

// 4. Assert the schema. This does **not** migrate — the migrator job does, and it has already run
//    by the time a container starts. Failing here rather than serving is the point.
try {
  await assertSchemaAtLeast(sql as unknown as DbSql, SCHEMA_VERSION)
} catch (err) {
  logger.fatal('schema assertion failed', { err, required: SCHEMA_VERSION })
  await sql.end({ timeout: 5 }).catch(() => {})
  process.exit(1)
}

// 5. The Lifecycle and its probes, before the routes, because `/readyz` is a route and it needs
//    something to report. The service is `starting` from here until `markReady()`.
const lifecycle = new Lifecycle({
  // Must exceed one load-balancer probe interval or the balancer is still sending traffic when the
  // process stops accepting it.
  drainDelayMs: 5_000,
  drainTimeoutMs: 25_000,
  onStateChange: (state) => logger.info('lifecycle state', { state }),
})

lifecycle.addProbe(
  postgresProbe('postgres', (signal) =>
    // The probe deadline is enforced by the Lifecycle's AbortSignal, but a driver that ignores the
    // signal would hang `/readyz` for ever. Racing the signal here is what turns "the database is
    // not answering" into a fail rather than a hung readiness endpoint.
    Promise.race([
      sql`select 1`,
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('probe aborted')), { once: true })
      }),
    ]),
  ),
)

// 6. The chains. One `ChainService` each, constructed now and started below — construction is pure
//    wiring and cannot fail on a network, so it happens before anything is listening.
//
//    The abort controller is what stops every template loop at shutdown. It is aborted from a
//    shutdown hook rather than from a signal handler directly, so the ordering below governs it.
const chainsAbort = new AbortController()
const chains = env.chains.map(
  (config) =>
    new ChainService({
      config,
      network: env.network,
      sql: sql as unknown as Exec,
      logger,
      metrics,
      stratumBind: env.stratumBind,
      coinbaseTag: env.coinbaseTag,
      pplnsMultiplier: env.pplnsMultiplier,
      templatePollMs: env.templatePollMs,
      vardiffSharesPerMinute: env.vardiffSharesPerMinute,
      signal: chainsAbort.signal,
    }),
)

/**
 * A hard probe per chain: is this chain's template fresh enough to be worth mining on?
 *
 * Hard rather than soft, and that is the decision this probe exists to make. A soft probe would
 * leave the replica in the balancer while its miners hashed against a template from before the last
 * block — which looks completely healthy from outside (connections up, shares arriving) and is
 * worth nothing. `TEMPLATE_STALE_AFTER_MS` in `template.ts` sets the threshold and explains it.
 *
 * Note what this does NOT do: it does not close the stratum port. A node blip should not disconnect
 * every miner, because they will reconnect to the same replica anyway. Reporting unready is what
 * takes this replica out of the HTTP balancer and off the dashboard's green list.
 */
for (const chain of chains) {
  const probe: Probe = {
    name: `template-${chain.chain}`,
    kind: 'hard',
    check: async () =>
      chain.ready
        ? { state: 'pass' as const }
        : { state: 'fail' as const, detail: `no fresh ${chain.chain} template` },
  }
  lifecycle.addProbe(probe)
}

// 7. Routes. Constructed after the Lifecycle so the health handlers report real state, and after
//    the chains so the snapshot has something to read.
const server = createServer({
  lifecycle,
  logger,
  metrics,
  sql: sql as unknown as Exec,
  snapshot: () => ({
    network: env.network,
    feeBasisPoints: env.feeBasisPoints,
    pplnsMultiplier: env.pplnsMultiplier,
    chains: chains.map((chain) => chain.status()),
  }),
  // Queue depth, connection counts and template age are all sampled at scrape time rather than on
  // a timer. There is no `setInterval` in this repository, and CI greps for one — rule 8.
  beforeScrape: async () => {
    for (const chain of chains) chain.sampleGauges()
    const stats = await queue.stats()
    metrics.set('jobs_pending', stats.pending)
    metrics.set('jobs_overdue', stats.overdue)
  },
})

// 8. The job runner. Background work is claimed under a lease, so a replica that is draining stops
//    claiming before it stops serving — `shouldClaim` is wired to the Lifecycle for exactly that.
const queue = new JobQueue(sql as unknown as JobsSql, { owner: env.instanceId })
const chainIds = env.chains.map((chain) => chain.chain)
const reschedule = rescheduleRecurring(queue, logger, chainIds)
const runner = new JobRunner({
  queue,
  concurrency: 2,
  pollMs: 1_000,
  shouldClaim: () => lifecycle.claimingJobs,
  onEvent: (event) => {
    if (event.kind) {
      if (event.type === 'claimed') metrics.increment('jobs_claimed_total', { kind: event.kind })
      if (event.type === 'completed') metrics.increment('jobs_completed_total', { kind: event.kind })
      if (event.type === 'failed') metrics.increment('jobs_failed_total', { kind: event.kind })
      if (event.type === 'dead') metrics.increment('jobs_dead_total', { kind: event.kind })
      if (event.durationMs !== undefined) {
        metrics.observe('jobs_duration_ms', event.durationMs, { kind: event.kind })
      }
    }
    if (event.type === 'failed' || event.type === 'dead' || event.type === 'error') {
      logger.error('job failure', { ...event })
    }
    reschedule(event)
  },
})

registerHandlers(runner, {
  sql: sql as unknown as Exec,
  logger,
  chains: chainIds,
  retentionDays: env.shareRetentionDays,
})
await seedRecurring(queue, chainIds)
runner.start()

// 9. Start the chains. This is where the node is contacted, the payout address is validated and the
//    stratum ports open.
//
//    What reaches this catch is narrower than it looks, and the narrowing is the design: a chain
//    whose node ANSWERED with something unusable — the wrong network, an address the node calls
//    invalid — throws here and the process exits, because nothing about that improves by waiting and
//    a deploy is where somebody is watching. A chain whose node did not answer AT ALL does not throw;
//    it retries in the background with its stratum port shut and reports itself unready. See the
//    header of `chainservice.ts`. Exiting for that second case would turn "bitcoind is still
//    starting up beside us" into a crash loop.
try {
  for (const chain of chains) await chain.start()
} catch (err) {
  logger.fatal('a chain refused to start', { err })
  await runner.stop(5_000).catch(() => {})
  await sql.end({ timeout: 5 }).catch(() => {})
  process.exit(1)
}

// 10. Listen on HTTP. Last of the construction steps, because a socket that accepts before its
//     dependencies exist is a socket that answers 500.
await new Promise<void>((resolve, reject) => {
  server.once('error', reject)
  server.listen(env.port, () => resolve())
})
logger.info('listening', {
  port: env.port,
  // The CONFIGURED stratum ports, not a claim that each one is open: a chain still waiting on its
  // node has not bound its port yet. `/readyz` and the per-chain status route are where that is
  // reported, and a log line that asserted otherwise would be the first thing an operator believed.
  stratumPorts: env.chains.map((chain) => ({ chain: chain.chain, port: chain.stratumPort })),
  chainsServing: chains.filter((chain) => chain.ready).map((chain) => chain.chain),
})

// 11. Ready. Only now: the state moves `starting → ready`, `/readyz` starts answering 200, and the
//     balancer is allowed to send traffic.
lifecycle.markReady()

// 12. Signal handlers, last of all. Hooks run in REVERSE registration order, so read the block
//     below from the bottom up: stratum closes first (which flushes the last buffered shares), then
//     HTTP, then the job runner drains, then the database pool closes with nothing left to use it.
lifecycle.onShutdown(async () => {
  await sql.end({ timeout: 5 })
  logger.info('database pool closed')
})
lifecycle.onShutdown(async () => {
  const clean = await runner.stop(20_000)
  logger.info('job runner stopped', { clean })
})
lifecycle.onShutdown(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve())
      // Idle keep-alive sockets hold the server open past the drain budget. Closing them is what
      // makes `server.close()` a bounded operation rather than a wait on the slowest client.
      server.closeIdleConnections()
    }),
)
lifecycle.onShutdown(async () => {
  // First to run. Stops the template loops, closes every stratum listener, disconnects the miners
  // and — the part that matters — flushes the buffered shares one final time. A miner disconnected
  // here reconnects elsewhere in seconds; a share dropped here is work somebody did that nobody
  // has a record of.
  chainsAbort.abort()
  for (const chain of chains) await chain.stop()
  logger.info('stratum listeners closed and shares flushed')
})

installSignalHandlers(lifecycle)
