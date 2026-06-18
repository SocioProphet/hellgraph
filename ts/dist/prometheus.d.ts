/**
 * prometheus.ts — Prometheus symbolic regression integration for HellGraph.
 *
 * Wires the SINDy (Sparse Identification of Nonlinear Dynamics) fast path into
 * the ECAN attention subsystem. Every consolidation pass records a snapshot of
 * the graph's aggregate attention state. Once enough snapshots accumulate, SINDy
 * fits the governing decay equation: d(avg_sti)/dt = coeff * avg_sti + intercept.
 * The discovered coefficient is converted to a discrete per-tick decay factor and
 * fed back into decayAll() as an adaptive replacement for the hardcoded 0.85.
 *
 * This is genuinely novel: the knowledge graph's own attention dynamics discover
 * their decay law from first principles rather than using a hand-tuned constant.
 *
 * The PlatformDynamicsCandidate produced by SINDy is also written into HellGraph
 * as a node so the consolidation history is queryable and auditable.
 */
export interface SINDySeries {
    t: number;
    y: number;
}
export interface PlatformDynamicsCandidate {
    artifactType: 'PlatformDynamicsCandidate';
    applicationMode: string;
    candidateId: string;
    methodFamily: 'sindy';
    implementationMode: string;
    datasetRef: {
        uri: string;
        contentHash: string;
        hashAlgorithm: string;
    };
    timeColumn: string;
    stateVariable: string;
    equationLatex: string;
    coefficient: number;
    intercept: number;
    fitMetric: {
        name: string;
        value: number;
    };
    complexity: number;
    unitsStatus: string;
    promotionState: string;
    controlAuthority: false;
    nonAuthorityDeclaration: string;
    issuedAt: string;
    sampleCount: number;
}
export declare function recordAttentionSnapshot(): void;
export declare function exportAttentionSeries(): SINDySeries[];
export declare function ingestPrometheusCandidate(candidate: PlatformDynamicsCandidate): string;
export declare function discreteDecayFactor(coefficient: number, dtSeconds?: number): number;
/**
 * Push the current attention snapshot to prometheusd so it accumulates
 * collective history across sessions. Also writes the snapshot node to HellGraph.
 * Call this on every ECAN decay tick (every 30 min) not just on consolidation.
 */
export declare function pushSnapshotToPrometheusd(epochMs: number, avgSTI: number, atomCount: number, sessionId?: string): Promise<void>;
export declare function runSINDyPass(): Promise<PlatformDynamicsCandidate | null>;
//# sourceMappingURL=prometheus.d.ts.map