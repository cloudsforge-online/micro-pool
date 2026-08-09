/**
 * The modules another repository loads out of a bare checkout of this one, and the one property
 * they have to keep.
 *
 * micro-hub-web's `test/pool-contract.test.ts` drives the browser miner against THIS service's own
 * Stratum code rather than against a re-description of it, because a byte-order or field-order
 * defect in a Stratum client is invisible from inside that repository: a client that assembles the
 * header wrong produces uniformly distributed bytes that fail the target comparison exactly as an
 * honest losing nonce does. So it checks micro-pool out beside itself and imports these five
 * modules directly.
 *
 * It does NOT install this package. There is no `node_modules` in that checkout. Everything those
 * five reach, transitively, must therefore import nothing but `node:` builtins and each other —
 * `import type` is fine, since the transpiler elides it, but a value import of a bare specifier is
 * a hard `ERR_MODULE_NOT_FOUND` over there.
 *
 * ── WHY THIS TEST IS HERE AND NOT ONLY THERE ──────────────────────────────────────────────────
 *
 * A version of it *is* there, and on 2026-08-09 it did not fire. `session.ts` took a value import
 * of `./chains.ts` for one error string (micro-org#286), `chains.ts` value-imports
 * `@cloudsforge/contracts-chain`, and micro-hub-web's release CI died at module load with
 * ERR_MODULE_NOT_FOUND — before any assertion ran, including the assertion written to catch this.
 * A guard that lives downstream of the thing it guards cannot report on it.
 *
 * It also failed in the wrong repository. The commit was here; the red was three repositories away,
 * in a release PR, on a suite whose output says nothing about micro-pool. This file puts the red
 * where the cause is.
 *
 * The entry list below is the five modules that consumer imports, and the graph is walked from
 * them rather than enumerated — a hand-written file list would go stale the first time one of these
 * modules imports a new neighbour, which is precisely the change that breaks this.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.dirname(fileURLToPath(import.meta.url))

/**
 * The five `poolModule(...)` calls in micro-hub-web's `test/pool-contract.test.ts`.
 *
 * Named here rather than derived, because the sibling checkout is not present when this suite runs
 * in micro-pool's own CI. Adding to that list over there without adding to it here loses coverage
 * quietly, which is why the list is short and the reason is written down.
 */
const ENTRIES = ['work.ts', 'pow.ts', 'validate.ts', 'session.ts', 'vardiff.ts']

/** Every `import ... from '...'` that survives transpilation, i.e. not `import type`. */
function runtimeImports(file: string): string[] {
  const source = readFileSync(path.join(SRC, file), 'utf8')
  const found: string[] = []
  for (const line of source.split('\n')) {
    const match = /^import\s+(?!type\s)(?:.*?from\s+)?'([^']+)'/.exec(line)
    if (match?.[1]) found.push(match[1])
  }
  return found
}

test('the graph micro-hub-web loads reaches nothing a bare checkout cannot resolve', () => {
  const seen = new Set<string>()
  const queue = [...ENTRIES]
  const offenders: string[] = []
  while (queue.length > 0) {
    const file = queue.shift() as string
    if (seen.has(file)) continue
    seen.add(file)
    for (const specifier of runtimeImports(file)) {
      if (specifier.startsWith('node:')) continue
      if (specifier.startsWith('./')) {
        queue.push(specifier.slice(2))
        continue
      }
      offenders.push(`${file} → ${specifier}`)
    }
  }
  // Named individually: "one of ten files is wrong" is a message that sends the reader back to
  // grep, and the whole point of failing here rather than in micro-hub-web is to save that trip.
  assert.deepEqual(
    offenders,
    [],
    `these are loaded by micro-hub-web out of a checkout with no node_modules, so a bare specifier ` +
      `is ERR_MODULE_NOT_FOUND over there:\n  ${offenders.join('\n  ')}\n` +
      `Take the value across as data — see SessionDeps.chainName — or make the import 'import type'.`,
  )
  // The walk has to have actually walked. An entry list that stopped resolving would make the
  // assertion above pass by reaching nothing at all.
  assert.ok(seen.size >= ENTRIES.length + 3, `walked only ${seen.size} modules; the graph is larger`)
})
