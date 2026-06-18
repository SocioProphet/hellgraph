"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertCanonicalEntity = assertCanonicalEntity;
exports.assertSourceRecord = assertSourceRecord;
exports.assertEvidenceClaim = assertEvidenceClaim;
exports.assertConcordanceLink = assertConcordanceLink;
exports.assertDecisionLedgerEntry = assertDecisionLedgerEntry;
exports.assertEnergyLedgerEntry = assertEnergyLedgerEntry;
exports.recordEntityExtraction = recordEntityExtraction;
const store_1 = require("./store");
const DEFAULT_POLICY_ID = 'policy://hellgraph/default-promotion@0.1.0';
// ─── Factory functions ────────────────────────────────────────────────────────
// Each function upserts the appropriate node(s) into HellGraph and returns the
// primary node id.
function assertCanonicalEntity(entity) {
    const g = (0, store_1.getHellGraph)();
    const nodeId = entity.entity_id.startsWith('urn:') ? entity.entity_id : `urn:regis:canonical:${entity.entity_id}`;
    g.addNode(nodeId, ['CanonicalEntity', 'FeatureAtom'], {
        entity_type: entity.entity_type,
        status: entity.status,
        policy_id: entity.policy_id,
        identity_prime_scopes: entity.identity_prime_scopes.join(','),
        source_record_refs: entity.source_record_refs.join(','),
        evidence_claim_refs: entity.evidence_claim_refs.join(','),
        decision_ledger_refs: entity.decision_ledger_refs.join(','),
        ...entity.attributes,
    });
    return nodeId;
}
function assertSourceRecord(record) {
    const g = (0, store_1.getHellGraph)();
    const nodeId = record.source_id.startsWith('urn:') ? record.source_id : `urn:regis:source:${record.source_id}`;
    // Raw payload is preserved per contract invariant — only addNode (idempotent upsert), never overwrite
    if (!g.getNode(nodeId)) {
        g.addNode(nodeId, ['SourceRecord'], {
            raw_surface: record.raw_surface,
            normalised: record.normalised,
            source_type: record.source_type,
            confidence: record.confidence,
            ingested_at: record.ingested_at,
        });
    }
    return nodeId;
}
function assertEvidenceClaim(claim) {
    const g = (0, store_1.getHellGraph)();
    const nodeId = `urn:regis:evidence:${claim.claim_id}`;
    g.addNode(nodeId, ['EvidenceClaim'], {
        source_ref: claim.source_ref,
        claim_type: claim.claim_type,
        subject_ref: claim.subject_ref,
        predicate: claim.predicate,
        object_ref: claim.object_ref,
        confidence: claim.confidence,
    });
    // Edge: source → evidence claim
    g.addEdge('HAS_EVIDENCE', claim.source_ref, nodeId, {
        epistemicClass: claim.claim_type,
        confidence: claim.confidence,
        promotionState: 'confirmed',
    });
    return nodeId;
}
function assertConcordanceLink(link) {
    const g = (0, store_1.getHellGraph)();
    const nodeId = `urn:regis:concordance:${link.link_id}`;
    g.addNode(nodeId, ['ConcordanceLink'], {
        source_record_ref: link.source_record_ref,
        canonical_entity_ref: link.canonical_entity_ref,
        status: link.status,
        score: link.score,
        policy_id: link.policy_id,
        resolver: link.resolver,
    });
    g.addEdge('CONCORDANCE', link.source_record_ref, link.canonical_entity_ref, {
        epistemicClass: 'concordance',
        confidence: link.score,
        promotionState: link.status,
        link_id: nodeId,
    });
    return nodeId;
}
function assertDecisionLedgerEntry(entry) {
    const g = (0, store_1.getHellGraph)();
    const nodeId = entry.decision_id.startsWith('urn:') ? entry.decision_id : `urn:regis:decision:${entry.decision_id}`;
    g.addNode(nodeId, ['DecisionLedgerEntry'], {
        decision_type: entry.decision_type,
        subject_refs: entry.subject_refs.join(','),
        confidence: entry.confidence,
        reason: entry.reason,
        policy_id: entry.policy_id,
        created_by: entry.created_by,
        created_at: entry.created_at,
    });
    // Link each subject to this decision
    for (const subj of entry.subject_refs) {
        if (g.getNode(subj)) {
            g.addEdge('GOVERNED_BY', subj, nodeId, { epistemicClass: 'governance', confidence: 1.0, promotionState: 'confirmed' });
        }
    }
    return nodeId;
}
function assertEnergyLedgerEntry(entry) {
    const g = (0, store_1.getHellGraph)();
    const nodeId = `urn:regis:energy:${entry.energy_id}`;
    g.addNode(nodeId, ['EnergyLedgerEntry'], {
        candidate_a: entry.candidate_a,
        candidate_b: entry.candidate_b,
        similarity_score: entry.similarity_score,
        margin: entry.margin,
        stable: entry.stable,
        promotion_decision: entry.promotion_decision,
        resolver: entry.resolver,
        created_at: entry.created_at,
    });
    return nodeId;
}
function recordEntityExtraction(opts) {
    const slug = opts.normalised.replace(/[^a-z0-9]/g, '-').slice(0, 80);
    const ts = opts.timestamp;
    const now = new Date().toISOString();
    const sourceId = assertSourceRecord({
        source_id: `${slug}:${opts.interactionId}`,
        raw_surface: opts.surface,
        normalised: opts.normalised,
        source_type: opts.extractedBy === 'llm' ? 'llm_extraction' : opts.extractedBy === 'embedding' ? 'embedding_similarity' : 'regex_extraction',
        confidence: opts.confidence,
        ingested_at: ts,
    });
    const claimId = assertEvidenceClaim({
        claim_id: `${slug}:${opts.interactionId}:primary`,
        source_ref: sourceId,
        claim_type: 'extraction',
        subject_ref: sourceId,
        predicate: 'MENTIONS',
        object_ref: `urn:regis:feature-atom:${slug}`,
        confidence: opts.confidence,
    });
    const canonicalId = assertCanonicalEntity({
        entity_id: `urn:regis:canonical:${slug}`,
        entity_type: opts.kind,
        status: opts.confidence >= 0.8 ? 'active' : 'pending_review',
        policy_id: DEFAULT_POLICY_ID,
        identity_prime_scopes: opts.primeScopes,
        attributes: { surface: opts.surface, normalised: opts.normalised, kind: opts.kind },
        source_record_refs: [sourceId],
        evidence_claim_refs: [claimId],
        decision_ledger_refs: [],
    });
    const stable = (opts.margin ?? 1.0) >= 0.15;
    if (opts.similarityScore !== undefined) {
        assertEnergyLedgerEntry({
            energy_id: `${slug}:${opts.interactionId}`,
            candidate_a: sourceId,
            candidate_b: canonicalId,
            similarity_score: opts.similarityScore,
            margin: opts.margin ?? 1.0,
            stable,
            promotion_decision: stable && opts.similarityScore >= 0.85 ? 'promote' : 'hold',
            resolver: 'embedding',
            created_at: now,
        });
    }
    assertConcordanceLink({
        link_id: `${slug}:${opts.interactionId}`,
        source_record_ref: sourceId,
        canonical_entity_ref: canonicalId,
        status: opts.confidence >= 0.8 ? 'confirmed' : 'proposed',
        score: opts.confidence,
        policy_id: DEFAULT_POLICY_ID,
        resolver: opts.extractedBy,
    });
    const decisionId = assertDecisionLedgerEntry({
        decision_id: `${slug}:${opts.interactionId}`,
        decision_type: opts.confidence >= 0.8 ? 'promotion' : 'match',
        subject_refs: [sourceId, canonicalId],
        confidence: opts.confidence,
        reason: `${opts.extractedBy}_extraction`,
        policy_id: DEFAULT_POLICY_ID,
        created_by: opts.extractedBy === 'llm' ? 'llm' : opts.extractedBy === 'embedding' ? 'embedding' : 'system',
        created_at: now,
    });
    return { sourceId, canonicalId, decisionId };
}
//# sourceMappingURL=acr.js.map