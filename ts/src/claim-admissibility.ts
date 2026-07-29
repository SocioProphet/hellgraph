/**
 * Claim admissibility — "rules of evidence" for what may enter a reasoning context.
 *
 * RAG pipelines usually admit anything retrieval surfaces; courts do not. This module ports the
 * legal admissibility flowchart to claims/facts: a SEQUENTIAL typed gate chain where each gate can
 * exclude on a specific, recorded ground, and exclusion at gate N means later gates are never
 * reached (privilege is never even evaluated for a claim that already fell to hearsay). The full
 * step trace is returned, so a decision is auditable evidence — not an opinion.
 *
 * Gate order (fixed, mirroring the flowchart):
 *   1. relevance   — a claim below the relevance floor never enters (irrelevant evidence is out).
 *   2. hearsay     — provenance chains deeper than the limit are excluded UNLESS a registered
 *                    hearsay exception applies. Exceptions are first-class and extensible:
 *                    'business-record' (signed connector ⇒ records kept in the ordinary course)
 *                    and 'admission' (source attested its own statement) ship by default.
 *   3. opinion     — model-generated content is opinion, not fact: excluded when opinions are
 *                    disallowed, otherwise admitted at a discounted weight (×0.5).
 *   4. credibility — sources below the trust floor (e.g. PageRank < 0.1) are impeached out.
 *   5. privilege   — claims scoped beyond the requester's visibility are excluded, and the
 *                    exclusion reason NEVER carries the claim's content or its scope names.
 *   6. discretion  — a caller-supplied policy gets the judge's final override, reason recorded.
 *
 * Weight semantics: an admitted claim carries `weight` (1.0 unless discounted by the opinion
 * gate); an excluded claim carries weight 0 — it must not enter the reasoning context at all.
 */

export type SourceKind = 'measured' | 'attested' | 'asserted' | 'model-generated'

export interface ClaimProvenance {
  /** Hops between the original perception and this claim (0 = firsthand). */
  chainDepth?: number
  sourceKind?: SourceKind
  /** True when the claim arrived through a signed/verified connector (business-record grounds). */
  signedConnector?: boolean
}

export interface ClaimInput {
  id: string
  text?: string
  /** Retrieval relevance in [0,1] (e.g. reranker score). Absent ⇒ presumed relevant. */
  relevanceScore?: number
  provenance?: ClaimProvenance
  /** Source authority in [0,1] (e.g. PageRank of the source node). Absent ⇒ unimpeached. */
  sourceTrust?: number
  /** Scopes a requester must hold to see this claim. Absent/empty ⇒ public. */
  visibilityScope?: string[]
  /** Carried metadata (e.g. Assay tier); not consumed by the fixed gates but visible to `policy`. */
  epistemicTier?: string
}

/** A first-class hearsay exception: named grounds under which a deep chain is admitted anyway. */
export interface HearsayException {
  name: string
  applies: (c: ClaimInput) => boolean
}

/**
 * Default hearsay-exception registry.
 *   business-record — the claim came through a signed connector: records produced and kept in the
 *                     ordinary course of business are reliable despite chain depth.
 *   admission       — the source attested the statement itself: a party's own admission is exempt.
 */
export const DEFAULT_HEARSAY_EXCEPTIONS: readonly HearsayException[] = [
  { name: 'business-record', applies: (c) => c.provenance?.signedConnector === true },
  { name: 'admission', applies: (c) => c.provenance?.sourceKind === 'attested' },
]

export interface PolicyRuling {
  effect: 'allow' | 'deny'
  reason?: string
}

export interface AdmissibilityContext {
  /** Relevance floor (default 0.2): claims scoring below it are excluded at the relevance gate. */
  minRelevance?: number
  /** Maximum tolerated provenance chain depth (default 2): deeper is hearsay. */
  maxHearsayDepth?: number
  /** Admit model-generated (opinion) claims at a discount (default true); false excludes them. */
  allowOpinion?: boolean
  /** Scopes the requester holds; a claim's visibilityScope must be a subset of these. */
  requesterScopes?: string[]
  /** EXTRA hearsay exceptions, appended to DEFAULT_HEARSAY_EXCEPTIONS (registry is extensible). */
  hearsayExceptions?: HearsayException[]
  /** Discretionary override — the last gate; its ruling and reason are recorded on the trace. */
  policy?: (c: ClaimInput) => PolicyRuling
}

export type AdmissibilityGate = 'relevance' | 'hearsay' | 'opinion' | 'credibility' | 'privilege' | 'discretion'

/** Fixed gate order — exported so callers can render/verify traces against the canonical chain. */
export const ADMISSIBILITY_GATE_ORDER: readonly AdmissibilityGate[] =
  ['relevance', 'hearsay', 'opinion', 'credibility', 'privilege', 'discretion']

export type GateOutcome = 'pass' | 'exclude' | 'exception'

export interface GateStep {
  gate: AdmissibilityGate
  outcome: GateOutcome
  /** Name of the hearsay exception that admitted the claim (outcome 'exception' only). */
  exception?: string
  /** Specific ground for the outcome. The privilege gate's reason never leaks content or scopes. */
  reason: string
}

export interface AdmissibilityDecision {
  admitted: boolean
  /** 1.0 by default; discounted by the opinion gate; 0 when excluded. */
  weight: number
  /** One step per gate evaluated, in order. Stops at the excluding gate. */
  steps: GateStep[]
  /** The gate that excluded the claim, when admitted === false. */
  excludedAt?: AdmissibilityGate
}

export const DEFAULT_MIN_RELEVANCE = 0.2
export const DEFAULT_MAX_HEARSAY_DEPTH = 2
/** Weight multiplier applied to admitted model-generated (opinion) claims. */
export const OPINION_WEIGHT_MULTIPLIER = 0.5

/**
 * Run the admissibility gate chain over one claim. Deterministic and side-effect free; the
 * returned trace records every gate reached, and exclusion short-circuits the chain.
 */
export function admitClaim(claim: ClaimInput, ctx: AdmissibilityContext = {}): AdmissibilityDecision {
  const steps: GateStep[] = []
  let weight = 1.0
  const exclude = (gate: AdmissibilityGate, reason: string): AdmissibilityDecision => {
    steps.push({ gate, outcome: 'exclude', reason })
    return { admitted: false, weight: 0, steps, excludedAt: gate }
  }

  // 1 ─ relevance: irrelevant claims never enter. An unscored claim is presumed relevant, so an
  //     empty input under an empty context is still admissible.
  const minRelevance = ctx.minRelevance ?? DEFAULT_MIN_RELEVANCE
  if (claim.relevanceScore !== undefined && claim.relevanceScore < minRelevance) {
    return exclude('relevance', `relevance ${claim.relevanceScore} below floor ${minRelevance}`)
  }
  steps.push({
    gate: 'relevance',
    outcome: 'pass',
    reason: claim.relevanceScore === undefined
      ? 'no relevance score supplied — presumed relevant'
      : `relevance ${claim.relevanceScore} ≥ floor ${minRelevance}`,
  })

  // 2 ─ hearsay: deep provenance chains are excluded unless a registered exception applies.
  const maxDepth = ctx.maxHearsayDepth ?? DEFAULT_MAX_HEARSAY_DEPTH
  const depth = claim.provenance?.chainDepth ?? 0
  if (depth > maxDepth) {
    const registry = [...DEFAULT_HEARSAY_EXCEPTIONS, ...(ctx.hearsayExceptions ?? [])]
    const exc = registry.find((e) => e.applies(claim))
    if (!exc) {
      return exclude('hearsay', `provenance chain depth ${depth} exceeds max ${maxDepth} and no hearsay exception applies`)
    }
    steps.push({
      gate: 'hearsay',
      outcome: 'exception',
      exception: exc.name,
      reason: `chain depth ${depth} exceeds max ${maxDepth} but '${exc.name}' exception applies`,
    })
  } else {
    steps.push({ gate: 'hearsay', outcome: 'pass', reason: `chain depth ${depth} within max ${maxDepth}` })
  }

  // 3 ─ opinion: model-generated content is opinion — excluded when disallowed, discounted otherwise.
  if (claim.provenance?.sourceKind === 'model-generated') {
    if (!(ctx.allowOpinion ?? true)) {
      return exclude('opinion', 'model-generated (opinion) claims are not allowed in this context')
    }
    weight *= OPINION_WEIGHT_MULTIPLIER
    steps.push({
      gate: 'opinion',
      outcome: 'pass',
      reason: `model-generated claim admitted as opinion at ×${OPINION_WEIGHT_MULTIPLIER} weight`,
    })
  } else {
    steps.push({ gate: 'opinion', outcome: 'pass', reason: 'not model-generated — no opinion discount' })
  }

  // 4 ─ credibility: impeach sources below the trust floor. Unmeasured trust is not impeachment.
  if (claim.sourceTrust !== undefined && claim.sourceTrust < 0.1) {
    return exclude('credibility', `source trust ${claim.sourceTrust} below floor 0.1`)
  }
  steps.push({
    gate: 'credibility',
    outcome: 'pass',
    reason: claim.sourceTrust === undefined ? 'source trust unmeasured — unimpeached' : `source trust ${claim.sourceTrust} ≥ floor 0.1`,
  })

  // 5 ─ privilege: every scope on the claim must be held by the requester (subset check). The
  //     exclusion reason deliberately names neither the content nor the scopes — a privilege
  //     exclusion must not itself leak what was privileged.
  const required = claim.visibilityScope ?? []
  const held = new Set(ctx.requesterScopes ?? [])
  if (required.some((s) => !held.has(s))) {
    return exclude('privilege', 'claim is scoped beyond the requester visibility (content and scopes withheld)')
  }
  steps.push({
    gate: 'privilege',
    outcome: 'pass',
    reason: required.length === 0 ? 'claim carries no visibility scope — public' : 'requester holds every required scope',
  })

  // 6 ─ discretion: the caller-supplied policy has the last word, and its reason is recorded.
  if (ctx.policy) {
    const ruling = ctx.policy(claim)
    if (ruling.effect === 'deny') {
      return exclude('discretion', ruling.reason ?? 'excluded by discretionary policy')
    }
    steps.push({ gate: 'discretion', outcome: 'pass', reason: ruling.reason ?? 'allowed by discretionary policy' })
  } else {
    steps.push({ gate: 'discretion', outcome: 'pass', reason: 'no discretionary policy registered' })
  }

  return { admitted: true, weight, steps }
}
