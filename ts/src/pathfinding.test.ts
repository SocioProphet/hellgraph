import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AtomSpace } from './atomspace.js'
import { HellGraphStore } from './store.js'
import { shortestPath, shortestPathWeighted } from './graph-analytics.js'

function graph(): HellGraphStore {
  const g = new HellGraphStore(new AtomSpace('pathfinding', false))
  for (const id of ['A', 'B', 'C', 'D', 'X']) g.addNode(id, ['N'], {})
  // A→B→D and A→C→D (X is isolated). Weights make the C route cheaper.
  g.addEdge('E', 'A', 'B', { weight: 5 })
  g.addEdge('E', 'A', 'C', { weight: 1 })
  g.addEdge('E', 'B', 'C', { weight: 1 })
  g.addEdge('E', 'B', 'D', { weight: 1 })
  g.addEdge('E', 'C', 'D', { weight: 1 })
  return g
}

test('shortestPath: BFS unweighted, deterministic', () => {
  const g = graph()
  assert.deepEqual(shortestPath(g, 'A', 'D'), ['A', 'B', 'D'], 'fewest hops, ascending-id tie-break')
  assert.deepEqual(shortestPath(g, 'A', 'A'), ['A'], 'self path')
  assert.equal(shortestPath(g, 'A', 'X'), null, 'unreachable → null')
  assert.equal(shortestPath(g, 'A', 'ZZZ'), null, 'missing endpoint → null')
})

test('shortestPath: directed vs undirected', () => {
  const g = graph()
  assert.equal(shortestPath(g, 'D', 'A'), null, 'no directed path D→A')
  assert.deepEqual(shortestPath(g, 'D', 'A', { undirected: true }), ['D', 'B', 'A'], 'reachable undirected')
})

test('shortestPathWeighted: Dijkstra picks the cheaper route, not the fewer-hop one', () => {
  const g = graph()
  const r = shortestPathWeighted(g, 'A', 'D')
  assert.ok(r, 'path found')
  assert.deepEqual(r!.path, ['A', 'C', 'D'], 'A→C→D (cost 2) beats A→B→D (cost 6)')
  assert.equal(r!.cost, 2)
})

test('shortestPathWeighted: rejects negative weights (Dijkstra invariant)', () => {
  const g = new HellGraphStore(new AtomSpace('pf-neg', false))
  g.addNode('A', ['N'], {}); g.addNode('B', ['N'], {})
  g.addEdge('E', 'A', 'B', { weight: -3 })
  assert.throws(() => shortestPathWeighted(g, 'A', 'B'), /negative edge weight/)
})
