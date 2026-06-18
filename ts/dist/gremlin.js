"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GraphSource = exports.GraphTraversal = void 0;
exports.runGremlin = runGremlin;
class GraphTraversal {
    store;
    current;
    constructor(store, initial) {
        this.store = store;
        this.current = initial;
    }
    static g(store) { return new GraphSource(store); }
    // ─── Vertex/edge navigation ──────────────────────────────────────────────
    hasLabel(label) {
        return this.derive(this.nodes().filter((n) => n.labels.includes(label)));
    }
    has(key, value) {
        return this.derive(this.nodes().filter((n) => looseEq(n.properties[key], value)));
    }
    out(label) {
        return this.derive(this.nodes().flatMap((n) => this.store.out(n.id, label)));
    }
    in(label) {
        return this.derive(this.nodes().flatMap((n) => this.store.in(n.id, label)));
    }
    both(label) {
        return this.derive(this.nodes().flatMap((n) => [...this.store.out(n.id, label), ...this.store.in(n.id, label)]));
    }
    outE(label) {
        return this.derive(this.nodes().flatMap((n) => this.store.outEdges(n.id, label)));
    }
    inE(label) {
        return this.derive(this.nodes().flatMap((n) => this.store.inEdges(n.id, label)));
    }
    // ─── Terminal-ish steps ──────────────────────────────────────────────────
    values(key) {
        const out = this.current.map((t) => (isNode(t) || isEdge(t)) ? t.properties[key] : t).filter((v) => v !== undefined);
        return this.derive(out);
    }
    valueMap() {
        const out = this.current.filter((t) => isNode(t) || isEdge(t)).map((t) => t.properties);
        return this.derive(out);
    }
    dedup() {
        const seen = new Set();
        const out = this.current.filter((t) => {
            const key = isNode(t) || isEdge(t) ? t.id : JSON.stringify(t);
            if (seen.has(key))
                return false;
            seen.add(key);
            return true;
        });
        return this.derive(out);
    }
    order(key, desc = false) {
        const sorted = [...this.current].sort((a, b) => {
            const av = isNode(a) || isEdge(a) ? a.properties[key] : a;
            const bv = isNode(b) || isEdge(b) ? b.properties[key] : b;
            const an = Number(av), bn = Number(bv);
            const cmp = !Number.isNaN(an) && !Number.isNaN(bn) ? an - bn : String(av ?? '').localeCompare(String(bv ?? ''));
            return desc ? -cmp : cmp;
        });
        return this.derive(sorted);
    }
    limit(n) { return this.derive(this.current.slice(0, n)); }
    count() { return this.current.length; }
    toList() { return this.current; }
    result() {
        return { values: this.current, count: this.current.length };
    }
    // ─── helpers ─────────────────────────────────────────────────────────────
    nodes() { return this.current.filter(isNode); }
    derive(next) { return new GraphTraversal(this.store, next); }
}
exports.GraphTraversal = GraphTraversal;
class GraphSource {
    store;
    constructor(store) {
        this.store = store;
    }
    V() { return new GraphTraversal(this.store, this.store.allNodes()); }
    E() { return new GraphTraversal(this.store, this.store.allEdges()); }
}
exports.GraphSource = GraphSource;
function isNode(t) {
    return typeof t === 'object' && t !== null && 'labels' in t;
}
function isEdge(t) {
    return typeof t === 'object' && t !== null && 'from' in t && 'to' in t;
}
function looseEq(a, b) {
    return a === b || String(a) === String(b);
}
// ─── Textual query parser ────────────────────────────────────────────────────
/**
 * Parse and run a textual Gremlin traversal such as:
 *   g.V().hasLabel('Interaction').out('PRODUCED').values('content').limit(5)
 */
function runGremlin(store, query) {
    const steps = parseSteps(query);
    if (steps.length === 0 || (steps[0].name !== 'V' && steps[0].name !== 'E')) {
        throw new Error("Gremlin parse error: traversal must start with g.V() or g.E()");
    }
    const source = GraphTraversal.g(store);
    let t = steps[0].name === 'V' ? source.V() : source.E();
    let terminalCount = null;
    for (const step of steps.slice(1)) {
        const [a, b] = step.args;
        switch (step.name) {
            case 'hasLabel':
                t = t.hasLabel(str(a));
                break;
            case 'has':
                t = t.has(str(a), coerce(b));
                break;
            case 'out':
                t = t.out(a !== undefined ? str(a) : undefined);
                break;
            case 'in':
                t = t.in(a !== undefined ? str(a) : undefined);
                break;
            case 'both':
                t = t.both(a !== undefined ? str(a) : undefined);
                break;
            case 'outE':
                t = t.outE(a !== undefined ? str(a) : undefined);
                break;
            case 'inE':
                t = t.inE(a !== undefined ? str(a) : undefined);
                break;
            case 'values':
                t = t.values(str(a));
                break;
            case 'valueMap':
                t = t.valueMap();
                break;
            case 'dedup':
                t = t.dedup();
                break;
            case 'order':
                t = t.order(str(a), b !== undefined && str(b).toLowerCase() === 'desc');
                break;
            case 'limit':
                t = t.limit(Number(a));
                break;
            case 'count':
                terminalCount = t.count();
                break;
            default: throw new Error(`Gremlin parse error: unknown step '${step.name}'`);
        }
    }
    if (terminalCount !== null)
        return { values: [terminalCount], count: 1 };
    return t.result();
}
function parseSteps(query) {
    const trimmed = query.trim().replace(/^g\./, '');
    const steps = [];
    const re = /([A-Za-z]+)\s*\(([^)]*)\)/g;
    let m;
    while ((m = re.exec(trimmed)) !== null) {
        const name = m[1];
        const argStr = m[2].trim();
        const args = argStr === '' ? [] : splitArgs(argStr).map(parseArg);
        steps.push({ name, args });
    }
    return steps;
}
function splitArgs(s) {
    const out = [];
    let cur = '';
    let inStr = null;
    for (const ch of s) {
        if (inStr) {
            if (ch === inStr)
                inStr = null;
            else
                cur += ch;
        }
        else if (ch === '"' || ch === "'")
            inStr = ch;
        else if (ch === ',') {
            out.push(cur.trim());
            cur = '';
        }
        else
            cur += ch;
    }
    if (cur.trim())
        out.push(cur.trim());
    return out;
}
function parseArg(a) {
    const num = Number(a);
    return !Number.isNaN(num) && a !== '' ? num : a;
}
function str(v) { return String(v ?? ''); }
function coerce(v) {
    if (v === undefined)
        return null;
    if (v === 'true')
        return true;
    if (v === 'false')
        return false;
    return v;
}
//# sourceMappingURL=gremlin.js.map