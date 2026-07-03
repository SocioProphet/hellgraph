import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AtomSpace } from './atomspace.js'
import {
  phiGematria, phiSequence, phiSpacing, phiStructure, phiResidue, COPRIME_MODULI,
  manifest, syndrome, classify, verdictOf, evidenceTierOf,
  phiAbjad, phiSctTopology, phiAtbash, ERR_FACET_NOT_IMPLEMENTED,
  sealAtomContent, verifyAtomContent, attachCodexSealer, type Manifest,
} from './codex.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const vectors = JSON.parse(fs.readFileSync(path.join(here, 'codex-vectors.json'), 'utf-8')) as {
  known_answer: { gematria: Record<string, number>; sequence: Record<string, number>; spacing: Record<string, number[]>; structure: Record<string, number[]>; residue_len: number }
  manifest: { text: string; division: number; expect: Manifest }
  syndrome: { base: string; cases: { label: string; text: string; breaks: string[]; class: string; verdict: string }[] }
}

// ─── A. phi-registry known-answers (oracle parity) ────────────────────────────────
test('phi known-answers match the frozen reference vectors', () => {
  assert.equal(phiGematria('abc'), vectors.known_answer.gematria['abc'])
  assert.equal(phiSequence('abc'), vectors.known_answer.sequence['abc'])
  assert.deepEqual(phiSpacing('the open gate'), vectors.known_answer.spacing['the open gate'])
  assert.deepEqual(phiStructure('the open gate'), vectors.known_answer.structure['the open gate'])
  assert.equal(phiResidue('abc').length, COPRIME_MODULI.length)
  assert.equal(phiResidue('abc').length, vectors.known_answer.residue_len)
})

// ─── B. manifest byte-parity with the oracle (Appendix A.1) ───────────────────────
test('manifest reproduces the oracle manifest byte-for-byte', () => {
  const m = manifest(vectors.manifest.text, vectors.manifest.division)
  assert.deepEqual(m, vectors.manifest.expect)
  // spot-check the RRNS residue and the truncated sha, the two most port-fragile fields.
  assert.deepEqual(m.residue, [1, 4, 14, 2])
  assert.equal(m._sha256, 'ed49b79ff37fdbfa')
})

// ─── C. syndrome classifies each canonical edit (Appendix A.2) ────────────────────
test('each canonical edit yields its distinct class + verdict', () => {
  const base = manifest(vectors.syndrome.base)
  for (const c of vectors.syndrome.cases) {
    const syn = syndrome(base, c.text)
    assert.deepEqual(syn.breaks, c.breaks, `${c.label}: break-set`)
    assert.equal(syn.class, c.class, `${c.label}: class`)
    assert.equal(syn.verdict, c.verdict, `${c.label}: verdict`)
  }
})

// ─── D. RRNS single-symbol detection ──────────────────────────────────────────────
test('residue detects a single-letter substitution (RRNS)', () => {
  assert.notDeepEqual(phiResidue('the open gate'), phiResidue('the open gaze'))
})

// ─── decoder + verdict edges ──────────────────────────────────────────────────────
test('classify/verdict edges: empty→INTACT/POS, compound→ZERO', () => {
  assert.equal(classify(new Set()), 'INTACT')
  assert.equal(verdictOf('INTACT'), 'POS')
  assert.equal(verdictOf('substitution'), 'NEG')
  assert.equal(verdictOf('compound/unknown'), 'ZERO')
})

// ─── extension facets are stubbed with the canonical error ────────────────────────
test('extension facets raise ERR_FACET_NOT_IMPLEMENTED until frozen', () => {
  assert.throws(() => phiAbjad('x'), new RegExp(ERR_FACET_NOT_IMPLEMENTED))
  assert.throws(() => phiSctTopology('x', 'profile'), new RegExp(ERR_FACET_NOT_IMPLEMENTED))
  assert.throws(() => phiAtbash('x'), new RegExp(ERR_FACET_NOT_IMPLEMENTED)) // §16.8 atbash stub
})

// ─── TriTRPC reconciliation §16.4: verdict and evidence are two separate axes ─────────
test('syndrome carries evidence tier (CTRL243.evidence) distinct from verdict (State243.epistemic)', () => {
  const base = manifest('the open gate')
  const intact = syndrome(base, 'the open gate')
  assert.equal(intact.verdict, 'POS')
  assert.equal(intact.evidence, 'exact', 'formal T1 facets → exact')
  const tampered = syndrome(base, 'the open gaze')
  assert.equal(tampered.verdict, 'NEG')
  assert.equal(tampered.evidence, 'exact', 'evidence axis is independent of the verdict')
  // Unknown/empirical facets weaken the tier; formal-only stays exact.
  assert.equal(evidenceTierOf(['gematria', 'residue']), 'exact')
  assert.equal(evidenceTierOf(['gematria', 'sct_topology']), 'sampled')
})

// ─── AtomSpace integration: default-on passive seal + tamper localization ─────────
test('passive sealer seals nodes at ingest; verify localizes tamper', async () => {
  const space = new AtomSpace('test-codex', false)
  const detach = attachCodexSealer(space)

  const a = space.addNode('ConceptNode', 'the open gate')
  await new Promise((r) => setImmediate(r)) // let the deferred passive seal land
  // Sealed automatically at ingest.
  assert.ok(space.getAtom(a.handle)?.values['codex:manifest'], 'atom sealed passively')

  // Untouched content re-verifies INTACT/POS.
  const intact = verifyAtomContent(space, a.handle, 'the open gate')
  assert.equal(intact.class, 'INTACT')
  assert.equal(intact.verdict, 'POS')

  // A substitution is detected AND classified.
  const tampered = verifyAtomContent(space, a.handle, 'the open gaze')
  assert.equal(tampered.class, 'substitution')
  assert.equal(tampered.verdict, 'NEG')

  // Verifying an unsealed atom fails with the canonical mismatch code.
  space.setValue(a.handle, 'codex:manifest', { kind: 'string', value: [''] })
  assert.throws(() => verifyAtomContent(space, a.handle, 'x'), /ERR_MANIFEST_MISMATCH/)

  detach()
})
