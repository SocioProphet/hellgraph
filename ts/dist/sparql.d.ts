import type { HellGraphStore } from './store';
import type { Binding, SparqlResult, Triple } from './types';
export type { Binding, SparqlResult };
export declare function runSparqlConstruct(store: HellGraphStore, queryText: string): Triple[];
export declare function runSparql(store: HellGraphStore, queryText: string): SparqlResult;
//# sourceMappingURL=sparql.d.ts.map