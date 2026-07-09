import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AtomSpace } from './atomspace.js'
import { HellGraphStore } from './store.js'
import { HnswIndex } from './ann.js'
import { BM25Index } from './bm25.js'
import { buildRaptorTree, raptorRetrieve } from './raptor.js'
import { fastRP } from './fastrp.js'
import { personalizedPageRank, shortestPath, shortestPathWeighted } from './graph-analytics.js'
import { reciprocalRankFusion, mmrRerank } from './retrieval.js'
import { predictLinks } from './link-prediction.js'
import { hybridRetrieve } from './hybrid.js'
import { loadNodesCsv } from './bulk.js'

// Adversarial/degenerate input must never crash, hang, or produce NaN/Infinity output.
const finite = (xs: number[]): boolean => xs.every((x) => Number.isFinite(x))

test('ANNEAL ann: mismatched dims / huge topK / negative topK / re-add churn', () => {
  const idx = new HnswIndex({ seed: 1 })
  idx.add('a', [1, 0, 0]); idx.add('b', [0, 1]) // shorter vector — must not crash
  idx.add('a', [0, 0, 1]) // re-add updates in place
  assert.ok(idx.search([1, 0, 0], 1000).length <= idx.size, 'topK > size clamps to size')
  assert.deepEqual(idx.search([1, 0, 0], -5), [], 'negative topK → []')
  assert.ok(idx.search([1, 0, 0]).every((r) => Number.isFinite(r.score)), 'scores finite')
})

test('ANNEAL ann: HNSW level stays bounded across many inserts (no giant allocation)', () => {
  const idx = new HnswIndex({ seed: 99 })
  for (let i = 0; i < 400; i++) idx.add('n' + i, [Math.sin(i), Math.cos(i), i % 3])
  assert.equal(idx.size, 400)
  assert.equal(idx.search([1, 0, 0], 5).length, 5)
})

test('ANNEAL bm25: huge query, empty index, negative topK', () => {
  const idx = new BM25Index()
  assert.deepEqual(idx.search('x'.repeat(100000)), [], 'huge query on empty index')
  idx.add('d', 'hello world')
  assert.deepEqual(idx.search('nothing', -3), [], 'negative topK safe')
  assert.ok(idx.search('hello world hello '.repeat(1000)).every((r) => Number.isFinite(r.score)))
})

test('ANNEAL raptor: identical vectors + tiny/huge params terminate', () => {
  const chunks = Array.from({ length: 30 }, (_, i) => ({ id: 'c' + i, text: 'same' }))
  const embed = (): number[] => [1, 1] // all identical → degenerate clustering
  const summarize = (texts: string[]): string => 's' + texts.length
  const nodes = buildRaptorTree(chunks, { embed, summarize, branching: 2, maxLevels: 50 })
  assert.ok(nodes.length >= 30 && nodes.length < 1000, 'terminates without blowup')
  assert.deepEqual(raptorRetrieve(nodes, [1, 1], 3).length, 3)
})

test('ANNEAL fastrp: dim 0, empty weights, disconnected + self-loop graph', () => {
  const g = new HellGraphStore(new AtomSpace('an-frp', false))
  g.addNode('x', ['N'], {}); g.addNode('y', ['N'], {})
  g.addEdge('E', 'x', 'x') // self-loop (ignored)
  const emb = fastRP(g, { dim: 0, weights: [] })
  assert.ok(finite(emb.get('x') ?? []), 'no NaN with degenerate params')
})

test('ANNEAL graph-analytics: PPR bad seeds/damping, pathfinding missing nodes', () => {
  const g = new HellGraphStore(new AtomSpace('an-ga', false))
  for (const id of ['a', 'b']) g.addNode(id, ['N'], {})
  g.addEdge('E', 'a', 'b')
  assert.ok(finite([...personalizedPageRank(g, ['nope'], { damping: 1.5 }).values()]), 'PPR stays finite')
  assert.ok(finite([...personalizedPageRank(g, new Map([['a', -1], ['b', NaN]])).values()]), 'bad weights ignored')
  assert.equal(shortestPath(g, 'ghost', 'a'), null)
  assert.equal(shortestPathWeighted(g, 'a', 'ghost'), null)
})

test('ANNEAL retrieval + hybrid + link-pred + bulk: degenerate input', () => {
  assert.deepEqual(reciprocalRankFusion([[], [], []], -1), [])
  assert.deepEqual(mmrRerank([{ id: 'a', relevance: Infinity, vector: [NaN] }], { lambda: 2 }), ['a'])
  assert.deepEqual(hybridRetrieve({}, {}), [])
  const g = new HellGraphStore(new AtomSpace('an-lp', false))
  g.addNode('solo', ['N'], {})
  assert.deepEqual(predictLinks(g, 'solo', { topK: -1 }), [])
  // malformed CSV: unclosed quote must not hang/throw
  assert.doesNotThrow(() => loadNodesCsv(new HellGraphStore(new AtomSpace('an-csv', false)), 'id,x\n1,"unclosed\n2,ok', { id: 'id' }))
})
