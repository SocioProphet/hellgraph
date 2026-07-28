import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { AtomSpace } from './atomspace'
import { HellGraphStore } from './store'
import { pageRank } from './graph-analytics'
import { parseKko, loadKko, loadKkoIntoAtomSpace, kkoOntology, kkoShort, KKO_NS } from './kko'

const N3_PATH = 'ontology/kko/kko-2.10.n3'
const readN3 = () => readFileSync(N3_PATH, 'utf8')
const kko = (local: string) => KKO_NS + local

test('parseKko extracts the KKO class TBox from the vendored .n3', () => {
  const onto = parseKko(readN3())
  assert.equal(onto.version, 'http://kbpedia.org/kbpedia/v200')
  assert.equal(onto.classes.length, 168)
  const edges = onto.classes.reduce((n, c) => n + c.subClassOf.length, 0)
  assert.equal(edges, 167)
  assert.ok(onto.classes.every((c) => c.iri.startsWith(KKO_NS)), 'all classes are kko:')
})

test('embedded kkoOntology() is fresh — matches the parsed source (gen not stale)', () => {
  const emb = kkoOntology()
  const src = parseKko(readN3())
  assert.equal(emb.version, src.version)
  assert.equal(emb.classes.length, src.classes.length)
})

test('loadKkoIntoAtomSpace wires KKO subsumption into the type-inheritance lattice', () => {
  const as = new AtomSpace('kko-lattice', false)
  const stats = loadKkoIntoAtomSpace(as)
  assert.equal(stats.classes, 168)
  assert.equal(stats.subClassOfEdges, 167)
  // Peircean transitivity: Suchness ⊂ FirstMonads ⊂ Monads
  assert.ok(as.types.isA(kko('Suchness'), kko('FirstMonads')), 'Suchness ⊂ FirstMonads')
  assert.ok(as.types.isA(kko('Suchness'), kko('Monads')), 'Suchness ⊂ Monads (transitive)')
  assert.ok(!as.types.isA(kko('Monads'), kko('Suchness')), 'subsumption is directed')
  const anc = as.types.ancestors(kko('Suchness'))
  assert.ok(anc.has(kko('FirstMonads')) && anc.has(kko('Monads')), 'ancestors span the chain')
})

test('KKO ABox is queryable through the property-graph façade (the SPARQL/Cypher substrate)', () => {
  const as = new AtomSpace('kko-abox', false)
  const store = new HellGraphStore(as)
  loadKkoIntoAtomSpace(as)
  const classes = store.nodesByLabel('KkoClass')
  assert.equal(classes.length, 168)
  const monads = store.getNode(kko('Monads'))
  assert.equal(monads?.properties['short'], 'kko:Monads')
  assert.equal(monads?.properties['label'], 'monads')
  // subClassOf is a first-class edge: Suchness --rdfs:subClassOf--> FirstMonads
  const parents = store.out(kko('Suchness'), 'rdfs:subClassOf').map((n) => n.id)
  assert.ok(parents.includes(kko('FirstMonads')), 'Suchness --rdfs:subClassOf--> FirstMonads')
})

test('KKO is analyzable by the graph kernels (PageRank runs over the loaded hierarchy)', () => {
  const as = new AtomSpace('kko-pr', false)
  const store = new HellGraphStore(as)
  loadKkoIntoAtomSpace(as)
  const pr = pageRank(store)
  assert.ok(pr.size >= 168, 'every KKO node scored')
  assert.ok((pr.get(kko('Monads')) ?? 0) > 0, 'a KKO root has a PageRank score')
})

test('load is idempotent (content-addressed atoms) + loadKko ingests custom TBox text', () => {
  const as = new AtomSpace('kko-idem', false)
  const s1 = loadKkoIntoAtomSpace(as)
  const before = as.getByType('EvaluationLink', false).length
  const s2 = loadKkoIntoAtomSpace(as) // re-load
  assert.equal(as.getByType('EvaluationLink', false).length, before, 'no duplication on re-load')
  assert.deepEqual(s2, s1)
  const as2 = new AtomSpace('kko-text', false)
  assert.equal(loadKko(as2, readN3()).classes, 168)
})

test('kkoShort renders readable names; passes non-KKO IRIs through', () => {
  assert.equal(kkoShort(kko('Monads')), 'kko:Monads')
  assert.equal(kkoShort('http://example.org/Foo'), 'http://example.org/Foo')
})
