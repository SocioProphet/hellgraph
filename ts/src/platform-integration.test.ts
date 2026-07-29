import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AtomSpace } from './atomspace'
import { HellGraphStore } from './store'
import { loadKkoIntoAtomSpace, KKO_NS } from './kko'
import { loadReferenceConcepts, mapEntityToKko } from './kko-rc'
import { enrichClass } from './enrich'
import { exploreFrom } from './explore'

const kko = (local: string): string => KKO_NS + local

// End-to-end: the whole KG platform composed on ONE graph — KKO upper TBox + reference-concept ABox +
// entity typing + coherence-activated enrichment + guided exploration. Unit tests prove each piece; this
// proves they COMPOSE, which is where integration regressions hide.
test('platform integration: KKO + RC typing + coherent enrichment + exploration on one graph', () => {
  const as = new AtomSpace('platform-integration', false)
  const store = new HellGraphStore(as)

  // 1) KKO upper ontology → type lattice + graph; subsumption is live
  assert.equal(loadKkoIntoAtomSpace(as).classes, 168)
  assert.ok(as.types.isA(kko('Suchness'), kko('Monads')), 'KKO subsumption works')

  // 2) a reference-concept ABox typing down to KKO (with an altLabel)
  loadReferenceConcepts(store, `@prefix rc: <http://kbpedia.org/kko/rc/> .
@prefix kko: <http://kbpedia.org/ontologies/kko#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
rc:Physician a owl:Class ; rdfs:subClassOf kko:Agents ; skos:prefLabel "physician"@en ; skos:altLabel "doctor"@en .
rc:Gadget a owl:Class ; rdfs:subClassOf kko:Artifacts ; skos:prefLabel "gadget"@en .`)
  // entity typing composes RC → KKO, including via altLabel
  assert.deepEqual(mapEntityToKko(store, 'doctor').kkoTypes, [kko('Agents')])

  // 3) domain data on the SAME graph: a Clinician class (instances type to kko:Agents) + peers
  store.addNode('c1', ['Clinician'], { name: 'physician' })
  store.addNode('c2', ['Clinician'], { name: 'physician' })
  store.addNode('peerA', ['Ent'], { name: 'physician', npi: '123' }) // kko:Agents → coherent with Clinician
  store.addNode('peerB', ['Ent'], { name: 'gadget', serial: 'sn' })  // kko:Artifacts → incoherent
  store.addEdge('treats', 'c1', 'peerA')

  // 4) enrichment auto-activates KKO coherence (RCs present) and the ontologically-fitting attr wins
  const e = enrichClass(store, 'Clinician')
  assert.equal(e.kkoCoherence, true)
  assert.equal(e.recommendation.method, 'rrf(consistency,trust,probabilistic,coherence)')
  const npi = e.recommendation.recommendations.find((x) => x.key === 'npi')!
  const serial = e.recommendation.recommendations.find((x) => x.key === 'serial')!
  assert.ok((npi.signals.coherence ?? 0) > (serial.signals.coherence ?? 0), 'coherent attribute wins on coherence')
  assert.match(e.recommendation.hash, /^sha256:/)

  // 5) exploration navigates the same graph, proof-carrying
  const ex = exploreFrom(store, ['c1'])
  assert.ok(ex.suggestions.some((s) => s.id === 'peerA'), 'the treats-neighbour surfaces as a suggestion')
  assert.match(ex.hash, /^sha256:/)
})
