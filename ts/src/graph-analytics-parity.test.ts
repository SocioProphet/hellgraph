import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AtomSpace } from './atomspace.js'
import { HellGraphStore } from './store.js'
import { betweenness, louvain } from './graph-analytics.js'

function graph(nodes: string[], edges: [string, string][]): HellGraphStore {
  const g = new HellGraphStore(new AtomSpace('test-parity', false))
  for (const id of nodes) g.addNode(id, ['N'], {})
  for (const [f, t] of edges) g.addEdge('L', f, t, {})
  return g
}

test('betweenness: the middle of a directed path carries the through-traffic', () => {
  const g = graph(['A', 'B', 'C'], [['A', 'B'], ['B', 'C']])
  const bc = betweenness(g)
  assert.equal(bc.get('B'), 1, 'B is on the A→C shortest path')
  assert.equal(bc.get('A'), 0)
  assert.equal(bc.get('C'), 0)
})

test('betweenness: a hub on all shortest paths scores highest', () => {
  // star: spokes only reach each other through the center
  const g = graph(['h', 'x', 'y', 'z'], [['x', 'h'], ['h', 'y'], ['h', 'z'], ['x', 'h']])
  const bc = betweenness(g)
  assert.ok(bc.get('h')! >= bc.get('x')!, 'hub carries the most paths')
})

test('louvain: two triangles joined by a bridge → two communities', () => {
  const g = graph(
    ['A', 'B', 'C', 'D', 'E', 'F'],
    [['A', 'B'], ['B', 'C'], ['C', 'A'], ['D', 'E'], ['E', 'F'], ['F', 'D'], ['C', 'D']],
  )
  const c = louvain(g)
  assert.equal(c.get('A'), c.get('B'))
  assert.equal(c.get('B'), c.get('C'), 'A,B,C one community')
  assert.equal(c.get('D'), c.get('E'))
  assert.equal(c.get('E'), c.get('F'), 'D,E,F one community')
  assert.notEqual(c.get('A'), c.get('D'), 'the two triangles are distinct communities')
})

test('louvain: no edges → each node is its own community', () => {
  const c = louvain(graph(['A', 'B'], []))
  assert.notEqual(c.get('A'), c.get('B'))
})
