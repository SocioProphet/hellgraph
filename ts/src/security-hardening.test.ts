import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { setAtPath, getAtPath, applyMask, StaticKeyProvider } from './masking.js'
import { splitSecret, combineSecret, type Share } from './threshold-key.js'
import { RateLimiter } from './rate-limit.js'

// ─── Attack 1: prototype pollution via a crafted mask path ────────────────────────────
test('SECURITY: masking rejects __proto__/constructor/prototype path segments (no pollution)', () => {
  const victim: Record<string, unknown> = {}
  assert.throws(() => setAtPath(victim, '$.__proto__.polluted', 'PWNED'), /unsafe path segment/)
  assert.notEqual(({} as Record<string, unknown>)['polluted'], 'PWNED', 'Object.prototype is NOT polluted')
  assert.throws(() => setAtPath(victim, '$.constructor.prototype.x', 'x'), /unsafe path segment/)
  assert.throws(() => getAtPath(victim, '$.__proto__'), /unsafe path segment/)
  // The egress obligation path also fails closed rather than silently walking the prototype.
  assert.throws(() => applyMask({ a: 'x' }, ['$.__proto__.p'], StaticKeyProvider.fromPassphrase('k').getKey()), /unsafe path segment/)
})

// ─── Attack 2: threshold reconstruction with a forged/duplicate share ────────────────
test('SECURITY: threshold combineSecret rejects duplicate/invalid share x (no silent wrong key)', () => {
  const secret = randomBytes(32)
  const sh = splitSecret(secret, 5, 3)
  // Sound reconstruction still works.
  assert.deepEqual(combineSecret([sh[0]!, sh[1]!, sh[2]!]), secret)
  // Attacker duplicates a share's x with a different y → previously a SILENT wrong key.
  const forged: Share[] = [sh[0]!, { x: sh[0]!.x, y: sh[1]!.y }, sh[2]!]
  assert.throws(() => combineSecret(forged), /duplicate share x=/)
  // x=0 is the secret's own evaluation point — must be rejected.
  assert.throws(() => combineSecret([{ x: 0, y: sh[0]!.y }, sh[1]!]), /invalid share x=0/)
  // inconsistent share length.
  assert.throws(() => combineSecret([sh[0]!, { x: 9, y: Buffer.alloc(3) }]), /inconsistent share length/)
})

// ─── Attack 3: unbounded rate-limiter map (memory DoS via unique keys) ───────────────
test('SECURITY: rate limiter bounds its key map under a flood of unique keys (no OOM)', () => {
  const rl = new RateLimiter(1, 1, 100) // cap 100 keys
  for (let i = 0; i < 5000; i++) rl.allow(`key-${i}`)
  // @ts-expect-error — inspect the private map size for the invariant
  assert.ok(rl.buckets.size <= 100, `map stays bounded (was ${(rl as unknown as { buckets: Map<string, unknown> }).buckets.size})`)
  // Eviction is safe: a fresh (evicted) key just gets a full burst again — no extra allowance.
  assert.equal(rl.allow('brand-new'), true)
})
