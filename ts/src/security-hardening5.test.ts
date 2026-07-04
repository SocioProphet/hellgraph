import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AtomSpace } from './atomspace.js'
import { HellGraphStore } from './store.js'
import { runSparql } from './sparql.js'
import { parseAtomese } from './atomese.js'
import { parseTurtle } from './turtle.js'

// ─── Epoch 3 (cross-lane): parsers on the super-peer /query surface take untrusted input ─────
// These attack the ORIGINAL engine / concurrent-agent parsers (not my lane), as the user
// authorized ("don't stay in your lane"). Each proves the exploit is now blocked.

// ─── Attack 10: user-regex ReDoS via SPARQL FILTER regex (HIGH — hangs the super-peer) ──────
test('SECURITY: SPARQL FILTER regex rejects catastrophic-backtracking patterns (no ReDoS hang)', () => {
  const g = new HellGraphStore(new AtomSpace('sec-redos', false))
  // A value that forces catastrophic backtracking on `(a+)+$`: many a's then a non-a.
  g.addNode('n1', ['Doc'], { payload: 'a'.repeat(60) + '!' })

  const q = 'SELECT ?x WHERE { ?s payload ?x FILTER( regex(?x, "(a+)+$") ) }'
  const t0 = Date.now()
  const r = runSparql(g, q)
  const ms = Date.now() - t0
  // Without the guard, `new RegExp('(a+)+$').test('aaa…a!')` backtracks ~2^60 → minutes/hangs.
  assert.ok(ms < 1000, `ReDoS pattern must not hang (took ${ms}ms)`)
  assert.equal(r.bindings.length, 0, 'nested-quantifier pattern is rejected → no match (fail-safe)')
})

test('SECURITY: SPARQL FILTER regex still runs benign patterns', () => {
  const g = new HellGraphStore(new AtomSpace('sec-redos-ok', false))
  g.addNode('n1', ['Doc'], { payload: 'hello world' })
  const r = runSparql(g, 'SELECT ?x WHERE { ?s payload ?x FILTER( regex(?x, "^hel") ) }')
  assert.equal(r.bindings.length, 1, 'a safe, linear pattern matches normally')
})

// ─── Attack 11: SPARQL FILTER deep nesting → parse-time + eval-time stack overflow ──────────
test('SECURITY: SPARQL rejects a deeply-nested FILTER expression (stack-overflow DoS)', () => {
  const g = new HellGraphStore(new AtomSpace('sec-filter-depth', false))
  const deep = 'FILTER(' + '('.repeat(600) + '?x = ?x' + ')'.repeat(600) + ')'
  const q = `SELECT ?x WHERE { ?s p ?x ${deep} }`
  assert.throws(() => runSparql(g, q), /FILTER expression nesting too deep/)
})

// ─── Attack 12: Atomese deep nesting → recursive-descent stack overflow (no recovery catch) ──
test('SECURITY: parseAtomese rejects deeply-nested s-expressions with a clean error (not a raw stack overflow)', () => {
  const as = new AtomSpace('sec-atomese-depth', false)
  const bomb = '(f '.repeat(700) + 'x' + ')'.repeat(700)
  assert.throws(() => parseAtomese(as, bomb), /expression nesting too deep/)
})

// ─── Attack 13: Turtle deep nesting → recursive-descent stack overflow ───────────────────────
test('SECURITY: parseTurtle bounds deeply-nested terms and returns promptly (no hang/crash)', () => {
  // A pathologically-nested RDF collection as an object.
  const bomb = '<urn:s> <urn:p> ' + '('.repeat(20000) + ')'.repeat(20000) + ' .'
  const t0 = Date.now()
  const triples = parseTurtle(bomb) // statement-level catch recovers; depth guard bounds the stack
  const ms = Date.now() - t0
  assert.ok(Array.isArray(triples), 'parser returns without crashing')
  assert.ok(ms < 2000, `deep-nesting parse must not hang (took ${ms}ms)`)
})
