"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runSparqlConstruct = runSparqlConstruct;
exports.runSparql = runSparql;
// ─── Tokenizer ─────────────────────────────────────────────────────────────────
function tokenize(query) {
    const tokens = [];
    const re = /\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|<[^>]*>|\?[A-Za-z0-9_]+|-?\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_]*:[A-Za-z0-9_]*|[A-Za-z_][A-Za-z0-9_]*|<=|>=|!=|&&|\|\||[<>=]|[(){}.,;]|\S)/g;
    let m;
    while ((m = re.exec(query)) !== null) {
        if (m[1]?.trim())
            tokens.push(m[1]);
    }
    return tokens;
}
// ─── Parser ────────────────────────────────────────────────────────────────────
class Parser {
    tokens;
    pos = 0;
    prefixes = {};
    constructor(tokens) {
        this.tokens = tokens;
    }
    peek() { return this.tokens[this.pos]; }
    next() { return this.tokens[this.pos++]; }
    expect(tok) {
        const got = this.next();
        if (got?.toUpperCase() !== tok.toUpperCase())
            throw new Error(`SPARQL parse error: expected '${tok}', got '${got}'`);
    }
    parsePrefixes() {
        while (this.peek()?.toUpperCase() === 'PREFIX') {
            this.next();
            const prefix = this.next().replace(/:$/, '');
            const iri = this.next().replace(/^<|>$/g, '');
            this.prefixes[prefix] = iri;
        }
    }
    parseConstruct() {
        this.parsePrefixes();
        this.expect('CONSTRUCT');
        this.expect('{');
        const template = [];
        while (this.peek() && this.peek() !== '}') {
            if (this.peek() === '.') {
                this.next();
                continue;
            }
            template.push(this.parseTriplePattern());
        }
        this.expect('}');
        this.expect('WHERE');
        const where = this.parseGroup();
        return { prefixes: this.prefixes, template, where };
    }
    parse() {
        this.parsePrefixes();
        this.expect('SELECT');
        let distinct = false;
        if (this.peek()?.toUpperCase() === 'DISTINCT') {
            distinct = true;
            this.next();
        }
        let projection;
        if (this.peek() === '*') {
            projection = '*';
            this.next();
        }
        else {
            const vars = [];
            while (this.peek()?.startsWith('?'))
                vars.push(this.next().slice(1));
            if (vars.length === 0)
                throw new Error('SPARQL parse error: SELECT requires variables or *');
            projection = vars;
        }
        this.expect('WHERE');
        const where = this.parseGroup();
        const orderBy = [];
        let limit;
        let offset;
        while (this.peek()) {
            const kw = this.peek().toUpperCase();
            if (kw === 'ORDER') {
                this.next();
                this.expect('BY');
                while (this.peek()?.startsWith('?') || this.peek()?.toUpperCase() === 'ASC' || this.peek()?.toUpperCase() === 'DESC') {
                    let desc = false;
                    const d = this.peek().toUpperCase();
                    if (d === 'ASC' || d === 'DESC') {
                        desc = d === 'DESC';
                        this.next();
                        this.expect('(');
                    }
                    const v = this.next().slice(1);
                    if (this.peek() === ')')
                        this.next();
                    orderBy.push({ var: v, desc });
                }
            }
            else if (kw === 'LIMIT') {
                this.next();
                limit = parseInt(this.next(), 10);
            }
            else if (kw === 'OFFSET') {
                this.next();
                offset = parseInt(this.next(), 10);
            }
            else
                break;
        }
        return { prefixes: this.prefixes, distinct, projection, where, orderBy, limit, offset };
    }
    parseGroup() {
        this.expect('{');
        const group = { patterns: [], optionals: [], filters: [] };
        while (this.peek() && this.peek() !== '}') {
            const kw = this.peek().toUpperCase();
            if (kw === 'OPTIONAL') {
                this.next();
                group.optionals.push(this.parseGroup());
            }
            else if (kw === 'FILTER') {
                this.next();
                group.filters.push(this.parseFilter());
            }
            else if (this.peek() === '.') {
                this.next();
            }
            else
                group.patterns.push(this.parseTriplePattern());
        }
        this.expect('}');
        return group;
    }
    parseTriplePattern() {
        const s = this.parseTerm();
        const p = this.parseTerm();
        const o = this.parseTerm();
        if (this.peek() === '.')
            this.next();
        return { s, p, o };
    }
    parseTerm() {
        const tok = this.next();
        if (tok.startsWith('?'))
            return { kind: 'var', name: tok.slice(1) };
        if (tok.startsWith('<'))
            return { kind: 'iri', value: tok.replace(/^<|>$/g, '') };
        if (tok.startsWith('"') || tok.startsWith("'"))
            return { kind: 'literal', value: unquote(tok) };
        // prefixed name (prefix:local) or bareword keyword like rdf:type
        if (tok.includes(':')) {
            const [prefix, local] = tok.split(':');
            const base = this.prefixes[prefix];
            if (base)
                return { kind: 'iri', value: base + local };
            return { kind: 'iri', value: tok }; // unresolved prefix — treat literally (e.g. rdf:type)
        }
        // numeric literal
        const num = Number(tok);
        if (!Number.isNaN(num))
            return { kind: 'literal', value: num };
        return { kind: 'literal', value: tok };
    }
    parseFilter() {
        this.expect('(');
        const expr = this.parseFilterExpr();
        this.expect(')');
        return expr;
    }
    parseFilterExpr() {
        let left = this.parseFilterTerm();
        while (this.peek() === '&&' || this.peek() === '||') {
            const op = this.next();
            const right = this.parseFilterTerm();
            left = op === '&&' ? { kind: 'and', left, right } : { kind: 'or', left, right };
        }
        return left;
    }
    parseFilterTerm() {
        const tok = this.peek();
        if (tok === '(') {
            this.next();
            const e = this.parseFilterExpr();
            this.expect(')');
            return e;
        }
        const fn = tok?.toLowerCase();
        if (fn === 'regex') {
            this.next();
            this.expect('(');
            const varExpr = this.parseValueExpr();
            this.expect(',');
            const pattern = unquote(this.next());
            let flags = '';
            if (this.peek() === ',') {
                this.next();
                flags = unquote(this.next());
            }
            this.expect(')');
            return { kind: 'regex', varExpr, pattern, flags };
        }
        if (fn === 'contains') {
            this.next();
            this.expect('(');
            const haystack = this.parseValueExpr();
            this.expect(',');
            const needle = this.parseValueExpr();
            this.expect(')');
            return { kind: 'contains', haystack, needle };
        }
        if (fn === 'bound') {
            this.next();
            this.expect('(');
            const v = this.next().slice(1);
            this.expect(')');
            return { kind: 'bound', varName: v };
        }
        // comparison
        const left = this.parseValueExpr();
        const op = this.next();
        const right = this.parseValueExpr();
        return { kind: 'compare', op, left, right };
    }
    parseValueExpr() {
        const tok = this.next();
        if (tok.startsWith('?'))
            return { kind: 'var', name: tok.slice(1) };
        if (tok.startsWith('"') || tok.startsWith("'"))
            return { kind: 'const', value: unquote(tok) };
        const num = Number(tok);
        if (!Number.isNaN(num))
            return { kind: 'const', value: num };
        if (tok.startsWith('<'))
            return { kind: 'const', value: tok.replace(/^<|>$/g, '') };
        return { kind: 'const', value: tok };
    }
}
function unquote(tok) {
    return tok.replace(/^["']|["']$/g, '').replace(/\\(.)/g, '$1');
}
// ─── Evaluator ───────────────────────────────────────────────────────────────
function matchTriple(pattern, triple, binding) {
    const next = { ...binding };
    function unify(term, value) {
        if (term.kind === 'var') {
            if (term.name in next)
                return looseEq(next[term.name], value);
            next[term.name] = value;
            return true;
        }
        if (term.kind === 'iri')
            return String(value) === term.value;
        return looseEq(term.value, value);
    }
    if (!unify(pattern.s, triple.subject))
        return null;
    if (!unify(pattern.p, triple.predicate))
        return null;
    if (!unify(pattern.o, triple.object))
        return null;
    return next;
}
function looseEq(a, b) {
    if (a === b)
        return true;
    return String(a) === String(b);
}
function evalBGP(patterns, triples, seed) {
    let solutions = seed;
    for (const pattern of patterns) {
        const nextSolutions = [];
        for (const sol of solutions) {
            for (const triple of triples) {
                const merged = matchTriple(pattern, triple, sol);
                if (merged)
                    nextSolutions.push(merged);
            }
        }
        solutions = nextSolutions;
        if (solutions.length === 0)
            break;
    }
    return solutions;
}
function evalGroup(group, triples) {
    let solutions = evalBGP(group.patterns, triples, [{}]);
    // OPTIONAL → left join
    for (const opt of group.optionals) {
        const next = [];
        for (const sol of solutions) {
            const matches = evalGroup(opt, triples).filter((m) => compatible(sol, m));
            if (matches.length === 0)
                next.push(sol);
            else
                for (const m of matches)
                    next.push({ ...sol, ...m });
        }
        solutions = next;
    }
    // FILTER restriction
    for (const filter of group.filters) {
        solutions = solutions.filter((sol) => evalFilter(filter, sol));
    }
    return solutions;
}
function compatible(a, b) {
    for (const k of Object.keys(b)) {
        if (k in a && !looseEq(a[k], b[k]))
            return false;
    }
    return true;
}
function resolveValue(expr, binding) {
    return expr.kind === 'var' ? (binding[expr.name] ?? null) : expr.value;
}
function evalFilter(expr, binding) {
    switch (expr.kind) {
        case 'and': return evalFilter(expr.left, binding) && evalFilter(expr.right, binding);
        case 'or': return evalFilter(expr.left, binding) || evalFilter(expr.right, binding);
        case 'not': return !evalFilter(expr.expr, binding);
        case 'bound': return expr.varName in binding && binding[expr.varName] !== null;
        case 'regex': {
            const v = resolveValue(expr.varExpr, binding);
            try {
                return new RegExp(expr.pattern, expr.flags).test(String(v ?? ''));
            }
            catch {
                return false;
            }
        }
        case 'contains': {
            const h = String(resolveValue(expr.haystack, binding) ?? '');
            const n = String(resolveValue(expr.needle, binding) ?? '');
            return h.includes(n);
        }
        case 'compare': {
            const l = resolveValue(expr.left, binding);
            const r = resolveValue(expr.right, binding);
            return compareValues(expr.op, l, r);
        }
    }
}
function compareValues(op, l, r) {
    const ln = typeof l === 'number' ? l : Number(l);
    const rn = typeof r === 'number' ? r : Number(r);
    const numeric = !Number.isNaN(ln) && !Number.isNaN(rn) && l !== '' && r !== '';
    switch (op) {
        case '=': return looseEq(l, r);
        case '!=': return !looseEq(l, r);
        case '<': return numeric ? ln < rn : String(l) < String(r);
        case '>': return numeric ? ln > rn : String(l) > String(r);
        case '<=': return numeric ? ln <= rn : String(l) <= String(r);
        case '>=': return numeric ? ln >= rn : String(l) >= String(r);
        default: return false;
    }
}
function instantiateTerm(term, sol) {
    if (term.kind === 'var')
        return term.name in sol ? (sol[term.name] ?? null) : null;
    if (term.kind === 'iri')
        return term.value;
    return term.value;
}
function runSparqlConstruct(store, queryText) {
    const tokens = tokenize(queryText);
    const query = new Parser(tokens).parseConstruct();
    const triples = store.triples();
    const solutions = evalGroup(query.where, triples);
    const now = new Date().toISOString();
    const result = [];
    for (const sol of solutions) {
        for (const pattern of query.template) {
            const s = instantiateTerm(pattern.s, sol);
            const p = instantiateTerm(pattern.p, sol);
            const o = instantiateTerm(pattern.o, sol);
            if (s === null || p === null || o === null)
                continue;
            result.push({ subject: String(s), predicate: String(p), object: o, isIri: pattern.o.kind === 'iri', assertedAt: now });
        }
    }
    return result;
}
function runSparql(store, queryText) {
    const tokens = tokenize(queryText);
    const query = new Parser(tokens).parse();
    const triples = store.triples();
    let solutions = evalGroup(query.where, triples);
    // ORDER BY
    if (query.orderBy.length > 0) {
        solutions = [...solutions].sort((a, b) => {
            for (const { var: v, desc } of query.orderBy) {
                const av = a[v], bv = b[v];
                const an = Number(av), bn = Number(bv);
                const cmp = !Number.isNaN(an) && !Number.isNaN(bn)
                    ? an - bn
                    : String(av ?? '').localeCompare(String(bv ?? ''));
                if (cmp !== 0)
                    return desc ? -cmp : cmp;
            }
            return 0;
        });
    }
    // Projection
    const variables = query.projection === '*'
        ? Array.from(new Set(solutions.flatMap((s) => Object.keys(s))))
        : query.projection;
    let bindings = solutions.map((s) => {
        const row = {};
        for (const v of variables)
            row[v] = s[v] ?? null;
        return row;
    });
    // DISTINCT
    if (query.distinct) {
        const seen = new Set();
        bindings = bindings.filter((b) => {
            const key = JSON.stringify(b);
            if (seen.has(key))
                return false;
            seen.add(key);
            return true;
        });
    }
    // OFFSET / LIMIT
    if (query.offset)
        bindings = bindings.slice(query.offset);
    if (query.limit !== undefined)
        bindings = bindings.slice(0, query.limit);
    return { variables, bindings, evaluatedAtSeq: store.logicalClock };
}
//# sourceMappingURL=sparql.js.map