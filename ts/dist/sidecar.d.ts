import type { SINDySeries, PlatformDynamicsCandidate } from './prometheus';
export interface SidecarHealth {
    available: boolean;
    atom_count: number;
    import_error: string | null;
    capabilities: {
        pattern_matcher: boolean;
        pln: boolean;
        ure: boolean;
        ecan: boolean;
    };
    version: string;
}
export declare function sidecarHealth(): Promise<SidecarHealth | null>;
/** Push the entire HellGraph metagraph into the sidecar's AtomSpace as Atomese. */
export declare function syncToSidecar(): Promise<{
    added: number;
    atom_count: number;
}>;
/** Run a BindLink/GetLink through the real OpenCog Pattern Matcher. */
export declare function runBindLink(bindlink: string): Promise<{
    result: string;
}>;
/** PLN forward chaining over the sidecar AtomSpace. */
export declare function plnForwardChain(iterations?: number, focus?: string): Promise<{
    result: string;
}>;
/** ECAN attention allocation — stimulate an atom's short-term importance. */
export declare function ecanStimulate(atom: string, sti?: number): Promise<{
    result: string;
}>;
/** Evaluate arbitrary Atomese/Scheme in the sidecar (advanced/escape hatch). */
export declare function evalScheme(code: string): Promise<{
    result: string;
}>;
export interface SHACLValidateResult {
    conforms: boolean;
    violations: {
        focusNode: string;
        path?: string;
        message: string;
        severity: string;
        constraint: string;
    }[];
    rulesApplied: number;
}
/** Validate HellGraph triples against shapes using pyshacl (full W3C compliance). */
export declare function shaclValidate(shapesText: string): Promise<SHACLValidateResult | null>;
/**
 * Pull PLN-derived edges from the sidecar's 2-hop derivation pass and write them
 * back into the TypeScript HellGraph. This closes the bidirectionality gap: the
 * Python side runs an independent PLN derivation on its AtomSpaceLite mirror and
 * returns any RELATED_TO edges it found that HellGraph doesn't have yet.
 */
export declare function pullFromSidecar(): Promise<{
    imported: number;
}>;
/** Apply SHACL SPARQL data-derivation rules via pyshacl and return count of new triples. */
export declare function shaclApplyRules(shapesText: string): Promise<{
    added: number;
} | null>;
export interface RawRelationEdge {
    node1: string;
    relation: string;
    node2: string;
    provenance_ref?: string;
    source_evidence_ref?: string;
}
export interface CSKGEdge {
    edge_id: string;
    node1: string;
    relation: string;
    node2: string;
    provenance_refs: string[];
    source_evidence_refs: string[];
}
/**
 * Normalize raw relation triples through the graphbrain-contract CSKG normalizer.
 * Returns the canonicalized edges, or null if the sidecar is unavailable.
 */
export declare function normalizeThroughSidecar(edges: RawRelationEdge[]): Promise<CSKGEdge[] | null>;
/**
 * Run the SINDy fast-path symbolic regression on a time series via the sidecar.
 * Returns a PlatformDynamicsCandidate, or null if the sidecar is unavailable.
 */
export declare function runSINDy(series: SINDySeries[], stateVariable: string, datasetUri: string): Promise<PlatformDynamicsCandidate | null>;
export interface EpisodeRef {
    episode_id: string;
    working_memory_ref: string;
    request_metadata: Record<string, unknown>;
    retrieval_path?: unknown[];
    recommendation_object_refs?: string[];
}
export interface TopicDelta {
    topic_id: string;
    delta_type: string;
    weight: number;
    evidence_refs: string[];
}
export interface DriftReport {
    report_id: string;
    corpus_delta_ids: string[];
    episode_refs: string[];
    candidate_topic_deltas: TopicDelta[];
    notes: string;
    created_at: string;
}
/**
 * Consume EpisodeBundles through OnlineLDAMaintainer to produce a DriftReport.
 * Returns null if the sidecar is unavailable or the latent module isn't loaded.
 */
export declare function consumeEpisodeDrift(episodes: EpisodeRef[], corpusDeltaIds?: string[]): Promise<DriftReport | null>;
//# sourceMappingURL=sidecar.d.ts.map