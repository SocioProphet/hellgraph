import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AtomSpace } from './atomspace.js'
import { HellGraphStore } from './store.js'

test('transaction: a valid batch commits all nodes + edges', () => {
  const g = new HellGraphStore(new AtomSpace('tx', false))
  const r = g.transaction({
    nodes: [{ id: 'a', labels: ['N'], properties: { x: 1 } }, { id: 'b', labels: ['N'] }],
    edges: [{ label: 'E', from: 'a', to: 'b' }],
  })
  assert.equal(r.nodes.length, 2)
  assert.equal(r.edges.length, 1)
  assert.ok(g.getNode('a') && g.getNode('b'))
  assert.equal(g.getNode('a')!.properties['x'], 1)
})

test('transaction: a constraint violation aborts the WHOLE batch (all-or-none)', () => {
  const g = new HellGraphStore(new AtomSpace('tx2', false))
  g.addUniqueConstraint('User', 'email')
  g.addNode('u0', ['User'], { email: 'taken@x.com' })

  assert.throws(() => g.transaction({
    nodes: [
      { id: 'u1', labels: ['User'], properties: { email: 'new@x.com' } }, // valid on its own
      { id: 'u2', labels: ['User'], properties: { email: 'taken@x.com' } }, // violates the store
    ],
  }), /uniqueness constraint/)

  assert.equal(g.getNode('u1'), undefined, 'the valid earlier node was NOT written — atomic abort')
  assert.equal(g.getNode('u2'), undefined)
})

test('transaction: an intra-batch conflict is rejected, nothing written', () => {
  const g = new HellGraphStore(new AtomSpace('tx3', false))
  g.addUniqueConstraint('User', 'email')
  assert.throws(() => g.transaction({
    nodes: [
      { id: 'u1', labels: ['User'], properties: { email: 'dup@x.com' } },
      { id: 'u2', labels: ['User'], properties: { email: 'dup@x.com' } },
    ],
  }), /batch uniqueness conflict/)
  assert.equal(g.getNode('u1'), undefined, 'nothing written on intra-batch conflict')
  assert.equal(g.getNode('u2'), undefined)
})
