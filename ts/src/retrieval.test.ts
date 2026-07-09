import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AtomSpace } from './atomspace.js'
import { HellGraphStore } from './store.js'
import { personalizedPageRank } from './graph-analytics.js'
import { reciprocalRankFusion, mmrRerank } from './retrieval.js'

// ─── Personalized (seeded) PageRank — HippoRAG-style associative retrieval ─────────────────
test('personalizedPageRank: scores fall off with graph distance from the seed', () => {
  const g = new HellGraphStore(new AtomSpace('ppr', false))
  for (const id of ['A', 'B', 'C', 'D']) g.addNode(id, ['N'], {})
  g.addEdge('E', 'A', 'B'); g.addEdge('E', 'B', 'C') // A→B→C chain; D isolated
  const s = personalizedPageRank(g, ['A'])
  assert.ok(s.get('A')! > s.get('B')!, 'seed ranks above its neighbour')
  assert.ok(s.get('B')! > s.get('C')!, 'closer beats farther')
  assert.ok(s.get('C')! > s.get('D')!, 'reachable beats isolated')
  // different seed → different ranking (it is personalized, not global)
  const s2 = personalizedPageRank(g, ['C'])
  assert.ok(s2.get('C')! > s2.get('A')!, 'seeding C flips the ranking')
})

// ─── Reciprocal Rank Fusion ────────────────────────────────────────────────────────────────
test('reciprocalRankFusion: items ranked high across lists win; deterministic ties', () => {
  const fused = reciprocalRankFusion([['x', 'y', 'z'], ['y', 'x', 'w']])
  const order = fused.map((r) => r.id)
  assert.deepEqual(order.slice(0, 2).sort(), ['x', 'y'], 'x and y (top in both) lead')
  assert.equal(order[0], 'x', 'exact tie broken by id (x < y)')
  assert.ok(order.indexOf('z') > 1 && order.indexOf('w') > 1, 'singly-listed items rank lower')
})

// ─── MMR rerank ──────────────────────────────────────────────────────────────────────────
test('mmrRerank: diversity demotes a near-duplicate; lambda=1 is pure relevance', () => {
  const cands = [
    { id: 'a', relevance: 1.0, vector: [1, 0] },
    { id: 'b', relevance: 0.9, vector: [1, 0] }, // near-duplicate of a
    { id: 'c', relevance: 0.8, vector: [0, 1] }, // diverse
  ]
  assert.deepEqual(mmrRerank(cands, { lambda: 0.5 }), ['a', 'c', 'b'], 'diverse c jumps the near-dup b')
  assert.deepEqual(mmrRerank(cands, { lambda: 1 }), ['a', 'b', 'c'], 'pure relevance order')
})

// ─── Annealing: degenerate input must not crash / NaN out ──────────────────────────────────
test('ANNEAL: retrieval primitives are safe on empty / zero / NaN input', () => {
  assert.deepEqual(reciprocalRankFusion([]), [])
  assert.deepEqual(reciprocalRankFusion([[], []]), [])
  assert.deepEqual(reciprocalRankFusion([['a', 'a']]).length, 1, 'dup within a list counts once')
  assert.deepEqual(mmrRerank([]), [])
  // zero/short vectors + NaN relevance: no throw, no NaN ordering blowup
  const r = mmrRerank([{ id: 'a', relevance: NaN, vector: [0, 0] }, { id: 'b', relevance: 1, vector: [] }], { lambda: 0.5 })
  assert.equal(r.length, 2)
  // seeded PPR: unknown seed → graceful uniform fallback; empty graph → empty
  const g = new HellGraphStore(new AtomSpace('ppr-edge', false)); g.addNode('X', ['N'], {})
  assert.equal(personalizedPageRank(g, ['does-not-exist']).size, 1)
  assert.equal(personalizedPageRank(new HellGraphStore(new AtomSpace('empty', false)), ['A']).size, 0)
})

// ─── Composition: graph + vector hybrid ────────────────────────────────────────────────────
test('hybrid: fuse a graph (PPR) rank with a dense rank, then rerank', () => {
  const g = new HellGraphStore(new AtomSpace('hybrid', false))
  for (const id of ['A', 'B', 'C']) g.addNode(id, ['N'], {})
  g.addEdge('E', 'A', 'B'); g.addEdge('E', 'B', 'C')
  const graphRank = [...personalizedPageRank(g, ['A'])].sort((a, b) => b[1] - a[1]).map(([id]) => id)
  const denseRank = ['C', 'A', 'B'] // pretend vector search liked C
  const fused = reciprocalRankFusion([graphRank, denseRank]).map((r) => r.id)
  assert.equal(fused.length, 3)
  assert.ok(fused.includes('A') && fused.includes('B') && fused.includes('C'))
})
