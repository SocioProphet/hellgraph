/**
 * PLN — Probabilistic Logic Networks forward chaining for HellGraph.
 *
 * Implements three inference rules over the RELATED_TO edge type:
 *
 *   Deduction (2-hop):
 *     A→B (s1,c1) + B→C (s2,c2) → A→C (s1*s2, c1*c2*0.9)
 *
 *   Revision (multi-source):
 *     A→B from source 1 (s1,c1) + A→B from source 2 (s2,c2)
 *     → A→B strengthened: s = (s1*c1+s2*c2)/(c1+c2), c = c1+c2-c1*c2
 *
 *   Abduction (shared neighborhood):
 *     A→C (strong) + B→C (strong) + A,B not yet linked
 *     → A→B (conservative: s1*s2*0.4, c1*c2*0.4) — they might be related
 *
 * The sidecar (OpenCog PLN) handles full URE-backed chaining with all rules.
 * This TypeScript path is the fast, in-process fallback for zero-latency inference.
 */
export interface PLNResult {
    derived: number;
    rulesFired: number;
    iterations: number;
    revised: number;
    abduced: number;
}
export interface PLNOptions {
    maxIters?: number;
    runRevision?: boolean;
    runAbduction?: boolean;
}
/**
 * Run PLN forward chaining over RELATED_TO edges.
 * Applies deduction, revision, and abduction rules.
 */
export declare function forwardChain(opts?: PLNOptions): PLNResult;
//# sourceMappingURL=pln.d.ts.map