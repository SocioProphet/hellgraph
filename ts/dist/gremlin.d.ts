import type { HellGraphStore } from './store';
import type { GraphNode, GraphEdge, GremlinResult, PropertyValue } from './types';
/**
 * A Gremlin/TinkerPop-style traversal engine over HellGraph's property graph.
 *
 * Provides a fluent traversal API (g.V().hasLabel().out().values()…) and a
 * textual parser so the same steps can be issued as a string through the query
 * endpoint, giving Neptune/TinkerPop parity on the property-graph surface.
 *
 * Supported steps: V, E, hasLabel, has(key,value), out, in, both, outE, inE,
 * values, valueMap, count, dedup, limit, order (asc/desc by property).
 */
type Traverser = GraphNode | GraphEdge | PropertyValue;
export declare class GraphTraversal {
    private store;
    private current;
    constructor(store: HellGraphStore, initial: Traverser[]);
    static g(store: HellGraphStore): GraphSource;
    hasLabel(label: string): GraphTraversal;
    has(key: string, value: PropertyValue): GraphTraversal;
    out(label?: string): GraphTraversal;
    in(label?: string): GraphTraversal;
    both(label?: string): GraphTraversal;
    outE(label?: string): GraphTraversal;
    inE(label?: string): GraphTraversal;
    values(key: string): GraphTraversal;
    valueMap(): GraphTraversal;
    dedup(): GraphTraversal;
    order(key: string, desc?: boolean): GraphTraversal;
    limit(n: number): GraphTraversal;
    count(): number;
    toList(): Traverser[];
    result(): GremlinResult;
    private nodes;
    private derive;
}
export declare class GraphSource {
    private store;
    constructor(store: HellGraphStore);
    V(): GraphTraversal;
    E(): GraphTraversal;
}
/**
 * Parse and run a textual Gremlin traversal such as:
 *   g.V().hasLabel('Interaction').out('PRODUCED').values('content').limit(5)
 */
export declare function runGremlin(store: HellGraphStore, query: string): GremlinResult;
export {};
//# sourceMappingURL=gremlin.d.ts.map