"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sidecarHealth = sidecarHealth;
exports.syncToSidecar = syncToSidecar;
exports.runBindLink = runBindLink;
exports.plnForwardChain = plnForwardChain;
exports.ecanStimulate = ecanStimulate;
exports.evalScheme = evalScheme;
exports.shaclValidate = shaclValidate;
exports.pullFromSidecar = pullFromSidecar;
exports.shaclApplyRules = shaclApplyRules;
exports.normalizeThroughSidecar = normalizeThroughSidecar;
exports.runSINDy = runSINDy;
exports.consumeEpisodeDrift = consumeEpisodeDrift;
const atomspace_1 = require("./atomspace");
const atomese_1 = require("./atomese");
const store_1 = require("./store");
/**
 * Client for the OpenCog sidecar (opencog-sidecar/server.py).
 *
 * HellGraph is the system-of-record; the sidecar is the inference co-processor.
 * This client pushes our metagraph (as Atomese) into the sidecar's real
 * AtomSpace and delegates Pattern Matcher / PLN / ECAN work the pure-TS engine
 * does not perform. Every method degrades gracefully when the sidecar is absent.
 */
const DEFAULT_SIDECAR_URL = 'http://127.0.0.1:8137';
function sidecarUrl() {
    return process.env.HELLGRAPH_SIDECAR_URL?.replace(/\/$/, '') || DEFAULT_SIDECAR_URL;
}
async function call(path, init) {
    const res = await fetch(`${sidecarUrl()}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
        signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`sidecar ${res.status}: ${detail}`);
    }
    return res.json();
}
async function sidecarHealth() {
    try {
        return await call('/health');
    }
    catch {
        return null;
    }
}
/** Push the entire HellGraph metagraph into the sidecar's AtomSpace as Atomese. */
async function syncToSidecar() {
    const atomese = (0, atomese_1.dumpAtomese)((0, atomspace_1.getAtomSpace)());
    return call('/atomese/load', { method: 'POST', body: JSON.stringify({ atomese }) });
}
/** Run a BindLink/GetLink through the real OpenCog Pattern Matcher. */
async function runBindLink(bindlink) {
    return call('/pattern', { method: 'POST', body: JSON.stringify({ bindlink }) });
}
/** PLN forward chaining over the sidecar AtomSpace. */
async function plnForwardChain(iterations = 10, focus) {
    return call('/pln/forward', { method: 'POST', body: JSON.stringify({ iterations, focus }) });
}
/** ECAN attention allocation — stimulate an atom's short-term importance. */
async function ecanStimulate(atom, sti = 100) {
    return call('/ecan/stimulate', { method: 'POST', body: JSON.stringify({ atom, sti }) });
}
/** Evaluate arbitrary Atomese/Scheme in the sidecar (advanced/escape hatch). */
async function evalScheme(code) {
    return call('/scheme', { method: 'POST', body: JSON.stringify({ code }) });
}
/** Validate HellGraph triples against shapes using pyshacl (full W3C compliance). */
async function shaclValidate(shapesText) {
    try {
        const atomese = (0, atomese_1.dumpAtomese)((0, atomspace_1.getAtomSpace)());
        return await call('/shacl/validate', {
            method: 'POST',
            body: JSON.stringify({ shapes: shapesText, atomese }),
        });
    }
    catch {
        return null;
    }
}
/**
 * Pull PLN-derived edges from the sidecar's 2-hop derivation pass and write them
 * back into the TypeScript HellGraph. This closes the bidirectionality gap: the
 * Python side runs an independent PLN derivation on its AtomSpaceLite mirror and
 * returns any RELATED_TO edges it found that HellGraph doesn't have yet.
 */
async function pullFromSidecar() {
    try {
        const result = await call('/pln/derived');
        if (result.count === 0)
            return { imported: 0 };
        const g = (0, store_1.getHellGraph)();
        const ts = new Date().toISOString();
        let imported = 0;
        for (const edge of result.edges) {
            // Only import if both endpoint atoms already exist in HellGraph
            if (!g.getNode(edge.from) || !g.getNode(edge.to))
                continue;
            g.addEdge(edge.relation, edge.from, edge.to, {
                epistemicClass: edge.epistemicClass,
                confidence: edge.confidence,
                promotionState: 'inferred',
                createdAt: ts,
            });
            imported++;
        }
        return { imported };
    }
    catch {
        return { imported: 0 };
    }
}
/** Apply SHACL SPARQL data-derivation rules via pyshacl and return count of new triples. */
async function shaclApplyRules(shapesText) {
    try {
        const atomese = (0, atomese_1.dumpAtomese)((0, atomspace_1.getAtomSpace)());
        return await call('/shacl/rules', {
            method: 'POST',
            body: JSON.stringify({ shapes: shapesText, atomese }),
        });
    }
    catch {
        return null;
    }
}
/**
 * Normalize raw relation triples through the graphbrain-contract CSKG normalizer.
 * Returns the canonicalized edges, or null if the sidecar is unavailable.
 */
async function normalizeThroughSidecar(edges) {
    if (edges.length === 0)
        return [];
    try {
        const result = await call('/cskg/normalize', {
            method: 'POST',
            body: JSON.stringify({ relations: edges }),
        });
        return result.edges;
    }
    catch {
        return null;
    }
}
// ─── Prometheus SINDy ─────────────────────────────────────────────────────────
/**
 * Run the SINDy fast-path symbolic regression on a time series via the sidecar.
 * Returns a PlatformDynamicsCandidate, or null if the sidecar is unavailable.
 */
async function runSINDy(series, stateVariable, datasetUri) {
    if (series.length < 3)
        return null;
    try {
        return await call('/prometheus/sindy', {
            method: 'POST',
            body: JSON.stringify({ series, stateVariable, datasetUri }),
        });
    }
    catch {
        return null;
    }
}
/**
 * Consume EpisodeBundles through OnlineLDAMaintainer to produce a DriftReport.
 * Returns null if the sidecar is unavailable or the latent module isn't loaded.
 */
async function consumeEpisodeDrift(episodes, corpusDeltaIds = []) {
    if (episodes.length === 0)
        return null;
    try {
        return await call('/latent/consume', {
            method: 'POST',
            body: JSON.stringify({ episodes, corpusDeltaIds }),
        });
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=sidecar.js.map