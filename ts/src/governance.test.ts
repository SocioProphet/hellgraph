import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateModel, applyTransition, canTransition, TRANSITIONS,
  type ContentObject,
} from './lifecycle.js'
import {
  decide, dueTransitions, Governor, InMemoryAuditLog, type PolicyContext,
} from './policy.js'

const obj = (over: Partial<ContentObject> = {}): ContentObject => ({ id: 'o1', state: 'IngestedRaw', ...over })

// ─── Lifecycle FSM ────────────────────────────────────────────────────────────────
test('lifecycle model validates; legal hold has no retention-delete edge', () => {
  assert.deepEqual(validateModel(), { ok: true })
  assert.ok(!TRANSITIONS.LegalHold.some((e) => e.trigger === 'retention_delete'),
    'legal hold overrides retention (structural)')
  assert.equal(TRANSITIONS.Deleted.length, 0, 'Deleted is terminal')
})

test('happy path ingest→served; illegal transitions throw', () => {
  const o = obj()
  o.state = applyTransition(o, 'normalize'); assert.equal(o.state, 'Normalized')
  o.state = applyTransition(o, 'extract');   assert.equal(o.state, 'Extracted')
  o.state = applyTransition(o, 'index');     assert.equal(o.state, 'Indexed')
  o.state = applyTransition(o, 'serve');     assert.equal(o.state, 'Served')
  assert.throws(() => applyTransition(o, 'normalize'), /illegal transition/)
})

test('vendor materialization requires opt-in at the FSM edge', () => {
  const served = obj({ state: 'Served' })
  assert.equal(canTransition(served, 'vendor_materialize'), false, 'default-off without opt-in')
  assert.equal(canTransition({ ...served, vendorOptIn: true }, 'vendor_materialize'), true)
})

// ─── Policy engine (the non-negotiables) ────────────────────────────────────────────
test('egress to a vendor is default-deny without opt-in', () => {
  const ctx: PolicyContext = { action: 'egress', object: obj({ state: 'Served' }), target: { kind: 'vendor' } }
  assert.equal(decide(ctx).effect, 'deny')
})

test('opted-in egress is allowed and carries mask obligations for sensitive fields', () => {
  const ctx: PolicyContext = {
    action: 'egress',
    object: obj({ state: 'Served', vendorOptIn: true, sensitiveFields: ['$.phones.home'] }),
    target: { kind: 'vendor' },
  }
  const d = decide(ctx)
  assert.equal(d.effect, 'allow')
  assert.ok(d.obligations.includes('mask:$.phones.home'), 'sensitive field must be masked before egress')
})

test('legal hold overrides retention: delete denied while held, allowed after release', () => {
  const held: PolicyContext = { action: 'delete', object: { ...obj({ state: 'LegalHold' }), legalHold: true, holdReleased: false } }
  assert.equal(decide(held).effect, 'deny')
  const released: PolicyContext = { action: 'delete', object: { ...obj({ state: 'LegalHold' }), legalHold: true, holdReleased: true } }
  assert.equal(decide(released).effect, 'allow')
})

test('user policy cannot override a non-negotiable deny (deny-overrides)', () => {
  const ctx: PolicyContext = { action: 'egress', object: obj({ state: 'Served' }), target: { kind: 'vendor' } }
  const permissive = { rules: [{ id: 'user-allow-all', action: 'egress' as const, effect: 'allow' as const }] }
  assert.equal(decide(ctx, permissive).effect, 'deny', 'opt-in non-negotiable still wins')
})

// ─── Retention scheduler + governor + audit ─────────────────────────────────────────
test('retention scheduler computes due transitions', () => {
  const now = 1000
  assert.deepEqual(dueTransitions(obj({ state: 'VendorMaterialized', ttlAt: 500 }), now), [{ trigger: 'ttl_gc', to: 'ExpiredVendorCache' }])
  assert.deepEqual(dueTransitions(obj({ state: 'FlaggedRetention', flaggedWindowEndsAt: 500 }), now), [{ trigger: 'window_ends', to: 'Deleted' }])
  assert.deepEqual(dueTransitions(obj({ state: 'Served', retentionDeleteAt: 2000 }), now), [], 'not yet due')
})

test('governor gates retention delete under legal hold and audits everything', () => {
  const audit = new InMemoryAuditLog()
  const gov = new Governor({ rules: [] }, audit)

  // A held object in Served with a due retention delete → blocked.
  const held = { ...obj({ state: 'Served', retentionDeleteAt: 0 }), legalHold: true, holdReleased: false }
  gov.runRetention(held, 1000)
  assert.equal(held.state, 'Served', 'legal hold blocked the retention delete')
  assert.ok(audit.entries().some((e) => e.kind === 'blocked' && e.reason === 'legal-hold-blocks-delete'))

  // Once released, the same retention delete goes through.
  held.holdReleased = true
  gov.runRetention(held, 1000)
  assert.equal(held.state, 'Deleted')
  assert.ok(audit.entries().some((e) => e.kind === 'transition' && e.to === 'Deleted'))
})

test('governor blocks vendor materialization without opt-in (egress gate)', () => {
  const gov = new Governor()
  const o = obj({ state: 'Served' })
  gov.transition(o, 'vendor_materialize')
  assert.equal(o.state, 'Served', 'blocked: vendor egress is opt-in')
  const opted = obj({ state: 'Served', vendorOptIn: true })
  gov.transition(opted, 'vendor_materialize')
  assert.equal(opted.state, 'VendorMaterialized')
})
