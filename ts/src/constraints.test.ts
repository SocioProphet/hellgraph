import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AtomSpace } from './atomspace.js'
import { HellGraphStore } from './store.js'

test('uniqueness constraint: a duplicate property value is rejected (no partial write)', () => {
  const g = new HellGraphStore(new AtomSpace('uc', false))
  g.addUniqueConstraint('User', 'email')
  g.addNode('u1', ['User'], { email: 'a@x.com' })

  assert.throws(() => g.addNode('u2', ['User'], { email: 'a@x.com' }), /uniqueness constraint \(User\.email\)/)
  assert.equal(g.getNode('u2'), undefined, 'the violating node was NOT created (validate-before-write)')

  g.addNode('u2', ['User'], { email: 'b@x.com' }) // a distinct value is fine
  assert.ok(g.getNode('u2'))
})

test('uniqueness constraint: re-writing the same node keeps its own value (self-exclusion)', () => {
  const g = new HellGraphStore(new AtomSpace('uc2', false))
  g.addUniqueConstraint('User', 'email')
  g.addNode('u1', ['User'], { email: 'a@x.com' })
  assert.doesNotThrow(() => g.addNode('u1', ['User'], { email: 'a@x.com' }), 'idempotent re-add must not self-trip')
})

test('uniqueness constraint is label-scoped and enforced by setNodeProperty', () => {
  const g = new HellGraphStore(new AtomSpace('uc3', false))
  g.addUniqueConstraint('User', 'email')
  g.addNode('u1', ['User'], { email: 'a@x.com' })

  // Same email on a non-User node is allowed — the constraint is scoped to the User label.
  assert.doesNotThrow(() => g.addNode('c1', ['Contact'], { email: 'a@x.com' }))

  g.addNode('u2', ['User'], { email: 'b@x.com' })
  assert.throws(() => g.setNodeProperty('u2', 'email', 'a@x.com'), /uniqueness constraint/, 'setNodeProperty enforces too')
})

test('no constraint registered → no enforcement (backward compatible)', () => {
  const g = new HellGraphStore(new AtomSpace('uc4', false))
  g.addNode('u1', ['User'], { email: 'a@x.com' })
  assert.doesNotThrow(() => g.addNode('u2', ['User'], { email: 'a@x.com' }))
})
