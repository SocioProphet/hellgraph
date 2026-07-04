import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AtomSpace, nodeHandle } from './atomspace.js'
import { sealAtomContent, verifyAtomContent, manifest } from './codex.js'
import { parseSExpr } from './metta.js'
import { assertClaim, recordTruth } from './discourse.js'

// ─── Attack 4: forge a 64-bit manifest collision to pass tampered content as INTACT ──
test('SECURITY: codex full-256-bit sidecar catches a tamper the 64-bit manifest would miss', () => {
  const s = new AtomSpace('sec-codex', false)
  s.addNode('ConceptNode', 'doc')
  const h = nodeHandle('ConceptNode', 'doc')
  const A = 'account balance 100'
  sealAtomContent(s, h, A) // stores manifest(A) (64-bit _sha256) + full-256-bit integrity(A)
  assert.equal(verifyAtomContent(s, h, A).verdict, 'POS', 'untouched → POS')

  // Attacker forges a 64-bit-colliding manifest: a digits-only tamper B has identical formal
  // facets; stamp codex:manifest to manifest(B) so the 64-bit backstop would accept B as INTACT.
  const B = 'account balance 999'
  s.setValue(h, 'codex:manifest', { kind: 'string', value: [JSON.stringify(manifest(B))] })
  const syn = verifyAtomContent(s, h, B)
  assert.equal(syn.verdict, 'NEG', 'the full-256-bit integrity hash (of A) catches that B is tampered')
  assert.equal(syn.exact, false)
})

// ─── Attack 5: parser stack-overflow via deep nesting on the untrusted /query surface ─
test('SECURITY: MeTTa parser rejects pathologically deep nesting (no stack overflow)', () => {
  const deep = '('.repeat(5000) + 'x' + ')'.repeat(5000)
  assert.throws(() => parseSExpr(deep), /too deep/)
})

// ─── Attack 6: assert an unbacked "truth" (no witness / no causal frame) ──────────────
test('SECURITY: recordTruth rejects an unbacked verdict (no attestation or no cut)', () => {
  const s = new AtomSpace('sec-disc', false)
  assertClaim(s, { id: 'c1', text: 'x', refutationChannel: 'CTEST.x' })
  assert.throws(
    () => recordTruth(s, { claimId: 'c1', verdict: 'POS', evidence: 'exact', cut: { a: 1 }, attestations: [], ts: 't' }),
    /witness\/attestation/,
  )
  assert.throws(
    () => recordTruth(s, { claimId: 'c1', verdict: 'POS', evidence: 'exact', cut: {}, attestations: ['w1'], ts: 't' }),
    /causal frame/,
  )
  // A properly-backed record still works.
  assert.doesNotThrow(() => recordTruth(s, { claimId: 'c1', verdict: 'POS', evidence: 'exact', cut: { a: 1 }, attestations: ['w1'], ts: 't2' }))
})
