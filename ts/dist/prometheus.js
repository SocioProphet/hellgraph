"use strict";
/**
 * prometheus.ts — Prometheus symbolic regression integration for HellGraph.
 *
 * Wires the SINDy (Sparse Identification of Nonlinear Dynamics) fast path into
 * the ECAN attention subsystem. Every consolidation pass records a snapshot of
 * the graph's aggregate attention state. Once enough snapshots accumulate, SINDy
 * fits the governing decay equation: d(avg_sti)/dt = coeff * avg_sti + intercept.
 * The discovered coefficient is converted to a discrete per-tick decay factor and
 * fed back into decayAll() as an adaptive replacement for the hardcoded 0.85.
 *
 * This is genuinely novel: the knowledge graph's own attention dynamics discover
 * their decay law from first principles rather than using a hand-tuned constant.
 *
 * The PlatformDynamicsCandidate produced by SINDy is also written into HellGraph
 * as a node so the consolidation history is queryable and auditable.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordAttentionSnapshot = recordAttentionSnapshot;
exports.exportAttentionSeries = exportAttentionSeries;
exports.ingestPrometheusCandidate = ingestPrometheusCandidate;
exports.discreteDecayFactor = discreteDecayFactor;
exports.pushSnapshotToPrometheusd = pushSnapshotToPrometheusd;
exports.runSINDyPass = runSINDyPass;
const store_1 = require("./store");
// ─── Attention snapshot store ─────────────────────────────────────────────────
// Attention snapshots are written into HellGraph as AttentionSnapshot nodes.
// We need at least 3 to run SINDy; 5+ gives a meaningful fit.
function recordAttentionSnapshot() {
    const g = (0, store_1.getHellGraph)();
    const atoms = g.allNodes().filter(n => n.labels.includes('FeatureAtom'));
    if (atoms.length === 0)
        return;
    const stiValues = atoms.map(a => Number(a.properties['ecan:sti'] ?? 0));
    const avgSTI = stiValues.reduce((s, v) => s + v, 0) / stiValues.length;
    const ts = new Date().toISOString();
    const snapshotId = `urn:hellgraph:attention-snapshot:${Date.now()}`;
    g.addNode(snapshotId, ['AttentionSnapshot'], {
        avgSTI,
        atomCount: atoms.length,
        snapshotAt: ts,
        epochMs: Date.now(),
    });
}
function exportAttentionSeries() {
    const g = (0, store_1.getHellGraph)();
    const snapshots = g.allNodes()
        .filter(n => n.labels.includes('AttentionSnapshot'))
        .map(n => ({
        t: Number(n.properties['epochMs'] ?? 0) / 1000, // seconds
        y: Number(n.properties['avgSTI'] ?? 0),
    }))
        .filter(p => p.t > 0 && p.y > 0)
        .sort((a, b) => a.t - b.t);
    return snapshots;
}
// ─── HellGraph ingest for PlatformDynamicsCandidate ──────────────────────────
function ingestPrometheusCandidate(candidate) {
    const g = (0, store_1.getHellGraph)();
    const nodeId = candidate.candidateId;
    g.addNode(nodeId, ['PlatformDynamicsCandidate', 'PrometheusArtifact'], {
        methodFamily: candidate.methodFamily,
        implementationMode: candidate.implementationMode,
        stateVariable: candidate.stateVariable,
        equationLatex: candidate.equationLatex,
        coefficient: candidate.coefficient,
        intercept: candidate.intercept,
        nmse: candidate.fitMetric.value,
        complexity: candidate.complexity,
        promotionState: candidate.promotionState,
        controlAuthority: candidate.controlAuthority,
        sampleCount: candidate.sampleCount,
        issuedAt: candidate.issuedAt,
    });
    return nodeId;
}
// ─── Discrete decay factor from SINDy linear coefficient ─────────────────────
// SINDy fits: d(y)/dt = coeff * y + intercept (continuous time)
// For our 30-min decay tick (dt = 1800s), the discrete form is:
//   y(t+dt) = y(t) * e^(coeff * dt)
// We clamp to [0.50, 0.99] — below 0.50 is too aggressive, above 0.99 is no-op.
function discreteDecayFactor(coefficient, dtSeconds = 1800) {
    const factor = Math.exp(coefficient * dtSeconds);
    return Math.max(0.50, Math.min(0.99, factor));
}
// ─── prometheusd client ───────────────────────────────────────────────────────
// prometheusd is the primary SR runtime — a persistent local daemon with its own
// SQLite history. The sidecar is a stateless fallback when prometheusd is absent.
const PROMETHEUSD_URL = (process.env['PROMETHEUSD_URL'] ?? 'http://127.0.0.1:8890').replace(/\/$/, '');
const TIMEOUT_MS = 5_000;
async function _callPrometheusd(path, init) {
    const res = await fetch(`${PROMETHEUSD_URL}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok)
        throw new Error(`prometheusd ${res.status}`);
    return res.json();
}
/**
 * Push the current attention snapshot to prometheusd so it accumulates
 * collective history across sessions. Also writes the snapshot node to HellGraph.
 * Call this on every ECAN decay tick (every 30 min) not just on consolidation.
 */
async function pushSnapshotToPrometheusd(epochMs, avgSTI, atomCount, sessionId) {
    try {
        await _callPrometheusd('/attention/record', {
            method: 'POST',
            body: JSON.stringify({ epoch_ms: epochMs, avg_sti: avgSTI, atom_count: atomCount, session_id: sessionId ?? null }),
        });
    }
    catch {
        // prometheusd not running — snapshot only lives in HellGraph until daemon starts
    }
}
// ─── SINDy pass: prometheusd → sidecar fallback → update ECAN decay ──────────
// Imported lazily to avoid circular dep with sidecar.ts which imports from store.ts
const SINDY_MIN_SAMPLES = 3;
async function runSINDyPass() {
    // Primary: ask prometheusd to run /sindy/auto — it uses its full cross-session history
    try {
        const candidate = await _callPrometheusd('/sindy/auto', { method: 'POST' });
        if (candidate.ok === false)
            return null; // insufficient data
        ingestPrometheusCandidate(candidate);
        if (candidate.fitMetric.value <= 0.1 && candidate.coefficient < 0) {
            const { setAdaptiveDecayFactor } = await Promise.resolve().then(() => __importStar(require('./ecan.js')));
            setAdaptiveDecayFactor(discreteDecayFactor(candidate.coefficient));
        }
        return candidate;
    }
    catch { /* prometheusd offline — fall through to sidecar */ }
    // Fallback: local series → sidecar (stateless, single-session)
    const series = exportAttentionSeries();
    if (series.length < SINDY_MIN_SAMPLES)
        return null;
    try {
        const { runSINDy } = await Promise.resolve().then(() => __importStar(require('./sidecar.js')));
        const candidate = await runSINDy(series, 'avg_sti', 'urn:hellgraph:ecan-attention-series');
        if (!candidate)
            return null;
        ingestPrometheusCandidate(candidate);
        if (candidate.fitMetric.value <= 0.1 && candidate.coefficient < 0) {
            const { setAdaptiveDecayFactor } = await Promise.resolve().then(() => __importStar(require('./ecan.js')));
            setAdaptiveDecayFactor(discreteDecayFactor(candidate.coefficient));
        }
        return candidate;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=prometheus.js.map