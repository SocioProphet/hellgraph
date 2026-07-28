import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AtomSpace } from './atomspace'
import { HellGraphStore } from './store'
import { parseReferenceConcepts, loadReferenceConcepts, kkoTypesOf, RC_NS, RC_LABEL } from './kko-rc'
import { KKO_NS } from './kko'

// Mirrors the real KBpedia RC format: rc: owl:Class, subClassOf rc:/kko:, skos:prefLabel/altLabel.
const RC_TTL = `@prefix rc: <http://kbpedia.org/kko/rc/> .
@prefix kko: <http://kbpedia.org/ontologies/kko#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
rc:Cheese a owl:Class ; rdfs:subClassOf kko:Artifacts ; skos:prefLabel "cheese"@en .
rc:CowsMilkCheese a owl:Class ; rdfs:subClassOf rc:Cheese ;
  skos:prefLabel "cow's-milk cheese"@en ; skos:altLabel "cow cheese"@en .`

const rc = (local: string) => RC_NS + local

test('parseReferenceConcepts extracts RC classes with labels + superclasses', () => {
  const rcs = parseReferenceConcepts(RC_TTL)
  assert.equal(rcs.length, 2)
  const cmc = rcs.find((r) => r.iri === rc('CowsMilkCheese'))!
  assert.equal(cmc.prefLabel, "cow's-milk cheese")
  assert.deepEqual(cmc.altLabels, ['cow cheese'])
  assert.deepEqual(cmc.subClassOf, [rc('Cheese')])
})

test('loadReferenceConcepts ingests the ABox; kkoTypesOf rolls RCs up to KKO', () => {
  const store = new HellGraphStore(new AtomSpace('rc-load', false))
  const stats = loadReferenceConcepts(store, RC_TTL)
  assert.equal(stats.concepts, 2)
  assert.equal(stats.subClassOfEdges, 2)
  assert.equal(store.nodesByLabel(RC_LABEL).length, 2)
  assert.equal(store.getNode(rc('Cheese'))?.properties['prefLabel'], 'cheese')
  // rc:CowsMilkCheese ⊂ rc:Cheese ⊂ kko:Artifacts → resolves through the RC chain to the KKO upper type
  assert.deepEqual(kkoTypesOf(store, rc('CowsMilkCheese')), [KKO_NS + 'Artifacts'])
  assert.deepEqual(kkoTypesOf(store, rc('Cheese')), [KKO_NS + 'Artifacts'])
})

test('load is idempotent (content-addressed edges)', () => {
  const store = new HellGraphStore(new AtomSpace('rc-idem', false))
  loadReferenceConcepts(store, RC_TTL)
  const before = store.edgeCount()
  loadReferenceConcepts(store, RC_TTL)
  assert.equal(store.edgeCount(), before)
})
