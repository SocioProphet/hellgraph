import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BM25Index } from './bm25.js'
import { buildRaptorTree, raptorRetrieve, type RaptorChunk } from './raptor.js'

// ─── BM25 lexical retrieval ────────────────────────────────────────────────────────────────
test('BM25: ranks by term match + rare-term idf + length normalization', () => {
  const idx = new BM25Index()
  idx.add('d1', 'the graph database stores nodes and edges')
  idx.add('d2', 'graph graph graph theory is about vertices')
  idx.add('d3', 'a cooking recipe for pasta and tomato sauce')

  const r = idx.search('graph edges')
  assert.equal(r[0]!.id, 'd1', 'd1 matches both query terms → tops d2 (only "graph")')
  assert.ok(r.map((x) => x.id).includes('d2'))
  assert.ok(!r.map((x) => x.id).includes('d3'), 'unrelated doc scores nothing')

  const rare = idx.search('recipe')
  assert.equal(rare[0]!.id, 'd3', 'a rare term pins its doc')
})

test('BM25: remove / replace keeps the index consistent', () => {
  const idx = new BM25Index()
  idx.add('d1', 'alpha beta')
  idx.add('d2', 'alpha gamma')
  assert.equal(idx.size, 2)
  idx.remove('d1')
  assert.equal(idx.size, 1)
  assert.deepEqual(idx.search('beta'), [], 'removed doc no longer matches')
  idx.add('d2', 'delta epsilon') // replace d2's content
  assert.deepEqual(idx.search('alpha'), [], 'old terms gone after replace')
  assert.equal(idx.search('delta')[0]!.id, 'd2')
})

test('BM25: empty index / no-match are safe', () => {
  const idx = new BM25Index()
  assert.deepEqual(idx.search('anything'), [])
  idx.add('d1', 'hello world')
  assert.deepEqual(idx.search('zzz'), [])
})

// ─── RAPTOR hierarchical summary tree ────────────────────────────────────────────────────────
// Deterministic stub embed: 2-D vector by keyword presence, so clusters are predictable.
const embed = (t: string): number[] => [/cat|feline|kitten/.test(t) ? 1 : 0, /car|engine|wheel/.test(t) ? 1 : 0]
const summarize = (texts: string[]): string => 'SUMMARY[' + texts.join(' | ') + ']'

test('RAPTOR: builds a multi-level tree and retrieves across levels (collapsed tree)', () => {
  const chunks: RaptorChunk[] = [
    { id: 'c1', text: 'the cat is a feline' },
    { id: 'c2', text: 'a kitten is a young cat' },
    { id: 'c3', text: 'the car has an engine' },
    { id: 'c4', text: 'a wheel is part of a car' },
  ]
  const nodes = buildRaptorTree(chunks, { embed, summarize, branching: 2, maxLevels: 3 })

  assert.ok(nodes.length > chunks.length, 'summary nodes were added above the leaves')
  assert.ok(nodes.some((n) => n.level >= 1 && n.text.startsWith('SUMMARY[')), 'has a summarized parent')
  // 4 leaves → 2 clusters of 2 → 2 parents → 1 root
  assert.ok(nodes.some((n) => n.children.length >= 2), 'parents point at their children')

  // query about cats should surface cat leaves AND/OR the cat summary from anywhere in the tree
  const hits = raptorRetrieve(nodes, embed('cat feline'), 3).map((n) => n.id)
  assert.ok(hits.includes('c1') || hits.includes('c2') || hits.some((h) => h.startsWith('L')), 'retrieves relevant leaf or summary')
})

test('RAPTOR: degenerate input is safe', () => {
  assert.deepEqual(buildRaptorTree([], { embed, summarize }).length, 0)
  const one = buildRaptorTree([{ id: 'x', text: 'cat' }], { embed, summarize })
  assert.equal(one.length, 1, 'single chunk → just the leaf, no infinite recursion')
  assert.deepEqual(raptorRetrieve([], embed('q'), 5), [])
})
