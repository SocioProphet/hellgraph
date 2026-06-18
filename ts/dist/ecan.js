"use strict";
/**
 * ECAN — Economic Attention Allocation for HellGraph.
 *
 * Implements a lightweight ECAN-inspired attention layer over FeatureAtom nodes:
 *   - STI (short-term importance): spikes on mention, spreads to neighbors, decays per session
 *   - LTI (long-term importance): accumulates slowly across sessions, never decays fast
 *   - VLTI (very-long-term): permanently important atoms (set manually or via LTI threshold)
 *
 * STI is the working-memory signal: what the graph is "thinking about" right now.
 * LTI is the semantic memory signal: what has consistently mattered over time.
 * Retrieval scoring multiplies base token score by (1 + sti_norm) so active concepts surface.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSTI = getSTI;
exports.getLTI = getLTI;
exports.getVLTI = getVLTI;
exports.stiNorm = stiNorm;
exports.stimulate = stimulate;
exports.spreadAttention = spreadAttention;
exports.setAdaptiveDecayFactor = setAdaptiveDecayFactor;
exports.getAdaptiveDecayFactor = getAdaptiveDecayFactor;
exports.decayAll = decayAll;
const store_1 = require("./store");
const STI_PROP = 'ecan:sti';
const LTI_PROP = 'ecan:lti';
const VLTI_PROP = 'ecan:vlti';
const STI_MAX = 1000;
const LTI_MAX = 1000;
const LTI_PROMOTE_THRESHOLD = 700; // LTI above this → VLTI = 1
const SPREAD_EDGE_TYPES = ['COOCCURS_WITH', 'RELATED_TO', 'MENTIONED_IN'];
// ─── Read helpers ─────────────────────────────────────────────────────────────
function getSTI(atomId) {
    return Number((0, store_1.getHellGraph)().getNode(atomId)?.properties[STI_PROP] ?? 0);
}
function getLTI(atomId) {
    return Number((0, store_1.getHellGraph)().getNode(atomId)?.properties[LTI_PROP] ?? 0);
}
function getVLTI(atomId) {
    return Boolean((0, store_1.getHellGraph)().getNode(atomId)?.properties[VLTI_PROP]);
}
/** Normalized STI in [0,1] for use as a retrieval score multiplier. */
function stiNorm(atomId) {
    return getSTI(atomId) / STI_MAX;
}
// ─── Write operations ─────────────────────────────────────────────────────────
/**
 * Stimulate an atom: bump STI by `amount`, accumulate LTI at 10% rate.
 * Call this every time an entity is mentioned in a message.
 */
function stimulate(atomId, amount = 100) {
    const g = (0, store_1.getHellGraph)();
    if (!g.getNode(atomId))
        return;
    const sti = Math.min(getSTI(atomId) + amount, STI_MAX);
    const lti = Math.min(getLTI(atomId) + amount * 0.1, LTI_MAX);
    g.setNodeProperty(atomId, STI_PROP, sti);
    g.setNodeProperty(atomId, LTI_PROP, lti);
    if (lti >= LTI_PROMOTE_THRESHOLD) {
        g.setNodeProperty(atomId, VLTI_PROP, true);
    }
}
/**
 * Spread attention from a stimulated atom to its neighbors.
 * Called after stimulate() for high-STI atoms.
 */
function spreadAttention(atomId, decayFactor = 0.65) {
    const g = (0, store_1.getHellGraph)();
    const sti = getSTI(atomId);
    if (sti < 20)
        return; // not worth spreading below threshold
    const spreadAmount = sti * decayFactor * 0.4;
    for (const edgeType of SPREAD_EDGE_TYPES) {
        const neighbors = g.out(atomId, edgeType);
        for (const neighbor of neighbors.slice(0, 12)) {
            const current = Number(neighbor.properties[STI_PROP] ?? 0);
            g.setNodeProperty(neighbor.id, STI_PROP, Math.min(current + spreadAmount, STI_MAX));
        }
    }
}
// Adaptive decay factor — set by Prometheus SINDy pass when enough data exists.
// Falls back to 0.85 (static default) until SINDy has enough history to fit.
let _adaptiveDecayFactor = null;
function setAdaptiveDecayFactor(factor) {
    if (factor > 0 && factor < 1)
        _adaptiveDecayFactor = factor;
}
function getAdaptiveDecayFactor() {
    return _adaptiveDecayFactor ?? 0.85;
}
/**
 * Decay all FeatureAtom STI values by `factor`.
 * Call at session boundary to simulate forgetting.
 * VLTI atoms are exempt — they never decay below 10% of STI_MAX.
 * If Prometheus SINDy has fitted a decay coefficient, uses it automatically.
 */
function decayAll(factor) {
    const f = factor ?? _adaptiveDecayFactor ?? 0.85;
    const g = (0, store_1.getHellGraph)();
    const atoms = g.allNodes().filter(n => n.labels.includes('FeatureAtom'));
    let decayed = 0;
    for (const atom of atoms) {
        const sti = Number(atom.properties[STI_PROP] ?? 0);
        if (sti <= 0)
            continue;
        const vlti = Boolean(atom.properties[VLTI_PROP]);
        const floor = vlti ? STI_MAX * 0.1 : 0;
        g.setNodeProperty(atom.id, STI_PROP, Math.max(sti * f, floor));
        decayed++;
    }
    return decayed;
}
//# sourceMappingURL=ecan.js.map