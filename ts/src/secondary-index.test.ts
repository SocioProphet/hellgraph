import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AtomSpace } from './atomspace.js'
import { HellGraphStore } from './store.js'

const ids = (ns: { id: string }[]): string[] => ns.map((n) => n.id).sort()

test('nodesByProperty: secondary index finds nodes by property equality', () => {
  const g = new HellGraphStore(new AtomSpace('idx', false))
  g.addNode('n1', ['Doc'], { status: 'active', team: 'eng' })
  g.addNode('n2', ['Doc'], { status: 'active', team: 'sales' })
  g.addNode('n3', ['Doc'], { status: 'archived', team: 'eng' })

  assert.deepEqual(ids(g.nodesByProperty('status', 'active')), ['n1', 'n2'])
  assert.deepEqual(ids(g.nodesByProperty('team', 'eng')), ['n1', 'n3'])
  assert.deepEqual(g.nodesByProperty('status', 'nope'), [], 'no match → []')
  assert.deepEqual(g.nodesByProperty('missingKey', 'x'), [], 'unknown key → []')
})

test('secondary index is maintained on property overwrite (no stale hits)', () => {
  const g = new HellGraphStore(new AtomSpace('idx-ovw', false))
  g.addNode('n1', ['Doc'], { status: 'active' })
  assert.deepEqual(ids(g.nodesByProperty('status', 'active')), ['n1'])

  g.addNode('n1', [], { status: 'archived' }) // overwrite the property
  assert.deepEqual(g.nodesByProperty('status', 'active'), [], 'old value unindexed')
  assert.deepEqual(ids(g.nodesByProperty('status', 'archived')), ['n1'], 'new value indexed')
})

test('AtomSpace.findByValue: direct lookup incl. numeric (float) values', () => {
  const as = new AtomSpace('idx-direct', false)
  const a = as.addNode('ConceptNode', 'x')
  const b = as.addNode('ConceptNode', 'y')
  as.setValue(a.handle, 'score', { kind: 'float', value: [42] })
  as.setValue(b.handle, 'score', { kind: 'float', value: [42] })

  const hit = as.findByValue('score', { kind: 'float', value: [42] })
  assert.deepEqual(hit.map((x) => x.handle).sort(), [a.handle, b.handle].sort())
  assert.deepEqual(as.findByValue('score', { kind: 'float', value: [99] }), [], 'different value → none')
  // a 'string' 42 must NOT collide with a 'float' 42 (kind-tagged index key)
  assert.deepEqual(as.findByValue('score', { kind: 'string', value: ['42'] }), [], 'kind-typed, no cross-kind collision')
})
