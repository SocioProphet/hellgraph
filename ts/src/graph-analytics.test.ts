import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AtomSpace } from './atomspace.js'
import { HellGraphStore } from './store.js'
import { pageRank, degreeCentrality, connectedComponents, topK } from './graph-analytics.js'

function store(): HellGraphStore {
  return new HellGraphStore(new AtomSpace('test-analytics', false))
}

test('PageRank on a symmetric 3-cycle is uniform and sums to ~1', () => {
  const g = store()
  for (const id of ['A', 'B', 'C']) g.addNode(id, ['N'], {})
  g.addEdge('L', 'A', 'B', {}); g.addEdge('L', 'B', 'C', {}); g.addEdge('L', 'C', 'A', {})
  const pr = pageRank(g)
  const sum = [...pr.values()].reduce((a, b) => a + b, 0)
  assert.ok(Math.abs(sum - 1) < 1e-6, 'sums to 1')
  assert.ok(Math.abs(pr.get('A')! - 1 / 3) < 1e-6, 'symmetric → uniform')
})

test('PageRank ranks a hub (more inbound) above leaves', () => {
  const g = store()
  for (const id of ['hub', 'x', 'y', 'z']) g.addNode(id, ['N'], {})
  // everyone points at hub
  g.addEdge('L', 'x', 'hub', {}); g.addEdge('L', 'y', 'hub', {}); g.addEdge('L', 'z', 'hub', {})
  const pr = pageRank(g)
  assert.ok(pr.get('hub')! > pr.get('x')!, 'hub outranks its sources')
  assert.equal(topK(pr, 1)[0]![0], 'hub', 'hub is #1')
})

test('degree centrality counts in/out', () => {
  const g = store()
  for (const id of ['A', 'B', 'C']) g.addNode(id, ['N'], {})
  g.addEdge('L', 'A', 'B', {}); g.addEdge('L', 'A', 'C', {}); g.addEdge('L', 'B', 'C', {})
  const deg = degreeCentrality(g)
  assert.deepEqual(deg.get('A'), { in: 0, out: 2 })
  assert.deepEqual(deg.get('C'), { in: 2, out: 0 })
})

test('connected components groups reachable nodes (undirected)', () => {
  const g = store()
  for (const id of ['A', 'B', 'C', 'D']) g.addNode(id, ['N'], {})
  g.addEdge('L', 'A', 'B', {}) // {A,B}; C,D isolated but C-D linked below
  g.addEdge('L', 'C', 'D', {})
  const cc = connectedComponents(g)
  assert.equal(cc.get('A'), cc.get('B'), 'A,B same component')
  assert.equal(cc.get('C'), cc.get('D'), 'C,D same component')
  assert.notEqual(cc.get('A'), cc.get('C'), 'the two components differ')
})

test('empty graph → empty results', () => {
  assert.equal(pageRank(store()).size, 0)
})
