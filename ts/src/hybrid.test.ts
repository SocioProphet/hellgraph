import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AtomSpace } from './atomspace.js'
import { HellGraphStore } from './store.js'
import { BM25Index } from './bm25.js'
import { HnswIndex } from './ann.js'
import { hybridRetrieve } from './hybrid.js'

test('hybridRetrieve: fuses lexical + dense + graph legs into one ranking', () => {
  // lexical
  const bm25 = new BM25Index()
  bm25.add('d1', 'graph database retrieval')
  bm25.add('d2', 'cooking recipe')
  bm25.add('d3', 'graph retrieval fusion')
  // dense
  const dense = new HnswIndex({ seed: 1 })
  dense.add('d1', [1, 0]); dense.add('d2', [0, 1]); dense.add('d3', [0.9, 0.1])
  // graph
  const store = new HellGraphStore(new AtomSpace('hyb', false))
  for (const id of ['d1', 'd3', 'e']) store.addNode(id, ['N'], {})
  store.addEdge('E', 'd1', 'd3'); store.addEdge('E', 'd3', 'e')

  const res = hybridRetrieve({ bm25, dense, store }, {
    text: 'graph retrieval',
    vector: [1, 0],
    seeds: ['d1'],
    topK: 3,
  })
  const ids = res.map((r) => r.id)
  assert.ok(ids.includes('d1') && ids.includes('d3'), 'graph/retrieval docs surface across legs')
  assert.ok(!ids.includes('d2') || ids.indexOf('d2') === ids.length - 1, 'the cooking doc ranks last if at all')
})

test('hybridRetrieve: each leg is optional', () => {
  const bm25 = new BM25Index()
  bm25.add('a', 'alpha beta'); bm25.add('b', 'gamma')
  // lexical-only
  assert.equal(hybridRetrieve({ bm25 }, { text: 'alpha', topK: 1 })[0]!.id, 'a')
  // no parts / no query → empty
  assert.deepEqual(hybridRetrieve({}, { text: 'x' }), [])
  assert.deepEqual(hybridRetrieve({ bm25 }, {}), [])
})

test('hybridRetrieve: MMR rerank path runs', () => {
  const dense = new HnswIndex({ seed: 2 })
  dense.add('a', [1, 0]); dense.add('b', [1, 0]); dense.add('c', [0, 1])
  const vec: Record<string, number[]> = { a: [1, 0], b: [1, 0], c: [0, 1] }
  const res = hybridRetrieve({ dense }, {
    vector: [1, 0],
    topK: 3,
    mmr: { lambda: 0.5, vectorOf: (id) => vec[id] ?? [0, 0] },
  })
  assert.equal(res.length, 3)
  assert.equal(res[0]!.id, 'a', 'most relevant stays first; c (diverse) is promoted over the near-dup b')
  assert.equal(res[1]!.id, 'c')
})
