/**
 * PLN forward-chaining tests — seal-the-walls W3.1.
 *
 * Pins the three inference rules (deduction, revision, abduction), their gates
 * and caps, and the 0.4.41 truth-value storage contract: strength and
 * confidence are DISTINCT stored properties that evolve under different
 * arithmetic (deduction: s=s1·s2 vs c=c1·c2·0.9). Legacy edges carrying only
 * 'confidence' keep working via the strength←confidence read fallback.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { AtomSpace } from './atomspace.js'
import { HellGraphStore } from './store.js'
import { forwardChain } from './pln.js'

// forwardChain() reads the process-level singleton via getHellGraph(); swap a
// fresh isolated (non-persisted) store into it per test.
let seq = 0
function freshStore(): HellGraphStore {
  const store = new HellGraphStore(new AtomSpace(`pln-test-${seq++}`, false))
  globalThis.__hellgraph_store__ = store
  return store
}

/** Float assert with a tolerance far below any TV arithmetic difference. */
function approx(actual: unknown, expected: number, msg?: string): void {
  assert.ok(
    typeof actual === 'number' && Math.abs(actual - expected) < 1e-12,
    msg ?? `expected ${String(actual)} ≈ ${expected}`,
  )
}

function relEdges(g: HellGraphStore, epistemicClass?: string) {
  const all = g.allEdges().filter(e => e.label === 'RELATED_TO')
  return epistemicClass ? all.filter(e => e.properties['epistemicClass'] === epistemicClass) : all
}

// ─── Deduction + truth-value storage contract ────────────────────────────────

test('deduction derives A→C with s=s1·s2 and c=c1·c2·0.9 stored as SEPARATE properties', () => {
  const g = freshStore()
  g.addEdge('RELATED_TO', 'n:a', 'n:b', { epistemicClass: 'semantic', strength: 0.9, confidence: 0.5 })
  g.addEdge('RELATED_TO', 'n:b', 'n:c', { epistemicClass: 'semantic', strength: 0.8, confidence: 0.5 })

  const res = forwardChain({ runRevision: false, runAbduction: false })

  assert.equal(res.derived, 1)
  assert.equal(res.revised, 0)
  assert.equal(res.abduced, 0)
  const derived = relEdges(g, 'pln_deduction')
  assert.equal(derived.length, 1)
  const e = derived[0]!
  assert.equal(e.from, 'n:a')
  assert.equal(e.to, 'n:c')
  approx(e.properties['strength'], 0.9 * 0.8)          // 0.72 — the strength rule
  approx(e.properties['confidence'], 0.5 * 0.5 * 0.9)  // 0.225 — the confidence rule, NOT 0.72
  assert.equal(e.properties['promotionState'], 'inferred')
  assert.ok(typeof e.properties['createdAt'] === 'string' && e.properties['createdAt'].length > 0)
})

test('legacy edges carrying only confidence still chain: strength falls back to confidence', () => {
  const g = freshStore()
  // Pre-0.4.41 writers (ingest/consolidate asserted edges) store a single
  // 'confidence' property — the fallback must treat it as both TV halves.
  g.addEdge('RELATED_TO', 'n:a', 'n:b', { epistemicClass: 'semantic', confidence: 0.8 })
  g.addEdge('RELATED_TO', 'n:b', 'n:c', { epistemicClass: 'semantic', confidence: 0.6 })

  const res = forwardChain({ runRevision: false, runAbduction: false })

  assert.equal(res.derived, 1)
  const e = relEdges(g, 'pln_deduction')[0]!
  approx(e.properties['strength'], 0.8 * 0.6)          // s ← confidence fallback: 0.48
  approx(e.properties['confidence'], 0.8 * 0.6 * 0.9)  // c evolves separately: 0.432
  // The distinction the pre-fix code destroyed: both values stored, unequal.
  assert.notEqual(e.properties['strength'], e.properties['confidence'])
})

test('strength is read from the strength property, not confidence (TV-collapse regression pin)', () => {
  const g = freshStore()
  // Pre-fix, s was read from 'confidence' → 0.4·0.4 = 0.16 < MIN_STRENGTH and
  // NOTHING would derive. Post-fix, s = 0.9·0.9 = 0.81 clears the gate.
  g.addEdge('RELATED_TO', 'n:a', 'n:b', { epistemicClass: 'semantic', strength: 0.9, confidence: 0.4 })
  g.addEdge('RELATED_TO', 'n:b', 'n:c', { epistemicClass: 'semantic', strength: 0.9, confidence: 0.4 })

  const res = forwardChain({ runRevision: false, runAbduction: false })

  assert.equal(res.derived, 1)
  const e = relEdges(g, 'pln_deduction')[0]!
  approx(e.properties['strength'], 0.9 * 0.9)
  approx(e.properties['confidence'], 0.4 * 0.4 * 0.9)
})

test('MIN_STRENGTH gate suppresses deduction when s1·s2 < 0.30 (gates on strength, not confidence)', () => {
  const g = freshStore()
  // High confidence must NOT rescue a weak strength product: 0.5·0.5 = 0.25 < 0.30.
  g.addEdge('RELATED_TO', 'n:a', 'n:b', { strength: 0.5, confidence: 0.9 })
  g.addEdge('RELATED_TO', 'n:b', 'n:c', { strength: 0.5, confidence: 0.9 })

  const res = forwardChain({ runRevision: false, runAbduction: false })

  assert.equal(res.derived, 0)
  assert.equal(relEdges(g, 'pln_deduction').length, 0)
})

test('edges with no truth-value properties default to s=c=0.5 → 0.25 < gate → suppressed', () => {
  const g = freshStore()
  g.addEdge('RELATED_TO', 'n:a', 'n:b', {})
  g.addEdge('RELATED_TO', 'n:b', 'n:c', {})

  const res = forwardChain({ runRevision: false, runAbduction: false })

  assert.equal(res.derived, 0)
  assert.equal(res.rulesFired, 0)
})

test('chains across COOCCURS_WITH source edges and writes derivations as RELATED_TO', () => {
  const g = freshStore()
  g.addEdge('COOCCURS_WITH', 'n:a', 'n:b', { epistemicClass: 'co_occurrence', strength: 0.8, confidence: 0.8 })
  g.addEdge('COOCCURS_WITH', 'n:b', 'n:c', { epistemicClass: 'co_occurrence', strength: 0.8, confidence: 0.8 })

  const res = forwardChain({ runRevision: false, runAbduction: false })

  assert.equal(res.derived, 1)
  const e = relEdges(g, 'pln_deduction')[0]!
  assert.equal(e.label, 'RELATED_TO')
  assert.equal(e.from, 'n:a')
  assert.equal(e.to, 'n:c')
  approx(e.properties['strength'], 0.8 * 0.8)
  approx(e.properties['confidence'], 0.8 * 0.8 * 0.9)
})

test('no self-loops: a 2-cycle A→B, B→A derives nothing', () => {
  const g = freshStore()
  g.addEdge('RELATED_TO', 'n:a', 'n:b', { strength: 0.9, confidence: 0.9 })
  g.addEdge('COOCCURS_WITH', 'n:b', 'n:a', { strength: 0.9, confidence: 0.9 })

  const res = forwardChain({ runRevision: false, runAbduction: false })

  assert.equal(res.derived, 0)
  assert.ok(g.allEdges().every(e => e.from !== e.to), 'no edge may loop onto its own node')
})

test('idempotent re-run: no duplicate edges, second run derives 0', () => {
  const g = freshStore()
  g.addEdge('RELATED_TO', 'n:a', 'n:b', { strength: 0.9, confidence: 0.8 })
  g.addEdge('RELATED_TO', 'n:b', 'n:c', { strength: 0.9, confidence: 0.8 })

  const r1 = forwardChain({ runRevision: false, runAbduction: false })
  const r2 = forwardChain({ runRevision: false, runAbduction: false })

  assert.equal(r1.derived, 1)
  assert.equal(r2.derived, 0)
  const ac = g.allEdges().filter(e => e.label === 'RELATED_TO' && e.from === 'n:a' && e.to === 'n:c')
  assert.equal(ac.length, 1, 'exactly one A→C edge after two runs')
})

// ─── Caps ────────────────────────────────────────────────────────────────────

test('maxIters caps chaining passes', () => {
  const g = freshStore()
  for (let i = 0; i < 6; i++) g.addEdge('RELATED_TO', `n:${i}`, `n:${i + 1}`, { strength: 0.95, confidence: 0.9 })

  const res = forwardChain({ maxIters: 1, runRevision: false, runAbduction: false })

  assert.equal(res.iterations, 1)
  assert.ok(res.derived >= 1, 'the single allowed pass still derives')
})

test('maxDerived hard-caps derived edges', () => {
  const g = freshStore()
  // Full transitive closure of a 7-node chain would derive 10 new edges.
  for (let i = 0; i < 6; i++) g.addEdge('RELATED_TO', `n:${i}`, `n:${i + 1}`, { strength: 0.95, confidence: 0.9 })

  const res = forwardChain({ maxDerived: 4, runRevision: false, runAbduction: false })

  assert.equal(res.derived, 4)
  assert.equal(relEdges(g, 'pln_deduction').length, 4)
})

// ─── Revision ────────────────────────────────────────────────────────────────

test('revision fuses multi-source edges: s=Σsᵢcᵢ/Σcᵢ, c=1−Π(1−cᵢ), tagged pln_revision', () => {
  const g = freshStore()
  // Same pair from two epistemic sources (legacy single-property format).
  g.addEdge('RELATED_TO', 'n:a', 'n:b', { epistemicClass: 'semantic', confidence: 0.6 })
  g.addEdge('COOCCURS_WITH', 'n:a', 'n:b', { epistemicClass: 'co_occurrence', confidence: 0.8 })

  const res = forwardChain({ runAbduction: false })

  assert.equal(res.revised, 1)
  assert.equal(res.derived, 0)
  const e = g.allEdges().find(x => x.label === 'RELATED_TO' && x.from === 'n:a' && x.to === 'n:b')!
  assert.equal(e.properties['epistemicClass'], 'pln_revision')
  assert.equal(e.properties['promotionState'], 'inferred')
  approx(e.properties['strength'], (0.6 * 0.6 + 0.8 * 0.8) / (0.6 + 0.8)) // ≈ 0.7143 weighted average
  approx(e.properties['confidence'], 0.6 + 0.8 - 0.6 * 0.8)               // 0.92 bounded evidence sum
  // The co-occurrence source edge is untouched (still legacy-format).
  const co = g.allEdges().find(x => x.label === 'COOCCURS_WITH')!
  assert.equal(co.properties['confidence'], 0.8)
  assert.equal(co.properties['strength'], undefined)
})

test('revision confidence is capped at 0.99', () => {
  const g = freshStore()
  g.addEdge('RELATED_TO', 'n:a', 'n:b', { strength: 0.6, confidence: 0.94 })
  g.addEdge('COOCCURS_WITH', 'n:a', 'n:b', { strength: 0.6, confidence: 0.94 })

  const res = forwardChain({ runAbduction: false })

  assert.equal(res.revised, 1)
  const e = g.allEdges().find(x => x.label === 'RELATED_TO')!
  assert.equal(e.properties['confidence'], 0.99) // raw 0.94+0.94−0.94² ≈ 0.9964 → capped exactly
  approx(e.properties['strength'], 0.6)          // equal-strength sources revise to the same strength
})

test('revision requires ≥2 sources for the same pair', () => {
  const g = freshStore()
  g.addEdge('RELATED_TO', 'n:a', 'n:b', { strength: 0.9, confidence: 0.9 })

  const res = forwardChain({ runAbduction: false })

  assert.equal(res.revised, 0)
  const e = g.allEdges().find(x => x.label === 'RELATED_TO')!
  assert.equal(e.properties['epistemicClass'], undefined, 'single-source edge left untouched')
})

// ─── Abduction ───────────────────────────────────────────────────────────────

test('abduction links nodes sharing ≥3 strong targets: s=minS²·0.4, c=minC²·0.4, candidate state', () => {
  const g = freshStore()
  for (const t of ['n:t1', 'n:t2', 'n:t3']) {
    g.addEdge('RELATED_TO', 'n:a', t, { strength: 0.9, confidence: 0.7 })
    g.addEdge('RELATED_TO', 'n:b', t, { strength: 0.9, confidence: 0.7 })
  }

  const res = forwardChain({ runRevision: false })

  assert.equal(res.abduced, 1)
  assert.equal(res.derived, 0)
  const derived = relEdges(g, 'pln_abduction')
  assert.equal(derived.length, 1)
  const e = derived[0]!
  assert.equal(e.from, 'n:a')
  assert.equal(e.to, 'n:b')
  approx(e.properties['strength'], 0.9 * 0.9 * 0.4)   // 0.324 — clears MIN_STRENGTH
  approx(e.properties['confidence'], 0.7 * 0.7 * 0.4) // 0.196 — evolves from c, not from s
  assert.equal(e.properties['promotionState'], 'candidate')
  assert.equal(e.properties['sharedNeighbors'], 3)
})

test('abduction gates: <3 shared targets, sub-0.55 strength, or an existing direct link → nothing', () => {
  // Only 2 shared targets — below ABD_SHARED_THRESHOLD.
  let g = freshStore()
  for (const t of ['n:t1', 'n:t2']) {
    g.addEdge('RELATED_TO', 'n:a', t, { strength: 0.9, confidence: 0.9 })
    g.addEdge('RELATED_TO', 'n:b', t, { strength: 0.9, confidence: 0.9 })
  }
  assert.equal(forwardChain({ runRevision: false }).abduced, 0)

  // 3 shared targets but edge strength 0.5 < ABD_MIN_STRENGTH 0.55.
  g = freshStore()
  for (const t of ['n:t1', 'n:t2', 'n:t3']) {
    g.addEdge('RELATED_TO', 'n:a', t, { strength: 0.5, confidence: 0.9 })
    g.addEdge('RELATED_TO', 'n:b', t, { strength: 0.5, confidence: 0.9 })
  }
  assert.equal(forwardChain({ runRevision: false }).abduced, 0)

  // 3 strong shared targets but A and B are already directly linked.
  g = freshStore()
  g.addEdge('RELATED_TO', 'n:a', 'n:b', { strength: 0.9, confidence: 0.9 })
  for (const t of ['n:t1', 'n:t2', 'n:t3']) {
    g.addEdge('RELATED_TO', 'n:a', t, { strength: 0.9, confidence: 0.9 })
    g.addEdge('RELATED_TO', 'n:b', t, { strength: 0.9, confidence: 0.9 })
  }
  const res = forwardChain({ runRevision: false })
  assert.equal(res.abduced, 0)
  assert.equal(relEdges(g, 'pln_abduction').length, 0)
})

// ─── Determinism ─────────────────────────────────────────────────────────────

test('deterministic: identical input graphs → identical derived graphs and counters', () => {
  const seed = (g: HellGraphStore) => {
    // Deduction chain (legacy format), revision pair, abduction cluster — all three rules fire.
    g.addEdge('RELATED_TO', 'c:1', 'c:2', { epistemicClass: 'semantic', confidence: 0.8 })
    g.addEdge('RELATED_TO', 'c:2', 'c:3', { epistemicClass: 'semantic', confidence: 0.7 })
    g.addEdge('RELATED_TO', 'r:1', 'r:2', { epistemicClass: 'semantic', confidence: 0.6 })
    g.addEdge('COOCCURS_WITH', 'r:1', 'r:2', { epistemicClass: 'co_occurrence', confidence: 0.8 })
    for (const t of ['x:t1', 'x:t2', 'x:t3']) {
      g.addEdge('RELATED_TO', 'x:a', t, { strength: 0.9, confidence: 0.7 })
      g.addEdge('RELATED_TO', 'x:b', t, { strength: 0.9, confidence: 0.7 })
    }
  }
  const snapshot = (g: HellGraphStore) =>
    g.allEdges()
      .map(e => [
        e.label, e.from, e.to,
        e.properties['strength'] ?? null,
        e.properties['confidence'] ?? null,
        e.properties['epistemicClass'] ?? null,
        e.properties['promotionState'] ?? null,
      ])
      .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)))

  const g1 = freshStore(); seed(g1); const r1 = forwardChain(); const s1 = snapshot(g1)
  const g2 = freshStore(); seed(g2); const r2 = forwardChain(); const s2 = snapshot(g2)

  assert.deepEqual(r1, r2)
  assert.deepEqual(s1, s2)
  assert.ok(r1.derived >= 1 && r1.revised >= 1 && r1.abduced >= 1, 'all three rules exercised')
})
