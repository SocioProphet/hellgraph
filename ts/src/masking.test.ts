import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AtomSpace } from './atomspace.js'
import { HellGraphStore } from './store.js'
import { decide, type PolicyContext } from './policy.js'
import {
  StaticKeyProvider, maskValue, unmaskValue, isMasked,
  applyMask, applyUnmask, applyEgressObligations, getAtPath,
  maskingPolicyToGraph,
} from './masking.js'

const key = StaticKeyProvider.fromPassphrase('test-tenant-key').getKey()

// The reference payload (Image 1).
const payload = () => ({
  phones: { home: '(123) 456-7890', work: '(456) 194-3754', mobile: '(395) 383-3875' },
  email: 'my.example@fake.com',
})

// ─── Reversible cipher ──────────────────────────────────────────────────────────────
test('mask → unmask round-trips; masked value is delimited ciphertext', () => {
  const masked = maskValue('(123) 456-7890', key)
  assert.ok(isMasked(masked), 'masked value is a {#…#} wrapper')
  assert.notEqual(masked, '(123) 456-7890')
  assert.equal(unmaskValue(masked, key), '(123) 456-7890')
})

test('unmask with the wrong key fails (authenticated encryption)', () => {
  const masked = maskValue('secret', key)
  const wrong = StaticKeyProvider.fromPassphrase('attacker').getKey()
  assert.throws(() => unmaskValue(masked, wrong))
})

// ─── Field-level over a payload ───────────────────────────────────────────────────────
test('applyMask masks only the protected path; other fields untouched; unmask restores', () => {
  const p = payload()
  const masked = applyMask(p, ['$.phones.home'], key) as ReturnType<typeof payload>
  assert.ok(isMasked(masked.phones.home), 'home masked')
  assert.equal(masked.phones.work, '(456) 194-3754', 'work untouched')
  assert.equal(masked.email, 'my.example@fake.com', 'email untouched')
  assert.notDeepEqual(masked, p)
  const restored = applyUnmask(masked, ['$.phones.home'], key) as ReturnType<typeof payload>
  assert.deepEqual(restored, p, 'lossless round-trip')
})

// ─── The L5 → masking loop: policy obligations drive the masking ────────────────────
test('egress obligations from the policy engine mask the sensitive field before egress', () => {
  const ctx: PolicyContext = {
    action: 'egress',
    object: { id: 'o1', state: 'Served', vendorOptIn: true, sensitiveFields: ['$.phones.home'] },
    target: { kind: 'vendor' },
  }
  const d = decide(ctx)
  assert.equal(d.effect, 'allow')
  assert.ok(d.obligations.includes('mask:$.phones.home'))

  const egressing = applyEgressObligations(payload(), d.obligations, key)
  assert.ok(isMasked(getAtPath(egressing, '$.phones.home')), 'sensitive field masked before it leaves the cell')
})

// ─── The policy AS a HellGraph subgraph (Image 1) ────────────────────────────────────
test('maskingPolicyToGraph encodes the Json→Mask/Unmask processor graph', () => {
  const g = new HellGraphStore(new AtomSpace('test-mask', false))
  maskingPolicyToGraph(g, 'pii', ['$.phones.home'])

  const root = g.getNode('policy:pii:json-processor')
  assert.ok(root && root.labels.includes('JsonProcessor'), 'json processor root')
  assert.ok(g.getNode('policy:pii:mask-processor')?.labels.includes('MaskProcessor'))
  assert.ok(g.getNode('policy:pii:unmask-processor')?.labels.includes('UnmaskProcessor'))

  const maskEdge = g.allEdges().find((e) => e.label === 'mask')
  assert.ok(maskEdge, 'mask edge present')
  assert.equal(maskEdge!.properties['selector'], '$.phones.home')
  assert.equal(maskEdge!.properties['predicate'], 'encrypt')
  const unmaskEdge = g.allEdges().find((e) => e.label === 'unmask')
  assert.equal(unmaskEdge!.properties['predicate'], 'decrypt')
})
