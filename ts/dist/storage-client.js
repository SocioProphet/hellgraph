"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.StorageNodeClient = void 0;
class StorageNodeClient {
    baseUrl;
    headers;
    feedController = null;
    constructor(baseUrl, authToken) {
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.headers = {
            'content-type': 'application/json',
            ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
        };
    }
    // ─── Read ─────────────────────────────────────────────────────────────────
    async stats() {
        const res = await fetch(`${this.baseUrl}/api/atomspace/stats`, { headers: this.headers });
        if (!res.ok)
            throw new Error(`StorageNode stats failed: ${res.status}`);
        return res.json();
    }
    async fetchAtom(handle) {
        const res = await fetch(`${this.baseUrl}/api/atomspace/atom/${encodeURIComponent(handle)}`, { headers: this.headers, signal: AbortSignal.timeout(5000) });
        if (res.status === 404)
            return null;
        if (!res.ok)
            throw new Error(`fetchAtom failed: ${res.status}`);
        return res.json();
    }
    async fetchBatch(handles) {
        const res = await fetch(`${this.baseUrl}/api/atomspace/fetch`, {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify({ handles }),
            signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok)
            throw new Error(`fetchBatch failed: ${res.status}`);
        const data = await res.json();
        return data.atoms;
    }
    async fetchByType(type) {
        const res = await fetch(`${this.baseUrl}/api/atomspace/by-type/${encodeURIComponent(type)}`, { headers: this.headers, signal: AbortSignal.timeout(10_000) });
        if (!res.ok)
            throw new Error(`fetchByType failed: ${res.status}`);
        const data = await res.json();
        return data.atoms;
    }
    // ─── Write ────────────────────────────────────────────────────────────────
    async bulkSync(atoms, sourceId) {
        if (atoms.length === 0)
            return 0;
        const entries = atoms.map((a) => ({
            seq: a.createdAtSeq,
            ts: a.createdAt,
            op: 'add_atom',
            payload: {
                handle: a.handle,
                type: a.type,
                name: a.name,
                outgoing: a.outgoing,
                tv: a.tv,
                av: a.av,
            },
        }));
        // Chunk into batches of 500
        let totalImported = 0;
        for (let i = 0; i < entries.length; i += 500) {
            const batch = entries.slice(i, i + 500);
            const res = await fetch(`${this.baseUrl}/api/atomspace/sync`, {
                method: 'POST',
                headers: this.headers,
                body: JSON.stringify({ entries: batch, source: sourceId }),
                signal: AbortSignal.timeout(30_000),
            });
            if (!res.ok)
                throw new Error(`bulkSync batch failed: ${res.status}`);
            const data = await res.json();
            totalImported += data.imported;
        }
        return totalImported;
    }
    // ─── Change feed ──────────────────────────────────────────────────────────
    /**
     * Subscribe to the remote node's SSE change feed.
     * Calls onEntry for each remote mutation — caller should call
     * space.importEntry(entry) to merge the change locally.
     * Returns an unsubscribe function.
     */
    subscribeChangeFeed(onEntry, onError) {
        this.feedController?.abort();
        const controller = new AbortController();
        this.feedController = controller;
        void (async () => {
            try {
                const res = await fetch(`${this.baseUrl}/api/atomspace/stream`, {
                    headers: { ...this.headers, accept: 'text/event-stream' },
                    signal: controller.signal,
                });
                if (!res.ok || !res.body)
                    throw new Error(`SSE stream failed: ${res.status}`);
                const reader = res.body.getReader();
                const dec = new TextDecoder();
                let buf = '';
                while (true) {
                    const { done, value } = await reader.read();
                    if (done)
                        break;
                    buf += dec.decode(value, { stream: true });
                    const lines = buf.split('\n');
                    buf = lines.pop() ?? '';
                    for (const line of lines) {
                        if (!line.startsWith('data:'))
                            continue;
                        const raw = line.slice(5).trim();
                        if (!raw || raw.startsWith('{"type":"connected"}'))
                            continue;
                        try {
                            const event = JSON.parse(raw);
                            if (event.entry)
                                onEntry(event.entry);
                        }
                        catch { /* skip bad SSE frame */ }
                    }
                }
            }
            catch (e) {
                if (e.name !== 'AbortError') {
                    onError?.(e instanceof Error ? e : new Error(String(e)));
                }
            }
        })();
        return () => controller.abort();
    }
    disconnect() {
        this.feedController?.abort();
        this.feedController = null;
    }
}
exports.StorageNodeClient = StorageNodeClient;
//# sourceMappingURL=storage-client.js.map