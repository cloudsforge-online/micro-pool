# cloudsforge-pool

[![ci](https://github.com/cloudsforge-online/micro-pool/actions/workflows/ci.yml/badge.svg)](https://github.com/cloudsforge-online/micro-pool/actions/workflows/ci.yml) [![TypeScript](https://img.shields.io/badge/TypeScript-strict%20ESM-3178C6?logo=typescript&logoColor=white)](./tsconfig.base.json) [![node](https://img.shields.io/badge/node-%3E%3D22-5FA04E?logo=nodedotjs&logoColor=white)](./package.json) [![tests](https://img.shields.io/badge/tests-real%20Postgres-4169E1?logo=postgresql&logoColor=white)](./.github/workflows/ci.yml) [![licence](https://img.shields.io/badge/licence-MIT-blue)](./LICENSE)

A **Stratum v1 mining pool** for the Bitcoin-family chains this estate runs its own nodes for. It
builds block templates from those nodes, hands work to real mining hardware over raw TCP, judges the
shares that come back, submits the blocks, and records who is owed what.

Implements §5 of
[docs/ecosystem/36-multi-chain-and-mining-pool.md](https://github.com/cloudsforge-online/micro-docs/blob/main/ecosystem/36-multi-chain-and-mining-pool.md).

---

## READ THIS FIRST: payouts are not implemented

**This service records a debt. It does not pay one.** Nothing here credits a ledger, moves a
balance, or touches the wallet. When this pool finds a block it computes the PPLNS allocation, writes
the block row with the window bounds it was decided against, and stops.

`src/payouts.ts` is a **named, typed seam and nothing more**: the types every crediting
implementation will need, the `credit_key` idempotency shape borrowed verbatim from
`wallet/src/deposits.ts` so the eventual implementation cannot invent a second one, and a function
that throws. There is no payouts table in the schema either, deliberately — an empty
`pool_payout_credits` would read to the next person as a feature that exists and is not firing.

There is nothing here that will half-pay somebody. That was the point of leaving it out rather than
stubbing it.

The other named holes, in one place:

| Not implemented | What happens instead |
| --- | --- |
| Paying miners | `src/payouts.ts` throws. No ledger call exists anywhere in this repository. |
| Dogecoin | **Refused by name at boot.** `POOL_CHAINS=doge` will not start the service — see below. |
| Stratum v2 | Not implemented and not planned for this pass. v1 is what deployed hardware speaks. |
| TLS on the stratum port | Not implemented. Stratum v1 as deployed is plain TCP; the HTTP port is separate. |
| Solo mining / PPS | Not implemented. PPLNS only. |
| A miner-facing web UI | Not implemented. The read API is public JSON. |

---

## Dogecoin is refused, not missing

Dogecoin is **merge-mined with Litecoin through AuxPoW**. A valid Dogecoin block carries an AuxPoW
header committing to a Litecoin parent block, and this release does not build one.

A pool that added `doge` to a table and handed out ordinary scrypt work would produce solutions the
Dogecoin network discards — and it would look like it was working, because the shares would validate
against the pool's own target perfectly. So `doge` is listed in `REFUSED_CHAINS` in `src/chains.ts`
with the reason, and `src/env.ts` refuses to start with it configured. It is a decision, not a gap in
a lookup table, and it is written that way so nobody fills the gap in.

Implementing it means implementing AuxPoW: a merged-mining coinbase commitment on the Litecoin side,
the parent-block proof on the Dogecoin side, and a second `submitblock` path. That is its own change.

---

## Proof of work: SHA256d for BTC, scrypt for LTC

These are different functions and **a pool that uses the wrong one silently rejects every share** —
the miner sees 100% rejects and the pool sees nothing wrong with itself. The dispatch is on chain,
in one place (`powHash` in `src/pow.ts`), and every consumer goes through it.

The difficulty-1 targets differ too, which is the subtler half of the same trap: SHA-256d's is
`0xffff × 2^208` and scrypt's is `0xffff × 2^224`. Using Bitcoin's constant on Litecoin makes every
share appear 65,536× harder than it is. `diff1TargetFor` is the only place either number is written.

**scrypt comes from Node's own `crypto.scryptSync`** — N=1024, r=1, p=1, with the 80-byte header as
both password and salt, which is the Litecoin parameter set. It is in the standard library, it is
OpenSSL underneath, and it is not an npm package that could be unpublished or compromised. The
alternative was `scrypt-js` or a native binding; the reasoning is written out in `src/pow.ts`.

---

## Running it

```sh
pnpm install                  # pnpm, not npm — `npm ci` cannot resolve the link: specifiers
cp .env.example .env          # then fill in POOL_BTC_NODE_URL and POOL_BTC_PAYOUT_ADDRESS
pnpm migrate                  # the one-shot migrator, separately from the service
pnpm start
```

```sh
curl -s localhost:4146/livez
curl -s localhost:4146/readyz
curl -s localhost:4146/metrics
curl -s localhost:4146/v1/pool | jq          # chains, heights, difficulty, connections, fee
curl -s "localhost:4146/v1/pool/blocks?chain=btc" | jq
curl -s "localhost:4146/v1/pool/workers?chain=btc&account=<address>" | jq
curl -s "localhost:4146/v1/pool/shares?chain=btc&account=<address>" | jq
```

Point a miner at the stratum port — 3333 for BTC, 3334 for LTC by default. The username is
`<payout-address>.<worker>` and the password is ignored:

```sh
cgminer -o stratum+tcp://127.0.0.1:3333 -u bc1qyouraddress.rig1 -p x
```

`127.0.0.1` there is a fact about a local checkout and not something this service told you. What a
miner elsewhere should dial is `POOL_STRATUM_PUBLIC_HOST` and `POOL_<CHAIN>_STRATUM_PUBLIC_PORT`,
both unset by default — see the section below.

### Tests

```sh
pnpm typecheck && pnpm test
```

The suite is `node:test`, and **every share in it is mined for real** — there is no way to fake proof
of work, which is the point of it. The tests run at a difficulty low enough that a share turns up in
about 65,000 hashes, and `src/faketemplate.ts` serves regtest-difficulty templates so the *block*
branch is reachable at all rather than being the one path nothing ever takes.

The database-backed tests skip unless this is set, and **the name must contain `test`** — they
truncate, and that requirement is the difference between a red build and an emptied environment:

```sh
docker run -d --rm --name pool-test-pg -e POSTGRES_PASSWORD=ci -e POSTGRES_USER=ci \
  -e POSTGRES_DB=pool_test -p 55432:5432 postgres:17-alpine

POOL_TEST_DATABASE_URL=postgres://ci:ci@127.0.0.1:55432/pool_test pnpm test
```

### Mining a real block on a real node

```sh
scripts/regtest-mweb.sh          # needs Docker; nothing here touches an estate node
```

The suite mines every share for real but it cannot tell you whether a **node** accepts the block that
comes out, because every byte of it is checked against a fixture this repository also wrote. That gap
is what micro-org#277 was: the suite passed in full against a service that could not obtain a block
template from Litecoin at all.

So this script starts a litecoind on regtest in Docker, mines it past MWEB activation, puts a few
transactions in its mempool, and runs `src/regtest.test.ts` — which drives this repository's own
template fetch, coinbase assembly, merkle fold and block serialisation and then calls `submitblock`.
It passes when the node accepts the block and its height goes up by one. `src/regtest.test.ts` skips
without `POOL_REGTEST_NODE_URL`, which is what happens in CI; the script's own header explains why
this is not a CI job and what MWEB needs on regtest that mainnet does not.

### The image

```sh
docker build -t cloudsforge-pool \
  --build-context runtimepkgs=../runtime \
  --build-context contractspkgs=../contracts .
```

---

## What is in here

| File | What it is |
| --- | --- |
| `src/index.ts` | The composition root. The boot order, and why the stratum ports open last and close first. |
| `src/env.ts` | Typed configuration, validated at import. Names the missing variable and never echoes a node URL. |
| `src/chains.ts` | Which chains this pool mines, which it refuses and why. Everything else comes from `@cloudsforge/contracts-chain`. |
| `src/pow.ts` | SHA256d and scrypt, the two difficulty-1 targets, compact-bits decoding, difficulty↔target. |
| `src/bytes.ts` | The four byte orders this protocol uses, each named, with the conversions between them. |
| `src/merkle.ts` | The merkle branch with a hole at the coinbase, and the fold that reconstructs a root from one. |
| `src/coinbase.ts` | Building the coinbase transaction: BIP34 height, the extranonce placeholders, the witness commitment, the `coinb1`/`coinb2` split. |
| `src/mweb.ts` | Recognising Litecoin's MWEB integrating transaction in a template, and refusing one that is not last. |
| `src/template.ts` | `getblocktemplate`, longpoll, staleness, the payout-address and network checks. |
| `src/work.ts` | A template becomes a job: the `mining.notify` parameters and the job history a submit can still name. |
| `src/stratum.ts` | The TCP listener and the line framing. Timeouts, back-pressure, the share buffer. |
| `src/session.ts` | The Stratum v1 state machine: subscribe, authorize, configure, notify, submit. No socket in it. |
| `src/vardiff.ts` | Per-connection difficulty retargeting toward a steady share rate. |
| `src/validate.ts` | Rebuilding the header from a submission and judging it against the share target and the block target. |
| `src/blocks.ts` | What happens when a share is a block, in the order it has to happen in. |
| `src/pplns.ts` | The sliding window, and the integer allocation that makes the parts sum to the whole. |
| `src/payouts.ts` | The seam. Not implemented — see the top of this file. |
| `src/store.ts` | Every SQL statement, each scoped to one chain. |
| `src/server.ts` | `node:http`. `/livez`, `/readyz`, `/metrics`, and the public read API. |

---

## Decisions worth knowing before you change them

**Stratum v1, not v2.** v2 is better in every respect except the one that matters: v1 is what the
firmware on deployed hardware speaks. A pool that only speaks v2 is a pool almost nothing can connect
to. §5 of the multi-chain document decided this and it is not re-litigated here.

**Shares are stored as integer difficulty units, never floats.** A share's weight is summed over
hundreds of thousands of rows to decide how a block reward divides, and `double precision` sums are
not associative — the same shares aggregated in a different order give a different total. Every
difficulty on disk is `difficulty × 10^8` as a `bigint`, exactly the way this estate stores money.
§6: "share accounting that loses shares is indistinguishable, from the miner's side, from a pool that
steals them."

**A found block is written synchronously; accepted shares are buffered.** A share is acknowledged in
the time it takes to hash a header, and putting a database round trip in front of that reply makes
the pool's latency the database's latency — the first thing a miner notices. So shares are flushed on
a short timer, and the cost is stated rather than hidden: **a hard kill loses up to one flush interval
of shares.** A block is never buffered. It is written before the miner is even told the share was
accepted, because that one row is worth more than every other row in the table put together.

**The PPLNS window bounds are recorded when the block is found**, not recomputed later. Recomputing
against a pruned share table would quietly pay a different set of people.

**There is exactly one node endpoint per chain, and it does not fail over.** `getblocktemplate` is not
a read of settled history; it is a request for work a specific node assembled from a specific mempool,
and `submitblock` has to go back to the same node. Failing over mid-job would hand miners a merkle
branch belonging to a block the other node never proposed. An endpoint that stops answering stops the
chain — `/readyz` goes red — rather than silently switching.

**The node URL is never logged, and neither is anything derived from it.** In this estate the RPC
credential is HTTP Basic userinfo in the endpoint URL. `src/rpc.ts` lifts it into a default header and
exposes host and port only; `src/rpc.test.ts` replays every failure path and asserts no message ever
contains it. Note also that `URL.origin` **discards** userinfo — a client built from the origin drops
the credential and the node answers 401, which reads exactly like a wrong password.

**The payout address is validated by the node, not parsed here.** `validateaddress` returns the
`scriptPubKey` and that is what goes into the coinbase. A pool that decodes bech32 itself and gets it
wrong pays every block it ever finds to an unspendable output.

**A node that answers wrong is fatal; a node that does not answer is not.** The wrong network or an
address the node calls invalid kills the process at boot, where somebody is watching. A node that is
simply not up yet is retried with the stratum port shut and `/readyz` red — otherwise ordinary restart
ordering becomes a crash loop.

**Litecoin asks for `mweb` as well as `segwit`, and MWEB is not optional.** Litecoin Core refuses
`getblocktemplate` outright — `error -8`, not a degraded template — unless both rules are named, at
every height, whether or not MWEB has activated. The template that comes back always carries an
integrating transaction (the HogEx) even with an empty mempool, and a top-level `mweb` blob. **Both
are load-bearing**: the extension block is read off the wire only when the final transaction is the
HogEx, so the HogEx has to stay last and the blob has to be appended behind a `0x01` marker, or the
node cannot deserialise the block at all. `src/mweb.ts` recognises it, `src/template.ts` refuses a
template where the two disagree, and `src/blocks.ts` refuses to submit a block whose HogEx has moved.
MWEB does **not** touch the coinbase: its commitment lives in the HogEx's witness-version-8 output and
`default_witness_commitment` is exactly what it is on Bitcoin. Bitcoin keeps asking for `['segwit']`
alone, and asking it for `mweb` would be asking for a rule it has never heard of. Measured against
litecoind 0.21.5.6 on 2026-08-09; see micro-org#277 and `scripts/regtest-mweb.sh`.

**The read API is public and there is no `@cloudsforge/auth` here.** The only identity a miner has is
the stratum username they chose; there is no estate account behind it. §6 makes a checkable share
history a product requirement, and gating it behind an estate login would exclude every miner who does
not have one, which is all of them.

**The pool fee has no default anywhere.** `POOL_FEE_BASIS_POINTS` is required and the service refuses
to start without it. §7.1 records that the fee has not been chosen; a default of 0 would be choosing
"free" and a default of 200 would be choosing "2%", in the file least likely to be read by whoever
eventually decides.

**The endpoint a miner dials is configuration, and reported as `null` until somebody sets it.** This
service cannot work out what to advertise and does not try. `POOL_STRATUM_BIND` is an *interface* —
`0.0.0.0` is not a name and cannot be dialled — the per-chain `POOL_<CHAIN>_STRATUM_PORT` is the
port the listener *binds*, which is the inside of whatever mapping the deploy wrote, and the
hostname on the request is the HTTP surface, which is a different protocol on a different port.

So there are two optional variables, both unset by default:

| Variable | What it is |
| --- | --- |
| `POOL_STRATUM_PUBLIC_HOST` | The hostname or address a miner types into their firmware. One per deployment. Refused at boot if it carries a scheme, a path, credentials or a port — each of those composes a connection string that looks complete and is not. |
| `POOL_<CHAIN>_STRATUM_PUBLIC_PORT` | The published TCP port for that chain. Per chain, because one name fronts one port per chain. **Not defaulted from the bound port.** |

`GET /v1/pool` reports them together as `stratumEndpoint: { host, port }` per chain, and **`null`
when either half is missing** — never the bind, never the request's `Host` header, never a
derivation. Half a pair is refused at boot rather than half-advertised: a host with no published
port advertises nothing, and a port with no host is not an endpoint.

Null is the ordinary answer and, on this estate today, the correct one — the stratum port is bound
to loopback and the hostname serving the console reaches it through a Cloudflare Tunnel and Traefik,
neither of which forwards a raw TCP stream. `micro-pool-web` renders the absence. The alternative
was measured and is worse: with a port and no host in this response, the console derived the host
from its own address and printed `stratum+tcp://pool.<apex>:3334`, which cannot connect and which
costs its reader a silent outage they will blame on their own hardware (micro-org#285).

The published port is separate from the bound one because deploys map them. The estate's compose
file publishes `${POOL_LTC_STRATUM_PORT:-3334}:3334` — the host side reads a variable, the container
side is a literal, and the service's environment does not set that variable at all — so on
2026-08-09 an operator who moves the published port changes a number this service never sees.

---

## The three rules this service is unusual about

Everything in [docs/ecosystem/03 §2](https://github.com/cloudsforge-online/micro-docs/blob/main/ecosystem/03-repository-responsibilities.md)
applies as normal. Three are worth pointing at:

- **Rule 4 (health).** `/livez` is static, `/readyz` is not — and readiness includes a **hard** probe
  per chain on template freshness. A replica whose miners are hashing against a template from before
  the last block looks completely healthy from outside and is worth nothing.
- **Rule 8 (no unleased timers).** There is no `setInterval` in this repository. The template poll and
  the share flush are self-rescheduling timeouts, so a slow one delays the next rather than stacking;
  pruning and stats are leased jobs; the gauges are sampled at scrape time.
- **Rule 9 (declare only what you read).** No `OUTBOX_SIGNING_SECRET`, no `IDENTITY_*`, no
  `@cloudsforge/secrets` and no `@cloudsforge/auth`. Nothing here publishes an event or verifies a
  token, and the first event this service must emit is the payout — which is not implemented.

---

## The one temporary thing

`@cloudsforge/contracts-chain` and the five runtime packages are consumed as `file:` paths because
they are not published yet. Three places carry that, and all three are marked:

- `package.json` — the `file:` specifiers, and `tsx` as a runtime dependency because the unpublished
  packages resolve to their TypeScript sources
- `Dockerfile` — the `runtimepkgs` and `contractspkgs` named build contexts
- `.github/workflows/ci.yml` — the sibling checkouts, via the shared workflow

When AD-02 lands, all three become registry versions — with `contracts-chain` on an **exact** pin, not
a caret, because wallet, settlement, custody, indexer and this service must agree byte for byte on
what a satoshi is. `tsx` moves to `devDependencies` and the image runs `node dist/index.js`. Nothing
else in this repository changes.

---

## Provenance

The code in this repository was written by **Claude Opus 5** under human direction and review.
