import { AtomSpace, type Handle } from './atomspace';
/**
 * Atomese codec — lossless s-expression serialization compatible with OpenCog's
 * AtomSpace text format. This is the foundation for first-class OpenCog interop:
 * the same syntax is read/written by guile, the CogServer, and StorageNodes.
 *
 *   (EvaluationLink (stv 0.9 0.8)
 *     (PredicateNode "likes")
 *     (ListLink
 *       (ConceptNode "Alice")
 *       (ConceptNode "Bob")))
 *
 * Nodes:  (TypeNode "name")
 * Links:  (TypeLink <child atoms…>)
 * TruthValue: (stv <strength> <confidence>) as an optional first form.
 */
export declare function atomToSexpr(as: AtomSpace, handle: Handle, indent?: number): string;
/** Dump the entire AtomSpace as Atomese — only top-level atoms (those with no incoming links). */
export declare function dumpAtomese(as: AtomSpace): string;
export declare function parseAtomese(as: AtomSpace, text: string): Handle[];
//# sourceMappingURL=atomese.d.ts.map