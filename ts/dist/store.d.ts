import { AtomSpace } from './atomspace';
import type { GraphNode, GraphEdge, Triple, LogEntry, PropertyValue } from './types';
export declare class HellGraphStore {
    private as;
    constructor(as: AtomSpace);
    private projectNode;
    private projectEdge;
    addNode(id: string, labels: string[], properties?: Record<string, PropertyValue>): GraphNode;
    addEdge(label: string, from: string, to: string, properties?: Record<string, PropertyValue>): GraphEdge;
    setNodeProperty(id: string, key: string, value: PropertyValue): void;
    getNode(id: string): GraphNode | undefined;
    allNodes(): GraphNode[];
    allEdges(): GraphEdge[];
    nodesByLabel(label: string): GraphNode[];
    outEdges(nodeId: string, label?: string): GraphEdge[];
    inEdges(nodeId: string, label?: string): GraphEdge[];
    out(nodeId: string, label?: string): GraphNode[];
    in(nodeId: string, label?: string): GraphNode[];
    /** Edges where conceptH sits at outgoing position `pos` (0 = subject, 1 = object) of the ListLink. */
    private adjacentEdges;
    triples(): Triple[];
    get logicalClock(): number;
    get id(): string;
    nodeCount(): number;
    edgeCount(): number;
    orphanNodeCount(): number;
    danglingEdgeCount(): number;
    logTail(n?: number): LogEntry[];
    earliestTs(): string | undefined;
    latestTs(): string | undefined;
    /** Escape hatch to the underlying metagraph for hypergraph-native operations. */
    atomspace(): AtomSpace;
}
declare global {
    var __hellgraph_store__: HellGraphStore | undefined;
}
export declare function getHellGraph(): HellGraphStore;
//# sourceMappingURL=store.d.ts.map