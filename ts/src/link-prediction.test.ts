import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AtomSpace } from './atomspace.js'
import { HellGraphStore } from './store.js'
import { neighborhoods, commonNeighbors, jaccardSimilarity, adamicAdar, predictLinks } from './link-prediction.js'

// x and y share 3 common neighbours (m1,m2,m3) but aren't linked; z shares only m1 with x.
function graph(): HellGraphStore {
  const g = new HellGraphStore(new AtomSpace('lp', false))
  for (const id of ['x', 'y', 'z', 'm1', 'm2', 'm3']) g.addNode(id, ['N'], {})
  for (const m of ['m1', 'm2', 'm3']) { g.addEdge('E', 'x', m); g.addEdge('E', 'y', m) }
  g.addEdge('E', 'z', 'm1')
  return g
}

test('neighbourhood scores reflect shared structure', () => {
  const nb = neighborhoods(graph())
  const nx = nb.get('x')!, ny = nb.get('y')!, nz = nb.get('z')!
  assert.equal(commonNeighbors(nx, ny), 3, 'x,y share all three')
  assert.equal(commonNeighbors(nx, nz), 1, 'x,z share one')
  assert.ok(jaccardSimilarity(nx, ny) > jaccardSimilarity(nx, nz))
  assert.ok(adamicAdar(nx, ny, nb) > adamicAdar(nx, nz, nb), 'more shared neighbours → higher Adamic-Adar')
})

test('predictLinks ranks the strongest missing edge first', () => {
  const g = graph()
  const preds = predictLinks(g, 'x')
  assert.equal(preds[0]!.id, 'y', 'y (3 common neighbours) is the top predicted link for x')
  assert.ok(preds.every((p) => p.id !== 'x'), 'never predicts a self-loop')
  assert.ok(!preds.some((p) => ['m1', 'm2', 'm3'].includes(p.id)), 'existing neighbours are excluded')
  // metric switch works
  assert.equal(predictLinks(g, 'x', { metric: 'commonNeighbors' })[0]!.id, 'y')
})

test('link-prediction edge cases', () => {
  const g = new HellGraphStore(new AtomSpace('lp2', false))
  g.addNode('solo', ['N'], {})
  assert.deepEqual(predictLinks(g, 'solo'), [], 'no candidates → []')
  assert.deepEqual(predictLinks(g, 'missing'), [], 'unknown node → []')
})
