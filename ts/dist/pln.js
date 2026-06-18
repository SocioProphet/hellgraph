"use strict";
/**
 * PLN — Probabilistic Logic Networks forward chaining for HellGraph.
 *
 * Implements three inference rules over the RELATED_TO edge type:
 *
 *   Deduction (2-hop):
 *     A→B (s1,c1) + B→C (s2,c2) → A→C (s1*s2, c1*c2*0.9)
 *
 *   Revision (multi-source):
 *     A→B from source 1 (s1,c1) + A→B from source 2 (s2,c2)
 *     → A→B strengthened: s = (s1*c1+s2*c2)/(c1+c2), c = c1+c2-c1*c2
 *
 *   Abduction (shared neighborhood):
 *     A→C (strong) + B→C (strong) + A,B not yet linked
 *     → A→B (conservative: s1*s2*0.4, c1*c2*0.4) — they might be related
 *
 * The sidecar (OpenCog PLN) handles full URE-backed chaining with all rules.
 * This TypeScript path is the fast, in-process fallback for zero-latency inference.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.forwardChain = forwardChain;
const store_1 = require("./store");
const MIN_STRENGTH = 0.30;
const DEFAULT_MAX_ITERS = 80;
const CHAIN_EDGE = 'RELATED_TO';
const ABD_MIN_STRENGTH = 0.55; // minimum edge strength to trigger abduction
/**
 * Run PLN forward chaining over RELATED_TO edges.
 * Applies deduction, revision, and abduction rules.
 */
function forwardChain(opts = {}) {
    const maxIters = opts.maxIters ?? DEFAULT_MAX_ITERS;
    const runRevision = opts.runRevision ?? true;
    const runAbduction = opts.runAbduction ?? true;
    const g = (0, store_1.getHellGraph)();
    const allEdges = g.allEdges().filter(e => e.label === CHAIN_EDGE);
    const adj = new Map();
    for (const e of allEdges) {
        if (!adj.has(e.from))
            adj.set(e.from, []);
        const s = Number(e.properties['confidence'] ?? 0.5);
        const c = Number(e.properties['confidence'] ?? 0.5);
        const src = String(e.properties['epistemicClass'] ?? 'unknown');
        adj.get(e.from).push({ to: e.to, s, c, sources: [src] });
    }
    let derived = 0;
    let rulesFired = 0;
    let revised = 0;
    let abduced = 0;
    let changed = true;
    let iters = 0;
    const now = () => new Date().toISOString();
    // ── Revision: strengthen edges that have multiple independent source paths ──
    if (runRevision) {
        for (const [a, neighbors] of adj) {
            // Group edges to same target from multiple epistemic sources
            const byTarget = new Map();
            for (const n of neighbors) {
                if (!byTarget.has(n.to))
                    byTarget.set(n.to, []);
                byTarget.get(n.to).push(n);
            }
            for (const [b, paths] of byTarget) {
                if (paths.length < 2)
                    continue;
                // Bayesian revision: s = weighted average, c = bounded sum
                let totalWeight = 0, totalS = 0;
                for (const p of paths) {
                    totalS += p.s * p.c;
                    totalWeight += p.c;
                }
                const s_revised = totalWeight > 0 ? totalS / totalWeight : paths[0].s;
                let c_revised = 0;
                for (const p of paths) {
                    c_revised = c_revised + p.c - c_revised * p.c;
                }
                c_revised = Math.min(c_revised, 0.99);
                // Only update if meaningfully stronger
                const best = paths.reduce((m, p) => p.s > m.s ? p : m, paths[0]);
                if (s_revised > best.s * 1.05 || c_revised > best.c * 1.05) {
                    g.addEdge(CHAIN_EDGE, a, b, {
                        epistemicClass: 'pln_revision',
                        confidence: Math.min(s_revised, 1),
                        promotionState: 'inferred',
                        createdAt: now(),
                    });
                    rulesFired++;
                    revised++;
                    // Update local adj with revised strength
                    const existing = adj.get(a).find(n => n.to === b);
                    if (existing) {
                        existing.s = s_revised;
                        existing.c = c_revised;
                    }
                }
            }
        }
    }
    // ── Deduction: A→B + B→C → A→C ──────────────────────────────────────────
    while (changed && iters < maxIters) {
        changed = false;
        iters++;
        for (const [a, aNeighbors] of adj) {
            for (const { to: b, s: p1, c: c1 } of aNeighbors) {
                const bNeighbors = adj.get(b) ?? [];
                for (const { to: cc, s: p2, c: c2 } of bNeighbors) {
                    if (cc === a)
                        continue;
                    const inferredS = p1 * p2;
                    const inferredC = c1 * c2 * 0.9;
                    if (inferredS < MIN_STRENGTH)
                        continue;
                    const existing = adj.get(a)?.find(n => n.to === cc);
                    if (existing && existing.s >= inferredS)
                        continue;
                    g.addEdge(CHAIN_EDGE, a, cc, {
                        epistemicClass: 'pln_deduction',
                        confidence: inferredS,
                        promotionState: 'inferred',
                        createdAt: now(),
                    });
                    rulesFired++;
                    derived++;
                    changed = true;
                    if (!adj.has(a))
                        adj.set(a, []);
                    const aAdj = adj.get(a);
                    const existIdx = aAdj.findIndex(n => n.to === cc);
                    if (existIdx >= 0) {
                        aAdj[existIdx].s = inferredS;
                        aAdj[existIdx].c = inferredC;
                    }
                    else {
                        aAdj.push({ to: cc, s: inferredS, c: inferredC, sources: ['pln_deduction'] });
                    }
                }
            }
        }
    }
    // ── Abduction: A→C (strong) + B→C (strong) → maybe A→B ──────────────────
    // Nodes sharing 3+ strong common neighbors are probably related.
    if (runAbduction) {
        // Build reverse index: target → [sources that point to it strongly]
        const reverseAdj = new Map();
        for (const [a, neighbors] of adj) {
            for (const { to, s, c } of neighbors) {
                if (s < ABD_MIN_STRENGTH)
                    continue;
                if (!reverseAdj.has(to))
                    reverseAdj.set(to, []);
                reverseAdj.get(to).push({ from: a, s, c });
            }
        }
        // Find pairs (A, B) that share enough common targets
        const pairs = new Map();
        for (const [, sources] of reverseAdj) {
            if (sources.length < 2)
                continue;
            for (let i = 0; i < sources.length; i++) {
                for (let j = i + 1; j < sources.length; j++) {
                    const A = sources[i].from, B = sources[j].from;
                    if (A === B)
                        continue;
                    const key = A < B ? `${A}|${B}` : `${B}|${A}`;
                    if (!pairs.has(key))
                        pairs.set(key, { a: A, b: B, shared: 0, minS: 1, minC: 1 });
                    const p = pairs.get(key);
                    p.shared++;
                    p.minS = Math.min(p.minS, sources[i].s, sources[j].s);
                    p.minC = Math.min(p.minC, sources[i].c, sources[j].c);
                }
            }
        }
        const ABD_SHARED_THRESHOLD = 3;
        for (const { a, b, shared, minS, minC } of pairs.values()) {
            if (shared < ABD_SHARED_THRESHOLD)
                continue;
            // Already directly connected? Skip
            if (adj.get(a)?.some(n => n.to === b) || adj.get(b)?.some(n => n.to === a))
                continue;
            const abdS = minS * minS * 0.4; // conservative — abduction is weak evidence
            const abdC = minC * minC * 0.4;
            if (abdS < MIN_STRENGTH)
                continue;
            g.addEdge(CHAIN_EDGE, a, b, {
                epistemicClass: 'pln_abduction',
                confidence: abdS,
                promotionState: 'candidate',
                sharedNeighbors: shared,
                createdAt: now(),
            });
            abduced++;
            rulesFired++;
        }
    }
    return { derived, rulesFired, iterations: iters, revised, abduced };
}
//# sourceMappingURL=pln.js.map