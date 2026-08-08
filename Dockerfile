# syntax=docker/dockerfile:1.7
#
# Build context is this repository, plus two named contexts for the unpublished first-party
# packages:
#
#   docker build -t cloudsforge-pool \
#     --build-context runtimepkgs=../runtime \
#     --build-context contractspkgs=../contracts .
#
# Both are temporary. Once the runtime and contract packages are published (AD-02), package.json
# takes registry versions — a caret range for the runtime packages and an EXACT pin for
# @cloudsforge/contracts-chain — the COPY lines marked below are deleted, the flags go away, and
# this becomes an ordinary single-context build. Nothing else in this repository changes.
#
# They are named `runtimepkgs` and `contractspkgs` rather than `runtime` and `contracts` because a
# build context and a build stage share one namespace, and the final stage below is `runtime`.

# ----------------------------------------------------------------------------------- deps
FROM node:22-slim AS deps
# Pin pnpm in the image. The sibling workspaces are installed before this service's own
# package.json is copied, so corepack has no packageManager field to read at that point and
# would otherwise grab whatever is latest and then refuse to switch to the 11.9.0 the
# siblings pin.
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
WORKDIR /app

# Temporary: the file: dependencies resolve to ../runtime and ../contracts relative to this
# directory, so the packages must exist at those paths inside the image for the lockfile to stay
# frozen. Only manifests and sources are copied — node_modules is excluded by the pnpm store
# layout, not by a .dockerignore that would have to live in someone else's repository.
COPY --from=runtimepkgs package.json pnpm-workspace.yaml pnpm-lock.yaml /runtime/
COPY --from=runtimepkgs packages /runtime/packages
COPY --from=contractspkgs package.json pnpm-workspace.yaml pnpm-lock.yaml /contracts/
COPY --from=contractspkgs packages /contracts/packages

# Install the siblings' OWN dependencies first. `link:` uses the sibling as-is and does not manage
# its dependency tree, so /runtime's and /contracts' node_modules must exist independently — both
# for `tsc` to resolve the sibling source it typechecks and for `node --import tsx` to load
# @cloudsforge/* at run time. Without this the image builds a set of @cloudsforge symlinks that
# point at source which cannot resolve its own imports.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store,sharing=locked \
    pnpm --dir /runtime install --frozen-lockfile --config.store-dir=/pnpm-store \
 && pnpm --dir /contracts install --frozen-lockfile --config.store-dir=/pnpm-store

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# `--frozen-lockfile` is the point of the step: a build that silently resolves a different
# dependency tree from the one CI tested is a build whose provenance means nothing. It matters more
# here than in most services, because one of those dependencies is the exact-pinned
# @cloudsforge/contracts-chain that decides how many decimals a satoshi has. A pool that disagrees
# with the wallet about that credits every miner the wrong number.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store,sharing=locked \
    pnpm install --frozen-lockfile --config.store-dir=/pnpm-store

# ----------------------------------------------------------------------------------- build
# `tsc --noEmit` rather than an emit: tsx runs the TypeScript sources directly, exactly as every
# service in the estate already does. What this stage buys is that a type error fails the image
# build instead of the first request.
FROM deps AS build
COPY tsconfig.json tsconfig.base.json ./
COPY src ./src
RUN pnpm typecheck

# ----------------------------------------------------------------------------------- runtime
FROM node:22-slim AS runtime
WORKDIR /app

# No corepack, no pnpm, no build toolchain in the final image: fewer things an RCE can reach, and
# nothing at runtime needs them.
#
# The siblings come across too: /app/node_modules holds @cloudsforge/* as symlinks into them, so
# without the targets the links dangle and the first `import '@cloudsforge/db'` fails at run time.
COPY --from=build /runtime /runtime
COPY --from=build /contracts /contracts
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/tsconfig.json /app/tsconfig.base.json ./
COPY --from=build /app/src ./src

# node:22-slim ships an unprivileged `node` user (uid 1000). Nothing is written to the filesystem
# at runtime, so read-only ownership of the image is sufficient and the container needs no writable
# layer of its own.
#
# This service holds no private key and signs nothing. It builds block templates, judges shares and
# records a debt — the money side of a pool, paying that debt out, is not implemented in this
# release and will not live behind this user when it is.
USER node

# No secret is baked in, and none may be: every value in src/env.ts is supplied by the deploy at
# run time, and the image is published to a registry that is not the trust boundary for any of
# them. That goes double for the node RPC URLs, which carry HTTP Basic userinfo. There is no ENV
# line here on purpose.
ENV NODE_ENV=production

# THREE PORTS, AND THEY ARE NOT INTERCHANGEABLE.
#
# 4146 is the HTTP surface: /livez, /readyz, /metrics and the public read API. It is the only one an
# estate balancer should ever see.
#
# 3333 and 3334 are the Stratum v1 listeners for BTC and LTC — raw TCP, line-delimited JSON-RPC, no
# TLS and no authentication, because that is the protocol deployed hardware speaks. They are
# separate ports from the HTTP one precisely so that nothing routes a miner through an HTTP proxy,
# which would frame the connection and break it. A deploy that publishes 4146 through an ingress
# must publish these as plain TCP, and only the chains in POOL_CHAINS need publishing at all.
EXPOSE 4146
EXPOSE 3333
EXPOSE 3334

# The health endpoints are for the orchestrator, not for the image: the balancer probes /readyz and
# the restart policy probes /livez. A HEALTHCHECK here would duplicate that in a second place that
# then drifts.

# Migrations are NOT run here. `pnpm migrate` is a separate one-shot process — an init container or
# a Kubernetes Job — for the reasons in src/migrator.ts.
CMD ["node", "--import", "tsx", "src/index.ts"]
