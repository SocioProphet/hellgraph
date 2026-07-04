import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AtomSpace } from './atomspace.js'
import { HellGraphStore } from './store.js'
import { assertClaim, addEvidence, verifyClaim, recordTruth } from './discourse.js'

const space = (): AtomSpace => new AtomSpace('test-discourse', false)

test('falsifiability: a claim without a refutation channel is rejected', () => {
  const r = assertClaim(space(), { id: 'c1', text: 'the sky is green', refutationChannel: '' })
  assert.equal(r.ok, false)
  assert.match((r as { reason: string }).reason, /refutation channel/)
})

test('assertClaim seals the claim + creates its Test-Obligation channel; CSKG provenance-bound', () => {
  const s = space()
  const r = assertClaim(s, { id: 'c1', text: 'water boils at 100C at 1atm', refutationChannel: 'CTEST.thermo.boiling', sourceRefs: ['workspace-source:doc-42'] })
  assert.equal(r.ok, true)
  const g = new HellGraphStore(s)
  assert.ok(g.getNode('c1')?.labels.includes('Claim'), 'claim node')
  assert.equal(g.getNode('c1')?.properties['sourceRefs'], 'workspace-source:doc-42', 'provenance-bound to a WorkspaceSource (CSKG invariant)')
  assert.ok(g.getNode('test-obligation:c1')?.labels.includes('TestObligation'), 'test-obligation node')
  assert.ok(g.allEdges().some((e) => e.label === 'REFUTATION_CHANNEL' && e.from === 'c1'), 'refutation channel edge')
  // codex integrity: untouched → INTACT/POS.
  assert.equal(verifyClaim(s, 'c1', 'water boils at 100C at 1atm').verdict, 'POS')
})

test('evidence attaches with SUPPORTS/REFUTES; claim tamper is detected (codex)', () => {
  const s = space()
  assertClaim(s, { id: 'c1', text: 'the law is read', refutationChannel: 'CTEST.x' })
  addEvidence(s, 'c1', { id: 'e1', text: 'primary source A', supports: true })
  addEvidence(s, 'c1', { id: 'e2', text: 'primary source B', supports: false })
  const g = new HellGraphStore(s)
  assert.ok(g.allEdges().some((e) => e.label === 'SUPPORTS' && e.from === 'e1' && e.to === 'c1'))
  assert.ok(g.allEdges().some((e) => e.label === 'REFUTES' && e.from === 'e2' && e.to === 'c1'))
  // A substitution tamper on the claim text is caught + classified.
  assert.equal(verifyClaim(s, 'c1', 'the saw is read').verdict, 'NEG')
})

test('recordTruth appends a multi-valued/temporal Truth Record from proof (not policy)', () => {
  const s = space()
  assertClaim(s, { id: 'c1', text: 'x', refutationChannel: 'CTEST.x' })
  recordTruth(s, { claimId: 'c1', verdict: 'POS', evidence: 'exact', cut: { aaaa: 3 }, attestations: ['w1', 'w2'], ts: '2026-07-04T00:00:00Z' })
  const g = new HellGraphStore(s)
  const rec = g.getNode('truth-record:c1:2026-07-04T00:00:00Z')
  assert.ok(rec?.labels.includes('TruthRecord'))
  assert.equal(rec!.properties['verdict'], 'POS')
  assert.equal(rec!.properties['cut'], JSON.stringify({ aaaa: 3 }), 'temporal frame recorded')
  assert.ok(g.allEdges().some((e) => e.label === 'RECORDS' && e.to === 'c1'), 'record → claim edge')
})
