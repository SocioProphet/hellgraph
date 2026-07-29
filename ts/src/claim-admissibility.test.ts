import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  admitClaim,
  ADMISSIBILITY_GATE_ORDER,
  OPINION_WEIGHT_MULTIPLIER,
  type ClaimInput,
} from './claim-admissibility'

test('empty context admits a reasonable claim at full weight, one step per gate', () => {
  const d = admitClaim({ id: 'c1', text: 'the sky is blue', relevanceScore: 0.9, sourceTrust: 0.8 })
  assert.equal(d.admitted, true)
  assert.equal(d.weight, 1.0)
  assert.equal(d.excludedAt, undefined)
  assert.deepEqual(d.steps.map((s) => s.gate), [...ADMISSIBILITY_GATE_ORDER])
  assert.ok(d.steps.every((s) => s.outcome === 'pass' && s.reason.length > 0))
})

test('bare claim (no scores, no provenance) is admitted under defaults', () => {
  const d = admitClaim({ id: 'bare' })
  assert.equal(d.admitted, true)
  assert.equal(d.weight, 1.0)
})

test('relevance gate excludes below the default floor 0.2', () => {
  const d = admitClaim({ id: 'c2', relevanceScore: 0.05 })
  assert.equal(d.admitted, false)
  assert.equal(d.weight, 0)
  assert.equal(d.excludedAt, 'relevance')
  assert.deepEqual(d.steps.map((s) => s.gate), ['relevance'])
  assert.match(d.steps[0]!.reason, /0\.05/)
})

test('hearsay gate excludes a deep chain and later gates are never reached', () => {
  // Would ALSO fail privilege (scoped, requester holds nothing) — but hearsay comes first.
  const d = admitClaim({
    id: 'c3',
    provenance: { chainDepth: 5, sourceKind: 'asserted' },
    visibilityScope: ['secret'],
  })
  assert.equal(d.admitted, false)
  assert.equal(d.excludedAt, 'hearsay')
  assert.deepEqual(d.steps.map((s) => s.gate), ['relevance', 'hearsay'], 'chain stops at the excluding gate')
  assert.ok(!d.steps.some((s) => s.gate === 'privilege'), 'privilege never evaluated')
})

test('business-record exception admits a deep chain from a signed connector', () => {
  const d = admitClaim({ id: 'c4', provenance: { chainDepth: 5, signedConnector: true } })
  assert.equal(d.admitted, true)
  const hearsay = d.steps.find((s) => s.gate === 'hearsay')!
  assert.equal(hearsay.outcome, 'exception')
  assert.equal(hearsay.exception, 'business-record')
})

test('admission exception admits a deep chain from an attested source', () => {
  const d = admitClaim({ id: 'c5', provenance: { chainDepth: 4, sourceKind: 'attested' } })
  assert.equal(d.admitted, true)
  assert.equal(d.steps.find((s) => s.gate === 'hearsay')!.exception, 'admission')
})

test('hearsay exception registry is extensible via ctx', () => {
  const claim: ClaimInput = { id: 'c6', provenance: { chainDepth: 9 }, epistemicTier: 'dying-declaration' }
  const without = admitClaim(claim)
  assert.equal(without.admitted, false, 'no default exception covers it')
  const withExc = admitClaim(claim, {
    hearsayExceptions: [{ name: 'dying-declaration', applies: (c) => c.epistemicTier === 'dying-declaration' }],
  })
  assert.equal(withExc.admitted, true)
  assert.equal(withExc.steps.find((s) => s.gate === 'hearsay')!.exception, 'dying-declaration')
})

test('opinion gate discounts model-generated claims to half weight by default', () => {
  const d = admitClaim({ id: 'c7', provenance: { sourceKind: 'model-generated' } })
  assert.equal(d.admitted, true)
  assert.equal(d.weight, OPINION_WEIGHT_MULTIPLIER)
  assert.equal(d.steps.find((s) => s.gate === 'opinion')!.outcome, 'pass')
})

test('opinion gate excludes model-generated claims when allowOpinion is false', () => {
  const d = admitClaim({ id: 'c8', provenance: { sourceKind: 'model-generated' } }, { allowOpinion: false })
  assert.equal(d.admitted, false)
  assert.equal(d.excludedAt, 'opinion')
})

test('opinion discount composes with a hearsay exception (deep signed model output)', () => {
  const d = admitClaim({ id: 'c9', provenance: { chainDepth: 3, signedConnector: true, sourceKind: 'model-generated' } })
  assert.equal(d.admitted, true)
  assert.equal(d.weight, OPINION_WEIGHT_MULTIPLIER)
  assert.equal(d.steps.find((s) => s.gate === 'hearsay')!.outcome, 'exception')
})

test('credibility gate excludes sources under the 0.1 trust floor', () => {
  const d = admitClaim({ id: 'c10', sourceTrust: 0.02 })
  assert.equal(d.admitted, false)
  assert.equal(d.excludedAt, 'credibility')
  assert.match(d.steps.at(-1)!.reason, /0\.02/)
})

test('privilege gate excludes out-of-scope claims WITHOUT leaking content or scope names', () => {
  const secret = 'the launch codes are 0000'
  const d = admitClaim(
    { id: 'c11', text: secret, visibilityScope: ['ops:secret', 'legal:privileged'] },
    { requesterScopes: ['ops:secret'] },   // holds one of two required scopes — not a subset
  )
  assert.equal(d.admitted, false)
  assert.equal(d.excludedAt, 'privilege')
  const reason = d.steps.at(-1)!.reason
  assert.ok(!reason.includes(secret), 'reason must not leak claim text')
  assert.ok(!reason.includes('legal:privileged'), 'reason must not leak scope names')
})

test('privilege gate passes when the requester holds every required scope', () => {
  const d = admitClaim({ id: 'c12', visibilityScope: ['a', 'b'] }, { requesterScopes: ['a', 'b', 'c'] })
  assert.equal(d.admitted, true)
})

test('discretion gate: policy deny excludes with the recorded reason; allow is recorded too', () => {
  const denied = admitClaim({ id: 'c13' }, { policy: () => ({ effect: 'deny', reason: 'embargoed until Q3' }) })
  assert.equal(denied.admitted, false)
  assert.equal(denied.excludedAt, 'discretion')
  assert.equal(denied.steps.at(-1)!.reason, 'embargoed until Q3')

  const allowed = admitClaim({ id: 'c14' }, { policy: () => ({ effect: 'allow', reason: 'counsel reviewed' }) })
  assert.equal(allowed.admitted, true)
  assert.equal(allowed.steps.find((s) => s.gate === 'discretion')!.reason, 'counsel reviewed')
})

test('context overrides move the floors (minRelevance, maxHearsayDepth)', () => {
  assert.equal(admitClaim({ id: 'c15', relevanceScore: 0.3 }, { minRelevance: 0.5 }).admitted, false)
  assert.equal(admitClaim({ id: 'c16', provenance: { chainDepth: 3 } }, { maxHearsayDepth: 3 }).admitted, true)
})
