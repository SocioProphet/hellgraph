/**
 * consolidate.ts — Memory consolidation "sleep" pass for HellGraph.
 *
 * Runs on server startup (and optionally on idle) to perform the offline memory
 * operations that are too expensive to run inline on every ingest:
 *
 *   1. TruthValue temporal decay
 *      Atoms not mentioned in > DECAY_AFTER_DAYS have their confidence lowered.
 *      Mirrors biological memory consolidation: rarely-accessed traces fade.
 *
 *   2. MERGE_PROPOSAL batch promotion
 *      High-confidence MERGE_PROPOSAL edges (>= PROMOTE_THRESHOLD) are promoted
 *      to RELATED_TO. Each merge emits a DecisionLedgerEntry for audit.
 *
 *   3. Deep PLN pass
 *      Runs forwardChain with maxIters=200 to fully saturate transitive closure,
 *      plus revision (multi-source strengthening) and abduction (shared neighbors).
 *
 *   4. VLTI promotion
 *      Atoms with LTI >= LTI_PROMOTE_THRESHOLD are marked very-long-term important.
 *      VLTI atoms are exempt from STI decay and TruthValue decay.
 *
 *   5. SemanticMemoryRelease audit node
 *      A permanent record of this consolidation pass is written to the graph.
 *
 * mirrors graphbrain-contract SemanticMemoryRelease lifecycle.
 */

import * as crypto from 'node:crypto'
import { getHellGraph } from './store'
import { forwardChain } from './pln'
import { getLTI, getVLTI } from './ecan'
import { recordAttentionSnapshot, runSINDyPass } from './prometheus'

const DECAY_AFTER_DAYS       = 14
const DECAY_RATE             = 0.85    // confidence *= 0.85 per day beyond threshold
const CONFIDENCE_FLOOR       = 0.10
const PROMOTE_THRESHOLD      = 0.70    // MERGE_PROPOSAL confidence >= this → RELATED_TO
const LTI_VLTI_THRESHOLD     = 700
const POLICY_ID              = 'policy://hellgraph/consolidation@0.1.0'

export interface ConsolidationResult {
  decayedTruthValues: number
  mergedProposals:    number
  plnDerived:         number
  plnRevised:         number
  plnAbduced:         number
  vltiPromoted:       number
  memoryReleaseId:    string
  durationMs:         number
  prometheusCandidate?: string  // candidateId if SINDy ran successfully
}

export function consolidate(): ConsolidationResult {
  const startMs = Date.now()
  const g       = getHellGraph()
  const now     = Date.now()
  const ts      = new Date().toISOString()

  // ── 1. TruthValue temporal decay ──────────────────────────────────────────
  let decayedTruthValues = 0

  for (const atom of g.allNodes()) {
    if (!atom.labels.includes('FeatureAtom')) continue
    if (getVLTI(atom.id)) continue   // VLTI atoms are exempt

    // Find most recent MENTIONED_IN edge timestamp
    const mentionEdges = g.outEdges(atom.id, 'MENTIONED_IN')
    if (mentionEdges.length === 0) continue

    const lastMentionStr = mentionEdges
      .map(e => String(e.properties['createdAt'] ?? ''))
      .filter(Boolean)
      .sort()
      .at(-1)
    if (!lastMentionStr) continue

    const lastMs = new Date(lastMentionStr).getTime()
    if (isNaN(lastMs)) continue

    const daysSince = (now - lastMs) / 86_400_000
    if (daysSince <= DECAY_AFTER_DAYS) continue

    const daysOver = daysSince - DECAY_AFTER_DAYS
    const existingConf = Number(atom.properties['confidence'] ?? 1.0)
    const decayed = Math.max(existingConf * Math.pow(DECAY_RATE, daysOver), CONFIDENCE_FLOOR)

    if (decayed < existingConf - 0.001) {
      g.setNodeProperty(atom.id, 'confidence', Number(decayed.toFixed(4)))
      decayedTruthValues++
    }
  }

  // ── 2. Batch MERGE_PROPOSAL → RELATED_TO promotion ────────────────────────
  let mergedProposals = 0

  for (const edge of g.allEdges().filter(e => e.label === 'MERGE_PROPOSAL')) {
    const conf = Number(edge.properties['confidence'] ?? 0)
    if (conf < PROMOTE_THRESHOLD) continue

    // Promote to RELATED_TO
    g.addEdge('RELATED_TO', edge.from, edge.to, {
      epistemicClass:  'semantic',
      confidence:      conf,
      promotionState:  'consolidated',
      createdAt:       ts,
    })

    // Emit DecisionLedgerEntry — every merge must be ledgered per ACR invariant
    const decisionId = `urn:regis:decision:${crypto.randomUUID().slice(0, 12)}`
    g.addNode(decisionId, ['DecisionLedgerEntry'], {
      decision_type:  'merge',
      subject_a:      edge.from,
      subject_b:      edge.to,
      confidence:     conf,
      reason:         'consolidation_sleep_pass',
      policy_id:      POLICY_ID,
      created_by:     'system',
      createdAt:      ts,
    })

    mergedProposals++
  }

  // ── 3. Deep PLN pass ──────────────────────────────────────────────────────
  const plnResult = forwardChain({ maxIters: 200, runRevision: true, runAbduction: true })

  // ── 4. VLTI promotion ─────────────────────────────────────────────────────
  let vltiPromoted = 0

  for (const atom of g.allNodes()) {
    if (!atom.labels.includes('FeatureAtom')) continue
    if (getVLTI(atom.id)) continue

    if (getLTI(atom.id) >= LTI_VLTI_THRESHOLD) {
      g.setNodeProperty(atom.id, 'ecan:vlti', true)
      vltiPromoted++
    }
  }

  // ── 5. SemanticMemoryRelease audit node ────────────────────────────────────
  // Mirrors graphbrain-contract/memory_runtime_api.py SemanticMemoryRelease
  const memoryReleaseId = `urn:regis:memory-release:${Date.now()}`
  g.addNode(memoryReleaseId, ['SemanticMemoryRelease'], {
    decayedTruthValues,
    mergedProposals,
    plnDerived:    plnResult.derived,
    plnRevised:    plnResult.revised,
    plnAbduced:    plnResult.abduced,
    vltiPromoted,
    policy_id:     POLICY_ID,
    promotion_status: 'completed',
    createdAt:     ts,
  })

  // ── 6. Prometheus attention snapshot + SINDy adaptive decay ────────────────
  // Record the current avg_sti state as a data point for SINDy time-series fitting.
  // When >= 3 snapshots exist, SINDy fits the decay equation and updates ECAN's
  // adaptive decay factor automatically.
  recordAttentionSnapshot()
  runSINDyPass().then(candidate => {
    if (candidate) {
      g.setNodeProperty(memoryReleaseId, 'prometheusCandidate', candidate.candidateId)
    }
  }).catch(() => {/* sidecar unavailable — degrade gracefully */})

  return {
    decayedTruthValues,
    mergedProposals,
    plnDerived:    plnResult.derived,
    plnRevised:    plnResult.revised,
    plnAbduced:    plnResult.abduced,
    vltiPromoted,
    memoryReleaseId,
    durationMs:    Date.now() - startMs,
  }
}
