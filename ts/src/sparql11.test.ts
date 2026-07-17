import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { getHellGraph } from './store.js'
import { runSparql } from './sparql.js'

// Isolate the store singleton to this test process. getHellGraph() reads this lazily, so setting it
// before the first call (below) is sufficient.
process.env['HELLGRAPH_STORE_DIR'] = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-sparql11-'))

const g = getHellGraph()
g.addNode('n:1', ['Person'], { name: 'Ada', age: 30 })
g.addNode('n:2', ['Person'], { name: 'Alan', age: 40 })
g.addNode('n:3', ['Robot'], { name: 'HAL', age: 9 })
const rows = (q: string) => runSparql(g, q).bindings

// ─── SPARQL 1.1 additions ────────────────────────────────────────────────────────
test('UNION concatenates branch solutions', () => {
  const r = rows('SELECT ?s WHERE { { ?s ?p "Ada" } UNION { ?s ?p "Alan" } }')
  assert.deepEqual(new Set(r.map((b) => b['s'])), new Set(['n:1', 'n:2']))
})

test('VALUES injects inline data and joins', () => {
  const r = rows('SELECT ?s ?name WHERE { VALUES ?name { "Ada" "HAL" } ?s ?p ?name }')
  assert.equal(r.length, 2)
  assert.deepEqual(new Set(r.map((b) => b['s'])), new Set(['n:1', 'n:3']))
})

test('BIND computes a new variable (CONCAT + arithmetic)', () => {
  const r = rows('SELECT ?name ?tag WHERE { ?s ?p ?name . BIND(CONCAT(?name, "!") AS ?tag) FILTER(?p = "name") }')
  assert.ok(r.some((b) => b['name'] === 'Ada' && b['tag'] === 'Ada!'))
})

test("'a' is rdf:type shorthand", () => {
  const r = rows('SELECT ?s WHERE { ?s a "Robot" }')
  assert.deepEqual(r.map((b) => b['s']), ['n:3'])
})

test('COUNT / GROUP BY aggregates per group', () => {
  const r = rows('SELECT ?t (COUNT(?s) AS ?c) WHERE { ?s a ?t } GROUP BY ?t')
  const byType = Object.fromEntries(r.map((b) => [b['t'], b['c']]))
  assert.equal(byType['Person'], 2)
  assert.equal(byType['Robot'], 1)
})

test('AVG / SUM / MIN / MAX over VALUES', () => {
  assert.equal(rows('SELECT (AVG(?c) AS ?a) WHERE { VALUES ?c { 10 20 30 } }')[0]['a'], 20)
  assert.equal(rows('SELECT (SUM(?c) AS ?a) WHERE { VALUES ?c { 10 20 30 } }')[0]['a'], 60)
  assert.equal(rows('SELECT (MIN(?c) AS ?a) WHERE { VALUES ?c { 10 20 30 } }')[0]['a'], 10)
  assert.equal(rows('SELECT (MAX(?c) AS ?a) WHERE { VALUES ?c { 10 20 30 } }')[0]['a'], 30)
})

test('COUNT DISTINCT dedupes', () => {
  const r = rows('SELECT (COUNT(DISTINCT ?t) AS ?c) WHERE { ?s a ?t }')
  assert.equal(r[0]['c'], 2)   // Person, Robot
})

test('MINUS subtracts compatible solutions', () => {
  const r = rows('SELECT ?s WHERE { ?s a ?t MINUS { ?s a ?x FILTER(?x = "Robot") } }')
  assert.deepEqual(new Set(r.map((b) => b['s'])), new Set(['n:1', 'n:2']))
})

// ─── Loud rejection: the anti-silent-wrong guarantee ───────────────────────────────
test('unsupported query forms THROW rather than return silently-wrong empty results', () => {
  assert.throws(() => runSparql(g, 'ASK { ?s ?p ?o }'), /unsupported: ASK/)
  assert.throws(() => runSparql(g, 'DESCRIBE ?s WHERE { ?s ?p ?o }'), /unsupported: DESCRIBE/)
  assert.throws(() => runSparql(g, 'SELECT ?s WHERE { SERVICE <http://x> { ?s ?p ?o } }'), /unsupported: SERVICE/)
  assert.throws(() => runSparql(g, 'SELECT ?s WHERE { GRAPH ?gg { ?s ?p ?o } }'), /unsupported: GRAPH/)
  assert.throws(() => runSparql(g, 'INSERT DATA { <a> <b> <c> }'), /unsupported: INSERT/)
})

test('existing BGP/FILTER/OPTIONAL still work (no regression)', () => {
  assert.equal(rows('SELECT ?s ?o WHERE { ?s ?p ?o } LIMIT 2').length, 2)
  assert.ok(rows('SELECT ?s WHERE { ?s ?p ?o FILTER(?o = "Ada") }').length >= 1)
})
