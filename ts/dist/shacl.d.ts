/**
 * SHACL validation and SPARQL rule engine for HellGraph.
 *
 * Implements the SHACL constraint types actually used in the ontogenesis
 * ecosystem: sh:minCount/maxCount, sh:datatype, sh:nodeKind, sh:pattern,
 * sh:class, sh:in, sh:hasValue, sh:minInclusive/maxInclusive, sh:minLength,
 * sh:or — plus sh:SPARQLConstraint (SELECT-based) and sh:SPARQLRule
 * (CONSTRUCT-based derivation / validation result extraction).
 *
 * Shape files are parsed from raw Turtle text via lib/hellgraph/turtle.ts.
 * For full SHACL spec compliance (including sh:node, advanced path algebra,
 * recursive shapes), delegate to the OpenCog sidecar which runs pyshacl.
 *
 * Namespace resolution: HellGraph stores labels and edge types as short names
 * (the local fragment after # or /). The validator normalises shape property
 * paths to short names before comparison so shapes authored with full IRIs
 * match HellGraph's storage format.
 */
import type { HellGraphStore } from './store';
export type SHACLSeverity = 'Violation' | 'Warning' | 'Info';
export interface SHACLViolation {
    focusNode: string;
    path?: string;
    value?: string;
    message: string;
    severity: SHACLSeverity;
    constraint: string;
    shape: string;
}
export interface SHACLReport {
    conforms: boolean;
    violations: SHACLViolation[];
    /** Number of new triples added to the store by data-derivation rules. */
    rulesApplied: number;
}
/**
 * Validate the HellGraph store against SHACL shapes defined in Turtle text.
 * Returns a report with all violations found. Fires sh:SPARQLConstraint SELECT
 * queries and extracts sh:ValidationResult atoms produced by sh:SPARQLRule
 * CONSTRUCT queries.
 */
export declare function validateGraph(store: HellGraphStore, shapesText: string): SHACLReport;
/**
 * Apply data-derivation sh:SPARQLRule CONSTRUCT queries, adding inferred
 * triples back into the HellGraph store. Rules that generate sh:ValidationResult
 * atoms are skipped (those belong to validateGraph). Returns count of new
 * triples written.
 */
export declare function applyRules(store: HellGraphStore, shapesText: string): number;
//# sourceMappingURL=shacl.d.ts.map