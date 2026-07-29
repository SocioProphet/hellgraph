import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AtomSpace } from './atomspace'
import { HellGraphStore } from './store'
import { parseReferenceConcepts, loadReferenceConcepts, kkoTypesOf, mapEntityToKko, buildRcLabelIndex, buildRcEmbeddingIndex, mapEntityToKkoSemantic, materializeKkoTypes, entityKkoTypes, RC_NS, RC_LABEL } from './kko-rc'
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

test('semantic mapping resolves synonyms via embeddings; exact still wins; below-threshold → none', async () => {
  const store = new HellGraphStore(new AtomSpace('rc-sem', false))
  loadReferenceConcepts(store, `@prefix rc: <http://kbpedia.org/kko/rc/> .
@prefix kko: <http://kbpedia.org/ontologies/kko#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
rc:Doctor a owl:Class ; rdfs:subClassOf kko:Agents ; skos:prefLabel "doctor"@en .
rc:Gadget a owl:Class ; rdfs:subClassOf kko:Artifacts ; skos:prefLabel "gadget"@en .`)
  // deterministic fake embedder: physician ≈ doctor, gadget orthogonal, unknown fails (empty)
  const VOCAB: Record<string, number[]> = {
    doctor: [1, 0], physician: [0.95, 0.1], gadget: [0, 1], xyzzy: [-1, 0.02],
  }
  const embed = async (t: string): Promise<number[]> => VOCAB[t.toLowerCase().trim()] ?? []
  const idx = await buildRcEmbeddingIndex(store, embed)
  assert.equal(idx.embedded, 2)
  // synonym miss on exact → resolved semantically to Doctor → kko:Agents
  const m = await mapEntityToKkoSemantic(store, 'physician', idx, embed)
  assert.equal(m.via, 'semantic')
  assert.equal(m.matched, rc('Doctor'))
  assert.ok((m.similarity ?? 0) > 0.9)
  assert.deepEqual(m.kkoTypes, [KKO_NS + 'Agents'])
  // exact match short-circuits (no embedding needed)
  assert.equal((await mapEntityToKkoSemantic(store, 'gadget', idx, embed)).via, 'exact')
  // dissimilar + unembeddable → honest none, no fabricated match
  assert.equal((await mapEntityToKkoSemantic(store, 'xyzzy', idx, embed)).via, 'none')
  assert.equal((await mapEntityToKkoSemantic(store, 'unknowable', idx, embed)).via, 'none')
})

test('mapEntityToKko types an entity label to its RC + KKO upper types', () => {
  const store = new HellGraphStore(new AtomSpace('rc-map', false))
  loadReferenceConcepts(store, RC_TTL)
  const m = mapEntityToKko(store, 'Cheese')
  assert.equal(m.matched, rc('Cheese'))
  assert.equal(m.prefLabel, 'cheese')
  assert.deepEqual(m.kkoTypes, [KKO_NS + 'Artifacts'])
  assert.equal(m.candidates, 1)
  // normalization: different case / spacing / punctuation still resolves
  const idx = buildRcLabelIndex(store)
  assert.equal(mapEntityToKko(store, "  cow's-milk CHEESE ", idx).matched, rc('CowsMilkCheese'))
  // altLabel match: "cow cheese" is an altLabel of rc:CowsMilkCheese, not its prefLabel
  assert.equal(mapEntityToKko(store, 'cow cheese', idx).matched, rc('CowsMilkCheese'))
  // unknown entity → clean null mapping
  const u = mapEntityToKko(store, 'zzz-nonexistent', idx)
  assert.equal(u.matched, null)
  assert.deepEqual(u.kkoTypes, [])
})

test('materializeKkoTypes writes typedAs edges; entityKkoTypes reads them', () => {
  const store = new HellGraphStore(new AtomSpace('rc-mat', false))
  loadReferenceConcepts(store, RC_TTL)
  store.addNode('c1', ['Client'], { name: 'cheese' })
  store.addNode('c2', ['Client'], { name: 'zzz-unknown' })
  const st = materializeKkoTypes(store, 'Client')
  assert.equal(st.scanned, 2); assert.equal(st.typed, 1); assert.equal(st.edges, 1)
  assert.deepEqual(entityKkoTypes(store, 'c1'), [KKO_NS + 'Artifacts'])  // via the typedAs edge
  assert.deepEqual(entityKkoTypes(store, 'c2'), [])                        // honest untyped
  const before = store.edgeCount(); materializeKkoTypes(store, 'Client')
  assert.equal(store.edgeCount(), before, 'idempotent')
})

test('batched load (forced) equals whole-text load', () => {
  const store = new HellGraphStore(new AtomSpace('rc-batch', false))
  // batchThreshold 1 forces the batched path even on the tiny fixture; results must be identical
  const st = loadReferenceConcepts(store, RC_TTL, { batchThreshold: 1, batchBlocks: 1 })
  assert.equal(st.concepts, 2); assert.equal(st.subClassOfEdges, 2)
  assert.deepEqual(kkoTypesOf(store, rc('CowsMilkCheese')), [KKO_NS + 'Artifacts'])
})
