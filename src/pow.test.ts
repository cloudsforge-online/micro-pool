/**
 * Proof of work, pinned to blocks that were actually mined.
 *
 * The two questions this file has to settle are the two that cannot be settled by reading the code:
 *
 *   1. **Is `scryptSync` the function Litecoin's network validates against?** `pow.ts` argues from
 *      first principles that it is — RFC 7914 with N=1024, r=1, p=1, header as password AND salt —
 *      and an argument is not a proof. So the Litecoin and Dogecoin genesis headers are rebuilt byte
 *      for byte, checked against their published block hashes (which proves the HEADER is right, and
 *      therefore that a failure below is scrypt's fault and not the fixture's), and then hashed. Both
 *      nonces were found by real mining against `1e0ffff0`, so a correct scrypt lands under that
 *      target and a wrong one lands under it with probability about one in a million.
 *
 *   2. **Is the scrypt difficulty-1 unit 2^16 easier than Bitcoin's?** `pow.ts` names three
 *      candidates and picks one. The assertion below states the chosen value as a number rather than
 *      as an expression of `diff1TargetFor`, because an assertion written in terms of the thing it
 *      is checking checks nothing.
 *
 * Dogecoin appears here as a scrypt VECTOR and nowhere else. It is not a chain this pool mines —
 * `chains.ts` refuses it by name, `chains.test.ts` asserts the refusal — but its genesis header is
 * an independent second sample of the same function, which is worth having.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { scryptSync } from 'node:crypto'
import { buildHeader } from './coinbase.ts'
import { hashFromDisplay, hashToDisplay, swap32Hex } from './bytes.ts'
import {
  diff1TargetFor,
  difficultyOfHash,
  hashesPerDifficulty,
  meetsTarget,
  networkDifficultyOf,
  powHash,
  powHashToBigInt,
  scryptPow,
  sha256d,
  targetForDifficulty,
  targetFromCompactBits,
} from './pow.ts'

const ZERO_HASH = '0'.repeat(64)

interface Genesis {
  readonly name: string
  readonly version: number
  readonly merkleRootDisplay: string
  readonly ntime: number
  readonly bits: number
  readonly nonce: number
  /** The block hash as every explorer prints it: the SHA-256d of the header, display order. */
  readonly hash: string
}

/**
 * The three genesis blocks, from their published fields.
 *
 * Assembled through `buildHeader` and `bytes.ts` rather than as one pre-baked 160-character string,
 * deliberately: a pre-baked header would test the hash functions and nothing else, whereas this
 * routes the fixture through the same four byte-order conversions a live template does. If
 * `hashFromDisplay` or `swap32Hex` were reversed, these tests would fail — which is the point.
 */
const GENESIS: readonly Genesis[] = [
  {
    name: 'bitcoin',
    version: 1,
    merkleRootDisplay: '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b',
    ntime: 1231006505,
    bits: 0x1d00ffff,
    nonce: 2083236893,
    hash: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
  },
  {
    name: 'litecoin',
    version: 1,
    merkleRootDisplay: '97ddfbbae6be97fd6cdf3e7ca13232a3afff2353e29badfab7f73011edd4ced9',
    ntime: 1317972665,
    bits: 0x1e0ffff0,
    nonce: 2084524493,
    hash: '12a765e31ffd4059bada1e25190f6e98c99d9714d334efa41a195a7e7e04bfe2',
  },
  {
    name: 'dogecoin',
    version: 1,
    merkleRootDisplay: '5b2a3f53f605d62c53e62932dac6925e3d74afa5a4b459745c36d42d0ed26a69',
    ntime: 1386325540,
    bits: 0x1e0ffff0,
    nonce: 99943,
    hash: '1a91e3dace36e2be3bf030a65679fe821aa1d6ef92e7c9902eb318182c355691',
  },
]

function headerOf(genesis: Genesis): Buffer {
  const hex = (value: number): string => (value >>> 0).toString(16).padStart(8, '0')
  return buildHeader({
    version: swap32Hex(hex(genesis.version)),
    prevHash: hashFromDisplay(ZERO_HASH),
    merkleRoot: hashFromDisplay(genesis.merkleRootDisplay),
    ntime: swap32Hex(hex(genesis.ntime)),
    nbits: swap32Hex(hex(genesis.bits)),
    nonce: swap32Hex(hex(genesis.nonce)),
  })
}

/* ------------------------------------------------------------------ SHA-256d, against real blocks */

for (const genesis of GENESIS) {
  test(`the ${genesis.name} genesis header rebuilds to its published block hash`, () => {
    const header = headerOf(genesis)
    assert.equal(header.length, 80)
    // This assertion is load-bearing for the scrypt tests below: it proves the 80 bytes are the
    // bytes that chain's network agreed on, so anything that fails afterwards failed on the hash
    // function and not on a transposed field.
    assert.equal(hashToDisplay(sha256d(header)), genesis.hash)
  })
}

test('the bitcoin genesis block meets the target it was mined against', () => {
  const genesis = GENESIS[0]!
  const hash = powHash('sha256d', headerOf(genesis))
  assert.ok(meetsTarget(hash, targetFromCompactBits(genesis.bits)))
  // And is nowhere near meeting a target sixteen bits harder, which is the check that the
  // comparison is an inequality on the right side.
  assert.ok(!meetsTarget(hash, targetFromCompactBits(genesis.bits) >> 16n))
})

/* ------------------------------------------------------------------ scrypt, against real blocks */

test('scrypt is the function litecoin and dogecoin were mined with', () => {
  for (const genesis of GENESIS.slice(1)) {
    const header = headerOf(genesis)
    const hash = scryptPow(header)
    assert.equal(hash.length, 32, `${genesis.name}: scrypt must produce 32 bytes`)
    assert.ok(
      meetsTarget(hash, targetFromCompactBits(genesis.bits)),
      `${genesis.name}: the scrypt hash of a header whose nonce was found by real mining does not ` +
        'meet the target it was mined against — node:crypto is not computing the function this ' +
        'chain validates with, and every share on this chain would be rejected',
    )
    // The same header under the wrong proof-of-work function does NOT clear it, which is the
    // dispatch failure `chains.ts` exists to prevent, demonstrated rather than asserted in prose.
    assert.ok(!meetsTarget(sha256d(header), targetFromCompactBits(genesis.bits)))
  }
})

test('scrypt uses the header as both password and salt', () => {
  // Not a restatement of the implementation: it distinguishes the function `pow.ts` implements from
  // the one a reader used to password hashing would write, which is the same call with an empty or
  // a distinct salt. Those produce different digests, and this shows they do.
  const header = headerOf(GENESIS[1]!)
  const withHeaderAsSalt = scryptPow(header)
  const withEmptySalt = scryptSync(header, Buffer.alloc(0), 32, { N: 1024, r: 1, p: 1 })
  assert.notEqual(withHeaderAsSalt.toString('hex'), withEmptySalt.toString('hex'))
})

test('powHash dispatches on the algorithm and the two answers differ', () => {
  const header = headerOf(GENESIS[0]!)
  assert.equal(powHash('sha256d', header).toString('hex'), sha256d(header).toString('hex'))
  assert.equal(powHash('scrypt', header).toString('hex'), scryptPow(header).toString('hex'))
  assert.notEqual(powHash('sha256d', header).toString('hex'), powHash('scrypt', header).toString('hex'))
})

/* ------------------------------------------------------------------ difficulty units */

test('the difficulty-1 targets are the values deployed mining software uses', () => {
  // Written as literals, not as expressions of the constants under test. `pow.ts` explains at length
  // why scrypt's is 2^224 and not Bitcoin's 2^208 or Litecoin's consensus 2^220; this is the line
  // that would go red if somebody "corrected" it to the powLimit written in Litecoin's source.
  assert.equal(diff1TargetFor('sha256d'), 0xffffn * 2n ** 208n)
  assert.equal(diff1TargetFor('scrypt'), 0xffffn * 2n ** 224n)
  assert.equal(diff1TargetFor('scrypt') / diff1TargetFor('sha256d'), 65_536n)
})

test('a difficulty maps to a target and back', () => {
  for (const algorithm of ['sha256d', 'scrypt'] as const) {
    const diff1 = diff1TargetFor(algorithm)
    assert.equal(targetForDifficulty(algorithm, 1), diff1)
    assert.equal(targetForDifficulty(algorithm, 2), diff1 / 2n)
    assert.equal(targetForDifficulty(algorithm, 0.5), diff1 * 2n)
    // Fractional difficulties are ordinary on scrypt, where one GPU is worth well under a share
    // unit. The fixed-point scale exists so they do not quantise to zero.
    assert.ok(targetForDifficulty(algorithm, 0.001) > diff1 * 900n)
  }
})

test('a difficulty too small for the fixed-point scale is refused rather than rounded to zero', () => {
  assert.throws(() => targetForDifficulty('sha256d', 1e-9), RangeError)
  assert.throws(() => targetForDifficulty('sha256d', 0), RangeError)
  assert.throws(() => targetForDifficulty('sha256d', Number.NaN), RangeError)
})

test('difficultyOfHash inverts targetForDifficulty', () => {
  for (const algorithm of ['sha256d', 'scrypt'] as const) {
    for (const difficulty of [1, 4, 1024, 65_536]) {
      const target = targetForDifficulty(algorithm, difficulty)
      // A hash exactly ON the target has exactly that difficulty. Anything harder has more.
      assert.ok(Math.abs(difficultyOfHash(algorithm, powHashOf(target)) - difficulty) < difficulty * 1e-6)
      assert.ok(difficultyOfHash(algorithm, powHashOf(target / 2n)) > difficulty)
    }
  }
})

test('a proof-of-work hash is read little-endian, the way consensus reads it', () => {
  // The classic version of this mistake is to compare the raw digest big-endian. It does not fail
  // loudly; it accepts and rejects roughly the wrong shares forever. So the direction is pinned.
  const hash = Buffer.alloc(32, 0)
  hash[0] = 0x01
  assert.equal(powHashToBigInt(hash), 1n)
  const high = Buffer.alloc(32, 0)
  high[31] = 0x01
  assert.equal(powHashToBigInt(high), 2n ** 248n)
})

/* ------------------------------------------------------------------ compact bits */

test('targetFromCompactBits decodes the vectors bitcoin documents', () => {
  assert.equal(targetFromCompactBits(0x01123456), 0x12n)
  assert.equal(targetFromCompactBits(0x02008000), 0x80n)
  assert.equal(targetFromCompactBits(0x05009234), 0x92340000n)
  assert.equal(targetFromCompactBits(0x1d00ffff), 0xffffn * 2n ** 208n)
  assert.equal(targetFromCompactBits(0x1e0ffff0), 0xffffn * 2n ** 220n)
  assert.equal(targetFromCompactBits(0x1b0404cb), 0x0404cbn * 2n ** 192n)
})

test('litecoin difficulty-1 for MINING is sixteen times its consensus powLimit', () => {
  // Named because it is the single most tempting wrong answer in this file: 0x1e0ffff0 is the
  // number actually written in Litecoin's source, and it is not the stratum unit.
  assert.equal(diff1TargetFor('scrypt') / targetFromCompactBits(0x1e0ffff0), 16n)
})

test('targetFromCompactBits refuses what cannot be a target', () => {
  assert.throws(() => targetFromCompactBits(0x04923456), RangeError) // sign bit set
  assert.throws(() => targetFromCompactBits(0x00000000), RangeError) // zero target
  assert.throws(() => targetFromCompactBits(-1), RangeError)
  assert.throws(() => targetFromCompactBits(1.5), RangeError)
})

/* ------------------------------------------------------------------ display arithmetic */

test('hashesPerDifficulty differs between the algorithms by exactly the unit ratio', () => {
  const sha = hashesPerDifficulty('sha256d')
  const scrypt = hashesPerDifficulty('scrypt')
  // About 2^32 and about 2^16. Loose bounds on purpose — the exact value carries the 1/65535 that
  // makes difficulty-1 slightly easier than 2^32, and pinning that would be pinning arithmetic
  // nothing depends on.
  assert.ok(sha > 2 ** 32 && sha < 2 ** 32 * 1.0001)
  assert.ok(scrypt > 2 ** 16 && scrypt < 2 ** 16 * 1.0001)
  assert.ok(Math.abs(sha / scrypt - 65_536) < 1)
})

test('networkDifficultyOf reads a block target in the pool own share units', () => {
  assert.equal(networkDifficultyOf('sha256d', targetFromCompactBits(0x1d00ffff)), 1)
  // Litecoin's own genesis target is 16× easier than the scrypt stratum unit, so it is difficulty
  // 1/16 in the units this pool assigns to miners. That is not a bug: the PPLNS window is sized in
  // these units and `pplns.ts` must compare like with like.
  assert.equal(networkDifficultyOf('scrypt', targetFromCompactBits(0x1e0ffff0)), 16)
  assert.throws(() => networkDifficultyOf('sha256d', 0n), RangeError)
})

/** A 32-byte proof-of-work hash, in internal order, with exactly this numeric value. */
function powHashOf(value: bigint): Buffer {
  const hex = value.toString(16).padStart(64, '0')
  return Buffer.from(hex, 'hex').reverse()
}
