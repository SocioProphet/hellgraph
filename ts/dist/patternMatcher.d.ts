import { AtomSpace, type Handle } from './atomspace';
/**
 * Pattern Matcher — native hypergraph query over the AtomSpace.
 *
 * A pattern is a conjunction of clauses (link templates) containing variables.
 * The matcher finds every grounding: an assignment of variables to atoms that
 * makes all clauses simultaneously present in the space. Variables may carry a
 * type restriction (TypedVariable), resolved through the type lattice.
 *
 * This subsumes SPARQL basic graph patterns — clauses are full hypergraph
 * templates (any arity, links over links), not just binary triples — and is the
 * substrate the OpenCog BindLink/GetLink semantics map onto.
 */
export type PatternTerm = {
    kind: 'var';
    name: string;
    type?: string;
} | {
    kind: 'node';
    type: string;
    name: string;
} | {
    kind: 'link';
    type: string;
    outgoing: PatternTerm[];
};
export interface Pattern {
    /** Conjunctive clauses — all must match. Each is a link template. */
    clauses: Extract<PatternTerm, {
        kind: 'link';
    }>[];
    /** Variable names to project; defaults to all variables seen. */
    select?: string[];
}
/** var name → bound handle. */
export type Grounding = Record<string, Handle>;
export interface MatchResult {
    variables: string[];
    /** Each grounding, with variables resolved to readable atom labels. */
    results: Record<string, string>[];
    /** Raw handle groundings. */
    groundings: Grounding[];
    evaluatedAtSeq: number;
}
export declare const V: (name: string, type?: string) => PatternTerm;
export declare const N: (type: string, name: string) => PatternTerm;
export declare const L: (type: string, ...outgoing: PatternTerm[]) => Extract<PatternTerm, {
    kind: "link";
}>;
export declare function findMatches(as: AtomSpace, pattern: Pattern): MatchResult;
//# sourceMappingURL=patternMatcher.d.ts.map