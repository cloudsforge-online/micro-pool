/**
 * Which chains this pool mines, which proof-of-work function each one uses, and — just as
 * important — which chains are refused by name.
 *
 * **Nothing in `@cloudsforge/contracts-chain` is redefined here.** Decimals and the human name come
 * from `chainSpec()`; this file adds only the vocabulary a pool needs and that package has no
 * opinion about: the URL-and-env slug, the proof-of-work algorithm, and the stratum difficulty unit.
 * The rule is the one `indexer/src/chains.ts` already states — a number that exists in
 * contracts-chain is read from it and never restated, because the whole reason that package is
 * exact-pinned is that five services disagreeing about a constant is money credited wrongly.
 *
 * ## The algorithm is dispatched on the chain, and getting it wrong is silent
 *
 * Bitcoin's proof of work is double SHA-256 over the 80-byte header. Litecoin's and Dogecoin's is
 * scrypt(N=1024, r=1, p=1) over the same 80 bytes. They are different functions with different
 * outputs, and a pool that applies the wrong one does not crash, does not warn, and does not log
 * anything unusual: every share a miner submits simply fails the target comparison and comes back
 * `low difficulty share`. From the miner's side that is indistinguishable from a pool that is
 * stealing, and they leave. So the algorithm is a property of the chain, carried in the table
 * below, and `pow.ts` has no default branch — an algorithm that is not handled is a type error at
 * compile time rather than a rejected share at run time.
 *
 * ## DOGE IS REFUSED, BY NAME, AND THIS IS THE POINT OF `REFUSED_CHAINS`
 *
 * Dogecoin's proof of work is scrypt, and it would be very easy to read that fact off the
 * contracts-chain spec — which says `family: 'bitcoin'`, decimals 8, exactly like Litecoin — and
 * conclude that adding `doge` to the table below is a one-line change. **It is not, and the
 * one-line change would produce a pool that mines Dogecoin blocks nobody can spend.**
 *
 * Dogecoin has been merge-mined with Litecoin under AuxPoW since 2014. `contracts-chain`'s own DOGE
 * comment says so, and says why the confirmation depth depends on it: "its work is Litecoin's
 * Scrypt work rather than a small independent budget". Merge-mining means a Dogecoin block header
 * does not carry its own winning nonce at all. It carries an *auxiliary proof of work*: the parent
 * (Litecoin) block's header, the parent coinbase transaction containing a commitment to the
 * Dogecoin block hash, the merkle branch linking that coinbase to the parent header's merkle root,
 * and a second branch describing the position of this chain in the merged-mining tree. None of
 * that is produced by anything in this repository. `getauxblock` / `createauxblock` /
 * `submitauxblock` are a different node RPC surface from `getblocktemplate` / `submitblock`, and
 * the coinbase this repository builds has no merged-mining commitment in it.
 *
 * So a `doge` entry that reused the Litecoin path would hand miners Dogecoin templates, validate
 * their shares correctly against the scrypt target, and — on the one occasion that actually
 * mattered — submit a block Dogecoin's consensus rules reject for having no AuxPoW. The pool would
 * have taken real work, recorded a real debt, and produced nothing. **A named refusal that fails at
 * configuration time is strictly better than a silent misconfiguration that fails once, later, on
 * the only block that was ever worth anything.**
 *
 * The same reasoning refuses ETC, for a different reason: Etchash is not this family's proof of
 * work at all, an ETC node speaks `eth_getWork` rather than `getblocktemplate`, and §5.3 of
 * `docs/ecosystem/36-multi-chain-and-mining-pool.md` files it as its own piece of work. EMBER is
 * refused for a third reason, which is a product decision rather than a technical one: 36 §7.4
 * leaves "whether the pool mines EMBER too" open, and 36 §5.2 says the browser miner is the
 * estate's one genuinely distinctive first action and that nothing in this track may weaken it.
 * Choosing that here, by adding a row, would be deciding an open question in a table.
 */

import { chainSpec, type AssetCode, type Network } from '@cloudsforge/contracts-chain'

/** The chains this pool can actually mine. Lowercased asset code, as `indexer` slugs them. */
export type PoolChainId = 'btc' | 'ltc'

export const POOL_CHAIN_IDS: readonly PoolChainId[] = Object.freeze(['btc', 'ltc'])

/**
 * The proof-of-work functions this repository implements.
 *
 * A union rather than a string so `pow.ts` can exhaust it. `noFallthroughCasesInSwitch` and an
 * exhaustive `never` check together mean that adding a member here without implementing it fails
 * `tsc`, which is the only moment at which the omission is cheap to notice.
 */
export type PowAlgorithm = 'sha256d' | 'scrypt'

interface PoolChain {
  readonly chain: PoolChainId
  readonly asset: AssetCode
  readonly algorithm: PowAlgorithm
  /**
   * `getblocktemplate`'s `rules` argument. Core refuses the call outright — "getblocktemplate must
   * be called with the segwit rule set" — if a caller omits a rule the node considers mandatory,
   * so this is not optional decoration.
   *
   * MWEB is deliberately absent for Litecoin. Litecoin Core only includes MWEB transactions when
   * the caller asks for them, so omitting it costs this pool the fees on those transactions and
   * nothing else; the block is valid either way. Adding `mweb` means building a coinbase with the
   * MWEB commitment, which this repository does not do, so asking for it would be asking the node
   * for transactions we cannot correctly commit to.
   */
  readonly templateRules: readonly string[]
}

const POOL_CHAINS: Readonly<Record<PoolChainId, PoolChain>> = Object.freeze({
  btc: Object.freeze({
    chain: 'btc',
    asset: 'BTC',
    algorithm: 'sha256d',
    templateRules: Object.freeze(['segwit']),
  }),
  ltc: Object.freeze({
    chain: 'ltc',
    asset: 'LTC',
    algorithm: 'scrypt',
    templateRules: Object.freeze(['segwit']),
  }),
})

/**
 * Chains a person will reasonably try to configure, and the reason each one is refused.
 *
 * Read by `env.ts`, which turns a refused name in `POOL_CHAINS` into a boot failure carrying the
 * text below. The alternative — treating an unknown chain as simply unknown — answers "doge is not
 * a valid chain", which reads as a typo and invites the reader to go and add it.
 */
export const REFUSED_CHAINS: Readonly<Record<string, string>> = Object.freeze({
  doge:
    'Dogecoin is merge-mined with Litecoin under AuxPoW and has been since 2014. Its blocks are ' +
    'won by a Litecoin header carrying a commitment to them, not by a nonce found against a ' +
    'Dogecoin header, and this repository implements neither the auxiliary proof nor the ' +
    'getauxblock/submitauxblock RPC surface it is submitted through. Mining it through the ' +
    'getblocktemplate path would take real work from miners and submit a block consensus rejects.',
  etc:
    'Ethereum Classic is Etchash over an EVM account-model chain. It has no getblocktemplate, no ' +
    'coinbase transaction to build, and no merkle branch of the shape this pool computes. ' +
    'docs/ecosystem/36-multi-chain-and-mining-pool.md files the EVM work path as its own piece of ' +
    'work, and it shares no code with this one.',
  ember:
    'Whether this pool mines EMBER is an open decision, not an omission — 36 §7.4. It competes ' +
    'directly with the browser miner for the same blocks, and 36 §5.2 says the browser miner is ' +
    'the estate’s one genuinely distinctive first action and that nothing in this track may ' +
    'weaken it. That question is answered by a person, not by adding a row to a table.',
})

export function isPoolChainId(value: string): value is PoolChainId {
  return (POOL_CHAIN_IDS as readonly string[]).includes(value)
}

export function poolChain(chain: PoolChainId): PoolChain {
  return POOL_CHAINS[chain]
}

/** The proof-of-work function for a chain. The one place the dispatch is decided. */
export function algorithmFor(chain: PoolChainId): PowAlgorithm {
  return POOL_CHAINS[chain].algorithm
}

export function assetFor(chain: PoolChainId): AssetCode {
  return POOL_CHAINS[chain].asset
}

/** Smallest-unit exponent. Read from contracts-chain, never restated. */
export function decimalsFor(chain: PoolChainId): number {
  return chainSpec(assetFor(chain)).decimals
}

/** The chain's human name, for a log line or a page. Read from contracts-chain. */
export function nameFor(chain: PoolChainId): string {
  return chainSpec(assetFor(chain)).name
}

/**
 * What `getblockchaininfo.chain` must say for each of the estate's two networks.
 *
 * Copied in shape — not in code, because it is one object and importing it would be a
 * cross-service source import — from `indexer/src/btcnodesource.ts`, whose comment explains why
 * `testnet` is a SET: Bitcoin has four distinct test networks, Core reports each by its own name,
 * and the estate's `Network` type has one value for all of them.
 *
 * **For a pool this check is worth more than it is for an indexer**, and that is why it refuses to
 * serve rather than merely logging. An indexer pointed at the wrong network reads blocks that do
 * not concern it. A pool pointed at the wrong network hands miners mainnet templates against a
 * testnet payout address, or the reverse — and the first time that combination finds a block, the
 * reward is paid to an address on a chain where nobody holds the key.
 */
export const EXPECTED_NODE_CHAIN: Readonly<Record<Network, ReadonlySet<string>>> = Object.freeze({
  mainnet: new Set(['main']),
  testnet: new Set(['test', 'testnet4', 'signet', 'regtest']),
})
