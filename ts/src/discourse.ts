/**
 * discourse — the Discourse Graph atom schema + Truth-Engine binding (spec 14).
 *
 * The canonical claim/warrant/evidence schema for the discourse-hygiene pipeline, so the graph
 * ingest (incl. CSKG bulk ingest) and the verification/proof layer share ONE schema, not two.
 * It encodes the Truth Engine (Image 1): Artifact → Claim → Test-Obligation (required refutation
 * channel) → Witness/Attestation → Truth Record.
 *
 * Two invariants are enforced here (spec 14):
 *  - Falsifiability: a Claim MUST carry a refutation channel (a Test-Obligation); assertClaim
 *    rejects a claim without one.
 *  - Telos ≠ Truth: recordTruth writes a verdict that comes from proof/codex + attestations — it
 *    takes NO policy input, so the policy (Telos) layer cannot assert truth through it.
 */

import { AtomSpace, nodeHandle } from './atomspace.js'
import { HellGraphStore } from './store.js'
import { sealAtomContent, verifyAtomContent, type Verdict, type EvidenceTier, type Syndrome } from './codex.js'
import type { CausalCut } from './causal-proof.js'

export const DISCOURSE_NODE = {
  Artifact: 'Artifact', Claim: 'Claim', Warrant: 'Warrant', Evidence: 'Evidence',
  Attestation: 'Attestation', TestObligation: 'TestObligation', TruthRecord: 'TruthRecord',
} as const

export const DISCOURSE_EDGE = {
  WARRANTS: 'WARRANTS', SUPPORTS: 'SUPPORTS', REFUTES: 'REFUTES', CITES: 'CITES',
  ATTESTS: 'ATTESTS', REFUTATION_CHANNEL: 'REFUTATION_CHANNEL', RECORDS: 'RECORDS',
} as const

const handleOf = (id: string): string => nodeHandle('ConceptNode', id)

export interface Claim {
  id: string
  text: string
  /** Falsifiability: how this claim can be refuted (a CTEST id / codex re-verify ref). Required. */
  refutationChannel: string
}

export interface Evidence {
  id: string
  text: string
  /** true = supports the claim, false = refutes it. */
  supports: boolean
}

/** A multi-valued, temporal, adversary-aware verdict — from proof/codex, never from policy. */
export interface TruthRecord {
  claimId: string
  verdict: Verdict
  evidence: EvidenceTier
  cut: CausalCut
  /** Witness/Attestation ids (provenance + independence). */
  attestations: string[]
  ts: string
}

/**
 * Assert a claim into the discourse graph: codex-seals the claim text (artifact integrity) and
 * creates its required Test-Obligation refutation channel. Rejects a claim without one.
 */
export function assertClaim(space: AtomSpace, claim: Claim): { ok: true } | { ok: false; reason: string } {
  if (!claim.refutationChannel || claim.refutationChannel.trim() === '') {
    return { ok: false, reason: 'falsifiability: a claim requires a refutation channel (Test-Obligation)' }
  }
  const g = new HellGraphStore(space)
  g.addNode(claim.id, [DISCOURSE_NODE.Claim], { text: claim.text, refutationChannel: claim.refutationChannel })
  sealAtomContent(space, handleOf(claim.id), claim.text) // codex integrity on the claim text
  const obligationId = `test-obligation:${claim.id}`
  g.addNode(obligationId, [DISCOURSE_NODE.TestObligation], { channel: claim.refutationChannel })
  g.addEdge(DISCOURSE_EDGE.REFUTATION_CHANNEL, claim.id, obligationId, {})
  return { ok: true }
}

/** Attach evidence (codex-sealed) to a claim with a SUPPORTS/REFUTES edge. */
export function addEvidence(space: AtomSpace, claimId: string, ev: Evidence): void {
  const g = new HellGraphStore(space)
  g.addNode(ev.id, [DISCOURSE_NODE.Evidence], { text: ev.text })
  sealAtomContent(space, handleOf(ev.id), ev.text)
  g.addEdge(ev.supports ? DISCOURSE_EDGE.SUPPORTS : DISCOURSE_EDGE.REFUTES, ev.id, claimId, {})
}

/** Verify a claim's content integrity (codex): tamper → NEG. */
export function verifyClaim(space: AtomSpace, claimId: string, currentText: string): Syndrome {
  return verifyAtomContent(space, handleOf(claimId), currentText)
}

/**
 * Record a Truth verdict for a claim (multi-valued/temporal). The verdict/evidence/cut come from
 * the proof + codex + attestations — NOT from policy (Telos ≠ Truth). Appends a TruthRecord node
 * linked to the claim; multiple records over time form the temporal, adversary-aware record.
 */
export function recordTruth(space: AtomSpace, rec: TruthRecord): void {
  const g = new HellGraphStore(space)
  const recordId = `truth-record:${rec.claimId}:${rec.ts}`
  g.addNode(recordId, [DISCOURSE_NODE.TruthRecord], {
    verdict: rec.verdict,
    evidence: rec.evidence,
    cut: JSON.stringify(rec.cut),
    attestations: rec.attestations.join(','),
    ts: rec.ts,
  })
  g.addEdge(DISCOURSE_EDGE.RECORDS, recordId, rec.claimId, {})
}
