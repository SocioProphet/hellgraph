import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AtomSpace } from './atomspace'
import { HellGraphStore } from './store'
import { loadReferenceConcepts } from './kko-rc'
import { enrichClass } from './enrich'

function personFixture(): HellGraphStore {
  const store = new HellGraphStore(new AtomSpace('enrich', false))
  store.addNode('p1', ['Person'], { name: 'Ada' })
  store.addNode('p2', ['Person'], { name: 'Alan' })
  store.addNode('e1', ['Employee'], { name: 'Grace', salary: 100 }) // peer (shares name), extra salary
  return store
}

test('enrichClass composes profile + ranked recommendation (3-ranker without RCs)', () => {
  const r = enrichClass(personFixture(), 'Person')
  assert.equal(r.profile.instances, 2)
  assert.equal(r.recommendation.method, 'rrf(consistency,trust,probabilistic)')
  assert.equal(r.kkoCoherence, false)
  assert.match(r.recommendation.hash, /^sha256:/)
  assert.ok(r.recommendation.recommendations.some((x) => x.key === 'salary'))
})

const RC_TTL = `@prefix rc: <http://kbpedia.org/kko/rc/> .
@prefix kko: <http://kbpedia.org/ontologies/kko#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
rc:Doctor a owl:Class ; rdfs:subClassOf kko:Agents ; skos:prefLabel "doctor"@en .
rc:Widget a owl:Class ; rdfs:subClassOf kko:Artifacts ; skos:prefLabel "widget"@en .`

test('enrichClass auto-activates KKO coherence when reference concepts are loaded', () => {
  const store = new HellGraphStore(new AtomSpace('enrich-kko', false))
  loadReferenceConcepts(store, RC_TTL)
  // Person instances named "doctor" → typed kko:Agents; a coherent peer (doctor) + an incoherent one (widget)
  store.addNode('p1', ['Person'], { name: 'doctor' })
  store.addNode('p2', ['Person'], { name: 'doctor' })
  store.addNode('a1', ['P'], { name: 'doctor', email: 'e' })  // → kko:Agents (coherent with Person)
  store.addNode('x1', ['P'], { name: 'widget', serial: 's' }) // → kko:Artifacts (incoherent)

  const r = enrichClass(store, 'Person')
  assert.equal(r.kkoCoherence, true)
  assert.equal(r.recommendation.method, 'rrf(consistency,trust,probabilistic,coherence)')
  const email = r.recommendation.recommendations.find((x) => x.key === 'email')!
  const serial = r.recommendation.recommendations.find((x) => x.key === 'serial')!
  assert.equal(email.signals.coherence, 1)   // peer shares Person's KKO type (Agents)
  assert.equal(serial.signals.coherence, 0)  // peer is a different type (Artifacts)
})

test('autoKkoCoherence:false opts out even with RCs present', () => {
  const store = new HellGraphStore(new AtomSpace('enrich-optout', false))
  loadReferenceConcepts(store, RC_TTL)
  store.addNode('p1', ['Person'], { name: 'doctor' })
  store.addNode('e1', ['P'], { name: 'doctor', email: 'e' })
  const r = enrichClass(store, 'Person', { autoKkoCoherence: false })
  assert.equal(r.kkoCoherence, false)
  assert.equal(r.recommendation.method, 'rrf(consistency,trust,probabilistic)')
})
