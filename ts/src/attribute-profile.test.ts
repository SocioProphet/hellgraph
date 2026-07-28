import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AtomSpace } from './atomspace'
import { HellGraphStore } from './store'
import { profileClass, recommendNewAttributes } from './attribute-profile'

function fixture(): HellGraphStore {
  const store = new HellGraphStore(new AtomSpace('attr-profile', false))
  // Persons — carry name + age; p1 knows p2
  store.addNode('p1', ['Person'], { name: 'Ada', age: 30 })
  store.addNode('p2', ['Person'], { name: 'Alan', age: 40 })
  store.addEdge('knows', 'p1', 'p2')
  // Employees — peers (share 'name') that also carry salary + a worksAt relation Persons lack
  store.addNode('e1', ['Employee'], { name: 'Grace', salary: 100 })
  store.addNode('e2', ['Employee'], { name: 'Edsger', salary: 120 })
  store.addNode('acme', ['Org'], {})
  store.addNode('ibm', ['Org'], {})
  store.addEdge('worksAt', 'e1', 'acme')
  store.addEdge('worksAt', 'e2', 'ibm')
  return store
}

test('profileClass summarizes the schema in use (coverage + cardinality)', () => {
  const p = profileClass(fixture(), 'Person')
  assert.equal(p.instances, 2)
  const by = (kind: string, key: string) => p.attributes.find((a) => a.kind === kind && a.key === key)
  const name = by('property', 'name')
  assert.ok(name && name.coverage === 1 && name.distinctValues === 2, 'name: full coverage, 2 distinct values')
  assert.equal(by('property', 'age')!.coverage, 1)
  // p1 -knows-> p2 : out on 1 of 2 persons, in on 1 of 2
  assert.equal(by('relation-out', 'knows')!.coverage, 0.5)
  assert.equal(by('relation-in', 'knows')!.coverage, 0.5)
  // sorted by coverage descending
  assert.ok(p.attributes[0].coverage >= p.attributes[p.attributes.length - 1].coverage)
})

test('recommendNewAttributes ranks peer-common, class-sparse attributes', () => {
  const recs = recommendNewAttributes(fixture(), 'Person')
  const keys = recs.map((r) => `${r.kind}:${r.key}`)
  // Employees (peers, share 'name') carry salary + worksAt that Persons lack → recommended
  assert.ok(keys.includes('property:salary'), 'salary recommended')
  assert.ok(keys.includes('relation-out:worksAt'), 'worksAt recommended')
  // 'name' is already universal in-class → never recommended
  assert.ok(!keys.includes('property:name'), 'name not recommended (already covered in-class)')
  // scores are gap-weighted: salary (ownCoverage 0, peerCoverage 1) scores maximally
  const salary = recs.find((r) => r.key === 'salary')!
  assert.equal(salary.ownCoverage, 0)
  assert.ok(salary.peerCoverage === 1 && salary.score === 1)
})

test('empty / unknown class profiles + recommends cleanly', () => {
  const store = fixture()
  const p = profileClass(store, 'Nonexistent')
  assert.equal(p.instances, 0)
  assert.deepEqual(p.attributes, [])
  assert.deepEqual(recommendNewAttributes(store, 'Nonexistent'), [])
})
