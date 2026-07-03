import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bindProof, honorProof, cutFromOrder, cutJoin, cutSubsumes, cutEquals, opInCut,
  type OpId, type CausalCut,
} from './causal-proof.js'

const A = 'aaaa'
const B = 'bbbb'
const op = (writer: string, seq: number): OpId => ({ writer, seq })

// ─── Cut algebra ─────────────────────────────────────────────────────────────

test('cut algebra: join is componentwise max; subsumes is componentwise ≥', () => {
  const a: CausalCut = { [A]: 2, [B]: 1 }
  const b: CausalCut = { [A]: 1, [B]: 3 }
  assert.deepEqual(cutJoin(a, b), { [A]: 2, [B]: 3 })
  assert.ok(cutSubsumes({ [A]: 2, [B]: 3 }, a), 'superset subsumes')
  assert.ok(!cutSubsumes(a, b), 'neither subsumes the other under a fork')
  assert.ok(cutEquals(cutJoin(a, b), cutJoin(b, a)), 'join is commutative')
  assert.ok(opInCut(op(A, 2), a) && !opInCut(op(A, 3), a), 'opInCut respects the frame')
})

// ─── P1: a proof must name a non-empty frame; deps must lie inside it ─────────

test('P1: bindProof rejects an empty frame', () => {
  assert.throws(() => bindProof({
    statement: 's', verdict: true, derivedAgainst: {}, dependencyOps: [],
  }), /non-empty causal cut/)
})

test('bindProof rejects a dependency outside the declared frame', () => {
  assert.throws(() => bindProof({
    statement: 's', verdict: true, derivedAgainst: { [A]: 1 }, dependencyOps: [op(A, 2)],
  }), /outside derivedAgainst/)
})

// ─── In-frame: recorded verdict is surfaced ──────────────────────────────────

test('in-frame proof surfaces its recorded verdict', () => {
  const order = [op(A, 1), op(B, 1)]
  const proof = bindProof({
    statement: 'A1 before B1', verdict: true,
    derivedAgainst: cutFromOrder(order), dependencyOps: [op(A, 1), op(B, 1)],
  })
  const r = honorProof(proof, cutFromOrder(order), order)
  assert.equal(r.status, 'in-frame')
  assert.equal(r.verdict, true)
})

// ─── P4 / monotone: append-only growth beyond the deps never changes the verdict ─

test('P4: extending the log after the dependency set keeps the proof in-frame', () => {
  const order0 = [op(A, 1), op(B, 1)]
  const proof = bindProof({
    statement: 's', verdict: true,
    derivedAgainst: cutFromOrder(order0), dependencyOps: [op(A, 1), op(B, 1)],
  })
  // New ops arrive causally after the dependency set; read cut extends to include them.
  const order1 = [op(A, 1), op(B, 1), op(A, 2), op(B, 2)]
  const r = honorProof(proof, cutFromOrder(order1), order1)
  assert.equal(r.status, 'in-frame')
  assert.equal(r.verdict, true)
})

// ─── Rule 2 / P2: a fork-reorder takes the proof OUT-OF-FRAME, never downgraded ─

test('P2: reordering a dependency pair takes the proof out-of-frame and WITHHOLDS the verdict', () => {
  const order0 = [op(A, 1), op(B, 1)]
  const proof = bindProof({
    statement: 'A1 before B1', verdict: true,
    derivedAgainst: cutFromOrder(order0), dependencyOps: [op(A, 1), op(B, 1)],
  })
  // A causal fork resolves the other way: B1 now precedes A1.
  const reordered = [op(B, 1), op(A, 1)]
  const r = honorProof(proof, cutFromOrder(reordered), reordered)
  assert.equal(r.status, 'out-of-frame')
  assert.equal(r.verdict, undefined, 'no silent downgrade: verdict is withheld, not turned into confidence')
})

test('a dependency unobserved at the read cut is out-of-frame', () => {
  const order = [op(A, 1), op(B, 1)]
  const proof = bindProof({
    statement: 's', verdict: true,
    derivedAgainst: cutFromOrder(order), dependencyOps: [op(A, 1), op(B, 1)],
  })
  // Read cut has not yet observed B's op.
  const r = honorProof(proof, { [A]: 1 }, [op(A, 1)])
  assert.equal(r.status, 'out-of-frame')
  assert.equal(r.verdict, undefined)
})

// ─── P3: determinism ─────────────────────────────────────────────────────────

test('P3: honorProof is deterministic for a fixed cut', () => {
  const order = [op(A, 1), op(A, 2), op(B, 1)]
  const proof = bindProof({
    statement: 's', verdict: false,
    derivedAgainst: cutFromOrder(order), dependencyOps: [op(A, 1), op(A, 2), op(B, 1)],
  })
  const r1 = honorProof(proof, cutFromOrder(order), order)
  const r2 = honorProof(proof, cutFromOrder(order), order)
  assert.deepEqual(r1, r2)
  assert.equal(r1.status, 'in-frame')
  assert.equal(r1.verdict, false, 'the verdict itself is preserved, not re-derived')
})
