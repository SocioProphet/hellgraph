import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AtomSpace } from './atomspace'
import { HellGraphStore } from './store'
import { runSparql } from './sparql'
import { runCypher } from './cypher'

/**
 * Projection-parity suite — faithful-projection CI for the engine's DUAL PROJECTIONS.
 *
 * Lesson (topology / dual-graph information loss): every projection of a richer structure loses
 * something, and the loss is only safe when it is DOCUMENTED and TESTED. The estate already got
 * burned here once: raw AtomSpace `InheritanceLink` atoms are invisible to the property-graph
 * façade, so a hierarchy written the "native" way silently vanished from SPARQL/Cypher/analytics.
 * kko.ts is the canonical fix: loadKkoIntoAtomSpace writes the hierarchy BOTH ways — declaring the
 * type lattice natively AND writing `store.addEdge('rdfs:subClassOf', …)` façade edges in the same
 * EvaluationLink shape the façade projects — precisely so the hierarchy is queryable everywhere.
 *
 * This suite pins the parity contract for graphs built VIA THE FAÇADE (the supported write path):
 *   façade (allNodes/allEdges/out) ⇄ triples() RDF view ⇄ SPARQL ⇄ Cypher must agree exactly.
 * It also characterizes the KNOWN-lossy directions so any change in the loss surface is loud:
 *   • raw AtomSpace links (e.g. InheritanceLink) do NOT project — by design; see kko.ts.
 *   • edge PROPERTIES do not appear in triples() — plain triples cannot carry edge attributes
 *     without RDF reification; this matches store.ts's documented mapping (labels + node props +
 *     one triple per edge, nothing else).
 *   • PINNED GAP (genuine parity bug, characterized below): store.edgeCount() counts
 *     EvaluationLink atoms BY TYPE, so a malformed EvaluationLink written through the atomspace()
 *     escape hatch is counted even though allEdges()/triples()/SPARQL/Cypher all (correctly)
 *     refuse to project it — edgeCount() over-reports vs every queryable surface.
 */

function fixture(): { g: HellGraphStore; as: AtomSpace } {
  const as = new AtomSpace('parity-test', false)
  const g = new HellGraphStore(as)
  g.addNode('alice', ['Person'], { name: 'Alice', age: 34 })
  g.addNode('bob', ['Person'], { name: 'Bob' })
  g.addNode('carol', ['Person', 'Admin'], { name: 'Carol' })
  g.addEdge('knows', 'alice', 'bob', { since: 2020 })   // edge property: documented-lossy in triples()
  g.addEdge('knows', 'bob', 'carol')
  g.addEdge('manages', 'alice', 'carol')
  return { g, as }
}

const tripleKey = (s: string, p: string, o: unknown, iri: boolean): string => `${s} |${p}| ${String(o)} |${iri}`

test('(a) triples() carries EXACTLY the facts the façade reports — no omissions, no extras', () => {
  const { g } = fixture()
  // Expected multiset, derived from the façade's own reports under the documented mapping:
  // one rdf:type triple per node label, one literal triple per node property, one IRI triple per
  // edge — and NOTHING for edge properties (RDF triples cannot carry them without reification).
  const expected: string[] = []
  for (const n of g.allNodes()) {
    for (const label of n.labels) expected.push(tripleKey(n.id, 'rdf:type', label, false))
    for (const [k, v] of Object.entries(n.properties)) expected.push(tripleKey(n.id, k, v, false))
  }
  for (const e of g.allEdges()) expected.push(tripleKey(e.from, e.label, e.to, true))
  const actual = g.triples().map((t) => tripleKey(t.subject, t.predicate, t.object, t.isIri))
  assert.deepEqual(actual.sort(), expected.sort())
})

test('(b) SPARQL agrees with the store: edge count and subject coverage', () => {
  const { g } = fixture()
  const count = runSparql(g, 'SELECT (COUNT(?s) AS ?c) WHERE { ?s ?p ?o FILTER(?p = "knows" || ?p = "manages") }')
  assert.equal(count.bindings[0]!['c'], g.edgeCount(), 'SPARQL count over edge predicates === store.edgeCount()')
  const subjects = new Set(runSparql(g, 'SELECT DISTINCT ?s WHERE { ?s ?p ?o }').bindings.map((b) => b['s']))
  for (const n of g.allNodes()) {
    assert.ok(subjects.has(n.id), `SPARQL distinct subjects must include node ${n.id}`)
  }
})

test('(c) Cypher MATCH over an edge label returns the same pairs as store.out()', () => {
  const { g, as } = fixture()
  const viaCypher = runCypher(as, 'MATCH (a)-[:knows]->(b) RETURN a, b LIMIT 100')
    .rows.map((r) => `${r['a']}->${r['b']}`).sort()
  const viaFacade = g.allNodes()
    .flatMap((n) => g.out(n.id, 'knows').map((t) => `${n.id}->${t.id}`)).sort()
  assert.deepEqual(viaCypher, viaFacade)
  assert.deepEqual(viaFacade, ['alice->bob', 'bob->carol'], 'and both match the fixture ground truth')
})

test('(d) KNOWN-LOSSY direction: raw AtomSpace InheritanceLink does NOT project to the façade', () => {
  const { g, as } = fixture()
  const before = { edges: g.edgeCount(), triples: g.triples().length }
  // Write a hierarchy the "native" way — the exact pattern that burned the estate.
  const cat = as.addNode('ConceptNode', 'cat').handle
  const animal = as.addNode('ConceptNode', 'animal').handle
  as.addLink('InheritanceLink', [cat, animal])
  // Invisible on EVERY projection surface (characterized, so a change in the loss surface is loud).
  assert.equal(g.edgeCount(), before.edges, 'edgeCount blind to InheritanceLink')
  assert.equal(g.triples().filter((t) => t.subject === 'cat' && t.isIri).length, 0, 'no RDF triple projected')
  assert.equal(runCypher(as, 'MATCH (a)-[:InheritanceLink]->(b) RETURN a, b LIMIT 10').rows.length, 0, 'Cypher blind')
  // The supported pattern (kko.ts): ALSO write a façade edge; then every surface sees it.
  g.addEdge('rdfs:subClassOf', 'cat', 'animal')
  assert.equal(g.edgeCount(), before.edges + 1)
  assert.equal(g.triples().filter((t) => t.subject === 'cat' && t.isIri).length, 1)
})

test('(e) PINNED PARITY GAP: edgeCount() counts a malformed EvaluationLink the projections refuse', () => {
  const { g, as } = fixture()
  const wellFormed = g.allEdges().length
  assert.equal(g.edgeCount(), wellFormed, 'in agreement while all EvaluationLinks are well-formed')
  // Escape-hatch write: an EvaluationLink WITHOUT the (PredicateNode, ListLink) shape.
  const x = as.addNode('ConceptNode', 'x').handle
  const y = as.addNode('ConceptNode', 'y').handle
  as.addLink('EvaluationLink', [x, y])
  // CHARACTERIZATION of the current bug — deliberately loud: if edgeCount() is ever fixed to count
  // only projectable edges (or projection changes), this test fails and forces a conscious update.
  assert.equal(g.allEdges().length, wellFormed, 'projection (correctly) refuses the malformed link')
  assert.equal(
    runSparql(g, 'SELECT (COUNT(?s) AS ?c) WHERE { ?s ?p ?o FILTER(?p = "knows" || ?p = "manages") }').bindings[0]!['c'],
    wellFormed,
    'SPARQL agrees with allEdges()',
  )
  assert.equal(g.edgeCount(), wellFormed + 1,
    'KNOWN GAP: edgeCount() counts EvaluationLink atoms by TYPE and over-reports vs every queryable surface')
})
