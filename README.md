# cloudsforge-pool

[![ci](https://github.com/cloudsforge-online/micro-pool/actions/workflows/ci.yml/badge.svg)](https://github.com/cloudsforge-online/micro-pool/actions/workflows/ci.yml) [![TypeScript](https://img.shields.io/badge/TypeScript-strict%20ESM-3178C6?logo=typescript&logoColor=white)](./tsconfig.base.json) [![node](https://img.shields.io/badge/node-%3E%3D22-5FA04E?logo=nodedotjs&logoColor=white)](./package.json) [![tests](https://img.shields.io/badge/tests-real%20Postgres-4169E1?logo=postgresql&logoColor=white)](./.github/workflows/ci.yml) [![licence](https://img.shields.io/badge/licence-MIT-blue)](./LICENSE)

A **Stratum v1 mining pool** for the Bitcoin-family chains this estate runs its own nodes for. It
builds block templates from those nodes, hands work to real mining hardware over raw TCP, judges the
shares that come back, submits the blocks, and records who is owed what. Where a chain is
merge-mined — Dogecoin under Litecoin — the same share is worth a block on both, and the AuxPoW
commitment that makes that true is built into every coinbase.

Implements §5 of
[docs/ecosystem/36-multi-chain-and-mining-pool.md](https://github.com/cloudsforge-online/micro-docs/blob/main/ecosystem/36-multi-chain-and-mining-pool.md).

---

## READ THIS FIRST: payouts are still switched off

**This service records a debt. It does not pay one.** When this pool finds a block it computes the
PPLNS allocation, writes the block row with the window bounds it was decided against, re-checks that
block until it has matured or been orphaned, and stops. Nothing moves a balance.

micro-org#302 changed what is *behind* that statement without changing the statement. The path is
now complete end to end: `src/maturity.ts` decides whether a reward exists, `src/rewards.ts` walks
the matured blocks and turns each one into per-worker claims through the existing PPLNS allocation
(the leased job `pool.credit-blocks`), and `src/payouts.ts` holds a real sink — `LedgerPayoutSink`,
which posts a double-entry credit to micro-ledger under the `credit_key` idempotency shape borrowed
verbatim from `wallet/src/deposits.ts`. `pool_payout_credits` exists in the schema, introduced by
the same migration as the code that writes to it. **Two independent gates stand in front of the
whole path, and both are shut:**

1. **The payout configuration is unset.** `POOL_<CHAIN>_MINIMUM_PAYOUT` has no default anywhere.
   With no minimum, no sink is constructed, neither payout job is registered, and `GET /v1/pool` reports
   `payoutsImplemented: false`. See `.env.example` for why this block is optional when the fee is
   required: `src/env.ts` is eager, and a newly required variable is a container that will not boot.
2. **`CUSTODY_BACKING_CLOSED` is `false`, in the source rather than in the environment.** The pool's
   coinbase pays into a custody-held address that **nothing registers with the indexer** and that
   `INDEXER_CUSTODY_LABEL_PREFIXES` (`"deposit:,treasury:"` on the estate) would not match if it
   did. A credit would therefore raise micro-ledger's custody total while the observed total did not
   move — positive drift, against a **zero** tolerance for LTC — and the reconciliation sweep would
   **freeze LTC withdrawals estate-wide** and keep re-freezing them, because only an exactly-clean
   run clears the freeze. That is micro-org#247/#248 with the sign reversed. The constant's comment
   in `src/payouts.ts` carries the full finding and the three things that must be true before it can
   be opened; two of the three are not in this repository's gift.

So there is still nothing here that will half-pay somebody, and turning payouts on is a code change
somebody reviews rather than an environment variable somebody sets.

The other named holes, in one place:

| Not implemented | What happens instead |
| --- | --- |
| Paying miners | The mechanism exists and is exercised by tests; two gates refuse every credit in this release: no payout configuration, and `CUSTODY_BACKING_CLOSED` is false. |
| Accrual across blocks | The minimum is a per-claim floor, not a running balance. A claim under it records nothing, so it stays payable later. |
| Paying external miners | A miner with a payout address and no estate account is counted `skipped_no_account` and paid nothing. This service credits a ledger; it does not send a transaction. |
| Reversing an orphaned credit | Nothing here reverses a credit. A block cannot reach `matured` and then `orphaned` through this service, and a correction is a new opposite ledger entry posted by a person — see the header of `src/rewards.ts`. |
| Dogecoin as a chain of its own | **Refused by name at boot**, and it always will be — `POOL_CHAINS=doge` asks for a listener that cannot exist. Dogecoin is mined here as an *auxiliary* chain of Litecoin: `POOL_LTC_AUX_CHAINS=doge`. See below. |
| Stratum v2 | Not implemented and not planned for this pass. v1 is what deployed hardware speaks. |
| TLS on the stratum port | Not implemented. Stratum v1 as deployed is plain TCP; the HTTP port is separate. |
| Solo mining / PPS | Not implemented. PPLNS only. |
| A miner-facing web UI | Not implemented. The read API is public JSON. |

---

## Dogecoin is merge-mined, and it is a chain of Litecoin rather than a chain of its own

**One share, two chains, no extra hashing.** A Dogecoin block has no nonce of its own: it is won by
finding a *Litecoin* header whose scrypt hash meets Dogecoin's target, where that Litecoin block's
coinbase carries a commitment naming the Dogecoin block being claimed. The commitment is what makes
the work non-transferable — the header's merkle root covers the coinbase, and the coinbase names one
specific Dogecoin block, so the same proof cannot be re-pointed at another one afterwards.

So `doge` is still refused in `POOL_CHAINS` and always will be. There is no `getblocktemplate` to
poll for it, no coinbase of ours to build, and no stratum port to serve it on; asking for one asks
for a listener that cannot exist. It is configured as an **auxiliary chain of a parent**:

```sh
POOL_LTC_AUX_CHAINS=doge
POOL_DOGE_NODE_URL=http://user:pass@dogecoind:22555/
POOL_DOGE_PAYOUT_ADDRESS=D…            # a Dogecoin address. dogecoind pays it; this pool never does
```

All three or none. Every half of this configuration produces a pool that mines Litecoin perfectly
and mines no Dogecoin at all, and the only symptom is an absence — which nobody notices for as long
as no aux block would have been won anyway. `src/env.ts` refuses each half at boot by name,
including the reverse case: a `POOL_DOGE_NODE_URL` set with no parent merging it is a dogecoind
running, reachable, configured and never called.

**The pairing is checked and is tighter than consensus.** `AUX_PARENT` in `src/chains.ts` allows
`doge` under `ltc` and nothing else. Dogecoin itself accepts a parent from any chain — its
`fStrictChainId` is false for the parent on mainnet — but merging `doge` into Bitcoin's SHA-256d
work is meaningless in practice and fails the way this repository fears most: no aux blocks, no
errors.

### What the miner sees, which is nothing

The stratum protocol does not change. Jobs, extranonces, difficulty and `mining.submit` are byte for
byte what they were; the commitment lives inside the coinbase, in the part a miner never inspects.
A share is judged against three targets instead of two — the share target, the Litecoin block target
and the Dogecoin block target — and a share can meet the third without meeting the second. That is
the ordinary case, in fact, and it is the entire point: Dogecoin's difficulty is far below
Litecoin's, so most merge-mined blocks are found by shares that were never Litecoin blocks.

### The three things that are silent when wrong

Everything in `src/auxpow.ts` was transcribed from Dogecoin 1.14.9's own `src/auxpow.cpp` at tag
`v1.14.9` on 2026-08-09, because every rule in it is a consensus rule whose violation is a rejected
block and nothing else — no warning, no log line on our side, and exactly one opportunity to observe
it. Three are worth naming here:

- **The 32 committed bytes are in DISPLAY order**, which is the reverse of every other 32 bytes in
  this repository. `CAuxPow::check` reverses a `uint256`'s internal iteration order before searching
  for it, which lands on exactly what `createauxblock` returned in its `hash` field. So the bytes go
  in as the RPC gave them, with no `hashFromDisplay` and no `.reverse()`.
- **The merged-mining magic `fa be 6d 6d` must occur exactly once in the whole scriptSig.** The
  scriptSig also carries the miner's extranonce, which this pool does not choose. A miner whose
  extranonce2 contains that pattern — or straddles it — produces a perfectly valid Litecoin block
  and a Dogecoin block consensus throws away. `validate.ts` calls that share `spoiled`: the parent
  share stands and is credited, the merged half is lost, and it is logged loudly. Refusing the share
  outright was considered and rejected — it deters no adversary, who loses nothing either way, and
  it costs an honest miner credit for real work roughly once every couple of years across a
  thousand rigs.
- **With one aux chain the merkle tree has height 0**, and at height 0 most of `CAuxPow::check`
  collapses: the "chain merkle root" in the commitment *is* the Dogecoin block hash unhashed, the
  branch is empty, `nSize` is 1, and the nonce is not searched because `rand % 1` is 0 for every
  value. `AUX_CHAIN_MERKLE_SIZE` stands in for the tree that does not exist yet, and `env.ts`
  refuses a second aux chain rather than configuring one that would be absent from every commitment
  this pool publishes.

### Where an aux block is submitted, and how it is paid

The aux block goes to **dogecoind, by `submitauxblock`, and to no other node.** `submitauxblock`
takes the aux block hash and the serialised AuxPoW and answers a **boolean** — not a reason string,
unlike `submitblock` — and it can only answer at all while dogecoind's own tip has not moved, since
the hash is a key into a map that node clears on every new block. The submission path holds that
window rather than assuming it.

Everything downstream then runs **on the block's own chain**, which is not the chain the shares are
on:

| | Parent chain (`ltc`) | Aux chain (`doge`) |
| --- | --- | --- |
| Shares, vardiff, pruning | yes | **no** — there are no `doge` shares; the shares are Litecoin's, and `pool_blocks.share_chain` records that |
| Coinbase maturity | 100 confirmations | **240** — `consensus.nCoinbaseMaturity` from `chainparams.cpp` v1.14.9, effective from height 145,000; the estate's node is far past it |
| Maturity re-check | against litecoind | **against dogecoind** — litecoind answers `-5` for a Dogecoin hash, which is not an answer about the block |
| Credits and payouts | `POOL_LTC_MINIMUM_PAYOUT` | `POOL_DOGE_MINIMUM_PAYOUT`, **independent of its parent's** — different asset, different unit, prices four orders of magnitude apart |
| Readable back over HTTP | `/v1/pool/blocks?chain=ltc` | `/v1/pool/blocks?chain=doge` — the aux chain is accepted **only on `/blocks`**, because that is the only one of the three routes whose table is keyed by the block's chain |

240 blocks at Dogecoin's one-minute target is four hours, which is by design about the same wall
time as Litecoin's 100 at two and a half minutes. Crediting a Dogecoin block at 100 would allocate
and pay out 140 blocks before the coinbase could be spent — a payout the pool cannot fund.

### Whether it is actually happening is a field, not a log line

Merged mining fails by **absence**. A dogecoind in initial block download refuses `createauxblock`;
the pool then mines Litecoin exactly as well as it did before and every number it reports is
identical to the merge-mining case. So `GET /v1/pool` carries `merged` per chain, with three states
and not two: `null` (nothing configured), `committed: false` with a one-word reason (`syncing`,
`no-peers`, `refused`, `unreachable`), or `committed: true`. A page that showed "mining DOGE" for
the middle state would be telling a miner they are earning an asset they are not.

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
curl -s 'localhost:4146/v1/pool' | jq                                       # chains, heights, difficulty, connections, fee
curl -s 'localhost:4146/v1/pool/blocks?chain=btc&limit=25' | jq            # blocks found, and the node's verdict on each
curl -s 'localhost:4146/v1/pool/workers?chain=btc&account=<address>' | jq  # this account's workers, over the last 600s
curl -s 'localhost:4146/v1/pool/shares?chain=btc&account=<address>' | jq   # this account's share history, share by share
```

**The account is a query parameter and there are no path parameters anywhere in this service** —
route matching is exact string equality on the pathname, so an address cannot appear in a path under
any spelling. `/v1/workers/<address>`, which this file used to name, is not a route and answers the
404 envelope (micro-org#284). `chain` may be omitted only while this pool serves exactly one chain.
Every body these return is written out under [Routes](#routes) below.

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

## Routes

Everything on this port, with the body each one answers — micro-org#287. Until this section existed
the only written description of this service's wire format lived in another repository, kept true by
a test that reads this repository's source as text and skips itself when the two are not checked out
side by side. A consumer had to read `src/server.ts` to find out what a field was called, which is
the same as having no contract.

Every route below is **public and unauthenticated** except `POST /v1/pool/ticket`, which is the only
route on this port that writes anything. Why the reads are open is argued in `src/server.ts` and
comes from §6 of the multi-chain document: a share history checkable only by people with an estate
login is checkable by almost no miner.

### What every response has

| | |
| --- | --- |
| `content-type` | `application/json; charset=utf-8` on everything but `/metrics`, which is `text/plain; version=0.0.4; charset=utf-8` |
| `content-length` | always set — no chunked replies, no streaming |
| `x-request-id` | the `x-request-id` you sent if it is 64 characters or fewer of `[A-Za-z0-9_-]`, otherwise one this service generated. It is on the response headers **and** inside every error body |
| `cache-control` | `no-store`, on all of them. Every answer here is a point-in-time fact, and a cached 200 from a replica that has since gone unready is exactly the lie it would be worst to tell |
| body | JSON object, one trailing newline |

**Anything that is not a 200 is this and only this:**

```json
{ "error": { "code": "bad_request", "message": "limit must be a positive whole number", "requestId": "…" } }
```

`code` is a stable token to branch on; `message` is prose for a human and may change. The codes are
`bad_request` (400), `unauthenticated` (401), `forbidden` (403), `not_found` (404),
`browser_mining_unavailable` (503), `identity_unavailable` (503) and `internal` (500).

### Query parameters

| Parameter | Where | Rules |
| --- | --- | --- |
| `chain` | `/blocks`, `/workers`, `/shares` | Lower-cased and trimmed. **Optional only when this pool serves exactly one chain**, in which case it defaults to that one; required otherwise. A chain this deployment does not serve is 400 and the message names the ones it does. **The accepted set is not the same on all three** — see below. |
| `account` | `/workers`, `/shares` | Required. Trimmed. Up to 96 characters of `[A-Za-z0-9_:-]`. Anything else is 400 — the character set is the one this pool would have been willing to store, so a value it rejects here is a value it can never have recorded a share against. |
| `limit` | `/blocks`, `/shares` | A positive whole number. Absent or empty means the default. |

#### `/blocks` takes a wider set of chains than `/shares` and `/workers`

A merge-mined chain is a chain this pool can win a **block** on and cannot record a **share** on, so
the two sets differ by exactly the aux chains configured:

| Route | Accepted `chain` values | Default when absent |
| --- | --- | --- |
| `GET /v1/pool/blocks` | `POOL_CHAINS`, **plus every aux chain in `POOL_<PARENT>_AUX_CHAINS`** | the single share chain, never an aux one |
| `GET /v1/pool/shares`, `GET /v1/pool/workers` | `POOL_CHAINS` only | the single share chain |

`GET /v1/pool/blocks?chain=doge` answers with the Dogecoin blocks this pool won by merged mining,
denominated in DOGE — `asset` and `decimals` are the **aux** chain's and not the parent's. Asking
`/shares` or `/workers` for `doge` is a **400 rather than an empty list**, and the refusal is the
honest answer: the Litecoin work is what produced the Dogecoin block, so a miner's DOGE share
history *is* their LTC share history. An empty list would tell them their merged work was not
recorded.

Both refusals name the set they checked against, in different words on purpose — `it serves ltc`
from the share routes and `it mines ltc` from `/blocks` — so the message says which question was
asked. A deployment with no aux chain configured refuses `doge` on all three, exactly as before.

**`limit` is CLAMPED, not refused, and nothing in the response says so.** Ask `/blocks` for 5,000
and you get 200 with 200 rows, not a 400. The ceiling is what keeps an unauthenticated endpoint from
being a way to ask the database for every share ever recorded, and returning the ceiling is what the
caller wanted anyway — but it means **a full page is not evidence that there are no more rows**, and
a client that pages by asking for more must not conclude anything from getting fewer than it asked
for. Zero, a negative number, a fraction and a non-number are all 400.

| Route | `limit` default | `limit` ceiling |
| --- | --- | --- |
| `GET /v1/pool/blocks` | 50 | 200 |
| `GET /v1/pool/shares` | 100 | 1000 |

### Two fields are strings that look like numbers, on purpose

`reward` on a block and `id` on a share are **strings**, and a consumer that runs them through
`Number()` is writing a bug that will not show up for years.

- `reward` is money, in the chain's smallest unit, and JSON has no integer wide enough for one.
  `Number.MAX_SAFE_INTEGER` is about 9.007 × 10^15; a block reward in litoshi is comfortably inside
  that today and the point is that nothing about the format promises it stays there. Estate
  convention, from `contracts-chain`: **amounts cross a wire as text.** Divide by `10 ** decimals`,
  which the same response gives you, and do it in a decimal library rather than a float.
- `id` is a `bigserial`. Same reason, one table over.

Everything else numeric is a genuine JSON number: heights, difficulties, hashrate estimates, counts.

### `GET /livez`

Static. 200, always, while the process is alive. It never consults the database, the node or
anything else — for this service a restart drops every miner's TCP connection and loses whatever
shares are still buffered, so a liveness probe that fails on a database blink is expensive.

```json
{ "ok": true, "state": "ready", "uptimeMs": 812345 }
```

`state` is one of `starting`, `ready`, `degraded`, `draining`, `stopped`.

### `GET /readyz`

**200 when ready, 503 when not**, with the same body either way. Readiness includes a hard probe per
chain on template freshness: a replica whose miners are hashing against a template from before the
last block looks perfect from outside and is worth nothing.

```json
{
  "ready": true,
  "state": "ready",
  "uptimeMs": 812345,
  "checks": [{ "name": "ltc-template", "kind": "hard", "state": "pass", "detail": "…" }]
}
```

Each check's `state` is `pass`, `warn` or `fail`; `detail` is prose for an operator and is **absent**
rather than null when there is nothing to add. A `hard` check that fails makes the whole report
unready; a `soft` one degrades it and keeps the service serving.

### `GET /metrics`

Prometheus text exposition, `text/plain; version=0.0.4`. Not JSON. Sampled gauges — connection
counts, template age — are refreshed as the scrape is served rather than on a timer, because a timer
here would be the one `setInterval` in this repository.

### `GET /v1/pool`

What this pool is and what it is doing. No parameters. Every configured chain, always, whether or
not it is ready.

```json
{
  "network": "mainnet",
  "feeBasisPoints": 100,
  "pplnsWindowMultiplier": 2,
  "payoutsImplemented": false,
  "chains": [
    {
      "chain": "ltc",
      "name": "Litecoin",
      "asset": "LTC",
      "decimals": 8,
      "algorithm": "scrypt",
      "stratumPort": 3334,
      "stratumEndpoint": null,
      "websocketEndpoint": null,
      "connections": 0,
      "height": 2985113,
      "networkDifficulty": 41234567.89,
      "templateAgeSeconds": 4.2,
      "ready": true,
      "windowSeconds": 600,
      "sharesInWindow": 0,
      "workersInWindow": 0,
      "hashrateEstimate": 0,
      "merged": {
        "chain": "doge",
        "name": "Dogecoin",
        "asset": "DOGE",
        "committed": true,
        "unavailability": null,
        "height": 5015467,
        "networkDifficulty": 12345678.5
      }
    }
  ]
}
```

| Field | Null when | What the null means |
| --- | --- | --- |
| `stratumEndpoint` | either `POOL_STRATUM_PUBLIC_HOST` or this chain's `POOL_<CHAIN>_STRATUM_PUBLIC_PORT` is unset | **No endpoint has been published; ask an operator.** It is never the bind address, never the request's `Host`, never a derivation. Null is the ordinary answer on this estate — see the section above on why, and on the page that once derived one and printed an address that cannot connect |
| `websocketEndpoint` | `POOL_WEBSOCKET_PUBLIC_ORIGIN` is unset, or this deployment serves no browsers | The same answer for the browser transport. One complete `wss://…` URL or nothing; there is no half of it to assemble |
| `height` | this chain has never obtained a template | The node has not answered yet. Distinct from height 0, which no live chain is at |
| `networkDifficulty` | as above | |
| `templateAgeSeconds` | as above | Not "the template is fresh" — there is no template |
| `merged` | this chain merges nothing (`POOL_<CHAIN>_AUX_CHAINS` unset) | **This pool does not merge-mine.** Distinct from an object with `committed: false`, which means it is configured to and currently is not — a consumer branches on the null to decide whether to render the section at all |

`ready` is per chain and is the same hard probe `/readyz` aggregates. `stratumPort` is the port the
listener **binds**: a true fact about this process, the inside of whatever port mapping the deploy
wrote, and not half of a connection string. `connections` counts both transports.

`hashrateEstimate` is hashes per second implied by the difficulty credited over `windowSeconds`, and
it is computed with **that chain's own** difficulty-1 constant — 2^32 hashes per unit of difficulty
on SHA-256d, 2^16 on scrypt. A single formula would report every Litecoin miner as 65,536 times
faster than they are, and it would be believed, because the number carries no unit that would look
wrong. `sharesInWindow` and `workersInWindow` come from the same window. All three are 0 for a chain
nobody is mining, which is not the same as absent.

`merged` is the merge-mined chain under this one, and **`committed` is the field that matters**: it
says whether the work being handed out *right now* commits to an aux block, which is the one fact
distinguishing "we are merge-mining Dogecoin" from "we intended to". It is read off the job registry
rather than off the template source, so it describes the jobs miners are holding. `unavailability`
is why not, in one word — `syncing`, `no-peers`, `refused`, `unreachable` — and is reported even
when a block is present, because a stale block beside a node that has since started refusing is a
state worth seeing. `networkDifficulty` inside `merged` is the aux chain's own difficulty computed
on the **parent's** algorithm, which is the only unit it is meaningful in; beside the parent's it is
roughly how much rarer an aux block is for the same hashing. There is deliberately no second
`hashrateEstimate` in there: it would be the same shares and the same units as the one above it.

`payoutsImplemented` is `false` and is in the body rather than only in this file, so that a page
built against this API cannot accidentally imply a payment that will not arrive. **It appears here
and on `/v1/pool/blocks`, and nowhere else** — in particular it is not part of the ticket reply.

### `GET /v1/pool/blocks?chain=<chain>&limit=<n>`

Blocks this pool found, newest first. `limit` defaults to 50 and is clamped at 200. `chain` may be
an aux chain — `?chain=doge` on a pool that merge-mines it — in which case every field below is the
Dogecoin block's, including `asset` and `decimals`.

```json
{
  "chain": "ltc",
  "asset": "LTC",
  "decimals": 8,
  "payoutsImplemented": false,
  "blocks": [
    {
      "height": 2985101,
      "hash": "b1946ac9…",
      "foundAt": "2026-08-09T11:02:41.318Z",
      "reward": "625000000",
      "networkDifficulty": 41234567.89,
      "submitStatus": "accepted",
      "submitDetail": null,
      "maturityStatus": "pending",
      "confirmations": 37
    }
  ]
}
```

`foundAt` is ISO 8601 with milliseconds, UTC, from `Date#toISOString`. Same for every timestamp
below.

`submitStatus` is `accepted` or `rejected` — **the node's verdict at the moment of submission**, and
a rejected block is published rather than hidden, because it is the single most useful diagnostic
this service has and a pool that showed only its accepted blocks would be concealing the one failure
miners must know about. `submitDetail` is the node's own words, and is **null when there is nothing
to say** — an accepted block, ordinarily.

`maturityStatus` is the **second, later verdict, and it is the one that says whether the reward
exists.** `submitStatus: "accepted"` only ever meant the node took the block onto its tip; a coinbase
is unspendable for 100 blocks on BTC and LTC — **240 on Dogecoin** — and a block can be orphaned
well inside that window. So a leased job (`pool.check-maturity`, every ten minutes) re-reads each
recorded block by hash against the node **for that block's own chain**, and moves the row to one of
three states:

| `maturityStatus` | Meaning |
| --- | --- |
| `pending` | On the chain but not deep enough yet — **or** the node could not be asked. Not payable. |
| `matured` | On the active chain at the full maturity depth or more. The only payable state. |
| `orphaned` | The node holds this block and it is not on the active chain. Terminal. |

The depth is per chain and is `COINBASE_MATURITY` in `src/maturity.ts`, which carries the
`chainparams.cpp` provenance for each number. A merge-mined block is asked about on its own chain
and nowhere else: litecoind answers `-5` for a Dogecoin hash, which this service reads as "not the
node that took the submission" rather than as an answer about the block.

Every block starts `pending` and only a positive answer from the node moves it, so an unreachable
node delays a payment rather than inventing or destroying one. `confirmations` is the node's own
count — **negative** for a block off the active chain, and `null` before the watcher has managed to
ask. `submitStatus` is never rewritten: the two facts sit beside each other, because the submission
verdict is the only thing separating "the coinbase was built wrongly" from "we lost a race".

An orphan is logged at `error` and counted in `pool_block_maturity_total{status="orphaned"}`.

`matured` is also the only state the allocation job will touch: `pool.credit-blocks` (every ten
minutes, per chain, and **only for a chain with a payout minimum configured**) reads matured,
accepted, not-yet-allocated blocks, re-summs the PPLNS window each one recorded when it was found,
takes the fee, and offers every worker's share to the sink under `poolPayoutCreditKey`. Outcomes are
counted in `pool_payout_claim_total{outcome=…}`, where the skips are the interesting values —
`skipped_no_account` is every miner who has an address here and no estate account. In this release
the sink refuses all of them at the first claim and the sweep stops, loudly, having written nothing.

### `GET /v1/pool/workers?chain=<chain>&account=<account>`

Every worker seen under one account, with its recent contribution. No `limit`: the list is bounded
by how many workers an account has, and an account with an unreasonable number of them has a problem
a page size would hide.

```json
{
  "chain": "ltc",
  "account": "ltc1qexampleaddress",
  "windowSeconds": 600,
  "workers": [
    {
      "worker": "rig1",
      "lastSeenAt": "2026-08-09T11:14:02.004Z",
      "difficulty": 512,
      "sharesInWindow": 37,
      "hashrateEstimate": 4093.2
    }
  ]
}
```

`difficulty` is the difficulty this worker was last **issued**, and it is **null when the pool has
never set one for it** — a worker row created by an authorisation that never received a job, or one
predating any vardiff decision. Null is not zero: zero would say the pool set a difficulty of zero,
which it cannot do. `sharesInWindow` and `hashrateEstimate` cover `windowSeconds` and are 0 for a
worker that has been idle throughout, which *is* different from `difficulty` being null.

**`worker` is the empty string for a miner that authorised with a bare address and no dot**, which
is an ordinary configuration and not a fault: `bc1qexample` is one worker named "", `bc1qexample.rig1`
is one named `rig1`. Consumers render `""` as a blank cell and their operators read it as a bug, so
show something — "(unnamed)" — rather than nothing. It is never null; the field is always present
and always a string.

### `GET /v1/pool/shares?chain=<chain>&account=<account>&limit=<n>`

One account's share history, share by share, newest first. `limit` defaults to 100 and is clamped at
1000.

This is the route §6 exists for. It returns the job each share was against, the difficulty it was
**credited** at and the difficulty it actually **achieved**, which is exactly what a miner's own log
records — so the two reconcile line for line. A count would be checkable against nothing.

```json
{
  "chain": "ltc",
  "account": "ltc1qexampleaddress",
  "shares": [
    {
      "id": "48291",
      "worker": "rig1",
      "jobId": "1f",
      "height": 2985113,
      "creditedDifficulty": 512,
      "achievedDifficulty": 1043.77,
      "isBlock": false,
      "createdAt": "2026-08-09T11:14:02.004Z"
    }
  ]
}
```

`creditedDifficulty` is what the share is worth for PPLNS; `achievedDifficulty` is what the header
actually hashed to and is always at least the credited value. `isBlock` is true for a share that was
also a block — it stays a share, and both rows exist, because losing the share accounting for the
most valuable submission a pool will ever receive is not an acceptable trade for tidiness. No field
here is nullable.

### `POST /v1/pool/ticket`

The one authenticated route and the one route that writes. Sixty seconds, one connection, one use.

```
POST /v1/pool/ticket
Authorization: Bearer <estate access token>

200 { "ticket": "<opaque>", "account": "cf-…", "worker": "web-…", "expiresInMs": 60000 }
```

No request body is read; sending one is harmless and ignored. The chain is not named here, because a
ticket is worth one authorisation on one connection and which chain that connection is for is
already in the WebSocket path — naming it twice would create a pair that can disagree.

**`expiresInMs`, not `expiresAt`, and this is the corrected contract.** An earlier written
description of this route specified `expiresAt` plus `ttlSeconds` plus `payoutsImplemented`. The
service has never sent any of those and it is the service that is right: elapsed milliseconds is the
one clock a browser and this process reliably share, and an absolute timestamp compared against a
laptop forty seconds out produces a ticket that looks expired the instant it arrives.
`payoutsImplemented` belongs on `GET /v1/pool`, where it is. A client has already shipped against
`expiresInMs`; the document was wrong, not the code.

| Status | Meaning |
| --- | --- |
| 200 | Minted. `ticket` appears here and nowhere else — it is never logged, never counted by value, and never stored beyond the in-memory ticket table |
| 401 `unauthenticated` | No bearer token, or one identity did not accept. The reason is deliberately not echoed: a verification failure names key ids, issuers and clock skews, and repeating that to an unauthenticated caller builds a token oracle |
| 403 `forbidden` | A **service** principal. A mining ticket belongs to a person; there is no user id to credit work to. 403 rather than 401 because the credential was perfectly good and a better one will not help |
| 503 `identity_unavailable` | Identity could not be reached. Explicitly not 401 — answering 401 because the identity service is having a bad minute signs every user in the estate out of the miner |
| 503 `browser_mining_unavailable` | This deployment has no `IDENTITY_JWKS_URL`. It is a TCP-only pool, which is a complete and supported configuration |

`account` and `worker` are the **server's** labels, generated here, and are what the work will be
credited to. Neither is anything the client asked for. See the browser-mining section below.

### `mining.subscribe` is MANDATORY, and skipping it fails silently

Not a route, but it belongs with the contract, because it is the failure that costs the most time to
diagnose.

A connection that sends `mining.authorize` without having sent `mining.subscribe` **is answered
`true`**, is sent a `mining.set_difficulty`, and is then **sent no work at all, ever**. Not an error,
not a close — silence, on a healthy socket, indefinitely. If it eventually submits something it is
refused with error **25 (`NOT_SUBSCRIBED`)**, which is the first and only hint it gets, and a client
that never submits because it was never given a job never sees even that.

So: **subscribe, then authorize, then wait for `mining.notify`.**

```
{"id":1,"method":"mining.subscribe","params":["your-client/1.0"]}
{"id":2,"method":"mining.authorize","params":["<address-or-empty>","<password-or-ticket>"]}
```

The other order — authorize first, then subscribe — does work: the authorisation succeeds and the
next template broadcast reaches the connection normally. That is why this is documented rather than
refused. Rejecting an `authorize` that arrives before a `subscribe` would break clients that are
behaving legitimately, so the honest fix is a warning rather than a refusal, and `session.ts` has no
logger to warn through today. It is called out here so that nobody has to find it from a browser.

Everything a job depends on is withheld until both have happened: no `mining.notify`, no usable
extranonce and no difficulty band. An unauthenticated WebSocket upgrade therefore gets you a socket
and nothing else, and the handshake timeout closes it.

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
| `src/auxtemplate.ts` | `createauxblock` against the aux chain's node: the block being claimed, and why it is unavailable when it is. |
| `src/auxpow.ts` | The 44 bytes that go in the coinbase and the AuxPoW proof handed back, transcribed from Dogecoin 1.14.9. |
| `src/work.ts` | A template becomes a job: the `mining.notify` parameters and the job history a submit can still name. |
| `src/stratum.ts` | The TCP listener and the line framing. Timeouts, back-pressure, the share buffer. |
| `src/session.ts` | The Stratum v1 state machine: subscribe, authorize, configure, notify, submit. No socket in it. |
| `src/wsframe.ts` | RFC 6455 server framing, hand-rolled. Masking, the three length forms, continuation, ping/pong, the caps. |
| `src/wsstratum.ts` | The WebSocket transport: the `upgrade` handler on the HTTP port, and why the keepalive is application-level. |
| `src/tickets.ts` | Mining tickets and the opaque pool account an estate user's browser work is credited to. |
| `src/vardiff.ts` | Per-connection difficulty retargeting toward a steady share rate. |
| `src/validate.ts` | Rebuilding the header from a submission and judging it against the share target and the block target. |
| `src/blocks.ts` | What happens when a share is a block, in the order it has to happen in. |
| `src/pplns.ts` | The sliding window, and the integer allocation that makes the parts sum to the whole. |
| `src/maturity.ts` | Re-reading a found block against its own chain's node: still on the chain, and deep enough? The per-chain depths, with their provenance. |
| `src/rewards.ts` | The walk from a matured block to per-worker claims: the window it was found against, the fee, and the remainder. |
| `src/payouts.ts` | The credit key, the sink that posts it, and the two gates that refuse it — see the top of this file. |
| `src/ledgerclient.ts` | One route of micro-ledger's API: `POST /entries`. Amounts are strings on the wire in both directions. |
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

**The read API is public.** The only identity a miner has is the stratum username they chose; there
is no estate account behind it. §6 makes a checkable share history a product requirement, and gating
it behind an estate login would exclude every miner who does not have one, which is nearly all of
them. `@cloudsforge/auth` arrived with browser mining and verifies a token on **exactly one route** —
`POST /v1/pool/ticket`. Every route that answers a question about work already done is untouched.

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

## Browser mining (micro-org#289)

A tab can mine. The same protocol, the same jobs, the same validation and the same share table — the
only thing that differs is the pipe the lines travel down and the difficulty band they travel at.

It is **off by default**. Unset `IDENTITY_JWKS_URL` and this is a pool that serves mining hardware
over raw TCP and nothing else, which is a complete and tested configuration; a pool run by somebody
with no estate at all has to start.

**Raw TCP is unchanged by any of it.** A miner on the stratum port authorises with a free-text
username, has no account and no authentication, and gets the hardware difficulty band, exactly as
before. Everything below is reachable only through the WebSocket transport.

### The wire

| | |
| --- | --- |
| Endpoint | `wss://<origin>/v1/pool/stratum/<chain>` — one complete URL, reported as `websocketEndpoint` per chain on `GET /v1/pool`, `null` when unpublished |
| Subprotocol | none — none is sent and none is negotiated |
| Frames | text only; one WebSocket message is one newline-terminated Stratum line, and a binary frame closes the connection |
| Keepalive | server pings every 20 s, declares a connection dead after 70 s of silence |

```
POST /v1/pool/ticket
Authorization: Bearer <estate access token>

200 { "ticket": "<opaque>", "account": "cf-…", "worker": "web-…", "expiresInMs": 60000 }
```

Then open the WebSocket and spend the ticket as the **password**:

```
{"id":1,"method":"mining.subscribe","params":["cloudsforge-web/1.0"]}
{"id":2,"method":"mining.authorize","params":["","<ticket>"]}
```

The username is ignored on this transport and the label the work is credited to is the server's
answer, never the client's claim.

### Why it is shaped like that

**The ticket exists because the browser `WebSocket` constructor cannot set headers.** `new
WebSocket(url, protocols)` takes a URL and a subprotocol list and nothing else, so an estate access
token could only reach this service in the query string or smuggled through
`Sec-WebSocket-Protocol` — and a URL is written to every access log between the tab and here, while
the estate's token is good against every service in the estate for ten minutes. So the token is
presented once over ordinary HTTP, and what comes back is worth exactly one authorisation, on one
connection, for sixty seconds, once. It is spent in the `mining.authorize` password field because
that is the one string in this protocol that has never been read, stored or logged.

**The account label is opaque and generated, not the estate user id.** `GET /v1/pool/shares?account=`
is public, so an account label is a public identifier; crediting browser work to a user id would
make mining in a tab cost you a stable estate identifier anybody can enumerate work against. A new
table maps user id → `cf-<16 hex>`, created on the first ticket and stable after. The worker label is
per ticket, `web-<6 hex>`, so two tabs are two rows rather than one row with the sum of two machines.

**The link is a new table, and `pool_workers` still has no join to an estate user.** That property is
stated in `src/migrations.ts` and is deliberate: mining hardware has no estate account and the share
table must not imply one. Migration 3 is additive and opt-in, and nothing about the existing tables
changed.

**The difficulty band is per transport.** Pure-JS scrypt(1024,1,1) does a few hundred hashes per
second per core; at Litecoin's hardware start of 512 one share is on the order of 37 hours. A browser
that cannot produce a single share is indistinguishable from a broken miner — it produces *no
evidence of work at all* — so the WebSocket transport starts around 1,024 hashes per share and its
vardiff floor is 256, while the TCP transport keeps the band silicon needs. See `src/vardiff.ts`.

**The keepalive is application-level because nothing below can do it.** Traefik has no per-router idle
timeout — `respondingTimeouts` is static on an entrypoint — Go's `net/http` clears both deadlines the
moment a connection is hijacked, and Cloudflare's edge closes an idle WebSocket at roughly a hundred
seconds and is not configurable on the plan this estate runs. So the ping interval is chosen against
that hundred seconds, and death is declared after **three** missed pings rather than one, so a laptop
waking from sleep does not lose a miner mid-share. Same numbers, same reasoning, as Hearth's
`HEARTH_P2P_WS`.

**The upgrade itself is unauthenticated**, and it gets you nothing: `session.ts` hands out no job, no
difficulty and no usable extranonce until `mining.authorize` succeeds, and a connection that does not
authorise is closed by the handshake timeout.

**Tickets live in memory, and that assumes one replica.** A ticket minted by replica A is unknown to
replica B. The pool is single-replica for reasons that predate this — a connection-oriented listener
with per-connection extranonce state does not fan out behind a load balancer — so the constraint is
not new, but it is stated rather than discovered. `src/tickets.ts` records why a database table and a
signed stateless ticket were both rejected.

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
- **Rule 9 (declare only what you read).** No `OUTBOX_SIGNING_SECRET` and no `@cloudsforge/secrets`.
  Nothing here publishes an event or signs anything, and the first event this service must emit is
  the payout — which is not implemented. The mining ticket is a random opaque value matched by
  equality, not a MAC, so it needs no key either. `IDENTITY_JWKS_URL`, `IDENTITY_ISSUER` and
  `POOL_WEBSOCKET_PUBLIC_ORIGIN` are declared because they are read; all three are optional and
  unset is a supported, tested mode.

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
