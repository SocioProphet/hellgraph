import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AtomSpace } from './atomspace.js'
import { HellGraphStore } from './store.js'
import { fastRP } from './fastrp.js'

const cos = (a: number[], b: number[]): number => {
  let d = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]! }
  return na && nb ? d / Math.sqrt(na * nb) : 0
}

test('fastRP: nodes sharing a neighbourhood embed alike; unrelated nodes do not', () => {
  const g = new HellGraphStore(new AtomSpace('frp', false))
  // star c–{l1,l2,l3}: leaves share the single neighbour c → alike. Plus a disconnected d1–d2.
  for (const id of ['c', 'l1', 'l2', 'l3', 'd1', 'd2']) g.addNode(id, ['N'], {})
  g.addEdge('E', 'c', 'l1'); g.addEdge('E', 'c', 'l2'); g.addEdge('E', 'c', 'l3')
  g.addEdge('E', 'd1', 'd2')

  const emb = fastRP(g, { dim: 64, weights: [0, 1, 1] })
  const l1 = emb.get('l1')!, l2 = emb.get('l2')!, l3 = emb.get('l3')!, d1 = emb.get('d1')!
  assert.ok(cos(l1, l2) > 0.99, 'leaves sharing neighbour c are near-identical')
  assert.ok(cos(l1, l3) > 0.99)
  assert.ok(cos(l1, l2) > cos(l1, d1), 'leaves are more similar to each other than to an unrelated node')
})

test('fastRP: deterministic under a fixed seed; different seeds differ', () => {
  const g = new HellGraphStore(new AtomSpace('frp2', false))
  for (const id of ['a', 'b', 'c']) g.addNode(id, ['N'], {})
  g.addEdge('E', 'a', 'b'); g.addEdge('E', 'b', 'c')
  const e1 = fastRP(g, { dim: 32, seed: 7 })
  const e2 = fastRP(g, { dim: 32, seed: 7 })
  assert.deepEqual(e1.get('a'), e2.get('a'), 'same seed → identical embedding')
  const e3 = fastRP(g, { dim: 32, seed: 99 })
  assert.notDeepEqual(e1.get('a'), e3.get('a'), 'different seed → different projection')
})

test('fastRP: dimensions + empty graph', () => {
  const g = new HellGraphStore(new AtomSpace('frp3', false))
  g.addNode('x', ['N'], {})
  const emb = fastRP(g, { dim: 48 })
  assert.equal(emb.get('x')!.length, 48, 'embedding has the requested dimension')
  assert.equal(fastRP(new HellGraphStore(new AtomSpace('empty', false))).size, 0)
})
