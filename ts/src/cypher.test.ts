import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AtomSpace } from './atomspace'
import { runCypher } from './cypher'

// Build a small CSKG-shaped AtomSpace:
//   EvaluationLink(PredicateNode REL, ListLink(ConceptNode a, ConceptNode b))
function edge(as: AtomSpace, rel: string, a: string, b: string): void {
  const an = as.addNode('ConceptNode', a).handle
  const bn = as.addNode('ConceptNode', b).handle
  const pred = as.addNode('PredicateNode', rel).handle
  const list = as.addLink('ListLink', [an, bn]).handle
  as.addLink('EvaluationLink', [pred, list])
}

function fixture(): AtomSpace {
  const as = new AtomSpace('cypher-test', false)
  edge(as, 'IsA', 'rain', 'weather_event')
  edge(as, 'IsA', 'snow', 'weather_event')
  edge(as, 'RelatedTo', 'rain', 'wet')
  edge(as, 'RelatedTo', 'wet', 'moist')
  return as
}

test('1-hop MATCH with WHERE pin + LIMIT', () => {
  const as = fixture()
  const r = runCypher(as, 'MATCH (a)-[:IsA]->(b) WHERE a.form = "rain" RETURN b LIMIT 25')
  assert.deepEqual(r.columns, ['b'])
  assert.deepEqual(r.rows, [{ b: 'weather_event' }])
  assert.match(r.queryHash, /^sha256:[0-9a-f]{64}$/)
})

test('inline {form:"..."} pin works like WHERE', () => {
  const as = fixture()
  const r = runCypher(as, 'MATCH (a {form:"rain"})-[:RelatedTo]->(b) RETURN b LIMIT 10')
  assert.deepEqual(r.rows, [{ b: 'wet' }])
})

test('variable-length *1..2 does bounded multi-hop (the CSKG query)', () => {
  const as = fixture()
  const r = runCypher(as, 'MATCH (a)-[:RelatedTo*1..2]->(b) WHERE a.form = "rain" RETURN b LIMIT 25')
  const got = r.rows.map((x) => x.b).sort()
  assert.deepEqual(got, ['moist', 'wet'])   // 1-hop wet, 2-hop moist
})

test('multi-row projection RETURN a, b', () => {
  const as = fixture()
  const r = runCypher(as, 'MATCH (a)-[:IsA]->(b) RETURN a, b LIMIT 25')
  assert.deepEqual(r.columns, ['a', 'b'])
  const pairs = r.rows.map((x) => `${x.a}->${x.b}`).sort()
  assert.deepEqual(pairs, ['rain->weather_event', 'snow->weather_event'])
})

test('$param binding', () => {
  const as = fixture()
  const r = runCypher(as, 'MATCH (a)-[:IsA]->(b) WHERE a.form = $lemma RETURN b LIMIT 5', { lemma: 'snow' })
  assert.deepEqual(r.rows, [{ b: 'weather_event' }])
})

test('native MATCH LINK over an n-ary hyperedge', () => {
  const as = new AtomSpace('cypher-link', false)
  const p = as.addNode('ConceptNode', 'alice').handle
  const k = as.addNode('ConceptNode', 'key7').handle
  const art = as.addNode('ConceptNode', 'doc1').handle
  const svc = as.addNode('ConceptNode', 'vault').handle
  as.addLink('Decrypt', [p, k, art, svc])
  const r = runCypher(as, 'MATCH LINK d:Decrypt(caller=p, key=k, artifact=a, service=s) RETURN p, k LIMIT 5')
  assert.deepEqual(r.rows, [{ p: 'alice', k: 'key7' }])
})

test('EXPLAIN returns a plan and needs no LIMIT', () => {
  const as = fixture()
  const r = runCypher(as, 'EXPLAIN MATCH (a)-[:IsA]->(b) RETURN b')
  assert.ok(r.plan && r.plan.length >= 1)
  assert.equal(r.rows.length, 0)
})

test('onEvidence hook emits a receipt-spine record', () => {
  const as = fixture()
  let ev: unknown = null
  runCypher(as, 'MATCH (a)-[:IsA]->(b) RETURN b LIMIT 5', {}, { onEvidence: (e) => { ev = e } })
  assert.ok(ev)
  const e = ev as { queryHash: string; rowCount: number; evaluatedAtSeq: number; space: string }
  assert.match(e.queryHash, /^sha256:/)
  assert.equal(e.space, 'cypher-test')
})

// ─── Relationship TruthValue projection + filter + ORDER BY ─────────────────────

function weighted(): AtomSpace {
  // rain RelatedTo wet (conf high), rain RelatedTo dry (conf low)
  const as = new AtomSpace('cypher-tv', false)
  const mk = (rel: string, a: string, b: string, conf: number) => {
    const an = as.addNode('ConceptNode', a).handle
    const bn = as.addNode('ConceptNode', b).handle
    const pred = as.addNode('PredicateNode', rel).handle
    const list = as.addLink('ListLink', [an, bn]).handle
    as.addLink('EvaluationLink', [pred, list], { tv: { strength: 1, confidence: conf } })
  }
  mk('RelatedTo', 'rain', 'wet', 0.9)
  mk('RelatedTo', 'rain', 'dry', 0.1)
  return as
}

test('bound relationship exposes edge TruthValue as r.confidence', () => {
  const as = weighted()
  const r = runCypher(as, 'MATCH (a)-[r:RelatedTo]->(b) WHERE a.form = "rain" RETURN b, r.confidence LIMIT 25')
  const map = Object.fromEntries(r.rows.map((x) => [x.b, x['r.confidence']]))
  assert.equal(map.wet, '0.9')
  assert.equal(map.dry, '0.1')
})

test('WHERE comparison filters on edge confidence', () => {
  const as = weighted()
  const r = runCypher(as, 'MATCH (a)-[r:RelatedTo]->(b) WHERE a.form = "rain" AND r.confidence > 0.5 RETURN b LIMIT 25')
  assert.deepEqual(r.rows, [{ b: 'wet' }])
})

test('ORDER BY r.confidence DESC ranks commonsense edges', () => {
  const as = weighted()
  const r = runCypher(as, 'MATCH (a)-[r:RelatedTo]->(b) WHERE a.form = "rain" RETURN b ORDER BY r.confidence DESC LIMIT 25')
  assert.deepEqual(r.rows.map((x) => x.b), ['wet', 'dry'])
})

// ─── Sentinel policy (bounded, read-only) ──────────────────────────────────────

test('mutation clauses are refused (read-only v0.1)', () => {
  const as = fixture()
  assert.throws(() => runCypher(as, 'CREATE (a:Concept {form:"x"}) RETURN a LIMIT 1'), /read-only/)
})

test('unbounded variable-length is rejected', () => {
  const as = fixture()
  assert.throws(() => runCypher(as, 'MATCH (a)-[:RelatedTo*1..]->(b) RETURN b LIMIT 5'), /unbounded/)
})

test('hop count over maxHops is rejected', () => {
  const as = fixture()
  assert.throws(() => runCypher(as, 'MATCH (a)-[:RelatedTo*1..5]->(b) RETURN b LIMIT 5'), /exceeds maxHops/)
})

test('missing LIMIT is rejected (Sentinel)', () => {
  const as = fixture()
  assert.throws(() => runCypher(as, 'MATCH (a)-[:IsA]->(b) RETURN b'), /LIMIT is required/)
})

test('allowWrite opt-in lets a write parse without refusal', () => {
  const as = fixture()
  // Not executing writes in v0.1, but the guard should not throw when opted in.
  assert.doesNotThrow(() => runCypher(as, 'MATCH (a)-[:IsA]->(b) SET a.x = "1" RETURN b LIMIT 1', {}, { allowWrite: true }))
})
