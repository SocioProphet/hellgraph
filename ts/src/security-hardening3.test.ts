import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evalCondition, decide, type Condition, type PolicyContext } from './policy.js'

// ─── Attack 7: deeply-nested (tenant-authored) policy condition → stack overflow ─────
test('SECURITY: policy condition evaluator rejects pathologically deep nesting', () => {
  let cond: Condition = { attr: 'object.id', op: 'truthy' }
  for (let i = 0; i < 5000; i++) cond = { all: [cond] }
  const ctx: PolicyContext = { action: 'egress', object: { id: 'o1', state: 'Served' } }
  assert.throws(() => evalCondition(cond, ctx), /nesting too deep/)
  // A sane nesting still evaluates.
  assert.equal(evalCondition({ all: [{ attr: 'object.id', op: 'truthy' }] }, ctx), true)
  // And a malicious deep-nested user rule can't hang decide() — it throws, not loops.
  assert.throws(() => decide(ctx, { rules: [{ id: 'evil', action: 'egress', effect: 'allow', when: cond }] }), /nesting too deep/)
})
