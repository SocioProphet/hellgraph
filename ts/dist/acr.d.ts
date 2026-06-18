/**
 * acr.ts — Regis ACR (Adaptive Concordance Resolution) contract layer for HellGraph.
 *
 * Implements the contract types and factory functions from
 * SocioProphet/regis-entity-graph/contracts/acr-contract-pack.yaml.
 *
 * Every entity in HellGraph has a full ACR lifecycle:
 *
 *   SourceRecord         — the raw, preserved extraction event
 *     │
 *     ├─ EvidenceClaim   — typed assertion extracted from the source
 *     │
 *     └─ ConcordanceLink → CanonicalEntity   — resolved canonical projection
 *                              │
 *                              └─ DecisionLedgerEntry   — every merge/promotion audited
 *                                       │
 *                                       └─ EnergyLedgerEntry  — resolver energy accounting
 *
 * Invariants from the contract pack (enforced here):
 *   - Canonical updates/merges require a DecisionLedgerEntry
 *   - SourceRecord raw payloads are preserved (never overwritten)
 *   - EvidenceClaim does not overwrite canonical state without a ledgered decision
 *   - Low-margin EnergyLedgerEntry outputs must not be auto-promoted
 *
 * Usage:
 *   import { assertCanonicalEntity, assertConcordanceLink, assertDecisionLedgerEntry } from './acr'
 */
export interface CanonicalEntityRecord {
    entity_id: string;
    entity_type: string;
    status: 'pending_review' | 'active' | 'rejected' | 'archived';
    policy_id: string;
    identity_prime_scopes: string[];
    attributes: Record<string, unknown>;
    source_record_refs: string[];
    evidence_claim_refs: string[];
    decision_ledger_refs: string[];
}
export interface SourceRecord {
    source_id: string;
    raw_surface: string;
    normalised: string;
    source_type: string;
    confidence: number;
    ingested_at: string;
}
export interface EvidenceClaim {
    claim_id: string;
    source_ref: string;
    claim_type: string;
    subject_ref: string;
    predicate: string;
    object_ref: string;
    confidence: number;
}
export interface ConcordanceLink {
    link_id: string;
    source_record_ref: string;
    canonical_entity_ref: string;
    status: 'proposed' | 'confirmed' | 'rejected';
    score: number;
    policy_id: string;
    resolver: string;
}
export interface DecisionLedgerEntry {
    decision_id: string;
    decision_type: 'match' | 'non_match' | 'merge' | 'split' | 'promotion' | 'rejection' | 'override' | 'stewardship';
    subject_refs: string[];
    confidence: number;
    reason: string;
    policy_id: string;
    created_by: string;
    created_at: string;
}
export interface EnergyLedgerEntry {
    energy_id: string;
    candidate_a: string;
    candidate_b: string;
    similarity_score: number;
    margin: number;
    stable: boolean;
    promotion_decision: 'promote' | 'hold' | 'reject';
    resolver: string;
    created_at: string;
}
export declare function assertCanonicalEntity(entity: CanonicalEntityRecord): string;
export declare function assertSourceRecord(record: SourceRecord): string;
export declare function assertEvidenceClaim(claim: EvidenceClaim): string;
export declare function assertConcordanceLink(link: ConcordanceLink): string;
export declare function assertDecisionLedgerEntry(entry: DecisionLedgerEntry): string;
export declare function assertEnergyLedgerEntry(entry: EnergyLedgerEntry): string;
export interface EntityExtractionACR {
    surface: string;
    normalised: string;
    kind: string;
    confidence: number;
    extractedBy: string;
    interactionId: string;
    primeScopes: string[];
    timestamp: string;
    similarityScore?: number;
    margin?: number;
}
export declare function recordEntityExtraction(opts: EntityExtractionACR): {
    sourceId: string;
    canonicalId: string;
    decisionId: string;
};
//# sourceMappingURL=acr.d.ts.map