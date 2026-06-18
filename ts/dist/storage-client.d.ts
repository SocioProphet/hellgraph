/**
 * StorageNodeClient — connects to a remote AtomSpace StorageNode.
 *
 * Enables distributed AtomSpace federation across Noetica instances:
 *   - fetchAtom / fetchByType: read atoms from a remote node
 *   - pushAtom / bulkSync: write local atoms to a remote node
 *   - subscribeChangeFeed: real-time SSE stream of remote mutations
 *
 * Usage (single-direction pull from a cloud node):
 *   const client = new StorageNodeClient('https://node.example.com')
 *   await client.bulkSync(space.allAtoms())  // push local state
 *   client.subscribeChangeFeed((entry) => space.importEntry(entry))
 */
import type { Atom, AtomLogEntry, Handle } from './atomspace.js';
export interface StorageNodeStats {
    total: number;
    nodes: number;
    links: number;
    types: Record<string, number>;
    logicalClock: number;
    storagePath: string;
}
export declare class StorageNodeClient {
    private readonly baseUrl;
    private readonly headers;
    private feedController;
    constructor(baseUrl: string, authToken?: string);
    stats(): Promise<StorageNodeStats>;
    fetchAtom(handle: Handle): Promise<Atom | null>;
    fetchBatch(handles: Handle[]): Promise<Atom[]>;
    fetchByType(type: string): Promise<Atom[]>;
    bulkSync(atoms: Atom[], sourceId?: string): Promise<number>;
    /**
     * Subscribe to the remote node's SSE change feed.
     * Calls onEntry for each remote mutation — caller should call
     * space.importEntry(entry) to merge the change locally.
     * Returns an unsubscribe function.
     */
    subscribeChangeFeed(onEntry: (entry: AtomLogEntry) => void, onError?: (err: Error) => void): () => void;
    disconnect(): void;
}
//# sourceMappingURL=storage-client.d.ts.map