import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AtomSpace } from './atomspace'
import { HellGraphStore } from './store'
import { exploreFrom } from './explore'

function fixture(): HellGraphStore {
  const store = new HellGraphStore(new AtomSpace('explore', false))
  for (const id of ['a', 'b', 'c', 'd', 'e']) store.addNode(id, ['N'], {})
  // a → b, a → c (direct); b → d, c → e (2-hop from a)
  store.addEdge('rel', 'a', 'b')
  store.addEdge('rel', 'a', 'c')
  store.addEdge('rel', 'b', 'd')
  store.addEdge('rel', 'c', 'e')
  return store
}

test('exploreFrom ranks graph-proximal nodes to explore next (proof-carrying)', () => {
  const ex = exploreFrom(fixture(), ['a'], { topK: 4 })
  assert.equal(ex.method, 'rrf(personalized-pagerank,seed-adjacency)')
  assert.deepEqual(ex.snapshot, { nodes: 5, edges: 4 })
  assert.match(ex.hash, /^sha256:[0-9a-f]{64}$/)
  const ids = ex.suggestions.map((s) => s.id)
  assert.ok(!ids.includes('a'), 'the seed is excluded')
  // direct neighbours (b, c) rank above their 2-hop descendants (d, e)
  assert.ok(ids.indexOf('b') < ids.indexOf('d'), 'b (1-hop) before d (2-hop)')
  assert.ok(ids.indexOf('c') < ids.indexOf('e'), 'c (1-hop) before e (2-hop)')
  // dense 1..n ranks, labels carried through
  assert.deepEqual(ex.suggestions.map((s) => s.rank), ex.suggestions.map((_, i) => i + 1))
  assert.deepEqual(ex.suggestions[0].labels, ['N'])
})

test('the exploration receipt is deterministic', () => {
  assert.equal(exploreFrom(fixture(), ['a']).hash, exploreFrom(fixture(), ['a']).hash)
})

test('a seed with nothing reachable returns an empty, still-sealed exploration', () => {
  const store = new HellGraphStore(new AtomSpace('explore-empty', false))
  store.addNode('lonely', ['N'], {})
  const ex = exploreFrom(store, ['lonely'])
  assert.deepEqual(ex.suggestions, [])
  assert.match(ex.hash, /^sha256:/)
})
