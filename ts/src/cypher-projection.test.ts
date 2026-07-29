/**
 * Cypher label-matching and RETURN-value projection.
 *
 * projection-parity.test.ts (0.4.43) compares whether the surfaces AGREE THAT A THING EXISTS.
 * It never compared what a surface RENDERS. That blind spot hid a live defect: nodes written
 * through the facade matched `MATCH (n:Label)` but every projected value came back as ''.
 * Cause: the facade stores properties namespaced in atom Values (`prop:price`), and the
 * projection emitted the raw key, so `n.price` — what every query actually asks for — was
 * never a key at all. Found in production on the market-replay MarketDataEvent stream.
 *
 * Three independent causes produced that one row of empty strings (all fixed in 0.4.45):
 *   1. a node-only pattern compiled to ZERO clauses, which the matcher satisfies with one empty
 *      binding — the "1 row, every value ''" signature;
 *   2. a Cypher label compiled to an atom TYPE, but the facade stores labels in `graph:labels`,
 *      so a label never matched a facade-written node (0 rows once an edge was in the pattern);
 *   3. properties projected only under their namespaced key, so `n.price` was never a column.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HellGraphStore } from './store.js'
import { AtomSpace } from './atomspace.js'
import { runCypher } from './cypher.js'

function fixture() {
  const as = new AtomSpace('cypher-projection-test', false)
  const g = new HellGraphStore(as)
  g.addNode('mde-1', ['MarketDataEvent'], { eventId: 'mde-1', symbol: 'SP:AAA', price: 74.26, volume: 546 })
  g.addNode('mde-2', ['MarketDataEvent'], { eventId: 'mde-2', symbol: 'SP:BBB', price: 12.5, volume: 10 })
  g.addNode('sym-1', ['Symbol'], { symbol: 'SP:AAA' })
  g.addEdge('aboutSymbol', 'mde-1', 'sym-1')
  return { g, as }
}

test('string and numeric node properties project under their bare names', () => {
  const { as } = fixture()
  const r: any = runCypher(as, 'MATCH (n:MarketDataEvent) RETURN n.eventId, n.symbol, n.price LIMIT 10')
  assert.equal(r.rows.length, 2)
  const byId = Object.fromEntries(r.rows.map((x: any) => [x['n.eventId'], x]))
  assert.equal(byId['mde-1']['n.symbol'], 'SP:AAA')
  assert.equal(byId['mde-1']['n.price'], '74.26', 'numeric property must render its value, not ""')
  assert.equal(byId['mde-2']['n.price'], '12.5')
})

test('a bare node variable projects the node name, not an empty string', () => {
  const { as } = fixture()
  const r: any = runCypher(as, 'MATCH (n:MarketDataEvent) RETURN n LIMIT 10')
  const names = r.rows.map((x: any) => x['n']).sort()
  assert.deepEqual(names, ['mde-1', 'mde-2'], 'label-only patterns must still bind the node variable')
})

test('WHERE filters on a real property select rows instead of dropping all of them', () => {
  const { as } = fixture()
  const r: any = runCypher(as, 'MATCH (n:MarketDataEvent) WHERE n.symbol = "SP:AAA" RETURN n.eventId LIMIT 10')
  assert.deepEqual(r.rows.map((x: any) => x['n.eventId']), ['mde-1'])
})

test('back-compat: a RAW (un-namespaced) Value key is still projectable under its own name', () => {
  // The `prop:`-namespaced key is still projected internally, but it is NOT reachable through the
  // query grammar — `RETURN n.prop:symbol` tokenizes to the column `n.prop` (characterized below),
  // so the back-compat surface that actually exists is the raw Value key written straight onto an
  // atom (the pre-facade write path, which cypher.test.ts's propFixture uses).
  const { as } = fixture()
  as.setValue(as.getNode('ConceptNode', 'mde-1')!.handle, 'severity', { kind: 'float', value: [7] })
  const r: any = runCypher(as, 'MATCH (n:MarketDataEvent) WHERE n.severity >= 7 RETURN n.eventId, n.severity LIMIT 10')
  assert.deepEqual(r.rows, [{ 'n.eventId': 'mde-1', 'n.severity': '7' }])
  // CHARACTERIZATION (loud on purpose): a namespaced key cannot be written in Cypher at all.
  const raw: any = runCypher(as, 'MATCH (n:MarketDataEvent) RETURN n.prop:symbol LIMIT 10')
  assert.deepEqual(raw.columns, ['n.prop'], '`n.prop:symbol` parses as `n.prop` — the ":" ends the reference')
  assert.ok(raw.rows.every((x: any) => x['n.prop'] === ''), 'and an unknown reference renders empty, not a stray node id')
})

test('a genuinely absent property still renders empty — the fix must not invent values', () => {
  const { as } = fixture()
  const r: any = runCypher(as, 'MATCH (n:MarketDataEvent) RETURN n.nosuchprop LIMIT 10')
  assert.ok(r.rows.every((x: any) => x['n.nosuchprop'] === ''))
})

// ─── Label semantics: BOTH namespaces, ANY label ──────────────────────────────

test('a multi-label node matches on ANY of its labels', () => {
  const as = new AtomSpace('cypher-projection-multilabel', false)
  const g = new HellGraphStore(as)
  g.addNode('carol', ['Person', 'Admin'], { name: 'Carol' })
  g.addNode('bob', ['Person'], { name: 'Bob' })
  const names = (label: string) =>
    runCypher(as, `MATCH (n:${label}) RETURN n LIMIT 10`).rows.map((x) => x['n']).sort()
  assert.deepEqual(names('Person'), ['bob', 'carol'])
  assert.deepEqual(names('Admin'), ['carol'], 'the second label is matchable too')
  assert.deepEqual(names('Nobody'), [], 'an unknown label matches nothing — and does not throw')
})

test('two node positions naming the same variable AND their labels together', () => {
  const as = new AtomSpace('cypher-projection-samevar', false)
  const g = new HellGraphStore(as)
  g.addNode('carol', ['Person', 'Admin'], {})
  g.addNode('bob', ['Person'], {})
  g.addEdge('knows', 'carol', 'bob')
  // Scanned on both sides: every declared label must hold, not just the first one seen.
  assert.deepEqual(runCypher(as, 'MATCH (a:Person) MATCH (a:Admin) RETURN a LIMIT 10').rows, [{ a: 'carol' }])
  // Clause-bound on one side, labelled on the other: same answer.
  assert.deepEqual(runCypher(as, 'MATCH (a:Person)-[:knows]->(b) MATCH (a:Admin) RETURN a, b LIMIT 10').rows,
    [{ a: 'carol', b: 'bob' }])
  assert.deepEqual(runCypher(as, 'MATCH (a:Person) MATCH (a:Nobody) RETURN a LIMIT 10').rows, [])
})

test('labels still match a natively-typed atom by TYPE (both namespaces are legitimate)', () => {
  const as = new AtomSpace('cypher-projection-native', false)
  as.addNode('Person', 'native-alice')
  const g = new HellGraphStore(as)
  g.addNode('facade-bob', ['Person'], {})
  const names = runCypher(as, 'MATCH (n:Person) RETURN n LIMIT 10').rows.map((x) => x['n']).sort()
  assert.deepEqual(names, ['facade-bob', 'native-alice'], 'atom type OR graph:labels membership')
})

test('a label works in a node-WITH-EDGE pattern too (it returned 0 rows before 0.4.45)', () => {
  const { as } = fixture()
  const r = runCypher(as, 'MATCH (n:MarketDataEvent)-[:aboutSymbol]->(s:Symbol) RETURN n.eventId, s LIMIT 10')
  assert.deepEqual(r.rows, [{ 'n.eventId': 'mde-1', s: 'sym-1' }])
  assert.equal(runCypher(as, 'MATCH (n:Symbol)-[:aboutSymbol]->(s) RETURN n LIMIT 10').rows.length, 0,
    'and the label still EXCLUDES a node that does not carry it')
})

test('an identity-pinned node variable is projected (it is a constant in the IR, not a variable)', () => {
  const { as } = fixture()
  const inline = runCypher(as, 'MATCH (a {form:"mde-1"})-[:aboutSymbol]->(b) RETURN a, b LIMIT 5')
  assert.deepEqual(inline.rows, [{ a: 'mde-1', b: 'sym-1' }])
  const pinned = runCypher(as, 'MATCH (a)-[:aboutSymbol]->(b) WHERE a.form = "mde-1" RETURN a, b LIMIT 5')
  assert.deepEqual(pinned.rows, [{ a: 'mde-1', b: 'sym-1' }])
  const nodeOnly = runCypher(as, 'MATCH (a:MarketDataEvent {form:"mde-2"}) RETURN a, a.price LIMIT 5')
  assert.deepEqual(nodeOnly.rows, [{ a: 'mde-2', 'a.price': '12.5' }])
  assert.deepEqual(runCypher(as, 'MATCH (a {form:"nope"}) RETURN a LIMIT 5').rows, [],
    'a pin on an absent node is zero rows, not one empty row')
})

test('ORDER BY and RETURN * read the same projected property', () => {
  const { as } = fixture()
  const r = runCypher(as, 'MATCH (n:MarketDataEvent) RETURN n.eventId ORDER BY n.price DESC LIMIT 10')
  assert.deepEqual(r.rows.map((x) => x['n.eventId']), ['mde-1', 'mde-2'])
  const star = runCypher(as, 'MATCH (n:MarketDataEvent)-[:aboutSymbol]->(s) RETURN * LIMIT 10')
  assert.deepEqual(star.columns.sort(), ['n', 's'], 'RETURN * projects the bound variables, not the property keys')
})

// ─── Sentinel: a scan is bounded ───────────────────────────────────────────────

test('a label scan stops at LIMIT instead of walking every candidate', () => {
  const { as } = fixture()
  // maxScan 1 with LIMIT 1: legal only because the scan stops as soon as the row budget is full.
  assert.deepEqual(runCypher(as, 'MATCH (n:MarketDataEvent) RETURN n LIMIT 1', {}, { maxScan: 1 }).rows.length, 1)
  // LIMIT 2 needs a second candidate → the Sentinel bound trips, loudly.
  assert.throws(() => runCypher(as, 'MATCH (n:MarketDataEvent) RETURN n LIMIT 2', {}, { maxScan: 1 }),
    /exceeded maxScan/)
})

test('an ORDER BY / WHERE scan cannot truncate, so it refuses rather than under-report', () => {
  const { as } = fixture()
  // Both need the full candidate set before the answer is known, so neither may stop early.
  assert.throws(() => runCypher(as, 'MATCH (n:MarketDataEvent) RETURN n ORDER BY n.price LIMIT 1', {}, { maxScan: 1 }),
    /exceeded maxScan/)
  assert.throws(() => runCypher(as, 'MATCH (n:MarketDataEvent) WHERE n.price > 0 RETURN n LIMIT 1', {}, { maxScan: 1 }),
    /exceeded maxScan/)
})

test('an anchor-free scan is bounded too', () => {
  const { as } = fixture()
  assert.throws(() => runCypher(as, 'MATCH (n) RETURN n LIMIT 10', {}, { maxScan: 2 }), /exceeded maxScan/)
  assert.equal(runCypher(as, 'MATCH (n) RETURN n LIMIT 10').rows.length, 3, 'unbounded by default only up to maxScan')
})

// ─── Anti-silent-wrong: constructs that used to be parsed and then dropped ──────

test('an inline property predicate filters instead of being silently ignored', () => {
  const { as } = fixture()
  const r = runCypher(as, 'MATCH (n:MarketDataEvent {symbol:"SP:AAA"}) RETURN n LIMIT 10')
  assert.deepEqual(r.rows, [{ n: 'mde-1' }], 'inline {symbol:…} used to match every node')
  assert.throws(() => runCypher(as, 'MATCH (:MarketDataEvent {symbol:"SP:AAA"}) RETURN 1 LIMIT 10'),
    /inline property .* on an anonymous node/)
})

test('a comma-separated MATCH is refused (everything after the comma was silently dropped)', () => {
  const { as } = fixture()
  assert.throws(() => runCypher(as, 'MATCH (n:MarketDataEvent), (s:Symbol) RETURN n, s LIMIT 10'),
    /comma-separated MATCH/)
})
