/**
 * SHACL validator + rule-engine tests — seal-the-walls W3.2.
 *
 * Pins validateGraph (target resolution via sh:targetClass / sh:targetSubjectsOf,
 * the property-constraint checkers, violation reporting fields, the conforms
 * flag, SPARQL constraints/rules) and applyRules (sh:SPARQLRule CONSTRUCT
 * derivation written back into the store).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { AtomSpace } from './atomspace.js'
import { HellGraphStore } from './store.js'
import { validateGraph, applyRules } from './shacl.js'

let seq = 0
function freshStore(): HellGraphStore {
  return new HellGraphStore(new AtomSpace(`shacl-test-${seq++}`, false))
}

const PREAMBLE = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix ex: <http://example.org/> .
`

// ─── Conformance + target resolution ─────────────────────────────────────────

test('conforming graph: sh:targetClass shape with satisfied constraints → conforms, no violations', () => {
  const g = freshStore()
  g.addNode('p:ada', ['Person'], { name: 'Ada Lovelace', age: 36 })
  const report = validateGraph(g, PREAMBLE + `
ex:PersonShape a sh:NodeShape ;
  sh:targetClass ex:Person ;
  sh:property [ sh:path ex:name ; sh:minCount 1 ; sh:minLength 3 ] ;
  sh:property [ sh:path ex:age ; sh:datatype xsd:integer ; sh:minInclusive 0 ; sh:maxInclusive 120 ] .
`)
  assert.equal(report.conforms, true)
  assert.deepEqual(report.violations, [])
  assert.equal(report.rulesApplied, 0)
})

test('sh:minCount violation reports shape, focus node, path, constraint and message', () => {
  const g = freshStore()
  g.addNode('p:ghost', ['Person'], {})
  const report = validateGraph(g, PREAMBLE + `
ex:PersonShape a sh:NodeShape ;
  sh:targetClass ex:Person ;
  sh:property [ sh:path ex:name ; sh:minCount 1 ] .
`)
  assert.equal(report.conforms, false)
  assert.equal(report.violations.length, 1)
  const v = report.violations[0]!
  assert.equal(v.focusNode, 'p:ghost')
  assert.equal(v.shape, 'http://example.org/PersonShape')
  assert.equal(v.path, 'http://example.org/name')
  assert.equal(v.constraint, 'sh:minCount')
  assert.equal(v.severity, 'Violation')
  assert.match(v.message, /name/)
})

test('sh:targetSubjectsOf targets exactly the subjects of the property; sh:message overrides', () => {
  const g = freshStore()
  g.addEdge('knows', 'p:bob', 'p:carol') // bob is a subject of knows → targeted, has no name
  g.addNode('p:dave', [], {})            // never a subject of knows → not targeted
  const report = validateGraph(g, PREAMBLE + `
ex:KnowerShape sh:targetSubjectsOf ex:knows ;
  sh:property [ sh:path ex:name ; sh:minCount 1 ; sh:message "knowers must be named" ] .
`)
  assert.equal(report.conforms, false)
  assert.equal(report.violations.length, 1)
  const v = report.violations[0]!
  assert.equal(v.focusNode, 'p:bob')
  assert.equal(v.message, 'knowers must be named')
  assert.equal(v.shape, 'http://example.org/KnowerShape')
})

// ─── Constraint checkers ─────────────────────────────────────────────────────

test('sh:maxCount violation when a node has more values (edges) than allowed', () => {
  const g = freshStore()
  g.addNode('p:ada', ['Person'], { name: 'Ada' })
  g.addEdge('knows', 'p:ada', 'p:alan')
  g.addEdge('knows', 'p:ada', 'p:grace')
  const report = validateGraph(g, PREAMBLE + `
ex:PersonShape a sh:NodeShape ;
  sh:targetClass ex:Person ;
  sh:property [ sh:path ex:knows ; sh:maxCount 1 ] .
`)
  assert.equal(report.conforms, false)
  assert.equal(report.violations.length, 1)
  assert.equal(report.violations[0]!.constraint, 'sh:maxCount')
  assert.equal(report.violations[0]!.focusNode, 'p:ada')
})

test('sh:datatype violation: string where xsd:integer expected (numbers conform)', () => {
  const g = freshStore()
  g.addNode('p:x', ['Person'], { age: 'unknown' })
  g.addNode('p:y', ['Person'], { age: 42 })
  const report = validateGraph(g, PREAMBLE + `
ex:PersonShape a sh:NodeShape ;
  sh:targetClass ex:Person ;
  sh:property [ sh:path ex:age ; sh:datatype xsd:integer ] .
`)
  assert.equal(report.conforms, false)
  assert.equal(report.violations.length, 1)
  const v = report.violations[0]!
  assert.equal(v.focusNode, 'p:x')
  assert.equal(v.constraint, 'sh:datatype')
  assert.equal(v.value, 'unknown')
  assert.match(v.message, /string.+integer/)
})

test('sh:pattern and sh:minLength violations on the same focus node', () => {
  const g = freshStore()
  g.addNode('d:1', ['Doc'], { id: 'foo', title: 'ab' })
  const report = validateGraph(g, PREAMBLE + `
ex:DocShape a sh:NodeShape ;
  sh:targetClass ex:Doc ;
  sh:property [ sh:path ex:id ; sh:pattern "^urn:" ] ;
  sh:property [ sh:path ex:title ; sh:minLength 3 ] .
`)
  assert.equal(report.conforms, false)
  assert.deepEqual(
    new Set(report.violations.map(v => v.constraint)),
    new Set(['sh:pattern', 'sh:minLength']),
  )
  assert.ok(report.violations.every(v => v.focusNode === 'd:1'))
})

test('sh:nodeKind IRI: literal property value violates, edge target conforms', () => {
  const g = freshStore()
  g.addNode('p:lit', ['Person'], { ref: 'just-a-string' })
  g.addNode('p:iri', ['Person'], {})
  g.addEdge('ref', 'p:iri', 'p:target')
  const report = validateGraph(g, PREAMBLE + `
ex:RefShape a sh:NodeShape ;
  sh:targetClass ex:Person ;
  sh:property [ sh:path ex:ref ; sh:nodeKind sh:IRI ] .
`)
  assert.equal(report.violations.length, 1)
  const v = report.violations[0]!
  assert.equal(v.focusNode, 'p:lit')
  assert.equal(v.constraint, 'sh:nodeKind')
  assert.equal(v.value, 'just-a-string')
})

test('sh:in (RDF list) rejects values outside the set; sh:hasValue accepts the required value', () => {
  const g = freshStore()
  g.addNode('l:1', ['Light'], { color: 'purple', state: 'on' })
  const report = validateGraph(g, PREAMBLE + `
ex:LightShape a sh:NodeShape ;
  sh:targetClass ex:Light ;
  sh:property [ sh:path ex:color ; sh:in ( "red" "green" "blue" ) ] ;
  sh:property [ sh:path ex:state ; sh:hasValue "on" ] .
`)
  assert.equal(report.conforms, false)
  assert.equal(report.violations.length, 1)
  const v = report.violations[0]!
  assert.equal(v.constraint, 'sh:in')
  assert.equal(v.value, 'purple')
  assert.match(v.message, /not in allowed set/)
})

test('sh:minInclusive / sh:maxInclusive range violations', () => {
  const g = freshStore()
  g.addNode('p:old', ['Person'], { age: 150 })
  g.addNode('p:neg', ['Person'], { age: -5 })
  const report = validateGraph(g, PREAMBLE + `
ex:AgeShape a sh:NodeShape ;
  sh:targetClass ex:Person ;
  sh:property [ sh:path ex:age ; sh:minInclusive 0 ; sh:maxInclusive 120 ] .
`)
  assert.equal(report.conforms, false)
  assert.equal(report.violations.length, 2)
  const byFocus = new Map(report.violations.map(v => [v.focusNode, v.constraint]))
  assert.equal(byFocus.get('p:old'), 'sh:maxInclusive')
  assert.equal(byFocus.get('p:neg'), 'sh:minInclusive')
})

// ─── SPARQL constraints and rules ────────────────────────────────────────────

test('sh:SPARQLRule CONSTRUCT producing sh:ValidationResult atoms surfaces violations', () => {
  const g = freshStore()
  g.addNode('p:solo', ['Person'], { name: 'Solo' })
  g.addEdge('knows', 'p:solo', 'p:other')
  const report = validateGraph(g, PREAMBLE + `
ex:RuleShape a sh:NodeShape ;
  sh:targetClass ex:Person ;
  sh:rule [ sh:construct """CONSTRUCT { <urn:report> <sh:result> <urn:v1> . <urn:v1> <focusNode> ?s . <urn:v1> <resultMessage> "knows requires mutual follow-back" } WHERE { ?s <knows> ?o }""" ] .
`)
  assert.equal(report.conforms, false)
  const v = report.violations.find(x => x.constraint === 'sh:SPARQLRule')
  assert.ok(v, 'expected a sh:SPARQLRule violation')
  assert.equal(v.focusNode, 'p:solo')
  assert.equal(v.message, 'knows requires mutual follow-back')
})

test('applyRules: CONSTRUCT derivation writes edges back into the store and returns the count', () => {
  const g = freshStore()
  g.addEdge('knows', 'p:ada', 'p:bob')
  g.addEdge('knows', 'p:carol', 'p:bob')
  const n = applyRules(g, PREAMBLE + `
ex:DeriveShape a sh:NodeShape ;
  sh:targetSubjectsOf ex:knows ;
  sh:rule [ sh:construct """CONSTRUCT { ?s <memberOf> <grp:bob-circle> } WHERE { ?s <knows> ?o }""" ] .
`)
  assert.equal(n, 2)
  const members = g.allEdges().filter(e => e.label === 'memberOf')
  assert.equal(members.length, 2)
  assert.deepEqual(new Set(members.map(e => e.from)), new Set(['p:ada', 'p:carol']))
  assert.deepEqual(new Set(members.map(e => e.to)), new Set(['grp:bob-circle']))
})

test('applyRules skips validation-result rules (those belong to validateGraph)', () => {
  const g = freshStore()
  g.addEdge('knows', 'p:ada', 'p:bob')
  const before = g.edgeCount()
  const n = applyRules(g, PREAMBLE + `
ex:CheckShape a sh:NodeShape ;
  sh:targetSubjectsOf ex:knows ;
  sh:rule [ sh:construct """CONSTRUCT { <urn:report> <sh:result> <urn:v1> . <urn:v1> <focusNode> ?s } WHERE { ?s <knows> ?o }""" ] .
`)
  assert.equal(n, 0)
  assert.equal(g.edgeCount(), before, 'no triples written by a validation rule')
})

// ─── Negative paths ──────────────────────────────────────────────────────────

test('negative: broken SPARQL inside sh:sparql surfaces a clear eval-error entry, not a silent pass', () => {
  const g = freshStore()
  g.addNode('p:x', ['Person'], { name: 'X' })
  const report = validateGraph(g, PREAMBLE + `
ex:BadShape a sh:NodeShape ;
  sh:targetClass ex:Person ;
  sh:sparql [ sh:select "THIS IS NOT SPARQL AT ALL" ] .
`)
  assert.equal(report.conforms, false)
  assert.equal(report.violations.length, 1)
  const v = report.violations[0]!
  assert.equal(v.constraint, 'sh:SPARQLConstraint')
  assert.match(v.message, /eval error/i)
})

test('KNOWN GAP: unparseable shapes text is error-recovered to zero shapes → vacuous conforms:true', () => {
  // parseTurtle() recovers from syntax errors by skipping to the next '.', so
  // garbage input yields ZERO shapes and validateGraph reports conforms:true
  // with no violations — callers cannot distinguish "graph is valid" from
  // "shapes file didn't parse". This pins the CURRENT behavior so the day a
  // strict-parse guard lands in shacl.ts, this test fails loudly and must be
  // flipped to assert the error. (shacl.ts is outside this change's lane.)
  const g = freshStore()
  g.addNode('p:x', ['Person'], {})
  const report = validateGraph(g, '¡this is @@ not turtle;;; at all')
  assert.equal(report.conforms, true)
  assert.deepEqual(report.violations, [])
})
