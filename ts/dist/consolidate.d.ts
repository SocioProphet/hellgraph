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
export interface ConsolidationResult {
    decayedTruthValues: number;
    mergedProposals: number;
    plnDerived: number;
    plnRevised: number;
    plnAbduced: number;
    vltiPromoted: number;
    memoryReleaseId: string;
    durationMs: number;
    prometheusCandidate?: string;
}
export declare function consolidate(): ConsolidationResult;
//# sourceMappingURL=consolidate.d.ts.map