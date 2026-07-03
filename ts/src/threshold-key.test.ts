import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { splitSecret, combineSecret, shareToString, shareFromString, ThresholdKeyProvider } from './threshold-key.js'
import { maskValue, unmaskValue } from './masking.js'

test('any t of n shares reconstruct the secret; a different subset agrees', () => {
  const secret = randomBytes(32)
  const shares = splitSecret(secret, 5, 3)
  assert.deepEqual(combineSecret([shares[0]!, shares[2]!, shares[4]!]), secret)
  assert.deepEqual(combineSecret([shares[1]!, shares[3]!, shares[4]!]), secret)
  assert.deepEqual(combineSecret(shares), secret, 'all shares also reconstruct')
})

test('fewer than t shares do NOT reveal the secret', () => {
  const secret = randomBytes(32)
  const shares = splitSecret(secret, 5, 3)
  assert.notDeepEqual(combineSecret([shares[0]!, shares[1]!]), secret, '2 of 3 leaks nothing')
})

test('shares serialize/round-trip for distribution', () => {
  const secret = randomBytes(16)
  const shares = splitSecret(secret, 3, 2)
  const wire = shares.map(shareToString)
  const back = wire.map(shareFromString)
  assert.deepEqual(combineSecret([back[0]!, back[2]!]), secret)
})

test('sovereign custody end-to-end: a quorum unmasks; under-quorum cannot', () => {
  // Split the masking key across 5 shareholders, 3 required.
  const key = randomBytes(32)
  const shares = splitSecret(key, 5, 3)
  const masked = maskValue('(123) 456-7890', key)

  // Three shareholders combine → reconstruct the key → unmask.
  const quorum = new ThresholdKeyProvider([shares[0]!, shares[1]!, shares[2]!], 3)
  assert.equal(unmaskValue(masked, quorum.getKey()), '(123) 456-7890')

  // Two shareholders cannot even form a quorum.
  const underQuorum = new ThresholdKeyProvider([shares[0]!, shares[1]!], 3)
  assert.throws(() => underQuorum.getKey(), /quorum not met/)
})
