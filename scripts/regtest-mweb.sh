#!/usr/bin/env bash
#
# Mine a real Litecoin block through this pool and have a real litecoind accept it.
#
# This is the reproduction behind micro-org#277 and the acceptance test in its PR. It starts a
# litecoind on regtest in Docker, mines it past MWEB activation, and runs `src/regtest.test.ts`
# against it — which drives this repository's own template fetch, coinbase assembly, merkle fold and
# block serialisation and then calls `submitblock`.
#
# ## Why this is a script and not a CI job
#
# Two reasons, and the first is the estate's rule rather than a limitation of the test. Every service
# calls the ONE reusable workflow in micro-org; `.github/workflows/ci.yml` says in as many words that
# a repository needing a job of its own is a signal the reusable workflow needs an input. That
# workflow gives a service a Postgres and nothing else, and a chain node is a different shape of
# dependency: 35 MB of binaries, a datadir, an activation ceremony, and a chain-specific one at that.
#
# The second is that this test's value is in being run against a node, and a node in CI would be a
# node in CI's network namespace on CI's architecture — which is a different node from the one the
# estate runs, so a green CI job would be weaker evidence than it looks. `src/regtest.test.ts` skips
# without POOL_REGTEST_NODE_URL, and skipping is honest: the shape of the bytes is held between runs
# of this by `blocks.test.ts` and `mweb.test.ts`, and this is what says the shape was ever right.
#
# ## What MWEB needs on regtest that mainnet does not
#
# MWEB is a BIP9 deployment on regtest with a start time of 2020-09-30 and a 432-block activation
# window, so it activates by itself once the chain is 432 blocks long with a median time past that
# date — which every freshly generated regtest chain has, because generated blocks are stamped with
# the current clock.
#
# The awkward part is the block MWEB activates in. The integrating transaction's inputs are the
# previous block's integrating transaction plus every peg-in in this block, and in the FIRST MWEB
# block there is no previous one — so with an empty mempool it would have no inputs at all, which
# `CheckTransaction` rejects as `bad-txns-vin-empty`. litecoind's own miner hits this and refuses to
# build the block; Litecoin's `test/functional/mweb_mining.py` steps around it by sending to an MWEB
# address before mining that block, and so does this script. It is not a bug in anything, and it is
# not something a pool ever has to handle: it happens once per chain, at activation, and Litecoin
# mainnet passed it at block 2,265,984 in 2022.
#
# Usage:
#   scripts/regtest-mweb.sh              start the node, mine a block through the pool, tear down
#   KEEP=1 scripts/regtest-mweb.sh       leave the node running afterwards, and print how to reach it
#
# Requires Docker. Nothing here touches any node the estate runs.

set -euo pipefail

VERSION="${LITECOIN_VERSION:-0.21.5.6}"
CONTAINER="${CONTAINER:-cloudsforge-pool-regtest}"
IMAGE="cloudsforge/litecoind-regtest:${VERSION}"
PORT="${PORT:-19443}"
RPC_USER="pooltest"
# A regtest node with no wallet worth anything and no port reachable off this host. Written in the
# clear on purpose: a placeholder that looks like a secret is how a string gets copied somewhere it
# matters, and this one has to be in two places at once.
RPC_PASSWORD="pooltest"
WORK="${TMPDIR:-/tmp}/cloudsforge-pool-regtest"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cli() { docker exec "$CONTAINER" litecoin-cli -regtest "-rpcuser=$RPC_USER" "-rpcpassword=$RPC_PASSWORD" "-rpcport=$PORT" "$@"; }

cleanup() {
  if [ "${KEEP:-0}" = "1" ]; then
    echo "regtest: leaving $CONTAINER running. RPC: http://$RPC_USER:$RPC_PASSWORD@127.0.0.1:$PORT/"
    return
  fi
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# ── the image ────────────────────────────────────────────────────────────────────────────────────
# Built from the release tarball rather than pulled, because there is no official Litecoin image and
# an unofficial one is a third party in the trust path of a consensus test. The arch is the host's:
# Litecoin publishes x86_64 and aarch64 Linux builds and Docker runs whichever matches.
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  case "$(docker version --format '{{.Server.Arch}}')" in
    arm64|aarch64) arch=aarch64 ;;
    *) arch=x86_64 ;;
  esac
  tarball="litecoin-${VERSION}-${arch}-linux-gnu.tar.gz"
  mkdir -p "$WORK"
  if [ ! -f "$WORK/$tarball" ]; then
    echo "regtest: downloading $tarball"
    curl -fsSL -o "$WORK/$tarball" "https://download.litecoin.org/litecoin-${VERSION}/linux/${tarball}"
  fi
  tar xzf "$WORK/$tarball" -C "$WORK" "litecoin-${VERSION}/bin/litecoind" "litecoin-${VERSION}/bin/litecoin-cli"
  cat >"$WORK/Dockerfile" <<EOF
FROM ubuntu:22.04
COPY litecoin-${VERSION}/bin/litecoind /usr/local/bin/litecoind
COPY litecoin-${VERSION}/bin/litecoin-cli /usr/local/bin/litecoin-cli
EOF
  echo "regtest: building $IMAGE"
  docker build -q -t "$IMAGE" "$WORK" >/dev/null
fi

# ── the node ─────────────────────────────────────────────────────────────────────────────────────
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
echo "regtest: starting litecoind $VERSION"
docker run -d --name "$CONTAINER" -p "127.0.0.1:$PORT:$PORT" "$IMAGE" \
  litecoind -regtest -server -listen=0 -printtoconsole \
  "-rpcuser=$RPC_USER" "-rpcpassword=$RPC_PASSWORD" \
  -rpcbind=0.0.0.0 -rpcallowip=0.0.0.0/0 "-rpcport=$PORT" -fallbackfee=0.0002 >/dev/null

for _ in $(seq 1 60); do
  if cli getblockchaininfo >/dev/null 2>&1; then break; fi
  sleep 1
done
cli getblockchaininfo >/dev/null

# ── past MWEB activation ─────────────────────────────────────────────────────────────────────────
cli createwallet pool >/dev/null
ADDR="$(cli getnewaddress)"

echo "regtest: reproducing micro-org#277 before MWEB has even activated"
# Worth seeing on its way past: the -8 is not conditional on MWEB being active. A node at height 0,
# with the deployment still `defined` and no extension block possible, refuses the call all the same.
cli getblocktemplate '{"rules":["segwit"]}' 2>&1 | sed -n 's/^error message://p;/rule sets/p' || true

echo "regtest: mining to MWEB activation"
cli generatetoaddress 431 "$ADDR" >/dev/null
# The peg-in the activation block's integrating transaction needs an input from. See the note above.
cli sendtoaddress "$(cli getnewaddress '' mweb)" 1 >/dev/null
cli generatetoaddress 1 "$ADDR" >/dev/null

# Checked by asking for a template rather than by reading the deployment's BIP9 state, because the
# template is the thing under test: a node that reports `mweb` active but hands out a template with
# no extension block would sail past a softfork check and fail the test for a reason nobody could
# read off the output.
if ! cli getblocktemplate '{"rules":["mweb","segwit"]}' | grep -q '"mweb"'; then
  echo "regtest: MWEB did not activate; refusing to run a test that would prove nothing" >&2
  cli getblockchaininfo >&2
  exit 1
fi
echo "regtest: MWEB active at height $(cli getblockcount)"

# A few ordinary transactions, so the block the pool builds has a merkle tree with more than one
# leaf in it. An empty-mempool block would exercise the extension block but not the interaction
# between the transaction order and the integrating transaction's position, which is the half of
# this that a `blocksonly` node — see micro-org#268 — can never show you.
for amount in 0.11 0.12 0.13; do cli sendtoaddress "$(cli getnewaddress)" "$amount" >/dev/null; done

# **litecoind caches a template for five seconds**, and will hand back the one it built a moment ago
# on an unchanged tip however much the mempool has moved. Without this wait the pool mines a block
# with a coinbase and an integrating transaction and nothing else — which passes, and proves half of
# what this script is for. Polled rather than slept on so that the condition is stated rather than
# assumed from a number.
echo "regtest: waiting for a template that carries the mempool"
for _ in $(seq 1 30); do
  if [ "$(cli getblocktemplate '{"rules":["mweb","segwit"]}' | grep -c '"txid"')" -ge 4 ]; then break; fi
  sleep 1
done

# ── the pool ─────────────────────────────────────────────────────────────────────────────────────
echo "regtest: mining a block through the pool"
cd "$here"
POOL_REGTEST_NODE_URL="http://$RPC_USER:$RPC_PASSWORD@127.0.0.1:$PORT/" \
POOL_REGTEST_PAYOUT_ADDRESS="$(cli getnewaddress)" \
  node --import tsx --test src/regtest.test.ts
