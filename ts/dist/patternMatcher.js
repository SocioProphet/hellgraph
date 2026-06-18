"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.L = exports.N = exports.V = void 0;
exports.findMatches = findMatches;
const atomspace_1 = require("./atomspace");
// ─── Builder helpers (ergonomic pattern construction) ──────────────────────────
const V = (name, type) => ({ kind: 'var', name, type });
exports.V = V;
const N = (type, name) => ({ kind: 'node', type, name });
exports.N = N;
const L = (type, ...outgoing) => ({ kind: 'link', type, outgoing });
exports.L = L;
// ─── Matcher ───────────────────────────────────────────────────────────────────
function findMatches(as, pattern) {
    let groundings = [{}];
    for (const clause of pattern.clauses) {
        const next = [];
        const candidates = as.getByType(clause.type); // includes subtypes via lattice
        for (const g of groundings) {
            for (const cand of candidates) {
                const merged = unifyLink(as, clause, cand, g);
                if (merged)
                    next.push(merged);
            }
        }
        groundings = next;
        if (groundings.length === 0)
            break;
    }
    // Deduplicate groundings
    const seen = new Set();
    groundings = groundings.filter((g) => {
        const key = JSON.stringify(Object.entries(g).sort());
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
    const variables = pattern.select ?? collectVars(pattern.clauses);
    const results = groundings.map((g) => {
        const row = {};
        for (const v of variables) {
            const atom = g[v] ? as.getAtom(g[v]) : undefined;
            row[v] = atom ? (atom.name ?? atom.type) : '';
        }
        return row;
    });
    return { variables, results, groundings, evaluatedAtSeq: as.logicalClock };
}
function unifyLink(as, pattern, atom, binding) {
    if (!as.types.isA(atom.type, pattern.type))
        return null;
    const out = atom.outgoing ?? [];
    if (out.length !== pattern.outgoing.length)
        return null;
    let current = binding;
    for (let i = 0; i < pattern.outgoing.length; i++) {
        current = unifyTerm(as, pattern.outgoing[i], out[i], current);
        if (!current)
            return null;
    }
    return current;
}
function unifyTerm(as, term, handle, binding) {
    switch (term.kind) {
        case 'var': {
            if (term.name in binding)
                return binding[term.name] === handle ? binding : null;
            if (term.type) {
                const atom = as.getAtom(handle);
                if (!atom || !as.types.isA(atom.type, term.type))
                    return null;
            }
            return { ...binding, [term.name]: handle };
        }
        case 'node':
            return (0, atomspace_1.nodeHandle)(term.type, term.name) === handle ? binding : null;
        case 'link': {
            const atom = as.getAtom(handle);
            if (!atom?.outgoing)
                return null;
            return unifyLink(as, term, atom, binding);
        }
    }
}
function collectVars(clauses) {
    const vars = new Set();
    const walk = (t) => {
        if (t.kind === 'var')
            vars.add(t.name);
        else if (t.kind === 'link')
            t.outgoing.forEach(walk);
    };
    clauses.forEach(walk);
    return Array.from(vars);
}
//# sourceMappingURL=patternMatcher.js.map