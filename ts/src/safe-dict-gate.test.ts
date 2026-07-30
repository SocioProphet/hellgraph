import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

/**
 * The safe-dict gate, run from the test suite.
 *
 * ── Why here rather than in a workflow ────────────────────────────────────────────────
 * `.github/workflows/ts-ci.yml` already runs `npm test`, and `npm test` globs
 * `ts/src/*.test.ts`. Wiring the gate in as a test therefore puts it on the only REQUIRED
 * status check (`build-and-verify-dist`) without editing the workflow — which two other
 * lanes are concurrently editing. One less merge conflict, same enforcement.
 *
 * ── What these tests assert ───────────────────────────────────────────────────────────
 * Not just "the gate passes". A gate that only ever goes green proves nothing, so the
 * tests below assert it goes RED on the code it exists to reject — including the verbatim
 * construction that shipped in PR #34 and was fixed by hand in 454a2c8 — and GREEN on the
 * sanctioned constructions and on the real query surfaces as they stand.
 */

// Resolved through a variable so this stays a runtime import of a plain .mjs script rather
// than something `tsc` tries to find types for.
const GATE_URL = pathToFileURL(join(__dirname, '..', '..', 'scripts', 'check-safe-dict.mjs')).href

type Violation = { rule: string; file: string; line: number; col: number; message: string }
type Fixture = { id: string; expect: 'flagged' | 'clean'; rule?: string; why: string; code: string }
type Gate = {
  scanSource(fileName: string, text: string): Violation[]
  runSelfTest(): string[]
  guardedFiles(): string[]
  FIXTURES: Fixture[]
  CANONICAL_SURFACES: string[]
  TRACKED_TYPES: string[]
}

const loadGate = async (): Promise<Gate> => (await import(GATE_URL)) as Gate

// ─── RED: the regression the gate exists for ──────────────────────────────────────────
// PR #34 converted the interior of patternMatcher.ts to null-prototype groundings and left
// the OUTPUT row as a plain object keyed by the same query-derived variable names. On that
// object `row['__proto__'] = v` hits Object.prototype's inherited SETTER and the write is
// SWALLOWED: the column stays listed in `variables` and is absent from every row. `tsc`
// accepts it, every test that does not probe a hostile variable name passes, and it reached
// main's review queue. This is that code, verbatim.

const PRE_FIX_PATTERN_MATCHER_ROW = `
  const variables = pattern.select ?? collectVars(pattern.clauses)
  const results = groundings.map((g) => {
    const row: Record<string, string> = {}
    for (const v of variables) {
      const atom = g[v] ? as.getAtom(g[v]) : undefined
      row[v] = atom ? (atom.name ?? atom.type) : ''
    }
    return row
  })
`

test('GATE: the pre-fix patternMatcher output row is REJECTED', async () => {
  const { scanSource } = await loadGate()
  const found = scanSource('ts/src/patternMatcher.ts', PRE_FIX_PATTERN_MATCHER_ROW)

  assert.ok(found.length > 0,
    'the gate did not flag the exact construction it was written to catch — it is not a gate')
  assert.ok(found.some((v) => v.rule === 'R1'),
    `expected R1 (computed-key write onto a prototype-bearing object), got ${found.map((v) => v.rule).join(', ')}`)
})

test('GATE: the shipped patternMatcher output row is ACCEPTED', async () => {
  const { scanSource } = await loadGate()
  const src = readFileSync(join(__dirname, 'patternMatcher.ts'), 'utf8')
  assert.deepEqual(scanSource('ts/src/patternMatcher.ts', src), [],
    'the fixed file must be clean — otherwise the red result above is just noise')
})

// ─── The fixture table: teeth in both directions ──────────────────────────────────────
// Driven from the same table the standalone script self-tests against, so there is one
// definition of "what this gate catches" and it cannot drift between the two callers.

test('GATE: every must-fail fixture is flagged and every must-pass fixture is clean', async () => {
  const { runSelfTest, FIXTURES } = await loadGate()
  assert.deepEqual(runSelfTest(), [], 'the gate\'s own red/green fixture table did not behave')

  // Guard the guard: an empty or one-sided table would make runSelfTest() vacuously pass.
  const mustFail = FIXTURES.filter((f) => f.expect === 'flagged')
  const mustPass = FIXTURES.filter((f) => f.expect === 'clean')
  assert.ok(mustFail.length >= 8, `only ${mustFail.length} must-fail fixtures — the table has been hollowed out`)
  assert.ok(mustPass.length >= 5, `only ${mustPass.length} must-pass fixtures — nothing is guarding false positives`)
  for (const rule of ['R1', 'R2', 'R3', 'R5']) {
    assert.ok(mustFail.some((f) => f.rule === rule), `no must-fail fixture exercises ${rule}`)
  }
})

// ─── RED: the READ mode — gremlin.ts's half of the same CodeQL alert ──────────────────
// The other half of js/remote-property-injection, and the half R1–R4 could not see: the gate
// scored gremlin.ts ZERO both before and after 0.4.47 fixed it, so `ownValue()` there was a
// convention with nothing holding it. `n.properties[key]` off a GraphNode returns INHERITED
// members — `g.V().values("constructor")` really does hand back the Object constructor as if
// it were stored graph data, and `has("constructor", …)` compares against one. This is that
// code, from the call sites 0.4.47 changed.

const PRE_FIX_GREMLIN_READS = `
  type PropertyValue = string | number | boolean
  interface GraphNode { id: string; labels: string[]; properties: Record<string, PropertyValue> }
  interface GraphEdge { id: string; label: string; properties: Record<string, PropertyValue> }
  type Traverser = GraphNode | GraphEdge | PropertyValue
  declare function isNode(t: Traverser): t is GraphNode
  declare function isEdge(t: Traverser): t is GraphEdge
  declare function looseEq(a: unknown, b: unknown): boolean
  export class GraphTraversal {
    constructor(private current: Traverser[]) {}
    has(nodes: GraphNode[], key: string, value: PropertyValue) {
      return nodes.filter((n) => looseEq(n.properties[key], value))
    }
    values(key: string) {
      return this.current.map((t) => (isNode(t) || isEdge(t)) ? t.properties[key] : t)
    }
    order(key: string) {
      return [...this.current].sort((a, b) => {
        const av = isNode(a) || isEdge(a) ? a.properties[key] : a
        const bv = isNode(b) || isEdge(b) ? b.properties[key] : b
        return String(av).localeCompare(String(bv))
      })
    }
  }
`

test('GATE: the pre-ownValue gremlin property READS are REJECTED', async () => {
  const { scanSource } = await loadGate()
  const found = scanSource('ts/src/gremlin.ts', PRE_FIX_GREMLIN_READS)

  assert.ok(found.some((v) => v.rule === 'R5'),
    `expected R5 (computed read off a prototype-bearing bag), got ${found.map((v) => v.rule).join(', ') || 'nothing'}`)
  assert.equal(found.filter((v) => v.rule === 'R5').length, 4,
    'has(), values() and both arms of order() — every call site 0.4.47 routed through ownValue()')
})

test('GATE: the shipped gremlin.ts is ACCEPTED — ownValue() is the fix, not an exemption', async () => {
  const { scanSource } = await loadGate()
  const src = readFileSync(join(__dirname, 'gremlin.ts'), 'utf8')
  assert.deepEqual(scanSource('ts/src/gremlin.ts', src), [],
    'ownValue(bag, key) is a CALL, not an element access, so fixed code stops matching the rule')
})

test('GATE: R5 does not flag array indexing or reads off null-prototype dictionaries', async () => {
  // The reason R5 is origin-directed rather than "any computed read": the four guarded surfaces
  // hold 57 computed element accesses, and all but the property-bag reads are array indexing or
  // reads off dictionaries R3 already guarantees are built with emptyDict/cloneDict/mergeDicts.
  // A rule that flagged those would be 57 false positives and one switched-off gate.
  const { scanSource } = await loadGate()
  const clean = `
    type Binding = Record<string, string>
    declare function emptyDict<V>(): Record<string, V>
    declare const tokens: string[]; declare const term: { name: string }
    export class P { private pos = 0
      peek() { return tokens[this.pos] }
      bound(binding: Binding) { const fresh: Binding = emptyDict<string>(); return [binding[term.name], fresh[term.name]] } }
  `
  assert.deepEqual(scanSource('ts/src/sparql.ts', clean), [])
})

// ─── Coverage: the gate must still be pointed at the real surfaces ────────────────────

test('GATE: the guarded set still covers every canonical query surface, and the live files are clean', async () => {
  const { guardedFiles, CANONICAL_SURFACES, scanSource } = await loadGate()
  const guarded = guardedFiles()

  for (const f of CANONICAL_SURFACES) {
    assert.ok(guarded.includes(f), `${f} is no longer in the guarded set — coverage was silently dropped`)
  }

  const violations = guarded.flatMap((f) => scanSource(`ts/src/${f}`, readFileSync(join(__dirname, f), 'utf8')))
  assert.deepEqual(violations, [],
    violations.map((v) => `${v.rule} ${v.file}:${v.line} ${v.message}`).join('\n'))
})
