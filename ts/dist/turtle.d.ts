/**
 * Minimal Turtle 1.1 parser — enough to load SHACL shape files.
 *
 * Handles: @prefix / @base / PREFIX / BASE directives; subject-predicate-object
 * triples with `;` and `,` shorthand; blank-node property lists `[ ... ]`;
 * RDF collections `( item... )`; long strings `"""..."""`; `^^` datatype
 * annotations; `@lang` language tags; numeric and boolean literals; `a` shorthand.
 *
 * Intentionally does NOT implement full IRI resolution, graph names, or the
 * complete PN_LOCAL character class — this is for internal use on trusted
 * shape files from the ontogenesis ecosystem.
 */
export type RdfTerm = IriTerm | BNodeTerm | LiteralTerm;
export interface IriTerm {
    kind: 'iri';
    value: string;
}
export interface BNodeTerm {
    kind: 'bnode';
    value: string;
}
export interface LiteralTerm {
    kind: 'literal';
    value: string;
    datatype: string;
    language?: string;
}
export interface RdfTriple {
    s: RdfTerm;
    p: IriTerm;
    o: RdfTerm;
}
export declare function parseTurtle(text: string, baseUri?: string): RdfTriple[];
//# sourceMappingURL=turtle.d.ts.map