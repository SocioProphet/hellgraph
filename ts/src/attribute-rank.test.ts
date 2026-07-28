import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AtomSpace } from './atomspace'
import { HellGraphStore } from './store'
import { rankAttributeRecommendations } from './attribute-rank'

function fixture(): HellGraphStore {
  const store = new HellGraphStore(new AtomSpace('attr-rank', false))
  store.addNode('p1', ['Person'], { name: 'Ada', age: 30 })
  store.addNode('p2', ['Person'], { name: 'Alan', age: 40 })
  store.addEdge('knows', 'p1', 'p2')
  store.addNode('e1', ['Employee'], { name: 'Grace', salary: 100 })
  store.addNode('e2', ['Employee'], { name: 'Edsger', salary: 120 })
  store.addNode('acme', ['Org'], {})
  store.addNode('ibm', ['Org'], {})
  store.addEdge('worksAt', 'e1', 'acme')
  store.addEdge('worksAt', 'e2', 'ibm')
  return store
}

test('rankAttributeRecommendations fuses three rankers into a proof-carrying receipt', () => {
  const rec = rankAttributeRecommendations(fixture(), 'Person')
  assert.equal(rec.label, 'Person')
  assert.equal(rec.method, 'rrf(consistency,trust,probabilistic)')
  assert.equal(rec.peers, 2)                          // the two Employees (share 'name')
  assert.deepEqual(rec.snapshot, { nodes: 6, edges: 3 })
  assert.match(rec.hash, /^sha256:[0-9a-f]{64}$/)     // proof-carrying

  const keys = rec.recommendations.map((r) => `${r.kind}:${r.key}`)
  assert.ok(keys.includes('property:salary') && keys.includes('relation-out:worksAt'))
  assert.ok(!keys.includes('property:name'), 'universal in-class attribute is never recommended')

  // ranks are dense 1..n; salary's signals are all positive and maxed (present on every peer)
  assert.deepEqual(rec.recommendations.map((r) => r.rank), rec.recommendations.map((_, i) => i + 1))
  const salary = rec.recommendations.find((r) => r.key === 'salary')!
  assert.equal(salary.signals.consistency, 1)         // peerCoverage 1 × gap 1
  assert.equal(salary.signals.trust, 1)               // all peer PageRank mass carries it
  assert.ok(salary.signals.probabilistic > 0 && salary.fusedScore > 0)
})

test('the receipt is deterministic (same graph → same hash)', () => {
  assert.equal(rankAttributeRecommendations(fixture(), 'Person').hash, rankAttributeRecommendations(fixture(), 'Person').hash)
})

test('a class with no peers yields an empty, still-sealed receipt', () => {
  const rec = rankAttributeRecommendations(fixture(), 'Nonexistent')
  assert.equal(rec.peers, 0)
  assert.deepEqual(rec.recommendations, [])
  assert.match(rec.hash, /^sha256:/)
})
